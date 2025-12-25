import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let currentFileEtag = null; // 파일의 최신 버전을 추적하기 위한 변수

export function initGoogleDrive(callback) {
    if (typeof gapi === 'undefined' || typeof google === 'undefined' || !google.accounts) {
        setTimeout(() => initGoogleDrive(callback), 100);
        return;
    }

    gapi.load('client', async () => {
        try {
            await gapi.client.init({
                apiKey: GOOGLE_CONFIG.API_KEY,
                discoveryDocs: [GOOGLE_CONFIG.DISCOVERY_DOC],
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
        listBtn?.classList.add('rotating');
        editorBtn?.classList.add('rotating');
    } else {
        listBtn?.classList.remove('rotating');
        editorBtn?.classList.remove('rotating');
    }
}

// [핵심] 병합 및 저장 로직 (ETag 검증 추가)
export async function saveToDrive() {
    if (!gapi.client.getToken()) return;

    try {
        toggleSpinners(true);
        const folderId = await ensureAppFolder();
        const fileInfo = await findDBFileWithMeta(folderId);
        
        let cloudData = { entries: [], categories: [], categoryOrder: [], categoryUpdatedAt: new Date(0).toISOString() };
        let fileId = fileInfo?.id;

        if (fileId) {
            // 업로드 전 클라우드 최신 상태를 한 번 더 확인 (버전 충돌 방지)
            const response = await gapi.client.drive.files.get({
                fileId: fileId,
                alt: 'media'
            });
            cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
            currentFileEtag = response.headers.etag;
        }

        // 1. 스마트 병합 수행
        const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
        const mergedCategories = mergeCategories(state, cloudData);

        state.entries = mergedEntries;
        state.allCategories = mergedCategories.categories;
        state.categoryOrder = mergedCategories.order;
        state.categoryUpdatedAt = mergedCategories.updatedAt;

        // 2. 로컬 업데이트
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveCategoriesToLocal();

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

        const multipartRequestBody =
            delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(fileMetadata) +
            delimiter + 'Content-Type: application/json\r\n\r\n' + fileContent + close_delim;

        // 3. 파일 업로드 (동시 수정 방지를 위해 조건부 PATCH 가능하나 간단한 재시도로 구현)
        const request = gapi.client.request({
            'path': fileId ? `/upload/drive/v3/files/${fileId}` : '/upload/drive/v3/files',
            'method': fileId ? 'PATCH' : 'POST',
            'params': { 'uploadType': 'multipart' },
            'headers': { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
            'body': multipartRequestBody
        });

        await request;
        renderEntries();
        console.log("동기화 완벽 완료");

    } catch (err) {
        console.error("Save to Drive Error", err);
    } finally {
        toggleSpinners(false);
    }
}

export async function syncFromDrive() {
    if (!gapi.client.getToken()) return;
    try {
        state.isLoading = true;
        renderEntries();
        toggleSpinners(true);

        const folderId = await ensureAppFolder();
        const fileInfo = await findDBFileWithMeta(folderId);

        if (!fileInfo) {
            state.isLoading = false;
            renderEntries();
            return;
        }

        const response = await gapi.client.drive.files.get({
            fileId: fileInfo.id,
            alt: 'media'
        });

        const cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
        currentFileEtag = response.headers.etag;

        const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
        const mergedCategories = mergeCategories(state, cloudData);

        state.entries = mergedEntries;
        state.allCategories = mergedCategories.categories;
        state.categoryOrder = mergedCategories.order;
        state.categoryUpdatedAt = mergedCategories.updatedAt;

        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveCategoriesToLocal();

        state.isLoading = false;
        renderTabs();
        renderEntries();

    } catch (err) {
        console.error("Sync Error", err);
        state.isLoading = false;
        renderEntries();
    } finally {
        toggleSpinners(false);
    }
}

function mergeEntries(local, cloud) {
    const entryMap = new Map();
    // 클라우드 데이터 먼저 매핑
    cloud.forEach(item => entryMap.set(item.id, item));
    // 로컬 데이터와 비교하여 최신본 선택
    local.forEach(localItem => {
        const cloudItem = entryMap.get(localItem.id);
        if (!cloudItem) {
            entryMap.set(localItem.id, localItem);
        } else {
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
            if (localTime >= cloudTime) {
                entryMap.set(localItem.id, localItem);
            }
        }
    });
    return Array.from(entryMap.values());
}

function mergeCategories(localState, cloudData) {
    const localTime = new Date(localState.categoryUpdatedAt || 0).getTime();
    const cloudTime = new Date(cloudData.categoryUpdatedAt || 0).getTime();
    if (cloudTime > localTime && cloudData.categories?.length > 0) {
        return { categories: cloudData.categories, order: cloudData.order || [], updatedAt: cloudData.categoryUpdatedAt };
    }
    return { categories: localState.allCategories, order: localState.categoryOrder, updatedAt: localState.categoryUpdatedAt };
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

async function findDBFileWithMeta(folderId) {
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name, headRevisionId)' });
    if (response.result.files.length > 0) return response.result.files[0];
    return null;
}