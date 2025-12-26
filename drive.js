import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// 동기화 상태 제어
let isSyncing = false;
let pendingSync = false;
let lastCloudModifiedTime = null; // 클라우드 파일의 마지막 수정 시간 저장

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

        // 로그인 직후 강제 동기화
        await syncFromDrive(true);
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

// core sync function
export async function saveToDrive(isForce = false) {
    if (!gapi.client.getToken()) return;

    if (isSyncing) {
        pendingSync = true;
        return;
    }

    isSyncing = true;
    toggleSpinners(true);

    try {
        const folderId = await ensureAppFolder();
        const fileMeta = await findDBFileMeta(folderId);
        
        // 클라우드 수정 시간이 로컬 기록과 같다면 (변경사항이 없다면) 업로드만 진행하거나 스킵
        if (!isForce && fileMeta && lastCloudModifiedTime === fileMeta.modifiedTime) {
            // 로컬 데이터만 업로드 (최적화: Pull 생략)
            await uploadToDrive(folderId, fileMeta.id);
        } else {
            // Pull & Merge & Push 전체 프로세스
            let cloudData = { entries: [], categories: [], categoryOrder: [], categoryUpdatedAt: "1970-01-01T00:00:00.000Z" };
            
            if (fileMeta) {
                const response = await gapi.client.drive.files.get({
                    fileId: fileMeta.id,
                    alt: 'media'
                });
                cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
            }

            // 정밀 병합
            const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
            const mergedCats = mergeCategories(state, cloudData);

            state.entries = mergedEntries;
            state.allCategories = mergedCats.categories;
            state.categoryOrder = mergedCats.order;
            state.categoryUpdatedAt = mergedCats.updatedAt;

            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
            saveCategoriesToLocal();

            await uploadToDrive(folderId, fileMeta ? fileMeta.id : null);
        }
        
        // 동기화 후 시점 기록
        const updatedMeta = await findDBFileMeta(folderId);
        if(updatedMeta) lastCloudModifiedTime = updatedMeta.modifiedTime;

        renderTabs();
        renderEntries();

    } catch (err) {
        console.error("Sync Process Error", err);
    } finally {
        isSyncing = false;
        toggleSpinners(false);
        if (pendingSync) {
            pendingSync = false;
            setTimeout(() => saveToDrive(false), 500);
        }
    }
}

export async function syncFromDrive(isForce = false) {
    await saveToDrive(isForce);
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

function mergeEntries(localList, cloudList) {
    const entryMap = new Map();
    // 클라우드 우선 로드
    cloudList.forEach(item => { if(item && item.id) entryMap.set(item.id, item); });
    
    localList.forEach(localItem => {
        if(!localItem || !localItem.id) return;
        const cloudItem = entryMap.get(localItem.id);
        
        if (!cloudItem) {
            entryMap.set(localItem.id, localItem);
        } else {
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
            
            // 더 최신 수정본을 선택
            if (localTime > cloudTime) {
                entryMap.set(localItem.id, localItem);
            }
            // 같거나 클라우드가 크면 클라우드 유지
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
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ 
        q, 
        orderBy: 'modifiedTime desc',
        fields: 'files(id, name, modifiedTime)' 
    });
    return response.result.files.length > 0 ? response.result.files[0] : null;
}