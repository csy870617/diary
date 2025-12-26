import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// [동기화 안전 장치]
let isSyncing = false;      // 현재 동기화 중인지 여부
let pendingSync = false;    // 대기 중인 동기화 요청이 있는지 여부

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

            if (storedToken && storedExp && now < (parseInt(storedExp) - 60000)) {
                gapi.client.setToken({ access_token: storedToken });
                state.currentUser = { name: "Google User", provider: "google" };
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
            const expiresIn = resp.expires_in || 3599; 
            const expTime = Date.now() + (expiresIn * 1000);
            localStorage.setItem('faith_token', resp.access_token);
            localStorage.setItem('faith_token_exp', expTime);
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
        const userInfo = await gapi.client.drive.about.get({ fields: 'user' });
        state.currentUser = userInfo.result.user;
        
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

function toggleSpinners(active) {
    const refreshBtn = document.getElementById('refresh-btn');
    const editorSyncBtn = document.getElementById('editor-sync-btn');
    
    if (active) {
        if(refreshBtn) refreshBtn.classList.add('rotating');
        if(editorSyncBtn) editorSyncBtn.classList.add('rotating');
    } else {
        if(refreshBtn) refreshBtn.classList.remove('rotating');
        if(editorSyncBtn) editorSyncBtn.classList.remove('rotating');
    }
}

// ==========================================
// 2. 스마트 병합 동기화 (Lock 시스템 적용)
// ==========================================

export async function saveToDrive() {
    if (!gapi.client.getToken()) return;

    // 이미 동기화 중이면 대기열에 등록하고 리턴 (중복 실행 방지)
    if (isSyncing) {
        console.log("동기화 중... 대기열에 등록됨");
        pendingSync = true;
        return;
    }

    isSyncing = true;
    toggleSpinners(true);

    try {
        const folderId = await ensureAppFolder();
        const fileId = await findDBFile(folderId);
        
        let cloudData = { entries: [], categories: [], categoryOrder: [], categoryUpdatedAt: "1970-01-01T00:00:00.000Z" };

        // 1. Pull (가져오기)
        if (fileId) {
            const response = await gapi.client.drive.files.get({
                fileId: fileId,
                alt: 'media'
            });
            if (response.result) {
                cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
            }
        }

        // 2. Merge (병합)
        const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
        const mergedCategories = mergeCategories(state, cloudData);

        state.entries = mergedEntries;
        state.allCategories = mergedCategories.categories;
        state.categoryOrder = mergedCategories.order;
        state.categoryUpdatedAt = mergedCategories.updatedAt;

        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveCategoriesToLocal();

        // 3. Push (업로드)
        const finalData = {
            entries: state.entries,
            categories: state.allCategories,
            order: state.categoryOrder,
            categoryUpdatedAt: state.categoryUpdatedAt,
            lastSync: new Date().toISOString()
        };

        const fileContent = JSON.stringify(finalData);
        
        const fileMetadata = {
            name: DB_FILE_NAME,
            mimeType: 'application/json'
        };
        // 새 파일일 때만 부모 폴더 지정 (403 에러 방지)
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

        const request = gapi.client.request({
            'path': fileId ? `/upload/drive/v3/files/${fileId}` : '/upload/drive/v3/files',
            'method': fileId ? 'PATCH' : 'POST',
            'params': { 'uploadType': 'multipart' },
            'headers': { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
            'body': multipartRequestBody
        });

        await request;
        console.log("동기화 완료 (Smart Merge)");
        renderEntries(); // 화면 최신화

    } catch (err) {
        console.error("Save to Drive Error", err);
    } finally {
        isSyncing = false;
        toggleSpinners(false);

        // 대기 중인 요청이 있었다면 즉시 다시 실행
        if (pendingSync) {
            pendingSync = false;
            setTimeout(saveToDrive, 500); // 0.5초 딜레이 후 재시도
        }
    }
}

export async function syncFromDrive() {
    // saveToDrive는 Pull-Merge-Push를 모두 수행하므로, 
    // 단순 로드 시에도 saveToDrive를 사용하여 데이터 정합성을 맞춥니다.
    // 다만, 로드 시점에는 '내 로컬 변경사항'이 없을 확률이 높으므로 Pull 위주로 동작합니다.
    await saveToDrive();
}

function mergeEntries(local, cloud) {
    const entryMap = new Map();
    cloud.forEach(item => entryMap.set(item.id, item));
    
    local.forEach(localItem => {
        const cloudItem = entryMap.get(localItem.id);
        if (!cloudItem) {
            entryMap.set(localItem.id, localItem);
        } else {
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
            // 로컬이 최신이거나 같으면 로컬 우선
            if (localTime >= cloudTime) {
                entryMap.set(localItem.id, localItem);
            }
        }
    });
    
    return Array.from(entryMap.values()).sort((a, b) => {
        const dateA = new Date(a.timestamp).getTime();
        const dateB = new Date(b.timestamp).getTime();
        return dateB - dateA;
    });
}

function mergeCategories(localState, cloudData) {
    const localTime = new Date(localState.categoryUpdatedAt || 0).getTime();
    const cloudTime = new Date(cloudData.categoryUpdatedAt || 0).getTime();

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