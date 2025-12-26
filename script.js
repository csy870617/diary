import { state, loadCategoriesFromLocal, saveCategoriesToLocal } from './state.js';
import { loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash, duplicateEntry } from './data.js';
import { renderEntries, renderTabs, closeAllModals, openModal, openTrashModal, openMoveModal, renameCategoryAction, deleteCategoryAction, addNewCategory } from './ui.js';
import { openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, insertSticker, applyFontStyle, turnPage, insertImage } from './editor.js';
import { setupAuthListeners } from './auth.js';
import { initGoogleDrive, saveToDrive, syncFromDrive } from './drive.js';

// 전역 윈도우 함수 등록 (HTML 인라인 호출용)
window.addNewCategory = addNewCategory;
window.restoreEntry = restoreEntry;
window.permanentDelete = permanentDelete;
window.duplicateEntry = duplicateEntry;
window.changeGlobalFontSize = changeGlobalFontSize;
window.insertSticker = insertSticker;

const stickers = [ 
    '✝️','⛪','🛐','📖','🙏','🕊️','🕯️',
    '🩸','🐑','🍞','🍷','🍇','👼','🙌',
    '☁️','☀️','🌙','⭐','✨','🌈','🔥',
    '💧','🌱','🌿','🍂','🌻','🌷','🌹',
    '❤️','🧡','💛','💚','💙','💜','🤍',
    '🤎','🖤','💔','❣️','💕','💞','💓',
    '😊','🥰','😭','🥺','🤔','🫡','👏',
    '👍','🤝','🙇','🙆','🙅','💪','🎉',
    '📝','✏️','🖍️','📌','📎','📅','⏳',
    '💡','🔔','🎁','🎀','💌','🏠','🚪'
];

/**
 * 앱 초기화 실행
 */
function init() {
    loadCategoriesFromLocal(); 
    loadDataFromLocal();
    checkOldTrash();
    renderTabs();
    state.isLoading = false;
    renderEntries();

    // 1. Google Drive 초기화 및 동기화 설정
    initGoogleDrive((isLoggedIn) => {
        updateAuthUI(isLoggedIn);
        if (isLoggedIn) {
            renderTabs();
            renderEntries(); 

            // [추가] 백그라운드 실시간 동기화 (1분마다 체크)
            setInterval(() => {
                if (!document.hidden && gapi.client && gapi.client.getToken()) {
                    syncFromDrive(false);
                }
            }, 60000);
        }
    });

    // 2. [추가] 브라우저/앱으로 다시 돌아왔을 때 즉시 최신 데이터 확인
    window.addEventListener('focus', () => {
        if (gapi.client && gapi.client.getToken()) {
            syncFromDrive(false);
        }
    });

    // 3. 온라인 상태가 되면 동기화 시도
    window.addEventListener('online', () => {
        const refreshBtn = document.getElementById('refresh-btn');
        if(refreshBtn && !refreshBtn.classList.contains('hidden')) {
            refreshBtn.classList.add('rotating');
            syncFromDrive(true); // 강제 동기화
            setTimeout(() => refreshBtn.classList.remove('rotating'), 2000);
        }
    });

    setupListeners();
    renderStickers();
    makeDraggable(document.getElementById('color-palette-popup'), document.querySelector('.palette-header'));
}

/**
 * 로그인 상태에 따른 UI 업데이트
 */
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

/**
 * 드래그 가능한 팝업 설정 (색상 팔레트용)
 */
function makeDraggable(element, handle) {
    if (!element) return;
    const dragHandle = handle || element;
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const moveAt = (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        element.style.left = `${initialLeft + dx}px`;
        element.style.top = `${initialTop + dy}px`;
    };

    dragHandle.onmousedown = (e) => {
        if(e.target.tagName === 'BUTTON' || e.target.closest('button')) return; 
        e.preventDefault(); 
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = element.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
        element.style.transform = 'none';
        element.style.left = `${initialLeft}px`;
        element.style.top = `${initialTop}px`;
    };

    window.addEventListener('mousemove', (e) => { if (isDragging) moveAt(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => isDragging = false);
}

/**
 * 주요 이벤트 리스너 설정
 */
function setupListeners() {
    const tabContainer = document.getElementById('tab-container');
    if (typeof Sortable !== 'undefined' && tabContainer) {
        new Sortable(tabContainer, {
            animation: 150, ghostClass: 'sortable-ghost', dragClass: 'sortable-drag',
            filter: '.add-cat-btn', delay: 200, delayOnTouchOnly: true,
            onEnd: async () => {
                const newOrder = [];
                tabContainer.querySelectorAll('.tab-btn').forEach(btn => { if(btn.dataset.id) newOrder.push(btn.dataset.id); });
                state.categoryOrder = newOrder;
                state.categoryUpdatedAt = new Date().toISOString();
                saveCategoriesToLocal();
                await saveToDrive(true); // 순서 변경 후 클라우드 즉시 업로드
            }
        });
        tabContainer.addEventListener('wheel', (evt) => {
            if (evt.deltaY !== 0) { evt.preventDefault(); tabContainer.scrollLeft += evt.deltaY; }
        });
    }

    window.addEventListener('popstate', async (event) => {
        const writeModal = document.getElementById('write-modal');
        if (writeModal && !writeModal.classList.contains('hidden')) await saveEntry();
        if (!event.state || event.state.modal !== 'open') closeAllModals(false); 
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

/**
 * UI 버튼 리스너 설정
 */
function setupUIListeners() {
    const toolbarScroll = document.getElementById('toolbar-scroll-area');
    if (toolbarScroll) {
        toolbarScroll.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) { e.preventDefault(); toolbarScroll.scrollLeft += e.deltaY; }
        }, { passive: false });
    }

    const editorSyncBtn = document.getElementById('editor-sync-btn');
    if (editorSyncBtn) {
        editorSyncBtn.onclick = async function() {
            this.classList.add('rotating');
            try {
                await saveEntry(); // data.js에서 saveEntry 후 자동으로 saveToDrive 호출
            } catch (err) {
                console.error("Sync Error:", err);
            } finally {
                setTimeout(() => this.classList.remove('rotating'), 1000);
            }
        };
    }

    document.getElementById('sort-criteria')?.addEventListener('change', (e) => { state.currentSortBy = e.target.value; renderEntries(); });
    document.getElementById('sort-order-btn')?.addEventListener('click', () => { 
        state.currentSortOrder = state.currentSortOrder === 'desc' ? 'asc' : 'desc'; 
        const icon = document.getElementById('sort-icon');
        if (icon) {
            icon.classList.toggle('ph-sort-descending'); icon.classList.toggle('ph-sort-ascending');
        }
        renderEntries(); 
    });
    
    document.getElementById('search-input')?.addEventListener('input', (e) => renderEntries(e.target.value));
    document.getElementById('search-trigger')?.addEventListener('click', () => document.getElementById('search-input').focus());

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.onclick = async function() {
            this.classList.add('rotating');
            await syncFromDrive(true);
            this.classList.remove('rotating');
        };
    }

    document.getElementById('font-selector')?.addEventListener('change', (e) => applyFontStyle(e.target.value, state.currentFontSize));
    
    document.getElementById('btn-global-size-up')?.addEventListener('click', () => changeGlobalFontSize(2));
    document.getElementById('btn-global-size-down')?.addEventListener('click', () => changeGlobalFontSize(-2));

    document.querySelectorAll('.editor-toolbar .tool-btn[data-cmd]').forEach(btn => {
        btn.onclick = () => formatDoc(btn.dataset.cmd);
    });

    document.getElementById('sticker-btn')?.addEventListener('click', (e) => { 
        e.stopPropagation();
        const palette = document.getElementById('sticker-palette');
        if (palette) {
            palette.style.top = '110px'; palette.classList.toggle('hidden');
        }
    });
    
    const imageInput = document.getElementById('image-upload-input');
    document.getElementById('toolbar-image-btn')?.addEventListener('click', () => {
        document.getElementById('editor-body')?.focus();
        imageInput?.click();
    });
    imageInput?.addEventListener('change', (e) => {
        if (e.target.files[0]) processImage(e.target.files[0]);
        e.target.value = '';
    });

    const toggleBtn = document.getElementById('toolbar-toggle-btn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
            const toolbar = document.getElementById('editor-toolbar');
            if (toolbar) {
                toolbar.classList.toggle('collapsed');
                const icon = this.querySelector('i');
                if (icon) {
                    icon.className = toolbar.classList.contains('collapsed') ? 'ph ph-caret-down' : 'ph ph-caret-up';
                }
            }
        });
    }

    const colorBtn = document.getElementById('toolbar-color-btn');
    if (colorBtn) colorBtn.onclick = (e) => { e.stopPropagation(); state.activeColorMode = 'foreColor'; openColorPalette(); };
    
    const hiliteBtn = document.getElementById('toolbar-hilite-btn');
    if (hiliteBtn) hiliteBtn.onclick = (e) => { e.stopPropagation(); state.activeColorMode = 'hiliteColor'; openColorPalette(); };

    document.querySelectorAll('.color-dot').forEach(btn => { 
        btn.onmousedown = (e) => { 
            e.preventDefault(); 
            if(btn.dataset.color) formatDoc(state.activeColorMode, btn.dataset.color);
            const popup = document.getElementById('color-palette-popup');
            if (popup) popup.classList.add('hidden'); 
        }; 
    });

    document.getElementById('btn-remove-color')?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if(state.activeColorMode === 'hiliteColor') {
             document.execCommand('hiliteColor', false, 'transparent');
             document.execCommand('backColor', false, 'transparent'); 
        } else formatDoc('foreColor', '#111827');
        const popup = document.getElementById('color-palette-popup');
        if (popup) popup.classList.add('hidden'); 
    });

    const editBody = document.getElementById('editor-body');
    if(editBody) {
        editBody.onfocus = () => state.lastFocusedEdit = editBody;
        editBody.onkeydown = (e) => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveEntry(); } };
    }

    const trashBtn = document.getElementById('trash-btn');
    if (trashBtn) trashBtn.onclick = openTrashModal;
    
    const closeTrashBtn = document.getElementById('close-trash-btn');
    if (closeTrashBtn) closeTrashBtn.onclick = () => closeAllModals(true);
    
    const writeBtn = document.getElementById('write-btn');
    if (writeBtn) writeBtn.onclick = () => openEditor(false);
    
    const closeWriteBtn = document.getElementById('close-write-btn');
    if (closeWriteBtn) closeWriteBtn.onclick = async () => { await saveEntry(); closeAllModals(true); };
    
    const readOnlyBtn = document.getElementById('btn-readonly');
    if (readOnlyBtn) readOnlyBtn.onclick = () => toggleViewMode(state.currentViewMode === 'readOnly' ? 'default' : 'readOnly');
    
    const bookModeBtn = document.getElementById('btn-bookmode');
    if (bookModeBtn) bookModeBtn.onclick = () => toggleViewMode(state.currentViewMode === 'book' ? 'default' : 'book');
    
    const copyBtn = document.getElementById('btn-copy-text');
    if (copyBtn) {
        copyBtn.onclick = async () => {
            const title = document.getElementById('edit-title')?.value || "";
            const body = document.getElementById('editor-body')?.innerText || "";
            const text = `${title}\n\n${body}`;
            await navigator.clipboard.writeText(text); alert("복사되었습니다.");
        };
    }

    const navLeft = document.getElementById('book-nav-left');
    if (navLeft) navLeft.onclick = () => turnPage(-1);
    
    const navRight = document.getElementById('book-nav-right');
    if (navRight) navRight.onclick = () => turnPage(1);
    
    document.addEventListener('keydown', (e) => { 
        if(state.currentViewMode === 'book' && !document.getElementById('write-modal').classList.contains('hidden')) { 
            if(e.key === 'ArrowLeft') turnPage(-1); 
            if(e.key === 'ArrowRight') turnPage(1); 
        } 
    });

    const moveBtn = document.getElementById('ctx-move');
    if (moveBtn) moveBtn.onclick = openMoveModal;
    
    const copyCtxBtn = document.getElementById('ctx-copy');
    if (copyCtxBtn) copyCtxBtn.onclick = () => { duplicateEntry(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); };
    
    const deleteCtxBtn = document.getElementById('ctx-delete');
    if (deleteCtxBtn) deleteCtxBtn.onclick = () => { moveToTrash(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); };
    
    const renameCatBtn = document.getElementById('ctx-cat-rename');
    if (renameCatBtn) renameCatBtn.onclick = renameCategoryAction;
    
    const deleteCatBtn = document.getElementById('ctx-cat-delete');
    if (deleteCatBtn) deleteCatBtn.onclick = deleteCategoryAction;
    
    const closeMoveBtn = document.getElementById('close-move-btn');
    if (closeMoveBtn) closeMoveBtn.onclick = () => document.getElementById('move-modal').classList.add('hidden');
    
    const emptyTrashBtn = document.getElementById('btn-empty-trash');
    if (emptyTrashBtn) emptyTrashBtn.onclick = emptyTrash;
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
            const ctx = canvas.getContext('2d');
            const maxWidth = 800;
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