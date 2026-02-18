import { state, loadCategoriesFromLocal, saveCategoriesToLocal } from './state.js';
import { loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash, duplicateEntry } from './data.js';
import { renderEntries, renderTabs, closeAllModals, openModal, openTrashModal, openMoveModal, renameCategoryAction, deleteCategoryAction, addNewCategory } from './ui.js';
import { openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, insertSticker, applyFontStyle, turnPage, jumpToPage, insertImage, triggerAutoSave, insertTable, createHyperlink, addRow, deleteRow, addColumn, deleteColumn, openTableInsertModal, openTableEditModal, mergeCells, splitCellColumns, splitCellRows, saveCurrentSelection } from './editor.js';
import { setupAuthListeners } from './auth.js';
import { initGoogleDrive, saveToDrive, syncFromDrive, ensureTokenOnResume } from './drive.js';

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
    if (!history.state) history.replaceState({ modal: 'main' }, null, '');
    
    const urlParams = new URLSearchParams(window.location.search);
    const sharedData = urlParams.get('share');

    loadCategoriesFromLocal(); 
    loadDataFromLocal();
    checkOldTrash();
    renderTabs();
    state.isLoading = false;
    renderEntries();

    // [중요] 로그인 성공 시 UI를 강제로 업데이트하는 콜백 전달
    initGoogleDrive((isLoggedIn) => {
        updateAuthUI(isLoggedIn);
        if (isLoggedIn) {
            renderTabs();
            renderEntries(); 
            if (!window.syncInterval) {
                window.syncInterval = setInterval(async () => {
                    if (!document.hidden && localStorage.getItem('is_faith_logged_in') === 'true') {
                        const valid = await ensureTokenOnResume();
                        if (valid) syncFromDrive();
                    }
                }, 20000);
            }
        }
    });

    if (sharedData) {
        try {
            const raw = JSON.parse(decodeURIComponent(atob(sharedData)));
            const entry = {
                title: raw.t || raw.title || '제목 없음',
                subtitle: raw.s || raw.subtitle || '',
                body: raw.b || raw.body || '',
                date: raw.d || raw.date || new Date().toLocaleDateString('ko-KR'),
                fontFamily: raw.f || raw.fontFamily || 'Pretendard',
                fontSize: raw.z || raw.fontSize || 10 
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

    window.addEventListener('focus', async () => {
        if (localStorage.getItem('is_faith_logged_in') === 'true') {
            const valid = await ensureTokenOnResume();
            if (valid) syncFromDrive();
        }
    });
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && localStorage.getItem('is_faith_logged_in') === 'true') {
            const valid = await ensureTokenOnResume();
            if (valid) syncFromDrive();
        }
    });
    window.addEventListener('online', async () => {
        if (localStorage.getItem('is_faith_logged_in') === 'true') {
            const valid = await ensureTokenOnResume();
            if (valid) syncFromDrive();
        }
    });

    setupListeners();
    renderStickers();
}

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
        if (window.location.search.includes('share')) {
            window.history.replaceState({}, document.title, window.location.pathname);
            const backBtnText = document.getElementById('back-btn-text');
            if (backBtnText) backBtnText.innerText = '목록';
        }
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
            if (el && !el.contains(e.target) && !e.target.closest('.tool-btn') && !e.target.closest('#font-size-input')) el.classList.add('hidden');
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
        if (icon) { icon.className = state.currentSortOrder === 'desc' ? 'ph ph-sort-descending' : 'ph ph-sort-ascending'; }
        renderEntries(); 
    });
    
    document.getElementById('search-input')?.addEventListener('input', (e) => renderEntries(e.target.value));
    document.getElementById('refresh-btn')?.addEventListener('click', () => syncFromDrive());

    const fontSizeInput = document.getElementById('font-size-input');
    if (fontSizeInput) {
        fontSizeInput.addEventListener('input', (e) => {
            changeGlobalFontSize(e.target.value);
            triggerAutoSave();
        });
    }

    const toolbarScrollArea = document.getElementById('toolbar-scroll-area');
    if (toolbarScrollArea) { toolbarScrollArea.addEventListener('wheel', (e) => { if (e.deltaY !== 0) { e.preventDefault(); toolbarScrollArea.scrollLeft += e.deltaY; } }); }

    document.getElementById('font-selector')?.addEventListener('change', (e) => { applyFontStyle(e.target.value, state.currentFontSize); triggerAutoSave(); });

    document.querySelectorAll('.tool-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.preventDefault(); const cmd = btn.dataset.cmd; if (cmd) formatDoc(cmd); });
    });

    document.getElementById('btn-share')?.addEventListener('click', () => {
        const bodyHtml = document.getElementById('editor-body').innerHTML;
        if (bodyHtml.includes('src="data:image')) {
            alert("이미지가 포함된 글은 URL 공유가 불가능합니다. 우측 하단의 다운로드 버튼(PDF)을 이용해 공유해주세요.");
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
            if (shareUrl.length > 4000) { alert("내용이 너무 길어 공유 링크를 생성할 수 없습니다."); return; }
            if (navigator.share) { navigator.share({ title: '신앙일지 공유', text: `${title}`, url: shareUrl }).catch(console.error); } 
            else { navigator.clipboard.writeText(shareUrl).then(() => { alert('공유 링크가 클립보드에 복사되었습니다.'); }); }
        } catch (e) { alert("공유 링크 생성 실패"); }
    });

    document.getElementById('btn-download')?.addEventListener('click', () => {
        const element = document.getElementById('editor-container');
        const title = document.getElementById('edit-title').value || '신앙일지';
        const opt = {
            margin: 10,
            filename: `${title}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        html2pdf().set(opt).from(element).save();
    });

    document.getElementById('toolbar-link-btn')?.addEventListener('click', () => { createHyperlink(); });

    const tableModal = document.getElementById('table-modal');
    
    // 툴바에서 표 삽입 버튼 클릭 시 커서 위치 저장 후 삽입 모드로 모달 열기
    document.getElementById('toolbar-table-btn')?.addEventListener('click', () => {
        saveCurrentSelection();
        openTableInsertModal();
    });
    
    // 툴바에서 표 편집 버튼 클릭 시 편집 모드로 모달 열기
    document.getElementById('toolbar-table-edit-btn')?.addEventListener('click', () => { 
        openTableEditModal();
    });
    
    // 표 삽입 확인
    document.getElementById('btn-confirm-table')?.addEventListener('click', () => {
        const r = parseInt(document.getElementById('table-rows').value) || 3;
        const c = parseInt(document.getElementById('table-cols').value) || 3;
        insertTable(r, c);
        tableModal.classList.add('hidden');
    });
    
    // 표 모달 닫기
    document.getElementById('btn-cancel-table')?.addEventListener('click', () => { 
        tableModal.classList.add('hidden'); 
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
    document.getElementById('btn-split-col')?.addEventListener('click', () => {
        splitCellColumns();
    });
    document.getElementById('btn-split-row')?.addEventListener('click', () => {
        splitCellRows();
    });

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
            e.preventDefault(); if(btn.dataset.color) formatDoc(state.activeColorMode, btn.dataset.color); document.getElementById('color-palette-popup')?.classList.add('hidden'); 
        }; 
    });

    const removeColorBtn = document.getElementById('btn-remove-color');
    if (removeColorBtn) {
        removeColorBtn.onmousedown = (e) => {
            e.preventDefault();
            const resetValue = (state.activeColorMode === 'hiliteColor') ? 'transparent' : '#111827';
            formatDoc(state.activeColorMode, resetValue);
            document.getElementById('color-palette-popup')?.classList.add('hidden');
        };
    }

    document.getElementById('write-btn')?.addEventListener('click', () => openEditor(false));
    document.getElementById('close-write-btn')?.addEventListener('click', () => { 
        saveEntry(); closeAllModals(true); if (navigator.onLine && window.gapi?.client?.getToken()) saveToDrive(); 
        if (window.location.search.includes('share')) {
            window.history.replaceState({}, document.title, window.location.pathname);
            const backBtnText = document.getElementById('back-btn-text');
            if (backBtnText) backBtnText.innerText = '목록';
        }
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
    if (grid) grid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); window.insertSticker('${s}')">${s}</span>`).join(''); 
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