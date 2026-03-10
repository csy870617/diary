import { state } from './state.js';
import { saveEntry } from './data.js';
import { saveToDrive } from './drive.js';
import { openModal } from './ui.js';
import { setupLinkPreservation, autoLink } from './utils.js';

let currentSelectedElement = null; 
let lastClickedCell = null; 
let selectionBox = null;
let resizeHandle = null;
let deleteBtn = null;
let resizeBtnGroup = null;
let autoSaveTimer = null;
let isTurningPage = false;    
let currentBookPageIndex = 0; 
let touchStartX = 0;          
let wheelLockTimer = null;    

let selectionStartCell = null;
let isSelectingCells = false;
let mobileLongPressTimer = null;

let isColDragging = false;
let isRowDragging = false;
let resizeTargetTd = null;
let startX, startY, startW, startH;

let savedRange = null; // 표 삽입 시 커서 위치 저장용
let lastLocalEditTime = 0; // 마지막 로컬 편집 시간 (동기화 충돌 방지)

let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 100;
let startTableFontSize = 16;

// Undo/Redo 시스템을 위한 상태
let lastInputTime = 0;
let lastInputType = '';
let isComposing = false;  // IME 조합 중 여부
let pendingSnapshot = null;  // 보류 중인 스냅샷
const TYPING_GROUP_DELAY = 500;  // 타이핑 그룹핑 딜레이 (ms)
const WORD_BREAK_CHARS = [' ', '\n', '\t', '.', ',', '!', '?', ';', ':', '(', ')', '[', ']', '{', '}', '"', "'"];

/**
 * 현재 에디터 상태의 스냅샷 생성 (커서 위치 포함)
 */
function createSnapshot() {
    const editorBody = document.getElementById('editor-body');
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    if (!editorBody) return null;
    
    const selection = window.getSelection();
    let cursorInfo = null;
    
    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        cursorInfo = {
            startPath: getNodePath(editorBody, range.startContainer),
            startOffset: range.startOffset,
            endPath: getNodePath(editorBody, range.endContainer),
            endOffset: range.endOffset,
            isCollapsed: range.collapsed
        };
    }
    
    return {
        body: editorBody.innerHTML,
        title: editTitle?.value || '',
        subtitle: editSubtitle?.value || '',
        cursor: cursorInfo,
        timestamp: Date.now()
    };
}

/**
 * 스냅샷에서 에디터 상태 복원
 */
function restoreSnapshot(snapshot) {
    if (!snapshot) return;
    
    const editorBody = document.getElementById('editor-body');
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    if (!editorBody) return;
    
    // 내용 복원
    editorBody.innerHTML = snapshot.body;
    if (editTitle) editTitle.value = snapshot.title;
    if (editSubtitle) editSubtitle.value = snapshot.subtitle;
    
    // 커서 위치 복원
    if (snapshot.cursor) {
        try {
            const selection = window.getSelection();
            const range = document.createRange();
            
            const startNode = getNodeFromPath(editorBody, snapshot.cursor.startPath);
            const endNode = getNodeFromPath(editorBody, snapshot.cursor.endPath);
            
            if (startNode && endNode) {
                const startOffset = Math.min(snapshot.cursor.startOffset, getMaxOffset(startNode));
                const endOffset = Math.min(snapshot.cursor.endOffset, getMaxOffset(endNode));
                
                range.setStart(startNode, startOffset);
                range.setEnd(endNode, endOffset);
                
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } catch (e) {
            // 커서 복원 실패 시 에디터 끝으로 이동
            editorBody.focus();
            const range = document.createRange();
            range.selectNodeContents(editorBody);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }
}

/**
 * 노드의 경로 배열 생성 (루트부터 해당 노드까지의 인덱스 배열)
 */
function getNodePath(root, node) {
    const path = [];
    let current = node;
    
    while (current && current !== root) {
        const parent = current.parentNode;
        if (!parent) break;
        
        const index = Array.from(parent.childNodes).indexOf(current);
        path.unshift(index);
        current = parent;
    }
    
    return path;
}

/**
 * 경로 배열로부터 노드 찾기
 */
function getNodeFromPath(root, path) {
    if (!path || path.length === 0) return root;
    
    let current = root;
    for (const index of path) {
        if (!current.childNodes || index >= current.childNodes.length) {
            return null;
        }
        current = current.childNodes[index];
    }
    return current;
}

/**
 * 노드의 최대 오프셋 값
 */
function getMaxOffset(node) {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.length;
    }
    return node.childNodes.length;
}

/**
 * 히스토리에 스냅샷 추가 (중복 방지)
 */
function pushToHistory(snapshot) {
    if (!snapshot) return;
    
    // 마지막 스냅샷과 동일하면 추가하지 않음
    if (undoStack.length > 0) {
        const last = undoStack[undoStack.length - 1];
        if (last.body === snapshot.body && 
            last.title === snapshot.title && 
            last.subtitle === snapshot.subtitle) {
            return;
        }
    }
    
    undoStack.push(snapshot);
    if (undoStack.length > MAX_HISTORY) {
        undoStack.shift();
    }
    
    // 새로운 변경이 발생하면 redo 스택 초기화
    redoStack = [];
}

/**
 * 히스토리 기록 (변경 전 상태 저장)
 * @param {string} actionType - 액션 타입 ('typing', 'format', 'delete', 'paste', 'insert' 등)
 */
function recordHistory(actionType = 'unknown') {
    const now = Date.now();
    const currentSnapshot = createSnapshot();
    
    if (!currentSnapshot) return;
    
    // IME 조합 중에는 기록하지 않음
    if (isComposing) {
        pendingSnapshot = currentSnapshot;
        return;
    }
    
    // 타이핑 그룹핑: 짧은 시간 내의 연속 타이핑은 하나로 묶음
    if (actionType === 'typing') {
        const timeDiff = now - lastInputTime;
        
        // 첫 타이핑이거나 시간이 충분히 지났으면 새 히스토리 생성
        if (lastInputType !== 'typing' || timeDiff > TYPING_GROUP_DELAY) {
            pushToHistory(currentSnapshot);
        }
        // 그렇지 않으면 마지막 히스토리 업데이트 (그룹핑)
    } else {
        // 타이핑이 아닌 액션은 항상 새 히스토리
        pushToHistory(currentSnapshot);
    }
    
    lastInputTime = now;
    lastInputType = actionType;
}

/**
 * 변경 전에 호출하여 현재 상태를 저장
 */
function saveBeforeChange(actionType = 'unknown') {
    const snapshot = createSnapshot();
    if (snapshot) {
        pushToHistory(snapshot);
    }
    lastInputType = actionType;
    lastLocalEditTime = Date.now();
}

/**
 * 현재 커서 위치를 저장 (표 삽입 등 모달 열기 전에 호출)
 */
export function saveCurrentSelection() {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        savedRange = selection.getRangeAt(0).cloneRange();
    }
}

/**
 * Undo 실행
 */
function performUndo() {
    const editorBody = document.getElementById('editor-body');
    if (!editorBody) return false;
    
    if (undoStack.length === 0) return false;
    
    // 현재 상태를 redo 스택에 저장
    const currentSnapshot = createSnapshot();
    if (currentSnapshot) {
        redoStack.push(currentSnapshot);
    }
    
    // 이전 상태 복원
    const prevSnapshot = undoStack.pop();
    restoreSnapshot(prevSnapshot);
    
    return true;
}

/**
 * Redo 실행
 */
function performRedo() {
    const editorBody = document.getElementById('editor-body');
    if (!editorBody) return false;
    
    if (redoStack.length === 0) return false;
    
    // 현재 상태를 undo 스택에 저장
    const currentSnapshot = createSnapshot();
    if (currentSnapshot) {
        undoStack.push(currentSnapshot);
    }
    
    // 다음 상태 복원
    const nextSnapshot = redoStack.pop();
    restoreSnapshot(nextSnapshot);
    
    return true;
}

/**
 * 히스토리 초기화
 */
function clearHistory() {
    undoStack = [];
    redoStack = [];
    lastInputTime = 0;
    lastInputType = '';
    pendingSnapshot = null;
}

/**
 * 초기 상태 저장 (에디터 열 때 호출)
 */
function saveInitialState() {
    clearHistory();
    const snapshot = createSnapshot();
    if (snapshot) {
        undoStack.push(snapshot);
    }
}

// 이전 호환성을 위한 함수 (기존 코드에서 호출하는 곳용)
function getCursorOffset(element) {
    const selection = window.getSelection();
    if (selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    return preCaretRange.toString().length;
}

function setCursorOffset(element, offset) {
    const selection = window.getSelection();
    const range = document.createRange();
    let currentPos = 0;
    const nodeStack = [element];
    while (nodeStack.length > 0) {
        const node = nodeStack.pop();
        if (node.nodeType === 3) {
            const nextPos = currentPos + node.length;
            if (offset >= currentPos && offset <= nextPos) {
                range.setStart(node, offset - currentPos);
                range.setEnd(node, offset - currentPos);
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
            currentPos = nextPos;
        } else {
            for (let i = node.childNodes.length - 1; i >= 0; i--) {
                nodeStack.push(node.childNodes[i]);
            }
        }
    }
}

export async function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        const editBody = document.getElementById('editor-body');
        if (!editBody || state.currentViewMode !== 'default') return;
        await saveEntry(); 
        if (window.gapi && gapi.client && gapi.client.getToken()) await saveToDrive(); 
    }, 2000); 
}

/* --- 책 모드 관련 핸들러 --- */
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
    if (pageIndicator) { pageIndicator.innerText = `${currentBookPageIndex + 1} / ${totalPages}`; pageIndicator.classList.remove('hidden'); }
    const slider = document.getElementById('book-page-slider');
    if (slider) { slider.max = totalPages - 1; slider.value = currentBookPageIndex; }
}

function linkifyContents(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const nodes = []; let node; while(node = walker.nextNode()) nodes.push(node);
    const urlRegex = /((https?:\/\/|www\.)[^\s]+)/g;
    nodes.forEach(node => {
        if (node.parentNode.tagName === 'A' || node.parentNode.isContentEditable) return;
        const text = node.nodeValue;
        if (text.match(urlRegex)) {
            const fragment = document.createDocumentFragment(); let lastIdx = 0;
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

/**
 * 표 wrapper에 스크롤 이벤트를 설정하여 모바일에서 스크롤 힌트를 제어합니다.
 */
function setupTableWrapperScroll(container) {
    if (!container) return;
    
    const wrappers = container.querySelectorAll('.table-wrapper');
    wrappers.forEach(wrapper => {
        // 이미 설정된 경우 스킵
        if (wrapper._scrollSetup) return;
        wrapper._scrollSetup = true;
        
        // 스크롤 상태 체크 함수
        const checkScrollEnd = () => {
            const isAtEnd = wrapper.scrollLeft + wrapper.clientWidth >= wrapper.scrollWidth - 5;
            if (isAtEnd) {
                wrapper.classList.add('scrolled-end');
            } else {
                wrapper.classList.remove('scrolled-end');
            }
        };
        
        // 초기 상태 체크
        setTimeout(checkScrollEnd, 100);
        
        // 스크롤 이벤트 리스너
        wrapper.addEventListener('scroll', checkScrollEnd, { passive: true });
        
        // 터치 이벤트로 부드러운 스크롤 지원
        let startX = 0;
        let scrollLeft = 0;
        
        wrapper.addEventListener('touchstart', (e) => {
            startX = e.touches[0].pageX - wrapper.offsetLeft;
            scrollLeft = wrapper.scrollLeft;
        }, { passive: true });
        
        wrapper.addEventListener('touchmove', (e) => {
            if (!startX) return;
            const x = e.touches[0].pageX - wrapper.offsetLeft;
            const walk = (startX - x);
            wrapper.scrollLeft = scrollLeft + walk;
        }, { passive: true });
        
        wrapper.addEventListener('touchend', () => {
            startX = 0;
        }, { passive: true });
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
        if (!isSingleCell && r >= minR && r <= maxR && c >= minC && c <= maxC) td.classList.add('selected-cell');
        else td.classList.remove('selected-cell');
    });
}

function clearCellSelection() { 
    document.querySelectorAll('td.selected-cell').forEach(td => td.classList.remove('selected-cell')); 
    document.querySelectorAll('table.selecting-cells').forEach(t => t.classList.remove('selecting-cells'));
}

function focusCell(cell) {
    if (!cell) return;

    // 셀 선택 해제
    clearCellSelection();

    // 셀에 포커스
    cell.focus();
    
    // 커서를 셀의 시작점에 위치
    const sel = window.getSelection();
    const range = document.createRange();
    
    try {
        // 셀에 내용이 있으면
        if (cell.childNodes.length > 0) {
            const firstChild = cell.childNodes[0];
            if (firstChild.nodeType === Node.TEXT_NODE) {
                // 텍스트 노드면 시작점에 커서
                range.setStart(firstChild, 0);
                range.setEnd(firstChild, 0);
            } else if (firstChild.nodeName === 'BR') {
                // BR 태그면 셀 자체 선택
                range.selectNodeContents(cell);
                range.collapse(true);
            } else {
                // 다른 요소면 그 안에 커서
                range.selectNodeContents(firstChild);
                range.collapse(true);
            }
        } else {
            // 빈 셀이면 셀 자체 선택
            range.selectNodeContents(cell);
            range.collapse(true);
        }
        
        sel.removeAllRanges();
        sel.addRange(range);
    } catch (e) {
        // 에러 발생 시 셀 전체 선택
        range.selectNodeContents(cell);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }
    
    lastClickedCell = cell; 
}

/**
 * 커서가 셀의 끝에 있는지 확인
 */
function isCaretAtEnd(cell) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return true;
    
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return false;
    
    // 셀이 비어있거나 br만 있는 경우
    const text = cell.textContent;
    if (!text || text.trim() === '') return true;
    
    // 셀의 마지막 텍스트 노드 찾기
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
    let lastTextNode = null;
    let node;
    while (node = walker.nextNode()) {
        lastTextNode = node;
    }
    
    if (!lastTextNode) return true;
    
    // 커서가 마지막 텍스트 노드의 끝에 있는지 확인
    if (range.endContainer === lastTextNode && range.endOffset === lastTextNode.length) {
        return true;
    }
    
    // 커서가 셀 자체에 있고 오프셋이 자식 노드 수와 같은 경우
    if (range.endContainer === cell && range.endOffset === cell.childNodes.length) {
        return true;
    }
    
    return false;
}

/**
 * 커서가 셀의 시작에 있는지 확인
 */
function isCaretAtStart(cell) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return true;
    
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return false;
    
    // 셀이 비어있거나 br만 있는 경우
    const text = cell.textContent;
    if (!text || text.trim() === '') return true;
    
    // 셀의 첫 번째 텍스트 노드 찾기
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
    const firstTextNode = walker.nextNode();
    
    if (!firstTextNode) return true;
    
    // 커서가 첫 번째 텍스트 노드의 시작에 있는지 확인
    if (range.startContainer === firstTextNode && range.startOffset === 0) {
        return true;
    }
    
    // 커서가 셀 자체에 있고 오프셋이 0인 경우
    if (range.startContainer === cell && range.startOffset === 0) {
        return true;
    }
    
    return false;
}

let basicHandlingSetup = false;
function setupBasicHandling() {
    const editorBody = document.getElementById('editor-body');
    const editorContainer = document.getElementById('editor-container');
    if (!editorBody) return;
    if (basicHandlingSetup) return;
    basicHandlingSetup = true;

    // 하이퍼링크 보존 기능 설정 (복사/잘라내기/붙여넣기)
    setupLinkPreservation(editorBody, {
        onBeforePaste: () => saveBeforeChange('paste'),
        onAfterPaste: () => triggerAutoSave()
    });

    editorBody.onmousemove = (e) => {
        if (!editorBody.isContentEditable || isColDragging || isRowDragging) return;
        const td = e.target.closest('td'); if (!td) return;
        const rect = td.getBoundingClientRect(); const padding = 10;
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
                saveBeforeChange('resize');
                isColDragging = true;
                resizeTargetTd = td;
                startX = e.clientX;
                // table-layout: fixed에서는 첫 번째 행 셀의 너비가 열 너비를 결정
                const table = td.closest('table');
                const colIdx = td.cellIndex;
                const firstRowCell = (table && table.rows[0]) ? table.rows[0].cells[colIdx] : td;
                startW = firstRowCell ? firstRowCell.offsetWidth : td.offsetWidth;
                e.preventDefault();
                return;
            }
            else if (td.style.cursor === 'row-resize') {
                saveBeforeChange('resize');
                isRowDragging = true;
                resizeTargetTd = td;
                startY = e.clientY;
                startH = td.parentElement.offsetHeight; // tr의 높이 기준
                e.preventDefault();
                return;
            }
            isSelectingCells = true; selectionStartCell = td; clearCellSelection();
        }
    };

    editorBody.ontouchstart = (e) => { if (!editorBody.isContentEditable) return; const cell = e.target.closest('td'); if (cell) { mobileLongPressTimer = setTimeout(() => { isSelectingCells = true; selectionStartCell = cell; clearCellSelection(); if (navigator.vibrate) navigator.vibrate(50); }, 600); } };
    editorBody.ontouchmove = (e) => { if (isSelectingCells && selectionStartCell) { e.preventDefault(); const touch = e.touches[0]; const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('td'); if (cell) selectCellRange(selectionStartCell, cell); } else { clearTimeout(mobileLongPressTimer); } };
    editorBody.ontouchend = () => { clearTimeout(mobileLongPressTimer); isSelectingCells = false; };

    window.addEventListener('mousemove', (e) => {
        if (isColDragging && resizeTargetTd) {
            const newWidth = startW + (e.clientX - startX);
            if (newWidth > 30) {
                const table = resizeTargetTd.closest('table');
                const colIdx = resizeTargetTd.cellIndex;
                // table-layout: fixed에서 첫 번째 행 셀의 width가 열 전체 너비를 결정
                if (table && table.rows[0] && table.rows[0].cells[colIdx]) {
                    table.rows[0].cells[colIdx].style.width = newWidth + 'px';
                }
                resizeTargetTd.style.width = newWidth + 'px';
                updateSelectionBox();
            }
        }
        else if (isRowDragging && resizeTargetTd) {
            const newHeight = startH + (e.clientY - startY);
            if (newHeight > 20) {
                // tr 요소에 높이 설정 (행 전체에 적용)
                const tr = resizeTargetTd.parentElement;
                if (tr) tr.style.height = newHeight + 'px';
                resizeTargetTd.style.height = newHeight + 'px';
                updateSelectionBox();
            }
        }
        else if (isSelectingCells && selectionStartCell) {
            const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('td');
            if (cell && cell !== selectionStartCell) {
                window.getSelection().removeAllRanges();
                selectCellRange(selectionStartCell, cell);
            }
        }
    });

    window.addEventListener('mouseup', () => { if (isColDragging || isRowDragging) { triggerAutoSave(); } isColDragging = false; isRowDragging = false; resizeTargetTd = null; isSelectingCells = false; document.querySelectorAll('table.selecting-cells').forEach(t => t.classList.remove('selecting-cells')); });

    editorBody.onclick = (e) => {
        if (!editorBody.isContentEditable) return;
        const target = e.target.closest('img, table'); 
        const cell = e.target.closest('td');
        
        if (cell) {
            lastClickedCell = cell;
            // 단일 셀 클릭 시 선택 해제하고 일반 편집 모드 유지
            clearCellSelection();
            // 셀 클릭 시 해당 표를 자동으로 선택하여 플로팅 UI 표시
            const table = cell.closest('table');
            if (table && currentSelectedElement !== table) {
                selectTableFromCell(cell);
            }
        }
        
        if (target) { 
            const selectedCells = document.querySelectorAll('td.selected-cell'); 
            if (selectedCells.length <= 1) { 
                e.stopPropagation(); 
                e.preventDefault(); 
                selectElement(target); 
            } 
        } else if (!cell) { 
            // 셀 외부를 클릭하면 선택 해제
            hideSelection(); 
            clearCellSelection(); 
        }
    };

    editorBody.onkeydown = (e) => {
        // Ctrl+Z / Cmd+Z: Undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { 
            e.preventDefault(); 
            formatDoc('undo'); 
            return; 
        }
        // Ctrl+Y / Cmd+Y 또는 Ctrl+Shift+Z / Cmd+Shift+Z: Redo
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { 
            e.preventDefault(); 
            formatDoc('redo'); 
            return; 
        }
        
        // 표 셀 내에서 Tab과 화살표 키 처리
        let currentCell = null;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            let node = sel.getRangeAt(0).startContainer;
            if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
            currentCell = node?.closest ? node.closest('td') : null;
        }
        
        if (!currentCell) {
            // 셀이 아닌 곳에서는 기본 동작
            handleNonCellKeys(e);
            return;
        }
        
        const table = currentCell.closest('table');
        if (!table) {
            handleNonCellKeys(e);
            return;
        }
        
        const rowIdx = currentCell.parentElement.rowIndex;
        const colIdx = currentCell.cellIndex;
        const logicalColIdx = getCellColumnIndex(currentCell);
        const maxRow = table.rows.length - 1;
        const currentRowCells = table.rows[rowIdx].cells.length - 1;

        // Tab: 오른쪽 셀로 이동
        if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();

            let nextCell = null;
            if (colIdx < currentRowCells) {
                // 오른쪽 셀로
                nextCell = table.rows[rowIdx].cells[colIdx + 1];
            } else if (rowIdx < maxRow) {
                // 다음 줄 첫 셀로
                nextCell = table.rows[rowIdx + 1].cells[0];
            } else {
                // 마지막 셀에서 Tab - 새 줄 추가
                currentSelectedElement = table;
                lastClickedCell = currentCell;
                addRow();
                nextCell = table.rows[rowIdx + 1]?.cells[0];
            }

            if (nextCell) {
                focusCell(nextCell);
            }
            return;
        }

        // Shift+Tab: 왼쪽 셀로 이동
        if (e.key === 'Tab' && e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();

            let prevCell = null;
            if (colIdx > 0) {
                prevCell = table.rows[rowIdx].cells[colIdx - 1];
            } else if (rowIdx > 0) {
                const prevRow = table.rows[rowIdx - 1];
                prevCell = prevRow.cells[prevRow.cells.length - 1];
            }

            if (prevCell) {
                focusCell(prevCell);
            }
            return;
        }

        // 화살표 아래: 아래 셀로 이동
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            if (rowIdx < maxRow) {
                const nextCell = getCellAt(table, rowIdx + 1, logicalColIdx);
                if (nextCell) {
                    focusCell(nextCell);
                }
            }
            return;
        }

        // 화살표 위: 위 셀로 이동
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            if (rowIdx > 0) {
                const prevCell = getCellAt(table, rowIdx - 1, logicalColIdx);
                if (prevCell) {
                    focusCell(prevCell);
                }
            }
            return;
        }

        // 화살표 오른쪽: 셀 끝에서 오른쪽 셀로 이동
        if (e.key === 'ArrowRight' && colIdx < currentRowCells) {
            if (isCaretAtEnd(currentCell)) {
                e.preventDefault();
                e.stopPropagation();
                const nextCell = table.rows[rowIdx].cells[colIdx + 1];
                if (nextCell) {
                    focusCell(nextCell);
                }
                return;
            }
        }

        // 화살표 왼쪽: 셀 시작에서 왼쪽 셀로 이동
        if (e.key === 'ArrowLeft' && colIdx > 0) {
            if (isCaretAtStart(currentCell)) {
                e.preventDefault();
                e.stopPropagation();
                const prevCell = table.rows[rowIdx].cells[colIdx - 1];
                if (prevCell) {
                    focusCell(prevCell);
                }
                return;
            }
        }
        
        // 나머지 키는 기본 동작
        handleNonCellKeys(e);
    };
    
    // 셀이 아닌 곳에서의 키 처리
    function handleNonCellKeys(e) {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        
        // Delete 키로 선택된 셀 또는 요소 삭제
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedCells.length > 1) {
                e.preventDefault();
                saveBeforeChange('delete');
                selectedCells.forEach(cell => {
                    cell.innerHTML = '<br>';
                });
                triggerAutoSave();
                return;
            }
            if (currentSelectedElement && currentSelectedElement.tagName !== 'TABLE' && document.activeElement.tagName !== 'TD') { 
                e.preventDefault(); 
                saveBeforeChange('delete'); 
                deleteSelectedElement(); 
                return;
            }
        }
        
        // 일반 타이핑 시 히스토리 기록 (단어 경계에서)
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
            if (WORD_BREAK_CHARS.includes(e.key)) {
                saveBeforeChange('typing');
            }
        }
    }

    // IME 조합 이벤트 (한글 등)
    editorBody.addEventListener('compositionstart', () => {
        isComposing = true;
        // 조합 시작 전 상태 저장
        pendingSnapshot = createSnapshot();
    });
    
    editorBody.addEventListener('compositionend', () => {
        isComposing = false;
        // 조합 완료 후 히스토리에 저장
        if (pendingSnapshot) {
            pushToHistory(pendingSnapshot);
            pendingSnapshot = null;
        }
        lastInputTime = Date.now();
        lastInputType = 'typing';
    });

    // input 이벤트: 타이핑 그룹핑 적용
    let inputTimer;
    editorBody.addEventListener('input', (e) => { 
        clearTimeout(inputTimer); 
        
        // IME 조합 중이 아닐 때만 처리
        if (!isComposing) {
            // 일정 시간 후에 히스토리 기록 (타이핑 멈춤 감지)
            inputTimer = setTimeout(() => {
                recordHistory('typing');
            }, TYPING_GROUP_DELAY);
        }
        
        updateSelectionBox(); 
        triggerAutoSave(); 
    });
    
    const syncButtons = () => { if (currentSelectedElement) updateSelectionBox(); };
    editorContainer?.addEventListener('scroll', syncButtons);
    editorBody.addEventListener('scroll', (e) => { if (e.target.classList.contains('table-wrapper')) syncButtons(); }, true);
    
    // 제목/소제목도 Undo 히스토리에 포함
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    
    let titleTimer, subtitleTimer;
    editTitle?.addEventListener('input', () => { 
        clearTimeout(titleTimer);
        titleTimer = setTimeout(() => saveBeforeChange('title'), TYPING_GROUP_DELAY);
        triggerAutoSave(); 
    });
    editTitle?.addEventListener('focus', () => saveBeforeChange('title'));
    
    editSubtitle?.addEventListener('input', () => { 
        clearTimeout(subtitleTimer);
        subtitleTimer = setTimeout(() => saveBeforeChange('subtitle'), TYPING_GROUP_DELAY);
        triggerAutoSave(); 
    });
    editSubtitle?.addEventListener('focus', () => saveBeforeChange('subtitle'));
    
    window.addEventListener('resize', () => { updateSelectionBox(); if(state.currentViewMode === 'book') handleBookResize(); });
}

export function openEditor(isEdit, entryData) { 
    state.isEditMode = isEdit; const writeModal = document.getElementById('write-modal'); openModal(writeModal); writeModal.scrollTop = 0; currentBookPageIndex = 0; setupBasicHandling();
    const catName = state.allCategories.find(c => c.id === state.currentCategory)?.name || '기록';
    document.getElementById('display-category').innerText = catName; document.getElementById('display-date').innerText = entryData ? entryData.date : new Date().toLocaleDateString('ko-KR');
    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');
    
    if(isEdit && entryData) { 
        state.editingId = entryData.id; 
        editTitle.value = entryData.title || ''; 
        editSubtitle.value = entryData.subtitle || ''; 
        editBody.innerHTML = entryData.body || ''; 
        linkifyContents(editBody);
        setupTableWrapperScroll(editBody);
        state.currentFontFamily = entryData.fontFamily || 'Pretendard';
        state.currentFontSize = entryData.fontSize || 16;
        applyFontStyle(state.currentFontFamily, state.currentFontSize); 
    }
    else { 
        state.editingId = Date.now().toString(); 
        editTitle.value = ''; editSubtitle.value = ''; editBody.innerHTML = ''; 
        state.currentFontFamily = 'Pretendard';
        state.currentFontSize = 16;
        applyFontStyle('Pretendard', 16); 
        setTimeout(() => editTitle.focus(), 100); 
    }
    
    const sizeInput = document.getElementById('font-size-input');
    if (sizeInput) sizeInput.value = state.currentFontSize;
    const fontSelect = document.getElementById('font-selector');
    if (fontSelect) fontSelect.value = state.currentFontFamily;

    toggleViewMode('default');
    
    // 초기 상태 저장 (Undo 히스토리 시작점)
    saveInitialState();
}

export function refreshEditorContent() {
    const writeModal = document.getElementById('write-modal');
    if (writeModal.classList.contains('hidden') || !state.editingId) return;
    // 최근 로컬 편집 후 5초 이내이면 동기화로 인한 덮어쓰기 방지
    if (Date.now() - lastLocalEditTime < 5000) return;
    // 표 편집 모달이 열려있으면 덮어쓰기 방지
    const tableModal = document.getElementById('table-modal');
    if (tableModal && !tableModal.classList.contains('hidden')) return;
    const latestEntry = state.entries.find(e => e.id === state.editingId);
    if (!latestEntry) return;
    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');
    if (state.currentViewMode !== 'default' || document.activeElement !== editBody) {
        if (editTitle.value !== latestEntry.title) editTitle.value = latestEntry.title || '';
        if (editSubtitle.value !== latestEntry.subtitle) editSubtitle.value = latestEntry.subtitle || '';
        if (editBody.innerHTML !== latestEntry.body) { editBody.innerHTML = latestEntry.body || ''; linkifyContents(editBody); setupTableWrapperScroll(editBody); if (state.currentViewMode === 'book') updateBookNav(); }
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
    hideSelection(); 
    toggleBookEventListeners(mode === 'book');
    if (mode === 'book') { editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false"; linkifyContents(editBody); writeModal.classList.add('mode-book'); updateBookLayout(); if (!wasBookMode && oldHeight > 0) currentBookPageIndex = Math.floor(oldScrollTop / oldHeight); updateBookNav(); if (container) container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth); editorToolbar?.classList.add('collapsed'); }
    else if (mode === 'readOnly') { editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false"; linkifyContents(editBody); writeModal.classList.add('mode-read-only'); editorToolbar?.classList.add('collapsed'); if (wasBookMode && container) requestAnimationFrame(() => { container.scrollTop = lastPageIndex * oldHeight; }); }
    else { editTitle.readOnly = false; editSubtitle.readOnly = false; editBody.contentEditable = "true"; editorToolbar?.classList.remove('collapsed'); if (wasBookMode && container) requestAnimationFrame(() => { container.scrollTop = lastPageIndex * oldHeight; }); }
}

export function formatDoc(cmd, value = null) { 
    const editor = document.getElementById('editor-body'); if (!editor) return;

    if (cmd === 'undo') {
        if (performUndo()) {
            triggerAutoSave();
        }
        return;
    }
    if (cmd === 'redo') {
        if (performRedo()) {
            triggerAutoSave();
        }
        return;
    }

    saveBeforeChange('format'); 
    if (!document.activeElement.closest('#editor-body')) editor.focus();

    if (cmd.startsWith('justify')) {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        const alignMap = { 'justifyLeft': 'left', 'justifyCenter': 'center', 'justifyRight': 'right' };
        const alignValue = alignMap[cmd];
        if (selectedCells.length > 0) { selectedCells.forEach(cell => cell.style.textAlign = alignValue); } 
        else { const selection = window.getSelection(); const td = selection.anchorNode?.nodeType === 3 ? selection.anchorNode.parentElement.closest('td') : selection.anchorNode.closest('td'); if (td) td.style.textAlign = alignValue; else document.execCommand(cmd, false, value); }
    } else {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length > 0) {
            selectedCells.forEach(cell => {
                const range = document.createRange(); range.selectNodeContents(cell);
                const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
                document.execCommand(cmd, false, value);
            });
        } else { document.execCommand(cmd, false, value); }
    }
    triggerAutoSave(); 
}

export function changeGlobalFontSize(newSize) {
    const selection = window.getSelection();
    const size = parseInt(newSize);
    if (isNaN(size)) return;
    
    state.currentFontSize = size;
    saveBeforeChange('fontSize');

    if (selection.rangeCount > 0 && selection.toString().length > 0) {
        document.execCommand('fontSize', false, '7'); 
        const fontTags = document.querySelectorAll('font[size="7"]');
        fontTags.forEach(t => {
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            span.innerHTML = t.innerHTML;
            t.parentNode.replaceChild(span, t);
        });
    } else {
        const body = document.getElementById('editor-body');
        if(body) body.style.fontSize = size + 'px';
    }
    triggerAutoSave(); 
}

export function changeGlobalFontFamily(newFont) {
    const selection = window.getSelection();
    state.currentFontFamily = newFont;
    saveBeforeChange('fontFamily');

    if (selection.rangeCount > 0 && selection.toString().length > 0) {
        document.execCommand('fontName', false, 'temp_font');
        const fontTags = document.querySelectorAll('font[face="temp_font"]');
        fontTags.forEach(t => {
            const span = document.createElement('span');
            span.style.fontFamily = newFont;
            span.innerHTML = t.innerHTML;
            t.parentNode.replaceChild(span, t);
        });
    } else {
        applyFontStyle(newFont, state.currentFontSize);
    }
    triggerAutoSave();
}

/**
 * [중요] 제목과 소제목은 글꼴만 변경하고 크기는 고정
 */
export function applyFontStyle(f, s) { 
    state.currentFontFamily = f; state.currentFontSize = s; 
    const body = document.getElementById('editor-body'), title = document.getElementById('edit-title'), subtitle = document.getElementById('edit-subtitle');
    const isHand = (f === 'Nanum Pen Script'); const baseSize = isHand ? s + 4 : s;
    
    if(body) { 
        body.style.fontFamily = f; 
        body.style.fontSize = baseSize + 'px'; 
    }
    // 제목과 소제목은 글꼴만 업데이트 (크기는 CSS !important로 고정됨)
    if(title) { 
        title.style.fontFamily = f; 
    }
    if(subtitle) { 
        subtitle.style.fontFamily = f; 
    }
}

/* --- 리사이징 및 기타 유틸리티 --- */
function selectElement(el) { currentSelectedElement = el; createSelectionUI(); updateSelectionBox(); }
function hideSelection() { 
    currentSelectedElement = null; 
    ['img-selection-box','resize-handle','img-delete-btn','img-resize-group'].forEach(cls => { 
        document.querySelectorAll('.'+cls).forEach(e => e.style.display = 'none'); 
    }); 
    // 툴바의 표 편집 버튼 숨김
    const toolbarTableEditBtn = document.getElementById('toolbar-table-edit-btn');
    if (toolbarTableEditBtn) toolbarTableEditBtn.style.display = 'none';
}

/**
 * 현재 커서가 있는 셀의 표를 선택
 */
function selectTableFromCell(cell) {
    if (!cell) return;
    const table = cell.closest('table');
    if (table) {
        currentSelectedElement = table;
        lastClickedCell = cell;
        createSelectionUI();
        updateSelectionBox();
    }
}

function createSelectionUI() {
    if (!selectionBox) {
        selectionBox = document.createElement('div'); selectionBox.className = 'img-selection-box'; document.body.appendChild(selectionBox);
        resizeHandle = document.createElement('div'); resizeHandle.className = 'resize-handle se'; document.body.appendChild(resizeHandle);
        resizeHandle.onmousedown = (e) => startResize(e);
        resizeHandle.ontouchstart = (e) => startResizeTouch(e);
        deleteBtn = document.createElement('button'); deleteBtn.className = 'img-delete-btn'; deleteBtn.innerHTML = '<i class="ph ph-trash"></i> 삭제'; document.body.appendChild(deleteBtn);
        deleteBtn.onclick = () => { saveBeforeChange('delete'); deleteSelectedElement(); };
        resizeBtnGroup = document.createElement('div'); resizeBtnGroup.className = 'img-resize-group';
        [25, 50, 75, 100].forEach(size => { 
            const btn = document.createElement('button'); 
            btn.className = 'img-resize-btn'; 
            btn.innerText = size + '%'; 
            btn.onclick = () => { 
                if (currentSelectedElement) { 
                    saveBeforeChange('resize'); 
                    currentSelectedElement.style.width = size + '%'; 
                    currentSelectedElement.style.height = 'auto'; 
                    // 표인 경우 table-layout도 설정
                    if (currentSelectedElement.tagName === 'TABLE') {
                        currentSelectedElement.style.tableLayout = 'fixed';
                    }
                    updateSelectionBox(); 
                    triggerAutoSave(); 
                } 
            }; 
            resizeBtnGroup.appendChild(btn); 
        });
        document.body.appendChild(resizeBtnGroup);
    }
    selectionBox.style.display = 'block'; resizeHandle.style.display = 'block'; deleteBtn.style.display = 'flex'; resizeBtnGroup.style.display = 'flex';
    
    // 툴바의 표 편집 버튼 표시/숨김
    const toolbarTableEditBtn = document.getElementById('toolbar-table-edit-btn');
    if (toolbarTableEditBtn) {
        toolbarTableEditBtn.style.display = currentSelectedElement.tagName === 'TABLE' ? 'flex' : 'none';
    }
}
function updateSelectionBox() {
    if (!currentSelectedElement || !selectionBox) return;
    const rect = currentSelectedElement.getBoundingClientRect(), scrollTop = window.scrollY, scrollLeft = window.scrollX;
    selectionBox.style.top = (rect.top + scrollTop) + 'px'; selectionBox.style.left = (rect.left + scrollLeft) + 'px'; selectionBox.style.width = rect.width + 'px'; selectionBox.style.height = rect.height + 'px';
    resizeHandle.style.top = (rect.bottom + scrollTop - 10) + 'px'; resizeHandle.style.left = (rect.right + scrollLeft - 10) + 'px';
    const centerX = rect.left + scrollLeft + rect.width / 2;
    if (currentSelectedElement.tagName === 'TABLE') {
        resizeBtnGroup.style.top = (rect.bottom + scrollTop + 15) + 'px'; resizeBtnGroup.style.left = centerX + 'px';
        deleteBtn.style.top = (rect.bottom + scrollTop + 55) + 'px'; deleteBtn.style.left = centerX + 'px';
    } else {
        resizeBtnGroup.style.top = (rect.bottom + scrollTop + 15) + 'px'; resizeBtnGroup.style.left = centerX + 'px';
        deleteBtn.style.top = (rect.bottom + scrollTop + 55) + 'px'; deleteBtn.style.left = centerX + 'px';
    }
}
function deleteSelectedElement() { if (currentSelectedElement) { currentSelectedElement.remove(); hideSelection(); triggerAutoSave(); } }
let isResizing = false, startX2, startY2, startWidth2, startHeight2;

function startResize(e) { 
    e.preventDefault(); 
    saveBeforeChange('resize'); 
    isResizing = true; 
    startX2 = e.clientX; 
    startY2 = e.clientY; 
    startWidth2 = currentSelectedElement.clientWidth; 
    startHeight2 = currentSelectedElement.clientHeight; 
    if (currentSelectedElement.tagName === 'TABLE') { 
        startTableFontSize = parseInt(window.getComputedStyle(currentSelectedElement).fontSize) || 16; 
        currentSelectedElement.style.tableLayout = 'fixed';
    } 
    document.addEventListener('mousemove', resizing); 
    document.addEventListener('mouseup', stopResize); 
}

function startResizeTouch(e) {
    e.preventDefault();
    saveBeforeChange('resize');
    isResizing = true;
    const touch = e.touches[0];
    startX2 = touch.clientX;
    startY2 = touch.clientY;
    startWidth2 = currentSelectedElement.clientWidth;
    startHeight2 = currentSelectedElement.clientHeight;
    if (currentSelectedElement.tagName === 'TABLE') {
        startTableFontSize = parseInt(window.getComputedStyle(currentSelectedElement).fontSize) || 16;
        currentSelectedElement.style.tableLayout = 'fixed';
    }
    document.addEventListener('touchmove', resizingTouch, { passive: false });
    document.addEventListener('touchend', stopResizeTouch);
}

function resizing(e) { 
    if (!isResizing || !currentSelectedElement) return; 
    const deltaX = e.clientX - startX2, newWidth = startWidth2 + deltaX, scaleRatio = newWidth / startWidth2, newHeight = startHeight2 + (e.clientY - startY2); 
    if (newWidth > 50) { 
        currentSelectedElement.style.width = newWidth + 'px'; 
        if (currentSelectedElement.tagName === 'TABLE') { 
            currentSelectedElement.style.fontSize = (startTableFontSize * scaleRatio) + 'px'; 
        } 
    } 
    if (newHeight > 30) currentSelectedElement.style.height = newHeight + 'px'; 
    updateSelectionBox(); 
}

function resizingTouch(e) {
    if (!isResizing || !currentSelectedElement) return;
    e.preventDefault();
    const touch = e.touches[0];
    const deltaX = touch.clientX - startX2, newWidth = startWidth2 + deltaX, scaleRatio = newWidth / startWidth2, newHeight = startHeight2 + (touch.clientY - startY2);
    if (newWidth > 50) {
        currentSelectedElement.style.width = newWidth + 'px';
        if (currentSelectedElement.tagName === 'TABLE') {
            currentSelectedElement.style.fontSize = (startTableFontSize * scaleRatio) + 'px';
        }
    }
    if (newHeight > 30) currentSelectedElement.style.height = newHeight + 'px';
    updateSelectionBox();
}

function stopResize() { 
    isResizing = false; 
    document.removeEventListener('mousemove', resizing); 
    document.removeEventListener('mouseup', stopResize); 
    triggerAutoSave(); 
}

function stopResizeTouch() {
    isResizing = false;
    document.removeEventListener('touchmove', resizingTouch);
    document.removeEventListener('touchend', stopResizeTouch);
    triggerAutoSave();
}

export function addRow() {
    const table = currentSelectedElement;
    if (!table || table.tagName !== 'TABLE') return;
    saveBeforeChange('tableEdit');
    const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null;
    const refRow = targetCell ? targetCell.parentElement : table.rows[table.rows.length - 1];
    const colIdx = targetCell ? targetCell.cellIndex : 0;
    const newRow = table.insertRow(refRow.rowIndex + 1);
    const colCount = table.rows[0].cells.length;
    let cellToFocus = null;
    for (let i = 0; i < colCount; i++) {
        const newCell = newRow.insertCell(i);
        newCell.innerHTML = '<br>';
        if (i === colIdx) cellToFocus = newCell;
    }
    if (cellToFocus) focusCell(cellToFocus);
    triggerAutoSave();
}

export function deleteRow() {
    const table = currentSelectedElement;
    if (!table || table.tagName !== 'TABLE' || table.rows.length <= 1) return;
    saveBeforeChange('tableEdit');
    const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null;
    const refRow = targetCell ? targetCell.parentElement : table.rows[table.rows.length - 1];
    const rowIdx = refRow.rowIndex;
    const colIdx = targetCell ? targetCell.cellIndex : 0;
    table.deleteRow(rowIdx);
    // 삭제 후 인접 셀로 커서 이동
    const newRowIdx = Math.min(rowIdx, table.rows.length - 1);
    if (newRowIdx >= 0 && table.rows[newRowIdx]) {
        const newCell = table.rows[newRowIdx].cells[Math.min(colIdx, table.rows[newRowIdx].cells.length - 1)];
        if (newCell) {
            focusCell(newCell);
            lastClickedCell = newCell;
        }
    }
    triggerAutoSave();
}

export function addColumn() {
    const table = currentSelectedElement;
    if (!table || table.tagName !== 'TABLE') return;
    saveBeforeChange('tableEdit');
    const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null;
    const colIdx = targetCell ? targetCell.cellIndex : table.rows[0].cells.length - 1;
    const rowIdx = targetCell ? targetCell.parentElement.rowIndex : 0;
    let cellToFocus = null;
    for (let i = 0; i < table.rows.length; i++) {
        const newCell = table.rows[i].insertCell(colIdx + 1);
        newCell.innerHTML = '<br>';
        if (i === rowIdx) cellToFocus = newCell;
    }
    if (cellToFocus) focusCell(cellToFocus);
    triggerAutoSave();
}

export function deleteColumn() {
    const table = currentSelectedElement;
    if (!table || table.tagName !== 'TABLE' || table.rows[0].cells.length <= 1) return;
    saveBeforeChange('tableEdit');
    const targetCell = (lastClickedCell && table.contains(lastClickedCell)) ? lastClickedCell : null;
    const colIdx = targetCell ? targetCell.cellIndex : table.rows[0].cells.length - 1;
    const rowIdx = targetCell ? targetCell.parentElement.rowIndex : 0;
    for (let i = 0; i < table.rows.length; i++) {
        table.rows[i].deleteCell(colIdx);
    }
    // 삭제 후 인접 셀로 커서 이동
    const newColIdx = Math.min(colIdx, table.rows[0].cells.length - 1);
    if (newColIdx >= 0 && table.rows[rowIdx]) {
        const newCell = table.rows[rowIdx].cells[newColIdx];
        if (newCell) {
            focusCell(newCell);
            lastClickedCell = newCell;
        }
    }
    triggerAutoSave();
}

/**
 * 선택된 셀들을 합치기
 */
export function mergeCells() {
    const selectedCells = document.querySelectorAll('td.selected-cell');
    if (selectedCells.length < 2) {
        alert('합칠 셀을 2개 이상 선택해주세요.\n(셀을 드래그하여 선택)');
        return;
    }
    
    const table = selectedCells[0].closest('table');
    if (!table) return;
    
    // 선택된 셀들의 행/열 인덱스 수집
    let minRow = Infinity, maxRow = -1, minCol = Infinity, maxCol = -1;
    const cellsInfo = [];
    
    selectedCells.forEach(cell => {
        const rowIdx = cell.parentElement.rowIndex;
        const colIdx = cell.cellIndex;
        
        minRow = Math.min(minRow, rowIdx);
        maxRow = Math.max(maxRow, rowIdx);
        minCol = Math.min(minCol, colIdx);
        maxCol = Math.max(maxCol, colIdx);
        
        cellsInfo.push({ cell, rowIdx, colIdx });
    });
    
    // 직사각형 영역 확인
    const expectedCount = (maxRow - minRow + 1) * (maxCol - minCol + 1);
    if (selectedCells.length !== expectedCount) {
        alert('직사각형 형태로만 셀을 합칠 수 있습니다.');
        return;
    }
    
    saveBeforeChange('mergeCell');
    
    // 내용 수집 (행 순서대로)
    let mergedContent = '';
    cellsInfo.sort((a, b) => a.rowIdx - b.rowIdx || a.colIdx - b.colIdx);
    
    cellsInfo.forEach(info => {
        const content = info.cell.innerHTML.trim();
        if (content && content !== '<br>') {
            if (mergedContent) mergedContent += ' ';
            mergedContent += content;
        }
    });
    
    // 첫 번째 셀 (왼쪽 위)
    const firstCell = table.rows[minRow].cells[minCol];
    if (!firstCell) return;
    
    // 각 행에서 삭제할 셀 수 계산 (colspan)
    const colsToMerge = maxCol - minCol + 1;
    const rowsToMerge = maxRow - minRow + 1;
    
    // 셀 삭제 (역순으로 - 인덱스 변경 방지)
    for (let r = maxRow; r >= minRow; r--) {
        const row = table.rows[r];
        if (!row) continue;
        
        // 같은 행에서 오른쪽부터 삭제
        for (let c = maxCol; c >= minCol; c--) {
            // 첫 번째 셀은 삭제하지 않음
            if (r === minRow && c === minCol) continue;
            
            const cell = row.cells[c];
            if (cell) {
                cell.remove();
            }
        }
    }
    
    // 첫 번째 셀에 colspan, rowspan 설정
    if (colsToMerge > 1) {
        firstCell.colSpan = colsToMerge;
    }
    if (rowsToMerge > 1) {
        firstCell.rowSpan = rowsToMerge;
    }
    
    firstCell.innerHTML = mergedContent || '<br>';
    firstCell.classList.remove('selected-cell');
    
    // 선택 해제
    clearCellSelection();
    focusCell(firstCell);
    triggerAutoSave();
}

/**
 * 셀의 실제 열 인덱스 계산 (colspan 고려)
 */
function getCellColumnIndex(cell) {
    const row = cell.parentElement;
    let colIndex = 0;
    
    for (let i = 0; i < row.cells.length; i++) {
        if (row.cells[i] === cell) {
            return colIndex;
        }
        colIndex += row.cells[i].colSpan || 1;
    }
    
    return colIndex;
}

/**
 * 특정 행/열 위치의 셀 찾기
 */
function getCellAt(table, rowIndex, colIndex) {
    const row = table.rows[rowIndex];
    if (!row) return null;
    
    let currentCol = 0;
    for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        const colspan = cell.colSpan || 1;
        
        if (currentCol === colIndex) {
            return cell;
        }
        if (currentCol < colIndex && currentCol + colspan > colIndex) {
            return cell; // colspan 범위 내
        }
        currentCol += colspan;
    }
    
    return null;
}


export function insertSticker(emoji) { saveBeforeChange('insert'); document.execCommand('insertText', false, emoji); triggerAutoSave(); }
export function insertImage(src) { saveBeforeChange('insert'); document.execCommand('insertImage', false, src); triggerAutoSave(); }
export function insertTable(rows, cols) {
    saveBeforeChange('insert');
    let tableHtml = '<div class="table-wrapper"><table><tbody>';
    for (let i = 0; i < rows; i++) {
        tableHtml += '<tr>';
        for (let j = 0; j < cols; j++) {
            tableHtml += '<td><br></td>';
        }
        tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table></div><p><br></p>';
    const editor = document.getElementById('editor-body');
    editor.focus();

    // 저장된 커서 위치가 있으면 복원하여 해당 위치에 표 삽입
    if (savedRange) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(savedRange);
        savedRange = null;
    }

    document.execCommand('insertHTML', false, tableHtml);

    // 새로 삽입된 표에 스크롤 이벤트 리스너 추가
    setTimeout(() => {
        setupTableWrapperScroll(editor);
    }, 100);

    triggerAutoSave();
}
export function createHyperlink() { const selection = window.getSelection(); if (selection.rangeCount > 0 && selection.toString().length > 0) { const url = prompt("연결할 주소(URL)를 입력하세요:", "https://"); if (url && url !== "https://") { saveBeforeChange('link'); document.execCommand('createLink', false, url); const anchor = selection.anchorNode.parentElement; if (anchor && anchor.tagName === 'A') { anchor.target = '_blank'; anchor.style.color = '#2563EB'; anchor.style.textDecoration = 'underline'; anchor.style.cursor = 'pointer'; } triggerAutoSave(); } } else { alert("링크를 걸 문구를 먼저 드래그하여 선택해주세요."); } }

/**
 * 표 편집 모달 열기 (편집 모드)
 */
export function openTableEditModal() {
    const tableModal = document.getElementById('table-modal');
    const tableModalTitle = document.getElementById('table-modal-title');
    const tableInsertSection = document.getElementById('table-insert-section');
    const tableEditSection = document.getElementById('table-edit-section');
    const btnConfirmTable = document.getElementById('btn-confirm-table');
    
    if (tableModal) {
        tableModalTitle.textContent = '표 편집';
        tableInsertSection.classList.add('hidden');
        tableEditSection.classList.remove('hidden');
        btnConfirmTable.classList.add('hidden');
        tableModal.classList.remove('hidden');
    }
}

/**
 * 표 삽입 모달 열기 (삽입 모드)
 */
export function openTableInsertModal() {
    const tableModal = document.getElementById('table-modal');
    const tableModalTitle = document.getElementById('table-modal-title');
    const tableInsertSection = document.getElementById('table-insert-section');
    const tableEditSection = document.getElementById('table-edit-section');
    const btnConfirmTable = document.getElementById('btn-confirm-table');
    
    if (tableModal) {
        tableModalTitle.textContent = '표 삽입';
        tableInsertSection.classList.remove('hidden');
        tableEditSection.classList.add('hidden');
        btnConfirmTable.classList.remove('hidden');
        tableModal.classList.remove('hidden');
    }
}