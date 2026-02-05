import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';
import { refreshEditorContent } from './editor.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let isSyncing = false;
let pendingSync = false;
let lastCloudModifiedTime = null; 
let syncTimeoutTimer = null; 
let refreshTimer = null; // [추가] 토큰 자동 갱신용 타이머

/**
 * [핵심 수정] 토큰 유효성 검사 및 자동 갱신 로직 강화
 * 사용자가 로그아웃하기 전까지 세션을 유지합니다.
 */
async function ensureValidToken(isAutoSave = false) {
    const storedToken = localStorage.getItem('faith_token');
    const storedExp = localStorage.getItem('faith_token_exp');
    const isLoggedIn = localStorage.getItem('is_faith_logged_in') === 'true';
    const now = Date.now();

    // 1. 토큰이 유효한 경우
    if (storedToken && storedExp && now < (parseInt(storedExp) - 300000)) {
        if (!gapi.client.getToken()) {
            gapi.client.setToken({ access_token: storedToken });
        }
        return true;
    }

    // 2. 세션이 만료되었지만 로그인 상태인 경우 (배경에서 조용히 복구)
    if (isLoggedIn && tokenClient) {
        return new Promise((resolve) => {
            tokenClient.callback = async (resp) => {
                if (resp.error) {
                    if (!isAutoSave) localStorage.removeItem('is_faith_logged_in');
                    resolve(false);
                    return;
                }
                saveTokenInfo(resp);
                resolve(true);
            };
            tokenClient.requestAccessToken({ prompt: '' }); 
        });
    }
    return false;
}

/**
 * [추가] 토큰 정보 저장 및 UI 갱신 알림
 */
function saveTokenInfo(resp) {
    const expiresIn = resp.expires_in || 3599; 
    const expTime = Date.now() + (expiresIn * 1000);
    localStorage.setItem('faith_token', resp.access_token);
    localStorage.setItem('faith_token_exp', expTime);
    localStorage.setItem('is_faith_logged_in', 'true');
    gapi.client.setToken({ access_token: resp.access_token });
    
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => ensureValidToken(true), (expiresIn - 600) * 1000);
}

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
            
            // 로그인 플래그가 있다면 자동 로그인 시도
            if (localStorage.getItem('is_faith_logged_in') === 'true') {
                const success = await ensureValidToken(true);
                if (success) {
                    await checkAuthAndSync(callback);
                    return;
                }
            }
            state.isLoading = false;
            renderEntries();
            if(callback) callback(false);
        } catch (err) {
            console.error("GAPI 초기화 실패", err);
            state.isLoading = false;
            renderEntries();
            if(callback) callback(false);
        }
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error) return;
            saveTokenInfo(resp);
            await checkAuthAndSync(callback);
            if (window.onAuthSuccess) window.onAuthSuccess(); // auth.js 연동
        },
    });
    gisInited = true;
}

export function handleAuthClick() {
    // 웨일에서 가장 안정적인 select_account 옵션 사용
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'select_account' });
}

export function handleSignoutClick(callback) {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token);
        gapi.client.setToken('');
    }
    localStorage.removeItem('faith_token');
    localStorage.removeItem('faith_token_exp');
    localStorage.removeItem('is_faith_logged_in');
    state.currentUser = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    if(callback) callback();
}

async function checkAuthAndSync(callback) {
    if (!gapi.client.getToken()) {
        if(callback) callback(false);
        return;
    }
    try {
        const userInfo = await gapi.client.drive.about.get({ fields: 'user' });
        state.currentUser = userInfo.result.user;
        await syncFromDrive(); 
        if(callback) callback(true);
    } catch (err) {
        if(callback) callback(false);
    }
}

function toggleSpinners(active) {
    const listBtn = document.getElementById('refresh-btn');
    if (active) { if(listBtn) listBtn.classList.add('rotating'); } 
    else { if(listBtn) listBtn.classList.remove('rotating'); }
}

export async function saveToDrive() {
    if (localStorage.getItem('is_faith_logged_in') !== 'true') return; 
    if (isSyncing) { pendingSync = true; return; }

    const isValid = await ensureValidToken(true);
    if (!isValid) return;

    isSyncing = true;
    toggleSpinners(true);

    if (syncTimeoutTimer) clearTimeout(syncTimeoutTimer);
    syncTimeoutTimer = setTimeout(() => {
        if (isSyncing) { isSyncing = false; toggleSpinners(false); }
    }, 30000);

    try {
        const folderId = await ensureAppFolder();
        const fileMeta = await findDBFileMeta(folderId);
        
        let cloudData = null;
        if (fileMeta) {
            if (!lastCloudModifiedTime || fileMeta.modifiedTime !== lastCloudModifiedTime) {
                const response = await gapi.client.drive.files.get({ fileId: fileMeta.id, alt: 'media' });
                cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
                lastCloudModifiedTime = fileMeta.modifiedTime;
            }
        }

        if (cloudData) {
            state.entries = mergeEntries(state.entries, cloudData.entries || []);
            const mergedCats = mergeCategories(state, cloudData);
            state.allCategories = mergedCats.categories;
            state.categoryOrder = mergedCats.order;
            state.categoryUpdatedAt = mergedCats.updatedAt;

            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
            saveCategoriesToLocal();
            renderTabs();
            renderEntries();
            refreshEditorContent();
        }

        const uploadRes = await uploadToDrive(folderId, fileMeta ? fileMeta.id : null);
        if (uploadRes && uploadRes.result) {
            lastCloudModifiedTime = uploadRes.result.modifiedTime;
        }

    } catch (err) {
        console.error("구글 드라이브 저장 실패:", err);
    } finally {
        if (syncTimeoutTimer) clearTimeout(syncTimeoutTimer);
        isSyncing = false;
        toggleSpinners(false);
        if (pendingSync) {
            pendingSync = false;
            setTimeout(saveToDrive, 500);
        }
    }
}

export async function syncFromDrive() { await saveToDrive(); }

async function uploadToDrive(folderId, fileId) {
    const finalData = {
        entries: state.entries,
        categories: state.allCategories,
        order: state.categoryOrder,
        categoryUpdatedAt: state.categoryUpdatedAt,
        lastSync: new Date().toISOString()
    };
    const fileContent = JSON.stringify(finalData);
    const fileMetadata = { name: DB_FILE_NAME, mimeType: 'application/json' };
    if (!fileId) fileMetadata.parents = [folderId];
    const boundary = '-------faith_log_multipart_boundary';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";
    const multipartRequestBody =
        delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(fileMetadata) +
        delimiter + 'Content-Type: application/json\r\n\r\n' + fileContent + close_delim;

    return await gapi.client.request({
        'path': fileId ? `/upload/drive/v3/files/${fileId}` : '/upload/drive/v3/files',
        'method': fileId ? 'PATCH' : 'POST',
        'params': { 'uploadType': 'multipart', 'fields': 'id, name, modifiedTime' },
        'headers': { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
        'body': multipartRequestBody
    });
}

function mergeEntries(localList, cloudList) {
    const entryMap = new Map();
    cloudList.forEach(item => { if(item && item.id) entryMap.set(item.id, item); });
    localList.forEach(localItem => {
        if(!localItem || !localItem.id) return;
        const cloudItem = entryMap.get(localItem.id);
        if (!cloudItem) { entryMap.set(localItem.id, localItem); } 
        else {
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
            if (localTime >= cloudTime) entryMap.set(localItem.id, localItem);
        }
    });
    return Array.from(entryMap.values()).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function mergeCategories(localState, cloudData) {
    const localTime = new Date(localState.categoryUpdatedAt || 0).getTime();
    const cloudTime = new Date(cloudData.categoryUpdatedAt || 0).getTime();
    if (cloudTime > localTime && cloudData.categories && cloudData.categories.length > 0) {
        return { categories: cloudData.categories, order: cloudData.order || [], updatedAt: cloudData.categoryUpdatedAt };
    } else {
        return { categories: localState.allCategories, order: localState.categoryOrder, updatedAt: localState.categoryUpdatedAt };
    }
}

async function ensureAppFolder() {
    const q = `mimeType='application/vnd.google-apps.folder' and name='${APP_FOLDER_NAME}' and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    if (response.result.files.length > 0) return response.result.files[0].id;
    const res = await gapi.client.drive.files.create({ resource: { name: APP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
    return res.result.id;
}

async function findDBFileMeta(folderId) {
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, orderBy: 'modifiedTime desc', fields: 'files(id, name, modifiedTime)' });
    return response.result.files.length > 0 ? response.result.files[0] : null;
}