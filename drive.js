import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state } from './state.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// 1. Google API 초기화
export function initGoogleDrive(callback) {
    // GAPI 로드
    gapi.load('client', async () => {
        try {
            await gapi.client.init({
                apiKey: GOOGLE_CONFIG.API_KEY,
                discoveryDocs: [GOOGLE_CONFIG.DISCOVERY_DOC],
            });
            gapiInited = true;
            // 초기 로딩 시에는 자동 로그인 시도를 하지 않고 false 반환 (버튼 눌러 로그인 유도)
            if(callback) callback(false); 
        } catch (err) {
            console.error("GAPI init error:", err);
            if(callback) callback(false);
        }
    });

    // GIS 로드
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error !== undefined) {
                throw (resp);
            }
            // 로그인 성공 시 상태 업데이트
            state.currentUser = { name: "Google User", provider: "google" };
            await syncFromDrive(callback);
        },
    });
    gisInited = true;
}

// 2. 로그인 요청
export function handleAuthClick() {
    if(!gisInited || !gapiInited) {
        alert("구글 연결 준비 중입니다. 1초 뒤에 다시 시도해주세요.");
        return;
    }
    // 팝업 트리거
    tokenClient.requestAccessToken({prompt: 'consent'});
}

// 3. 로그아웃
export function handleSignoutClick(callback) {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token, () => {
            gapi.client.setToken('');
            state.currentUser = null;
            if(callback) callback();
        });
    }
}

// 4. 데이터 동기화 (다운로드)
export async function syncFromDrive(callback) {
    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const response = await gapi.client.drive.files.get({
                fileId: fileId,
                alt: 'media'
            });
            const cloudData = response.result;
            
            state.entries = Array.isArray(cloudData) ? cloudData : [];
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
            console.log("동기화 완료");
        } else {
            await saveToDrive();
        }
        
        if(callback) callback(true); // 로그인 성공 알림
        
    } catch (err) {
        console.error("Sync Error", err);
        if(callback) callback(false);
    }
}

// 5. 데이터 저장 (업로드)
export async function saveToDrive() {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        const fileContent = JSON.stringify(state.entries);
        
        let fileMetadata = {
            name: DB_FILE_NAME,
            mimeType: 'application/json'
        };

        if (!fileId) {
            fileMetadata.parents = [folderId];
        }

        const multipartRequestBody =
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            JSON.stringify(fileMetadata) +
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            fileContent +
            close_delim;

        if (fileId) {
            // PATCH
            await gapi.client.request({
                path: '/upload/drive/v3/files/' + fileId,
                method: 'PATCH',
                params: { uploadType: 'multipart' },
                headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
                body: multipartRequestBody
            });
        } else {
            // POST
            await gapi.client.request({
                path: '/upload/drive/v3/files',
                method: 'POST',
                params: { uploadType: 'multipart' },
                headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
                body: multipartRequestBody
            });
        }
    } catch (err) {
        console.error("Save Error", err);
    }
}

// --- Helpers ---
const boundary = '-------314159265358979323846';
const delimiter = "\r\n--" + boundary + "\r\n";
const close_delim = "\r\n--" + boundary + "--";

async function ensureAppFolder() {
    const q = `mimeType='application/vnd.google-apps.folder' and name='${APP_FOLDER_NAME}' and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    
    if (response.result.files.length > 0) {
        return response.result.files[0].id;
    } else {
        const fileMetadata = {
            'name': APP_FOLDER_NAME,
            'mimeType': 'application/vnd.google-apps.folder'
        };
        const res = await gapi.client.drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });
        return res.result.id;
    }
}

async function findDbFile(folderId) {
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    if (response.result.files.length > 0) {
        return response.result.files[0].id;
    }
    return null;
}