import { state } from './state.js';
import { saveEntry } from './data.js';
import { saveToDrive } from './drive.js';
import { openModal } from './ui.js';

let currentSelectedElement = null; 
let lastClickedCell = null; 
let selectionBox = null;
let resizeHandle = null;
let deleteBtn = null;
let resizeBtnGroup = null;
let tableControlGroup = null; 
let autoSaveTimer = null;
let isTurningPage = false;    
let currentBookPageIndex = 0; 
let touchStartX = 0;          
let wheelLockTimer = null;    

// 표 셀 선택 및 리사이징 관련 변수
let selectionStartCell = null;
let isSelectingCells = false;
let mobileLongPressTimer = null;

let isColDragging = false;
let isRowDragging = false;
let resizeTargetTd = null;
let startX, startY, startW, startH;

// [히스토리] 구조적 변경(줄/칸 추가/삭제) 되돌리기를 위한 스택
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 50;

// 현재 에디터 상태를 히스토리에 기록하는 함수
function recordHistory() {
    const editorBody = document.getElementById('editor-body');
    if (!editorBody) return;
    const currentState = editorBody.innerHTML;
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== currentState) {
        undoStack.push(currentState);
        if (undoStack.length > MAX_HISTORY) undoStack.shift();
        redoStack = []; 
    }
}

// 자동 저장 트리거
export async function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        const editBody = document.getElementById('editor-body');
        if (!editBody || state.currentViewMode !== 'default') return;
        await saveEntry(); 
        if (window.gapi && gapi.client && gapi.client.getToken()) await saveToDrive(); 
    }, 2000); 
}

function handleBookWheel(e) {
    if (state.currentViewMode !== 'book') return;
    e.preventDefault(); e.stopPropagation();
    if (wheelLockTimer) clearTimeout(wheelLockTimer);
    if (!isTurningPage && Math.abs(e.deltaY) > 20) {
        turnPage(e.deltaY > 0 ? 1 : -1);
        isTurningPage = true; 
    }
    wheelLockTimer = setTimeout(() => { isTurningPage = false; wheelLockTimer = null; }, 500);
}

function handleBookTouchStart(e) { if (state.currentViewMode === 'book') touchStartX = e.changedTouches[0].screenX; }
function handleBookTouchMove(e) { if (state.currentViewMode === 'book') e.preventDefault(); }
function handleBookTouchEnd(e) {
    if (state.currentViewMode !== 'book' || isTurningPage) return;
    const diff = touchStartX - e.changedTouches[0].screenX;
    if (Math.abs(diff) > 50) {
        turnPage(diff > 0 ? 1 : -1);
        isTurningPage = true; setTimeout(() => isTurningPage = false, 300);
    }
}

function handleBookResize() {
    if (state.currentViewMode === 'book') {
        updateBookLayout();
        const container = document.getElementById('editor-container');
        if(container) container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth);
        updateBookNav();
    }
}

export function turnPage(direction) { 
    const container = document.getElementById('editor-container');
    if (!container) return;
    const stride = Math.floor(container.clientWidth);
    const maxPage = Math.ceil(container.scrollWidth / stride) - 1;
    let nextIndex = Math.max(0, Math.min(maxPage, currentBookPageIndex + direction));
    if (nextIndex === currentBookPageIndex) return;
    currentBookPageIndex = nextIndex;
    container.scrollLeft = currentBookPageIndex * stride;
    updateBookNav();
}

export function jumpToPage(index) {
    const container = document.getElementById('editor-container');
    if (!container) return;
    const stride = Math.floor(container.clientWidth);
    const maxPage = Math.ceil(container.scrollWidth / stride) - 1;
    let nextIndex = Math.max(0, Math.min(maxPage, index));
    currentBookPageIndex = nextIndex;
    container.scrollLeft = currentBookPageIndex * stride;
    updateBookNav();
}

function updateBookLayout() {
    const container = document.getElementById('editor-container');
    if (!container) return;
    container.style.columnWidth = `${Math.floor(container.clientWidth)}px`;
    container.style.columnGap = '0px';
    container.style.height = `${window.innerHeight - 120}px`;
    container.style.overflow = 'hidden';
}

export function updateBookNav() { 
    if (state.currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    if(!container) return;
    const stride = Math.floor(container.clientWidth);
    const totalPages = Math.ceil(container.scrollWidth / stride) || 1; 
    
    document.getElementById('book-nav-left')?.classList.toggle('hidden', currentBookPageIndex <= 0);
    document.getElementById('book-nav-right')?.classList.toggle('hidden', currentBookPageIndex + 1 >= totalPages);
    
    const pageIndicator = document.getElementById('page-indicator');
    if (pageIndicator) { 
        pageIndicator.innerText = `${currentBookPageIndex + 1} / ${totalPages}`; 
        pageIndicator.classList.remove('hidden'); 
    }

    const slider = document.getElementById('book-page-slider');
    if (slider) {
        slider.max = totalPages - 1;
        slider.value = currentBookPageIndex;
    }
}

function linkifyContents(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    let node;
    while(node = walker.nextNode()) nodes.push(node);
    const urlRegex = /((https?:\/\/|www\.)[^\s]+)/g;
    nodes.forEach(node => {
        if (node.parentNode.tagName === 'A' || node.parentNode.isContentEditable) return;
        const text = node.nodeValue;
        if (text.match(urlRegex)) {
            const fragment = document.createDocumentFragment();
            let lastIdx = 0;
            text.replace(urlRegex, (match, url, protocol, offset) => {
                fragment.appendChild(document.createTextNode(text.slice(lastIdx, offset)));
                const a = document.createElement('a'); a.href = protocol === 'www.' ? 'http://' + url : url; a.target = '_blank'; a.textContent = url;
                a.style.textDecoration = 'underline'; a.style.color = '#2563EB'; a.style.cursor = 'pointer';
                fragment.appendChild(a); lastIdx = offset + match.length;
            });
            fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
            node.parentNode.replaceChild(fragment, node);
        }
    });
}

function selectCellRange(startTd, endTd) {
    const startTable = startTd.closest('table');
    const endTable = endTd.closest('table');
    if (startTable !== endTable) return;
    const startR = startTd.parentElement.rowIndex, startC = startTd.cellIndex;
    const endR = endTd.parentElement.rowIndex, endC = endTd.cellIndex;
    const minR = Math.min(startR, endR), maxR = Math.max(startR, endR);
    const minC = Math.min(startC, endC), maxC = Math.max(startC, endC);
    const isSingleCell = (minR === maxR && minC === maxC);

    if (!isSingleCell) startTable.classList.add('selecting-cells');

    startTable.querySelectorAll('td').forEach(td => {
        const r = td.parentElement.rowIndex, c = td.cellIndex;
        if (!isSingleCell && r >= minR && r <= maxR && c >= minC && c <= maxC) {
            td.classList.add('selected-cell');
        } else {
            td.classList.remove('selected-cell');
        }
    });
}

function clearCellSelection() { 
    document.querySelectorAll('td.selected-cell').forEach(td => td.classList.remove('selected-cell')); 
    document.querySelectorAll('table.selecting-cells').forEach(t => t.classList.remove('selecting-cells'));
}

function focusCell(cell) {
    if (!cell) return;
    cell.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true); 
    sel.removeAllRanges();
    sel.addRange(range);
    lastClickedCell = cell; 
}

function setupBasicHandling() {
    const editorBody = document.getElementById('editor-body');
    const editorContainer = document.getElementById('editor-container');
    if (!editorBody) return;

    // [핀포인트 수정] 붙여넣기 시 표 구조 제거 로직 추가
    editorBody.onpaste = (e) => {
        const html = e.clipboardData.getData('text/html');
        if (html && html.includes('<table')) {
            e.preventDefault();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const cells = doc.querySelectorAll('td');
            let combinedContent = "";
            if (cells.length > 0) {
                cells.forEach((cell, idx) => {
                    combinedContent += cell.innerHTML + (idx < cells.length - 1 ? " " : "");
                });
                document.execCommand('insertHTML', false, combinedContent);
            } else {
                document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
            }
            recordHistory();
            triggerAutoSave();
        }
    };

    // 표 테두리 감지
    editorBody.onmousemove = (e) => {
        if (!editorBody.isContentEditable || isColDragging || isRowDragging) return;
        const td = e.target.closest('td');
        if (!td) return;

        const rect = td.getBoundingClientRect();
        const padding = 10;
        const nearRight = (e.clientX > rect.right - padding);
        const nearBottom = (e.clientY > rect.bottom - padding);

        if (nearRight) td.style.cursor = 'col-resize';
        else if (nearBottom) td.style.cursor = 'row-resize';
        else td.style.cursor = 'text';
    };

    editorBody.onmousedown = (e) => {
        if (!editorBody.isContentEditable) return;
        const td = e.target.closest('td');
        
        if (td) {
            if (td.style.cursor === 'col-resize') {
                isColDragging = true; resizeTargetTd = td; startX = e.clientX; startW = td.offsetWidth; e.preventDefault(); return;
            } else if (td.style.cursor === 'row-resize') {
                isRowDragging = true; resizeTargetTd = td; startY = e.clientY; startH = td.offsetHeight; e.preventDefault(); return;
            }
            isSelectingCells = true; selectionStartCell = td; clearCellSelection(); 
        }
    };

    editorBody.ontouchstart = (e) => {
        if (!editorBody.isContentEditable) return;
        const cell = e.target.closest('td');
        if (cell) {
            mobileLongPressTimer = setTimeout(() => {
                isSelectingCells = true;
                selectionStartCell = cell;
                clearCellSelection();
                if (navigator.vibrate) navigator.vibrate(50);
            }, 600);
        }
    };

    editorBody.ontouchmove = (e) => {
        if (isSelectingCells && selectionStartCell) {
            e.preventDefault(); 
            const touch = e.touches[0];
            const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('td');
            if (cell) selectCellRange(selectionStartCell, cell);
        } else {
            clearTimeout(mobileLongPressTimer);
        }
    };

    editorBody.ontouchend = () => {
        clearTimeout(mobileLongPressTimer);
        isSelectingCells = false;
    };

    window.addEventListener('mousemove', (e) => {
        if (isColDragging && resizeTargetTd) {
            const newWidth = startW + (e.clientX - startX);
            if (newWidth > 30) { resizeTargetTd.style.width = newWidth + 'px'; updateSelectionBox(); }
        } else if (isRowDragging && resizeTargetTd) {
            const newHeight = startH + (e.clientY - startY);
            if (newHeight > 20) { resizeTargetTd.style.height = newHeight + 'px'; updateSelectionBox(); }
        } else if (isSelectingCells && selectionStartCell) {
            const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('td');
            if (cell) {
                if (cell !== selectionStartCell) window.getSelection().removeAllRanges();
                selectCellRange(selectionStartCell, cell); 
            }
        }
    });

    window.addEventListener('mouseup', () => { 
        if (isColDragging || isRowDragging) { recordHistory(); triggerAutoSave(); }
        isColDragging = false; isRowDragging = false; resizeTargetTd = null; isSelectingCells = false; 
        document.querySelectorAll('table.selecting-cells').forEach(t => t.classList.remove('selecting-cells'));
    });

    editorBody.onclick = (e) => {
        if (!editorBody.isContentEditable) return;
        const target = e.target.closest('img, table');
        const cell = e.target.closest('td');
        if (cell) lastClickedCell = cell;
        if (target) {
            const selectedCells = document.querySelectorAll('td.selected-cell');
            if (selectedCells.length <= 1) { e.stopPropagation(); e.preventDefault(); selectElement(target); }
        } else {
            hideSelection();
            if (!e.target.closest('td')) clearCellSelection();
        }
    };

    editorBody.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); formatDoc('undo'); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); formatDoc('redo'); return; }
        
        if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i' || e.key === 'u')) {
            const selectedCells = document.querySelectorAll('td.selected-cell');
            if (selectedCells.length > 0) { e.preventDefault(); const cmd = e.key === 'b' ? 'bold' : e.key === 'i' ? 'italic' : 'underline'; formatDoc(cmd); return; }
        }

        if (e.key === 'Tab') {
            const sel = window.getSelection(); if (!sel.rangeCount) return;
            const container = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
            const cell = container.closest('td');
            if (cell) {
                e.preventDefault(); clearCellSelection(); const row = cell.parentElement;
                let targetCell = e.shiftKey ? cell.previousElementSibling : cell.nextElementSibling;
                if (!targetCell && e.shiftKey && row.previousElementSibling) targetCell = row.previousElementSibling.cells[row.previousElementSibling.cells.length - 1];
                else if (!targetCell && !e.shiftKey && row.nextElementSibling) targetCell = row.nextElementSibling.cells[0];
                if (targetCell) focusCell(targetCell);
            }
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const sel = window.getSelection(); if (!sel.rangeCount) return;
            const container = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
            const cell = container.closest('td');
            if (cell) {
                const row = cell.parentElement, colIdx = cell.cellIndex;
                const targetRow = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
                if (targetRow && targetRow.cells[colIdx]) { e.preventDefault(); clearCellSelection(); focusCell(targetRow.cells[colIdx]); }
            }
        }

        if (e.key === 'Delete') {
            const selectedCells = document.querySelectorAll('td.selected-cell');
            if (selectedCells.length > 0) {
                e.preventDefault();
                recordHistory();
                selectedCells.forEach(cell => {
                    const range = document.createRange();
                    range.selectNodeContents(cell);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.execCommand('delete', false, null);
                });
                triggerAutoSave();
                return;
            }
            if (currentSelectedElement) {
                if (currentSelectedElement.tagName !== 'TABLE' && document.activeElement.tagName !== 'TD') {
                    e.preventDefault();
                    recordHistory();
                    deleteSelectedElement();
                }
            }
        }
    };

    let inputTimer;
    editorBody.addEventListener('input', () => { 
        clearTimeout(inputTimer);
        inputTimer = setTimeout(recordHistory, 1000); 
        updateSelectionBox(); triggerAutoSave(); 
    });
    
    // [핀포인트 수정] 에디터 및 표 래퍼 스크롤 발생 시 버튼 위치 동기화
    const syncButtons = () => { if (currentSelectedElement) updateSelectionBox(); };
    editorContainer?.addEventListener('scroll', syncButtons);
    editorBody.addEventListener('scroll', (e) => {
        if (e.target.classList.contains('table-wrapper')) syncButtons();
    }, true);

    document.getElementById('edit-title')?.addEventListener('input', triggerAutoSave);
    document.getElementById('edit-subtitle')?.addEventListener('input', triggerAutoSave);
    window.addEventListener('resize', () => { updateSelectionBox(); if(state.currentViewMode === 'book') handleBookResize(); });
}

function toggleBookEventListeners(enable) {
    const container = document.getElementById('editor-container');
    if (!container) return;
    container.removeEventListener('wheel', handleBookWheel);
    container.removeEventListener('touchstart', handleBookTouchStart);
    container.removeEventListener('touchmove', handleBookTouchMove);
    container.removeEventListener('touchend', handleBookTouchEnd);
    if (enable) {
        container.addEventListener('wheel', handleBookWheel, { passive: false });
        container.addEventListener('touchstart', handleBookTouchStart, { passive: true });
        container.addEventListener('touchmove', handleBookTouchMove, { passive: false });
        container.addEventListener('touchend', handleBookTouchEnd, { passive: true });
    }
}

export function openEditor(isEdit, entryData) { 
    state.isEditMode = isEdit; const writeModal = document.getElementById('write-modal'); openModal(writeModal); writeModal.scrollTop = 0; currentBookPageIndex = 0; setupBasicHandling();
    const catName = state.allCategories.find(c => c.id === state.currentCategory)?.name || '기록';
    document.getElementById('display-category').innerText = catName; document.getElementById('display-date').innerText = entryData ? entryData.date : new Date().toLocaleDateString('ko-KR');
    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');
    if(isEdit && entryData) { state.editingId = entryData.id; editTitle.value = entryData.title || ''; editSubtitle.value = entryData.subtitle || ''; editBody.innerHTML = entryData.body || ''; linkifyContents(editBody); applyFontStyle(entryData.fontFamily || 'Pretendard', entryData.fontSize || 16); }
    else { state.editingId = Date.now().toString(); editTitle.value = ''; editSubtitle.value = ''; editBody.innerHTML = ''; applyFontStyle('Pretendard', 16); setTimeout(() => editTitle.focus(), 100); }
    toggleViewMode('default');
    undoStack = []; redoStack = []; 
}

export function refreshEditorContent() {
    const writeModal = document.getElementById('write-modal');
    if (writeModal.classList.contains('hidden') || !state.editingId) return;
    const latestEntry = state.entries.find(e => e.id === state.editingId);
    if (!latestEntry) return;
    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');
    if (state.currentViewMode !== 'default' || document.activeElement !== editBody) {
        if (editTitle.value !== latestEntry.title) editTitle.value = latestEntry.title || '';
        if (editSubtitle.value !== latestEntry.subtitle) editSubtitle.value = latestEntry.subtitle || '';
        if (editBody.innerHTML !== latestEntry.body) { editBody.innerHTML = latestEntry.body || ''; linkifyContents(editBody); if (state.currentViewMode === 'book') updateBookNav(); }
    }
}

export function toggleViewMode(mode) {
    const container = document.getElementById('editor-container'), writeModal = document.getElementById('write-modal'), editBody = document.getElementById('editor-body'), editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editorToolbar = document.getElementById('editor-toolbar');
    const wasBookMode = state.currentViewMode === 'book', oldScrollTop = container ? container.scrollTop : 0, oldHeight = container ? container.clientHeight : 0, lastPageIndex = currentBookPageIndex;
    state.currentViewMode = mode;
    const btnReadOnly = document.getElementById('btn-readonly'), btnBookMode = document.getElementById('btn-bookmode');
    if(btnReadOnly) btnReadOnly.classList.toggle('active', mode === 'readOnly');
    if(btnBookMode) btnBookMode.classList.toggle('active', mode === 'book');
    if(container) { container.style.height = ''; container.style.overflow = ''; container.style.columnWidth = ''; container.style.columnGap = ''; container.scrollLeft = 0; }
    writeModal.classList.remove('mode-read-only', 'mode-book');
    document.querySelectorAll('.book-nav, #page-indicator, #book-slider-container, #btn-scroll-top').forEach(el => el.classList.add('hidden'));
    hideSelection(); toggleBookEventListeners(false);
    if (mode === 'book') { editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false"; linkifyContents(editBody); writeModal.classList.add('mode-book'); updateBookLayout(); if (!wasBookMode && oldHeight > 0) currentBookPageIndex = Math.floor(oldScrollTop / oldHeight); toggleBookEventListeners(true); updateBookNav(); if (container) container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth); editorToolbar?.classList.add('collapsed'); }
    else if (mode === 'readOnly') { editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false"; linkifyContents(editBody); writeModal.classList.add('mode-read-only'); editorToolbar?.classList.add('collapsed'); if (wasBookMode && container) requestAnimationFrame(() => { container.scrollTop = lastPageIndex * oldHeight; }); }
    else { editTitle.readOnly = false; editSubtitle.readOnly = false; editBody.contentEditable = "true"; editorToolbar?.classList.remove('collapsed'); if (wasBookMode && container) requestAnimationFrame(() => { container.scrollTop = lastPageIndex * oldHeight; }); }
}

function selectElement(el) { currentSelectedElement = el; createSelectionUI(); updateSelectionBox(); }
function hideSelection() { currentSelectedElement = null; if (selectionBox) selectionBox.style.display = 'none'; if (resizeHandle) resizeHandle.style.display = 'none'; if (deleteBtn) deleteBtn.style.display = 'none'; if (resizeBtnGroup) resizeBtnGroup.style.display = 'none'; if(tableControlGroup) tableControlGroup.style.display = 'none'; }

function createSelectionUI() {
    if (!selectionBox) {
        selectionBox = document.createElement('div'); selectionBox.className = 'img-selection-box'; document.body.appendChild(selectionBox);
        resizeHandle = document.createElement('div'); resizeHandle.className = 'resize-handle se'; document.body.appendChild(resizeHandle);
        resizeHandle.onmousedown = (e) => startResize(e);
        deleteBtn = document.createElement('button'); deleteBtn.className = 'img-delete-btn'; deleteBtn.innerHTML = '<i class="ph ph-trash"></i> 삭제'; document.body.appendChild(deleteBtn);
        deleteBtn.onclick = () => { recordHistory(); deleteSelectedElement(); };
        resizeBtnGroup = document.createElement('div'); resizeBtnGroup.className = 'img-resize-group';
        [25, 50, 75, 100].forEach(size => {
            const btn = document.createElement('button'); btn.className = 'img-resize-btn'; btn.innerText = size + '%';
            btn.onclick = () => { if (currentSelectedElement) { recordHistory(); currentSelectedElement.style.width = size + '%'; currentSelectedElement.style.height = 'auto'; updateSelectionBox(); triggerAutoSave(); } };
            resizeBtnGroup.appendChild(btn);
        });
        document.body.appendChild(resizeBtnGroup);
    }
    if (!tableControlGroup) {
        tableControlGroup = document.createElement('div'); tableControlGroup.className = 'img-resize-group'; 
        const createOpBtn = (label, icon, fn) => { const btn = document.createElement('button'); btn.className = 'img-resize-btn'; btn.innerHTML = `<i class="ph ${icon}"></i> ${label}`; btn.onclick = (e) => { e.stopPropagation(); fn(); updateSelectionBox(); triggerAutoSave(); }; return btn; };
        tableControlGroup.appendChild(createOpBtn('줄+', 'ph-rows', addRow)); tableControlGroup.appendChild(createOpBtn('줄-', 'ph-minus', deleteRow)); tableControlGroup.appendChild(createOpBtn('칸+', 'ph-columns', addColumn)); tableControlGroup.appendChild(createOpBtn('칸-', 'ph-minus', deleteColumn));
        document.body.appendChild(tableControlGroup);
    }
    selectionBox.style.display = 'block'; resizeHandle.style.display = 'block'; deleteBtn.style.display = 'flex'; resizeBtnGroup.style.display = 'flex';
    if(tableControlGroup) tableControlGroup.style.display = currentSelectedElement.tagName === 'TABLE' ? 'flex' : 'none';
}

function updateSelectionBox() {
    if (!currentSelectedElement || !selectionBox) return;
    const rect = currentSelectedElement.getBoundingClientRect(), scrollTop = window.scrollY, scrollLeft = window.scrollX;
    
    selectionBox.style.top = (rect.top + scrollTop) + 'px'; 
    selectionBox.style.left = (rect.left + scrollLeft) + 'px'; 
    selectionBox.style.width = rect.width + 'px'; 
    selectionBox.style.height = rect.height + 'px';
    
    resizeHandle.style.top = (rect.bottom + scrollTop - 10) + 'px'; 
    resizeHandle.style.left = (rect.right + scrollLeft - 10) + 'px';

    const centerX = rect.left + scrollLeft + rect.width / 2;
    if (currentSelectedElement.tagName === 'TABLE') {
        tableControlGroup.style.top = (rect.bottom + scrollTop + 15) + 'px';
        tableControlGroup.style.left = centerX + 'px';
        resizeBtnGroup.style.top = (rect.bottom + scrollTop + 55) + 'px';
        resizeBtnGroup.style.left = centerX + 'px';
        deleteBtn.style.top = (rect.bottom + scrollTop + 95) + 'px';
        deleteBtn.style.left = centerX + 'px';
    } else {
        resizeBtnGroup.style.top = (rect.bottom + scrollTop + 15) + 'px';
        resizeBtnGroup.style.left = centerX + 'px';
        deleteBtn.style.top = (rect.bottom + scrollTop + 55) + 'px';
        deleteBtn.style.left = centerX + 'px';
    }
}

function deleteSelectedElement() { if (currentSelectedElement) { currentSelectedElement.remove(); hideSelection(); triggerAutoSave(); } }

let isResizing = false, startX2, startY2, startWidth2, startHeight2;
function startResize(e) { e.preventDefault(); isResizing = true; startX2 = e.clientX; startY2 = e.clientY; startWidth2 = currentSelectedElement.clientWidth; startHeight2 = currentSelectedElement.clientHeight; document.addEventListener('mousemove', resizing); document.addEventListener('mouseup', stopResize); }
function resizing(e) { if (!isResizing || !currentSelectedElement) return; const newWidth = startWidth2 + (e.clientX - startX2), newHeight = startHeight2 + (e.clientY - startY2); if (newWidth > 50) currentSelectedElement.style.width = newWidth + 'px'; if (newHeight > 30) currentSelectedElement.style.height = newHeight + 'px'; updateSelectionBox(); }
function stopResize() { if (isResizing) { recordHistory(); isResizing = false; } document.removeEventListener('mousemove', resizing); document.removeEventListener('mouseup', stopResize); triggerAutoSave(); }

export function addRow() { const table = currentSelectedElement; if (!table || table.tagName !== 'TABLE') return; recordHistory(); const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null, refRow = targetCell ? targetCell.parentElement : table.rows[table.rows.length - 1], colIdx = targetCell ? targetCell.cellIndex : 0, newRow = table.insertRow(refRow.rowIndex + 1), colCount = table.rows[0].cells.length; let cellToFocus = null; for (let i = 0; i < colCount; i++) { const newCell = newRow.insertCell(i); newCell.innerHTML = '<br>'; if (i === colIdx) cellToFocus = newCell; } if (cellToFocus) focusCell(cellToFocus); }
export function deleteRow() { const table = currentSelectedElement; if (!table || table.tagName !== 'TABLE' || table.rows.length <= 1) return; recordHistory(); const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null, refRow = targetCell ? targetCell.parentElement : table.rows[table.rows.length - 1]; table.deleteRow(refRow.rowIndex); lastClickedCell = null; }
export function addColumn() { const table = currentSelectedElement; if (!table || table.tagName !== 'TABLE') return; recordHistory(); const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null, colIdx = targetCell ? targetCell.cellIndex : table.rows[0].cells.length - 1, rowIdx = targetCell ? targetCell.parentElement.rowIndex : 0; let cellToFocus = null; for (let i = 0; i < table.rows.length; i++) { const newCell = table.rows[i].insertCell(colIdx + 1); newCell.innerHTML = '<br>'; if (i === rowIdx) cellToFocus = newCell; } if (cellToFocus) focusCell(cellToFocus); }
export function deleteColumn() { const table = currentSelectedElement; if (!table || table.tagName !== 'TABLE' || table.rows[0].cells.length <= 1) return; recordHistory(); const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null, colIdx = targetCell ? targetCell.cellIndex : table.rows[0].cells.length - 1; for (let i = 0; i < table.rows.length; i++) { table.rows[i].deleteCell(colIdx); } lastClickedCell = null; }

export function createHyperlink() { const selection = window.getSelection(); if (selection.rangeCount > 0 && selection.toString().length > 0) { const url = prompt("연결할 주소(URL)를 입력하세요:", "https://"); if (url && url !== "https://") { recordHistory(); document.execCommand('createLink', false, url); const anchor = selection.anchorNode.parentElement; if (anchor && anchor.tagName === 'A') { anchor.target = '_blank'; anchor.style.color = '#2563EB'; anchor.style.textDecoration = 'underline'; anchor.style.cursor = 'pointer'; } triggerAutoSave(); } } else { alert("링크를 걸 문구를 먼저 드래그하여 선택해주세요."); } }

export function formatDoc(cmd, value = null) { 
    const editor = document.getElementById('editor-body'); if (!editor) return;
    if (cmd === 'undo') { if (undoStack.length > 0) { redoStack.push(editor.innerHTML); editor.innerHTML = undoStack.pop(); triggerAutoSave(); return; } else { document.execCommand('undo', false, null); return; } }
    if (cmd === 'redo') { if (redoStack.length > 0) { undoStack.push(editor.innerHTML); editor.innerHTML = redoStack.pop(); triggerAutoSave(); return; } else { document.execCommand('redo', false, null); return; } }
    recordHistory(); if (!document.activeElement.closest('#editor-body')) editor.focus();
    const selectedCells = document.querySelectorAll('td.selected-cell');
    if (selectedCells.length > 0) { selectedCells.forEach(cell => { const range = document.createRange(); range.selectNodeContents(cell); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); document.execCommand(cmd, false, value); }); } 
    else { document.execCommand(cmd, false, value); }
    triggerAutoSave(); 
}

export function applyFontStyle(f, s) { 
    state.currentFontFamily = f; state.currentFontSize = s; 
    const body = document.getElementById('editor-body'), title = document.getElementById('edit-title'), subtitle = document.getElementById('edit-subtitle');
    const isHand = (f === 'Nanum Pen Script'); const baseSize = isHand ? s + 4 : s;
    if(body) { body.style.fontFamily = f; body.style.fontSize = baseSize + 'px'; }
    if(title) { title.style.fontFamily = f; title.style.fontSize = Math.floor(baseSize * 1.6) + 'px'; }
    if(subtitle) { subtitle.style.fontFamily = f; subtitle.style.fontSize = Math.floor(baseSize * 1.3) + 'px'; }
}

export function changeGlobalFontSize(delta) { state.currentFontSize = Math.max(12, Math.min(60, state.currentFontSize + delta)); applyFontStyle(state.currentFontFamily, state.currentFontSize); triggerAutoSave(); }
export function insertSticker(emoji) { recordHistory(); document.execCommand('insertText', false, emoji); triggerAutoSave(); }
export function insertImage(src) { recordHistory(); document.execCommand('insertImage', false, src); triggerAutoSave(); }

// [수정] 표 생성 시 슬라이드 지원을 위해 .table-wrapper 로 감싸도록 수정
export function insertTable(rows, cols) {
    recordHistory();
    let tableHtml = '<div class="table-wrapper"><table style="width: 100%; table-layout: fixed;"><tbody>';
    for (let i = 0; i < rows; i++) { 
        tableHtml += '<tr>'; 
        for (let j = 0; j < cols; j++) { tableHtml += '<td><br></td>'; } 
        tableHtml += '</tr>'; 
    }
    tableHtml += '</tbody></table></div><p><br></p>';
    const editor = document.getElementById('editor-body'); 
    editor.focus(); 
    document.execCommand('insertHTML', false, tableHtml); 
    triggerAutoSave();
}