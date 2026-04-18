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
    state.categoryOrder.forEach(id => { const found = state.allCategories.find(c => c.id === id); if(found && !found.isDeleted) allSorted.push(found); });
    state.allCategories.forEach(c => { if(!c.isDeleted && !state.categoryOrder.includes(c.id)) { allSorted.push(c); state.categoryOrder.push(c.id); } });

    const sortedCats = state.currentFolder === null
        ? allSorted.filter(c => !c.folderId)
        : allSorted.filter(c => c.folderId === state.currentFolder);

    const currentExists = sortedCats.find(c => c.id === state.currentCategory);
    if (!currentExists && sortedCats.length > 0) {
        state.currentCategory = sortedCats[0].id;
        applyCategorySort();
    }

    if (sortedCats.length === 0) {
        const emptyMsg = state.currentFolder === null ? '주제가 없습니다.' : '이 폴더에 주제가 없습니다.';
        tabContainer.innerHTML = `<span style="font-size:13px; color:var(--gray-400); font-family:'Pretendard'; padding:8px 4px;">${emptyMsg}</span>`;
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
    trashList.innerHTML = `<div style="padding:10px 0; text-align:center; font-size:12px; color:var(--gray-400); font-family:'Pretendard'; margin-bottom:10px;">휴지통에 보관된 항목은 30일 후 자동 삭제됩니다.</div>`;

    const deletedFolders = state.allFolders.filter(f => f.isDeleted);
    const deletedCats = state.allCategories.filter(c => c.isDeleted);
    const deletedEntries = state.entries.filter(e => e.isDeleted && !e.isPurged);

    if (deletedFolders.length === 0 && deletedCats.length === 0 && deletedEntries.length === 0) {
        trashList.innerHTML += `<div style="text-align:center; margin-top:50px; color:var(--gray-400); font-family:'Pretendard';">비어있음</div>`;
        return;
    }

    const makeButtons = (onRestore, onDelete) => {
        const group = document.createElement('div');
        group.className = 'trash-btn-group';
        const r = document.createElement('button'); r.className = 'btn-restore'; r.innerText = '복구';
        r.onclick = (e) => { e.stopPropagation(); onRestore(); };
        const d = document.createElement('button'); d.className = 'btn-perm-delete'; d.innerText = '삭제';
        d.onclick = (e) => { e.stopPropagation(); onDelete(); };
        group.appendChild(r); group.appendChild(d);
        return group;
    };

    const addSection = (title, items, buildItem) => {
        if (items.length === 0) return;
        const header = document.createElement('h4');
        header.className = 'trash-section-title';
        header.textContent = title;
        trashList.appendChild(header);
        items.forEach(it => trashList.appendChild(buildItem(it)));
    };

    addSection('폴더', deletedFolders, (folder) => {
        const div = document.createElement('div'); div.className = 'trash-item';
        const dateStr = folder.deletedAt ? new Date(folder.deletedAt).toLocaleDateString() : '';
        div.innerHTML = `<div class="trash-info"><h4><i class="ph ph-folder-simple"></i> ${folder.name}</h4>${dateStr ? `<p>${dateStr} 삭제</p>` : ''}</div>`;
        div.appendChild(makeButtons(() => restoreFolder(folder.id), () => permanentDeleteFolder(folder.id)));
        return div;
    });

    addSection('주제', deletedCats, (cat) => {
        const div = document.createElement('div'); div.className = 'trash-item';
        const dateStr = cat.deletedAt ? new Date(cat.deletedAt).toLocaleDateString() : '';
        div.innerHTML = `<div class="trash-info"><h4><i class="ph ph-tag"></i> ${cat.name}</h4>${dateStr ? `<p>${dateStr} 삭제</p>` : ''}</div>`;
        div.appendChild(makeButtons(() => restoreCategory(cat.id), () => permanentDeleteCategory(cat.id)));
        return div;
    });

    addSection('글', deletedEntries, (entry) => {
        const div = document.createElement('div'); div.className = 'trash-item';
        div.innerHTML = `<div class="trash-info"><h4>${entry.title}</h4><p>${entry.date}</p></div>`;
        div.appendChild(makeButtons(() => restoreEntry(entry.id), () => permanentDelete(entry.id)));
        return div;
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

    if (state.currentFolder !== null) {
        const cur = state.allFolders.find(f => f.id === state.currentFolder);
        if (!cur || cur.isDeleted) state.currentFolder = null;
    }

    const sortedFolders = [];
    state.folderOrder.forEach(id => { const f = state.allFolders.find(f => f.id === id); if (f && !f.isDeleted) sortedFolders.push(f); });
    state.allFolders.forEach(f => { if (!f.isDeleted && !state.folderOrder.includes(f.id)) sortedFolders.push(f); });

    const visibleFolders = sortedFolders.filter(f => (f.parentFolderId || null) === state.currentFolder);
    const liveFoldersExist = state.allFolders.some(f => !f.isDeleted);

    if (state.currentFolder === null && !liveFoldersExist) {
        row.classList.add('hidden');
        return;
    }
    row.classList.remove('hidden');

    if (state.currentFolder !== null) {
        const currentFolderObj = state.allFolders.find(f => f.id === state.currentFolder);
        const parentId = currentFolderObj && currentFolderObj.parentFolderId ? currentFolderObj.parentFolderId : null;
        const parentName = parentId ? (state.allFolders.find(f => f.id === parentId)?.name || '뒤로') : '홈';

        const backBtn = document.createElement('button');
        backBtn.className = 'folder-tab folder-back-btn';
        backBtn.innerHTML = `<i class="ph ph-caret-left"></i> ${parentName}`;
        backBtn.onclick = () => {
            state.currentFolder = parentId;
            const validCats = state.allCategories.filter(c => (c.folderId || null) === parentId);
            if (validCats.length > 0 && !validCats.find(c => c.id === state.currentCategory)) {
                state.currentCategory = validCats[0].id;
                applyCategorySort();
            }
            if (state.isSelectMode) exitSelectMode();
            renderFolders();
            renderTabs();
            renderEntries();
        };
        row.appendChild(backBtn);

        if (currentFolderObj) {
            const currentBtn = document.createElement('button');
            currentBtn.className = 'folder-tab folder-current active';
            currentBtn.dataset.folderId = currentFolderObj.id;
            currentBtn.innerHTML = `<i class="ph ph-folder-open"></i> ${currentFolderObj.name}`;
            attachFolderContextMenu(currentBtn, currentFolderObj.id);
            row.appendChild(currentBtn);
        }
    }

    visibleFolders.forEach(folder => {
        const btn = document.createElement('button');
        btn.className = 'folder-tab';
        btn.dataset.folderId = folder.id;
        const hasChildren = state.allFolders.some(f => f.parentFolderId === folder.id && !f.isDeleted);
        const childIcon = hasChildren ? ' <i class="ph ph-caret-right" style="font-size:10px;opacity:0.6;"></i>' : '';
        btn.innerHTML = `<i class="ph ph-folder-simple"></i> ${folder.name}${childIcon}`;
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
    addBtn.className = 'folder-tab folder-add-btn';
    addBtn.title = state.currentFolder === null ? '새 폴더 만들기' : '새 하위 폴더 만들기';
    addBtn.innerHTML = '<i class="ph ph-folder-plus"></i>';
    addBtn.onclick = createFolderInCurrent;
    row.appendChild(addBtn);
}

export function createFolderInCurrent() {
    const isSub = state.currentFolder !== null;
    const promptLabel = isSub ? '새 하위 폴더 이름:' : '새 폴더 이름:';
    const name = prompt(promptLabel);
    if (!name || !name.trim()) return;
    const id = 'folder_' + Date.now();
    const folderObj = { id, name: name.trim() };
    if (isSub) folderObj.parentFolderId = state.currentFolder;
    state.allFolders.push(folderObj);
    state.folderOrder.push(id);
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal();
    renderFolders();
    saveToDrive();
}

export function addSubfolderAction() {
    getEl('folder-context-menu')?.classList.add('hidden');
    const parent = state.allFolders.find(f => f.id === state.contextFolderId);
    if (!parent) return;
    const name = prompt(`'${parent.name}' 안에 새 하위 폴더 이름:`);
    if (!name || !name.trim()) return;
    const id = 'folder_' + Date.now();
    state.allFolders.push({ id, name: name.trim(), parentFolderId: parent.id });
    state.folderOrder.push(id);
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal();
    renderFolders();
    saveToDrive();
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
    if (!folder || folder.isDeleted) return;

    const collectDescendants = (id) => {
        const direct = state.allFolders.filter(f => f.parentFolderId === id && !f.isDeleted);
        return direct.reduce((acc, f) => acc.concat([f.id], collectDescendants(f.id)), []);
    };
    const descendants = collectDescendants(folder.id);
    const allFolderIds = new Set([folder.id, ...descendants]);
    const affectedCats = state.allCategories.filter(c => c.folderId && allFolderIds.has(c.folderId) && !c.isDeleted);

    let extra = '';
    if (descendants.length > 0 && affectedCats.length > 0) extra = ` (하위 폴더 ${descendants.length}개, 주제 ${affectedCats.length}개 포함)`;
    else if (descendants.length > 0) extra = ` (하위 폴더 ${descendants.length}개 포함)`;
    else if (affectedCats.length > 0) extra = ` (소속 주제 ${affectedCats.length}개 포함)`;

    if (confirm(`'${folder.name}' 폴더를 휴지통으로 보내시겠습니까?${extra}`)) {
        const now = new Date().toISOString();
        state.allFolders.forEach(f => { if (allFolderIds.has(f.id)) { f.isDeleted = true; f.deletedAt = now; } });
        affectedCats.forEach(c => { c.isDeleted = true; c.deletedAt = now; });
        if (state.currentFolder && allFolderIds.has(state.currentFolder)) {
            state.currentFolder = folder.parentFolderId || null;
        }
        if (state.allCategories.find(c => c.id === state.currentCategory)?.isDeleted) {
            const next = state.allCategories.find(c => !c.isDeleted);
            if (next) { state.currentCategory = next.id; applyCategorySort(); }
        }
        state.categoryUpdatedAt = now;
        saveCategoriesToLocal(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
    }
}

export function restoreFolder(id) {
    const folder = state.allFolders.find(f => f.id === id);
    if (!folder) return;
    delete folder.isDeleted;
    delete folder.deletedAt;
    let parentId = folder.parentFolderId;
    while (parentId) {
        const parent = state.allFolders.find(f => f.id === parentId);
        if (!parent) { delete folder.parentFolderId; break; }
        if (parent.isDeleted) { delete parent.isDeleted; delete parent.deletedAt; }
        parentId = parent.parentFolderId;
    }
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal(); renderTrash(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
}

export function permanentDeleteFolder(id) {
    if (!confirm('이 폴더를 영구 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
    const folder = state.allFolders.find(f => f.id === id);
    if (!folder) return;
    state.allFolders.forEach(f => { if (f.parentFolderId === id) delete f.parentFolderId; });
    state.allCategories.forEach(c => { if (c.folderId === id) delete c.folderId; });
    state.allFolders = state.allFolders.filter(f => f.id !== id);
    state.folderOrder = state.folderOrder.filter(fid => fid !== id);
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal(); renderTrash(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
}

function renderFolderAssignList() {
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
    state.folderOrder.forEach(id => { const f = state.allFolders.find(f => f.id === id); if (f && !f.isDeleted) sortedFolders.push(f); });
    state.allFolders.forEach(f => { if (!f.isDeleted && !state.folderOrder.includes(f.id)) sortedFolders.push(f); });

    const renderLevel = (parentId, depth) => {
        sortedFolders.filter(f => (f.parentFolderId || null) === parentId).forEach(folder => {
            const div = document.createElement('div');
            div.className = 'cat-select-item';
            if (depth > 0) div.style.paddingLeft = `${12 + depth * 18}px`;
            div.innerHTML = `<i class="ph ph-folder-simple"></i> ${folder.name}`;
            div.onclick = () => {
                const cat = state.allCategories.find(c => c.id === state.contextCatId);
                if (cat) { cat.folderId = folder.id; state.categoryUpdatedAt = new Date().toISOString(); saveCategoriesToLocal(); renderFolders(); renderTabs(); saveToDrive(); }
                modal.classList.add('hidden');
            };
            list.appendChild(div);
            renderLevel(folder.id, depth + 1);
        });
    };
    renderLevel(null, 0);
}

export function openFolderAssignModal() {
    getEl('category-context-menu')?.classList.add('hidden');
    const modal = getEl('folder-assign-modal');
    if (!modal) return;
    renderFolderAssignList();
    openModal(modal);
}

export function createFolderFromAssignModal() {
    const name = prompt("새 폴더 이름");
    if (!name || !name.trim()) return;
    const id = 'folder_' + Date.now();
    state.allFolders.push({ id, name: name.trim() });
    state.folderOrder.push(id);
    state.categoryUpdatedAt = new Date().toISOString();

    const cat = state.allCategories.find(c => c.id === state.contextCatId);
    if (cat) cat.folderId = id;

    saveCategoriesToLocal();
    renderFolders();
    renderTabs();
    saveToDrive();

    const modal = getEl('folder-assign-modal');
    if (modal) modal.classList.add('hidden');
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
    if (!cat || cat.isDeleted) return;
    const visible = state.allCategories.filter(c => !c.isDeleted);
    if (visible.length <= 1) { alert('마지막 주제는 삭제할 수 없습니다.'); return; }
    if (confirm(`'${cat.name}' 주제를 휴지통으로 보내시겠습니까?\n(소속된 글은 주제를 복구하면 다시 보입니다)`)) {
        const now = new Date().toISOString();
        cat.isDeleted = true;
        cat.deletedAt = now;
        if (state.currentCategory === cat.id) {
            const next = state.allCategories.find(c => !c.isDeleted);
            if (next) { state.currentCategory = next.id; applyCategorySort(); }
        }
        state.categoryUpdatedAt = now;
        saveCategoriesToLocal(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
    }
}

export function restoreCategory(id) {
    const cat = state.allCategories.find(c => c.id === id);
    if (!cat) return;
    delete cat.isDeleted;
    delete cat.deletedAt;
    let parentId = cat.folderId;
    while (parentId) {
        const parent = state.allFolders.find(f => f.id === parentId);
        if (!parent) { delete cat.folderId; break; }
        if (parent.isDeleted) { delete parent.isDeleted; delete parent.deletedAt; }
        parentId = parent.parentFolderId;
    }
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal(); renderTrash(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
}

export function permanentDeleteCategory(id) {
    const remaining = state.allCategories.filter(c => !c.isDeleted && c.id !== id);
    if (remaining.length === 0) { alert('영구 삭제 후 남는 주제가 없어 삭제할 수 없습니다.'); return; }
    if (!confirm('이 주제를 영구 삭제하시겠습니까? 소속된 글도 다른 주제로 옮겨집니다.')) return;
    const cat = state.allCategories.find(c => c.id === id);
    if (!cat) return;
    state.allCategories = state.allCategories.filter(c => c.id !== id);
    state.categoryOrder = state.categoryOrder.filter(cid => cid !== id);
    const newCatId = remaining[0].id;
    state.entries.forEach(e => { if (e.category === id) e.category = newCatId; });
    try { localStorage.setItem('faithLogDB', JSON.stringify(state.entries)); } catch(e) { console.error(e); }
    if (state.currentCategory === id) { state.currentCategory = newCatId; applyCategorySort(); }
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal(); renderTrash(); renderFolders(); renderTabs(); renderEntries(); saveToDrive();
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
    state.categoryOrder.forEach(id => { const found = state.allCategories.find(c => c.id === id); if(found && !found.isDeleted) sortedCats.push(found); });
    state.allCategories.forEach(c => { if(!c.isDeleted && !state.categoryOrder.includes(c.id)) sortedCats.push(c); });

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