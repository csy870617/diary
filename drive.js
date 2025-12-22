import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// 1. Google API 초기화
export function initGoogleDrive(callback) {
    if (typeof gapi === 'undefined' || typeof google === 'undefined' || !google.accounts) {
        setTimeout(() => initGoogleDrive(callback), 100);
        return;
    }

    gapi.load('client', async () => {
        try {
            await gapi.client.init({
                apiKey: GOOGLE_CONFIG.API_KEY,
                discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
            });
            gapiInited = true;
            
            const storedToken = localStorage.getItem('faith_token');
            const storedExp = localStorage.getItem('faith_token_exp');
            const now = Date.now();

            if (storedToken && storedExp && now < parseInt(storedExp)) {
                gapi.client.setToken({ access_token: storedToken });
                state.currentUser = { name: "Google User", provider: "google" };
                console.log("세션 복구됨");
                await syncFromDrive(callback);
            } else {
                if(callback) callback(false); 
            }
        } catch (err) {
            console.error("GAPI init error:", err);
            if(callback) callback(false);
        }
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error !== undefined) throw (resp);
            
            const expiresIn = resp.expires_in || 3599; 
            const expiryTime = Date.now() + (expiresIn * 1000);
            localStorage.setItem('faith_token', resp.access_token);
            localStorage.setItem('faith_token_exp', expiryTime);

            state.currentUser = { name: "Google User", provider: "google" };
            await syncFromDrive(callback);
        },
    });
    gisInited = true;
}

export function handleAuthClick() {
    if(!gisInited || !gapiInited) return alert("연결 준비 중입니다. 잠시만 기다려주세요.");
    tokenClient.requestAccessToken({prompt: 'consent'});
}

export function handleSignoutClick(callback) {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token, () => {
            gapi.client.setToken('');
            state.currentUser = null;
            localStorage.removeItem('faith_token');
            localStorage.removeItem('faith_token_exp');
            if(callback) callback();
        });
    }
}

// 4. 데이터 동기화 (로드)
export async function syncFromDrive(callback) {
    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const cloudRawData = await downloadFile(fileId);
            
            let cloudEntries = [];
            let cloudCategories = null;
            let cloudOrder = null;
            let cloudCatTime = null;

            if (Array.isArray(cloudRawData)) {
                cloudEntries = cloudRawData;
            } else if (cloudRawData && cloudRawData.entries) {
                cloudEntries = cloudRawData.entries;
                cloudCategories = cloudRawData.categories;
                cloudOrder = cloudRawData.categoryOrder;
                cloudCatTime = cloudRawData.categoryUpdatedAt;
            }

            // 1. 글 병합
            const merged = mergeData(cloudEntries, state.entries);
            state.entries = merged;
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));

            // 2. 카테고리 동기화
            if (cloudCategories && cloudOrder) {
                const localTime = new Date(state.categoryUpdatedAt || 0).getTime();
                const serverTime = new Date(cloudCatTime || 0).getTime();

                // 서버가 더 최신이면 내 것을 업데이트
                if (serverTime > localTime) {
                    state.allCategories = cloudCategories;
                    state.categoryOrder = cloudOrder;
                    state.categoryUpdatedAt = cloudCatTime;
                    
                    saveCategoriesToLocal(); 
                    renderTabs();
                    
                    const currentValid = state.allCategories.find(c => c.id === state.currentCategory);
                    if (!currentValid && state.categoryOrder.length > 0) {
                        state.currentCategory = state.categoryOrder[0];
                        renderTabs();
                    }
                    console.log("카테고리 동기화: 서버 버전 적용");
                }
            }

            renderEntries(); 
            console.log("전체 동기화 완료");
        } else {
            await saveToDrive(); 
        }
        if(callback) callback(true);
    } catch (err) {
        handleDriveError(err, callback);
    }
}

// 5. 저장 (업로드) - [문제 해결의 핵심 로직]
export async function saveToDrive() {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        let entriesToSave = state.entries;
        
        // 최종적으로 저장할 카테고리 데이터 (기본은 내 것)
        let finalCategories = state.allCategories;
        let finalOrder = state.categoryOrder;
        let finalCatTime = state.categoryUpdatedAt || new Date(0).toISOString();

        // 저장하기 전에 먼저 클라우드 상태를 확인 (충돌 방지)
        if (fileId) {
            try {
                const cloudRawData = await downloadFile(fileId);
                
                // 1. 글 데이터 병합 (기존 로직)
                let cloudEntries = [];
                if (Array.isArray(cloudRawData)) {
                    cloudEntries = cloudRawData;
                } else if (cloudRawData && cloudRawData.entries) {
                    cloudEntries = cloudRawData.entries;
                }
                if (Array.isArray(cloudEntries)) {
                    entriesToSave = mergeData(cloudEntries, state.entries);
                    state.entries = entriesToSave;
                    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                    renderEntries();
                }

                // 2. [핵심] 카테고리 상태 확인
                // 만약 클라우드에 더 최신 카테고리 정보가 있다면?
                // 내 폰의 카테고리 정보로 덮어쓰지 말고, 클라우드 정보를 유지해야 함!
                if (cloudRawData && cloudRawData.categories && cloudRawData.categoryUpdatedAt) {
                    const serverTime = new Date(cloudRawData.categoryUpdatedAt).getTime();
                    const localTime = new Date(state.categoryUpdatedAt || 0).getTime();

                    if (serverTime > localTime) {
                        console.log("저장 중 발견: 서버 카테고리가 더 최신임. 서버 데이터 유지.");
                        // 저장할 데이터 패키지에 서버의 카테고리를 담음
                        finalCategories = cloudRawData.categories;
                        finalOrder = cloudRawData.categoryOrder;
                        finalCatTime = cloudRawData.categoryUpdatedAt;

                        // 내 기기의 상태도 최신으로 업데이트 (화면 갱신)
                        state.allCategories = finalCategories;
                        state.categoryOrder = finalOrder;
                        state.categoryUpdatedAt = finalCatTime;
                        saveCategoriesToLocal();
                        renderTabs();
                    }
                }

            } catch (e) {
                console.warn("병합 전 읽기 실패", e);
            }
        }

        // 완성된 데이터 패키지
        const fullData = {
            entries: entriesToSave,
            categories: finalCategories,      // 최신 승자 카테고리
            categoryOrder: finalOrder,        // 최신 승자 순서
            categoryUpdatedAt: finalCatTime,  // 최신 승자 시간
            lastUpdated: new Date().toISOString()
        };

        const fileContent = JSON.stringify(fullData);
        const fileMetadata = { name: DB_FILE_NAME, mimeType: 'application/json' };
        if (!fileId) fileMetadata.parents = [folderId];

        const multipartRequestBody =
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            JSON.stringify(fileMetadata) +
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            fileContent +
            close_delim;

        const requestPath = fileId ? '/upload/drive/v3/files/' + fileId : '/upload/drive/v3/files';
        const requestMethod = fileId ? 'PATCH' : 'POST';

        await gapi.client.request({
            path: requestPath,
            method: requestMethod,
            params: { uploadType: 'multipart' },
            headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
            body: multipartRequestBody
        });
        
        console.log("저장 완료 (안전한 카테고리 병합)");

    } catch (err) {
        handleDriveError(err);
    }
}

function mergeData(cloud, local) {
    const map = new Map();
    cloud.forEach(item => map.set(item.id, item));
    local.forEach(localItem => {
        const cloudItem = map.get(localItem.id);
        if (!cloudItem) {
            map.set(localItem.id, localItem);
        } else {
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp).getTime();
            if (localTime >= cloudTime || (localItem.isPurged && !cloudItem.isPurged)) {
                map.set(localItem.id, localItem);
            }
        }
    });
    return Array.from(map.values());
}

async function downloadFile(fileId) {
    const response = await gapi.client.drive.files.get({
        fileId: fileId,
        alt: 'media'
    });
    try {
        if(typeof response.result === 'string') return JSON.parse(response.result);
        return response.result;
    } catch(e) { return []; }
}

function handleDriveError(err, callback) {
    console.error("Drive Error", err);
    if(err.status === 401) {
        localStorage.removeItem('faith_token');
        localStorage.removeItem('faith_token_exp');
    }
    if(callback) callback(false);
}

const boundary = '-------314159265358979323846';
const delimiter = "\r\n--" + boundary + "\r\n";
const close_delim = "\r\n--" + boundary + "--";

async function ensureAppFolder() {
    const q = `mimeType='application/vnd.google-apps.folder' and name='${APP_FOLDER_NAME}' and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    if (response.result.files.length > 0) return response.result.files[0].id;
    const res = await gapi.client.drive.files.create({
        resource: { 'name': APP_FOLDER_NAME, 'mimeType': 'application/vnd.google-apps.folder' },
        fields: 'id'
    });
    return res.result.id;
}

async function findDbFile(folderId) {
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    return response.result.files.length > 0 ? response.result.files[0].id : null;
}