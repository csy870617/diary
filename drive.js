import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal, isReadOnlyView, migrateRootOrder } from './state.js';
import { renderEntries, renderTabs, renderFolders } from './ui.js';
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
let mainTokenErrorCallback = null; // 원본 tokenClient error_callback 보존용
let syncRunId = 0; // 동기화 실행 세대 — 워치독/finally가 다른 실행의 플래그를 건드리지 않도록 함
let currentSyncPromise = null; // 진행 중인 동기화 완료 대기용 (로그아웃 시 사용)
let silentRefreshAbortFn = null; // silent refresh 중단용
let isRefreshing = false; // 토큰 갱신 중복 방지 뮤텍스
let refreshPromise = null; // 진행 중인 갱신 Promise 공유용
let lastResumeCheck = 0; // resume 이벤트 디바운스용
let syncWarningTimer = null; // 동기화 경고 디바운스용

function showSyncWarning(message) {
    // 짧은 시간 내 중복 경고 방지
    if (syncWarningTimer) return;
    syncWarningTimer = setTimeout(() => { syncWarningTimer = null; }, 30000);
    const existing = document.getElementById('sync-warning-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'sync-warning-toast';
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;padding:12px 20px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:90vw;text-align:center;';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

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
 * - 뮤텍스로 동시 갱신 요청을 방지하여 콜백 충돌 제거
 * - 이미 갱신 중이면 진행 중인 Promise를 공유하여 중복 호출 방지
 */
async function silentTokenRefreshWithRetry(maxRetries = 3) {
    // 이미 갱신 중이면 진행 중인 Promise 결과를 기다림
    if (isRefreshing && refreshPromise) {
        return await refreshPromise;
    }

    isRefreshing = true;
    refreshPromise = (async () => {
        try {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                const success = await silentTokenRefresh();
                if (success) return true;
                if (attempt < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
                }
            }
            return false;
        } finally {
            isRefreshing = false;
            refreshPromise = null;
        }
    })();

    return await refreshPromise;
}

function silentTokenRefresh() {
    return new Promise((resolve) => {
        const restoreCallback = () => {
            if (mainTokenCallback) tokenClient.callback = mainTokenCallback;
            tokenClient.error_callback = mainTokenErrorCallback;
            silentRefreshAbortFn = null;
        };
        const timeout = setTimeout(() => {
            console.warn("Silent token refresh 타임아웃 (15초)");
            restoreCallback();
            resolve(false);
        }, 15000);

        // handleAuthClick에서 호출하여 silent refresh를 중단할 수 있도록 함
        silentRefreshAbortFn = () => {
            clearTimeout(timeout);
            restoreCallback();
            resolve(false);
        };

        // error_callback: FedCM 또는 팝업이 차단/실패 시 즉시 호출됨
        // (타임아웃까지 기다리지 않고 빠르게 실패 처리)
        tokenClient.error_callback = (err) => {
            clearTimeout(timeout);
            restoreCallback();
            console.warn("Silent refresh 실패 (error_callback):", err?.type || err?.message || err);
            resolve(false);
        };

        tokenClient.callback = async (resp) => {
            clearTimeout(timeout);
            restoreCallback();
            if (resp.error) {
                console.warn("Silent refresh 응답 오류:", resp.error);
                resolve(false);
                return;
            }
            saveTokenInfo(resp);
            resolve(true);
        };
        const savedEmail = getSavedUserEmail();
        tokenClient.requestAccessToken({
            prompt: '',
            ...(savedEmail && { login_hint: savedEmail })
        });
    });
}

function saveTokenInfo(resp) {
    const expiresIn = resp.expires_in || 3599;
    const expTime = Date.now() + (expiresIn * 1000);
    localStorage.setItem('faith_token', resp.access_token);
    localStorage.setItem('faith_token_exp', String(expTime));
    localStorage.setItem('is_faith_logged_in', 'true');
    gapi.client.setToken({ access_token: resp.access_token });

    // 만료 20분 전에 자동 갱신 예약 (여유를 두어 갱신 실패 시 재시도 시간 확보)
    if (refreshTimer) clearTimeout(refreshTimer);
    const refreshLeadTime = Math.max(expiresIn - 1200, 60); // 최소 60초 후
    refreshTimer = setTimeout(() => {
        if (isReadOnlyView()) return; // 읽기 전용/책 모드에서는 토큰 갱신 안 함
        ensureValidToken(true);
    }, refreshLeadTime * 1000);
}

/**
 * 사용자 이메일을 저장하여 재로그인 시 login_hint로 사용
 * → 계정 선택 화면 없이 바로 로그인 가능
 */
function saveUserEmail(email) {
    if (email) localStorage.setItem('faith_user_email', email);
}

function getSavedUserEmail() {
    return localStorage.getItem('faith_user_email') || '';
}

/**
 * 주기적으로 토큰 유효성을 확인하여 세션이 끊기지 않도록 함
 * - 5분마다 토큰 상태 확인
 * - 만료가 임박하면 자동 갱신
 */
export function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(async () => {
        if (isReadOnlyView()) return; // 읽기 전용/책 모드에서는 토큰 갱신 안 함
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
 * - 디바운스 적용: 2초 이내 중복 호출 방지 (focus + visibilitychange 동시 발생 대응)
 * - 토큰이 유효하면 바로 사용
 * - 만료되었으면 silent refresh 시도 (페이지 활성 상태 유지)
 */
export async function ensureTokenOnResume() {
    if (localStorage.getItem('is_faith_logged_in') !== 'true') return false;

    // 디바운스: 2초 이내 중복 호출 방지
    const now = Date.now();
    if (now - lastResumeCheck < 2000) {
        // 최근에 이미 확인했으면 현재 토큰 상태만 반환
        const storedToken = localStorage.getItem('faith_token');
        const storedExp = localStorage.getItem('faith_token_exp');
        return !!(storedToken && storedExp && now < (parseInt(storedExp) - 300000));
    }
    lastResumeCheck = now;

    const storedToken = localStorage.getItem('faith_token');
    const storedExp = localStorage.getItem('faith_token_exp');
    if (storedToken && storedExp && now < (parseInt(storedExp) - 300000)) {
        if (!gapi.client.getToken()) {
            gapi.client.setToken({ access_token: storedToken });
        }
        return true;
    }
    // 토큰 만료 시 silent refresh 시도 (로그인 상태 유지)
    if (tokenClient) {
        const refreshed = await silentTokenRefreshWithRetry();
        if (!refreshed) {
            // silent refresh 실패해도 즉시 로그아웃하지 않음
            // → 네트워크 일시적 문제일 수 있으므로 다음 기회에 재시도
            console.warn("토큰 갱신 실패 - 다음 활성화 시 재시도합니다.");
        }
        return refreshed;
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
                // tokenClient 초기화를 기다림 (최대 5초)
                const waitForTokenClient = () => new Promise((resolve) => {
                    if (tokenClient) { resolve(true); return; }
                    let waited = 0;
                    const interval = setInterval(() => {
                        waited += 100;
                        if (tokenClient) { clearInterval(interval); resolve(true); }
                        else if (waited >= 5000) { clearInterval(interval); resolve(false); }
                    }, 100);
                });

                const clientReady = await waitForTokenClient();
                if (clientReady) {
                    const refreshed = await silentTokenRefreshWithRetry();
                    if (refreshed) {
                        startKeepAlive();
                        await checkAuthAndSync(callback);
                        if (window.onAuthSuccess) window.onAuthSuccess();
                    } else {
                        // silent refresh 실패 → 만료된 토큰만 제거
                        // is_faith_logged_in은 유지하여 다음 탭 활성화 시 재시도 가능
                        // (풀스크린 로그인 모달을 바로 띄우지 않고 로컬 데이터로 앱 사용 가능)
                        localStorage.removeItem('faith_token');
                        localStorage.removeItem('faith_token_exp');
                        state.isLoading = false;
                        renderEntries();
                        if (callback) callback(false);
                    }
                } else {
                    state.isLoading = false;
                    renderEntries();
                    if (callback) callback(false);
                }
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

    // 인터랙티브 인증 실패용 기본 error_callback (silent refresh가 끝나면 이걸로 복원됨)
    mainTokenErrorCallback = (err) => {
        console.error("Google 인증 실패:", err?.type || err?.message || err);
        if (callback) callback(false);
    };

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        scope: GOOGLE_CONFIG.SCOPES,
        callback: mainTokenCallback,
        error_callback: mainTokenErrorCallback,
        // FedCM을 사용하면 서드파티 쿠키가 차단된 환경(Safari, Firefox 등)에서도
        // 팝업 없이 silent token refresh가 가능해져 로그인 화면 빈도를 줄임
        use_fedcm_for_prompt: true,
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
        tokenClient.error_callback = mainTokenErrorCallback;
        const savedEmail = getSavedUserEmail();
        if (savedEmail) {
            // 이전에 로그인한 적 있으면 login_hint로 계정 선택 생략
            tokenClient.requestAccessToken({ prompt: '', login_hint: savedEmail });
        } else {
            tokenClient.requestAccessToken({ prompt: 'select_account' });
        }
    }
}

export async function handleSignoutClick(callback) {
    const hasGapi = () => typeof gapi !== 'undefined' && !!gapi.client;
    // 로그아웃 전 마지막 동기화 시도 (진행 중인 동기화는 최대 10초까지 완료 대기)
    try {
        if (currentSyncPromise) {
            await Promise.race([currentSyncPromise, new Promise(r => setTimeout(r, 10000))]);
        }
        const token = hasGapi() ? gapi.client.getToken() : null;
        if (token) {
            await saveToDrive();
        }
    } catch(e) {
        console.warn("로그아웃 전 동기화 실패:", e);
    }
    const token = hasGapi() ? gapi.client.getToken() : null;
    if (token !== null) {
        if (typeof google !== 'undefined' && google.accounts) {
            google.accounts.oauth2.revoke(token.access_token);
        }
        gapi.client.setToken('');
    }
    localStorage.removeItem('faith_token');
    localStorage.removeItem('faith_token_exp');
    localStorage.removeItem('is_faith_logged_in');
    localStorage.removeItem('faith_user_email');
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
        // 사용자 이메일 저장 → 재로그인 시 login_hint로 활용
        if (userInfo.result.user && userInfo.result.user.emailAddress) {
            saveUserEmail(userInfo.result.user.emailAddress);
        }
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
                        if (retryInfo.result.user && retryInfo.result.user.emailAddress) {
                            saveUserEmail(retryInfo.result.user.emailAddress);
                        }
                    } catch (retryErr) {
                        // 갱신 후에도 실패 → 토큰만 제거 (is_faith_logged_in 유지하여 재시도 가능)
                        localStorage.removeItem('faith_token');
                        localStorage.removeItem('faith_token_exp');
                        if(callback) callback(false);
                        return;
                    }
                } else {
                    // 갱신 실패 → 토큰만 제거 (로그인 상태는 유지)
                    localStorage.removeItem('faith_token');
                    localStorage.removeItem('faith_token_exp');
                    if(callback) callback(false);
                    return;
                }
            } else {
                localStorage.removeItem('faith_token');
                localStorage.removeItem('faith_token_exp');
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
    if (!isValid) {
        console.warn("saveToDrive: 토큰이 유효하지 않아 동기화를 건너뜁니다.");
        showSyncWarning("클라우드 동기화 실패: 로그인이 필요합니다.");
        return;
    }

    const runId = ++syncRunId;
    isSyncing = true;
    toggleSpinners(true);

    let resolveRun;
    const myPromise = new Promise(r => { resolveRun = r; });
    currentSyncPromise = myPromise;

    if (syncTimeoutTimer) clearTimeout(syncTimeoutTimer);
    syncTimeoutTimer = setTimeout(() => {
        // 세대가 일치할 때만 해제 — 이후 시작된 다른 실행의 플래그를 건드리지 않음
        if (runId === syncRunId && isSyncing) { isSyncing = false; toggleSpinners(false); }
    }, 30000);

    const doSync = async () => {
        const folderId = await ensureAppFolder();
        const fileMeta = await findDBFileMeta(folderId);

        let cloudData = null;
        if (fileMeta) {
            if (!lastCloudModifiedTime || fileMeta.modifiedTime !== lastCloudModifiedTime) {
                const response = await gapi.client.drive.files.get({ fileId: fileMeta.id, alt: 'media' });
                try {
                    cloudData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
                } catch (parseErr) {
                    // 클라우드 파일이 손상된 경우 → 병합 생략하고 로컬 데이터로 덮어씀
                    console.error("클라우드 DB 파싱 실패 - 로컬 데이터로 덮어씁니다:", parseErr);
                    cloudData = null;
                }
                lastCloudModifiedTime = fileMeta.modifiedTime;
            }
        }

        if (cloudData) {
            state.entries = mergeEntries(state.entries, cloudData.entries || []);
            const mergedCats = mergeCategories(state, cloudData);
            state.allCategories = mergedCats.categories;
            state.categoryOrder = mergedCats.order;
            state.allFolders = mergedCats.folders;
            state.folderOrder = mergedCats.folderOrder;
            state.rootOrder = mergedCats.rootOrder;
            state.categoryUpdatedAt = mergedCats.updatedAt;
            migrateRootOrder();

            try {
                localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
            } catch(e) {
                console.error("동기화 후 로컬 저장 실패:", e);
                if (e.name === 'QuotaExceededError') {
                    showSyncWarning("저장 공간이 부족합니다. 휴지통을 비워주세요.");
                }
            }
            saveCategoriesToLocal();
            renderFolders();
            renderTabs();
            renderEntries();
            refreshEditorContent();
        }

        const uploadRes = await uploadToDrive(folderId, fileMeta ? fileMeta.id : null);
        if (uploadRes && uploadRes.result) {
            lastCloudModifiedTime = uploadRes.result.modifiedTime;
        }
    };

    try {
        try {
            await doSync();
        } catch (err) {
            // 서버에서 폐기된 토큰(401, authError 403) → 갱신 후 1회만 재시도
            const isAuthErr = err && (err.status === 401 ||
                (err.status === 403 && err.result?.error?.errors?.some(e2 => e2.reason === 'authError')));
            if (isAuthErr && tokenClient) {
                const refreshed = await silentTokenRefreshWithRetry();
                if (!refreshed) throw err;
                await doSync();
            } else {
                throw err;
            }
        }
    } catch (err) {
        console.error("구글 드라이브 저장 실패:", err);
        showSyncWarning("클라우드 동기화에 실패했습니다. 데이터는 기기에 저장되어 있습니다.");
    } finally {
        // 워치독 발동 후 새 실행이 시작된 경우, 늦게 끝난 이전 실행이 새 실행의 상태를 건드리지 않도록 함
        if (runId === syncRunId) {
            if (syncTimeoutTimer) clearTimeout(syncTimeoutTimer);
            syncTimeoutTimer = null;
            isSyncing = false;
            toggleSpinners(false);
            if (pendingSync) {
                pendingSync = false;
                setTimeout(saveToDrive, 500);
            }
        }
        if (currentSyncPromise === myPromise) currentSyncPromise = null;
        resolveRun();
    }
}

export async function syncFromDrive() { await saveToDrive(); }

async function uploadToDrive(folderId, fileId) {
    const finalData = {
        entries: state.entries,
        categories: state.allCategories,
        order: state.categoryOrder,
        categoryUpdatedAt: state.categoryUpdatedAt,
        folders: state.allFolders,
        folderOrder: state.folderOrder,
        rootOrder: state.rootOrder,
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
        return {
            categories: cloudData.categories,
            order: cloudData.order || [],
            folders: cloudData.folders || [],
            folderOrder: cloudData.folderOrder || [],
            rootOrder: cloudData.rootOrder || [],
            updatedAt: cloudData.categoryUpdatedAt
        };
    } else {
        return {
            categories: localState.allCategories,
            order: localState.categoryOrder,
            folders: localState.allFolders,
            folderOrder: localState.folderOrder,
            rootOrder: localState.rootOrder || [],
            updatedAt: localState.categoryUpdatedAt
        };
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