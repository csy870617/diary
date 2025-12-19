import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state } from './state.js';
import { renderEntries } from './ui.js'; // 화면 갱신을 위해 필요

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
            
            // 자동 로그인 체크
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

// 4. 데이터 가져오기 (단순 로드)
export async function syncFromDrive(callback) {
    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const cloudData = await downloadFile(fileId);
            state.entries = Array.isArray(cloudData) ? cloudData : [];
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
            console.log("동기화(로드) 완료");
        } else {
            await saveToDrive(); // 파일 없으면 생성
        }
        if(callback) callback(true);
    } catch (err) {
        handleDriveError(err, callback);
    }
}

// 5. [핵심] 스마트 저장 (병합 후 저장)
export async function saveToDrive() {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        let mergedEntries = state.entries;

        // 파일이 이미 존재하면, 클라우드 데이터를 먼저 가져와서 병합
        if (fileId) {
            try {
                const cloudData = await downloadFile(fileId);
                if (Array.isArray(cloudData)) {
                    // 병합 로직 실행
                    mergedEntries = mergeData(cloudData, state.entries);
                    
                    // 병합된 최신 데이터를 내 화면(state)에도 반영
                    state.entries = mergedEntries;
                    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                    renderEntries(); // UI 갱신 (혹시 다른 기기에서 쓴 글이 들어왔을 수 있으므로)
                }
            } catch (e) {
                console.warn("병합 전 읽기 실패, 강제 저장 시도", e);
            }
        }

        // 병합된 데이터를 업로드
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
        
        console.log("안전하게 저장됨 (병합 완료)");

    } catch (err) {
        handleDriveError(err);
    }
}

// --- Helper Functions ---

// 두 데이터(클라우드 vs 로컬)를 비교해서 최신 수정본으로 합치는 함수
function mergeData(cloud, local) {
    const map = new Map();

    // 1. 클라우드 데이터를 먼저 맵에 넣음
    cloud.forEach(item => map.set(item.id, item));

    // 2. 로컬 데이터를 돌면서 비교
    local.forEach(localItem => {
        const cloudItem = map.get(localItem.id);
        
        if (!cloudItem) {
            // 로컬에만 있는 새 글 -> 추가
            map.set(localItem.id, localItem);
        } else {
            // 둘 다 있음 -> 수정일(modifiedAt 없으면 timestamp) 비교
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp).getTime();

            // 로컬이 더 최신이거나 같으면 덮어씀 (아니면 클라우드 버전 유지)
            if (localTime >= cloudTime) {
                map.set(localItem.id, localItem);
            }
        }
    });

    // 맵을 배열로 변환해서 반환
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
    if(err.status === 401) {
        localStorage.removeItem('faith_token');
        localStorage.removeItem('faith_token_exp');
        if(confirm("로그인이 만료되었습니다. 다시 로그인할까요?")) location.reload();
    } else {
        // alert("동기화 중 오류 발생: " + (err.result?.error?.message || JSON.stringify(err)));
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