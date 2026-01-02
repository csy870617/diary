import { state, loadCategoriesFromLocal, saveCategoriesToLocal } from './state.js';
import { loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash, duplicateEntry } from './data.js';
import { renderEntries, renderTabs, closeAllModals, openModal, openTrashModal, openMoveModal, renameCategoryAction, deleteCategoryAction, addNewCategory } from './ui.js';
import { openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, insertSticker, applyFontStyle, turnPage, jumpToPage, insertImage, triggerAutoSave, insertTable } from './editor.js';
import { setupAuthListeners } from './auth.js';
import { initGoogleDrive, saveToDrive, syncFromDrive } from './drive.js';

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
    '📝','✏️','🖍️','📌','📎','📅','⏳','💡','🔔','🎁','🎀','💌','🏠',' DOOR'
];

function init() {
    if (!history.state) history.replaceState({ modal: 'main' }, null, '');
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
            setInterval(() => {
                if (!document.hidden && window.gapi?.client?.getToken()) syncFromDrive();
            }, 15000); 
        }
    });

    window.addEventListener('focus', () => { if (window.gapi?.client?.getToken()) syncFromDrive(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && window.gapi?.client?.getToken()) syncFromDrive(); });
    window.addEventListener('online', () => syncFromDrive());

    setupListeners();
    renderStickers();
}

function updateAuthUI(isLoggedIn) {
    const logoutBtn = document.getElementById('logout-btn'), loginTriggerBtn = document.getElementById('login-trigger-btn'), loginModal = document.getElementById('login-modal'), refreshBtn = document.getElementById('refresh-btn'), loginMsgArea = document.getElementById('login-msg-area');
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

    window.addEventListener('popstate', async () => {
        const writeModal = document.getElementById('write-modal');
        if (writeModal && !writeModal.classList.contains('hidden')) await saveEntry();
        closeAllModals(false); 
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
        if (link && link.href && document.getElementById('editor-body').getAttribute('contenteditable') === "false") {
            e.preventDefault(); e.stopPropagation(); window.open(link.href, '_blank')?.focus(); return;
        }
        const sliderContainer = document.getElementById('book-slider-container');
        if (sliderContainer && !sliderContainer.classList.contains('hidden') && !sliderContainer.contains(e.target) && !e.target.closest('#page-indicator')) sliderContainer.classList.add('hidden');

        ['context-menu', 'category-context-menu', 'color-palette-popup', 'sticker-palette', 'table-modal'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.contains(e.target) && !e.target.closest('.tool-btn')) el.classList.add('hidden');
        });
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

    const toolbarScrollArea = document.getElementById('toolbar-scroll-area');
    if (toolbarScrollArea) { toolbarScrollArea.addEventListener('wheel', (e) => { if (e.deltaY !== 0) { e.preventDefault(); toolbarScrollArea.scrollLeft += e.deltaY; } }); }

    document.getElementById('font-selector')?.addEventListener('change', (e) => { applyFontStyle(e.target.value, state.currentFontSize); triggerAutoSave(); });

    // 볼드, 이탤릭, 언더라인, 취소선, 정렬 버튼 리스너
    document.querySelectorAll('.tool-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const cmd = btn.dataset.cmd;
            if (cmd) formatDoc(cmd);
        });
    });

    // 표 생성 관련 핸들러
    const tableModal = document.getElementById('table-modal');
    document.getElementById('toolbar-table-btn')?.addEventListener('click', () => { tableModal.classList.remove('hidden'); });
    document.getElementById('btn-confirm-table')?.addEventListener('click', () => {
        const r = parseInt(document.getElementById('table-rows').value) || 3;
        const c = parseInt(document.getElementById('table-cols').value) || 3;
        insertTable(r, c);
        tableModal.classList.add('hidden');
    });
    document.getElementById('btn-cancel-table')?.addEventListener('click', () => { tableModal.classList.add('hidden'); });

    document.getElementById('sticker-btn')?.addEventListener('click', (e) => { 
        e.stopPropagation(); const palette = document.getElementById('sticker-palette');
        if (palette) { palette.style.top = '110px'; palette.classList.toggle('hidden'); }
    });
    
    const imageInput = document.getElementById('image-upload-input');
    document.getElementById('toolbar-image-btn')?.addEventListener('click', () => { document.getElementById('editor-body')?.focus(); imageInput?.click(); });
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
            e.preventDefault(); if(btn.dataset.color) formatDoc(state.activeColorMode, btn.dataset.color);
            document.getElementById('color-palette-popup')?.classList.add('hidden'); 
        }; 
    });

    document.getElementById('write-btn')?.addEventListener('click', () => openEditor(false));
    
    document.getElementById('close-write-btn')?.addEventListener('click', () => { 
        saveEntry(); closeAllModals(true); 
        if (navigator.onLine && window.gapi?.client?.getToken()) saveToDrive(); 
    });

    document.getElementById('btn-readonly')?.addEventListener('click', () => toggleViewMode(state.currentViewMode === 'readOnly' ? 'default' : 'readOnly'));
    document.getElementById('btn-bookmode')?.addEventListener('click', () => toggleViewMode(state.currentViewMode === 'book' ? 'default' : 'book'));
    
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

    document.getElementById('ctx-move')?.addEventListener('click', openMoveModal);
    document.getElementById('ctx-copy')?.addEventListener('click', () => { duplicateEntry(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    document.getElementById('ctx-delete')?.addEventListener('click', () => { moveToTrash(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    document.getElementById('ctx-cat-rename')?.addEventListener('click', renameCategoryAction);
    document.getElementById('ctx-cat-delete')?.addEventListener('click', deleteCategoryAction);
}

function openColorPalette() {
    const popup = document.getElementById('color-palette-popup');
    if (popup) { popup.style.top = '110px'; popup.classList.toggle('hidden'); }
}

function renderStickers() { 
    const grid = document.getElementById('sticker-grid');
    if (grid) grid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); insertSticker('${s}')">${s}</span>`).join(''); 
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