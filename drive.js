import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state } from './state.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// 1. Google API 초기화
export function initGoogleDrive(callback) {
    gapi.load('client', async () => {
        try {
            await gapi.client.init({
                apiKey: GOOGLE_CONFIG.API_KEY,
                // 명시적인 Discovery URL 사용 (가장 안정적)
                discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
            });
            
            gapiInited = true;
            
            // 초기화 성공 시 콜백 (로그인 상태는 아직 모름)
            if(callback) callback(false); 
            
        } catch (err) {
            console.error("GAPI init error:", err);
            // 모바일 디버깅용: 1단계 설정(API키 제한 해제)을 안 하면 여기서 에러가 남
            alert("구글 연결 실패. API키 설정을 확인하세요.\n" + JSON.stringify(err));
            if(callback) callback(false);
        }
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error !== undefined) {
                throw (resp);
            }
            state.currentUser = { name: "Google User", provider: "google" };
            await syncFromDrive(callback);
        },
    });
    gisInited = true;
}

// 2. 로그인 요청
export function handleAuthClick() {
    if(!gisInited || !gapiInited) {
        alert("구글 연결 준비 중입니다. 잠시만 기다려주세요.");
        return;
    }
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
        
        if(callback) callback(true);
        
    } catch (err) {
        console.error("Sync Error", err);
        alert("동기화 오류: " + JSON.stringify(err));
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
            await gapi.client.request({
                path: '/upload/drive/v3/files/' + fileId,
                method: 'PATCH',
                params: { uploadType: 'multipart' },
                headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
                body: multipartRequestBody
            });
        } else {
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