import { state, saveCategoriesToLocal, getCategorySort } from './state.js';
import { updateEntryField, bulkUpdateEntryField, emptyTrash, saveEntry, restoreEntry, permanentDelete } from './data.js';
import { openEditor, toggleViewMode, applyFontStyle, turnPage, formatDoc, changeGlobalFontSize, insertSticker, insertImage } from './editor.js';
import { saveToDrive, syncFromDrive } from './drive.js'; 

const getEl = (id) => document.getElementById(id);

function stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || '';
}

export function applyCategorySort() {
    const sort = getCategorySort(state.currentCategory);
    state.currentSortBy = sort.sortBy;
    state.currentSortOrder = sort.sortOrder;
    const select = getEl('sort-criteria');
    if (select) select.value = sort.sortBy;
    const icon = getEl('sort-icon');
    if (icon) icon.className = sort.sortOrder === 'desc' ? 'ph ph-sort-descending' : 'ph ph-sort-ascending';
}

export function renderEntries(keyword = '') {
    const entryList = getEl('entry-list');
    if(!entryList) return;
    entryList.innerHTML = '';
    
    if(state.isLoading) {
        entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:var(--gray-400); font-family:'Pretendard';">로딩 중...</div>`;
        return;
    }

    const filtered = state.entries.filter(entry => 
        !entry.isPurged && 
        !entry.isDeleted && 
        entry.category === state.currentCategory && 
        (entry.title.includes(keyword) || stripHtml(entry.body).includes(keyword))
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

    if (filtered.length === 0) { entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:var(--gray-400); font-family:'Pretendard';">기록이 없습니다.</div>`; return; }
    
    filtered.forEach(entry => {
        const div = document.createElement('article');
        div.className = 'entry-card';
        if (state.isSelectMode && state.selectedEntries.includes(entry.id)) {
            div.classList.add('selected');
        }
        const dateStr = state.currentSortBy === 'modified'
            ? `수정: ${new Date(entry.modifiedAt || entry.timestamp).toLocaleDateString()}`
            : entry.date;

        const checkboxHtml = state.isSelectMode
            ? `<div class="entry-checkbox ${state.selectedEntries.includes(entry.id) ? 'checked' : ''}"><i class="ph ph-check"></i></div>`
            : '';
        div.innerHTML = `${checkboxHtml}<div class="entry-card-content"><h3 class="card-title">${entry.title}</h3>${entry.subtitle ? `<p class="card-subtitle">${entry.subtitle}</p>` : ''}<div class="card-meta"><span>${dateStr}</span></div></div>`;

        if (state.isSelectMode) {
            div.onclick = () => toggleEntrySelection(entry.id);
        } else {
            div.onclick = () => {
                openEditor(true, entry);
                toggleViewMode('readOnly');
                if (window.gapi && gapi.client && gapi.client.getToken()) {
                    syncFromDrive();
                }
            };
        }

        if (!state.isSelectMode) {
            attachContextMenu(div, entry.id);
        }
        entryList.appendChild(div);
    });
}

export function renderTabs() {
    const tabContainer = getEl('tab-container');
    if(!tabContainer) return;
    tabContainer.innerHTML = '';
    
    const allSorted = [];
    state.categoryOrder.forEach(id => { const found = state.allCategories.find(c => c.id === id); if(found) allSorted.push(found); });
    state.allCategories.forEach(c => { if(!state.categoryOrder.includes(c.id)) { allSorted.push(c); state.categoryOrder.push(c.id); } });

    const sortedCats = state.currentFolder === null
        ? allSorted
        : allSorted.filter(c => c.folderId === state.currentFolder);

    const currentExists = sortedCats.find(c => c.id === state.currentCategory);
    if (!currentExists && sortedCats.length > 0) {
        state.currentCategory = sortedCats[0].id;
        applyCategorySort();
    }

    if (sortedCats.length === 0) {
        tabContainer.innerHTML = `<span style="font-size:13px; color:var(--gray-400); font-family:'Pretendard'; padding:8px 4px;">이 폴더에 주제가 없습니다.</span>`;
        const addBtn2 = document.createElement('button');
        addBtn2.className = 'add-cat-btn';
        addBtn2.innerHTML = '<i class="ph ph-plus"></i>';
        addBtn2.onclick = addNewCategory;
        tabContainer.appendChild(addBtn2);
        return;
    }

    sortedCats.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `tab-btn ${state.currentCategory === cat.id ? 'active' : ''}`;
        btn.dataset.id = cat.id; 
        btn.innerHTML = `<span>${cat.name}</span>`;
        btn.onclick = () => {
            state.currentCategory = cat.id;
            applyCategorySort();
            if (state.isSelectMode) exitSelectMode();
            renderTabs();
            renderEntries();
        };
        attachCatContextMenu(btn, cat.id);
        tabContainer.appendChild(btn);
    });
    
    const addBtn = document.createElement('button');
    addBtn.className = 'add-cat-btn';
    addBtn.innerHTML = '<i class="ph ph-plus"></i>';
    addBtn.onclick = addNewCategory;
    tabContainer.appendChild(addBtn);
}

export function renderTrash() {
    const trashList = getEl('trash-list');
    if (!trashList) return;
    trashList.innerHTML = `<div style="padding:10px 0; text-align:center; font-size:12px; color:var(--gray-400); font-family:'Pretendard'; margin-bottom:10px;">휴지통에 보관된 글은 30일 후 자동 삭제됩니다.</div>`;
    const deleted = state.entries.filter(e => e.isDeleted && !e.isPurged); 
    if(deleted.length === 0) { 
        trashList.innerHTML += `<div style="text-align:center; margin-top:50px; color:var(--gray-400); font-family:'Pretendard';">비어있음</div>`; 
        return; 
    } 
    deleted.forEach(entry => { 
        const div = document.createElement('div'); div.className = 'trash-item'; 
        div.innerHTML = `<div class="trash-info"><h4>${entry.title}</h4><p>${entry.date}</p></div><div class="trash-btn-group"></div>`;
        const btnGroup = div.querySelector('.trash-btn-group');
        const btnRestore = document.createElement('button'); btnRestore.className = 'btn-restore'; btnRestore.innerText = '복구';
        btnRestore.onclick = (e) => { e.stopPropagation(); restoreEntry(entry.id); };
        const btnDelete = document.createElement('button'); btnDelete.className = 'btn-perm-delete'; btnDelete.innerText = '삭제';
        btnDelete.onclick = (e) => { e.stopPropagation(); permanentDelete(entry.id); };
        btnGroup.appendChild(btnRestore); btnGroup.appendChild(btnDelete);
        trashList.appendChild(div); 
    }); 
}

export function closeAllModals(goBack = true) {
    const ids = ['write-modal', 'trash-modal', 'login-modal', 'move-modal', 'folder-assign-modal'];
    ids.forEach(id => {
        const el = getEl(id);
        if(el) el.classList.add('hidden');
    });

    toggleViewMode('default'); 
    
    if(goBack && history.state && history.state.modal === 'open') {
        history.back();
    }
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
    element.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, entryId); };
    element.addEventListener('touchstart', (e) => {
        state.longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showContextMenu(touch.clientX, touch.clientY, entryId);
        }, 600);
    }, { passive: true });
    element.ontouchend = () => clearTimeout(state.longPressTimer);
}

function showContextMenu(x, y, id) {
    const contextMenu = getEl('context-menu');
    if(!contextMenu) return;
    getEl('category-context-menu')?.classList.add('hidden');
    state.contextTargetId = id;
    contextMenu.style.top = `${y}px`;
    contextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) contextMenu.style.left = `${window.innerWidth - 170}px`;
    contextMenu.classList.remove('hidden');
}

function attachCatContextMenu(element, catId) {
    element.oncontextmenu = (e) => { e.preventDefault(); showCatContextMenu(e.clientX, e.clientY, catId); };
    element.addEventListener('touchstart', (e) => {
        state.longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showCatContextMenu(touch.clientX, touch.clientY, catId);
        }, 600);
    }, { passive: true });
    element.ontouchend = () => clearTimeout(state.longPressTimer);
}

function showCatContextMenu(x, y, id) {
    const catContextMenu = getEl('category-context-menu');
    if(!catContextMenu) return;
    getEl('context-menu')?.classList.add('hidden');
    state.contextCatId = id;
    catContextMenu.style.top = `${y}px`;
    catContextMenu.style.left = `${x}px`;
    catContextMenu.classList.remove('hidden');
}

export function renderFolders() {
    const row = getEl('folder-row');
    if (!row) return;
    row.innerHTML = '';

    if (state.allFolders.length === 0) {
        const addBtn = document.createElement('button');
        addBtn.className = 'add-folder-btn';
        addBtn.innerHTML = '<i class="ph ph-folder-plus"></i> 폴더 추가';
        addBtn.title = '폴더 추가';
        addBtn.onclick = addNewFolder;
        row.appendChild(addBtn);
        return;
    }

    const allBtn = document.createElement('button');
    allBtn.className = `folder-tab ${state.currentFolder === null ? 'active' : ''}`;
    allBtn.textContent = '전체';
    allBtn.onclick = () => {
        state.currentFolder = null;
        renderFolders();
        renderTabs();
        renderEntries();
    };
    row.appendChild(allBtn);

    const sortedFolders = [];
    state.folderOrder.forEach(id => { const f = state.allFolders.find(f => f.id === id); if (f) sortedFolders.push(f); });
    state.allFolders.forEach(f => { if (!state.folderOrder.includes(f.id)) sortedFolders.push(f); });

    sortedFolders.forEach(folder => {
        const btn = document.createElement('button');
        btn.className = `folder-tab ${state.currentFolder === folder.id ? 'active' : ''}`;
        btn.dataset.folderId = folder.id;
        btn.innerHTML = `<i class="ph ph-folder-simple"></i> ${folder.name}`;
        btn.onclick = () => {
            state.currentFolder = folder.id;
            const catsInFolder = state.allCategories.filter(c => c.folderId === folder.id);
            if (catsInFolder.length > 0 && !catsInFolder.find(c => c.id === state.currentCategory)) {
                state.currentCategory = catsInFolder[0].id;
                applyCategorySort();
            }
            if (state.isSelectMode) exitSelectMode();
            renderFolders();
            renderTabs();
            renderEntries();
        };
        attachFolderContextMenu(btn, folder.id);
        row.appendChild(btn);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'add-folder-btn';
    addBtn.innerHTML = '<i class="ph ph-folder-plus"></i>';
    addBtn.title = '폴더 추가';
    addBtn.onclick = addNewFolder;
    row.appendChild(addBtn);
}

function attachFolderContextMenu(element, folderId) {
    element.oncontextmenu = (e) => { e.preventDefault(); showFolderContextMenu(e.clientX, e.clientY, folderId); };
    element.addEventListener('touchstart', (e) => {
        state.longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showFolderContextMenu(touch.clientX, touch.clientY, folderId);
        }, 600);
    }, { passive: true });
    element.ontouchend = () => clearTimeout(state.longPressTimer);
}

function showFolderContextMenu(x, y, folderId) {
    const menu = getEl('folder-context-menu');
    if (!menu) return;
    getEl('context-menu')?.classList.add('hidden');
    getEl('category-context-menu')?.classList.add('hidden');
    state.contextFolderId = folderId;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) menu.style.left = `${window.innerWidth - 170}px`;
    menu.classList.remove('hidden');
}

export function addNewFolder() {
    const name = prompt("새 폴더 이름");
    if (name && name.trim()) {
        const id = 'folder_' + Date.now();
        state.allFolders.push({ id, name: name.trim() });
        state.folderOrder.push(id);
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal(); renderFolders(); saveToDrive();
    }
}

export function renameFolderAction() {
    getEl('folder-context-menu')?.classList.add('hidden');
    const folder = state.allFolders.find(f => f.id === state.contextFolderId);
    if (!folder) return;
    const newName = prompt(`'${folder.name}'의 새 이름:`, folder.name);
    if (newName && newName.trim()) {
        folder.name = newName.trim();
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal(); renderFolders(); saveToDrive();
    }
}

export function deleteFolderAction() {
    getEl('folder-context-menu')?.classList.add('hidden');
    const folder = state.allFolders.find(f => f.id === state.contextFolderId);
    if (!folder) return;
    if (confirm(`'${folder.name}' 폴더를 삭제하시겠습니까?\n(소속된 주제는 폴더 없음 상태가 됩니다)`)) {
        state.allCategories.forEach(c => { if (c.folderId === state.contextFolderId) delete c.folderId; });
        state.allFolders = state.allFolders.filter(f => f.id !== state.contextFolderId);
        state.folderOrder = state.folderOrder.filter(id => id !== state.contextFolderId);
        if (state.currentFolder === state.contextFolderId) state.currentFolder = null;
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
    }
}

export function openFolderAssignModal() {
    getEl('category-context-menu')?.classList.add('hidden');
    const modal = getEl('folder-assign-modal');
    const list = getEl('folder-assign-list');
    if (!modal || !list) return;
    list.innerHTML = '';

    const noneDiv = document.createElement('div');
    noneDiv.className = 'cat-select-item';
    noneDiv.textContent = '없음 (폴더 없음)';
    noneDiv.onclick = () => {
        const cat = state.allCategories.find(c => c.id === state.contextCatId);
        if (cat) { delete cat.folderId; state.categoryUpdatedAt = new Date().toISOString(); saveCategoriesToLocal(); renderFolders(); renderTabs(); saveToDrive(); }
        modal.classList.add('hidden');
    };
    list.appendChild(noneDiv);

    const sortedFolders = [];
    state.folderOrder.forEach(id => { const f = state.allFolders.find(f => f.id === id); if (f) sortedFolders.push(f); });
    state.allFolders.forEach(f => { if (!state.folderOrder.includes(f.id)) sortedFolders.push(f); });

    sortedFolders.forEach(folder => {
        const div = document.createElement('div');
        div.className = 'cat-select-item';
        div.innerHTML = `<i class="ph ph-folder-simple"></i> ${folder.name}`;
        div.onclick = () => {
            const cat = state.allCategories.find(c => c.id === state.contextCatId);
            if (cat) { cat.folderId = folder.id; state.categoryUpdatedAt = new Date().toISOString(); saveCategoriesToLocal(); renderFolders(); renderTabs(); saveToDrive(); }
            modal.classList.add('hidden');
        };
        list.appendChild(div);
    });

    openModal(modal);
}

export function addNewCategory() {
    const name = prompt("새 주제 이름");
    if (name) {
        const id = 'custom_' + Date.now();
        const cat = { id, name };
        if (state.currentFolder !== null) cat.folderId = state.currentFolder;
        state.allCategories.push(cat);
        state.categoryOrder.push(id);
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal(); renderTabs(); saveToDrive();
    }
}

export function renameCategoryAction() {
    getEl('category-context-menu')?.classList.add('hidden');
    const cat = state.allCategories.find(c => c.id === state.contextCatId);
    if (!cat) return;
    const newName = prompt(`'${cat.name}'의 새로운 이름:`, cat.name);
    if (newName && newName.trim() !== "") {
        cat.name = newName.trim();
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal(); renderTabs(); saveToDrive(); 
    }
}

export function deleteCategoryAction() {
    getEl('category-context-menu')?.classList.add('hidden');
    const cat = state.allCategories.find(c => c.id === state.contextCatId);
    if (!cat || state.allCategories.length <= 1) return;
    if (confirm(`'${cat.name}' 주제를 삭제하시겠습니까?\n(소속된 글은 첫 번째 주제로 이동됩니다)`)) {
        state.allCategories = state.allCategories.filter(c => c.id !== state.contextCatId);
        state.categoryOrder = state.categoryOrder.filter(id => id !== state.contextCatId);
        const newCatId = state.allCategories[0].id;
        // 삭제된 카테고리에 속한 글을 첫 번째 카테고리로 이동
        state.entries.forEach(e => { if (e.category === state.contextCatId) e.category = newCatId; });
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        if (state.currentCategory === state.contextCatId) { state.currentCategory = newCatId; applyCategorySort(); }
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
    }
}

export async function renameEntryAction() {
    getEl('context-menu')?.classList.add('hidden');
    const entry = state.entries.find(e => e.id === state.contextTargetId);
    if (!entry) return;
    const newTitle = prompt(`새로운 제목:`, entry.title || '');
    if (newTitle !== null && newTitle.trim() !== "") {
        await updateEntryField(state.contextTargetId, { title: newTitle.trim() });
    }
}

export function openMoveModal() {
    getEl('context-menu')?.classList.add('hidden');
    const moveModal = getEl('move-modal');
    const moveCategoryList = getEl('move-category-list');
    const moveTitle = getEl('move-modal-title');
    openModal(moveModal);
    moveCategoryList.innerHTML = '';

    const isBulk = state.isSelectMode && state.selectedEntries.length > 0;
    if (moveTitle) {
        moveTitle.textContent = isBulk ? `주제 이동 (${state.selectedEntries.length}개 선택)` : '주제 이동';
    }

    const sortedCats = [];
    state.categoryOrder.forEach(id => { const found = state.allCategories.find(c => c.id === id); if(found) sortedCats.push(found); });
    state.allCategories.forEach(c => { if(!state.categoryOrder.includes(c.id)) sortedCats.push(c); });

    sortedCats.forEach(cat => {
        const div = document.createElement('div');
        div.className = `cat-select-item ${state.currentCategory === cat.id ? 'current' : ''}`;
        div.innerText = cat.name;
        if (state.currentCategory !== cat.id) {
            div.onclick = async () => {
                if (isBulk) {
                    await bulkUpdateEntryField([...state.selectedEntries], { category: cat.id });
                    exitSelectMode();
                } else {
                    await updateEntryField(state.contextTargetId, { category: cat.id });
                }
                closeAllModals(true);
            };
        }
        moveCategoryList.appendChild(div);
    });
}

function toggleEntrySelection(id) {
    const idx = state.selectedEntries.indexOf(id);
    if (idx === -1) {
        state.selectedEntries.push(id);
    } else {
        state.selectedEntries.splice(idx, 1);
    }
    renderEntries();
    updateBulkBar();
}

export function toggleSelectMode() {
    state.isSelectMode = !state.isSelectMode;
    state.selectedEntries = [];
    const selectBtn = getEl('select-mode-btn');
    if (selectBtn) {
        selectBtn.classList.toggle('active', state.isSelectMode);
    }
    const bulkBar = getEl('bulk-action-bar');
    if (bulkBar) bulkBar.classList.toggle('hidden', !state.isSelectMode);
    const writeBtn = getEl('write-btn');
    if (writeBtn) writeBtn.classList.toggle('hidden', state.isSelectMode);
    updateBulkBar();
    renderEntries();
}

export function exitSelectMode() {
    state.isSelectMode = false;
    state.selectedEntries = [];
    const selectBtn = getEl('select-mode-btn');
    if (selectBtn) selectBtn.classList.remove('active');
    const bulkBar = getEl('bulk-action-bar');
    if (bulkBar) bulkBar.classList.add('hidden');
    const writeBtn = getEl('write-btn');
    if (writeBtn) writeBtn.classList.remove('hidden');
    renderEntries();
}

export function selectAllEntries() {
    const filtered = state.entries.filter(entry =>
        !entry.isPurged && !entry.isDeleted && entry.category === state.currentCategory
    );
    if (state.selectedEntries.length === filtered.length) {
        state.selectedEntries = [];
    } else {
        state.selectedEntries = filtered.map(e => e.id);
    }
    renderEntries();
    updateBulkBar();
}

function updateBulkBar() {
    const count = state.selectedEntries.length;
    const countEl = getEl('bulk-selected-count');
    if (countEl) countEl.textContent = `${count}개 선택`;
    const moveBtn = getEl('bulk-move-btn');
    if (moveBtn) moveBtn.disabled = count === 0;
}