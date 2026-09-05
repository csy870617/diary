import { state, loadCategoriesFromLocal, saveCategoriesToLocal, isReadOnlyView, loadCategorySortsFromLocal, setCategorySort } from './state.js';
import { loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash, duplicateEntry } from './data.js';
import { renderEntries, renderTabs, renderFolders, closeAllModals, openModal, openTrashModal, openMoveModal, renameEntryAction, renameCategoryAction, deleteCategoryAction, addNewCategory, renameFolderAction, deleteFolderAction, openFolderAssignModal, createFolderFromAssignModal, addSubfolderAction, closeFolderPopup, toggleSelectMode, exitSelectMode, selectAllEntries, applyCategorySort, bulkDownloadPdf, downloadEntryPdf } from './ui.js';
import { insertTableFunction, clearTableFunction, flushPendingEdit, openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, changeGlobalFontFamily, insertSticker, applyFontStyle, turnPage, jumpToPage, insertImage, insertPlainText, triggerAutoSave, insertTable, createHyperlink, addRow, deleteRow, addColumn, deleteColumn, openTableInsertModal, openTableEditModal, mergeCells, saveCurrentSelection, increaseFontSize, decreaseFontSize, detectSelectionFontSize, getCleanBodyHtml, addRowAbove, addRowBelow, addColumnLeft, addColumnRight, deleteTable, hideTableTools, updateTableTools, setTableWidth, toggleTableEditSection, repositionTableTools } from './editor.js';
import { setupAuthListeners } from './auth.js';
import { initGoogleDrive, handleAuthClick, syncNow, syncSoon, pullFromDrive, flushCloudSyncBeacon, ensureTokenOnResume, startKeepAlive, setSyncStatus } from './drive.js';
import { toggleTTSPanel, toggleTTSSettings, playTTS, pauseTTS, stopTTS, setTTSStart, setTTSEnd, resetTTSRange, playSelection, updateSpeedDisplay, updatePitchDisplay, updateGapDisplay, initTTS, updateTTSRange, seekTTSByPercent, saveTTSVoice } from './tts.js';
import { initFaithsSSO } from './faiths-sso.js';
import { flushEntries } from './storage.js';
import { isSafeUrl } from './utils.js';

const faithsSsoReady = initFaithsSSO();

window.addNewCategory = addNewCategory;
window.restoreEntry = restoreEntry;
window.permanentDelete = permanentDelete;
window.duplicateEntry = duplicateEntry;
window.changeGlobalFontSize = changeGlobalFontSize;
window.insertSticker = insertSticker;

const stickers = [ 
    '✝️','⛪','🛐','📖','🙏','🕊️','🕯️','🩸','🐑','🍞','🍷','🍇','👼','🙌',
    '☁️','☀️','🌙','⭐','✨','🌈','🔥','💧','🌱','🌿','🍂','🌻','🌷','🌹',
    '❤️','🧡','💛','💚','💙','💜','🤍','🤎','🖤','💔','❣️','💕','💞','💓',
    '😊','🥰','😭','🥺','🤔','🫡','👏','👍','🤝','🙇','🙆','🙅','💪','🎉',
    '📝','✏️','🖍️','📌','📎','📅','⏳','💡','🔔','🎁','🎀','💌','🏠','🚪'
];

function getThemePref() {
    const saved = localStorage.getItem('faith_theme');
    return (saved === 'light' || saved === 'dark' || saved === 'system') ? saved : 'system';
}

function applyTheme(pref) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
    if (effective === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    updateThemeIcon(pref);
}

function initTheme() {
    applyTheme(getThemePref());
    // 시스템 설정을 따를 때 OS 테마 변화를 즉시 반영
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (getThemePref() === 'system') applyTheme('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
}

function toggleTheme() {
    const order = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
    localStorage.setItem('faith_theme', next);
    applyTheme(next);
}

function updateThemeIcon(pref) {
    const iconClass = pref === 'light' ? 'ph ph-sun'
                    : pref === 'dark' ? 'ph ph-moon'
                    : 'ph ph-monitor';
    const title = pref === 'light' ? '라이트모드 (클릭: 다크)'
                : pref === 'dark' ? '다크모드 (클릭: 시스템)'
                : '시스템 설정 따름 (클릭: 라이트)';
    // 메인 헤더와 글쓰기 화면의 테마 버튼을 함께 갱신
    ['theme-toggle-btn', 'write-theme-toggle-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const icon = btn.querySelector('i');
        if (icon) icon.className = iconClass;
        btn.title = title;
    });
}

// 공유 링크(?share=)로 들어온 외부 HTML 정화 (XSS 방지)
// utils.js의 sanitizeExternalHtml은 export되지 않아 최소한의 로컬 구현을 사용
function sanitizeSharedHtml(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, form, input, textarea, select, button, meta, link, style, base').forEach(el => el.remove());
    doc.body.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase();
            const value = attr.value.trim().toLowerCase();
            if (name.startsWith('on')) el.removeAttribute(attr.name);
            // 스킴 중간의 탭·개행까지 고려한 공용 판정 사용 (허용 목록 방식)
            else if ((name === 'href' || name === 'src' || name === 'srcset' || name === 'xlink:href'
                || name === 'action' || name === 'formaction' || name === 'data' || name === 'srcdoc')
                && !isSafeUrl(attr.value)) el.removeAttribute(attr.name);
            else if (name === 'style' && (value.includes('expression') || value.includes('javascript'))) el.removeAttribute(attr.name);
        });
    });
    return doc.body.innerHTML;
}

async function init() {
    if (!history.state) history.replaceState({ modal: 'main' }, null, '');

    initTheme();

    const urlParams = new URLSearchParams(window.location.search);
    const sharedData = urlParams.get('share');

    loadCategoriesFromLocal();
    loadCategorySortsFromLocal();
    await loadDataFromLocal(); // IndexedDB에서 불러옴 (예전 localStorage 데이터는 최초 1회 자동 이전)
    // 휴지통 자동 정리: 로그인 사용자는 첫 클라우드 동기화 후 실행(병합 전 stale 데이터로 영구삭제 전파 방지),
    // 비로그인(오프라인) 사용자는 지금 실행
    if (localStorage.getItem('is_faith_logged_in') !== 'true') {
        checkOldTrash().catch(err => console.error('휴지통 정리 실패:', err));
    }
    renderFolders();
    renderTabs();
    applyCategorySort();
    state.isLoading = false;
    renderEntries();

    // [중요] 로그인 성공 시 UI를 강제로 업데이트하는 콜백 전달
    // 두 번째 인자(onReady): 초기 클라우드 동기화 완료 후 휴지통 자동 정리 실행
    initGoogleDrive((isLoggedIn) => {
        updateAuthUI(isLoggedIn);
        if (isLoggedIn) {
            renderTabs();
            renderEntries();
            if (!window.syncInterval) {
                window.syncInterval = setInterval(async () => {
                    if (isReadOnlyView()) return; // 읽기 전용/책 모드에서는 자동 동기화 안 함
                    // 편집 가능한 모드로 작성 중일 때 동기화하면 작성 내용이 덮어써지므로 건너뜀
                    const writeModal = document.getElementById('write-modal');
                    if (writeModal && !writeModal.classList.contains('hidden')) return;
                    // 네트워크 지연 시 이전 주기 동기화가 아직 끝나지 않았으면 겹쳐 실행하지 않음
                    if (window.periodicSyncBusy) return;
                    if (!document.hidden && localStorage.getItem('is_faith_logged_in') === 'true') {
                        window.periodicSyncBusy = true;
                        try {
                            const valid = await ensureTokenOnResume();
                            // 주기 폴링은 다른 기기 변경분만 받아오는 pull 전용 (불필요한 전체 재업로드 방지)
                            if (valid) await pullFromDrive().catch(err => console.error('주기 동기화 실패:', err));
                        } finally {
                            window.periodicSyncBusy = false;
                        }
                    }
                    // 20초는 너무 잦아 모바일 배터리·데이터를 갉아먹었다.
                    // 화면 복귀·탭 전환 때 어차피 동기화하므로 60초로 충분하다.
                }, 60000);
            }
        } else {
            // 로그아웃 시 자동 동기화 인터벌 정리
            if (window.syncInterval) { clearInterval(window.syncInterval); window.syncInterval = null; }
            // 비로그인 상태: 이전에 로그인한 적 있으면 모달 없이 동기화 버튼만 표시
            // (일시적 토큰 갱신 실패일 수 있으므로 풀스크린 모달로 방해하지 않음)
            // 처음 사용자(이메일 없음)만 로그인 모달 표시
            if (!localStorage.getItem('faith_user_email')) {
                const loginModal = document.getElementById('login-modal');
                if (loginModal) loginModal.classList.remove('hidden');
            }
        }
    }, () => { checkOldTrash().catch(err => console.error('휴지통 정리 실패:', err)); });

    if (sharedData) {
        try {
            const raw = JSON.parse(decodeURIComponent(escape(atob(sharedData))));
            const entry = {
                title: raw.t || raw.title || '제목 없음',
                subtitle: raw.s || raw.subtitle || '',
                body: sanitizeSharedHtml(raw.b || raw.body || ''),
                date: raw.d || raw.date || new Date().toLocaleDateString('ko-KR'),
                fontFamily: raw.f || raw.fontFamily || 'Pretendard',
                fontSize: raw.z || raw.fontSize || 16
            };
            state.isShareView = true; // 공유 보기: 닫을 때 저장하지 않음 (남의 글이 내 일지로 들어오는 것 방지)
            setTimeout(() => {
                openEditor(true, entry);
                toggleViewMode('readOnly');
                const backBtnText = document.getElementById('back-btn-text');
                if (backBtnText) backBtnText.innerText = '홈으로';
            }, 500);
        } catch (e) {
            console.error("공유 데이터 해석 실패", e);
        }
    }

    // 탭 복귀 시 토큰 확인 및 동기화 (ensureTokenOnResume 내부에서 디바운스 처리)
    const handleResume = async () => {
        if (isReadOnlyView()) return; // 읽기 전용/책 모드에서는 자동 동기화 안 함
        if (localStorage.getItem('is_faith_logged_in') === 'true') {
            const valid = await ensureTokenOnResume();
            if (valid) syncNow().catch(err => console.error('복귀 동기화 실패:', err));
        }
    };
    // 동기화 상태 점을 누르면 지금 바로 동기화 (특히 빨간 점일 때 다시 시도용)
    // 점은 목록 화면과 글 쓰는 화면 양쪽에 있으므로 위임으로 한 번에 처리한다
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.sync-dot')) return;
        if (localStorage.getItem('is_faith_logged_in') !== 'true') return;
        syncNow().catch(err => console.error('수동 동기화 실패:', err));
    });

    window.addEventListener('focus', handleResume);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') handleResume();
        // 백그라운드로 전환되기 직전, 대기 중인 클라우드 업로드를 즉시 전송 → 다른 기기에서 최신 상태 확인 가능
        // 탭이 가려지기 직전 — 편집 중이던 내용을 먼저 저장한 뒤 올린다
        else flushPendingEdit().then(() => syncNow());
    });
    window.addEventListener('online', handleResume);
    // 탭/창을 닫거나 떠날 때도 미전송 변경분을 즉시 업로드 (모바일에서 신뢰성 높음)
    // keepalive 전송(언로드 후에도 완료 보장)을 우선 시도하고, 조건이 안 되면 기존 방식으로 폴백
    window.addEventListener('pagehide', () => {
        // 편집 중이던 내용을 먼저 state에 반영해야 그 내용이 올라간다 (동기적으로 끝난다)
        flushPendingEdit();
        flushEntries().catch(() => {}); // 아직 기록되지 않은 로컬 저장분을 마무리
        if (!flushCloudSyncBeacon()) syncNow();
    });

    // 사용자 활동 감지 → 토큰 만료 임박 시 자동 갱신 (페이지 활성 상태에서 로그아웃 방지)
    let lastActivityRefresh = 0;
    const activityRefreshInterval = 3 * 60 * 1000; // 최소 3분 간격으로 체크
    const handleUserActivity = async () => {
        if (isReadOnlyView()) return; // 읽기 전용/책 모드에서는 토큰 갱신 안 함
        const now = Date.now();
        if (now - lastActivityRefresh < activityRefreshInterval) return;
        if (localStorage.getItem('is_faith_logged_in') !== 'true') return;
        const storedExp = localStorage.getItem('faith_token_exp');
        if (!storedExp) return;
        // 만료 15분 이내이면 사용자 활동 시점에 미리 갱신
        if (now > (parseInt(storedExp) - 900000)) {
            lastActivityRefresh = now;
            await ensureTokenOnResume();
        }
    };
    ['click', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, handleUserActivity, { passive: true });
    });

    // 브라우저 닫기/새로고침 시 미저장 데이터 경고
    window.addEventListener('beforeunload', (e) => {
        const writeModal = document.getElementById('write-modal');
        if (writeModal && !writeModal.classList.contains('hidden')) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    setupListeners();
    renderStickers();

    // FAITHS SSO 응답(또는 타임아웃)을 먼저 기다려, 응답이 늦게 도착해
    // 로그인 모달이 잠깐 떴다가 닫히는 깜빡임을 방지한다.
    await faithsSsoReady;

    // 로그인 안 된 상태 + 처음 사용자(이메일 없음)만 로그인 모달 표시
    // 이전에 로그인한 적 있는 사용자는 일시적 토큰 만료일 수 있으므로 모달 없이 진행
    if (localStorage.getItem('is_faith_logged_in') !== 'true' && !localStorage.getItem('faith_user_email')) {
        const loginModal = document.getElementById('login-modal');
        if (loginModal) loginModal.classList.remove('hidden');
    }
}

function updateAuthUI(isLoggedIn) {
    const logoutBtn = document.getElementById('logout-btn'),
          loginTriggerBtn = document.getElementById('login-trigger-btn'),
          loginModal = document.getElementById('login-modal');

    if (isLoggedIn) {
        if (logoutBtn) logoutBtn.classList.remove('hidden');
        if (loginTriggerBtn) loginTriggerBtn.classList.add('hidden');
        if (loginModal) loginModal.classList.add('hidden');
    } else {
        if (logoutBtn) logoutBtn.classList.add('hidden');
        if (loginTriggerBtn) loginTriggerBtn.classList.remove('hidden');
        // 로그인 전에는 동기화할 것이 없으므로 상태 점을 감춘다
        setSyncStatus('off');
    }
}

function setupListeners() {
    // 폴더/주제 칩 드래그 정렬: renderFolders()에서도 렌더마다 재부착하지만,
    // 캐시 전환기(구버전 ui.js) 대비로 여기서도 한 번 부착해 둔다 (_sortable로 중복 방지)
    const folderRow = document.getElementById('folder-row');
    if (typeof Sortable !== 'undefined' && folderRow && !folderRow._sortable) {
        folderRow._sortable = new Sortable(folderRow, {
            animation: 150, delay: 200, delayOnTouchOnly: true, touchStartThreshold: 5,
            filter: '.nav-add-btn',
            preventOnFilter: false,
            onEnd: async () => {
                const newOrder = [];
                folderRow.querySelectorAll('[data-item-id]').forEach(el => {
                    if (el.dataset.itemId) newOrder.push(el.dataset.itemId);
                });
                if (newOrder.length === 0) return;
                state.rootOrder = newOrder;
                state.categoryUpdatedAt = new Date().toISOString();
                saveCategoriesToLocal(); syncSoon();
            }
        });
    }

    const navRow = document.querySelector('.nav-row');
    if (navRow) {
        navRow.addEventListener('wheel', (evt) => { if (evt.deltaY !== 0) { evt.preventDefault(); navRow.scrollLeft += evt.deltaY; } });
    }

    window.addEventListener('popstate', async () => {
        stopTTS(); document.getElementById('tts-panel')?.classList.add('hidden'); document.getElementById('write-modal')?.classList.remove('tts-open');
        const writeModal = document.getElementById('write-modal');
        const wasEditing = writeModal && !writeModal.classList.contains('hidden') && !state.isShareView;
        if (wasEditing) await saveEntry(); // 로컬 저장(빠름)
        closeAllModals(false); // 목록으로 즉시 나가기
        // Drive 동기화는 백그라운드로 (UI 지연 방지)
        if (wasEditing && navigator.onLine && window.gapi?.client?.getToken()) {
            syncSoon();
        }
        if (window.location.search.includes('share')) {
            window.history.replaceState({}, document.title, window.location.pathname);
            const backBtnText = document.getElementById('back-btn-text');
            if (backBtnText) backBtnText.innerText = '목록';
        }
        state.isShareView = false;
    });

    const editorBody = document.getElementById('editor-body');
    if (editorBody) {
        editorBody.ondragover = (e) => e.preventDefault();
        editorBody.ondrop = (e) => {
            e.preventDefault(); const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) processImage(files[0]);
        };
    }

    window.addEventListener('click', (e) => {
        const link = e.target.closest('#editor-body a');
        if (link && link.href && document.getElementById('editor-body')?.getAttribute('contenteditable') === "false") {
            e.preventDefault(); e.stopPropagation(); window.open(link.href, '_blank')?.focus(); return;
        }
        const sliderContainer = document.getElementById('book-slider-container');
        if (sliderContainer && !sliderContainer.classList.contains('hidden') && !sliderContainer.contains(e.target) && !e.target.closest('#page-indicator')) sliderContainer.classList.add('hidden');

        // 컨텍스트 메뉴: 메뉴 바깥 클릭 시 닫기
        ['context-menu', 'category-context-menu', 'folder-context-menu'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.contains(e.target)) el.classList.add('hidden');
        });
        // 색상/스티커/표 팝업: 각자의 트리거 버튼 바깥을 클릭하면 닫기 (다른 도구 버튼 클릭 시에도 닫히도록)
        const colorPop = document.getElementById('color-palette-popup');
        if (colorPop && !colorPop.contains(e.target) && !e.target.closest('#toolbar-color-btn') && !e.target.closest('#toolbar-hilite-btn')) colorPop.classList.add('hidden');
        const stickerPop = document.getElementById('sticker-palette');
        if (stickerPop && !stickerPop.contains(e.target) && !e.target.closest('#sticker-btn')) stickerPop.classList.add('hidden');
        const tableModalEl = document.getElementById('table-modal');
        if (tableModalEl && !tableModalEl.contains(e.target) && !e.target.closest('#toolbar-table-btn') && !e.target.closest('#toolbar-table-edit-btn')) tableModalEl.classList.add('hidden');

        const folderPopup = document.getElementById('folder-popup');
        if (folderPopup && !folderPopup.classList.contains('hidden')
            && !folderPopup.contains(e.target)
            && !e.target.closest('.folder-nav')) {
            closeFolderPopup();
        }
        const addMenu = document.getElementById('add-menu-popup');
        if (addMenu && !addMenu.classList.contains('hidden')
            && !addMenu.contains(e.target)
            && !e.target.closest('.nav-add-btn')) {
            addMenu.classList.add('hidden');
        }
        // 글자 크기 드롭다운: 콤보 바깥 터치 시 닫기
        const fsDrop = document.getElementById('font-size-dropdown');
        if (fsDrop && fsDrop.classList.contains('show') && !e.target.closest('#font-size-combo')) {
            fsDrop.classList.remove('show');
        }
        // TTS 설정 확장 패널: 설정 영역/설정 버튼 바깥 터치 시 닫기
        const ttsSettings = document.getElementById('tts-settings');
        if (ttsSettings && !ttsSettings.classList.contains('hidden')
            && !e.target.closest('#tts-settings')
            && !e.target.closest('#tts-settings-btn')) {
            ttsSettings.classList.add('hidden');
        }
    }, true);

    setupAuthListeners();
    setupUIListeners();
}

function setupUIListeners() {
    const editorContainer = document.getElementById('editor-container');
    const scrollTopBtn = document.getElementById('btn-scroll-top');

    editorContainer?.addEventListener('scroll', () => {
        if (state.currentViewMode === 'readOnly' && editorContainer.scrollTop > 300) scrollTopBtn?.classList.remove('hidden');
        else scrollTopBtn?.classList.add('hidden');
    });

    scrollTopBtn?.addEventListener('click', () => { editorContainer.scrollTo({ top: 0, behavior: 'smooth' }); });

    document.getElementById('theme-toggle-btn')?.addEventListener('click', toggleTheme);
    document.getElementById('write-theme-toggle-btn')?.addEventListener('click', toggleTheme);
    document.getElementById('sort-criteria')?.addEventListener('change', (e) => {
        state.currentSortBy = e.target.value;
        setCategorySort(state.currentCategory, state.currentSortBy, state.currentSortOrder);
        renderEntries();
    });
    document.getElementById('sort-order-btn')?.addEventListener('click', () => {
        state.currentSortOrder = state.currentSortOrder === 'desc' ? 'asc' : 'desc';
        const icon = document.getElementById('sort-icon');
        if (icon) { icon.className = state.currentSortOrder === 'desc' ? 'ph ph-sort-descending' : 'ph ph-sort-ascending'; }
        setCategorySort(state.currentCategory, state.currentSortBy, state.currentSortOrder);
        renderEntries();
    });
    
    document.getElementById('search-input')?.addEventListener('input', (e) => renderEntries(e.target.value));

    // --- MS Word 스타일 글자 크기 컨트롤 ---
    const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
    const fontSizeInput = document.getElementById('font-size-input');
    const fontSizeDropdown = document.getElementById('font-size-dropdown');
    const fontSizeCombo = document.getElementById('font-size-combo');

    // 드롭다운 옵션 생성
    if (fontSizeDropdown) {
        FONT_SIZE_PRESETS.forEach(size => {
            const opt = document.createElement('div');
            opt.className = 'font-size-option';
            opt.textContent = size;
            opt.dataset.size = size;
            opt.addEventListener('mousedown', (e) => {
                e.preventDefault();
                fontSizeInput.value = size;
                changeGlobalFontSize(size);
                triggerAutoSave();
                fontSizeDropdown.classList.remove('show');
            });
            fontSizeDropdown.appendChild(opt);
        });
    }

    if (fontSizeInput) {
        // 클릭 시 드롭다운 열기
        fontSizeInput.addEventListener('focus', () => {
            if (fontSizeDropdown) {
                fontSizeDropdown.classList.add('show');
                // 현재 값에 맞는 옵션 활성화
                const val = parseInt(fontSizeInput.value);
                fontSizeDropdown.querySelectorAll('.font-size-option').forEach(opt => {
                    opt.classList.toggle('active', parseInt(opt.dataset.size) === val);
                });
            }
        });
        fontSizeInput.addEventListener('blur', () => {
            setTimeout(() => fontSizeDropdown?.classList.remove('show'), 150);
        });
        // Enter 키로 직접 입력
        fontSizeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const size = parseInt(fontSizeInput.value);
                if (size >= 1 && size <= 200) {
                    changeGlobalFontSize(size);
                    triggerAutoSave();
                }
                fontSizeInput.blur();
                fontSizeDropdown?.classList.remove('show');
            }
        });
    }

    // 글자 크기 증가/감소 버튼
    document.getElementById('font-size-increase')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        increaseFontSize();
        triggerAutoSave();
    });
    document.getElementById('font-size-decrease')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        decreaseFontSize();
        triggerAutoSave();
    });

    // 커서/선택 변경 시 글자 크기 감지하여 입력칸 업데이트
    document.addEventListener('selectionchange', () => {
        const writeModal = document.getElementById('write-modal');
        if (!writeModal || writeModal.classList.contains('hidden')) return;
        const detected = detectSelectionFontSize();
        if (detected && fontSizeInput) {
            fontSizeInput.value = detected;
        }
    });

    const toolbarScrollArea = document.getElementById('toolbar-scroll-area');
    if (toolbarScrollArea) { toolbarScrollArea.addEventListener('wheel', (e) => { if (e.deltaY !== 0) { e.preventDefault(); toolbarScrollArea.scrollLeft += e.deltaY; } }); }

    document.getElementById('font-selector')?.addEventListener('change', (e) => { changeGlobalFontFamily(e.target.value); triggerAutoSave(); });

    document.querySelectorAll('.tool-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.preventDefault(); const cmd = btn.dataset.cmd; if (cmd) formatDoc(cmd); });
    });

    document.getElementById('btn-download')?.addEventListener('click', () => {
        // 선택 모드의 PDF 저장과 동일한 스타일로 출력하기 위해, 에디터의 현재 내용을
        // entry 객체로 만들어 공용 downloadEntryPdf()에 넘긴다.
        const bodyEl = document.getElementById('editor-body');
        const entry = {
            title: document.getElementById('edit-title').value || '신앙일지',
            subtitle: document.getElementById('edit-subtitle').value || '',
            body: bodyEl ? getCleanBodyHtml(bodyEl) : '',
            date: document.getElementById('display-date')?.textContent || '',
            fontFamily: state.currentFontFamily
        };
        downloadEntryPdf(entry);
    });

    // --- TTS 기능 ---
    document.getElementById('btn-tts')?.addEventListener('click', toggleTTSPanel);
    document.getElementById('tts-close-btn')?.addEventListener('click', toggleTTSPanel);
    document.getElementById('tts-settings-btn')?.addEventListener('click', toggleTTSSettings);
    document.getElementById('tts-play-btn')?.addEventListener('click', playTTS);
    document.getElementById('tts-pause-btn')?.addEventListener('click', pauseTTS);
    document.getElementById('tts-stop-btn')?.addEventListener('click', stopTTS);
    document.getElementById('tts-set-start')?.addEventListener('click', setTTSStart);
    document.getElementById('tts-set-end')?.addEventListener('click', setTTSEnd);
    document.getElementById('tts-reset-range')?.addEventListener('click', resetTTSRange);
    document.getElementById('tts-play-selection')?.addEventListener('click', playSelection);
    document.getElementById('tts-speed-slider')?.addEventListener('input', updateSpeedDisplay);
    document.getElementById('tts-pitch-slider')?.addEventListener('input', updatePitchDisplay);
    document.getElementById('tts-gap-slider')?.addEventListener('input', updateGapDisplay);
    document.getElementById('tts-voice-select')?.addEventListener('change', saveTTSVoice);
    document.getElementById('tts-progress-slider')?.addEventListener('input', (e) => seekTTSByPercent(e.target.value));
    initTTS();

    document.getElementById('toolbar-link-btn')?.addEventListener('click', () => { createHyperlink(); });

    const tableModal = document.getElementById('table-modal');
    
    // 툴바에서 표 삽입 버튼 클릭 시 커서 위치 저장 후 삽입 모드로 모달 열기
    document.getElementById('toolbar-table-btn')?.addEventListener('click', () => {
        saveCurrentSelection();
        openTableInsertModal();
    });
    
    // 툴바의 표 편집 버튼: 모달 대신 표 옆 도구 바를 띄운다
    // (모달은 표를 가려서 결과를 볼 수 없었다)
    document.getElementById('toolbar-table-edit-btn')?.addEventListener('click', () => {
        updateTableTools();
    });
    
    // 표 삽입 확인
    document.getElementById('btn-confirm-table')?.addEventListener('click', () => {
        const r = parseInt(document.getElementById('table-rows').value) || 3;
        const c = parseInt(document.getElementById('table-cols').value) || 3;
        insertTable(r, c);
        tableModal?.classList.add('hidden');
    });

    // 표 모달 닫기
    document.getElementById('btn-cancel-table')?.addEventListener('click', () => {
        tableModal?.classList.add('hidden');
    });
    
    // 표 편집 버튼들
    document.getElementById('btn-add-row')?.addEventListener('click', () => { 
        addRow(); 
    });
    document.getElementById('btn-delete-row')?.addEventListener('click', () => { 
        deleteRow(); 
    });
    document.getElementById('btn-add-col')?.addEventListener('click', () => { 
        addColumn(); 
    });
    document.getElementById('btn-delete-col')?.addEventListener('click', () => { 
        deleteColumn(); 
    });
    document.getElementById('btn-merge-cells')?.addEventListener('click', () => {
        mergeCells();
    });

    // ── 표 도구 바 ──────────────────────────────────────────
    // 표 안을 누르면 표 옆에 떠서 그 자리에서 바로 줄·칸을 넣고 뺀다.
    // mousedown 단계에서 막아야 편집 영역의 포커스(=대상 셀)를 잃지 않는다.
    const tableTools = document.getElementById('table-tools');
    tableTools?.addEventListener('mousedown', (e) => e.preventDefault());
    tableTools?.addEventListener('touchstart', (e) => {
        if (e.target.closest('button')) e.preventDefault();
    }, { passive: false });

    const ttBind = (id, fn) => document.getElementById(id)?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); fn();
    });
    ttBind('tt-row-above', addRowAbove);
    ttBind('tt-row-below', addRowBelow);
    ttBind('tt-row-del', deleteRow);
    ttBind('tt-col-left', addColumnLeft);
    ttBind('tt-col-right', addColumnRight);
    ttBind('tt-col-del', deleteColumn);
    ttBind('tt-merge', mergeCells);
    ttBind('tt-table-del', deleteTable);
    ttBind('table-tools-close', hideTableTools);
    ttBind('tt-toggle-edit', () => toggleTableEditSection());
    // 계산 (합계·평균·개수·최대·최소)
    document.querySelectorAll('#table-tools .tt-fn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            insertTableFunction(btn.dataset.fn);
        });
    });
    ttBind('tt-formula-clear', clearTableFunction);
    // 표 폭 프리셋 (25 / 50 / 75 / 100%)
    document.querySelectorAll('#table-tools .tt-w').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            setTableWidth(parseInt(btn.dataset.w, 10));
        });
    });

    // 스크롤·화면 변화 시 표 옆에 계속 붙어 있도록 위치 갱신
    // 스크롤 중에는 위치만 갱신 (격자 재계산은 불필요하고 무겁다)
    document.getElementById('editor-container')?.addEventListener('scroll', () => repositionTableTools(), { passive: true });
    window.addEventListener('resize', () => updateTableTools());

    document.getElementById('sticker-btn')?.addEventListener('click', (e) => { 
        e.stopPropagation(); const palette = document.getElementById('sticker-palette');
        if (palette) { palette.style.top = '110px'; palette.classList.toggle('hidden'); }
    });
    
    const imageInput = document.getElementById('image-upload-input');
    document.getElementById('toolbar-image-btn')?.addEventListener('click', () => { document.getElementById('editor-body')?.focus(); imageInput?.click(); });
    imageInput?.addEventListener('change', (e) => { if (e.target.files[0]) processImage(e.target.files[0]); e.target.value = ''; });

    setupCropModalHandlers();

    const textFileInput = document.getElementById('textfile-upload-input');
    document.getElementById('toolbar-textfile-btn')?.addEventListener('click', () => { document.getElementById('editor-body')?.focus(); textFileInput?.click(); });
    textFileInput?.addEventListener('change', (e) => { if (e.target.files[0]) processTextFile(e.target.files[0]); e.target.value = ''; });

    document.getElementById('toolbar-toggle-btn')?.addEventListener('click', function() {
        const toolbar = document.getElementById('editor-toolbar');
        if (toolbar) {
            toolbar.classList.toggle('collapsed');
            const icon = this.querySelector('i');
            if (icon) icon.className = toolbar.classList.contains('collapsed') ? 'ph ph-caret-down' : 'ph ph-caret-up';
        }
    });

    document.getElementById('toolbar-color-btn')?.addEventListener('click', (e) => { e.stopPropagation(); state.activeColorMode = 'foreColor'; openColorPalette(); });
    document.getElementById('toolbar-hilite-btn')?.addEventListener('click', (e) => { e.stopPropagation(); state.activeColorMode = 'hiliteColor'; openColorPalette(); });

    document.querySelectorAll('.color-dot').forEach(btn => { 
        btn.onmousedown = (e) => { 
            e.preventDefault(); if(btn.dataset.color) formatDoc(state.activeColorMode, btn.dataset.color); document.getElementById('color-palette-popup')?.classList.add('hidden'); 
        }; 
    });

    const removeColorBtn = document.getElementById('btn-remove-color');
    if (removeColorBtn) {
        removeColorBtn.onmousedown = (e) => {
            e.preventDefault();
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const defaultTextColor = isDark ? '#e8ecf1' : '#111827';
            const resetValue = (state.activeColorMode === 'hiliteColor') ? 'transparent' : defaultTextColor;
            formatDoc(state.activeColorMode, resetValue);
            document.getElementById('color-palette-popup')?.classList.add('hidden');
        };
    }

    document.getElementById('write-btn')?.addEventListener('click', () => openEditor(false));
    document.getElementById('close-write-btn')?.addEventListener('click', async () => {
        stopTTS(); document.getElementById('tts-panel')?.classList.add('hidden'); document.getElementById('write-modal')?.classList.remove('tts-open');
        if (!state.isShareView) await saveEntry(); // 로컬 저장(빠름)
        closeAllModals(true); // 목록으로 즉시 나가기
        // Drive 동기화는 백그라운드로 (UI 지연 방지)
        if (!state.isShareView && navigator.onLine && window.gapi?.client?.getToken()) {
            syncSoon();
        }
        if (window.location.search.includes('share')) {
            window.history.replaceState({}, document.title, window.location.pathname);
            const backBtnText = document.getElementById('back-btn-text');
            if (backBtnText) backBtnText.innerText = '목록';
        }
        state.isShareView = false;
    });
    document.getElementById('btn-readonly')?.addEventListener('click', () => {
        if (state.currentViewMode === 'book-edit') toggleViewMode('default');
        else toggleViewMode(state.currentViewMode === 'readOnly' ? 'default' : 'readOnly');
    });
    document.getElementById('btn-bookmode')?.addEventListener('click', () => {
        if (state.currentViewMode === 'book') toggleViewMode('book-edit');
        else if (state.currentViewMode === 'book-edit') toggleViewMode('book');
        else toggleViewMode('book');
    });
    document.getElementById('trash-btn')?.addEventListener('click', openTrashModal);
    document.getElementById('close-trash-btn')?.addEventListener('click', () => closeAllModals(true));
    document.getElementById('btn-empty-trash')?.addEventListener('click', emptyTrash);
    document.getElementById('book-nav-left')?.addEventListener('click', () => turnPage(-1));
    document.getElementById('book-nav-right')?.addEventListener('click', () => turnPage(1));
    document.getElementById('page-indicator')?.addEventListener('click', (e) => {
        if (state.currentViewMode !== 'book') return;
        e.stopPropagation(); const sliderContainer = document.getElementById('book-slider-container');
        if (sliderContainer) sliderContainer.classList.toggle('hidden');
    });
    document.getElementById('book-page-slider')?.addEventListener('input', (e) => { jumpToPage(parseInt(e.target.value)); });
    document.getElementById('select-mode-btn')?.addEventListener('click', toggleSelectMode);
    document.getElementById('bulk-select-all-btn')?.addEventListener('click', selectAllEntries);
    document.getElementById('bulk-move-btn')?.addEventListener('click', openMoveModal);
    document.getElementById('bulk-pdf-btn')?.addEventListener('click', bulkDownloadPdf);
    document.getElementById('bulk-cancel-btn')?.addEventListener('click', exitSelectMode);
    document.getElementById('close-move-btn')?.addEventListener('click', () => closeAllModals(true));
    document.getElementById('ctx-rename')?.addEventListener('click', renameEntryAction);
    document.getElementById('ctx-move')?.addEventListener('click', openMoveModal);
    document.getElementById('ctx-copy')?.addEventListener('click', () => { duplicateEntry(state.contextTargetId); document.getElementById('context-menu')?.classList.add('hidden'); });
    document.getElementById('ctx-delete')?.addEventListener('click', () => { moveToTrash(state.contextTargetId); document.getElementById('context-menu')?.classList.add('hidden'); });
    document.getElementById('ctx-cat-rename')?.addEventListener('click', renameCategoryAction);
    document.getElementById('ctx-cat-assign-folder')?.addEventListener('click', openFolderAssignModal);
    document.getElementById('ctx-cat-delete')?.addEventListener('click', deleteCategoryAction);
    document.getElementById('ctx-folder-rename')?.addEventListener('click', renameFolderAction);
    document.getElementById('ctx-folder-delete')?.addEventListener('click', deleteFolderAction);
    document.getElementById('ctx-folder-add-sub')?.addEventListener('click', addSubfolderAction);
    document.getElementById('close-folder-assign-btn')?.addEventListener('click', () => document.getElementById('folder-assign-modal')?.classList.add('hidden'));
    document.getElementById('new-folder-inline-btn')?.addEventListener('click', createFolderFromAssignModal);
}

function openColorPalette() {
    const popup = document.getElementById('color-palette-popup');
    if (popup) { popup.style.top = '110px'; popup.classList.toggle('hidden'); }
}

function renderStickers() { 
    const grid = document.getElementById('sticker-grid');
    if (grid) grid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); window.insertSticker('${s}')">${s}</span>`).join(''); 
}

function processTextFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const text = typeof e.target.result === 'string' ? e.target.result.replace(/^﻿/, '') : '';
        if (!text) return;
        insertPlainText(text);
    };
    reader.onerror = () => alert('파일을 읽는 중 오류가 발생했습니다.');
    reader.readAsText(file, 'UTF-8');
}

// 잘라낸 이미지도 반드시 용량을 제한해서 넣는다.
// (예전에는 화질 보존을 위해 원본 해상도 + 무손실 PNG로 넣었는데, 사진 한 장이
//  수 MB가 되어 브라우저 저장 공간(보통 5MB)을 혼자 다 써버리는 원인이었다.
//  자르기는 화질 의도가 있으므로 일반 삽입보다 여유 있는 상한을 준다.)
// 이미지를 지정한 상한 안으로 줄여서 data URL로 돌려준다.
// 투명한 부분이 있는 이미지를 JPEG로 바꾸면 그 영역이 검게 변하므로, 투명 픽셀이 있으면
// PNG로 유지한다(대신 해상도 상한만 적용). 스티커·로고 등이 검게 변하지 않도록.
export function compressImageDataUrl(dataUrl, maxWidth = 800, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            let { width, height } = img;
            if (width > maxWidth) { height *= maxWidth / width; width = maxWidth; }
            width = Math.max(1, Math.round(width));
            height = Math.max(1, Math.round(height));
            canvas.width = width; canvas.height = height;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, width, height);
            let hasAlpha = false;
            try {
                const d = ctx.getImageData(0, 0, width, height).data;
                for (let i = 3; i < d.length; i += 4) { if (d[i] < 250) { hasAlpha = true; break; } }
            } catch (e) { /* 교차 출처 등으로 읽을 수 없으면 JPEG 기준으로 처리 */ }
            resolve(hasAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('이미지 로드 실패'));
        img.src = dataUrl;
    });
}
window.compressImageDataUrl = compressImageDataUrl;

function compressAndInsertImage(dataUrl, maxWidth = 800, quality = 0.7) {
    compressImageDataUrl(dataUrl, maxWidth, quality)
        .then(insertImage)
        .catch(err => { console.error(err); alert('이미지를 불러올 수 없습니다. 손상된 파일일 수 있습니다.'); });
}

function processImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        openCropModal(e.target.result, (resultDataUrl, wasCropped) => {
            if (wasCropped) compressAndInsertImage(resultDataUrl, 1280, 0.82);
            else compressAndInsertImage(resultDataUrl);
        });
    };
    reader.onerror = () => { console.error('이미지 파일 읽기 실패'); alert('이미지 파일을 읽는 중 오류가 발생했습니다.'); };
    reader.readAsDataURL(file);
}

function processImageDataUrl(dataUrl) {
    openCropModal(dataUrl, (resultDataUrl, wasCropped) => {
        if (wasCropped) compressAndInsertImage(resultDataUrl, 1280, 0.82);
        else compressAndInsertImage(resultDataUrl);
    });
}
window.processImageDataUrl = processImageDataUrl;

// ========== 이미지 자르기 모달 ==========
let cropState = null;

function openCropModal(dataUrl, onConfirm) {
    const modal = document.getElementById('crop-modal');
    const imgEl = document.getElementById('crop-image');
    const stage = document.getElementById('crop-stage');
    const box = document.getElementById('crop-box');
    if (!modal || !imgEl || !stage || !box) { onConfirm(dataUrl); return; }

    cropState = { dataUrl, onConfirm, naturalWidth: 0, naturalHeight: 0, displayWidth: 0, displayHeight: 0 };

    imgEl.onload = () => {
        cropState.naturalWidth = imgEl.naturalWidth;
        cropState.naturalHeight = imgEl.naturalHeight;
        // Wait a frame so layout settles
        requestAnimationFrame(() => {
            const imgRect = imgEl.getBoundingClientRect();
            const stageRect = stage.getBoundingClientRect();
            cropState.displayWidth = imgRect.width;
            cropState.displayHeight = imgRect.height;
            // Initial crop box = 80% of image, centered on image
            const w = imgRect.width * 0.8;
            const h = imgRect.height * 0.8;
            const offsetX = imgRect.left - stageRect.left;
            const offsetY = imgRect.top - stageRect.top;
            box.style.left = (offsetX + (imgRect.width - w) / 2) + 'px';
            box.style.top = (offsetY + (imgRect.height - h) / 2) + 'px';
            box.style.width = w + 'px';
            box.style.height = h + 'px';
        });
    };
    imgEl.src = dataUrl;
    modal.classList.remove('hidden');
}

// 에디터(editor.js)에서 기존 이미지를 다시 자를 수 있도록 노출
window.openImageCropper = openCropModal;

function closeCropModal() {
    const modal = document.getElementById('crop-modal');
    if (modal) modal.classList.add('hidden');
    cropState = null;
}

function performCrop() {
    if (!cropState) return null;
    const imgEl = document.getElementById('crop-image');
    const box = document.getElementById('crop-box');
    if (!imgEl || !box) return null;

    const imgRect = imgEl.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const scaleX = cropState.naturalWidth / imgRect.width;
    const scaleY = cropState.naturalHeight / imgRect.height;
    const sx = Math.max(0, (boxRect.left - imgRect.left) * scaleX);
    const sy = Math.max(0, (boxRect.top - imgRect.top) * scaleY);
    const sw = Math.min(cropState.naturalWidth - sx, boxRect.width * scaleX);
    const sh = Math.min(cropState.naturalHeight - sy, boxRect.height * scaleY);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    // 자르기 단계에서는 무손실(PNG)로 넘기고, 삽입 직전 compressAndInsertImage에서
    // 용량 상한(가로 1280px / JPEG 0.82)을 적용한다. (저장 공간 초과 방지)
    return canvas.toDataURL('image/png');
}

function setupCropModalHandlers() {
    const stage = document.getElementById('crop-stage');
    const box = document.getElementById('crop-box');
    const confirmBtn = document.getElementById('btn-confirm-crop');
    const skipBtn = document.getElementById('btn-skip-crop');
    const cancelBtn = document.getElementById('btn-cancel-crop');
    if (!stage || !box) return;

    let drag = null;

    const getPoint = (e) => {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    };

    const startDrag = (e, mode, dir) => {
        e.preventDefault();
        const p = getPoint(e);
        const stageRect = stage.getBoundingClientRect();
        drag = {
            mode, dir,
            startX: p.x, startY: p.y,
            startLeft: parseFloat(box.style.left) || 0,
            startTop: parseFloat(box.style.top) || 0,
            startWidth: parseFloat(box.style.width) || 0,
            startHeight: parseFloat(box.style.height) || 0,
            stageWidth: stageRect.width,
            stageHeight: stageRect.height,
        };
    };

    const onMove = (e) => {
        if (!drag) return;
        e.preventDefault();
        const p = getPoint(e);
        const dx = p.x - drag.startX;
        const dy = p.y - drag.startY;
        const imgEl = document.getElementById('crop-image');
        const imgRect = imgEl.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const minX = imgRect.left - stageRect.left;
        const minY = imgRect.top - stageRect.top;
        const maxRight = minX + imgRect.width;
        const maxBottom = minY + imgRect.height;
        const minSize = 30;

        if (drag.mode === 'move') {
            let nl = drag.startLeft + dx;
            let nt = drag.startTop + dy;
            nl = Math.max(minX, Math.min(maxRight - drag.startWidth, nl));
            nt = Math.max(minY, Math.min(maxBottom - drag.startHeight, nt));
            box.style.left = nl + 'px';
            box.style.top = nt + 'px';
        } else if (drag.mode === 'resize') {
            let l = drag.startLeft, t = drag.startTop, w = drag.startWidth, h = drag.startHeight;
            if (drag.dir.includes('e')) w = Math.max(minSize, Math.min(maxRight - l, drag.startWidth + dx));
            if (drag.dir.includes('s')) h = Math.max(minSize, Math.min(maxBottom - t, drag.startHeight + dy));
            if (drag.dir.includes('w')) {
                const newL = Math.min(drag.startLeft + dx, drag.startLeft + drag.startWidth - minSize);
                const clampedL = Math.max(minX, newL);
                w = drag.startWidth + (drag.startLeft - clampedL);
                l = clampedL;
            }
            if (drag.dir.includes('n')) {
                const newT = Math.min(drag.startTop + dy, drag.startTop + drag.startHeight - minSize);
                const clampedT = Math.max(minY, newT);
                h = drag.startHeight + (drag.startTop - clampedT);
                t = clampedT;
            }
            box.style.left = l + 'px';
            box.style.top = t + 'px';
            box.style.width = w + 'px';
            box.style.height = h + 'px';
        }
    };

    const endDrag = () => { drag = null; };

    box.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('crop-handle')) {
            startDrag(e, 'resize', e.target.dataset.dir);
        } else {
            startDrag(e, 'move');
        }
    });
    box.addEventListener('touchstart', (e) => {
        if (e.target.classList.contains('crop-handle')) {
            startDrag(e, 'resize', e.target.dataset.dir);
        } else {
            startDrag(e, 'move');
        }
    }, { passive: false });

    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    confirmBtn?.addEventListener('click', () => {
        const cb = cropState?.onConfirm;
        const result = performCrop();
        closeCropModal();
        if (cb && result) cb(result, true);
    });
    skipBtn?.addEventListener('click', () => {
        const cb = cropState?.onConfirm;
        const original = cropState?.dataUrl;
        closeCropModal();
        if (cb && original) cb(original, false);
    });
    cancelBtn?.addEventListener('click', () => {
        closeCropModal();
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
