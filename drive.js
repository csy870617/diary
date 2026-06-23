import { GOOGLE_CONFIG, APP_FOLDER_NAME, DB_FILE_NAME } from './config.js';
import { state, saveCategoriesToLocal, isReadOnlyView, migrateRootOrder } from './state.js';
import { renderEntries, renderTabs, renderFolders } from './ui.js';
import { refreshEditorContent, reloadEntryIntoEditor } from './editor.js';

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

export function initGoogleDrive(callback, onReady) {
    if (typeof gapi === 'undefined' || typeof google === 'undefined' || !google.accounts) {
        setTimeout(() => initGoogleDrive(callback, onReady), 100);
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
                    await checkAuthAndSync(callback, onReady);
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
                        await checkAuthAndSync(callback, onReady);
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
        await checkAuthAndSync(callback, onReady);
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
        // 대기 중인 디바운스 업로드가 있으면 먼저 즉시 전송
        if (cloudSyncTimer) { clearTimeout(cloudSyncTimer); cloudSyncTimer = null; }
        if (currentSyncPromise) {
            await Promise.race([currentSyncPromise, new Promise(r => setTimeout(r, 10000))]);
        }
        const token = hasGapi() ? gapi.client.getToken() : null;
        if (token) {
            await saveToDrive();
            // 진행 중이던 동기화 때문에 위 호출이 건너뛰어졌으면(pendingSync) 완료까지 한 번 더 대기
            if (currentSyncPromise) {
                await Promise.race([currentSyncPromise, new Promise(r => setTimeout(r, 10000))]);
            }
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

async function checkAuthAndSync(callback, onReady) {
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
    // 초기 클라우드 병합 이후에만 실행 (예: 오래된 휴지통 정리 — stale 로컬로 영구삭제 전파 방지)
    if (onReady) { try { onReady(); } catch (e) { console.error("초기 동기화 후 처리 실패:", e); } }
}

function toggleSpinners(active) {
    const btns = [document.getElementById('refresh-btn'), document.getElementById('write-sync-btn')];
    btns.forEach(btn => {
        if (!btn) return;
        if (active) btn.classList.add('rotating');
        else btn.classList.remove('rotating');
    });
}

export async function saveToDrive(pullOnly = false, promptOnConflict = false) {
    if (localStorage.getItem('is_faith_logged_in') !== 'true') return;
    if (isSyncing) { if (!pullOnly) pendingSync = true; return; }

    const isValid = await ensureValidToken(true);
    if (!isValid) {
        console.warn("saveToDrive: 토큰이 유효하지 않아 동기화를 건너뜁니다.");
        showSyncWarning("클라우드 동기화 실패: 로그인이 필요합니다.");
        return;
    }

    const runId = ++syncRunId;
    isSyncing = true;
    toggleSpinners(true);

    // 전체 동기화가 시작되면 대기 중인 디바운스 업로드는 이 실행에 포함되므로 취소 (중복 업로드 방지)
    if (!pullOnly && cloudSyncTimer) { clearTimeout(cloudSyncTimer); cloudSyncTimer = null; }

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

        // 편집 중인 글이 편집 가능한 모드로 열려 있는지 (이 글은 동기화로 덮어쓰지 않도록 보호)
        const writeModalEl = document.getElementById('write-modal');
        const editorOpen = writeModalEl && !writeModalEl.classList.contains('hidden');
        const editableMode = state.currentViewMode === 'default' || state.currentViewMode === 'book-edit';
        const editingActive = editorOpen && editableMode && state.editingId != null;

        // --- 충돌 감지: 편집 중인 글이 다른 기기에서 먼저 수정되었으면 처리 ---
        let skipUpload = pullOnly;
        if (!pullOnly && cloudData && editingActive) {
            const editId = state.editingId;
            const cloudItem = (cloudData.entries || []).find(e => e && e.id === editId);
            const localItem = state.entries.find(e => e && e.id === editId);
            if (cloudItem && localItem) {
                const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
                const baseTime = state.editBaseModifiedAt || 0;
                const differs = cloudItem.body !== localItem.body
                    || cloudItem.title !== localItem.title
                    || cloudItem.subtitle !== localItem.subtitle
                    || !!cloudItem.isDeleted !== !!localItem.isDeleted
                    || !!cloudItem.isPurged !== !!localItem.isPurged
                    || cloudItem.category !== localItem.category;
                // 내가 편집을 시작한 버전보다 클라우드가 더 최신이고 내용도 다르면 충돌
                if (cloudTime > baseTime && differs) {
                    if (promptOnConflict) {
                        // confirm()이 동기적으로 블로킹되는 동안 워치독이 오발동하지 않도록 잠시 해제
                        if (syncTimeoutTimer) { clearTimeout(syncTimeoutTimer); syncTimeoutTimer = null; }
                        const overwrite = confirm('이 글이 다른 기기에서 먼저 수정되었습니다.\n\n[확인] 내 변경 내용으로 덮어쓰기\n[취소] 다른 기기의 내용 불러오기 (내 변경은 취소됩니다)');
                        // 워치독 재무장
                        syncTimeoutTimer = setTimeout(() => {
                            if (runId === syncRunId && isSyncing) { isSyncing = false; toggleSpinners(false); }
                        }, 30000);
                        if (runId !== syncRunId) {
                            // confirm 동안 다른 실행이 점유 → 이번 업로드는 포기 (중복 업로드 방지)
                            skipUpload = true;
                        } else if (overwrite) {
                            // 내 버전이 병합에서 이기도록 수정 시각을 최신으로, 기준 시각도 함께 맞춤
                            // (업로드가 실패해도 로컬과 기준이 어긋나 충돌을 놓치는 일이 없도록)
                            localItem.modifiedAt = new Date().toISOString();
                            state.editBaseModifiedAt = new Date(localItem.modifiedAt).getTime();
                        } else {
                            // 다른 기기 내용 채택 → 로컬을 클라우드 버전으로 교체하고 이번엔 업로드 생략
                            const idx = state.entries.findIndex(e => e && e.id === editId);
                            if (idx !== -1) state.entries[idx] = cloudItem;
                            state.editBaseModifiedAt = cloudTime;
                            reloadEntryIntoEditor(cloudItem);
                            skipUpload = true;
                        }
                    } else {
                        // 자동저장/백그라운드 등: 묻지 않고 업로드 보류 (양쪽 보존, 다음 명시적 저장에서 확인)
                        skipUpload = true;
                    }
                }
            }
        }

        if (cloudData) {
            // 편집 중인 글은 병합으로 덮어쓰지 않도록 보호 (충돌은 확인창으로만 해소)
            const protectedId = editingActive ? state.editingId : null;
            state.entries = mergeEntries(state.entries, cloudData.entries || [], protectedId);
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

        // pullOnly(주기 폴링) 또는 충돌 시 '다른 기기 내용 불러오기'를 택한 경우 업로드 생략
        if (!skipUpload) {
            const uploadRes = await uploadToDrive(folderId, fileMeta ? fileMeta.id : null);
            if (uploadRes && uploadRes.result) {
                lastCloudModifiedTime = uploadRes.result.modifiedTime;
            }
            // 편집 중인 글의 충돌 기준 시각을 방금 올린 버전으로 갱신 (다음 저장에서 오탐 방지)
            if (state.editingId != null) {
                const cur = state.entries.find(e => e && e.id === state.editingId);
                if (cur) state.editBaseModifiedAt = new Date(cur.modifiedAt || cur.timestamp || 0).getTime();
            }
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

export async function syncFromDrive(pullOnly = false, promptOnConflict = false) { await saveToDrive(pullOnly, promptOnConflict); }

// 클라우드 업로드를 묶어서(디바운스) 보내기 위한 스케줄러.
// 로컬 저장은 즉시 하되, Drive 업로드는 입력이 멈춘 뒤 한 번만 전송해 전체 파일 반복 업로드를 줄인다.
let cloudSyncTimer = null;
const CLOUD_SYNC_DELAY = 5000;

export function scheduleCloudSync(delay = CLOUD_SYNC_DELAY) {
    if (localStorage.getItem('is_faith_logged_in') !== 'true') return;
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => {
        cloudSyncTimer = null;
        // 자동저장 업로드는 충돌 시 묻지 않고 보류 (다음 명시적 저장에서 확인)
        saveToDrive(false, false).catch(err => console.error('자동 동기화 실패:', err));
    }, delay);
}

// 대기 중인 클라우드 업로드를 즉시 전송 (탭이 백그라운드로 가거나 닫히기 직전 호출 → 다른 기기 동기화 보장)
// promptOnConflict: 명시적 동작(편집 종료 등)에서만 충돌 확인창을 띄움. 언로드/백그라운드 flush는 false.
export function flushCloudSync(promptOnConflict = false) {
    if (!cloudSyncTimer) return null;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
    if (localStorage.getItem('is_faith_logged_in') !== 'true') return null;
    return saveToDrive(false, promptOnConflict).catch(err => console.error('동기화 실패:', err));
}

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

function mergeEntries(localList, cloudList, protectedId = null) {
    const entryMap = new Map();
    cloudList.forEach(item => { if(item && item.id) entryMap.set(item.id, item); });
    localList.forEach(localItem => {
        if(!localItem || !localItem.id) return;
        const cloudItem = entryMap.get(localItem.id);
        if (!cloudItem) { entryMap.set(localItem.id, localItem); }
        else if (localItem.id === protectedId) { entryMap.set(localItem.id, localItem); } // 편집 중인 글은 항상 로컬 유지
        else {
            const localTime = new Date(localItem.modifiedAt || localItem.timestamp || 0).getTime();
            const cloudTime = new Date(cloudItem.modifiedAt || cloudItem.timestamp || 0).getTime();
            if (localTime >= cloudTime) entryMap.set(localItem.id, localItem);
        }
    });
    // timestamp 누락 항목에서 NaN 정렬이 깨지지 않도록 modifiedAt·0으로 폴백
    return Array.from(entryMap.values()).sort((a, b) =>
        (new Date(b.timestamp || b.modifiedAt || 0).getTime() || 0) - (new Date(a.timestamp || a.modifiedAt || 0).getTime() || 0));
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