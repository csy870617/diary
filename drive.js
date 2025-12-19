import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state } from './state.js';
import { renderEntries } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// 1. Google API 초기화
export function initGoogleDrive(callback) {
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
    if(!gisInited || !gapiInited) return alert("연결 준비 중입니다.");
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

// 4. 데이터 동기화 (로드 시에도 병합 수행)
export async function syncFromDrive(callback) {
    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const cloudData = await downloadFile(fileId);
            if (Array.isArray(cloudData)) {
                // [핵심 수정] 불러올 때도 내 기기의 데이터와 합칩니다.
                // 그래야 방금 쓴 글이 안 날아갑니다.
                const merged = mergeData(cloudData, state.entries);
                state.entries = merged;
                localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                renderEntries(); // 화면 갱신
                console.log("동기화(로드&병합) 완료");
            }
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
        
        let mergedEntries = state.entries;

        if (fileId) {
            try {
                const cloudData = await downloadFile(fileId);
                if (Array.isArray(cloudData)) {
                    mergedEntries = mergeData(cloudData, state.entries);
                    state.entries = mergedEntries;
                    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                    renderEntries();
                }
            } catch (e) {
                console.warn("병합 전 읽기 실패", e);
            }
        }

        const fileContent = JSON.stringify(mergedEntries);
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

// --- Helper Functions ---

// [중요] 병합 로직 개선: 클라우드와 로컬을 합집합으로 처리
function mergeData(cloud, local) {
    const map = new Map();

    // 1. 클라우드 데이터를 먼저 넣음
    cloud.forEach(item => map.set(item.id, item));

    // 2. 로컬 데이터를 넣을 때 비교
    local.forEach(localItem => {
        const cloudItem = map.get(localItem.id);
        
        if (!cloudItem) {
            // 구글엔 없는데 내 폰엔 있다? -> 방금 쓴 새 글임! (추가)
            map.set(localItem.id, localItem);
        } else {
            // 둘 다 있다? -> 더 최신 수정본을 선택
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp).getTime();

            if (localTime > cloudTime) {
                map.set(localItem.id, localItem); // 내 께 더 최신이면 덮어씀
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
    return response.result;
}

function handleDriveError(err, callback) {
    console.error("Drive Error", err);
    // 401: 토큰 만료 등 인증 에러
    if(err.status === 401) {
        localStorage.removeItem('faith_token');
        localStorage.removeItem('faith_token_exp');
    }
    // Cross-Origin 등 무시해도 되는 에러는 alert 띄우지 않음
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