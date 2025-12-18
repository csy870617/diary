import { auth, db } from './firebase.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { addDoc, collection } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { state } from './state.js';
import { loadDataFromFirestore, loadDataFromLocal, saveEntry, moveToTrash, permanentDelete, restoreEntry, emptyTrash, checkOldTrash } from './data.js';
import { renderEntries, renderTabs, closeAllModals, openModal, openTrashModal, openMoveModal, openLockModal, confirmLock, renameCategoryAction, deleteCategoryAction, addNewCategory } from './ui.js';
import { openEditor, toggleViewMode, formatDoc, changeGlobalFontSize, insertSticker, applyFontStyle, turnPage, makeBookEditButton } from './editor.js';
import { setupAuthListeners } from './auth.js';

// --- Global Scope Functions (for HTML inline events) ---
window.addNewCategory = addNewCategory;
window.restoreEntry = restoreEntry;
window.permanentDelete = permanentDelete;
window.changeGlobalFontSize = changeGlobalFontSize;
window.insertSticker = insertSticker;

const stickers = [ '✝️','🙏','📖','🕊️','🕯️','💒','🍞','🍷','🩸','🔥','☁️','☀️','🌙','⭐','✨','🌧️','🌈','❄️','🌿','🌷','🌻','🍂','🌱','🌲','🕊️','🦋','🐾','🧸','🎀','🎈','🎁','🔔','💡','🗝️','📝','📌','📎','✂️','🖍️','🖌️','💌','📅','☕','🍵','🥪','🍎','🤍','💛','🧡','❤️','💜','💙','💚','🤎','🖤','😊','😭','🥰','🤔','💪' ];

function init() {
    // 탭 Sortable
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
    }

    if(tabContainer) {
        tabContainer.addEventListener('wheel', (evt) => {
            if (evt.deltaY !== 0) {
                evt.preventDefault();
                tabContainer.scrollLeft += evt.deltaY; 
            }
        });
    }

    window.addEventListener('popstate', (event) => {
        if (!event.state || event.state.modal !== 'open') {
            closeAllModals(false); 
        }
    });

    // 전역 클릭 이벤트 캡처링
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
        
        if(colorPalettePopup && !colorPalettePopup.classList.contains('hidden')) {
            const isClickInside = colorPalettePopup.contains(e.target);
            const isToolbarBtn = document.getElementById('toolbar-color-btn') && document.getElementById('toolbar-color-btn').contains(e.target);
            const isHiliteBtn = document.getElementById('toolbar-hilite-btn') && document.getElementById('toolbar-hilite-btn').contains(e.target);
            if (!isClickInside && !isToolbarBtn && !isHiliteBtn) colorPalettePopup.classList.add('hidden');
        }
        if(stickerPalette && !stickerPalette.classList.contains('hidden')) {
             const isClickInside = stickerPalette.contains(e.target);
             const isStickerBtn = document.getElementById('sticker-btn') && document.getElementById('sticker-btn').contains(e.target);
             if(!isClickInside && !isStickerBtn) stickerPalette.classList.add('hidden');
        }
    }, true);

    const savedId = localStorage.getItem('savedEmail');
    if(savedId && document.getElementById('login-email')) {
        document.getElementById('login-email').value = savedId;
        document.getElementById('save-id-check').checked = true;
    }

    // Auth Change Listener
    onAuthStateChanged(auth, async (user) => {
        state.isLoading = true; 
        renderEntries();
        
        const loginMsg = document.getElementById('login-msg-area');
        const logoutBtn = document.getElementById('logout-btn');
        const loginTriggerBtn = document.getElementById('login-trigger-btn');
        const loginModal = document.getElementById('login-modal');

        if (user) {
            state.currentUser = user;
            if(logoutBtn) logoutBtn.classList.remove('hidden');
            if(loginTriggerBtn) loginTriggerBtn.classList.add('hidden');
            if(loginModal) loginModal.classList.add('hidden');
            if(loginMsg) loginMsg.classList.add('hidden');
            await loadDataFromFirestore();
        } else {
            state.currentUser = null;
            if(logoutBtn) logoutBtn.classList.add('hidden');
            if(loginTriggerBtn) loginTriggerBtn.classList.remove('hidden');
            if(loginMsg) loginMsg.classList.remove('hidden');
            loadDataFromLocal();
        }
        
        await checkOldTrash();
        
        state.isLoading = false; 
        renderTabs();
        renderEntries();
    });

    setupAuthListeners();
    setupUIListeners();
    renderStickers();
    
    // Make book button init (fallback)
    makeBookEditButton();
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
            document.getElementById('sticker-palette').classList.toggle('hidden');
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

            if(btn.id === 'btn-remove-color' || btn.classList.contains('remove-color')) {
                 if(state.activeColorMode === 'hiliteColor') {
                     document.execCommand('hiliteColor', false, 'transparent');
                 } else {
                     document.execCommand('foreColor', false, '#111827'); 
                 }
            } else {
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

    // Context Menu Actions
    const ctxMove = document.getElementById('ctx-move');
    if(ctxMove) ctxMove.addEventListener('click', () => openMoveModal());
    const ctxLock = document.getElementById('ctx-lock');
    if(ctxLock) ctxLock.addEventListener('click', () => openLockModal());
    const ctxCopy = document.getElementById('ctx-copy');
    if(ctxCopy) ctxCopy.addEventListener('click', duplicateEntry);
    const ctxDelete = document.getElementById('ctx-delete');
    if(ctxDelete) ctxDelete.addEventListener('click', () => { moveToTrash(state.contextTargetId); document.getElementById('context-menu').classList.add('hidden'); });
    
    const ctxCatRename = document.getElementById('ctx-cat-rename');
    if(ctxCatRename) ctxCatRename.addEventListener('click', renameCategoryAction);
    const ctxCatDelete = document.getElementById('ctx-cat-delete');
    if(ctxCatDelete) ctxCatDelete.addEventListener('click', deleteCategoryAction);
    
    const closeMoveBtn = document.getElementById('close-move-btn');
    if(closeMoveBtn) closeMoveBtn.addEventListener('click', () => document.getElementById('move-modal').classList.add('hidden'));
    const closeLockBtn = document.getElementById('close-lock-btn');
    if(closeLockBtn) closeLockBtn.addEventListener('click', () => document.getElementById('lock-modal').classList.add('hidden'));
    const confirmLockBtn = document.getElementById('confirm-lock-btn');
    if(confirmLockBtn) confirmLockBtn.addEventListener('click', confirmLock);

    // Trash Empty Button
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
        colorPalettePopup.style.top = '110px';
        colorPalettePopup.style.bottom = 'auto';
        colorPalettePopup.style.left = '50%';
        colorPalettePopup.style.transform = 'translateX(-50%)';
        colorPalettePopup.classList.toggle('hidden');
    }
}

async function duplicateEntry() {
    document.getElementById('context-menu').classList.add('hidden');
    const entry = state.entries.find(e => e.id === state.contextTargetId);
    if (!entry) return;
    const newEntry = { ...entry };
    delete newEntry.id;
    newEntry.title = `${entry.title} (복사본)`;
    newEntry.timestamp = Date.now();
    newEntry.modifiedAt = Date.now();
    newEntry.date = new Date().toLocaleDateString('ko-KR');
    try {
        if (state.currentUser) {
            await addDoc(collection(db, "users", state.currentUser.uid, "entries"), newEntry);
            await loadDataFromFirestore();
        } else {
            newEntry.id = 'copy_' + Date.now();
            state.entries.unshift(newEntry);
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        }
        renderEntries();
    } catch(e) { console.error(e); alert("복사 실패"); }
}

function renderStickers() { 
    const stickerGrid = document.getElementById('sticker-grid');
    if(stickerGrid) stickerGrid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); insertSticker('${s}')">${s}</span>`).join(''); 
}

// Start
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }