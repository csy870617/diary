import { state, saveCategoriesToLocal } from './state.js';
import { updateEntryField, emptyTrash, saveEntry, restoreEntry, permanentDelete } from './data.js';
import { openEditor, toggleViewMode, applyFontStyle, turnPage, formatDoc, changeGlobalFontSize, insertSticker, insertImage } from './editor.js';
import { saveToDrive } from './drive.js';

const getEl = (id) => document.getElementById(id);
let tabSortable = null; // Sortable 인스턴스 관리용

export function renderEntries(keyword = '') {
    const entryList = getEl('entry-list');
    if(!entryList) return;
    entryList.innerHTML = '';
    
    if(state.isLoading) {
        entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">로딩 중...</div>`;
        return;
    }

    const filtered = state.entries.filter(entry => 
        !entry.isPurged && 
        !entry.isDeleted && 
        entry.category === state.currentCategory && 
        (entry.title.includes(keyword) || entry.body.includes(keyword))
    );
    
    filtered.sort((a, b) => { 
        if (state.currentSortBy === 'title') { 
            const valA = (a.title || '').toLowerCase();
            const valB = (b.title || '').toLowerCase();
            if (valA < valB) return state.currentSortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return state.currentSortOrder === 'asc' ? 1 : -1;
            return 0;
        } else {
            const timeA = new Date(state.currentSortBy === 'modified' ? (a.modifiedAt || a.timestamp) : a.timestamp).getTime() || 0;
            const timeB = new Date(state.currentSortBy === 'modified' ? (b.modifiedAt || b.timestamp) : b.timestamp).getTime() || 0;
            return state.currentSortOrder === 'asc' ? timeA - timeB : timeB - timeA;
        }
    });

    if (filtered.length === 0) { entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">기록이 없습니다.</div>`; return; }
    
    filtered.forEach(entry => {
        const div = document.createElement('article');
        div.className = 'entry-card';
        const dateStr = state.currentSortBy === 'modified' 
            ? `수정: ${new Date(entry.modifiedAt || entry.timestamp).toLocaleDateString()}` 
            : entry.date;
        div.innerHTML = `<h3 class="card-title">${entry.title}</h3>${entry.subtitle ? `<p class="card-subtitle">${entry.subtitle}</p>` : ''}<div class="card-meta"><span>${dateStr}</span></div>`;
        div.onclick = () => {
            openEditor(true, entry);
            toggleViewMode('readOnly');
        };
        attachContextMenu(div, entry.id);
        entryList.appendChild(div);
    });
}

export function renderTabs() {
    const tabContainer = getEl('tab-container');
    if(!tabContainer) return;
    
    // 기존 Sortable 인스턴스 정리 (중복 방지)
    if (tabSortable) {
        tabSortable.destroy();
        tabSortable = null;
    }

    tabContainer.innerHTML = '';
    
    // 순서 정렬 로직
    const sortedCats = [];
    state.categoryOrder.forEach(id => { const found = state.allCategories.find(c => c.id === id); if(found) sortedCats.push(found); });
    state.allCategories.forEach(c => { if(!state.categoryOrder.includes(c.id)) { sortedCats.push(c); state.categoryOrder.push(c.id); } });

    // 현재 선택된 카테고리가 없으면 첫 번째 선택
    const currentExists = sortedCats.find(c => c.id === state.currentCategory);
    if (!currentExists && sortedCats.length > 0) {
        state.currentCategory = sortedCats[0].id;
        setTimeout(() => renderEntries(), 0);
    }

    // 탭 버튼 생성
    sortedCats.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `tab-btn ${state.currentCategory === cat.id ? 'active' : ''}`;
        btn.dataset.id = cat.id; 
        btn.innerHTML = `<span>${cat.name}</span>`;
        
        // 클릭 시 탭 전환
        btn.onclick = (e) => { 
            // 드래그 중 클릭 방지
            if(btn.classList.contains('sortable-drag')) return;
            state.currentCategory = cat.id; 
            renderTabs(); 
            renderEntries(); 
        };
        
        attachCatContextMenu(btn, cat.id);
        tabContainer.appendChild(btn);
    });
    
    // 추가 버튼 (+)
    const addBtn = document.createElement('button');
    addBtn.className = 'add-cat-btn';
    addBtn.innerHTML = '<i class="ph ph-plus"></i>';
    addBtn.onclick = addNewCategory;
    tabContainer.appendChild(addBtn);

    // [핵심] 탭 드래그 앤 드롭 기능 적용
    if (typeof Sortable !== 'undefined') {
        tabSortable = new Sortable(tabContainer, {
            animation: 150,
            draggable: ".tab-btn", // 탭 버튼만 드래그 가능 (+버튼 제외)
            filter: ".add-cat-btn",
            onEnd: async function (evt) {
                // DOM 순서대로 ID 추출
                const newOrder = [];
                tabContainer.querySelectorAll('.tab-btn').forEach(btn => {
                    newOrder.push(btn.dataset.id);
                });

                // 순서가 실제로 바뀌었으면 저장 및 동기화
                if (JSON.stringify(state.categoryOrder) !== JSON.stringify(newOrder)) {
                    state.categoryOrder = newOrder;
                    
                    // [중요] 타임스탬프 갱신 (그래야 다른 기기가 이 변경사항을 받아들임)
                    state.categoryUpdatedAt = new Date().toISOString();
                    
                    saveCategoriesToLocal();
                    
                    // 클라우드 즉시 동기화
                    const refreshBtn = document.getElementById('refresh-btn');
                    if(refreshBtn) refreshBtn.classList.add('rotating');
                    await saveToDrive();
                    if(refreshBtn) refreshBtn.classList.remove('rotating');
                }
            }
        });
    }
}

export function renderTrash() { 
    const trashList = getEl('trash-list');
    trashList.innerHTML = `<div style="padding:10px 0; text-align:center; font-size:12px; color:#9CA3AF; font-family:'Pretendard'; margin-bottom:10px;">휴지통에 보관된 글은 30일 후 자동 삭제됩니다.</div>`;
    
    const deleted = state.entries.filter(e => e.isDeleted && !e.isPurged); 
    
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
            <div class="trash-btn-group"></div>
        `;
        
        const btnGroup = div.querySelector('.trash-btn-group');
        const btnRestore = document.createElement('button');
        btnRestore.className = 'btn-restore';
        btnRestore.innerText = '복구';
        btnRestore.addEventListener('click', (e) => {
            e.stopPropagation();
            restoreEntry(entry.id);
        });
        
        const btnDelete = document.createElement('button');
        btnDelete.className = 'btn-perm-delete';
        btnDelete.innerText = '삭제';
        btnDelete.addEventListener('click', (e) => {
            e.stopPropagation();
            permanentDelete(entry.id);
        });
        
        btnGroup.appendChild(btnRestore);
        btnGroup.appendChild(btnDelete);
        trashList.appendChild(div); 
    }); 
}

export function closeAllModals(goBack = true) {
    const ids = ['write-modal', 'trash-modal', 'login-modal', 'reset-pw-modal', 'sticker-palette', 'color-palette-popup', 'context-menu', 'category-context-menu', 'move-modal'];
    ids.forEach(id => {
        const el = getEl(id);
        if(el) el.classList.add('hidden');
    });

    toggleViewMode('default'); 
    
    const editorToolbar = getEl('editor-toolbar');
    const toolbarToggleBtn = getEl('toolbar-toggle-btn');
    if(editorToolbar) {
        editorToolbar.classList.remove('collapsed');
        const icon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
        if(icon) {
            icon.classList.remove('ph-caret-down');
            icon.classList.add('ph-caret-up');
        }
    }
    
    if(goBack && history.state && history.state.modal === 'open') history.back();
    renderEntries();
}

export function openModal(modal) {
    if(!modal) return;
    if (!history.state || history.state.modal !== 'open') {
        history.pushState({ modal: 'open' }, null, '');
    }
    modal.classList.remove('hidden');
}

export function openTrashModal() { 
    renderTrash(); 
    openModal(getEl('trash-modal')); 
}

function attachContextMenu(element, entryId) {
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, entryId);
    });
    element.addEventListener('touchstart', (e) => {
        state.longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showContextMenu(touch.clientX, touch.clientY, entryId);
        }, 600);
    }, { passive: true });
    element.addEventListener('touchend', () => clearTimeout(state.longPressTimer));
    element.addEventListener('touchmove', () => clearTimeout(state.longPressTimer));
}

function showContextMenu(x, y, id) {
    const contextMenu = getEl('context-menu');
    if(!contextMenu) return;
    const catContextMenu = getEl('category-context-menu');
    if(catContextMenu) catContextMenu.classList.add('hidden');
    state.contextTargetId = id;
    contextMenu.style.top = `${y}px`;
    contextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) contextMenu.style.left = `${window.innerWidth - 170}px`;
    if (y + 160 > window.innerHeight) contextMenu.style.top = `${y - 160}px`;
    contextMenu.classList.remove('hidden');
}

function attachCatContextMenu(element, catId) {
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCatContextMenu(e.clientX, e.clientY, catId);
    });
    element.addEventListener('touchstart', (e) => {
        state.longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showCatContextMenu(touch.clientX, touch.clientY, catId);
        }, 600);
    }, { passive: true });
    element.addEventListener('touchend', () => clearTimeout(state.longPressTimer));
    element.addEventListener('touchmove', () => clearTimeout(state.longPressTimer));
}

function showCatContextMenu(x, y, id) {
    const catContextMenu = getEl('category-context-menu');
    if(!catContextMenu) return;
    const contextMenu = getEl('context-menu');
    if(contextMenu) contextMenu.classList.add('hidden');
    state.contextCatId = id;
    catContextMenu.style.top = `${y}px`;
    catContextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) catContextMenu.style.left = `${window.innerWidth - 170}px`;
    catContextMenu.classList.remove('hidden');
}

function getNextTimestamp() {
    const now = new Date().getTime();
    const last = new Date(state.categoryUpdatedAt || 0).getTime();
    if (now <= last) { return new Date(last + 1000).toISOString(); }
    return new Date().toISOString();
}

export function addNewCategory() {
    const name = prompt("새 주제 이름");
    if (name) {
        const id = 'custom_' + Date.now();
        state.allCategories.push({id, name});
        state.categoryOrder.push(id);
        state.categoryUpdatedAt = getNextTimestamp();
        saveCategoriesToLocal();
        renderTabs();
        saveToDrive(); 
    }
}

export function renameCategoryAction() {
    const catContextMenu = getEl('category-context-menu');
    if(catContextMenu) catContextMenu.classList.add('hidden');
    const cat = state.allCategories.find(c => c.id === state.contextCatId);
    if (!cat) return;
    const newName = prompt(`'${cat.name}'의 새로운 이름:`, cat.name);
    if (newName && newName.trim() !== "") {
        cat.name = newName.trim();
        state.categoryUpdatedAt = getNextTimestamp();
        saveCategoriesToLocal();
        renderTabs();
        saveToDrive(); 
    }
}

export function deleteCategoryAction() {
    const catContextMenu = getEl('category-context-menu');
    if(catContextMenu) catContextMenu.classList.add('hidden');
    const cat = state.allCategories.find(c => c.id === state.contextCatId);
    if (!cat) return;
    if (state.allCategories.length <= 1) return alert("최소 하나의 주제는 있어야 합니다.");
    if (confirm(`'${cat.name}' 주제를 삭제하시겠습니까?`)) {
        state.allCategories = state.allCategories.filter(c => c.id !== state.contextCatId);
        state.categoryOrder = state.categoryOrder.filter(id => id !== state.contextCatId);
        if (state.currentCategory === state.contextCatId) state.currentCategory = state.allCategories[0].id;
        state.categoryUpdatedAt = getNextTimestamp();
        saveCategoriesToLocal();
        renderTabs();
        renderEntries();
        saveToDrive(); 
    }
}

export function openMoveModal() {
    const contextMenu = getEl('context-menu');
    const moveModal = getEl('move-modal');
    const moveCategoryList = getEl('move-category-list');
    if(!contextMenu || !moveModal) return;
    contextMenu.classList.add('hidden');
    moveModal.classList.remove('hidden');
    moveCategoryList.innerHTML = '';
    state.allCategories.forEach(cat => {
        const div = document.createElement('div');
        div.className = `cat-select-item ${state.currentCategory === cat.id ? 'current' : ''}`;
        div.innerText = cat.name;
        if (state.currentCategory !== cat.id) {
            div.onclick = async () => {
                await updateEntryField(state.contextTargetId, { category: cat.id });
                moveModal.classList.add('hidden');
                renderEntries();
            };
        }
        moveCategoryList.appendChild(div);
    });
}

// UI 리스너 설정
export function setupUIListeners() {
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
            openColorPalette(); 
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

export function openColorPalette() {
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