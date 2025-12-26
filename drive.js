import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let isSyncing = false;
let pendingSync = false;

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
        if(callback) callback(false);
    }
}

function toggleSpinners(active) {
    const listBtn = document.getElementById('refresh-btn');
    const editorBtn = document.getElementById('editor-sync-btn');
    if (active) {
        if(listBtn) listBtn.classList.add('rotating');
        if(editorBtn) editorBtn.classList.add('rotating');
    } else {
        if(listBtn) listBtn.classList.remove('rotating');
        if(editorBtn) editorBtn.classList.remove('rotating');
    }
}

/**
 * 완벽 동기화 (Pull -> Merge -> Push)
 */
export async function saveToDrive() {
    if (!gapi.client.getToken()) return;

    if (isSyncing) {
        pendingSync = true;
        return;
    }

    isSyncing = true;
    toggleSpinners(true);

    try {
        console.log("동기화 시작: 클라우드 데이터 확인 중...");
        const folderId = await ensureAppFolder();
        const fileMeta = await findDBFileMeta(folderId);
        
        let cloudData = { entries: [], categories: [], categoryOrder: [], categoryUpdatedAt: "1970-01-01T00:00:00.000Z" };
        
        // 1. 클라우드 데이터 Pull (캐시 방지를 위해 랜덤 쿼리 추가)
        if (fileMeta) {
            const response = await gapi.client.drive.files.get({
                fileId: fileMeta.id,
                alt: 'media',
                // API 내부적으로 최신본을 가져오도록 보장
                fields: '*' 
            });
            cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
            console.log("클라우드 데이터 획득 성공.");
        }

        // 2. 정밀 병합 (ModifiedAt 기준)
        const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
        const mergedCats = mergeCategories(state, cloudData);

        // 3. 병합 결과 반영
        state.entries = mergedEntries;
        state.allCategories = mergedCats.categories;
        state.categoryOrder = mergedCats.order;
        state.categoryUpdatedAt = mergedCats.updatedAt;

        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveCategoriesToLocal();

        // 4. 최종 데이터 Push
        await uploadToDrive(folderId, fileMeta ? fileMeta.id : null);
        console.log("클라우드 업로드 완료. 동기화 성공.");

        // UI 즉시 업데이트
        renderTabs();
        renderEntries();

    } catch (err) {
        console.error("동기화 실패:", err);
    } finally {
        isSyncing = false;
        toggleSpinners(false);
        if (pendingSync) {
            pendingSync = false;
            setTimeout(saveToDrive, 500);
        }
    }
}

export async function syncFromDrive() {
    await saveToDrive();
}

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

    await gapi.client.request({
        'path': fileId ? `/upload/drive/v3/files/${fileId}` : '/upload/drive/v3/files',
        'method': fileId ? 'PATCH' : 'POST',
        'params': { 'uploadType': 'multipart' },
        'headers': { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
        'body': multipartRequestBody
    });
}

/**
 * 시간 기반 정밀 병합
 */
function mergeEntries(localList, cloudList) {
    const entryMap = new Map();
    
    // 1. 클라우드 데이터를 먼저 담습니다.
    cloudList.forEach(item => { if(item && item.id) entryMap.set(item.id, item); });
    
    // 2. 로컬 데이터를 비교합니다.
    localList.forEach(localItem => {
        if(!localItem || !localItem.id) return;
        const cloudItem = entryMap.get(localItem.id);
        
        if (!cloudItem) {
            entryMap.set(localItem.id, localItem);
        } else {
            // ISO 문자열을 밀리초 단위 숫자로 변환하여 비교
            const localTime = Date.parse(localItem.modifiedAt || localItem.timestamp || 0);
            const cloudTime = Date.parse(cloudItem.modifiedAt || cloudItem.timestamp || 0);
            
            // 로컬 시간이 더 최신일 때만 교체, 아니면 클라우드 데이터 유지
            if (localTime > cloudTime) {
                entryMap.set(localItem.id, localItem);
            }
        }
    });
    
    return Array.from(entryMap.values()).sort((a, b) => {
        return Date.parse(b.timestamp) - Date.parse(a.timestamp);
    });
}

function mergeCategories(localState, cloudData) {
    const localTime = Date.parse(localState.categoryUpdatedAt || 0);
    const cloudTime = Date.parse(cloudData.categoryUpdatedAt || 0);

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

async function findDBFileMeta(folderId) {
    // 쿼리 시점에 최신 메타데이터를 가져오도록 trashed=false 유지
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ 
        q, 
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, modifiedTime)' 
    });
    return response.result.files.length > 0 ? response.result.files[0] : null;
}