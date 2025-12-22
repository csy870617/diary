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

            // 2. [핵심 수정] 카테고리 동기화 로직 강화
            if (cloudCategories && cloudOrder) {
                // 시간이 없으면 0으로 처리해서 숫자 비교가 가능하게 함
                const localTimeStr = state.categoryUpdatedAt || new Date(0).toISOString();
                const serverTimeStr = cloudCatTime || new Date(0).toISOString();
                
                const localTime = new Date(localTimeStr).getTime();
                const serverTime = new Date(serverTimeStr).getTime();

                // 서버가 더 최신이거나, 로컬이 초기 상태(0)라면 서버 데이터 적용
                if (serverTime > localTime || localTime === 0) {
                    state.allCategories = cloudCategories;
                    state.categoryOrder = cloudOrder;
                    state.categoryUpdatedAt = serverTimeStr;
                    
                    saveCategoriesToLocal(); 
                    renderTabs(); // 탭 즉시 갱신
                    
                    // 현재 탭이 유효한지 재검사
                    const currentValid = state.allCategories.find(c => c.id === state.currentCategory);
                    if (!currentValid && state.categoryOrder.length > 0) {
                        state.currentCategory = state.categoryOrder[0];
                        renderTabs();
                        renderEntries();
                    }
                    console.log("카테고리 동기화 완료 (서버 -> 로컬)");
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

// 5. 저장 (업로드)
export async function saveToDrive() {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        let entriesToSave = state.entries;

        // 저장 전 클라우드 데이터 확인 (충돌 방지)
        if (fileId) {
            try {
                const cloudRawData = await downloadFile(fileId);
                let cloudEntries = [];
                // 구버전/신버전 호환 처리
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
            } catch (e) {
                console.warn("병합 전 읽기 실패", e);
            }
        }

        const fullData = {
            entries: entriesToSave,
            categories: state.allCategories,
            categoryOrder: state.categoryOrder,
            categoryUpdatedAt: state.categoryUpdatedAt || new Date().toISOString(),
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
        
        console.log("저장 완료");

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