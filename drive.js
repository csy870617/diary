import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';
import { refreshEditorContent } from './editor.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let isSyncing = false;
let pendingSync = false;
let refreshTimer = null;

/**
 * [핵심 수정] 토큰 유효성 검사 및 인앱 세션 복구 로직
 */
async function ensureValidToken(isAutoSave = false) {
    const storedToken = localStorage.getItem('faith_token');
    const storedExp = localStorage.getItem('faith_token_exp');
    const isLoggedIn = localStorage.getItem('is_faith_logged_in') === 'true';
    const now = Date.now();

    // 1. 유효한 토큰이 이미 있는 경우
    if (storedToken && storedExp && now < (parseInt(storedExp) - 300000)) {
        if (!gapi.client.getToken()) {
            gapi.client.setToken({ access_token: storedToken });
        }
        return true;
    }

    // 2. 인앱 브라우저 세션 복구 (배경에서 조용히 갱신)
    if (isLoggedIn && tokenClient) {
        return new Promise((resolve) => {
            try {
                tokenClient.callback = async (resp) => {
                    if (resp.error) {
                        console.warn("세션 갱신 실패:", resp.error);
                        if (!isAutoSave) localStorage.removeItem('is_faith_logged_in');
                        resolve(false);
                        return;
                    }
                    saveTokenInfo(resp);
                    resolve(true);
                };
                // prompt: ''는 이미 로그인된 경우 팝업 없이 세션을 가져오는 옵션입니다.
                tokenClient.requestAccessToken({ prompt: '' });
            } catch (err) {
                console.error("Auth Refresh Error:", err);
                resolve(false);
            }
        });
    }
    return false;
}

function saveTokenInfo(resp) {
    const expiresIn = resp.expires_in || 3599; 
    const expTime = Date.now() + (expiresIn * 1000);
    localStorage.setItem('faith_token', resp.access_token);
    localStorage.setItem('faith_token_exp', expTime);
    localStorage.setItem('is_faith_logged_in', 'true');
    gapi.client.setToken({ access_token: resp.access_token });
    setupAutoRefresh(expiresIn);
}

function setupAutoRefresh(expiresInSeconds) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max((expiresInSeconds - 600) * 1000, 1000);
    refreshTimer = setTimeout(() => ensureValidToken(true), delay);
}

export function initGoogleDrive(callback) {
    if (typeof gapi === 'undefined' || typeof google === 'undefined') {
        setTimeout(() => initGoogleDrive(callback), 200);
        return;
    }

    gapi.load('client', async () => {
        try {
            await gapi.client.init({
                apiKey: GOOGLE_CONFIG.API_KEY,
                discoveryDocs: [GOOGLE_CONFIG.DISCOVERY_DOC],
            });
            gapiInited = true;
            
            if (localStorage.getItem('is_faith_logged_in') === 'true') {
                const success = await ensureValidToken(true);
                if (success) {
                    const userInfo = await gapi.client.drive.about.get({ fields: 'user' });
                    state.currentUser = userInfo.result.user;
                    await syncFromDrive();
                    if(callback) callback(true);
                    return;
                }
            }
            if(callback) callback(false);
        } catch (err) {
            console.error("GAPI 초기화 실패", err);
            if(callback) callback(false);
        }
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error) return;
            saveTokenInfo(resp);
            const userInfo = await gapi.client.drive.about.get({ fields: 'user' });
            state.currentUser = userInfo.result.user;
            await syncFromDrive();
            if (window.onAuthSuccess) window.onAuthSuccess(); // auth.js와 연동
        },
    });
    gisInited = true;
}

export function handleAuthClick() {
    // 인앱 브라우저에서는 consent보다 select_account가 더 안정적입니다.
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'select_account' });
}

export function handleSignoutClick(callback) {
    const token = gapi.client.getToken();
    if (token) google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken('');
    localStorage.clear(); // 세션 완전 초기화
    if (refreshTimer) clearTimeout(refreshTimer);
    if(callback) callback();
}

/**
 * 드라이브 동기화 및 파일 관리 로직 (전체 유지)
 */
export async function saveToDrive() {
    if (localStorage.getItem('is_faith_logged_in') !== 'true') return;
    if (isSyncing) { pendingSync = true; return; }

    const isValid = await ensureValidToken(true);
    if (!isValid) return;

    isSyncing = true;
    toggleSpinners(true);

    try {
        const folderId = await ensureAppFolder();
        const fileMeta = await findDBFileMeta(folderId);
        
        if (fileMeta) {
            const response = await gapi.client.drive.files.get({ fileId: fileMeta.id, alt: 'media' });
            const cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
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
        }
        await uploadToDrive(folderId, fileMeta ? fileMeta.id : null);
    } catch (err) {
        console.error("Drive Sync Error:", err);
    } finally {
        isSyncing = false;
        toggleSpinners(false);
        if (pendingSync) {
            pendingSync = false;
            setTimeout(saveToDrive, 1000);
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
    
    const boundary = '-------faith_log_boundary';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";
    const multipartRequestBody =
        delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(fileMetadata) +
        delimiter + 'Content-Type: application/json\r\n\r\n' + fileContent + close_delim;

    return await gapi.client.request({
        'path': fileId ? `/upload/drive/v3/files/${fileId}` : '/upload/drive/v3/files',
        'method': fileId ? 'PATCH' : 'POST',
        'params': { 'uploadType': 'multipart' },
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
        if (!cloudItem) entryMap.set(localItem.id, localItem);
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
    if (cloudTime > localTime && cloudData.categories) {
        return { categories: cloudData.categories, order: cloudData.order || [], updatedAt: cloudData.categoryUpdatedAt };
    }
    return { categories: localState.allCategories, order: localState.categoryOrder, updatedAt: localState.categoryUpdatedAt };
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

function toggleSpinners(active) {
    const listBtn = document.getElementById('refresh-btn');
    if (listBtn) listBtn.classList.toggle('rotating', active);
}