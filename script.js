import { state, loadCategoriesFromLocal } from './state.js';
import { loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash, duplicateEntry } from './data.js';
import { renderEntries, renderTabs, closeAllModals, openModal, openTrashModal, openMoveModal, renameCategoryAction, deleteCategoryAction, addNewCategory } from './ui.js';
import { openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, insertSticker, applyFontStyle, turnPage, makeBookEditButton, insertImage } from './editor.js';
import { setupAuthListeners } from './auth.js';
import { initGoogleDrive, saveToDrive, syncFromDrive } from './drive.js';

window.addNewCategory = addNewCategory;
window.restoreEntry = restoreEntry;
window.permanentDelete = permanentDelete;
window.duplicateEntry = duplicateEntry;
window.changeGlobalFontSize = changeGlobalFontSize;
window.insertSticker = insertSticker;

const stickers = [ '✝️','🙏','📖','🕊️','🕯️','💒','🍞','🍷','🩸','🔥','☁️','☀️','🌙','⭐','✨','🌧️','🌈','❄️','🌿','🌷','🌻','🍂','🌱','🌲','🕊️','🦋','🐾','🧸','🎀','🎈','🎁','🔔','💡','🗝️','📝','📌','📎','✂️','🖍️','🖌️','💌','📅','☕','🍵','🥪','🍎','🤍','💛','🧡','❤️','💜','💙','💚','🤎','🖤','😊','😭','🥰','🤔','💪' ];

function init() {
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
        }
    });

    window.addEventListener('online', () => {
        console.log("인터넷 연결됨. 자동 동기화 시도...");
        const refreshBtn = document.getElementById('refresh-btn');
        if(refreshBtn && !refreshBtn.classList.contains('hidden')) {
            refreshBtn.classList.add('rotating');
            syncFromDrive(() => {
                refreshBtn.classList.remove('rotating');
            });
        }
    });

    setupListeners();
    renderStickers();
    makeBookEditButton();
    
    // [수정] 이모티콘 팔레트 드래그 코드 제거됨
    // makeDraggable(document.getElementById('sticker-palette'));
    makeDraggable(document.getElementById('color-palette-popup'), document.querySelector('.palette-header'));
}

function updateAuthUI(isLoggedIn) {
    const loginMsg = document.getElementById('login-msg-area');
    const logoutBtn = document.getElementById('logout-btn');
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    const loginModal = document.getElementById('login-modal');
    const refreshBtn = document.getElementById('refresh-btn');

    if (isLoggedIn) {
        if(logoutBtn) logoutBtn.classList.remove('hidden');
        if(loginTriggerBtn) loginTriggerBtn.classList.add('hidden');
        if(loginModal) loginModal.classList.add('hidden');
        if(loginMsg) loginMsg.classList.add('hidden');
        if(refreshBtn) refreshBtn.classList.remove('hidden');
    } else {
        state.currentUser = null;
        if(logoutBtn) logoutBtn.classList.add('hidden');
        if(loginTriggerBtn) loginTriggerBtn.classList.remove('hidden');
        if(loginMsg) loginMsg.classList.remove('hidden');
        if(refreshBtn) refreshBtn.classList.add('hidden');
    }
}

function makeDraggable(element, handle) {
    if (!element) return;
    const dragHandle = handle || element;
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    dragHandle.addEventListener('mousedown', (e) => {
        if(e.target.tagName === 'BUTTON' || e.target.closest('button')) return; 
        e.preventDefault(); 
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = element.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        element.style.transform = 'none'; 
        element.style.left = `${initialLeft}px`;
        element.style.top = `${initialTop}px`;
        element.style.bottom = 'auto';
        element.style.right = 'auto';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        element.style.left = `${initialLeft + dx}px`;
        element.style.top = `${initialTop + dy}px`;
    });

    window.addEventListener('mouseup', () => isDragging = false);
    
    dragHandle.addEventListener('touchstart', (e) => {
        if(e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        isDragging = true;
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        const rect = element.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        element.style.transform = 'none';
        element.style.left = `${initialLeft}px`;
        element.style.top = `${initialTop}px`;
    }, {passive: false});

    window.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const touch = e.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        element.style.left = `${initialLeft + dx}px`;
        element.style.top = `${initialTop + dy}px`;
    }, {passive: false});

    window.addEventListener('touchend', () => isDragging = false);
}

function setupListeners() {
    const tabContainer = document.getElementById('tab-container');
    if (typeof Sortable !== 'undefined' && tabContainer) {
        new Sortable(tabContainer, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            direction: 'horizontal',
            filter: '.add-cat-btn',
            delay: 200, delayOnTouchOnly: true,
            onMove: function(evt) { return evt.related.className.indexOf('add-cat-btn') === -1; },
            onEnd: function (evt) {
                const newOrder = [];
                tabContainer.querySelectorAll('.tab-btn').forEach(btn => { if(btn.dataset.id) newOrder.push(btn.dataset.id); });
                state.categoryOrder = newOrder;
                localStorage.setItem('faithCatOrder', JSON.stringify(state.categoryOrder));
            }
        });
        tabContainer.addEventListener('wheel', (evt) => {
            if (evt.deltaY !== 0) {
                evt.preventDefault();
                tabContainer.scrollLeft += evt.deltaY; 
            }
        });
    }

    window.addEventListener('popstate', async (event) => {
        const writeModal = document.getElementById('write-modal');
        if (writeModal && !writeModal.classList.contains('hidden')) {
             await saveEntry();
        }

        if (!event.state || event.state.modal !== 'open') {
            closeAllModals(false); 
        }
    });

    const editorBody = document.getElementById('editor-body');
    if (editorBody) {
        editorBody.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        
        editorBody.addEventListener('drop', (e) => {
            e.preventDefault();
            const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) {
                processImage(files[0]);
            }
        });
    }

    window.addEventListener('click', (e) => {
        const link = e.target.closest('#editor-body a');
        const editBody = document.getElementById('editor-body');
        
        if (link && link.href) {
            if (editBody && editBody.getAttribute('contenteditable') === "false") {
                e.preventDefault(); 
                e.stopPropagation();
                const win = window.open(link.href, '_blank');
                if(win) win.focus();
                return;
            }
        }
        const contextMenu = document.getElementById('context-menu');
        const catContextMenu = document.getElementById('category-context-menu');
        const colorPalettePopup = document.getElementById('color-palette-popup');
        const stickerPalette = document.getElementById('sticker-palette');

        if (contextMenu && !contextMenu.contains(e.target)) contextMenu.classList.add('hidden');
        if (catContextMenu && !catContextMenu.contains(e.target)) catContextMenu.classList.add('hidden');
        
        if(colorPalettePopup && !colorPalettePopup.classList.contains('hidden') && !colorPalettePopup.contains(e.target) && !e.target.closest('#toolbar-color-btn') && !e.target.closest('#toolbar-hilite-btn')) {
            colorPalettePopup.classList.add('hidden');
        }
        if(stickerPalette && !stickerPalette.classList.contains('hidden') && !stickerPalette.contains(e.target) && !e.target.closest('#sticker-btn')) {
            stickerPalette.classList.add('hidden');
        }
    }, true);

    setupAuthListeners();
    setupUIListeners();
}

function setupUIListeners() {
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) closeLoginBtn.addEventListener('click', () => closeAllModals(true));
    
    const closeResetBtn = document.getElementById('close-reset-btn');
    if(closeResetBtn) closeResetBtn.addEventListener('click', () => closeAllModals(true));
    
    const sortCriteria = document.getElementById('sort-criteria');
    if(sortCriteria) sortCriteria.addEventListener('change', (e) => { state.currentSortBy = e.target.value; renderEntries(); });
    
    const sortOrderBtn = document.getElementById('sort-order-btn');
    if(sortOrderBtn) sortOrderBtn.addEventListener('click', () => { 
        state.currentSortOrder = state.currentSortOrder === 'desc' ? 'asc' : 'desc'; 
        const sortIcon = document.getElementById('sort-icon');
        if(sortIcon) { 
            sortIcon.classList.toggle('ph-sort-descending'); 
            sortIcon.classList.toggle('ph-sort-ascending'); 
        } 
        renderEntries(); 
    });
    
    const searchInput = document.getElementById('search-input');
    if(searchInput) searchInput.addEventListener('input', (e) => renderEntries(e.target.value));
    const searchTrigger = document.getElementById('search-trigger');
    if(searchTrigger) {
        searchTrigger.addEventListener('click', () => {
            document.getElementById('search-input').focus();
        });
    }

    const refreshBtn = document.getElementById('refresh-btn');
    if(refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.classList.add('rotating');
            await saveToDrive();
            refreshBtn.classList.remove('rotating');
        });
    }

    const fontSelector = document.getElementById('font-selector');
    if(fontSelector) fontSelector.addEventListener('change', (e) => applyFontStyle(e.target.value, state.currentFontSize));
    
    const btnGlobalSizeUp = document.getElementById('btn-global-size-up');
    if(btnGlobalSizeUp) btnGlobalSizeUp.addEventListener('click', (e) => { e.preventDefault(); changeGlobalFontSize(2); });
    const btnGlobalSizeDown = document.getElementById('btn-global-size-down');
    if(btnGlobalSizeDown) btnGlobalSizeDown.addEventListener('click', (e) => { e.preventDefault(); changeGlobalFontSize(-2); });

    document.querySelectorAll('.editor-toolbar .tool-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            formatDoc(btn.dataset.cmd);
        });
    });

    const stickerBtn = document.getElementById('sticker-btn');
    if(stickerBtn) {
        stickerBtn.addEventListener('click', (e) => { 
            e.preventDefault();
            e.stopPropagation(); 
            const colorPalettePopup = document.getElementById('color-palette-popup');
            if(colorPalettePopup) colorPalettePopup.classList.add('hidden'); 
            
            const palette = document.getElementById('sticker-palette');
            palette.style.transform = 'translateX(-50%)';
            palette.style.left = '50%';
            palette.style.top = '110px';
            palette.classList.toggle('hidden');
        });
    }
    
    const imageBtn = document.getElementById('toolbar-image-btn');
    const imageInput = document.getElementById('image-upload-input');
    
    if (imageBtn && imageInput) {
        imageBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const editBody = document.getElementById('editor-body');
            if (editBody) editBody.focus();
            imageInput.click();
        });

        imageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                processImage(file);
            }
            e.target.value = '';
        });
    }

    const toolbarToggleBtn = document.getElementById('toolbar-toggle-btn');
    if(toolbarToggleBtn) {
        toolbarToggleBtn.addEventListener('click', () => {
            const editorToolbar = document.getElementById('editor-toolbar');
            if(editorToolbar) {
                editorToolbar.classList.toggle('collapsed');
                const icon = toolbarToggleBtn.querySelector('i');
                if(editorToolbar.classList.contains('collapsed')) {
                    icon.classList.remove('ph-caret-up');
                    icon.classList.add('ph-caret-down');
                } else {
                    icon.classList.remove('ph-caret-down');
                    icon.classList.add('ph-caret-up');
                }
            }
        });
    }

    const toolbarColorBtn = document.getElementById('toolbar-color-btn');
    if(toolbarColorBtn) {
        toolbarColorBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.activeColorMode = 'foreColor';
            openColorPalette();
        });
    }

    const toolbarHiliteBtn = document.getElementById('toolbar-hilite-btn');
    if(toolbarHiliteBtn) {
        toolbarHiliteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.activeColorMode = 'hiliteColor';
            openColorPalette();
        });
    }

    document.querySelectorAll('.color-dot').forEach(btn => { 
        btn.addEventListener('mousedown', (e) => { 
            e.preventDefault(); 
            const editBody = document.getElementById('editor-body');
            if(editBody) editBody.focus(); 

            if(!btn.classList.contains('remove-color') && btn.id !== 'btn-remove-color') {
                 formatDoc(state.activeColorMode, btn.dataset.color); 
            }
            document.getElementById('color-palette-popup').classList.add('hidden'); 
        }); 
    });

    const btnRemoveColor = document.getElementById('btn-remove-color');
    if(btnRemoveColor) {
        btnRemoveColor.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const editBody = document.getElementById('editor-body');
            if(editBody) editBody.focus();
            if(state.activeColorMode === 'hiliteColor') {
                 document.execCommand('hiliteColor', false, 'transparent');
                 document.execCommand('backColor', false, 'transparent'); 
            } else {
                 document.execCommand('foreColor', false, '#111827'); 
            }
            document.getElementById('color-palette-popup').classList.add('hidden'); 
        });
    }

    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const editBody = document.getElementById('editor-body');

    if(editTitle) {
        editTitle.addEventListener('focus', () => state.lastFocusedEdit = editTitle);
        editTitle.addEventListener('click', (e) => { e.stopPropagation(); });
    }
    if(editSubtitle) {
        editSubtitle.addEventListener('focus', () => state.lastFocusedEdit = editSubtitle);
        editSubtitle.addEventListener('click', (e) => { e.stopPropagation(); });
    }
    if(editBody) {
        editBody.addEventListener('focus', () => state.lastFocusedEdit = editBody);
        editBody.addEventListener('keydown', (e) => { 
            if ((e.altKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && (e.key === 's' || e.key === 'S'))) { 
                e.preventDefault(); saveEntry(); 
            } 
        });
        
        const container = document.getElementById('editor-container');
        if(container) {
            container.addEventListener('touchstart', (e) => { if(state.currentViewMode !== 'book') return; state.touchStartX = e.changedTouches[0].screenX; }, {passive:true});
            container.addEventListener('touchend', (e) => { 
                if(state.currentViewMode !== 'book') return; 
                state.touchEndX = e.changedTouches[0].screenX; 
                const swipeThreshold = 50; 
                if (state.touchEndX < state.touchStartX - swipeThreshold) turnPage(1); 
                else if (state.touchEndX > state.touchStartX + swipeThreshold) turnPage(-1); 
            }, {passive:true});
            
            container.addEventListener('mousedown', (e) => {
                if(state.currentViewMode !== 'book') return;
                if(e.button === 2) { 
                    e.preventDefault();
                    turnPage(1);
                }
            });
            container.addEventListener('contextmenu', (e) => {
                if(state.currentViewMode === 'book') e.preventDefault();
            });

            container.addEventListener('wheel', (e) => {
                if(state.currentViewMode !== 'book') return;
                e.preventDefault(); 
                if(state.wheelDebounceTimer) return; 

                if(e.deltaY > 0) {
                    turnPage(1);
                } else if(e.deltaY < 0) {
                    turnPage(-1);
                }

                state.wheelDebounceTimer = setTimeout(() => {
                    state.wheelDebounceTimer = null;
                }, 250);
            }, { passive: false });
        }
    }

    const trashBtn = document.getElementById('trash-btn');
    if(trashBtn) trashBtn.addEventListener('click', openTrashModal);
    const closeTrashBtn = document.getElementById('close-trash-btn');
    if(closeTrashBtn) closeTrashBtn.addEventListener('click', () => closeAllModals(true));
    const writeBtn = document.getElementById('write-btn');
    if(writeBtn) writeBtn.addEventListener('click', () => openEditor(false));
    
    const closeWriteBtn = document.getElementById('close-write-btn');
    if(closeWriteBtn) closeWriteBtn.addEventListener('click', async () => { 
        await saveEntry(); 
        closeAllModals(true); 
    });
    
    const btnReadOnly = document.getElementById('btn-readonly');
    if(btnReadOnly) btnReadOnly.addEventListener('click', () => {
        if (state.currentViewMode === 'readOnly') toggleViewMode('default');
        else toggleViewMode('readOnly');
    });
    
    const btnBookMode = document.getElementById('btn-bookmode');
    if(btnBookMode) btnBookMode.addEventListener('click', () => {
        if (state.currentViewMode === 'book') toggleViewMode('default');
        else toggleViewMode('book');
    });
    
    const btnCopyText = document.getElementById('btn-copy-text');
    if(btnCopyText) btnCopyText.addEventListener('click', async () => {
        const title = document.getElementById('edit-title').value;
        const body = document.getElementById('editor-body').innerText;
        if(!title || !body) return;
        const text = `${title}\n\n${body}`;
        try {
            await navigator.clipboard.writeText(text);
            alert("내용이 클립보드에 복사되었습니다.");
        } catch(err) { console.error(err); }
    });

    const exitFocusBtn = document.getElementById('exit-view-btn');
    if(exitFocusBtn) exitFocusBtn.addEventListener('click', () => toggleViewMode('default'));
    const bookNavLeft = document.getElementById('book-nav-left');
    if(bookNavLeft) bookNavLeft.addEventListener('click', () => turnPage(-1));
    const bookNavRight = document.getElementById('book-nav-right');
    if(bookNavRight) bookNavRight.addEventListener('click', () => turnPage(1));
    
    document.addEventListener('keydown', (e) => { 
        if(state.currentViewMode === 'book' && !document.getElementById('write-modal').classList.contains('hidden')) { 
            if(e.key === 'ArrowLeft') turnPage(-1); 
            if(e.key === 'ArrowRight') turnPage(1); 
        } 
    });

    const ctxMove = document.getElementById('ctx-move');
    if(ctxMove) ctxMove.addEventListener('click', () => openMoveModal());
    
    const ctxCopy = document.getElementById('ctx-copy');
    if(ctxCopy) ctxCopy.addEventListener('click', () => {
         duplicateEntry(state.contextTargetId);
         document.getElementById('context-menu').classList.add('hidden');
    });

    const ctxDelete = document.getElementById('ctx-delete');
    if(ctxDelete) ctxDelete.addEventListener('click', () => { moveToTrash(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    
    const ctxCatRename = document.getElementById('ctx-cat-rename');
    if(ctxCatRename) ctxCatRename.addEventListener('click', renameCategoryAction);
    const ctxCatDelete = document.getElementById('ctx-cat-delete');
    if(ctxCatDelete) ctxCatDelete.addEventListener('click', deleteCategoryAction);
    
    const closeMoveBtn = document.getElementById('close-move-btn');
    if(closeMoveBtn) closeMoveBtn.addEventListener('click', () => document.getElementById('move-modal').classList.add('hidden'));

    const trashHeader = document.querySelector('#trash-modal .write-header');
    if(trashHeader) {
        const spacer = trashHeader.querySelector('div[style*="width: 60px"]');
        if(spacer) {
            spacer.outerHTML = '<button id="btn-empty-trash" class="text-btn" style="font-size:13px; color:#EF4444; border:none; background:none; cursor:pointer; font-family:var(--text-sans); font-weight:600;">비우기</button>';
            document.getElementById('btn-empty-trash').addEventListener('click', emptyTrash);
        }
    }
}

function openColorPalette() {
    const stickerPalette = document.getElementById('sticker-palette');
    const colorPalettePopup = document.getElementById('color-palette-popup');
    if(stickerPalette) stickerPalette.classList.add('hidden');
    if(colorPalettePopup) {
        colorPalettePopup.style.transform = 'translateX(-50%)';
        colorPalettePopup.style.left = '50%';
        colorPalettePopup.style.top = '110px';
        colorPalettePopup.classList.toggle('hidden');
    }
}

function renderStickers() { 
    const stickerGrid = document.getElementById('sticker-grid');
    if(stickerGrid) stickerGrid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); insertSticker('${s}')">${s}</span>`).join(''); 
}

function processImage(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            const maxWidth = 800;
            let width = img.width;
            let height = img.height;

            if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            insertImage(dataUrl);
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }