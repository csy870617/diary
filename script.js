import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyA0DrHDHo9lI4hsTmaksc9_-QfyeXl1duA",
    authDomain: "faith-log.firebaseapp.com",
    projectId: "faith-log",
    storageBucket: "faith-log.firebasestorage.app",
    messagingSenderId: "702745292814",
    appId: "1:702745292814:web:877100e106c8696b5f8c5f",
    measurementId: "G-0Y5608Q4MT"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- 상태 변수 ---
let currentUser = null;
let currentCategory = 'sermon';
let entries = [];
let isLoading = true; 

const initialCategories = [
    { id: 'sermon', name: '설교' },
    { id: 'meditation', name: '묵상' },
    { id: 'prayer', name: '기도' },
    { id: 'gratitude', name: '감사' }
];
let allCategories = JSON.parse(localStorage.getItem('faithCategories')) || [...initialCategories];
let categoryOrder = JSON.parse(localStorage.getItem('faithCatOrder')) || allCategories.map(c => c.id);

let isEditMode = false;
let editingId = null;
let currentFontSize = 16; 
let currentFontFamily = 'Pretendard';
let currentSortBy = 'created';
let currentSortOrder = 'desc';
let currentViewMode = 'default';

let touchStartX = 0;
let touchEndX = 0;
let contextTargetId = null; 
let contextCatId = null;    
let longPressTimer = null;
let lastFocusedEdit = null;
let activeColorMode = 'foreColor';
let autoSaveTimer = null;
let wheelDebounceTimer = null;

// --- DOM 요소 변수 ---
let loginModal, loginTriggerBtn, logoutBtn, resetPwModal;
let entryList, writeModal, trashModal, trashList, tabContainer;
let editBody, editTitle, editSubtitle;
let fontSelector, stickerPalette, stickerGrid; 
let colorPalettePopup; 
let exitFocusBtn, bookNavLeft, bookNavRight, pageIndicator;
let sortCriteria, sortOrderBtn, sortIcon;
let contextMenu, catContextMenu, moveModal, moveCategoryList, lockModal;
let lockPwInput, lockModalTitle, lockModalDesc;
let editorToolbar, toolbarToggleBtn;
let btnBookEdit; // 책 편집 버튼

const stickers = [ '✝️','🙏','📖','🕊️','🕯️','💒','🍞','🍷','🩸','🔥','☁️','☀️','🌙','⭐','✨','🌧️','🌈','❄️','🌿','🌷','🌻','🍂','🌱','🌲','🕊️','🦋','🐾','🧸','🎀','🎈','🎁','🔔','💡','🗝️','📝','📌','📎','✂️','🖍️','🖌️','💌','📅','☕','🍵','🥪','🍎','🤍','💛','🧡','❤️','💜','💙','💚','🤎','🖤','😊','😭','🥰','🤔','💪' ];

function init() {
    loadDOMElements();

    if(categoryOrder.length === 0) categoryOrder = allCategories.map(c => c.id);

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
                categoryOrder = newOrder;
                localStorage.setItem('faithCatOrder', JSON.stringify(categoryOrder));
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

    // [최종 수정] 전역 클릭 이벤트 캡처링 (링크 클릭 강제)
    window.addEventListener('click', (e) => {
        // 1. 에디터 내부의 링크 클릭 감지
        const link = e.target.closest('#editor-body a');
        
        if (link && link.href) {
            // 에디터가 존재하고, contenteditable 속성이 "false"일 때 (읽기전용, 책모드)
            // 반드시 새 창으로 엽니다.
            if (editBody && editBody.getAttribute('contenteditable') === "false") {
                e.preventDefault(); 
                e.stopPropagation();
                const win = window.open(link.href, '_blank');
                if(win) win.focus();
                return;
            }
        }

        // 2. 팝업 닫기 (기존 기능 유지)
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
    }, true); // true: 캡처링 단계에서 실행하여 다른 이벤트보다 먼저 처리

    const savedId = localStorage.getItem('savedEmail');
    if(savedId && document.getElementById('login-email')) {
        document.getElementById('login-email').value = savedId;
        document.getElementById('save-id-check').checked = true;
    }

    onAuthStateChanged(auth, async (user) => {
        isLoading = true; 
        renderEntries();
        
        const loginMsg = document.getElementById('login-msg-area');
        if (user) {
            currentUser = user;
            if(logoutBtn) logoutBtn.classList.remove('hidden');
            if(loginTriggerBtn) loginTriggerBtn.classList.add('hidden');
            if(loginModal) loginModal.classList.add('hidden');
            if(loginMsg) loginMsg.classList.add('hidden');
            await loadDataFromFirestore();
        } else {
            currentUser = null;
            if(logoutBtn) logoutBtn.classList.add('hidden');
            if(loginTriggerBtn) loginTriggerBtn.classList.remove('hidden');
            if(loginMsg) loginMsg.classList.remove('hidden');
            loadDataFromLocal();
        }
        
        await checkOldTrash();
        
        isLoading = false; 
        renderTabs();
        renderEntries();
    });

    setupEventListeners();
    renderStickers();
}

function loadDOMElements() {
    fontSelector = document.getElementById('font-selector');
    stickerPalette = document.getElementById('sticker-palette');
    stickerGrid = document.getElementById('sticker-grid');
    colorPalettePopup = document.getElementById('color-palette-popup');
    loginModal = document.getElementById('login-modal');
    loginTriggerBtn = document.getElementById('login-trigger-btn');
    logoutBtn = document.getElementById('logout-btn');
    resetPwModal = document.getElementById('reset-pw-modal');
    entryList = document.getElementById('entry-list');
    writeModal = document.getElementById('write-modal');
    trashModal = document.getElementById('trash-modal');
    trashList = document.getElementById('trash-list');
    tabContainer = document.getElementById('tab-container');
    editBody = document.getElementById('editor-body');
    editTitle = document.getElementById('edit-title');
    editSubtitle = document.getElementById('edit-subtitle');
    exitFocusBtn = document.getElementById('exit-view-btn');
    bookNavLeft = document.getElementById('book-nav-left');
    bookNavRight = document.getElementById('book-nav-right');
    pageIndicator = document.getElementById('page-indicator');
    sortCriteria = document.getElementById('sort-criteria');
    sortOrderBtn = document.getElementById('sort-order-btn');
    sortIcon = document.getElementById('sort-icon');
    contextMenu = document.getElementById('context-menu');
    catContextMenu = document.getElementById('category-context-menu');
    moveModal = document.getElementById('move-modal');
    moveCategoryList = document.getElementById('move-category-list');
    lockModal = document.getElementById('lock-modal');
    lockPwInput = document.getElementById('lock-pw-input');
    lockModalTitle = document.getElementById('lock-modal-title');
    lockModalDesc = document.getElementById('lock-modal-desc');
    editorToolbar = document.getElementById('editor-toolbar');
    toolbarToggleBtn = document.getElementById('toolbar-toggle-btn');
    
    // [유지] 로드시 책 편집 버튼 생성 시도
    makeBookEditButton();

    const toolbarScroll = document.querySelector('.toolbar-content-scroll');
    if(toolbarScroll) {
        toolbarScroll.addEventListener('wheel', (evt) => {
            if(evt.deltaY !== 0) {
                evt.preventDefault();
                toolbarScroll.scrollLeft += evt.deltaY;
            }
        });
    }
}

// [기능 유지] 책 편집 버튼 생성 함수 (무조건 생성)
function makeBookEditButton() {
    const btnBookMode = document.getElementById('btn-bookmode');
    
    // 이미 버튼이 있으면 할당만 하고 종료
    if (document.getElementById('btn-book-edit')) {
        btnBookEdit = document.getElementById('btn-book-edit');
        return;
    }

    if (btnBookMode && btnBookMode.parentElement) {
        btnBookEdit = document.createElement('button');
        btnBookEdit.id = 'btn-book-edit';
        btnBookEdit.className = 'icon-btn';
        btnBookEdit.title = "페이지 편집";
        // 디자인 스타일링
        btnBookEdit.innerHTML = '<i class="ph ph-pencil-simple" style="font-size: 18px;"></i>';
        btnBookEdit.style.cssText = "display: none; align-items: center; justify-content: center; gap: 4px; font-family: 'Pretendard'; font-size: 14px; font-weight: 600; color: #4B5563; background: transparent; border: none; cursor: pointer; padding: 8px; margin-left: 4px; border-radius: 6px; width: 36px; height: 36px;";
        
        btnBookEdit.addEventListener('mouseover', () => btnBookEdit.style.backgroundColor = '#F3F4F6');
        btnBookEdit.addEventListener('mouseout', () => btnBookEdit.style.backgroundColor = 'transparent');
        btnBookEdit.addEventListener('click', enableBookEditing);

        // btn-bookmode 바로 옆에 삽입
        if (btnBookMode.nextSibling) {
            btnBookMode.parentElement.insertBefore(btnBookEdit, btnBookMode.nextSibling);
        } else {
            btnBookMode.parentElement.appendChild(btnBookEdit);
        }
    }
    
    // 목록 버튼(닫기) 왼쪽 정렬 보장
    const closeWriteBtn = document.getElementById('close-write-btn');
    const headerLeft = document.querySelector('.write-header .header-left');
    if (headerLeft && closeWriteBtn && !headerLeft.contains(closeWriteBtn)) {
        headerLeft.prepend(closeWriteBtn);
    }
}

function closeAllModals(goBack = true) {
    if(writeModal) {
        writeModal.classList.add('hidden');
        toggleViewMode('default', false); 
        
        if(editorToolbar) {
            editorToolbar.classList.remove('collapsed');
            const icon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
            if(icon) {
                icon.classList.remove('ph-caret-down');
                icon.classList.add('ph-caret-up');
            }
        }
    }
    if(trashModal) trashModal.classList.add('hidden');
    if(loginModal) loginModal.classList.add('hidden');
    if(resetPwModal) resetPwModal.classList.add('hidden');
    
    if(stickerPalette) stickerPalette.classList.add('hidden');
    if(colorPalettePopup) colorPalettePopup.classList.add('hidden');
    if(contextMenu) contextMenu.classList.add('hidden');
    if(moveModal) moveModal.classList.add('hidden');
    if(lockModal) lockModal.classList.add('hidden');
    
    if(goBack) history.back();
    renderEntries();
}

function openModal(modal) {
    if(!modal) return;
    if (!history.state || history.state.modal !== 'open') {
        history.pushState({ modal: 'open' }, null, '');
    }
    modal.classList.remove('hidden');
}

function debouncedSave() {
    if(autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(saveEntry, 1000); 
}

function autoLink(text) {
    const div = document.createElement('div');
    div.innerHTML = text;
    
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const nodesToReplace = [];
    
    while(node = walker.nextNode()) {
        if(node.parentElement.tagName === 'A') continue; 
        if(node.nodeValue.match(/(https?:\/\/[^\s]+)/)) {
            nodesToReplace.push(node);
        }
    }
    
    nodesToReplace.forEach(node => {
        const span = document.createElement('span');
        // 중요: pointer-events auto 추가하여 클릭 보장
        span.innerHTML = node.nodeValue.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#2563EB; text-decoration:underline; pointer-events: auto !important; cursor: pointer;">$1</a>');
        node.parentElement.replaceChild(span, node);
        const parent = span.parentElement;
        while(span.firstChild) {
            parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
    });
    
    return div.innerHTML;
}

function setupEventListeners() {
    if(loginTriggerBtn) loginTriggerBtn.addEventListener('click', () => openModal(loginModal));
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) closeLoginBtn.addEventListener('click', () => closeAllModals(true));
    
    const loginForm = document.getElementById('login-form');
    if(loginForm) loginForm.addEventListener('submit', async (e) => { 
        e.preventDefault(); 
        try { 
            const persistence = document.getElementById('save-id-check').checked ? browserLocalPersistence : browserSessionPersistence;
            await setPersistence(auth, persistence); 
            await signInWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-pw').value); 
            closeAllModals(true); 
        } catch (error) { alert("로그인 정보를 다시 확인해주세요."); } 
    });
    
    const signupBtn = document.getElementById('signup-btn');
    if(signupBtn) signupBtn.addEventListener('click', async (e) => { e.preventDefault(); try { await createUserWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-pw').value); alert('가입 완료되었습니다.'); } catch (error) { alert("실패: " + error.message); } });
    if(logoutBtn) logoutBtn.addEventListener('click', () => { if(confirm("로그아웃 하시겠습니까?")) signOut(auth); });
    const forgotPwBtn = document.getElementById('forgot-pw-btn');
    if(forgotPwBtn) forgotPwBtn.addEventListener('click', (e) => { e.preventDefault(); openModal(resetPwModal); });
    const closeResetBtn = document.getElementById('close-reset-btn');
    if(closeResetBtn) closeResetBtn.addEventListener('click', () => closeAllModals(true));
    
    if(sortCriteria) sortCriteria.addEventListener('change', (e) => { currentSortBy = e.target.value; renderEntries(); });
    if(sortOrderBtn) sortOrderBtn.addEventListener('click', () => { 
        currentSortOrder = currentSortOrder === 'desc' ? 'asc' : 'desc'; 
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

    if(fontSelector) fontSelector.addEventListener('change', (e) => applyFontStyle(e.target.value, currentFontSize));
    const btnGlobalSizeUp = document.getElementById('btn-global-size-up');
    if(btnGlobalSizeUp) btnGlobalSizeUp.addEventListener('click', (e) => { e.preventDefault(); window.changeGlobalFontSize(2); });
    const btnGlobalSizeDown = document.getElementById('btn-global-size-down');
    if(btnGlobalSizeDown) btnGlobalSizeDown.addEventListener('click', (e) => { e.preventDefault(); window.changeGlobalFontSize(-2); });

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
            if(colorPalettePopup) colorPalettePopup.classList.add('hidden'); 
            toggleStickerMenu();
        });
    }
    
    if(toolbarToggleBtn) {
        toolbarToggleBtn.addEventListener('click', () => {
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
            activeColorMode = 'foreColor';
            openColorPalette();
        });
    }

    const toolbarHiliteBtn = document.getElementById('toolbar-hilite-btn');
    if(toolbarHiliteBtn) {
        toolbarHiliteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            activeColorMode = 'hiliteColor';
            openColorPalette();
        });
    }

    function openColorPalette() {
        if(stickerPalette) stickerPalette.classList.add('hidden');
        if(colorPalettePopup) {
            colorPalettePopup.style.top = '110px';
            colorPalettePopup.style.bottom = 'auto';
            colorPalettePopup.style.left = '50%';
            colorPalettePopup.style.transform = 'translateX(-50%)';
            colorPalettePopup.classList.toggle('hidden');
        }
    }

    document.querySelectorAll('.color-dot').forEach(btn => { 
        btn.addEventListener('mousedown', (e) => { 
            e.preventDefault(); 
            if(editBody) editBody.focus(); 

            if(btn.id === 'btn-remove-color' || btn.classList.contains('remove-color')) {
                 if(activeColorMode === 'hiliteColor') {
                     document.execCommand('hiliteColor', false, 'transparent');
                 } else {
                     document.execCommand('foreColor', false, '#111827'); 
                 }
            } else {
                 formatDoc(activeColorMode, btn.dataset.color); 
            }
            colorPalettePopup.classList.add('hidden'); 
            debouncedSave();
        }); 
    });

    const btnRemoveColor = document.getElementById('btn-remove-color');
    if(btnRemoveColor) {
        btnRemoveColor.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if(editBody) editBody.focus();
            if(activeColorMode === 'hiliteColor') {
                 document.execCommand('hiliteColor', false, 'transparent');
            } else {
                 document.execCommand('foreColor', false, '#111827'); 
            }
            if(colorPalettePopup) colorPalettePopup.classList.add('hidden'); 
            debouncedSave();
        });
    }

    const trackFocus = (el) => { lastFocusedEdit = el; };
    if(editTitle) {
        editTitle.addEventListener('focus', () => trackFocus(editTitle));
        editTitle.addEventListener('click', (e) => { e.stopPropagation(); });
        editTitle.addEventListener('input', debouncedSave);
    }
    if(editSubtitle) {
        editSubtitle.addEventListener('focus', () => trackFocus(editSubtitle));
        editSubtitle.addEventListener('click', (e) => { e.stopPropagation(); });
        editSubtitle.addEventListener('input', debouncedSave);
    }
    if(editBody) {
        editBody.addEventListener('focus', () => trackFocus(editBody));
        editBody.addEventListener('keydown', (e) => { 
            if ((e.altKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && (e.key === 's' || e.key === 'S'))) { 
                e.preventDefault(); saveEntry(); 
            } 
        });
        
        editBody.addEventListener('input', debouncedSave);
        
        document.addEventListener('selectionchange', handleSelection);
        editBody.addEventListener('mouseup', handleSelection);
        editBody.addEventListener('keyup', handleSelection);
        editBody.addEventListener('touchend', () => setTimeout(handleSelection, 100));
        
        const container = document.getElementById('editor-container');
        if(container) {
            container.addEventListener('touchstart', (e) => { if(currentViewMode !== 'book') return; touchStartX = e.changedTouches[0].screenX; }, {passive:true});
            container.addEventListener('touchend', (e) => { if(currentViewMode !== 'book') return; touchEndX = e.changedTouches[0].screenX; handleSwipe(); }, {passive:true});
            
            container.addEventListener('mousedown', (e) => {
                if(currentViewMode !== 'book') return;
                if(e.button === 2) { 
                    e.preventDefault();
                    turnPage(1);
                }
            });
            container.addEventListener('contextmenu', (e) => {
                if(currentViewMode === 'book') e.preventDefault();
            });

            container.addEventListener('wheel', (e) => {
                if(currentViewMode !== 'book') return;
                e.preventDefault(); 

                if(wheelDebounceTimer) return; 

                if(e.deltaY > 0) {
                    turnPage(1);
                } else if(e.deltaY < 0) {
                    turnPage(-1);
                }

                wheelDebounceTimer = setTimeout(() => {
                    wheelDebounceTimer = null;
                }, 250);
            }, { passive: false });
        }
    }

    const btnSizeUp = document.getElementById('btn-sel-size-up');
    if(btnSizeUp) btnSizeUp.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); changeSelectionFontSize(2); });
    const btnSizeDown = document.getElementById('btn-sel-size-down');
    if(btnSizeDown) btnSizeDown.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); changeSelectionFontSize(-2); });

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
        if (currentViewMode === 'readOnly') toggleViewMode('default');
        else toggleViewMode('readOnly');
    });
    
    const btnBookMode = document.getElementById('btn-bookmode');
    if(btnBookMode) btnBookMode.addEventListener('click', () => {
        if (currentViewMode === 'book') toggleViewMode('default');
        else toggleViewMode('book');
    });
    
    const btnCopyText = document.getElementById('btn-copy-text');
    if(btnCopyText) btnCopyText.addEventListener('click', copyContentToClipboard);

    if(exitFocusBtn) exitFocusBtn.addEventListener('click', () => toggleViewMode('default'));
    if(bookNavLeft) bookNavLeft.addEventListener('click', () => turnPage(-1));
    if(bookNavRight) bookNavRight.addEventListener('click', () => turnPage(1));
    document.addEventListener('keydown', (e) => { if(currentViewMode === 'book' && !writeModal.classList.contains('hidden')) { if(e.key === 'ArrowLeft') turnPage(-1); if(e.key === 'ArrowRight') turnPage(1); } });

    const ctxMove = document.getElementById('ctx-move');
    if(ctxMove) ctxMove.addEventListener('click', () => openMoveModal());
    const ctxLock = document.getElementById('ctx-lock');
    if(ctxLock) ctxLock.addEventListener('click', () => openLockModal());
    const ctxCopy = document.getElementById('ctx-copy');
    if(ctxCopy) ctxCopy.addEventListener('click', () => duplicateEntry());
    const ctxDelete = document.getElementById('ctx-delete');
    if(ctxDelete) ctxDelete.addEventListener('click', () => { moveToTrash(contextTargetId); contextMenu.classList.add('hidden'); });
    const ctxCatRename = document.getElementById('ctx-cat-rename');
    if(ctxCatRename) ctxCatRename.addEventListener('click', renameCategoryAction);
    const ctxCatDelete = document.getElementById('ctx-cat-delete');
    if(ctxCatDelete) ctxCatDelete.addEventListener('click', deleteCategoryAction);
    const closeMoveBtn = document.getElementById('close-move-btn');
    if(closeMoveBtn) closeMoveBtn.addEventListener('click', () => moveModal.classList.add('hidden'));
    const closeLockBtn = document.getElementById('close-lock-btn');
    if(closeLockBtn) closeLockBtn.addEventListener('click', () => lockModal.classList.add('hidden'));
    const confirmLockBtn = document.getElementById('confirm-lock-btn');
    if(confirmLockBtn) confirmLockBtn.addEventListener('click', confirmLock);

    const trashHeader = document.querySelector('#trash-modal .write-header');
    if(trashHeader) {
        const spacer = trashHeader.querySelector('div[style*="width: 60px"]');
        if(spacer) {
            spacer.outerHTML = '<button id="btn-empty-trash" class="text-btn" style="font-size:13px; color:#EF4444; border:none; background:none; cursor:pointer; font-family:var(--text-sans); font-weight:600;">비우기</button>';
            document.getElementById('btn-empty-trash').addEventListener('click', emptyTrash);
        }
    }
}

function toggleStickerMenu() {
    if(stickerPalette) stickerPalette.classList.toggle('hidden');
}

async function copyContentToClipboard() {
    if(!editTitle || !editBody) return;
    const text = `${editTitle.value}\n\n${editBody.innerText}`;
    try {
        await navigator.clipboard.writeText(text);
        alert("내용이 클립보드에 복사되었습니다.");
    } catch(err) {
        console.error("복사 실패", err);
    }
}

function handleSelection() {
    // 플로팅 메뉴 없음
}

window.formatDoc = (cmd, value = null) => {
    if (document.activeElement === editTitle || document.activeElement === editSubtitle) return;
    if (!editBody) return;
    editBody.focus();
    document.execCommand(cmd, false, value);
    debouncedSave(); 
};

window.changeGlobalFontSize = (delta) => { 
    if(!editBody) return;
    const style = window.getComputedStyle(editBody);
    let currentSize = parseFloat(style.fontSize);
    if(isNaN(currentSize)) currentSize = 16;
    let newSize = currentSize + delta;
    if(newSize < 12) newSize = 12;
    if(newSize > 60) newSize = 60;
    currentFontSize = newSize; 
    applyFontStyle(currentFontFamily, newSize);
    const spans = editBody.querySelectorAll('span[style*="font-size"]');
    spans.forEach(span => {
        let spanCurrentStyle = window.getComputedStyle(span);
        let spanSize = parseFloat(spanCurrentStyle.fontSize);
        if(!isNaN(spanSize)) {
            let newSpanSize = spanSize + delta;
            if(newSpanSize < 10) newSpanSize = 10;
            span.style.fontSize = newSpanSize + 'px';
        }
    });
    debouncedSave();
};

window.changeSelectionFontSize = (delta) => {
    // 사용 안함
};

window.insertSticker = (emoji) => { 
    const target = lastFocusedEdit || editBody;
    if (target === editTitle || target === editSubtitle) { 
        const start = target.selectionStart; 
        const end = target.selectionEnd; 
        const text = target.value; 
        target.value = text.substring(0, start) + emoji + text.substring(end); 
        target.selectionStart = target.selectionEnd = start + emoji.length; 
        target.focus();
    } else { 
        editBody.focus(); 
        document.execCommand('insertText', false, emoji); 
    } 
    debouncedSave();
};

function renderStickers() { 
    if(stickerGrid) stickerGrid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); insertSticker('${s}')">${s}</span>`).join(''); 
}

function applyFontStyle(f, s) { 
    currentFontFamily = f; 
    currentFontSize = s; 
    if(editBody) {
        editBody.style.fontFamily = f; 
        editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; 
    }
    if(fontSelector) fontSelector.value = f; 
}

function openEditor(m, d) { 
    isEditMode = m; 
    openModal(writeModal); 
    
    // 모달 열 때 버튼 생성 (확실한 보장)
    makeBookEditButton();
    
    const catName = allCategories.find(c => c.id === currentCategory)?.name || '기록';
    const displayCat = document.getElementById('display-category');
    if(displayCat) displayCat.innerText = catName;
    const displayDate = document.getElementById('display-date');
    if(displayDate) displayDate.innerText = d ? d.date : new Date().toLocaleDateString('ko-KR');

    if(m&&d) { 
        editingId=d.id; 
        editTitle.value=d.title; 
        editSubtitle.value=d.subtitle; 
        editBody.innerHTML= autoLink(d.body); 
        applyFontStyle(d.fontFamily||'Pretendard', d.fontSize||16); 
    } else { 
        editingId=null; 
        editTitle.value=''; 
        editSubtitle.value=''; 
        editBody.innerHTML=''; 
        applyFontStyle('Pretendard', 16); 
    } 
    lastFocusedEdit = editBody;
    toggleViewMode('default', false);
}

// [수정] 책 모드에서 편집 활성화
function enableBookEditing() {
    if(currentViewMode !== 'book') return;
    
    editTitle.readOnly = false;
    editSubtitle.readOnly = false;
    editBody.contentEditable = "true";
    
    // 버튼 다시 찾고 숨기기
    if(!btnBookEdit) btnBookEdit = document.getElementById('btn-book-edit');
    if(btnBookEdit) btnBookEdit.style.display = 'none'; // CSS 클래스 대신 직접 스타일 제어
    
    // 툴바는 접힌 상태 유지
}

function toggleViewMode(mode, pushToHistory = false) {
    currentViewMode = mode;
    
    writeModal.classList.remove('mode-read-only', 'mode-book');
    bookNavLeft.classList.add('hidden');
    bookNavRight.classList.add('hidden');
    pageIndicator.classList.add('hidden');
    if(exitFocusBtn) exitFocusBtn.classList.add('hidden');
    
    const btnReadOnly = document.getElementById('btn-readonly');
    const btnBookMode = document.getElementById('btn-bookmode');
    if(btnReadOnly) btnReadOnly.classList.remove('active');
    if(btnBookMode) btnBookMode.classList.remove('active');
    
    const toolbarIcon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;

    if (mode === 'readOnly') {
        editTitle.readOnly = true;
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        // [중요] 읽기 전용 포인터 이벤트 활성화
        editBody.style.pointerEvents = "auto";
        editBody.style.userSelect = "text";
        
        writeModal.classList.add('mode-read-only');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnReadOnly) btnReadOnly.classList.add('active');

    } else if (mode === 'book') {
        editTitle.readOnly = true; 
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        // [중요] 책 모드 포인터 이벤트 활성화
        editBody.style.pointerEvents = "auto";
        editBody.style.userSelect = "text";
        
        writeModal.classList.add('mode-book');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnBookMode) btnBookMode.classList.add('active');
        const container = document.getElementById('editor-container');
        if(container) container.scrollLeft = 0; 
        updateBookNav();
        
        if(editorToolbar) {
            editorToolbar.classList.add('collapsed');
            if(toolbarIcon) {
                toolbarIcon.classList.remove('ph-caret-up');
                toolbarIcon.classList.add('ph-caret-down');
            }
        }
        
        // 버튼 표시
        if(!btnBookEdit) btnBookEdit = document.getElementById('btn-book-edit');
        if(!btnBookEdit) makeBookEditButton();
        if(btnBookEdit) btnBookEdit.style.display = 'inline-flex'; // 보이게 설정

    } else {
        editTitle.readOnly = false;
        editSubtitle.readOnly = false;
        editBody.contentEditable = "true";
        editBody.style.pointerEvents = "auto";
        editBody.style.userSelect = "text";
        
        if(!btnBookEdit) btnBookEdit = document.getElementById('btn-book-edit');
        if(btnBookEdit) btnBookEdit.style.display = 'none'; // 숨김
        
        if(editorToolbar) {
            editorToolbar.classList.remove('collapsed');
            if(toolbarIcon) {
                toolbarIcon.classList.remove('ph-caret-down');
                toolbarIcon.classList.add('ph-caret-up');
            }
        }
    }
}

function handleSwipe() { const swipeThreshold = 50; if (touchEndX < touchStartX - swipeThreshold) turnPage(1); else if (touchEndX > touchStartX + swipeThreshold) turnPage(-1); }

function turnPage(direction) { 
    if (currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    const pageWidth = container.clientWidth; 
    const currentScroll = container.scrollLeft; 
    
    const currentPageIndex = Math.round(currentScroll / pageWidth);
    const nextPageIndex = currentPageIndex + direction;
    const newScroll = nextPageIndex * pageWidth;
    
    container.scrollTo({ left: newScroll, behavior: 'auto' }); 
    setTimeout(updateBookNav, 50); 
}

function updateBookNav() { 
    if (currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    const scrollLeft = container.scrollLeft; 
    const scrollWidth = container.scrollWidth; 
    const clientWidth = container.clientWidth; 
    if (scrollLeft > 10) bookNavLeft.classList.remove('hidden'); else bookNavLeft.classList.add('hidden'); 
    if (scrollLeft + clientWidth < scrollWidth - 10) bookNavRight.classList.remove('hidden'); else bookNavRight.classList.add('hidden'); 
    const currentPage = Math.round(scrollLeft / clientWidth) + 1; 
    const totalPages = Math.ceil(scrollWidth / clientWidth); 
    pageIndicator.innerText = `${currentPage} / ${totalPages}`; 
    pageIndicator.classList.remove('hidden'); 
}

function renderEntries(keyword = '') {
    if(!entryList) return;
    entryList.innerHTML = '';
    if(isLoading) {
        entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">로딩 중...</div>`;
        return;
    }
    const filtered = entries.filter(entry => !entry.isDeleted && entry.category === currentCategory && (entry.title.includes(keyword) || entry.body.includes(keyword)));
    filtered.sort((a, b) => { let valA, valB; if (currentSortBy === 'title') { valA = a.title; valB = b.title; } else if (currentSortBy === 'modified') { valA = a.modifiedAt || a.timestamp; valB = b.modifiedAt || b.timestamp; } else { valA = a.timestamp; valB = b.timestamp; } if (valA < valB) return currentSortOrder === 'asc' ? -1 : 1; if (valA > valB) return currentSortOrder === 'asc' ? 1 : -1; return 0; });
    if (filtered.length === 0) { entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">기록이 없습니다.</div>`; return; }
    filtered.forEach(entry => {
        const div = document.createElement('article');
        div.className = 'entry-card';
        if (entry.isLocked) {
            div.innerHTML = `<h3 class="card-title"><i class="ph ph-lock-key"></i> ${entry.title}</h3><p class="card-subtitle" style="color:#aaa;">비공개 글입니다.</p><div class="card-meta"><span>${entry.date}</span></div>`;
            div.onclick = () => { contextTargetId = entry.id; openLockModal(); };
        } else {
            const dateStr = currentSortBy === 'modified' ? `수정: ${new Date(entry.modifiedAt || entry.timestamp).toLocaleDateString()}` : entry.date;
            div.innerHTML = `<h3 class="card-title">${entry.title}</h3>${entry.subtitle ? `<p class="card-subtitle">${entry.subtitle}</p>` : ''}<div class="card-meta"><span>${dateStr}</span></div>`;
            div.onclick = () => {
                openEditor(true, entry);
                toggleViewMode('readOnly'); // [수정] 클릭 시 읽기 전용으로 열기
            };
        }
        attachContextMenu(div, entry.id);
        entryList.appendChild(div);
    });
}

function renderTabs() {
    if(!tabContainer) return;
    tabContainer.innerHTML = '';
    const sortedCats = [];
    categoryOrder.forEach(id => { const found = allCategories.find(c => c.id === id); if(found) sortedCats.push(found); });
    allCategories.forEach(c => { if(!categoryOrder.includes(c.id)) { sortedCats.push(c); categoryOrder.push(c.id); } });

    sortedCats.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `tab-btn ${currentCategory === cat.id ? 'active' : ''}`;
        btn.dataset.id = cat.id; 
        btn.innerHTML = `<span>${cat.name}</span>`;
        btn.onclick = () => { currentCategory = cat.id; renderTabs(); renderEntries(); };
        attachCatContextMenu(btn, cat.id);
        tabContainer.appendChild(btn);
    });
    
    const addBtn = document.createElement('button');
    addBtn.className = 'add-cat-btn';
    addBtn.innerHTML = '<i class="ph ph-plus"></i>';
    addBtn.onclick = addNewCategory;
    tabContainer.appendChild(addBtn);
}

function attachCatContextMenu(element, catId) {
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCatContextMenu(e.clientX, e.clientY, catId);
    });
    element.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showCatContextMenu(touch.clientX, touch.clientY, catId);
        }, 600);
    }, { passive: true });
    element.addEventListener('touchend', () => clearTimeout(longPressTimer));
    element.addEventListener('touchmove', () => clearTimeout(longPressTimer));
}

function showCatContextMenu(x, y, id) {
    if(!catContextMenu) return;
    contextCatId = id;
    catContextMenu.style.top = `${y}px`;
    catContextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) catContextMenu.style.left = `${x - 160}px`;
    catContextMenu.classList.remove('hidden');
}

function renameCategoryAction() {
    if(catContextMenu) catContextMenu.classList.add('hidden');
    const cat = allCategories.find(c => c.id === contextCatId);
    if (!cat) return;
    const newName = prompt(`'${cat.name}'의 새로운 이름:`, cat.name);
    if (newName && newName.trim() !== "") {
        cat.name = newName.trim();
        saveCategories();
        renderTabs();
    }
}

function deleteCategoryAction() {
    if(catContextMenu) catContextMenu.classList.add('hidden');
    const cat = allCategories.find(c => c.id === contextCatId);
    if (!cat) return;
    if (allCategories.length <= 1) return alert("최소 하나의 주제는 있어야 합니다.");
    if (confirm(`'${cat.name}' 주제를 삭제하시겠습니까?`)) {
        allCategories = allCategories.filter(c => c.id !== contextCatId);
        categoryOrder = categoryOrder.filter(id => id !== contextCatId);
        if (currentCategory === contextCatId) currentCategory = allCategories[0].id;
        saveCategories();
        renderTabs();
        renderEntries();
    }
}

function saveCategories() {
    localStorage.setItem('faithCategories', JSON.stringify(allCategories));
    localStorage.setItem('faithCatOrder', JSON.stringify(categoryOrder));
}

window.addNewCategory = () => {
    const name = prompt("새 주제 이름");
    if (name) {
        const id = 'custom_' + Date.now();
        allCategories.push({id, name});
        categoryOrder.push(id);
        saveCategories();
        renderTabs();
    }
};

function attachContextMenu(element, entryId) {
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, entryId);
    });
    element.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showContextMenu(touch.clientX, touch.clientY, entryId);
        }, 600);
    }, { passive: true });
    element.addEventListener('touchend', () => clearTimeout(longPressTimer));
    element.addEventListener('touchmove', () => clearTimeout(longPressTimer));
}

function showContextMenu(x, y, id) {
    if(!contextMenu) return;
    contextTargetId = id;
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    const lockBtn = document.getElementById('ctx-lock');
    if(lockBtn) lockBtn.innerHTML = entry.isLocked ? '<i class="ph ph-lock-open"></i> 잠금 해제' : '<i class="ph ph-lock"></i> 잠그기';
    contextMenu.style.top = `${y}px`;
    contextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) contextMenu.style.left = `${x - 160}px`;
    if (y + 160 > window.innerHeight) contextMenu.style.top = `${y - 160}px`;
    contextMenu.classList.remove('hidden');
}

function openMoveModal() {
    if(!contextMenu || !moveModal) return;
    contextMenu.classList.add('hidden');
    moveModal.classList.remove('hidden');
    moveCategoryList.innerHTML = '';
    allCategories.forEach(cat => {
        const div = document.createElement('div');
        div.className = `cat-select-item ${currentCategory === cat.id ? 'current' : ''}`;
        div.innerText = cat.name;
        if (currentCategory !== cat.id) {
            div.onclick = async () => {
                await updateEntryField(contextTargetId, { category: cat.id });
                moveModal.classList.add('hidden');
                renderEntries();
            };
        }
        moveCategoryList.appendChild(div);
    });
}

function openLockModal() {
    if(!contextMenu || !lockModal) return;
    contextMenu.classList.add('hidden');
    const entry = entries.find(e => e.id === contextTargetId);
    if (!entry) return;
    if (entry.isLocked) {
        lockModalTitle.innerText = "잠금 해제";
        lockModalDesc.innerText = "비밀번호를 입력하여 잠금을 해제합니다.";
    } else {
        lockModalTitle.innerText = "비밀번호 설정";
        lockModalDesc.innerText = "이 글을 열 때 사용할 비밀번호를 입력하세요.";
    }
    lockPwInput.value = '';
    lockModal.classList.remove('hidden');
    lockPwInput.focus();
}

async function confirmLock() {
    const pw = lockPwInput.value;
    const entry = entries.find(e => e.id === contextTargetId);
    if (!entry || !pw) return alert("비밀번호를 입력해주세요.");
    if (entry.isLocked) {
        if (entry.lockPassword === pw) {
            await updateEntryField(contextTargetId, { isLocked: false, lockPassword: null });
            alert("잠금이 해제되었습니다.");
            lockModal.classList.add('hidden');
            renderEntries();
        } else { alert("비밀번호가 일치하지 않습니다."); }
    } else {
        await updateEntryField(contextTargetId, { isLocked: true, lockPassword: pw });
        alert("글이 잠겼습니다.");
        lockModal.classList.add('hidden');
        renderEntries();
    }
}

async function duplicateEntry() {
    if(contextMenu) contextMenu.classList.add('hidden');
    const entry = entries.find(e => e.id === contextTargetId);
    if (!entry) return;
    const newEntry = { ...entry };
    delete newEntry.id;
    newEntry.title = `${entry.title} (복사본)`;
    newEntry.timestamp = Date.now();
    newEntry.modifiedAt = Date.now();
    newEntry.date = new Date().toLocaleDateString('ko-KR');
    try {
        if (currentUser) {
            await addDoc(collection(db, "users", currentUser.uid, "entries"), newEntry);
            await loadDataFromFirestore();
        } else {
            newEntry.id = 'copy_' + Date.now();
            entries.unshift(newEntry);
            localStorage.setItem('faithLogDB', JSON.stringify(entries));
        }
        renderEntries();
    } catch(e) { console.error(e); alert("복사 실패"); }
}

async function updateEntryField(id, data) {
    if (currentUser) {
        await updateDoc(doc(db, "users", currentUser.uid, "entries", id), data);
        await loadDataFromFirestore();
    } else {
        const index = entries.findIndex(e => e.id === id);
        if (index !== -1) {
            entries[index] = { ...entries[index], ...data };
            localStorage.setItem('faithLogDB', JSON.stringify(entries));
        }
    }
}

function loadDataFromLocal() { entries = JSON.parse(localStorage.getItem('faithLogDB')) || []; }

async function loadDataFromFirestore() { 
    if(!currentUser) return; 
    const newEntries = []; 
    const q = query(collection(db, "users", currentUser.uid, "entries")); 
    try { 
        const querySnapshot = await getDocs(q); 
        querySnapshot.forEach((doc) => { newEntries.push({ id: doc.id, ...doc.data() }); }); 
        entries = newEntries; 
    } catch (e) { console.error(e); } 
}

async function saveEntry() { 
    const title = editTitle.value.trim(); 
    const body = autoLink(editBody.innerHTML);
    
    if(!title || !body || body === '<br>') return; 
    
    const now = Date.now(); 
    const entryData = { 
        category: currentCategory, 
        title, 
        subtitle: editSubtitle.value.trim(), 
        body, 
        fontFamily: currentFontFamily, 
        fontSize: currentFontSize, 
        date: new Date().toLocaleDateString('ko-KR'), 
        timestamp: now, 
        modifiedAt: now, 
        isDeleted: false 
    }; 
    
    try { 
        if(currentUser) { 
            if(isEditMode && editingId) { 
                const docRef = doc(db, "users", currentUser.uid, "entries", editingId); 
                const updateData = { ...entryData }; 
                delete updateData.timestamp; 
                await updateDoc(docRef, updateData); 
            } else { 
                const docRef = await addDoc(collection(db, "users", currentUser.uid, "entries"), entryData); 
                isEditMode = true;
                editingId = docRef.id;
            } 
            await loadDataFromFirestore(); 
        } else { 
            entryData.id = isEditMode ? editingId : now; 
            if (isEditMode) { 
                const index = entries.findIndex(e => e.id === editingId); 
                if (index !== -1) { 
                    entries[index] = { ...entries[index], ...entryData, timestamp: entries[index].timestamp, modifiedAt: now }; 
                } 
            } else { 
                entries.unshift(entryData); 
                isEditMode = true;
                editingId = entryData.id;
            } 
            localStorage.setItem('faithLogDB', JSON.stringify(entries)); 
        } 
    } catch(e) { console.error("Save Error:", e); } 
}

async function moveToTrash(id) { 
    if(!confirm('휴지통으로 이동하시겠습니까?')) return; 
    const now = Date.now();
    if(currentUser){ 
        const docRef = doc(db, "users", currentUser.uid, "entries", id); 
        await updateDoc(docRef, { isDeleted: true, deletedAt: now }); 
        await loadDataFromFirestore(); 
    } else { 
        const index = entries.findIndex(e => e.id === id); 
        if(index !== -1) {
            entries[index].isDeleted = true;
            entries[index].deletedAt = now;
            localStorage.setItem('faithLogDB', JSON.stringify(entries)); 
        }
    } 
    renderEntries(); 
} 

window.permanentDelete = async (id) => { 
    if(!confirm('영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return; 
    if(currentUser){ await deleteDoc(doc(db, "users", currentUser.uid, "entries", id)); await loadDataFromFirestore(); } else { entries = entries.filter(e => e.id !== id); localStorage.setItem('faithLogDB', JSON.stringify(entries)); } 
    renderTrash(); 
    renderEntries(); 
}

window.restoreEntry = async (id) => { if(!confirm('이 글을 복구하시겠습니까?')) return; if(currentUser){ const docRef = doc(db, "users", currentUser.uid, "entries", id); await updateDoc(docRef, { isDeleted: false }); await loadDataFromFirestore(); } else { const index = entries.findIndex(e => e.id === id); if(index !== -1) entries[index].isDeleted = false; localStorage.setItem('faithLogDB', JSON.stringify(entries)); } renderTrash(); renderEntries(); }

async function emptyTrash() {
    if(!confirm('휴지통을 비우시겠습니까? 모든 글이 영구 삭제됩니다.')) return;
    const deletedEntries = entries.filter(e => e.isDeleted);
    
    if (!currentUser) {
        entries = entries.filter(e => !e.isDeleted);
        localStorage.setItem('faithLogDB', JSON.stringify(entries));
        renderTrash();
        renderEntries();
        return;
    }
    
    for (const entry of deletedEntries) {
        await deleteDoc(doc(db, "users", currentUser.uid, "entries", entry.id));
    }
    await loadDataFromFirestore();
    renderTrash();
    renderEntries();
}

async function checkOldTrash() {
    const now = Date.now();
    const thirtyDays = 1000 * 60 * 60 * 24 * 30; 
    
    const toDelete = entries.filter(e => e.isDeleted && e.deletedAt && (now - e.deletedAt > thirtyDays));

    if(toDelete.length > 0) {
        if(currentUser) {
            for (const entry of toDelete) {
                await deleteDoc(doc(db, "users", currentUser.uid, "entries", entry.id));
            }
            await loadDataFromFirestore();
        } else {
            entries = entries.filter(e => !(e.isDeleted && e.deletedAt && (now - e.deletedAt > thirtyDays)));
            localStorage.setItem('faithLogDB', JSON.stringify(entries));
        }
        renderEntries();
    }
}

function renderTrash() { 
    trashList.innerHTML = `<div style="padding:10px 0; text-align:center; font-size:12px; color:#9CA3AF; font-family:'Pretendard'; margin-bottom:10px;">휴지통에 보관된 글은 30일 후 자동 삭제됩니다.</div>`;
    const deleted = entries.filter(e => e.isDeleted); 
    if(deleted.length === 0) { 
        trashList.innerHTML += `<div style="text-align:center; margin-top:50px; color:#aaa; font-family:'Pretendard';">비어있음</div>`; 
        return; 
    } 
    deleted.forEach(entry => { 
        const div = document.createElement('div'); 
        div.className = 'trash-item'; 
        div.innerHTML = `
            <div class="trash-info">
                <h4>${entry.title}</h4>
                <p>${entry.date}</p>
            </div>
            <div class="trash-btn-group">
                <button class="btn-restore" onclick="restoreEntry('${entry.id}')">복구</button>
                <button class="btn-perm-delete" onclick="permanentDelete('${entry.id}')">삭제</button>
            </div>
        `; 
        trashList.appendChild(div); 
    }); 
}
function openTrashModal() { renderTrash(); openModal(trashModal); }


if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }