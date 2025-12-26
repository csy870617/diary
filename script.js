import { state, loadCategoriesFromLocal, saveCategoriesToLocal } from './state.js';
import { loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash, duplicateEntry } from './data.js';
import { renderEntries, renderTabs, closeAllModals, openModal, openTrashModal, openMoveModal, renameCategoryAction, deleteCategoryAction, addNewCategory } from './ui.js';
import { openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, insertSticker, applyFontStyle, turnPage, insertImage } from './editor.js';
import { setupAuthListeners } from './auth.js';
import { initGoogleDrive, saveToDrive, syncFromDrive } from './drive.js';

// 전역 윈도우 함수 등록
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

function init() {
    // [중요] 초기 히스토리 상태 설정 (뒤로가기 방지용)
    if (!history.state) {
        history.replaceState({ modal: 'main' }, null, '');
    }

    loadCategoriesFromLocal(); 
    loadDataFromLocal();
    checkOldTrash();
    renderTabs();
    state.isLoading = false;
    renderEntries();

    initGoogleDrive((isLoggedIn) => {
        updateAuthUI(isLoggedIn);
        if (isLoggedIn) {
            renderTabs();
            renderEntries(); 
            // 주기적 동기화 간격을 30초로 단축하여 실시간성 강화
            setInterval(() => {
                if (!document.hidden && window.gapi?.client?.getToken()) syncFromDrive();
            }, 30000);
        }
    });

    // 화면 포커스를 얻거나, 다른 앱에서 돌아올 때(모바일) 즉시 동기화
    window.addEventListener('focus', () => {
        if (window.gapi?.client?.getToken()) syncFromDrive();
    });

    // [추가] 브라우저 가시성 상태 감지 (모바일 앱 전환 시 매우 중요)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && window.gapi?.client?.getToken()) {
            syncFromDrive();
        }
    });

    window.addEventListener('online', () => syncFromDrive());

    setupListeners();
    renderStickers();
}

function updateAuthUI(isLoggedIn) {
    const logoutBtn = document.getElementById('logout-btn');
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    const loginModal = document.getElementById('login-modal');
    const refreshBtn = document.getElementById('refresh-btn');
    const loginMsgArea = document.getElementById('login-msg-area');

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

function setupListeners() {
    const tabContainer = document.getElementById('tab-container');
    if (typeof Sortable !== 'undefined' && tabContainer) {
        new Sortable(tabContainer, {
            animation: 150,
            delay: 200, 
            delayOnTouchOnly: true,
            touchStartThreshold: 5,
            onEnd: async () => {
                const newOrder = [];
                tabContainer.querySelectorAll('.tab-btn').forEach(btn => { if(btn.dataset.id) newOrder.push(btn.dataset.id); });
                state.categoryOrder = newOrder;
                state.categoryUpdatedAt = new Date().toISOString();
                saveCategoriesToLocal(); 
                await saveToDrive();
            }
        });
        tabContainer.addEventListener('wheel', (evt) => { if (evt.deltaY !== 0) { evt.preventDefault(); tabContainer.scrollLeft += evt.deltaY; } });
    }

    // [중요] 브라우저 뒤로가기 발생 시 모달 닫기
    window.addEventListener('popstate', async (event) => {
        const writeModal = document.getElementById('write-modal');
        if (writeModal && !writeModal.classList.contains('hidden')) {
            await saveEntry(); // 작성 내용 자동 저장
        }
        closeAllModals(false); 
    });

    const editorBody = document.getElementById('editor-body');
    if (editorBody) {
        editorBody.ondragover = (e) => e.preventDefault();
        editorBody.ondrop = (e) => {
            e.preventDefault();
            const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) processImage(files[0]);
        };
    }

    window.addEventListener('click', (e) => {
        const link = e.target.closest('#editor-body a');
        if (link && link.href && document.getElementById('editor-body').getAttribute('contenteditable') === "false") {
            e.preventDefault(); e.stopPropagation(); window.open(link.href, '_blank')?.focus(); return;
        }
        ['context-menu', 'category-context-menu', 'color-palette-popup', 'sticker-palette'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.contains(e.target) && !e.target.closest('.tool-btn')) el.classList.add('hidden');
        });
    }, true);

    setupAuthListeners();
    setupUIListeners();
}

function setupUIListeners() {
    document.getElementById('editor-sync-btn')?.addEventListener('click', async function() {
        this.classList.add('rotating');
        await saveEntry(); 
        if(window.gapi?.client?.getToken()) await saveToDrive();
        this.classList.remove('rotating');
    });

    document.getElementById('sort-criteria')?.addEventListener('change', (e) => { state.currentSortBy = e.target.value; renderEntries(); });
    document.getElementById('sort-order-btn')?.addEventListener('click', () => { 
        state.currentSortOrder = state.currentSortOrder === 'desc' ? 'asc' : 'desc'; 
        const icon = document.getElementById('sort-icon');
        if (icon) { icon.classList.toggle('ph-sort-descending'); icon.classList.toggle('ph-sort-ascending'); }
        renderEntries(); 
    });
    
    document.getElementById('search-input')?.addEventListener('input', (e) => renderEntries(e.target.value));
    document.getElementById('refresh-btn')?.addEventListener('click', () => syncFromDrive());

    document.getElementById('btn-global-size-up')?.addEventListener('click', () => changeGlobalFontSize(2));
    document.getElementById('btn-global-size-down')?.addEventListener('click', () => changeGlobalFontSize(-2));

    document.getElementById('sticker-btn')?.addEventListener('click', (e) => { 
        e.stopPropagation();
        const palette = document.getElementById('sticker-palette');
        if (palette) { palette.style.top = '110px'; palette.classList.toggle('hidden'); }
    });
    
    const imageInput = document.getElementById('image-upload-input');
    document.getElementById('toolbar-image-btn')?.addEventListener('click', () => {
        document.getElementById('editor-body')?.focus();
        imageInput?.click();
    });
    imageInput?.addEventListener('change', (e) => { if (e.target.files[0]) processImage(e.target.files[0]); e.target.value = ''; });

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
            e.preventDefault(); 
            if(btn.dataset.color) formatDoc(state.activeColorMode, btn.dataset.color);
            document.getElementById('color-palette-popup')?.classList.add('hidden'); 
        }; 
    });

    document.getElementById('write-btn')?.addEventListener('click', () => openEditor(false));
    
    document.getElementById('close-write-btn')?.addEventListener('click', async () => { 
        await saveEntry(); 
        await saveToDrive(); 
        closeAllModals(true); 
    });

    document.getElementById('btn-readonly')?.addEventListener('click', () => toggleViewMode(state.currentViewMode === 'readOnly' ? 'default' : 'readOnly'));
    document.getElementById('btn-bookmode')?.addEventListener('click', () => toggleViewMode(state.currentViewMode === 'book' ? 'default' : 'book'));
    
    document.getElementById('trash-btn')?.addEventListener('click', openTrashModal);
    document.getElementById('close-trash-btn')?.addEventListener('click', () => closeAllModals(true));
    document.getElementById('btn-empty-trash')?.addEventListener('click', emptyTrash);
    
    document.getElementById('book-nav-left')?.addEventListener('click', () => turnPage(-1));
    document.getElementById('book-nav-right')?.addEventListener('click', () => turnPage(1));

    document.getElementById('ctx-move')?.addEventListener('click', openMoveModal);
    document.getElementById('ctx-copy')?.addEventListener('click', () => { duplicateEntry(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    document.getElementById('ctx-delete')?.addEventListener('click', () => { moveToTrash(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    document.getElementById('ctx-cat-rename')?.addEventListener('click', renameCategoryAction);
    document.getElementById('ctx-cat-delete')?.addEventListener('click', deleteCategoryAction);
}

function openColorPalette() {
    const popup = document.getElementById('color-palette-popup');
    if (popup) {
        popup.style.top = '110px'; popup.classList.toggle('hidden');
    }
}

function renderStickers() { 
    const grid = document.getElementById('sticker-grid');
    if (grid) {
        grid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); insertSticker('${s}')">${s}</span>`).join(''); 
    }
}

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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();