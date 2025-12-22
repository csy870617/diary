import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js'; // saveCategoriesToLocal 추가
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

// 2. 로그인 요청
export function handleAuthClick() {
    if(!gisInited || !gapiInited) return alert("연결 준비 중입니다. 잠시만 기다려주세요.");
    tokenClient.requestAccessToken({prompt: 'consent'});
}

// 3. 로그아웃
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

// 4. 데이터 동기화 (로드 & 병합)
export async function syncFromDrive(callback) {
    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const cloudRawData = await downloadFile(fileId);
            
            // [핵심] 데이터 구조 확인 및 처리
            let cloudEntries = [];
            let cloudCategories = null;
            let cloudOrder = null;

            if (Array.isArray(cloudRawData)) {
                // 구버전 데이터 (배열만 있음)
                cloudEntries = cloudRawData;
            } else if (cloudRawData && cloudRawData.entries) {
                // 신버전 데이터 (객체 형태)
                cloudEntries = cloudRawData.entries;
                cloudCategories = cloudRawData.categories;
                cloudOrder = cloudRawData.categoryOrder;
            }

            // 1. 글 병합
            const merged = mergeData(cloudEntries, state.entries);
            state.entries = merged;
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));

            // 2. 카테고리 동기화 (클라우드에 설정이 있다면 내 기기에 반영)
            if (cloudCategories && cloudOrder) {
                state.allCategories = cloudCategories;
                state.categoryOrder = cloudOrder;
                saveCategoriesToLocal(); // 로컬 스토리지 저장
                renderTabs(); // 탭 다시 그리기
            }

            renderEntries(); 
            console.log("동기화(로드&병합) 완료");
        } else {
            await saveToDrive(); 
        }
        if(callback) callback(true);
    } catch (err) {
        handleDriveError(err, callback);
    }
}

// 5. 저장 (업로드) - 카테고리 포함
export async function saveToDrive() {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        let entriesToSave = state.entries;

        // 병합 과정 (글 데이터 보호)
        if (fileId) {
            try {
                const cloudRawData = await downloadFile(fileId);
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
            } catch (e) {
                console.warn("병합 전 읽기 실패", e);
            }
        }

        // [핵심] 저장할 전체 데이터 패키지 생성
        const fullData = {
            entries: entriesToSave,
            categories: state.allCategories,
            categoryOrder: state.categoryOrder,
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
        
        console.log("저장 완료 (카테고리 포함)");

    } catch (err) {
        handleDriveError(err);
    }
}

// --- Helper Functions ---
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