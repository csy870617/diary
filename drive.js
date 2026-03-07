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
let refreshTimer = null;
let keepAliveTimer = null;
let mainTokenCallback = null; // 원본 tokenClient 콜백 보존용
let silentRefreshAbortFn = null; // silent refresh 중단용

/**
 * 토큰 유효성 검사 및 자동 갱신 로직
 * - 실패 시 최대 3회 재시도 (지수 백오프)
 * - 로그인 상태를 유지하여 세션이 끊기지 않도록 함
 */
async function ensureValidToken(isAutoSave = false) {
    const storedToken = localStorage.getItem('faith_token');
    const storedExp = localStorage.getItem('faith_token_exp');
    const isLoggedIn = localStorage.getItem('is_faith_logged_in') === 'true';
    const now = Date.now();

    // 1. 토큰이 유효한 경우 (만료 5분 전까지 유효)
    if (storedToken && storedExp && now < (parseInt(storedExp) - 300000)) {
        if (!gapi.client.getToken()) {
            gapi.client.setToken({ access_token: storedToken });
        }
        return true;
    }

    // 2. 세션이 만료되었지만 로그인 상태인 경우 → 재시도 포함 자동 복구
    if (isLoggedIn && tokenClient) {
        return await silentTokenRefreshWithRetry();
    }
    return false;
}

/**
 * 토큰 갱신을 최대 3회 재시도 (1초, 2초, 4초 간격)
 */
async function silentTokenRefreshWithRetry(maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const success = await silentTokenRefresh();
        if (success) return true;
        if (attempt < maxRetries - 1) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
    return false;
}

function silentTokenRefresh() {
    return new Promise((resolve) => {
        const restoreCallback = () => {
            if (mainTokenCallback) tokenClient.callback = mainTokenCallback;
            silentRefreshAbortFn = null;
        };
        const timeout = setTimeout(() => {
            restoreCallback();
            resolve(false);
        }, 10000);

        // handleAuthClick에서 호출하여 silent refresh를 중단할 수 있도록 함
        silentRefreshAbortFn = () => {
            clearTimeout(timeout);
            restoreCallback();
            resolve(false);
        };

        tokenClient.callback = async (resp) => {
            clearTimeout(timeout);
            restoreCallback();
            if (resp.error) {
                resolve(false);
                return;
            }
            saveTokenInfo(resp);
            resolve(true);
        };
        tokenClient.requestAccessToken({ prompt: '' });
    });
}

function saveTokenInfo(resp) {
    const expiresIn = resp.expires_in || 3599;
    const expTime = Date.now() + (expiresIn * 1000);
    localStorage.setItem('faith_token', resp.access_token);
    localStorage.setItem('faith_token_exp', expTime);
    localStorage.setItem('is_faith_logged_in', 'true');
    gapi.client.setToken({ access_token: resp.access_token });

    // 만료 10분 전에 자동 갱신 예약
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => ensureValidToken(true), (expiresIn - 600) * 1000);
}

/**
 * 주기적으로 토큰 유효성을 확인하여 세션이 끊기지 않도록 함
 * - 5분마다 토큰 상태 확인
 * - 만료가 임박하면 자동 갱신
 */
export function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(async () => {
        if (localStorage.getItem('is_faith_logged_in') !== 'true') return;
        const storedExp = localStorage.getItem('faith_token_exp');
        const now = Date.now();
        // 만료 15분 이내이면 미리 갱신
        if (storedExp && now > (parseInt(storedExp) - 900000)) {
            await ensureValidToken(true);
        }
    }, 5 * 60 * 1000); // 5분
}

function stopKeepAlive() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

/**
 * 탭이 다시 활성화될 때 토큰 유효성을 확인
 * - 토큰이 유효하면 바로 사용
 * - 만료되었으면 silent refresh 시도 (페이지 활성 상태 유지)
 */
export async function ensureTokenOnResume() {
    if (localStorage.getItem('is_faith_logged_in') !== 'true') return false;
    const storedToken = localStorage.getItem('faith_token');
    const storedExp = localStorage.getItem('faith_token_exp');
    const now = Date.now();
    if (storedToken && storedExp && now < (parseInt(storedExp) - 300000)) {
        if (!gapi.client.getToken()) {
            gapi.client.setToken({ access_token: storedToken });
        }
        return true;
    }
    // 토큰 만료 시 silent refresh 시도 (로그인 상태 유지)
    if (tokenClient) {
        return await silentTokenRefreshWithRetry();
    }
    return false;
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
            
            // 로그인 플래그가 있다면 저장된 토큰으로 자동 로그인 시도
            if (localStorage.getItem('is_faith_logged_in') === 'true') {
                const storedToken = localStorage.getItem('faith_token');
                const storedExp = localStorage.getItem('faith_token_exp');
                const now = Date.now();

                if (storedToken && storedExp && now < (parseInt(storedExp) - 300000)) {
                    // 토큰이 아직 유효 → 팝업 없이 바로 사용
                    gapi.client.setToken({ access_token: storedToken });
                    startKeepAlive();
                    await checkAuthAndSync(callback);
                    return;
                }
                // 토큰 만료 → silent refresh 시도 (팝업 없이 자동 갱신)
                // initTokenClient 완료 후 실행되도록 지연
                setTimeout(async () => {
                    if (tokenClient) {
                        const refreshed = await silentTokenRefreshWithRetry();
                        if (refreshed) {
                            startKeepAlive();
                            await checkAuthAndSync(callback);
                            if (window.onAuthSuccess) window.onAuthSuccess();
                        }
                    }
                }, 500);
                return;
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

    mainTokenCallback = async (resp) => {
        if (resp.error) {
            console.error("Google 인증 오류:", resp.error);
            if (callback) callback(false);
            return;
        }
        saveTokenInfo(resp);
        startKeepAlive();
        await checkAuthAndSync(callback);
        if (window.onAuthSuccess) window.onAuthSuccess(); // auth.js 연동
    };

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: mainTokenCallback,
    });
    gisInited = true;
}

export function handleAuthClick() {
    // 진행 중인 silent refresh가 있으면 중단 (콜백 충돌 방지)
    if (silentRefreshAbortFn) {
        silentRefreshAbortFn();
    }
    if (tokenClient) {
        // 유저 로그인 응답이 mainTokenCallback으로 처리되도록 보장
        tokenClient.callback = mainTokenCallback;
        tokenClient.requestAccessToken({ prompt: 'select_account' });
    }
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
    localStorage.removeItem('faithLogDB');
    localStorage.removeItem('faithCatData');
    state.currentUser = null;
    state.entries = [];
    if (refreshTimer) clearTimeout(refreshTimer);
    stopKeepAlive();
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
    } catch (err) {
        console.error("사용자 정보 조회 실패:", err);
        // 토큰이 유효하지 않은 경우 (401) → 토큰 갱신 시도 후 재확인
        if (err.status === 401) {
            if (tokenClient) {
                const refreshed = await silentTokenRefreshWithRetry();
                if (refreshed) {
                    try {
                        const retryInfo = await gapi.client.drive.about.get({ fields: 'user' });
                        state.currentUser = retryInfo.result.user;
                    } catch (retryErr) {
                        // 갱신 후에도 실패 → 로그아웃
                        localStorage.removeItem('faith_token');
                        localStorage.removeItem('faith_token_exp');
                        localStorage.removeItem('is_faith_logged_in');
                        if(callback) callback(false);
                        return;
                    }
                } else {
                    // 갱신 실패 → 로그아웃
                    localStorage.removeItem('faith_token');
                    localStorage.removeItem('faith_token_exp');
                    localStorage.removeItem('is_faith_logged_in');
                    if(callback) callback(false);
                    return;
                }
            } else {
                localStorage.removeItem('faith_token');
                localStorage.removeItem('faith_token_exp');
                localStorage.removeItem('is_faith_logged_in');
                if(callback) callback(false);
                return;
            }
        }
        // 다른 오류 (네트워크 등) → 로그인 상태 유지, 동기화만 실패
    }
    // 로그인 성공으로 UI 업데이트 (동기화 실패와 무관하게)
    if(callback) callback(true);
    try {
        await syncFromDrive();
    } catch (syncErr) {
        console.error("초기 동기화 실패:", syncErr);
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