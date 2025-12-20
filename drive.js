import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state } from './state.js';
import { renderEntries } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// 1. Google API 초기화 (안전장치 포함)
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

// 4. 데이터 동기화 (로드: 클라우드 + 로컬 병합)
export async function syncFromDrive(callback) {
    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const cloudData = await downloadFile(fileId);
            if (Array.isArray(cloudData)) {
                // 내 기기의 데이터와 클라우드 데이터를 합칩니다.
                const merged = mergeData(cloudData, state.entries);
                
                // 합친 결과로 갱신
                state.entries = merged;
                localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                renderEntries(); 
                console.log("동기화(로드&병합) 완료");
            }
        } else {
            // 파일이 없으면 내 데이터를 올림
            await saveToDrive(); 
        }
        if(callback) callback(true);
    } catch (err) {
        handleDriveError(err, callback);
    }
}

// 5. 저장 (업로드: 최신 데이터 확인 후 병합하여 저장)
export async function saveToDrive() {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        // 현재 내 기기의 최신 상태
        let entriesToSave = state.entries;

        if (fileId) {
            try {
                // [중요] 저장하기 직전에 클라우드에서 최신본을 한 번 더 가져옴
                const cloudData = await downloadFile(fileId);
                if (Array.isArray(cloudData)) {
                    // 클라우드 데이터와 내 데이터를 다시 병합 (충돌 방지)
                    entriesToSave = mergeData(cloudData, state.entries);
                    
                    // 병합된 최신 상태를 내 기기에도 반영
                    state.entries = entriesToSave;
                    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                    renderEntries();
                }
            } catch (e) {
                console.warn("병합 전 읽기 실패, 강제 저장 시도", e);
            }
        }

        const fileContent = JSON.stringify(entriesToSave);
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

// [강력한 병합 로직]
function mergeData(cloud, local) {
    const map = new Map();

    // 1. 클라우드 데이터를 기준점으로 잡음
    cloud.forEach(item => map.set(item.id, item));

    // 2. 로컬 데이터를 순회하며 비교
    local.forEach(localItem => {
        const cloudItem = map.get(localItem.id);
        
        if (!cloudItem) {
            // 클라우드엔 없는데 내 폰엔 있다? -> 내가 새로 쓴 글이므로 추가
            map.set(localItem.id, localItem);
        } else {
            // 둘 다 있다 -> 수정 시간을 비교 (밀리초 단위)
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp).getTime();

            // 내 폰의 수정 시간이 더 미래(최신)라면 내 걸로 덮어씀
            // (같거나 과거라면 클라우드 데이터 유지)
            if (localTime > cloudTime) {
                map.set(localItem.id, localItem);
            }
        }
    });

    // 3. Map을 배열로 변환하여 반환
    return Array.from(map.values());
}

async function downloadFile(fileId) {
    const response = await gapi.client.drive.files.get({
        fileId: fileId,
        alt: 'media'
    });
    // JSON 파싱 시 오류 방지
    try {
        if(typeof response.result === 'string') return JSON.parse(response.result);
        return response.result;
    } catch(e) {
        return [];
    }
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