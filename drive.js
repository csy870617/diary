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

// 4. 데이터 동기화 (로드) - [강력해진 방어 로직]
export async function syncFromDrive(callback) {
    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const cloudRawData = await downloadFile(fileId);
            
            // 데이터 초기화 (오류 방지)
            let cloudEntries = [];
            let cloudCategories = null;
            let cloudOrder = null;
            let cloudCatTime = null;

            // [수정] 데이터 타입 체크 강화
            if (!cloudRawData) {
                console.warn("클라우드 데이터가 비어있음");
            } else if (Array.isArray(cloudRawData)) {
                // 구버전 데이터 (배열)
                cloudEntries = cloudRawData;
            } else if (typeof cloudRawData === 'object') {
                // 신버전 데이터 (객체)
                cloudEntries = Array.isArray(cloudRawData.entries) ? cloudRawData.entries : [];
                cloudCategories = cloudRawData.categories;
                cloudOrder = cloudRawData.categoryOrder;
                cloudCatTime = cloudRawData.categoryUpdatedAt;
            }

            // 1. 글 병합 (배열이 확실한지 확인 후 전달)
            const merged = mergeData(cloudEntries, state.entries || []);
            state.entries = merged;
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));

            // 2. 카테고리 동기화
            if (cloudCategories && cloudOrder) {
                const localTime = new Date(state.categoryUpdatedAt || 0).getTime();
                const serverTime = new Date(cloudCatTime || 0).getTime();

                // 서버가 더 최신이거나 로컬이 초기값이면 덮어쓰기
                if (serverTime > localTime || localTime === 0) {
                    state.allCategories = cloudCategories;
                    state.categoryOrder = cloudOrder;
                    state.categoryUpdatedAt = cloudCatTime;
                    
                    saveCategoriesToLocal();
                    renderTabs();
                    
                    // 현재 선택된 탭이 유효한지 체크
                    const currentValid = state.allCategories.find(c => c.id === state.currentCategory);
                    if (!currentValid && state.categoryOrder.length > 0) {
                        state.currentCategory = state.categoryOrder[0];
                        renderTabs();
                    }
                    console.log("카테고리 동기화 완료 (서버 버전 적용)");
                }
            }

            renderEntries(); 
            console.log("전체 동기화 완료");
        } else {
            // 파일이 없으면 새로 생성
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
        
        let entriesToSave = state.entries || [];
        
        // 최종 저장할 카테고리 데이터 (기본값: 내 기기 데이터)
        let finalCategories = state.allCategories;
        let finalOrder = state.categoryOrder;
        let finalCatTime = state.categoryUpdatedAt || new Date(0).toISOString();

        if (fileId) {
            try {
                const cloudRawData = await downloadFile(fileId);
                
                // [수정] 다운로드 데이터 파싱 강화
                let cloudEntries = [];
                let cloudCatData = null;

                if (Array.isArray(cloudRawData)) {
                    cloudEntries = cloudRawData;
                } else if (cloudRawData && typeof cloudRawData === 'object') {
                    cloudEntries = Array.isArray(cloudRawData.entries) ? cloudRawData.entries : [];
                    cloudCatData = cloudRawData; // 카테고리 정보가 포함된 전체 객체
                }
                
                // 글 데이터 병합
                entriesToSave = mergeData(cloudEntries, state.entries || []);
                state.entries = entriesToSave;
                localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                renderEntries();

                // 카테고리 충돌 검사 (서버가 더 최신이면 서버 데이터 유지)
                if (cloudCatData && cloudCatData.categoryUpdatedAt) {
                    const serverTime = new Date(cloudCatData.categoryUpdatedAt).getTime();
                    const localTime = new Date(state.categoryUpdatedAt || 0).getTime();

                    if (serverTime > localTime) {
                        console.log("저장 중 발견: 서버 카테고리가 더 최신임. 서버 데이터 유지.");
                        finalCategories = cloudCatData.categories;
                        finalOrder = cloudCatData.categoryOrder;
                        finalCatTime = cloudCatData.categoryUpdatedAt;
                        
                        // 내 기기 상태도 업데이트
                        state.allCategories = finalCategories;
                        state.categoryOrder = finalOrder;
                        state.categoryUpdatedAt = finalCatTime;
                        saveCategoriesToLocal();
                        renderTabs();
                    }
                }

            } catch (e) {
                console.warn("병합 전 읽기 실패, 강제 저장 진행", e);
            }
        }

        // 전체 데이터 패키징
        const fullData = {
            entries: entriesToSave,
            categories: finalCategories,
            categoryOrder: finalOrder,
            categoryUpdatedAt: finalCatTime,
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

// [수정] 병합 로직 안전장치 추가
function mergeData(cloud, local) {
    if (!Array.isArray(cloud)) cloud = [];
    if (!Array.isArray(local)) local = [];

    const map = new Map();
    cloud.forEach(item => { if(item && item.id) map.set(item.id, item); });
    
    local.forEach(localItem => {
        if (!localItem || !localItem.id) return;
        
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
    try {
        const response = await gapi.client.drive.files.get({
            fileId: fileId,
            alt: 'media'
        });
        // 결과가 문자열이면 JSON 파싱, 객체면 그대로 사용
        if(typeof response.result === 'string') {
            return response.result ? JSON.parse(response.result) : null;
        }
        return response.result || null;
    } catch(e) { 
        console.warn("파일 다운로드/파싱 실패", e);
        return null; // 실패 시 null 반환하여 위에서 처리
    }
}

function handleDriveError(err, callback) {
    console.error("Drive Error", err);
    // 토큰 만료 에러(401) 시 로그아웃 처리
    if(err.status === 401 || (err.result && err.result.error && err.result.error.code === 401)) {
        localStorage.removeItem('faith_token');
        localStorage.removeItem('faith_token_exp');
        state.currentUser = null;
        alert("인증이 만료되었습니다. 다시 동기화 버튼을 눌러주세요.");
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