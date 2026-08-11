import { state, saveCategoriesToLocal, getCategorySort, migrateRootOrder, isReadOnlyView } from './state.js';
import { updateEntryField, bulkUpdateEntryField, emptyTrash, saveEntry, restoreEntry, permanentDelete } from './data.js';
import { openEditor, toggleViewMode, applyFontStyle, turnPage, formatDoc, changeGlobalFontSize, insertSticker, insertImage, sanitizeEntryHtml } from './editor.js';
import { saveToDrive, syncFromDrive } from './drive.js';
import { saveEntries } from './storage.js'; 

const getEl = (id) => document.getElementById(id);

function stripHtml(html) {
    if (!html) return '';
    // DOMParser는 비활성 문서를 사용하므로 img src 등으로 인한 네트워크 요청이 발생하지 않음
    return new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
}

// 사용자 입력 텍스트를 innerHTML 템플릿에 넣기 전 이스케이프 (저장형 HTML 주입 방지)
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

export function renderEntries(keyword) {
    // 호출부가 키워드를 넘기지 않아도 현재 검색어를 유지해,
    // 선택 모드 전환 등 재렌더링 시 검색 결과가 풀리는 문제를 방지
    if (keyword === undefined) keyword = getEl('search-input')?.value || '';
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
        ((entry.title || '').includes(keyword) || stripHtml(entry.body).includes(keyword))
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
        div.innerHTML = `${checkboxHtml}<div class="entry-card-content"><h3 class="card-title">${escapeHtml(entry.title)}</h3>${entry.subtitle ? `<p class="card-subtitle">${escapeHtml(entry.subtitle)}</p>` : ''}<div class="card-meta"><span>${escapeHtml(dateStr)}</span></div></div>`;

        if (state.isSelectMode) {
            div.onclick = () => toggleEntrySelection(entry.id);
        } else {
            div.onclick = () => {
                openEditor(true, entry);
                toggleViewMode('readOnly');
                // 작성 모달이 편집 가능한 모드로 열려 있으면 동기화 금지 (작성 중 내용 유실 방지)
                const writeModal = getEl('write-modal');
                const isEditingOpen = writeModal && !writeModal.classList.contains('hidden') && !isReadOnlyView();
                if (!isEditingOpen && window.gapi && gapi.client && gapi.client.getToken()) {
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

export function renderTabs() { renderFolders(); }

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
        div.innerHTML = `<div class="trash-info"><h4><i class="ph ph-folder-simple"></i> ${escapeHtml(folder.name)}</h4>${dateStr ? `<p>${dateStr} 삭제</p>` : ''}</div>`;
        div.appendChild(makeButtons(() => restoreFolder(folder.id), () => permanentDeleteFolder(folder.id)));
        return div;
    });

    addSection('주제', deletedCats, (cat) => {
        const div = document.createElement('div'); div.className = 'trash-item';
        const dateStr = cat.deletedAt ? new Date(cat.deletedAt).toLocaleDateString() : '';
        div.innerHTML = `<div class="trash-info"><h4><i class="ph ph-tag"></i> ${escapeHtml(cat.name)}</h4>${dateStr ? `<p>${dateStr} 삭제</p>` : ''}</div>`;
        div.appendChild(makeButtons(() => restoreCategory(cat.id), () => permanentDeleteCategory(cat.id)));
        return div;
    });

    addSection('글', deletedEntries, (entry) => {
        const div = document.createElement('div'); div.className = 'trash-item';
        div.innerHTML = `<div class="trash-info"><h4>${escapeHtml(entry.title)}</h4><p>${escapeHtml(entry.date)}</p></div>`;
        div.appendChild(makeButtons(() => restoreEntry(entry.id), () => permanentDelete(entry.id)));
        return div;
    });
}

// 떠 있는 팝업/확장 패널을 모두 닫는다 (화면 전환·바깥 터치 시 호출)
export function hideTransientPopups() {
    ['context-menu', 'category-context-menu', 'folder-context-menu', 'add-menu-popup', 'color-palette-popup', 'sticker-palette', 'table-modal'].forEach(id => {
        getEl(id)?.classList.add('hidden');
    });
    getEl('font-size-dropdown')?.classList.remove('show');
    getEl('tts-settings')?.classList.add('hidden');
    closeFolderPopup();
}

export function closeAllModals(goBack = true) {
    hideTransientPopups();
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

// 길게 누르기 공통 처리: 스크롤(touchmove)/취소 시 타이머 해제, 발동 직후 클릭은 무시
function attachLongPress(element, onLongPress) {
    let longPressFired = false;
    element.addEventListener('touchstart', (e) => {
        longPressFired = false;
        state.longPressTimer = setTimeout(() => {
            longPressFired = true;
            const touch = e.touches[0];
            if (touch) onLongPress(touch.clientX, touch.clientY);
        }, 600);
    }, { passive: true });
    const cancelTimer = () => clearTimeout(state.longPressTimer);
    element.addEventListener('touchmove', cancelTimer, { passive: true });
    element.addEventListener('touchcancel', cancelTimer, { passive: true });
    element.ontouchend = () => {
        cancelTimer();
        // 길게 누르기가 발동했다면 뒤따르는 합성 click만 무시하고, click이 안 와도 곧 플래그 해제
        // (해제하지 않으면 이후 정상 탭이 한 번 먹힐 수 있음)
        if (longPressFired) setTimeout(() => { longPressFired = false; }, 400);
    };
    element.addEventListener('click', (e) => {
        if (longPressFired) {
            longPressFired = false;
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);
}

function attachContextMenu(element, entryId) {
    element.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, entryId); };
    attachLongPress(element, (x, y) => showContextMenu(x, y, entryId));
}

function showContextMenu(x, y, id) {
    const contextMenu = getEl('context-menu');
    if(!contextMenu) return;
    getEl('category-context-menu')?.classList.add('hidden');
    getEl('folder-context-menu')?.classList.add('hidden');
    getEl('add-menu-popup')?.classList.add('hidden');
    state.contextTargetId = id;
    placeFloatingMenu(contextMenu, { x, y });
}

function attachCatContextMenu(element, catId) {
    element.oncontextmenu = (e) => { e.preventDefault(); showCatContextMenu(e.clientX, e.clientY, catId); };
    attachLongPress(element, (x, y) => showCatContextMenu(x, y, catId));
}

function showCatContextMenu(x, y, id) {
    const catContextMenu = getEl('category-context-menu');
    if(!catContextMenu) return;
    getEl('context-menu')?.classList.add('hidden');
    getEl('folder-context-menu')?.classList.add('hidden');
    getEl('add-menu-popup')?.classList.add('hidden');
    state.contextCatId = id;
    placeFloatingMenu(catContextMenu, { x, y });
}

let popupFolderId = null;
let popupHistory = [];
let popupAnchor = null;

function topicInFolderTree(topicId, folderId) {
    const topic = state.allCategories.find(c => c.id === topicId);
    if (!topic || !topic.folderId) return false;
    let cur = topic.folderId;
    while (cur) {
        if (cur === folderId) return true;
        const f = state.allFolders.find(fo => fo.id === cur);
        if (!f) return false;
        cur = f.parentFolderId;
    }
    return false;
}

function folderHasContent(folderId) {
    return state.allFolders.some(f => f.parentFolderId === folderId && !f.isDeleted)
        || state.allCategories.some(c => c.folderId === folderId && !c.isDeleted);
}

export function renderFolders() {
    const row = getEl('folder-row');
    if (!row) return;
    row.innerHTML = '';
    state.currentFolder = null;

    migrateRootOrder();

    const liveFolders = state.allFolders.filter(f => !f.isDeleted && !f.parentFolderId);
    const liveTopics = state.allCategories.filter(c => !c.isDeleted && !c.folderId);
    const currentExistsAtRoot = liveTopics.find(c => c.id === state.currentCategory);
    if (!currentExistsAtRoot) {
        const anyLive = state.allCategories.find(c => !c.isDeleted);
        if (anyLive && !state.allCategories.find(c => c.id === state.currentCategory && !c.isDeleted)) {
            state.currentCategory = anyLive.id;
            applyCategorySort();
        }
    }

    const itemMap = new Map();
    liveFolders.forEach(f => itemMap.set(f.id, { type: 'folder', obj: f }));
    liveTopics.forEach(c => itemMap.set(c.id, { type: 'topic', obj: c }));

    const sortedIds = [];
    (state.rootOrder || []).forEach(id => { if (itemMap.has(id)) { sortedIds.push(id); itemMap.delete(id); } });
    itemMap.forEach((_, id) => sortedIds.push(id));

    row.classList.remove('hidden');

    sortedIds.forEach(id => {
        const folder = state.allFolders.find(f => f.id === id);
        if (folder) { row.appendChild(buildFolderNavItem(folder)); return; }
        const cat = state.allCategories.find(c => c.id === id);
        if (cat) row.appendChild(buildTopicNavItem(cat));
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'nav-item nav-add-btn';
    addBtn.title = '새 항목 추가';
    addBtn.innerHTML = '<i class="ph ph-plus"></i>';
    addBtn.onclick = (e) => { e.stopPropagation(); showAddMenu(addBtn); };
    row.appendChild(addBtn);

    initFolderRowSortable(row); // 폴더/주제 칩 드래그 순서 변경 (렌더마다 재부착)

    if (popupFolderId) renderFolderPopupContent();
}

// 루트 폴더/주제 칩의 드래그 순서 변경. 렌더마다 destroy 후 재생성해 항상 동작하도록 보장
function initFolderRowSortable(row) {
    if (typeof Sortable === 'undefined' || !row) return;
    if (row._sortable) { try { row._sortable.destroy(); } catch (e) {} }
    row._sortable = new Sortable(row, {
        animation: 150, delay: 200, delayOnTouchOnly: true, touchStartThreshold: 5,
        filter: '.nav-add-btn',
        preventOnFilter: false,
        onEnd: async () => {
            const newOrder = [];
            row.querySelectorAll('[data-item-id]').forEach(el => {
                if (el.dataset.itemId) newOrder.push(el.dataset.itemId);
            });
            if (newOrder.length === 0) return;
            state.rootOrder = newOrder;
            state.categoryUpdatedAt = new Date().toISOString();
            saveCategoriesToLocal();
            await saveToDrive();
        }
    });
}

function buildFolderNavItem(folder) {
    const btn = document.createElement('button');
    btn.className = 'nav-item folder-nav';
    btn.dataset.itemId = folder.id;
    btn.dataset.itemType = 'folder';
    btn.dataset.folderId = folder.id;
    if (topicInFolderTree(state.currentCategory, folder.id)) btn.classList.add('has-active');
    if (popupFolderId === folder.id || (popupHistory.length > 0 && popupHistory[0] === folder.id)) btn.classList.add('popup-open');
    const hasChildren = folderHasContent(folder.id);
    const caret = hasChildren ? ' <i class="ph ph-caret-down nav-caret"></i>' : '';
    btn.innerHTML = `<i class="ph ph-folder-simple"></i> <span>${escapeHtml(folder.name)}</span>${caret}`;
    btn.onclick = (e) => {
        e.stopPropagation();
        if (popupFolderId && (popupFolderId === folder.id || popupHistory[0] === folder.id)) {
            closeFolderPopup();
        } else {
            showFolderPopup(folder.id, btn);
        }
    };
    attachFolderContextMenu(btn, folder.id);
    return btn;
}

function buildTopicNavItem(cat) {
    const btn = document.createElement('button');
    btn.className = `nav-item topic-nav${state.currentCategory === cat.id ? ' active' : ''}`;
    btn.dataset.itemId = cat.id;
    btn.dataset.itemType = 'topic';
    btn.dataset.catId = cat.id;
    btn.innerHTML = `<i class="ph ph-tag"></i> <span>${escapeHtml(cat.name)}</span>`;
    btn.onclick = (e) => {
        e.stopPropagation();
        closeFolderPopup();
        state.currentCategory = cat.id;
        applyCategorySort();
        if (state.isSelectMode) exitSelectMode();
        renderFolders();
        renderEntries();
    };
    attachCatContextMenu(btn, cat.id);
    return btn;
}

export function showFolderPopup(folderId, anchor) {
    getEl('add-menu-popup')?.classList.add('hidden');
    getEl('context-menu')?.classList.add('hidden');
    getEl('category-context-menu')?.classList.add('hidden');
    getEl('folder-context-menu')?.classList.add('hidden');
    popupFolderId = folderId;
    popupHistory = [];
    popupAnchor = anchor;
    renderFolderPopupContent();
    positionFolderPopup();
    getEl('folder-popup').classList.remove('hidden');
    renderFolders();
}

export function closeFolderPopup() {
    const popup = getEl('folder-popup');
    if (!popup) return;
    const wasOpen = !popup.classList.contains('hidden');
    popup.classList.add('hidden');
    popupFolderId = null;
    popupHistory = [];
    popupAnchor = null;
    if (wasOpen) renderFolders();
}

function renderFolderPopupContent() {
    const popup = getEl('folder-popup');
    const list = getEl('folder-popup-list');
    const header = getEl('folder-popup-header');
    const back = getEl('folder-popup-back');
    if (!popup || !list) return;
    const folder = state.allFolders.find(f => f.id === popupFolderId);
    if (!folder || folder.isDeleted) { closeFolderPopup(); return; }

    list.innerHTML = '';

    if (popupHistory.length > 0) {
        back.classList.remove('hidden');
        const prevId = popupHistory[popupHistory.length - 1];
        const prev = state.allFolders.find(f => f.id === prevId);
        const label = back.querySelector('.popup-back-label');
        if (label) label.textContent = prev ? prev.name : '뒤로';
        back.querySelector('button').onclick = (e) => {
            e.stopPropagation();
            popupFolderId = popupHistory.pop();
            renderFolderPopupContent();
            positionFolderPopup();
        };
    } else {
        back.classList.add('hidden');
    }

    if (header) {
        header.innerHTML = `<i class="ph ph-folder-open"></i> <span>${escapeHtml(folder.name)}</span>`;
    }

    const subFolders = state.allFolders
        .filter(f => f.parentFolderId === popupFolderId && !f.isDeleted)
        .sort((a, b) => state.folderOrder.indexOf(a.id) - state.folderOrder.indexOf(b.id));
    const topics = state.allCategories
        .filter(c => c.folderId === popupFolderId && !c.isDeleted)
        .sort((a, b) => state.categoryOrder.indexOf(a.id) - state.categoryOrder.indexOf(b.id));

    if (subFolders.length === 0 && topics.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'popup-empty';
        empty.textContent = '비어있음';
        list.appendChild(empty);
    }

    subFolders.forEach(f => {
        const item = document.createElement('div');
        item.className = 'popup-item folder-popup-item';
        item.dataset.itemId = f.id;
        item.dataset.itemType = 'folder';
        const hasChildren = folderHasContent(f.id);
        const caret = hasChildren ? '<i class="ph ph-caret-right popup-item-arrow"></i>' : '';
        item.innerHTML = `<i class="ph ph-folder-simple"></i><span class="popup-item-label">${escapeHtml(f.name)}</span>${caret}`;
        item.onclick = (e) => {
            e.stopPropagation();
            popupHistory.push(popupFolderId);
            popupFolderId = f.id;
            renderFolderPopupContent();
            positionFolderPopup();
        };
        attachFolderContextMenu(item, f.id);
        list.appendChild(item);
    });

    topics.forEach(c => {
        const item = document.createElement('div');
        item.className = `popup-item topic-popup-item${state.currentCategory === c.id ? ' active' : ''}`;
        item.dataset.itemId = c.id;
        item.dataset.itemType = 'topic';
        item.innerHTML = `<i class="ph ph-tag"></i><span class="popup-item-label">${escapeHtml(c.name)}</span>`;
        item.onclick = (e) => {
            e.stopPropagation();
            state.currentCategory = c.id;
            applyCategorySort();
            if (state.isSelectMode) exitSelectMode();
            closeFolderPopup();
            renderEntries();
        };
        attachCatContextMenu(item, c.id);
        list.appendChild(item);
    });

    const divider = document.createElement('div');
    divider.className = 'popup-divider';
    list.appendChild(divider);

    const addTopic = document.createElement('div');
    addTopic.className = 'popup-item popup-add-item';
    addTopic.innerHTML = '<i class="ph ph-plus"></i><span class="popup-item-label">새 주제</span>';
    addTopic.onclick = (e) => {
        e.stopPropagation();
        const name = prompt(`'${folder.name}' 안에 새 주제 이름:`);
        if (!name || !name.trim()) return;
        const id = 'custom_' + Date.now();
        state.allCategories.push({ id, name: name.trim(), folderId: popupFolderId });
        state.categoryOrder.push(id);
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal();
        renderFolderPopupContent();
        renderFolders();
        saveToDrive();
    };
    list.appendChild(addTopic);

    const addFolder = document.createElement('div');
    addFolder.className = 'popup-item popup-add-item';
    addFolder.innerHTML = '<i class="ph ph-folder-plus"></i><span class="popup-item-label">새 하위 폴더</span>';
    addFolder.onclick = (e) => {
        e.stopPropagation();
        const name = prompt(`'${folder.name}' 안에 새 하위 폴더 이름:`);
        if (!name || !name.trim()) return;
        const id = 'folder_' + Date.now();
        state.allFolders.push({ id, name: name.trim(), parentFolderId: popupFolderId });
        state.folderOrder.push(id);
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal();
        renderFolderPopupContent();
        renderFolders();
        saveToDrive();
    };
    list.appendChild(addFolder);

    initPopupSortable(list);
}

function initPopupSortable(list) {
    if (typeof Sortable === 'undefined' || !list) return;
    if (list._sortable) { try { list._sortable.destroy(); } catch(e) {} }
    list._sortable = new Sortable(list, {
        animation: 150,
        delay: 200,
        delayOnTouchOnly: true,
        touchStartThreshold: 5,
        draggable: '.folder-popup-item, .topic-popup-item',
        filter: '.popup-add-item, .popup-divider, .popup-empty',
        preventOnFilter: false,
        onEnd: async () => {
            const newFolderIds = [];
            const newTopicIds = [];
            list.querySelectorAll('[data-item-id]').forEach(el => {
                const type = el.dataset.itemType;
                const id = el.dataset.itemId;
                if (!id) return;
                if (type === 'folder') newFolderIds.push(id);
                else if (type === 'topic') newTopicIds.push(id);
            });

            const reorderGlobal = (globalOrder, subsetIds) => {
                const subsetSet = new Set(subsetIds);
                let i = 0;
                const result = globalOrder.map(id => (subsetSet.has(id) ? subsetIds[i++] : id));
                subsetIds.forEach(id => { if (!globalOrder.includes(id)) result.push(id); });
                return result;
            };

            if (newFolderIds.length > 0) {
                state.folderOrder = reorderGlobal(state.folderOrder, newFolderIds);
            }
            if (newTopicIds.length > 0) {
                state.categoryOrder = reorderGlobal(state.categoryOrder, newTopicIds);
            }

            state.categoryUpdatedAt = new Date().toISOString();
            saveCategoriesToLocal();
            await saveToDrive();
        }
    });
}

function positionFolderPopup() {
    const popup = getEl('folder-popup');
    if (!popup || !popupAnchor) return;
    const margin = 10;
    const rect = popupAnchor.getBoundingClientRect();
    popup.style.visibility = 'hidden';
    popup.classList.remove('hidden');
    const popupRect = popup.getBoundingClientRect();
    let left = rect.left;
    if (left + popupRect.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - popupRect.width - margin);
    }
    let top = rect.bottom + 4;
    if (top + popupRect.height > window.innerHeight - margin) {
        const topAboveAnchor = rect.top - popupRect.height - 4;
        top = topAboveAnchor >= margin ? topAboveAnchor : Math.max(margin, window.innerHeight - popupRect.height - margin);
    }
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.visibility = '';
}

function showAddMenu(anchor) {
    const menu = getEl('add-menu-popup');
    if (!menu) return;
    // 이미 열려 있으면 같은 버튼을 다시 눌렀을 때 닫기 (토글)
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    closeFolderPopup();
    getEl('context-menu')?.classList.add('hidden');
    getEl('category-context-menu')?.classList.add('hidden');
    getEl('folder-context-menu')?.classList.add('hidden');
    const rect = anchor.getBoundingClientRect();
    placeFloatingMenu(menu, { x: rect.right, y: rect.bottom + 4, alignRight: true });
    menu.querySelectorAll('.add-menu-item').forEach(b => {
        b.onclick = (e) => {
            e.stopPropagation();
            const action = b.dataset.action;
            menu.classList.add('hidden');
            if (action === 'topic') addRootTopic();
            else if (action === 'folder') addRootFolder();
        };
    });
}

function addRootTopic() {
    const name = prompt('새 주제 이름:');
    if (!name || !name.trim()) return;
    const id = 'custom_' + Date.now();
    state.allCategories.push({ id, name: name.trim() });
    state.categoryOrder.push(id);
    (state.rootOrder = state.rootOrder || []).push(id);
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal(); renderFolders(); saveToDrive();
}

function addRootFolder() {
    const name = prompt('새 폴더 이름:');
    if (!name || !name.trim()) return;
    const id = 'folder_' + Date.now();
    state.allFolders.push({ id, name: name.trim() });
    state.folderOrder.push(id);
    (state.rootOrder = state.rootOrder || []).push(id);
    state.categoryUpdatedAt = new Date().toISOString();
    saveCategoriesToLocal(); renderFolders(); saveToDrive();
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
    if (popupFolderId) renderFolderPopupContent();
    renderFolders();
    saveToDrive();
}

function attachFolderContextMenu(element, folderId) {
    element.oncontextmenu = (e) => { e.preventDefault(); showFolderContextMenu(e.clientX, e.clientY, folderId); };
    attachLongPress(element, (x, y) => showFolderContextMenu(x, y, folderId));
}

function showFolderContextMenu(x, y, folderId) {
    const menu = getEl('folder-context-menu');
    if (!menu) return;
    getEl('context-menu')?.classList.add('hidden');
    getEl('category-context-menu')?.classList.add('hidden');
    getEl('add-menu-popup')?.classList.add('hidden');
    state.contextFolderId = folderId;
    placeFloatingMenu(menu, { x, y });
}

function placeFloatingMenu(menu, { x, y, alignRight = false }) {
    if (!menu) return;
    const margin = 10;
    menu.style.visibility = 'hidden';
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    let left = alignRight ? x - rect.width : x;
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const top = Math.max(margin, Math.min(y, maxTop));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
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

    // 주제 삭제와 동일한 보호: 이 폴더를 지우면 살아있는 주제가 하나도 남지 않는 경우를 막는다.
    // (막지 않으면 모든 탭이 사라져 글이 어디에도 보이지 않고, 30일 뒤 자동 정리로 영구 손실된다)
    const liveCats = state.allCategories.filter(c => !c.isDeleted);
    const affectedIds = new Set(state.allCategories.filter(c => c.folderId && allFolderIds.has(c.folderId) && !c.isDeleted).map(c => c.id));
    if (liveCats.every(c => affectedIds.has(c.id))) {
        alert('이 폴더를 삭제하면 남는 주제가 없습니다.\n다른 주제를 먼저 만들거나 폴더 밖으로 옮겨 주세요.');
        return;
    }

    let extra = '';
    if (descendants.length > 0 && affectedCats.length > 0) extra = ` (하위 폴더 ${descendants.length}개, 주제 ${affectedCats.length}개 포함)`;
    else if (descendants.length > 0) extra = ` (하위 폴더 ${descendants.length}개 포함)`;
    else if (affectedCats.length > 0) extra = ` (소속 주제 ${affectedCats.length}개 포함)`;

    if (confirm(`'${folder.name}' 폴더를 휴지통으로 보내시겠습니까?${extra}`)) {
        const now = new Date().toISOString();
        // 함께 지워지는 항목에 '어느 폴더를 지우면서 딸려 삭제됐는지'를 남긴다.
        // 복구할 때 이 표식으로 하위 폴더·주제까지 같이 되살린다.
        state.allFolders.forEach(f => {
            if (!allFolderIds.has(f.id)) return;
            f.isDeleted = true; f.deletedAt = now;
            if (f.id !== folder.id) f.deletedWith = folder.id;
        });
        affectedCats.forEach(c => { c.isDeleted = true; c.deletedAt = now; c.deletedWith = folder.id; });
        // state.currentFolder는 renderFolders에서 항상 null로 초기화되므로 별도 처리 불필요
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
    delete folder.deletedWith;
    // 이 폴더를 지우면서 함께 삭제된 하위 폴더·주제도 같이 되살린다.
    // (되살리지 않으면 폴더만 빈 채로 돌아오고, 주제들은 30일 뒤 자동 정리로 사라진다)
    state.allFolders.forEach(f => {
        if (f.deletedWith === id) { delete f.isDeleted; delete f.deletedAt; delete f.deletedWith; }
    });
    state.allCategories.forEach(c => {
        if (c.deletedWith === id) { delete c.isDeleted; delete c.deletedAt; delete c.deletedWith; }
    });
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
    state.rootOrder = (state.rootOrder || []).filter(rid => rid !== id);
    // 삭제 사실을 남겨야 다른 기기와 병합할 때 되살아나지 않는다
    if (!state.purgedIds) state.purgedIds = {};
    state.purgedIds[id] = new Date().toISOString();
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
        if (cat) {
            delete cat.folderId;
            state.rootOrder = state.rootOrder || [];
            if (!state.rootOrder.includes(cat.id)) state.rootOrder.push(cat.id);
            state.categoryUpdatedAt = new Date().toISOString();
            saveCategoriesToLocal(); renderFolders(); saveToDrive();
        }
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
            div.innerHTML = `<i class="ph ph-folder-simple"></i> ${escapeHtml(folder.name)}`;
            div.onclick = () => {
                const cat = state.allCategories.find(c => c.id === state.contextCatId);
                if (cat) {
                    cat.folderId = folder.id;
                    state.rootOrder = (state.rootOrder || []).filter(id => id !== cat.id);
                    state.categoryUpdatedAt = new Date().toISOString();
                    saveCategoriesToLocal(); renderFolders(); saveToDrive();
                }
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
    (state.rootOrder = state.rootOrder || []).push(id);
    state.categoryUpdatedAt = new Date().toISOString();

    const cat = state.allCategories.find(c => c.id === state.contextCatId);
    if (cat) {
        cat.folderId = id;
        state.rootOrder = state.rootOrder.filter(rid => rid !== cat.id);
    }

    saveCategoriesToLocal();
    renderFolders();
    saveToDrive();

    const modal = getEl('folder-assign-modal');
    if (modal) modal.classList.add('hidden');
}

export function addNewCategory() {
    const name = prompt("새 주제 이름");
    if (name && name.trim()) {
        const id = 'custom_' + Date.now();
        state.allCategories.push({ id, name: name.trim() });
        state.categoryOrder.push(id);
        (state.rootOrder = state.rootOrder || []).push(id);
        state.categoryUpdatedAt = new Date().toISOString();
        saveCategoriesToLocal(); renderFolders(); saveToDrive();
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
    state.rootOrder = (state.rootOrder || []).filter(rid => rid !== id);
    if (!state.purgedIds) state.purgedIds = {};
    state.purgedIds[id] = new Date().toISOString();
    const newCatId = remaining[0].id;
    // 재배정도 '변경'이므로 수정시각을 갱신해야 다른 기기로 전파된다
    const reassignedAt = new Date().toISOString();
    state.entries.forEach(e => { if (e.category === id) { e.category = newCatId; e.modifiedAt = reassignedAt; } });
    saveEntries(state.entries).then(ok => {
        if (!ok) alert('이 기기의 저장 공간이 부족해 변경 내용을 기록하지 못했습니다.\n공간을 확보한 뒤 다시 시도해 주세요.');
    }).catch(e => console.error(e));
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
    // 검색으로 목록을 좁힌 상태에서는 화면에 보이는 글만 선택 대상으로 삼는다
    // (안 보이는 글까지 선택돼 일괄 이동/PDF가 의도치 않은 글에 적용되는 것 방지)
    const keyword = getEl('search-input')?.value || '';
    const filtered = state.entries.filter(entry =>
        !entry.isPurged && !entry.isDeleted && entry.category === state.currentCategory &&
        ((entry.title || '').includes(keyword) || stripHtml(entry.body).includes(keyword))
    );
    const filteredIds = filtered.map(e => e.id);
    const allSelected = filteredIds.length > 0 && filteredIds.every(id => state.selectedEntries.includes(id))
        && state.selectedEntries.length === filteredIds.length;
    state.selectedEntries = allSelected ? [] : filteredIds;
    renderEntries(keyword);
    updateBulkBar();
}

function updateBulkBar() {
    const count = state.selectedEntries.length;
    const countEl = getEl('bulk-selected-count');
    if (countEl) countEl.textContent = `${count}개 선택`;
    const moveBtn = getEl('bulk-move-btn');
    if (moveBtn) moveBtn.disabled = count === 0;
    const pdfBtn = getEl('bulk-pdf-btn');
    // PDF 생성 중에는 updateBulkBar가 버튼을 다시 활성화하지 않도록 보호
    if (pdfBtn && !pdfBtn.dataset.busy) pdfBtn.disabled = count === 0;
}

// 표시 순서와 동일하게 선택된 글들을 정렬해 반환
function getSelectedEntriesInOrder() {
    const selected = state.entries.filter(e =>
        state.selectedEntries.includes(e.id) && !e.isPurged && !e.isDeleted
    );
    selected.sort((a, b) => {
        if (state.currentSortBy === 'title') {
            const valA = (a.title || '').toLowerCase();
            const valB = (b.title || '').toLowerCase();
            if (valA < valB) return state.currentSortOrder === 'asc' ? -1 : 1;
            if (valA > valB) return state.currentSortOrder === 'asc' ? 1 : -1;
            return 0;
        }
        const timeA = new Date(state.currentSortBy === 'modified' ? (a.modifiedAt || a.timestamp) : a.timestamp).getTime() || 0;
        const timeB = new Date(state.currentSortBy === 'modified' ? (b.modifiedAt || b.timestamp) : b.timestamp).getTime() || 0;
        return state.currentSortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });
    return selected;
}

// 글 하나를 PDF 캡처용 오프스크린 요소로 렌더링해 from()에 넘길 content를 반환
// 화면 밖 위치 지정은 바깥 래퍼(offscreen)에만 적용한다.
// html2pdf는 from()에 넘긴 요소를 그대로 복제해 캡처하므로, 그 요소에
// left:-9999px 같은 스타일이 있으면 복제본도 화면 밖으로 밀려나 백지가 된다.
// 따라서 위치 스타일이 없는 안쪽 content 요소를 from()에 넘긴다.
function buildPdfContent(entry) {
    const offscreen = document.createElement('div');
    offscreen.style.cssText = 'position:absolute; left:-9999px; top:0;';
    const content = document.createElement('div');
    content.style.cssText = 'width:794px; background:#ffffff; padding:24px 32px; box-sizing:border-box;';
    const font = escapeHtml(entry.fontFamily || 'Pretendard');
    // 본문은 에디터 열 때와 동일하게 위험 요소(script/이벤트 핸들러 등)만 제거 후 삽입
    // (구버전에 동기화된 오염 데이터가 PDF 생성 시 실제 DOM에서 실행되는 것 방지)
    content.innerHTML =
        `<h1 style="font-family:${font}; font-size:26px; font-weight:600; margin:0 0 10px; color:#1a1a1a; word-break:break-all;">${escapeHtml(entry.title)}</h1>`
        + (entry.subtitle ? `<p style="font-family:${font}; font-size:16px; color:#666; margin:0 0 8px; word-break:break-all;">${escapeHtml(entry.subtitle)}</p>` : '')
        + `<div style="font-size:13px; color:#999; margin:0 0 18px;">${escapeHtml(entry.date || '')}</div>`
        + `<div style="font-family:${font}; font-size:16px; line-height:1.8; white-space:pre-wrap; word-break:break-all; overflow-wrap:break-word; color:#1a1a1a;">${sanitizeEntryHtml(entry.body || '')}</div>`;

    // html2canvas가 밑줄(text-decoration) 위치를 잘못 그리므로 링크는 border-bottom으로 대체
    content.querySelectorAll('a').forEach(link => {
        link.style.textDecoration = 'none';
        link.style.borderBottom = '1px solid #2563EB';
        link.style.paddingBottom = '1px';
    });

    offscreen.appendChild(content);
    document.body.appendChild(offscreen);
    return { offscreen, content };
}

function pdfOptions(filename) {
    return {
        margin: 10,
        filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
            scale: 2,
            useCORS: true,
            // 다크모드에서도 항상 라이트모드 스타일로 저장 (캡처용 복제본에서만 테마 제거 → 화면 깜빡임 없음)
            onclone: (clonedDoc) => { clonedDoc.documentElement.removeAttribute('data-theme'); }
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] }
    };
}

// 파일명에 쓸 수 없는 문자 제거
function sanitizeFilename(name) {
    return String(name || '신앙일지').replace(/[\\/:*?"<>|]/g, '_').trim() || '신앙일지';
}

// 글 하나를 단일 PDF로 다운로드 (선택 모드의 1개 선택, 에디터 다운로드 버튼 공용)
export async function downloadEntryPdf(entry) {
    if (typeof html2pdf === 'undefined') {
        alert('PDF 모듈을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.');
        return;
    }
    const { offscreen, content } = buildPdfContent(entry);
    try {
        await html2pdf().set(pdfOptions(`${sanitizeFilename(entry.title)}.pdf`)).from(content).save();
    } catch (err) {
        console.error('PDF 저장 실패', err);
        alert('PDF 저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
        offscreen.remove();
    }
}

// 선택한 글을 PDF로 다운로드.
// - 1개: 단일 PDF 파일
// - 여러 개: 각 글을 개별 PDF로 만들어 하나의 ZIP으로 압축 다운로드
export async function bulkDownloadPdf() {
    if (typeof html2pdf === 'undefined') {
        alert('PDF 모듈을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.');
        return;
    }
    const selected = getSelectedEntriesInOrder();
    if (selected.length === 0) return;

    if (selected.length > 1 && typeof JSZip === 'undefined') {
        alert('압축(ZIP) 모듈을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.');
        return;
    }

    const pdfBtn = getEl('bulk-pdf-btn');
    if (pdfBtn) {
        pdfBtn.dataset.busy = '1';
        pdfBtn.disabled = true;
        pdfBtn.innerHTML = `<i class="ph ph-spinner" style="animation:spin 1s linear infinite;"></i> 생성 중...`;
    }

    try {
        if (selected.length === 1) {
            // 단일 글: 그대로 PDF 다운로드 (에디터 다운로드와 동일한 스타일)
            await downloadEntryPdf(selected[0]);
        } else {
            // 여러 글: 각각 개별 PDF 생성 → ZIP으로 압축
            const zip = new JSZip();
            const pad = String(selected.length).length; // 정렬 유지를 위한 자리수
            const usedNames = new Set();
            const failedTitles = [];
            for (let i = 0; i < selected.length; i++) {
                const entry = selected[i];
                if (pdfBtn) pdfBtn.innerHTML = `<i class="ph ph-spinner" style="animation:spin 1s linear infinite;"></i> 생성 중... (${i + 1}/${selected.length})`;
                // 한 글이 실패해도 이미 만들어진 나머지 PDF는 버리지 않고 ZIP에 포함
                try {
                    const { offscreen, content } = buildPdfContent(entry);
                    let blob;
                    try {
                        blob = await html2pdf().set(pdfOptions('entry.pdf')).from(content).outputPdf('blob');
                    } finally {
                        offscreen.remove();
                    }
                    // 목록 순서를 보존하고 동일 제목 충돌을 피하기 위해 번호를 접두어로 사용
                    const prefix = String(i + 1).padStart(pad, '0');
                    let name = `${prefix}_${sanitizeFilename(entry.title)}.pdf`;
                    while (usedNames.has(name)) name = `${prefix}_${sanitizeFilename(entry.title)}_${Math.random().toString(36).slice(2, 5)}.pdf`;
                    usedNames.add(name);
                    zip.file(name, blob);
                } catch (entryErr) {
                    console.error('개별 PDF 생성 실패:', entry.title, entryErr);
                    failedTitles.push(entry.title || '제목 없음');
                }
            }
            if (failedTitles.length === selected.length) throw new Error('모든 PDF 생성에 실패했습니다.');
            if (failedTitles.length > 0) {
                alert(`${failedTitles.length}개 글은 PDF 생성에 실패해 제외되었습니다:\n- ${failedTitles.join('\n- ')}`);
            }
            if (pdfBtn) pdfBtn.innerHTML = `<i class="ph ph-spinner" style="animation:spin 1s linear infinite;"></i> 압축 중...`;
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `신앙일지_${selected.length}개.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        }
        exitSelectMode();
    } catch (err) {
        console.error('PDF 저장 실패', err);
        alert('PDF 저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
        if (pdfBtn) {
            delete pdfBtn.dataset.busy;
            pdfBtn.innerHTML = `<i class="ph ph-file-pdf"></i> PDF 저장`;
            updateBulkBar();
        }
    }
}
