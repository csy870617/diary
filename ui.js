import { state, saveCategoriesToLocal } from './state.js';
import { updateEntryField, emptyTrash, saveEntry, restoreEntry, permanentDelete } from './data.js';
import { openEditor, toggleViewMode, applyFontStyle } from './editor.js';
import { saveToDrive } from './drive.js';

const getEl = (id) => document.getElementById(id);

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

// [핵심 수정] 탭 렌더링 및 자동 선택 로직
export function renderTabs() {
    const tabContainer = getEl('tab-container');
    if(!tabContainer) return;
    tabContainer.innerHTML = '';
    
    const sortedCats = [];
    state.categoryOrder.forEach(id => { const found = state.allCategories.find(c => c.id === id); if(found) sortedCats.push(found); });
    state.allCategories.forEach(c => { if(!state.categoryOrder.includes(c.id)) { sortedCats.push(c); state.categoryOrder.push(c.id); } });

    // [중요] 현재 선택된 카테고리가 유효한지 검사
    const currentExists = sortedCats.find(c => c.id === state.currentCategory);
    
    // 만약 현재 카테고리가 삭제되었거나 동기화로 인해 변경되어 목록에 없다면?
    if (!currentExists && sortedCats.length > 0) {
        // 첫 번째 카테고리를 강제로 선택
        state.currentCategory = sortedCats[0].id;
        // 그리고 글 목록을 다시 그려줌 (재귀 호출 방지를 위해 renderEntries만 호출)
        setTimeout(renderEntries, 0); 
    }

    sortedCats.forEach(cat => {
        const btn = document.createElement('button');
        // 현재 선택된 카테고리에 active 클래스 부여
        btn.className = `tab-btn ${state.currentCategory === cat.id ? 'active' : ''}`;
        btn.dataset.id = cat.id; 
        btn.innerHTML = `<span>${cat.name}</span>`;
        btn.onclick = () => { 
            state.currentCategory = cat.id; 
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

export function addNewCategory() {
    const name = prompt("새 주제 이름");
    if (name) {
        const id = 'custom_' + Date.now();
        state.allCategories.push({id, name});
        state.categoryOrder.push(id);
        
        state.categoryUpdatedAt = new Date().toISOString();
        
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
        
        state.categoryUpdatedAt = new Date().toISOString();
        
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
        
        state.categoryUpdatedAt = new Date().toISOString();
        
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