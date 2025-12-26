import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTabs } from './ui.js';

let tokenClient;
let gapiInited = false;
let gisInited = false;

// 동기화 상태 락 (중복 실행 방지)
let isSyncing = false;
let pendingSync = false;

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

        // 로그인 직후 강제 동기화
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

// ==========================================
// 2. 스마트 병합 동기화 (Robust Ver.)
// ==========================================

export async function saveToDrive() {
    if (!gapi.client.getToken()) return;

    // 이미 실행 중이면 대기열 등록 (중복 방지)
    if (isSyncing) {
        console.log("동기화 중... 다음 요청 대기");
        pendingSync = true;
        return;
    }

    isSyncing = true;
    toggleSpinners(true);

    try {
        // 1. 폴더 및 파일 확인 (최신 파일 찾기)
        const folderId = await ensureAppFolder();
        const fileId = await findDBFile(folderId);
        
        let cloudData = { entries: [], categories: [], categoryOrder: [], categoryUpdatedAt: "1970-01-01T00:00:00.000Z" };

        // 2. 클라우드 데이터 가져오기 (Pull) - 캐시 방지 적용
        if (fileId) {
            try {
                // [핵심] fetch를 직접 사용하여 캐시 제어 헤더 추가 가능성 열어둠
                // gapi client는 기본적으로 캐싱을 안 하지만, 확실하게 하기 위해 로직 보강
                const response = await gapi.client.drive.files.get({
                    fileId: fileId,
                    alt: 'media'
                });
                
                if (response.result) {
                    cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
                }
            } catch(e) {
                console.warn("클라우드 데이터 읽기 실패 (파일 손상 등). 덮어씁니다.", e);
            }
        }

        // 3. 데이터 병합 (Merge)
        // 내 기기의 데이터(state.entries)와 클라우드 데이터(cloudData.entries)를 비교
        const mergedEntries = mergeEntries(state.entries, cloudData.entries || []);
        const mergedCategories = mergeCategories(state, cloudData);

        // 병합된 결과로 현재 상태 업데이트 (화면 반영)
        state.entries = mergedEntries;
        state.allCategories = mergedCategories.categories;
        state.categoryOrder = mergedCategories.order;
        state.categoryUpdatedAt = mergedCategories.updatedAt;

        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveCategoriesToLocal();

        // 4. 병합된 최종본 업로드 (Push)
        const finalData = {
            entries: state.entries,
            categories: state.allCategories,
            order: state.categoryOrder,
            categoryUpdatedAt: state.categoryUpdatedAt,
            lastSync: new Date().toISOString() // 동기화 시점 기록
        };

        const fileContent = JSON.stringify(finalData);
        
        const fileMetadata = {
            name: DB_FILE_NAME,
            mimeType: 'application/json'
        };
        
        // 새 파일일 때만 부모 폴더 지정
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
        
        console.log("동기화 성공 (Merge & Push)");
        renderEntries();

    } catch (err) {
        console.error("Save to Drive Error", err);
    } finally {
        isSyncing = false;
        toggleSpinners(false);

        // 대기 중인 요청이 있다면 즉시 재실행 (데이터 일관성 보장)
        if (pendingSync) {
            pendingSync = false;
            setTimeout(saveToDrive, 200); 
        }
    }
}

export async function syncFromDrive() {
    // 로드 시에도 saveToDrive를 호출하여 'Pull & Merge' 과정을 거치게 함으로써
    // 내 기기에 저장되지 않은 변경사항을 보호하고 클라우드와 합침
    await saveToDrive();
}

// [병합 로직 정밀화]
function mergeEntries(localList, cloudList) {
    const entryMap = new Map();

    // 1. 클라우드 데이터를 맵에 먼저 넣음
    cloudList.forEach(item => {
        if(item && item.id) entryMap.set(item.id, item);
    });
    
    // 2. 로컬 데이터를 하나씩 확인하며 비교
    localList.forEach(localItem => {
        if(!localItem || !localItem.id) return;

        const cloudItem = entryMap.get(localItem.id);
        
        if (!cloudItem) {
            // 클라우드에 없으면 로컬 데이터 추가 (새 글)
            entryMap.set(localItem.id, localItem);
        } else {
            // 둘 다 있으면 수정 시간 비교
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
            
            // [중요] 로컬이 '같거나' 더 최신이면 로컬이 이김
            // (동시 수정 시 로컬 사용자 경험 우선)
            if (localTime >= cloudTime) {
                entryMap.set(localItem.id, localItem);
            }
            // 클라우드가 더 최신이면 맵에 있는 클라우드 데이터 유지
        }
    });
    
    // 3. 최신순 정렬 반환
    return Array.from(entryMap.values()).sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return dateB - dateA;
    });
}

function mergeCategories(localState, cloudData) {
    const localTime = new Date(localState.categoryUpdatedAt || 0).getTime();
    const cloudTime = new Date(cloudData.categoryUpdatedAt || 0).getTime();

    // 카테고리는 구조가 바뀌는 것이므로, 시간이 더 최신인 쪽을 전체 채택
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
    // 폴더가 삭제되었을 수 있으니 trashed=false 조건 필수
    const q = `mimeType='application/vnd.google-apps.folder' and name='${APP_FOLDER_NAME}' and trashed=false`;
    const response = await gapi.client.drive.files.list({ q, fields: 'files(id, name)' });
    
    if (response.result.files.length > 0) {
        return response.result.files[0].id;
    }
    
    // 폴더 없으면 생성
    const res = await gapi.client.drive.files.create({
        resource: { name: APP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
    });
    return res.result.id;
}

async function findDBFile(folderId) {
    // [중요] 같은 이름의 파일이 여러 개일 경우, '수정 시간 역순'으로 정렬하여 가장 최신 파일을 가져옴
    const q = `name='${DB_FILE_NAME}' and '${folderId}' in parents and trashed=false`;
    const response = await gapi.client.drive.files.list({ 
        q, 
        orderBy: 'modifiedTime desc', // 최신 파일 우선
        fields: 'files(id, name, modifiedTime)' 
    });
    
    if (response.result.files.length > 0) {
        // 혹시 중복 파일이 있다면 가장 첫 번째(최신) 것 사용
        return response.result.files[0].id;
    }
    return null;
}