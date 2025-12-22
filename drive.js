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
            
            // 토큰 유효성 정밀 검사
            const storedToken = localStorage.getItem('faith_token');
            const storedExp = localStorage.getItem('faith_token_exp');
            const now = Date.now();

            // 토큰이 있고, 만료 시간보다 1분 이상 남았을 때만 재사용
            if (storedToken && storedExp && now < (parseInt(storedExp) - 60000)) {
                gapi.client.setToken({ access_token: storedToken });
                state.currentUser = { name: "Google User", provider: "google" };
                console.log("세션 유효: 자동 동기화 시작");
                await syncFromDrive(callback);
            } else {
                console.log("세션 만료 또는 없음: 재로그인 필요");
                // 만료된 토큰은 즉시 폐기
                localStorage.removeItem('faith_token');
                localStorage.removeItem('faith_token_exp');
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
            if (resp.error !== undefined) {
                throw (resp);
            }
            
            const expiresIn = resp.expires_in || 3599; 
            const expiryTime = Date.now() + (expiresIn * 1000);
            localStorage.setItem('faith_token', resp.access_token);
            localStorage.setItem('faith_token_exp', expiryTime);

            state.currentUser = { name: "Google User", provider: "google" };
            
            // 로그인 성공 직후 즉시 동기화 실행
            await syncFromDrive(callback);
        },
    });
    gisInited = true;
}

// 2. 동기화 버튼 클릭 핸들러 (만료 체크 포함)
export function handleAuthClick() {
    if(!gisInited || !gapiInited) return alert("연결 준비 중입니다. 잠시만 기다려주세요.");

    // 토큰이 만료되었는지 확인하고, 만료되었으면 바로 로그인 창 띄움 (에러 팝업 X)
    const storedExp = localStorage.getItem('faith_token_exp');
    const now = Date.now();

    if (!state.currentUser || !storedExp || now >= (parseInt(storedExp) - 60000)) {
        // 토큰 요청 (로그인 팝업)
        tokenClient.requestAccessToken({prompt: 'consent'});
    } else {
        // 이미 로그인 상태면 동기화 진행
        syncFromDrive();
    }
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
            // 로그아웃 시 로컬 데이터는 유지하되 화면 갱신
            renderEntries();
            if(callback) callback();
        });
    }
}

// 4. 데이터 동기화 (로드 -> 병합 -> 저장)
export async function syncFromDrive(callback) {
    if (!state.currentUser) return;

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        if (fileId) {
            const cloudRawData = await downloadFile(fileId);
            
            let cloudEntries = [];
            let cloudCategories = null;
            let cloudOrder = null;
            let cloudCatTime = null;

            // 데이터 구조 파싱
            if (cloudRawData) {
                if (Array.isArray(cloudRawData)) {
                    cloudEntries = cloudRawData;
                } else if (typeof cloudRawData === 'object') {
                    cloudEntries = Array.isArray(cloudRawData.entries) ? cloudRawData.entries : [];
                    cloudCategories = cloudRawData.categories;
                    cloudOrder = cloudRawData.categoryOrder;
                    cloudCatTime = cloudRawData.categoryUpdatedAt;
                }
            }

            // 1. 글 데이터 병합 (내 폰의 오프라인 작성글 보호)
            const merged = mergeData(cloudEntries, state.entries || []);
            state.entries = merged;
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));

            // 2. 카테고리 동기화
            if (cloudCategories && cloudOrder) {
                const localTime = new Date(state.categoryUpdatedAt || 0).getTime();
                const serverTime = new Date(cloudCatTime || 0).getTime();

                // 서버가 더 최신이거나 로컬이 초기값이면 덮어씀
                if (serverTime > localTime || localTime === 0) {
                    state.allCategories = cloudCategories;
                    state.categoryOrder = cloudOrder;
                    state.categoryUpdatedAt = cloudCatTime;
                    
                    saveCategoriesToLocal();
                    
                    // 현재 탭 유효성 검사
                    const currentValid = state.allCategories.find(c => c.id === state.currentCategory);
                    if (!currentValid && state.categoryOrder.length > 0) {
                        state.currentCategory = state.categoryOrder[0];
                    }
                    console.log("카테고리 업데이트 완료");
                }
            }

            // [중요] 동기화 후 반드시 화면 갱신
            renderTabs();
            renderEntries(); 
            console.log("동기화 완료");
        } else {
            // 파일이 없으면 내 데이터로 새로 생성
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

    // 만료 직전이면 저장 시도 중지하고 재인증 유도 가능 (여기서는 조용히 실패 후 다음 기회 노림)
    const storedExp = localStorage.getItem('faith_token_exp');
    if (!storedExp || Date.now() >= (parseInt(storedExp) - 60000)) {
        console.warn("토큰 만료로 저장 건너뜀");
        return;
    }

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDbFile(folderId);
        
        let entriesToSave = state.entries || [];
        
        // 최종 저장할 카테고리 (기본값: 내 기기)
        let finalCategories = state.allCategories;
        let finalOrder = state.categoryOrder;
        let finalCatTime = state.categoryUpdatedAt || new Date(0).toISOString();

        // 저장 전 최신 클라우드 데이터 확인 (병합)
        if (fileId) {
            try {
                const cloudRawData = await downloadFile(fileId);
                
                let cloudEntries = [];
                let cloudCatData = null;

                if (cloudRawData) {
                    if (Array.isArray(cloudRawData)) {
                        cloudEntries = cloudRawData;
                    } else if (typeof cloudRawData === 'object') {
                        cloudEntries = Array.isArray(cloudRawData.entries) ? cloudRawData.entries : [];
                        cloudCatData = cloudRawData;
                    }
                }
                
                // 글 병합
                entriesToSave = mergeData(cloudEntries, state.entries || []);
                state.entries = entriesToSave;
                localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
                // 병합된 결과 화면 반영
                renderEntries();

                // 카테고리 충돌 해결 (서버가 최신이면 서버 데이터 유지)
                if (cloudCatData && cloudCatData.categoryUpdatedAt) {
                    const serverTime = new Date(cloudCatData.categoryUpdatedAt).getTime();
                    const localTime = new Date(state.categoryUpdatedAt || 0).getTime();

                    if (serverTime > localTime) {
                        console.log("서버 카테고리가 더 최신임. 서버 데이터 유지.");
                        finalCategories = cloudCatData.categories;
                        finalOrder = cloudCatData.categoryOrder;
                        finalCatTime = cloudCatData.categoryUpdatedAt;
                        
                        // 내 로컬도 최신으로 업데이트
                        state.allCategories = finalCategories;
                        state.categoryOrder = finalOrder;
                        state.categoryUpdatedAt = finalCatTime;
                        saveCategoriesToLocal();
                        renderTabs();
                    }
                }

            } catch (e) {
                console.warn("병합 전 읽기 실패, 강제 저장", e);
            }
        }

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
        
        console.log("안전하게 저장 완료");

    } catch (err) {
        handleDriveError(err);
    }
}

// [병합 로직 강화]
function mergeData(cloud, local) {
    if (!Array.isArray(cloud)) cloud = [];
    if (!Array.isArray(local)) local = [];

    const map = new Map();
    // 1. 클라우드 데이터를 먼저 담음
    cloud.forEach(item => { if(item && item.id) map.set(item.id, item); });
    
    // 2. 로컬 데이터를 덮어씀
    local.forEach(localItem => {
        if (!localItem || !localItem.id) return;
        
        const cloudItem = map.get(localItem.id);
        if (!cloudItem) {
            // 클라우드에 없으면 추가 (새 글)
            map.set(localItem.id, localItem);
        } else {
            // 둘 다 있으면 수정 시간 비교
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp).getTime();
            
            // 로컬이 최신이거나, 로컬에서 삭제(Purged) 표시가 있으면 로컬 우선
            if (localTime >= cloudTime || (localItem.isPurged && !cloudItem.isPurged)) {
                map.set(localItem.id, localItem);
            }
        }
    });
    
    // 3. 날짜순 정렬 (최신순)
    return Array.from(map.values()).sort((a, b) => {
        const timeA = new Date(a.modifiedAt || a.timestamp).getTime();
        const timeB = new Date(b.modifiedAt || b.timestamp).getTime();
        return timeB - timeA;
    });
}

async function downloadFile(fileId) {
    try {
        // 캐시 방지 헤더 추가
        const response = await gapi.client.drive.files.get({
            fileId: fileId,
            alt: 'media'
        });
        if(typeof response.result === 'string') {
            return response.result ? JSON.parse(response.result) : null;
        }
        return response.result || null;
    } catch(e) { 
        console.warn("파일 다운로드 실패", e);
        return null;
    }
}

function handleDriveError(err, callback) {
    console.error("Drive Error Check", err);
    
    // 인증 만료 에러 (401) 처리
    if(err.status === 401 || (err.result && err.result.error && err.result.error.code === 401)) {
        console.warn("인증 만료됨. 재로그인 유도");
        localStorage.removeItem('faith_token');
        localStorage.removeItem('faith_token_exp');
        state.currentUser = null;
        
        // 여기서 alert를 띄우지 않고, 그냥 조용히 로그아웃 처리하거나
        // 사용자가 다시 버튼을 누르도록 유도 (UI 갱신 필요 시 여기서 호출)
        renderEntries();
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