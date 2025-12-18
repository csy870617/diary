import { state, saveCategoriesToLocal } from './state.js';
import { updateEntryField, emptyTrash, saveEntry, loadDataFromFirestore } from './data.js';
import { openEditor, toggleViewMode, applyFontStyle } from './editor.js';

// DOM 요소 불러오기 Helper
const getEl = (id) => document.getElementById(id);

export function renderEntries(keyword = '') {
    const entryList = getEl('entry-list');
    if(!entryList) return;
    entryList.innerHTML = '';
    if(state.isLoading) {
        entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">로딩 중...</div>`;
        return;
    }
    const filtered = state.entries.filter(entry => !entry.isDeleted && entry.category === state.currentCategory && (entry.title.includes(keyword) || entry.body.includes(keyword)));
    
    filtered.sort((a, b) => { 
        let valA, valB; 
        if (state.currentSortBy === 'title') { valA = a.title; valB = b.title; } 
        else if (state.currentSortBy === 'modified') { valA = a.modifiedAt || a.timestamp; valB = b.modifiedAt || b.timestamp; } 
        else { valA = a.timestamp; valB = b.timestamp; } 
        if (valA < valB) return state.currentSortOrder === 'asc' ? -1 : 1; 
        if (valA > valB) return state.currentSortOrder === 'asc' ? 1 : -1; 
        return 0; 
    });

    if (filtered.length === 0) { entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">기록이 없습니다.</div>`; return; }
    
    filtered.forEach(entry => {
        const div = document.createElement('article');
        div.className = 'entry-card';
        if (entry.isLocked) {
            div.innerHTML = `<h3 class="card-title"><i class="ph ph-lock-key"></i> ${entry.title}</h3><p class="card-subtitle" style="color:#aaa;">비공개 글입니다.</p><div class="card-meta"><span>${entry.date}</span></div>`;
            div.onclick = () => { state.contextTargetId = entry.id; openLockModal(); };
        } else {
            const dateStr = state.currentSortBy === 'modified' ? `수정: ${new Date(entry.modifiedAt || entry.timestamp).toLocaleDateString()}` : entry.date;
            div.innerHTML = `<h3 class="card-title">${entry.title}</h3>${entry.subtitle ? `<p class="card-subtitle">${entry.subtitle}</p>` : ''}<div class="card-meta"><span>${dateStr}</span></div>`;
            div.onclick = () => {
                openEditor(true, entry);
                toggleViewMode('readOnly');
            };
        }
        attachContextMenu(div, entry.id);
        entryList.appendChild(div);
    });
}

export function renderTabs() {
    const tabContainer = getEl('tab-container');
    if(!tabContainer) return;
    tabContainer.innerHTML = '';
    const sortedCats = [];
    state.categoryOrder.forEach(id => { const found = state.allCategories.find(c => c.id === id); if(found) sortedCats.push(found); });
    state.allCategories.forEach(c => { if(!state.categoryOrder.includes(c.id)) { sortedCats.push(c); state.categoryOrder.push(c.id); } });

    sortedCats.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `tab-btn ${state.currentCategory === cat.id ? 'active' : ''}`;
        btn.dataset.id = cat.id; 
        btn.innerHTML = `<span>${cat.name}</span>`;
        btn.onclick = () => { state.currentCategory = cat.id; renderTabs(); renderEntries(); };
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
    const deleted = state.entries.filter(e => e.isDeleted); 
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

export function closeAllModals(goBack = true) {
    const writeModal = getEl('write-modal');
    const trashModal = getEl('trash-modal');
    const loginModal = getEl('login-modal');
    const resetPwModal = getEl('reset-pw-modal');
    const stickerPalette = getEl('sticker-palette');
    const colorPalettePopup = getEl('color-palette-popup');
    const contextMenu = getEl('context-menu');
    const moveModal = getEl('move-modal');
    const lockModal = getEl('lock-modal');
    const editorToolbar = getEl('editor-toolbar');
    const toolbarToggleBtn = getEl('toolbar-toggle-btn');

    if(writeModal) {
        writeModal.classList.add('hidden');
        toggleViewMode('default'); 
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

// Context Menu Helpers
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
    state.contextTargetId = id;
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return;
    const lockBtn = getEl('ctx-lock');
    if(lockBtn) lockBtn.innerHTML = entry.isLocked ? '<i class="ph ph-lock-open"></i> 잠금 해제' : '<i class="ph ph-lock"></i> 잠그기';
    contextMenu.style.top = `${y}px`;
    contextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) contextMenu.style.left = `${x - 160}px`;
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
    state.contextCatId = id;
    catContextMenu.style.top = `${y}px`;
    catContextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) catContextMenu.style.left = `${x - 160}px`;
    catContextMenu.classList.remove('hidden');
}

export function addNewCategory() {
    const name = prompt("새 주제 이름");
    if (name) {
        const id = 'custom_' + Date.now();
        state.allCategories.push({id, name});
        state.categoryOrder.push(id);
        saveCategoriesToLocal();
        renderTabs();
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
        saveCategoriesToLocal();
        renderTabs();
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
        saveCategoriesToLocal();
        renderTabs();
        renderEntries();
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

export function openLockModal() {
    const contextMenu = getEl('context-menu');
    const lockModal = getEl('lock-modal');
    const lockModalTitle = getEl('lock-modal-title');
    const lockModalDesc = getEl('lock-modal-desc');
    const lockPwInput = getEl('lock-pw-input');
    
    if(!contextMenu || !lockModal) return;
    contextMenu.classList.add('hidden');
    const entry = state.entries.find(e => e.id === state.contextTargetId);
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

export async function confirmLock() {
    const lockPwInput = getEl('lock-pw-input');
    const lockModal = getEl('lock-modal');
    const pw = lockPwInput.value;
    const entry = state.entries.find(e => e.id === state.contextTargetId);
    if (!entry || !pw) return alert("비밀번호를 입력해주세요.");
    if (entry.isLocked) {
        if (entry.lockPassword === pw) {
            await updateEntryField(state.contextTargetId, { isLocked: false, lockPassword: null });
            alert("잠금이 해제되었습니다.");
            lockModal.classList.add('hidden');
            renderEntries();
        } else { alert("비밀번호가 일치하지 않습니다."); }
    } else {
        await updateEntryField(state.contextTargetId, { isLocked: true, lockPassword: pw });
        alert("글이 잠겼습니다.");
        lockModal.classList.add('hidden');
        renderEntries();
    }
}