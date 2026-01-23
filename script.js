import { state, loadCategoriesFromLocal, saveCategoriesToLocal } from './state.js';
import { loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash, duplicateEntry } from './data.js';
import { renderEntries, renderTabs, closeAllModals, openModal, openTrashModal, openMoveModal, renameCategoryAction, deleteCategoryAction, addNewCategory } from './ui.js';
import { openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, insertSticker, applyFontStyle, turnPage, jumpToPage, insertImage, triggerAutoSave, insertTable, createHyperlink } from './editor.js';
import { setupAuthListeners } from './auth.js';
import { initGoogleDrive, saveToDrive, syncFromDrive } from './drive.js';

// 전역 윈도우 함수 등록 (HTML 이벤트 바인딩용)
window.addNewCategory = addNewCategory;
window.restoreEntry = restoreEntry;
window.permanentDelete = permanentDelete;
window.duplicateEntry = duplicateEntry;
window.changeGlobalFontSize = changeGlobalFontSize;
window.insertSticker = insertSticker;

// 스티커 리스트 (원본 데이터 유지)
const stickers = [ 
    '✝️','⛪','🛐','📖','🙏','🕊️','🕯️','🩸','🐑','🍞','🍷','🍇','👼','🙌',
    '☁️','☀️','🌙','⭐','✨','🌈','🔥','💧','🌱','🌿','🍂','🌻','🌷','🌹',
    '❤️','🧡','💛','💚','💙','💜','🤍','🤎','🖤','💔','❣️','💕','💞','💓',
    '😊','🥰','😭','🥺','🤔','🫡','👏','👍','🤝','🙇','🙆','🙅','💪','🎉',
    '📝','✏️','🖍️','📌','📎','📅','⏳','💡','🔔','🎁','🎀','💌','🏠',' DOOR'
];

/**
 * 앱 초기화 실행
 */
function init() {
    if (!history.state) history.replaceState({ modal: 'main' }, null, '');
    
    // 로컬 데이터 로드
    loadCategoriesFromLocal(); 
    loadDataFromLocal();
    checkOldTrash();
    renderTabs();
    state.isLoading = false;
    renderEntries();

    // 구글 드라이브 인증 및 자동 세션 복구 로직 (강화된 콜백 방식)
    const handleAuthStatus = (isLoggedIn) => {
        updateAuthUI(isLoggedIn);
        if (isLoggedIn) {
            console.log("동기화 세션 활성화");
            renderTabs();
            renderEntries();
            // 중복 실행 방지 처리된 동기화 루프
            if (!window.syncInterval) {
                window.syncInterval = setInterval(() => {
                    if (!document.hidden && window.gapi?.client?.getToken()) syncFromDrive();
                }, 30000); 
            }
        }
    };

    // 드라이브 초기화 실행
    initGoogleDrive(handleAuthStatus);

    // [복구] 공유 데이터 URL 처리 (fontFamily, fontSize 상세 대응 포함)
    const urlParams = new URLSearchParams(window.location.search);
    const sharedData = urlParams.get('share');
    if (sharedData) {
        try {
            const raw = JSON.parse(decodeURIComponent(atob(sharedData)));
            const entry = {
                title: raw.t || raw.title || '제목 없음',
                subtitle: raw.s || raw.subtitle || '',
                body: raw.b || raw.body || '',
                date: raw.d || raw.date || new Date().toLocaleDateString('ko-KR'),
                fontFamily: raw.f || raw.fontFamily || 'Pretendard',
                fontSize: raw.z || raw.fontSize || 16 
            };
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

    // 브라우저 포커스/온라인 상태 시 동기화
    window.addEventListener('focus', () => { if (window.gapi?.client?.getToken()) syncFromDrive(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && window.gapi?.client?.getToken()) syncFromDrive(); });
    window.addEventListener('online', () => syncFromDrive());

    setupListeners();
    renderStickers();
}

/**
 * 인증 상태에 따른 UI 변경 로직 (원본 보존)
 */
function updateAuthUI(isLoggedIn) {
    const logoutBtn = document.getElementById('logout-btn'), 
          loginTriggerBtn = document.getElementById('login-trigger-btn'), 
          loginModal = document.getElementById('login-modal'), 
          refreshBtn = document.getElementById('refresh-btn'), 
          loginMsgArea = document.getElementById('login-msg-area');

    if (isLoggedIn) {
        if (logoutBtn) logoutBtn.classList.remove('hidden');
        if (loginTriggerBtn) loginTriggerBtn.classList.add('hidden');
        if (loginModal) loginModal.classList.add('hidden');
        if (refreshBtn) refreshBtn.classList.remove('hidden');
        if (loginMsgArea) loginMsgArea.classList.add('hidden'); 
    } else {
        state.currentUser = null;
        if (logoutBtn) logoutBtn.classList.add('hidden');
        if (loginTriggerBtn) loginTriggerBtn.classList.remove('hidden');
        if (refreshBtn) refreshBtn.classList.add('hidden');
        if (loginMsgArea) loginMsgArea.classList.remove('hidden');
    }
}

/**
 * 기본 이벤트 리스너 설정 (원본 로직 완벽 복구)
 */
function setupListeners() {
    // 탭 드래그 앤 드롭 (Sortable) 설정
    const tabContainer = document.getElementById('tab-container');
    if (typeof Sortable !== 'undefined' && tabContainer) {
        new Sortable(tabContainer, {
            animation: 150, delay: 200, delayOnTouchOnly: true, touchStartThreshold: 5,
            onEnd: async () => {
                const newOrder = [];
                tabContainer.querySelectorAll('.tab-btn').forEach(btn => { if(btn.dataset.id) newOrder.push(btn.dataset.id); });
                state.categoryOrder = newOrder; state.categoryUpdatedAt = new Date().toISOString();
                saveCategoriesToLocal(); await saveToDrive();
            }
        });
        tabContainer.addEventListener('wheel', (evt) => { if (evt.deltaY !== 0) { evt.preventDefault(); tabContainer.scrollLeft += evt.deltaY; } });
    }

    // 뒤로가기 버튼 처리
    window.addEventListener('popstate', async () => {
        const writeModal = document.getElementById('write-modal');
        if (writeModal && !writeModal.classList.contains('hidden')) await saveEntry();
        closeAllModals(false); 
        if (window.location.search.includes('share')) {
            window.history.replaceState({}, document.title, window.location.pathname);
            const backBtnText = document.getElementById('back-btn-text');
            if (backBtnText) backBtnText.innerText = '목록';
        }
    });

    // 이미지 드래그 앤 드롭
    const editorBody = document.getElementById('editor-body');
    if (editorBody) {
        editorBody.ondragover = (e) => e.preventDefault();
        editorBody.ondrop = (e) => {
            e.preventDefault(); const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) processImage(files[0]);
        };
    }

    // 전역 클릭 처리 (링크 이동 및 팝업 닫기 통합)
    window.addEventListener('click', (e) => {
        const link = e.target.closest('#editor-body a');
        if (link && link.href && document.getElementById('editor-body').getAttribute('contenteditable') === "false") {
            e.preventDefault(); e.stopPropagation(); window.open(link.href, '_blank')?.focus(); return;
        }
        
        // 팝업 외부 클릭 시 닫기 (스티커, 색상, 표, 책 슬라이더 등)
        ['context-menu', 'category-context-menu', 'color-palette-popup', 'sticker-palette', 'table-modal', 'book-slider-container'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.contains(e.target) && !e.target.closest('.tool-btn') && !e.target.closest('#font-size-input') && !e.target.closest('#page-indicator')) {
                el.classList.add('hidden');
            }
        });
    }, true);

    setupAuthListeners();
    setupUIListeners();
}

/**
 * UI 관련 세부 리스너 (원본 로직 완벽 복구)
 */
function setupUIListeners() {
    const editorContainer = document.getElementById('editor-container');
    const scrollTopBtn = document.getElementById('btn-scroll-top');

    // 스크롤 탑 버튼 가시성 제어
    editorContainer?.addEventListener('scroll', () => {
        if (state.currentViewMode === 'readOnly' && editorContainer.scrollTop > 300) scrollTopBtn?.classList.remove('hidden');
        else scrollTopBtn?.classList.add('hidden');
    });

    scrollTopBtn?.addEventListener('click', () => { editorContainer.scrollTo({ top: 0, behavior: 'smooth' }); });

    // 검색 및 정렬
    document.getElementById('sort-criteria')?.addEventListener('change', (e) => { state.currentSortBy = e.target.value; renderEntries(); });
    document.getElementById('sort-order-btn')?.addEventListener('click', () => { 
        state.currentSortOrder = state.currentSortOrder === 'desc' ? 'asc' : 'desc'; 
        const icon = document.getElementById('sort-icon');
        if (icon) icon.className = state.currentSortOrder === 'desc' ? 'ph ph-sort-descending' : 'ph ph-sort-ascending';
        renderEntries(); 
    });
    
    document.getElementById('search-input')?.addEventListener('input', (e) => renderEntries(e.target.value));
    document.getElementById('refresh-btn')?.addEventListener('click', () => syncFromDrive());

    // 폰트 크기 숫자 입력 필드 대응
    const fontSizeInput = document.getElementById('font-size-input');
    if (fontSizeInput) {
        fontSizeInput.addEventListener('input', (e) => {
            changeGlobalFontSize(e.target.value);
            triggerAutoSave();
        });
    }

    // 툴바 휠 스크롤 제어
    const toolbarScrollArea = document.getElementById('toolbar-scroll-area');
    if (toolbarScrollArea) { 
        toolbarScrollArea.addEventListener('wheel', (e) => { if (e.deltaY !== 0) { e.preventDefault(); toolbarScrollArea.scrollLeft += e.deltaY; } }); 
    }

    // 폰트 셀렉터 대응
    document.getElementById('font-selector')?.addEventListener('change', (e) => { 
        applyFontStyle(e.target.value, state.currentFontSize); 
        triggerAutoSave(); 
    });

    // 툴바 명령 버튼들
    document.querySelectorAll('.tool-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.preventDefault(); const cmd = btn.dataset.cmd; if (cmd) formatDoc(cmd); });
    });

    // 공유하기 기능 (복구)
    document.getElementById('btn-share')?.addEventListener('click', () => {
        const bodyHtml = document.getElementById('editor-body').innerHTML;
        if (bodyHtml.includes('src="data:image')) {
            alert("이미지가 포함된 글은 PDF 저장 버튼을 이용해 주세요.");
            return;
        }

        const title = document.getElementById('edit-title').value;
        const entryData = {
            t: title || '제목 없음',
            s: document.getElementById('edit-subtitle').value || '',
            b: bodyHtml,
            d: new Date().toLocaleDateString('ko-KR'),
            f: state.currentFontFamily,
            z: state.currentFontSize
        };

        try {
            const encodedData = btoa(unescape(encodeURIComponent(JSON.stringify(entryData))));
            const shareUrl = `${window.location.origin}${window.location.pathname}?share=${encodedData}`;
            if (shareUrl.length > 4000) { alert("내용이 너무 길어 링크 생성이 불가능합니다."); return; }
            if (navigator.share) { navigator.share({ title: '신앙일지 공유', text: title, url: shareUrl }); } 
            else { navigator.clipboard.writeText(shareUrl).then(() => alert('공유 링크가 복사되었습니다.')); }
        } catch (e) { alert("공유 실패"); }
    });

    // PDF 다운로드 기능 (복구)
    document.getElementById('btn-download')?.addEventListener('click', () => {
        const element = document.getElementById('editor-container');
        const title = document.getElementById('edit-title').value || '신앙일지';
        const opt = { margin: 10, filename: `${title}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
        html2pdf().set(opt).from(element).save();
    });

    // 링크 및 표 삽입
    document.getElementById('toolbar-link-btn')?.addEventListener('click', () => createHyperlink());
    document.getElementById('toolbar-table-btn')?.addEventListener('click', () => document.getElementById('table-modal').classList.remove('hidden'));
    document.getElementById('btn-confirm-table')?.addEventListener('click', () => {
        const r = parseInt(document.getElementById('table-rows').value) || 3;
        const c = parseInt(document.getElementById('table-cols').value) || 3;
        insertTable(r, c);
        document.getElementById('table-modal').classList.add('hidden');
    });
    document.getElementById('btn-cancel-table')?.addEventListener('click', () => document.getElementById('table-modal').classList.add('hidden'));

    // 스티커 팔레트 열기
    document.getElementById('sticker-btn')?.addEventListener('click', (e) => { 
        e.stopPropagation(); const palette = document.getElementById('sticker-palette');
        if (palette) { palette.style.top = '110px'; palette.classList.toggle('hidden'); }
    });
    
    // 이미지 업로드 핸들러 (복구)
    const imageInput = document.getElementById('image-upload-input');
    document.getElementById('toolbar-image-btn')?.addEventListener('click', () => { document.getElementById('editor-body')?.focus(); imageInput?.click(); });
    imageInput?.addEventListener('change', (e) => { if (e.target.files[0]) processImage(e.target.files[0]); e.target.value = ''; });

    // 툴바 토글 버튼 (복구)
    document.getElementById('toolbar-toggle-btn')?.addEventListener('click', function() {
        const toolbar = document.getElementById('editor-toolbar');
        if (toolbar) {
            toolbar.classList.toggle('collapsed');
            const icon = this.querySelector('i');
            if (icon) icon.className = toolbar.classList.contains('collapsed') ? 'ph ph-caret-down' : 'ph ph-caret-up';
        }
    });

    // 색상 팔레트 제어
    document.getElementById('toolbar-color-btn')?.addEventListener('click', (e) => { e.stopPropagation(); state.activeColorMode = 'foreColor'; openColorPalette(); });
    document.getElementById('toolbar-hilite-btn')?.addEventListener('click', (e) => { e.stopPropagation(); state.activeColorMode = 'hiliteColor'; openColorPalette(); });

    document.querySelectorAll('.color-dot').forEach(btn => { 
        btn.onmousedown = (e) => { 
            e.preventDefault(); if(btn.dataset.color) formatDoc(state.activeColorMode, btn.dataset.color); 
            document.getElementById('color-palette-popup')?.classList.add('hidden'); 
        }; 
    });

    document.getElementById('btn-remove-color')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const resetVal = (state.activeColorMode === 'hiliteColor') ? 'transparent' : '#111827';
        formatDoc(state.activeColorMode, resetVal);
        document.getElementById('color-palette-popup')?.classList.add('hidden');
    });

    // 메인 글쓰기 및 모달 제어 리스너
    document.getElementById('write-btn')?.addEventListener('click', () => openEditor(false));
    document.getElementById('close-write-btn')?.addEventListener('click', () => { 
        saveEntry(); closeAllModals(true); if (navigator.onLine && window.gapi?.client?.getToken()) saveToDrive(); 
    });
    document.getElementById('btn-readonly')?.addEventListener('click', () => toggleViewMode(state.currentViewMode === 'readOnly' ? 'default' : 'readOnly'));
    document.getElementById('btn-bookmode')?.addEventListener('click', () => toggleViewMode(state.currentViewMode === 'book' ? 'default' : 'book'));
    document.getElementById('trash-btn')?.addEventListener('click', openTrashModal);
    document.getElementById('close-trash-btn')?.addEventListener('click', () => closeAllModals(true));
    document.getElementById('btn-empty-trash')?.addEventListener('click', emptyTrash);

    // 책 모드 페이지 제어 (복구)
    document.getElementById('book-nav-left')?.addEventListener('click', () => turnPage(-1));
    document.getElementById('book-nav-right')?.addEventListener('click', () => turnPage(1));
    document.getElementById('page-indicator')?.addEventListener('click', (e) => {
        if (state.currentViewMode !== 'book') return;
        e.stopPropagation(); document.getElementById('book-slider-container')?.classList.toggle('hidden');
    });
    document.getElementById('book-page-slider')?.addEventListener('input', (e) => { jumpToPage(parseInt(e.target.value)); });

    // 컨텍스트 메뉴 리스너 (복구)
    document.getElementById('ctx-move')?.addEventListener('click', openMoveModal);
    document.getElementById('ctx-copy')?.addEventListener('click', () => { duplicateEntry(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    document.getElementById('ctx-delete')?.addEventListener('click', () => { moveToTrash(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    document.getElementById('ctx-cat-rename')?.addEventListener('click', renameCategoryAction);
    document.getElementById('ctx-cat-delete')?.addEventListener('click', deleteCategoryAction);
}

/**
 * 컬러 팔레트 위치 지정 및 열기 (복구)
 */
function openColorPalette() {
    const popup = document.getElementById('color-palette-popup');
    if (popup) { popup.style.top = '110px'; popup.classList.toggle('hidden'); }
}

/**
 * 스티커 그리드 렌더링 (복구)
 */
function renderStickers() { 
    const grid = document.getElementById('sticker-grid');
    if (grid) grid.innerHTML = stickers.map(s => `<span class=\"sticker-item\" onmousedown=\"event.preventDefault(); window.insertSticker('${s}')\">${s}</span>`).join(''); 
}

/**
 * 이미지 리사이징 및 최적화 프로세싱 (원본 보존)
 */
function processImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d'), maxWidth = 800;
            let { width, height } = img;
            if (width > maxWidth) { height *= maxWidth / width; width = maxWidth; }
            canvas.width = width; canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            insertImage(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// DOM 로드 완료 후 실행
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();