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
                discoveryDocs: [GOOGLE_CONFIG.DISCOVERY_DOC],
            });
            gapiInited = true;
            // console.log("GAPI Loaded"); // 디버깅용
            checkAuth(callback);
        } catch (err) {
            alert("Google API 초기화 실패: " + JSON.stringify(err));
        }
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error !== undefined) {
                throw (resp);
            }
            // alert("인증 성공! 데이터를 동기화합니다."); // 모바일 디버깅용 알림
            state.currentUser = { name: "Google User", provider: "google" };
            await syncFromDrive(callback);
        },
    });
    gisInited = true;
}

// 2. 로그인 요청 (안정성 강화)
export function handleAuthClick() {
    if (!gisInited || !gapiInited) {
        alert("구글 연결 중입니다... 3초 뒤에 다시 시도해주세요.");
        return;
    }
    
    try {
        tokenClient.requestAccessToken({prompt: 'consent'});
    } catch (err) {
        alert("로그인 창을 여는 중 오류 발생: " + err.message);
    }
}

// 3. 로그아웃 (토큰 취소)
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

// 4. 로그인 상태 확인
function checkAuth(callback) {
    if(callback) callback(false); 
}

// 5. 드라이브에서 데이터 동기화 (다운로드)
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
            // alert("동기화 완료!"); // 완료 알림
        } else {
            await saveToDrive();
        }
        
        if(callback) callback(true);
        
    } catch (err) {
        console.error("Sync Error", err);
        alert("동기화 실패: " + JSON.stringify(err));
        if(callback) callback(false);
    }
}

// 6. 드라이브에 데이터 저장 (업로드)
export async function saveToDrive() {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        const fileContent = JSON.stringify(state.entries);
        
        // 메타데이터 설정
        let fileMetadata = {
            name: DB_FILE_NAME,
            mimeType: 'application/json'
        };

        // 파일이 없을 때만(새로 만들 때만) 부모 폴더 지정
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
            // 업데이트 (PATCH)
            await gapi.client.request({
                path: '/upload/drive/v3/files/' + fileId,
                method: 'PATCH',
                params: { uploadType: 'multipart' },
                headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
                body: multipartRequestBody
            });
            console.log("구글 드라이브 업데이트 완료 (PATCH)");
        } else {
            // 새로 생성 (POST)
            await gapi.client.request({
                path: '/upload/drive/v3/files',
                method: 'POST',
                params: { uploadType: 'multipart' },
                headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
                body: multipartRequestBody
            });
            console.log("구글 드라이브 신규 저장 완료 (POST)");
        }
    } catch (err) {
        console.error("Save Error", err);
        // 저장 실패는 사용자 경험을 위해 alert를 띄우지 않고 콘솔에만 남김
    }
}

// --- Helper Functions ---

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