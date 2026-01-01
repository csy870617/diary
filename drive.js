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
let syncTimeoutTimer = null; // 동기화 멈춤 방지용 타이머

/**
 * 토큰 유효성 검사 및 자동 갱신 (오래된 세션 대응 강화)
 */
async function ensureValidToken() {
    const storedToken = localStorage.getItem('faith_token');
    const storedExp = localStorage.getItem('faith_token_exp');
    const now = Date.now();

    // 토큰이 없거나 만료 5분 전이면 미리 갱신 시도 (안전 마진 확보)
    if (!storedToken || !storedExp || now >= (parseInt(storedExp) - 300000)) {
        return new Promise((resolve) => {
            try {
                tokenClient.callback = async (resp) => {
                    if (resp.error) {
                        console.error("인증 갱신 실패:", resp.error);
                        resolve(false);
                        return;
                    }
                    const expiresIn = resp.expires_in || 3599; 
                    const expTime = Date.now() + (expiresIn * 1000);
                    localStorage.setItem('faith_token', resp.access_token);
                    localStorage.setItem('faith_token_exp', expTime);
                    gapi.client.setToken({ access_token: resp.access_token });
                    resolve(true);
                };
                // prompt: '' 는 이미 허용된 세션에 대해 팝업 없이 조용히 갱신을 시도함
                tokenClient.requestAccessToken({ prompt: '' });
            } catch (err) {
                console.error("Token Client Error", err);
                resolve(false);
            }
        });
    }
    
    // 로컬엔 있지만 gapi 메모리에 없을 경우 재설정
    if (!gapi.client.getToken()) {
        gapi.client.setToken({ access_token: storedToken });
    }
    return true;
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
            console.error("GAPI 초기화 실패", err);
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
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
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
        await saveToDrive(); 
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

/**
 * 정교한 동기화 프로세스 (인증 오류 시 복구 로직 포함)
 */
export async function saveToDrive() {
    if (!localStorage.getItem('faith_token')) return; 
    if (isSyncing) { pendingSync = true; return; }

    const isValid = await ensureValidToken();
    if (!isValid) return;

    isSyncing = true;
    toggleSpinners(true);

    // 동기화가 너무 오래 걸릴 경우(네트워크 행 걸림)를 대비한 타임아웃 설정
    if (syncTimeoutTimer) clearTimeout(syncTimeoutTimer);
    syncTimeoutTimer = setTimeout(() => {
        if (isSyncing) {
            console.warn("동기화 타임아웃 발생. 상태를 초기화합니다.");
            isSyncing = false;
            toggleSpinners(false);
        }
    }, 30000);

    try {
        const folderId = await ensureAppFolder();
        const fileMeta = await findDBFileMeta(folderId);
        
        let cloudData = null;
        if (fileMeta) {
            if (!lastCloudModifiedTime || fileMeta.modifiedTime !== lastCloudModifiedTime) {
                const response = await gapi.client.drive.files.get({
                    fileId: fileMeta.id,
                    alt: 'media'
                });
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
        console.error("동기화 중 에러 발생:", err);
        // [중요] 세션 만료 에러(401) 처리: 로컬 정보를 만료된 것으로 처리 후 재시도
        if (err.status === 401 || err.status === 403) {
            localStorage.removeItem('faith_token_exp'); 
            isSyncing = false; // 재시도를 위해 일시적으로 해제
            return await saveToDrive(); 
        }
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

    const boundary = '-------314159265358979323846';
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
        if (!cloudItem) {
            entryMap.set(localItem.id, localItem);
        } else {
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
            if (localTime >= cloudTime) entryMap.set(localItem.id, localItem);
        }
    });
    return Array.from(entryMap.values()).sort((a, b) => {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
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