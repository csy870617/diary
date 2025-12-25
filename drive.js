import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// ==========================================
// 1. Google API 초기화
// ==========================================
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
            
            // 토큰 유효성 검사 및 복구
            const storedToken = localStorage.getItem('faith_token');
            const storedExp = localStorage.getItem('faith_token_exp');
            const now = Date.now();

            if (storedToken && storedExp && now < (parseInt(storedExp) - 60000)) {
                gapi.client.setToken({ access_token: storedToken });
                checkAuthAndSync(callback);
            } else {
                state.isLoading = false;
                renderEntries();
                if(callback) callback(false);
            }
        } catch (err) {
            console.error("GAPI Init Error", err);
            state.isLoading = false;
            renderEntries();
        }
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error) throw resp;
            const expiresIn = resp.expires_in; 
            const expTime = Date.now() + (expiresIn * 1000);
            localStorage.setItem('faith_token', resp.access_token);
            localStorage.setItem('faith_token_exp', expTime);
            
            // 로그인 성공 시 즉시 동기화 시작
            await checkAuthAndSync(callback);
        },
    });
    gisInited = true;
}

export function handleAuthClick() {
    if (tokenClient) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    }
}

export function handleSignoutClick(callback) {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token);
        gapi.client.setToken('');
        localStorage.removeItem('faith_token');
        localStorage.removeItem('faith_token_exp');
        state.currentUser = null;
        if(callback) callback();
    }
}

async function checkAuthAndSync(callback) {
    if (!gapi.client.getToken()) {
        if(callback) callback(false);
        return;
    }
    
    try {
        // 사용자 정보 가져오기
        const userInfo = await gapi.client.drive.about.get({ fields: 'user' });
        state.currentUser = userInfo.result.user;
        
        // 로그인 UI 업데이트
        const loginBtn = document.getElementById('login-btn-header');
        if (loginBtn) {
            loginBtn.innerHTML = `
                <div style="display:flex; align-items:center; gap:6px;">
                    <img src="${state.currentUser.photoLink}" style="width:20px; height:20px; border-radius:50%;">
                    <span>${state.currentUser.displayName}</span>
                </div>
            `;
            const msgWrapper = document.querySelector('.login-msg-wrapper');
            if(msgWrapper) msgWrapper.style.display = 'none';
        }

        // [중요] 로그인 직후 클라우드 데이터와 병합 동기화
        await syncFromDrive();
        if(callback) callback(true);

    } catch (err) {
        console.error("Auth Check Error", err);
        if(err.status === 401) {
            localStorage.removeItem('faith_token');
            state.currentUser = null;
        }
        if(callback) callback(false);
    }
}

// ==========================================
// 2. 스마트 병합 동기화 (Smart Merge Sync)
// ==========================================

// 로컬 변경사항을 저장할 때 호출 (Save -> Pull -> Merge -> Push)
export async function saveToDrive() {
    if (!gapi.client.getToken()) return; // 비로그인 시 로컬 저장만 유지

    try {
        const refreshBtn = document.getElementById('refresh-btn');
        if(refreshBtn) refreshBtn.classList.add('rotating');

        // 1. 클라우드에서 최신 데이터 가져오기
        const folderId = await ensureAppFolder();
        const fileId = await findDBFile(folderId);
        
        let cloudData = { entries: [], categories: [], categoryOrder: [], categoryUpdatedAt: "1970-01-01T00:00:00.000Z" };

        if (fileId) {
            const response = await gapi.client.drive.files.get({
                fileId: fileId,
                alt: 'media'
            });
            if (response.result) {
                cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
            }
        }

        // 2. 데이터 병합 (Merge)
        const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
        const mergedCategories = mergeCategories(state, cloudData);

        // 3. 상태 업데이트 (로컬 반영)
        state.entries = mergedEntries;
        state.allCategories = mergedCategories.categories;
        state.categoryOrder = mergedCategories.order;
        state.categoryUpdatedAt = mergedCategories.updatedAt;

        // 로컬 스토리지도 갱신
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveCategoriesToLocal();

        // 4. 병합된 데이터를 클라우드에 업로드 (Push)
        const finalData = {
            entries: state.entries,
            categories: state.allCategories,
            order: state.categoryOrder,
            categoryUpdatedAt: state.categoryUpdatedAt,
            lastSync: new Date().toISOString()
        };

        const fileContent = JSON.stringify(finalData);
        const metadata = {
            name: DB_FILE_NAME,
            mimeType: 'application/json',
            parents: [folderId]
        };

        const multipartRequestBody =
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            JSON.stringify(metadata) +
            delimiter +
            'Content-Type: application/json\r\n\r\n' +
            fileContent +
            close_delim;

        const request = gapi.client.request({
            'path': fileId ? `/upload/drive/v3/files/${fileId}` : '/upload/drive/v3/files',
            'method': fileId ? 'PATCH' : 'POST',
            'params': { 'uploadType': 'multipart' },
            'headers': { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
            'body': multipartRequestBody
        });

        await request;
        
        if(refreshBtn) refreshBtn.classList.remove('rotating');
        console.log("동기화 완료 (Merge Success)");

    } catch (err) {
        console.error("Save to Drive Error", err);
        const refreshBtn = document.getElementById('refresh-btn');
        if(refreshBtn) refreshBtn.classList.remove('rotating');
    }
}

// 클라우드 데이터를 가져와서 병합만 수행 (로드 시 호출)
export async function syncFromDrive() {
    if (!gapi.client.getToken()) return;

    try {
        state.isLoading = true;
        renderEntries(); // 로딩 표시

        const folderId = await ensureAppFolder();
        const fileId = await findDBFile(folderId);

        if (!fileId) {
            state.isLoading = false;
            renderEntries();
            return; // 클라우드 파일 없으면 로컬 데이터 유지
        }

        const response = await gapi.client.drive.files.get({
            fileId: fileId,
            alt: 'media'
        });

        const cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;

        // 병합 로직 수행
        const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
        const mergedCategories = mergeCategories(state, cloudData);

        // 상태 업데이트
        state.entries = mergedEntries;
        state.allCategories = mergedCategories.categories;
        state.categoryOrder = mergedCategories.order;
        state.categoryUpdatedAt = mergedCategories.updatedAt;

        // 로컬 저장소 갱신
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveCategoriesToLocal();

        state.isLoading = false;
        renderTabs();
        renderEntries();

    } catch (err) {
        console.error("Sync Error", err);
        state.isLoading = false;
        renderEntries();
    }
}

// [핵심] 일기 데이터 병합 로직 (타임스탬프 기준)
function mergeEntries(local, cloud) {
    const entryMap = new Map();

    // 1. 클라우드 데이터 먼저 등록
    cloud.forEach(item => entryMap.set(item.id, item));

    // 2. 로컬 데이터로 덮어쓰거나 추가 (더 최신인 경우만)
    local.forEach(localItem => {
        const cloudItem = entryMap.get(localItem.id);
        
        if (!cloudItem) {
            // 클라우드에 없으면 추가 (새 글)
            entryMap.set(localItem.id, localItem);
        } else {
            // 둘 다 있으면 modifiedAt 비교
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();

            if (localTime > cloudTime) {
                entryMap.set(localItem.id, localItem); // 로컬이 더 최신이면 덮어씀
            }
            // 클라우드가 더 최신이면 가만히 둠 (클라우드 데이터 유지)
        }
    });

    // 배열로 변환 후 정렬
    return Array.from(entryMap.values()).sort((a, b) => {
        const dateA = new Date(a.timestamp).getTime();
        const dateB = new Date(b.timestamp).getTime();
        return dateB - dateA;
    });
}

// 카테고리 데이터 병합 로직
function mergeCategories(localState, cloudData) {
    const localTime = new Date(localState.categoryUpdatedAt || 0).getTime();
    const cloudTime = new Date(cloudData.categoryUpdatedAt || 0).getTime();

    // 더 최신 업데이트된 쪽의 카테고리 구조를 따름
    if (cloudTime > localTime && cloudData.categories && cloudData.categories.length > 0) {
        return {
            categories: cloudData.categories,
            order: cloudData.order || [],
            updatedAt: cloudData.categoryUpdatedAt
        };
    } else {
        return {
            categories: localState.allCategories,
            order: localState.categoryOrder,
            updatedAt: localState.categoryUpdatedAt
        };
    }
}

// ------------------------------------------
// 아래는 기존 구글 드라이브 파일/폴더 헬퍼 함수들
// ------------------------------------------
const boundary = '-------314159265358979323846';
const delimiter = "\r\n--" + boundary + "\r\n";
const close_delim = "\r\n--" + boundary + "--";

async function ensureAppFolder() {
    const q = `mimeType='application/vnd.google-apps.folder' and name='${APP_FOLDER_NAME}' and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    if (response.result.files.length > 0) return response.result.files[0].id;
    const res = await gapi.client.drive.files.create({
        resource: { name: APP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
    });
    return res.result.id;
}

async function findDBFile(folderId) {
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    if (response.result.files.length > 0) return response.result.files[0].id;
    return null;
}