import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';
import { refreshEditorContent } from './editor.js';

let tokenClient = null;
let gapiInited = false;
let gisInited = false;
let isSyncing = false;
let pendingSync = false;
let refreshTimer = null;

/**
 * [핵심] 웨일에서 팝업 차단을 방지하기 위해 
 * 인증 클라이언트를 전역에서 즉시 접근 가능한 상태로 유지합니다.
 */
export function initGoogleDrive(callback) {
    if (typeof gapi === 'undefined' || typeof google === 'undefined' || !google.accounts) {
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
            
            // 앱 실행 시 자동 세션 복구
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

    // GIS 인증 클라이언트 설정
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: async (resp) => {
            if (resp.error) {
                console.error("인증 응답 에러:", resp.error);
                return;
            }
            saveTokenInfo(resp);
            const userInfo = await gapi.client.drive.about.get({ fields: 'user' });
            state.currentUser = userInfo.result.user;
            await syncFromDrive();
            if (window.onAuthSuccess) window.onAuthSuccess(); 
        },
    });
    gisInited = true;
}

/**
 * [웨일 해결책] 클릭 이벤트와 인증창 호출 사이에 어떤 지연도 없도록 수정했습니다.
 */
export function handleAuthClick() {
    if (!tokenClient) {
        alert("인증 시스템을 불러오는 중입니다. 1~2초 후 다시 눌러주세요.");
        initGoogleDrive();
        return;
    }
    // 웨일에서 가장 안정적인 'select_account' 옵션을 사용하며 직속 호출합니다.
    try {
        tokenClient.requestAccessToken({ prompt: 'select_account' });
    } catch (e) {
        console.error("인증 요청 실패:", e);
        alert("웨일 브라우저의 팝업 차단 설정을 확인해 주세요.");
    }
}

async function ensureValidToken(isAutoSave = false) {
    const storedToken = localStorage.getItem('faith_token');
    const storedExp = localStorage.getItem('faith_token_exp');
    const isLoggedIn = localStorage.getItem('is_faith_logged_in') === 'true';
    const now = Date.now();

    if (storedToken && storedExp && now < (parseInt(storedExp) - 300000)) {
        if (!gapi.client.getToken()) {
            gapi.client.setToken({ access_token: storedToken });
        }
        return true;
    }

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

export function handleSignoutClick(callback) {
    const token = gapi.client.getToken();
    if (token) google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken('');
    localStorage.removeItem('faith_token');
    localStorage.removeItem('faith_token_exp');
    localStorage.removeItem('is_faith_logged_in');
    state.currentUser = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    if(callback) callback();
}

/**
 * 실시간 동기화 및 병합 (전체 로직 보존)
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
                renderTabs(); renderEntries(); refreshEditorContent();
            }
        }
        await uploadToDrive(folderId, fileMeta ? fileMeta.id : null);
    } catch (err) {
        console.error("드라이브 통신 에러:", err);
    } finally {
        isSyncing = false;
        toggleSpinners(false);
        if (pendingSync) { pendingSync = false; setTimeout(saveToDrive, 1000); }
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