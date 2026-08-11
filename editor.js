import { state } from './state.js';
import { saveEntry } from './data.js';
import { saveToDrive, scheduleCloudSync, flushCloudSync } from './drive.js';
import { openModal, hideTransientPopups } from './ui.js';
import { setupLinkPreservation, autoLink, isSafeUrl } from './utils.js';

let currentSelectedElement = null; 
let lastClickedCell = null; 
let selectionBox = null;
let resizeHandle = null;
let deleteBtn = null;
let resizeBtnGroup = null;
let cropBtn = null;
let imgFullscreenOverlay = null; // 이미지 전체화면 보기 오버레이
let autoSaveTimer = null;
let isTurningPage = false;    
let currentBookPageIndex = 0; 
let touchStartX = 0;
let touchStartY = 0;
let bookSwiping = false; // 책 편집 모드에서 가로 스와이프 판정 중
let lastBookColWidth = 0; // 마지막 책 레이아웃 시 컨테이너 폭 (키보드로 높이만 변한 경우 재배치 생략용)
let lastBookViewportH = 0; // 마지막 책 레이아웃 시 가시 뷰포트 높이 (가상 키보드 표시/숨김 감지용)
let bookKbdResizeTimer = null; // 키보드로 높이가 크게 변할 때 재배치를 한 번만 반영하기 위한 디바운스 타이머
let bookPinPage = -1;       // 탭한 시점에 보이던 페이지 (캐럿 좌표 대신 이 페이지를 고정)
let bookPinActive = false;  // 탭/페이지이동 후 현재 페이지를 고정(브라우저 자동 스크롤 무시). 타이핑 시작 시 해제
let lastBookTouchTime = 0;  // 마지막 책 모드 터치 시각 (터치로 발생하는 에뮬레이트 mousedown 무시용)
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
const MAX_HISTORY_CHARS = 30000000; // 스냅샷 총 문자 수 상한 (대용량 이미지로 인한 메모리 과다 방지)
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
    // (대용량 본문은 길이부터 비교해, 타이핑으로 길이가 달라진 일반적인 경우 전체 문자열 비교를 건너뜀)
    if (undoStack.length > 0) {
        const last = undoStack[undoStack.length - 1];
        if (last.title === snapshot.title &&
            last.subtitle === snapshot.subtitle &&
            (last.body || '').length === (snapshot.body || '').length &&
            last.body === snapshot.body) {
            return;
        }
    }

    undoStack.push(snapshot);
    if (undoStack.length > MAX_HISTORY) {
        undoStack.shift();
    }
    let totalChars = undoStack.reduce((sum, s) => sum + (s.body ? s.body.length : 0), 0);
    while (totalChars > MAX_HISTORY_CHARS && undoStack.length > 1) {
        totalChars -= (undoStack.shift().body || '').length;
    }

    // 새로운 변경이 발생하면 redo 스택 초기화
    redoStack = [];
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

export async function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        autoSaveTimer = null;
        const editBody = document.getElementById('editor-body');
        if (!editBody || (state.currentViewMode !== 'default' && state.currentViewMode !== 'book-edit')) return;
        // 에디터가 이미 닫힌 뒤(뒤로가기 등)에는 뒤늦게 저장하지 않음
        // (닫은 직후 삭제한 글이 자동저장으로 되살아나는 문제 방지)
        const writeModal = document.getElementById('write-modal');
        if (writeModal && writeModal.classList.contains('hidden')) return;
        try {
            await saveEntry(); // 로컬에는 즉시 저장
            if (window.gapi && gapi.client && gapi.client.getToken()) scheduleCloudSync(); // 클라우드 업로드는 묶어서 전송
        } catch (err) {
            console.error('자동 저장 실패:', err);
        }
    }, 2000);
}

/* --- 책 모드 관련 핸들러 --- */
function isBookNavMode() { return state.currentViewMode === 'book' || state.currentViewMode === 'book-edit'; }
function handleBookWheel(e) {
    if (!isBookNavMode()) return;
    // 가로 스크롤 의도면 그대로, 세로 휠도 페이지 이동으로 변환 (페이지뷰는 세로 스크롤이 없음)
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    e.preventDefault(); e.stopPropagation();
    if (wheelLockTimer) clearTimeout(wheelLockTimer);
    if (!isTurningPage && Math.abs(delta) > 20) {
        turnPage(delta > 0 ? 1 : -1);
        isTurningPage = true;
    }
    wheelLockTimer = setTimeout(() => { isTurningPage = false; wheelLockTimer = null; }, 500);
}
function handleBookTouchStart(e) {
    if (!isBookNavMode()) return;
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
    bookSwiping = false;
    // 탭 직전(아직 스크롤 안 됨)에 보이던 페이지를 기록해 둔다 (캐럿 좌표에 의존하지 않음)
    const container = document.getElementById('editor-container');
    if (container) {
        const stride = Math.floor(container.clientWidth);
        if (stride > 0) bookPinPage = Math.round(container.scrollLeft / stride);
    }
}
function handleBookTouchMove(e) {
    if (!isBookNavMode()) return;
    if (state.currentViewMode === 'book') { e.preventDefault(); return; } // 읽기 책 모드: 항상 페이지 제스처
    // 책 편집 모드: 가로 이동이 뚜렷하면 스와이프로 간주(편집/텍스트 선택 방해 방지)
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;
    if (!bookSwiping && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        bookSwiping = true;
        // 모바일 contenteditable에서 가로 드래그로 시작된 텍스트 선택을 적극 해제
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
    }
    if (bookSwiping) {
        e.preventDefault(); // 스와이프 중 캐럿 이동/선택 억제
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
    }
}
function handleBookTouchEnd(e) {
    if (!isBookNavMode() || isTurningPage) return;
    const diffX = touchStartX - e.changedTouches[0].screenX;
    const diffY = touchStartY - e.changedTouches[0].screenY;
    // 책 편집 모드에서는 가로 우세 스와이프만 페이지 이동 (탭/세로 이동은 편집으로 둠)
    const horizontalDominant = Math.abs(diffX) > Math.abs(diffY);
    if (Math.abs(diffX) > 40 && (state.currentViewMode === 'book' || (bookSwiping && horizontalDominant))) {
        // 스와이프로 잡혔던 선택을 정리하고 페이지 이동
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
        turnPage(diffX > 0 ? 1 : -1);
        isTurningPage = true; setTimeout(() => isTurningPage = false, 300);
        bookSwiping = false;
        lastBookTouchTime = Date.now();
        return;
    }
    bookSwiping = false;
    lastBookTouchTime = Date.now();
    // 탭(스와이프 아님): 탭한 시점에 보이던 페이지를 고정 → 브라우저가 캐럿을 보이려 다른 페이지로(또는
    // 세로로) 스크롤해도 그 자리(탭한 화면)를 유지. 타이핑을 시작하면 해제된다. (캐럿 좌표 부정확해도 안전)
    if (state.currentViewMode === 'book-edit' && bookPinPage >= 0) {
        currentBookPageIndex = bookPinPage;
        bookPinActive = true;
        const container = document.getElementById('editor-container');
        if (container) { container.scrollLeft = bookPinPage * Math.floor(container.clientWidth); container.scrollTop = 0; }
        updateBookNav();
    }
}
function handleBookResize() {
    if (state.currentViewMode !== 'book' && state.currentViewMode !== 'book-edit') return;
    const container = document.getElementById('editor-container');
    // 폭이 바뀌면(회전/화면 변화) 반드시 재배치해야 컬럼 폭과 스크롤 보폭이 어긋나지 않는다.
    // 폭은 그대로이고 높이만 변한 경우는 아래에서 변화 크기에 따라 나눠 처리한다(자잘한 변동=유지, 키보드=재배치).
    const widthChanged = !container || container.clientWidth !== lastBookColWidth;
    if (state.currentViewMode === 'book-edit' && !widthChanged) {
        // 폭은 그대로이고 높이만 변한 경우.
        const heightDelta = Math.abs(getBookViewportHeight() - lastBookViewportH);
        // 주소창 노출/숨김 같은 자잘한 높이 변동은 재배치하면 오히려 튀므로 현재 페이지만 유지한다.
        if (heightDelta < 100) {
            if (container) { container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth); container.scrollTop = 0; }
            updateBookNav();
            return;
        }
        // 가상 키보드 표시/숨김 등 큰 높이 변화: 페이지 높이를 현재 가시 영역에 맞춰 다시 배치하고
        // 커서가 있는 페이지로 스냅한다. → 편집 중인 줄(맨 윗줄·맨 아랫줄 포함)이 키보드에 가리지 않는다.
        // 키보드 애니메이션 중 여러 번 발생하는 리사이즈는 디바운스로 한 번만 반영해 화면 떨림을 막는다.
        if (bookKbdResizeTimer) clearTimeout(bookKbdResizeTimer);
        bookKbdResizeTimer = setTimeout(() => {
            bookKbdResizeTimer = null;
            if (state.currentViewMode !== 'book-edit') return;
            updateBookLayout();
            const c = document.getElementById('editor-container');
            if (!scrollCursorIntoBookView() && c) c.scrollLeft = currentBookPageIndex * Math.floor(c.clientWidth);
            updateBookNav();
        }, 120);
        return;
    }
    updateBookLayout();
    if (state.currentViewMode === 'book-edit') {
        if (!scrollCursorIntoBookView()) {
            if (container) container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth);
        }
    } else {
        if (container) container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth);
    }
    updateBookNav();
}

// 커서(접힌 Range)의 위치 사각형을 안전하게 구한다.
// range.getBoundingClientRect()가 zero-rect를 돌려주는 경우(빈 새 줄 등)에도
// 부모 요소의 rect로 폴백하면, 다중 컬럼/큰 컨테이너의 좌상단(rect.left=0,
// rect.top=0)으로 잘못 판단해 페이지가 처음으로 튕기는 문제가 생긴다.
// 따라서 인접한 자식/형제 노드의 rect로 좁혀서 보정하고, 그래도 신뢰할 수 없으면
// null을 돌려 호출 측에서 스크롤을 건너뛰도록 한다.
function getCaretRect(editBody) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (editBody && !editBody.contains(range.startContainer)) return null;
    const r = range.cloneRange(); r.collapse(true);
    const isValid = (rc) => rc && (rc.width !== 0 || rc.height !== 0 || rc.left !== 0 || rc.top !== 0);
    let rect = r.getBoundingClientRect();
    if (isValid(rect)) return rect;
    const node = r.startContainer;
    const offset = r.startOffset;
    const rectAtStart = (rc) => ({ left: rc.left, right: rc.left, top: rc.top, bottom: rc.bottom, width: 0, height: rc.height, x: rc.left, y: rc.top });
    const rectAtEnd = (rc) => ({ left: rc.right, right: rc.right, top: rc.top, bottom: rc.bottom, width: 0, height: rc.height, x: rc.right, y: rc.top });
    if (node.nodeType === Node.TEXT_NODE && node.length > 0) {
        const r2 = document.createRange();
        if (offset > 0) {
            r2.setStart(node, offset - 1); r2.setEnd(node, offset);
            const rc = r2.getBoundingClientRect();
            if (isValid(rc)) return rectAtEnd(rc);
        }
        if (offset < node.length) {
            r2.setStart(node, offset); r2.setEnd(node, offset + 1);
            const rc = r2.getBoundingClientRect();
            if (isValid(rc)) return rectAtStart(rc);
        }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
        const children = node.childNodes;
        if (offset < children.length) {
            const child = children[offset];
            if (child.nodeType === Node.ELEMENT_NODE) {
                const rc = child.getBoundingClientRect();
                if (isValid(rc)) return rectAtStart(rc);
            } else if (child.nodeType === Node.TEXT_NODE && child.length > 0) {
                const r2 = document.createRange();
                r2.setStart(child, 0); r2.setEnd(child, 1);
                const rc = r2.getBoundingClientRect();
                if (isValid(rc)) return rectAtStart(rc);
            }
        }
        if (offset > 0 && offset <= children.length) {
            const child = children[offset - 1];
            if (child.nodeType === Node.ELEMENT_NODE) {
                const rc = child.getBoundingClientRect();
                if (isValid(rc)) return rectAtEnd(rc);
            } else if (child.nodeType === Node.TEXT_NODE && child.length > 0) {
                const r2 = document.createRange();
                r2.setStart(child, child.length - 1); r2.setEnd(child, child.length);
                const rc = r2.getBoundingClientRect();
                if (isValid(rc)) return rectAtEnd(rc);
            }
        }
    }
    return null;
}

function scrollCaretIntoDefaultView() {
    if (!window.visualViewport) return;
    const editBody = document.getElementById('editor-body');
    if (!editBody) return;
    const rect = getCaretRect(editBody);
    if (!rect) return;
    // 가시 영역(visualViewport 기준)에서 커서가 가려지면 최소한만 스크롤
    const vv = window.visualViewport;
    const visibleTop = vv.offsetTop;
    const visibleBottom = vv.offsetTop + vv.height;
    const margin = 24;
    let dy = 0;
    if (rect.bottom > visibleBottom - margin) dy = rect.bottom - (visibleBottom - margin);
    else if (rect.top < visibleTop + margin) dy = rect.top - (visibleTop + margin);
    if (dy === 0) return;
    // 스크롤이 가능한 가장 가까운 조상 컨테이너를 찾아 스크롤
    let el = editBody;
    while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
            el.scrollTop += dy;
            return;
        }
        el = el.parentElement;
    }
    window.scrollBy(0, dy);
}

// 책 모드 총 페이지 수. 네 곳(페이지 넘김·점프·내비·커서 추적)에서 각자 계산하다
// 서로 어긋나던 것을 통일. 컬럼 레이아웃의 서브픽셀 반올림으로 scrollWidth가
// stride 배수보다 1~2px 크게 나와 빈 마지막 페이지가 생기지 않도록 5% 여유를 두고 올림.
function getBookPageCount(container, stride) {
    if (!container || stride <= 0) return 1;
    return Math.max(1, Math.ceil(container.scrollWidth / stride - 0.05));
}

function scrollCursorIntoBookView() {
    const container = document.getElementById('editor-container');
    if (!container) return false;
    const editBody = document.getElementById('editor-body');
    const rect = getCaretRect(editBody);
    if (!rect) return false;
    const cr = container.getBoundingClientRect();
    const stride = Math.floor(container.clientWidth);
    if (stride <= 0) return false;
    const offsetX = rect.left - cr.left + container.scrollLeft;
    const totalPages = getBookPageCount(container, stride);
    const pageIndex = Math.max(0, Math.min(totalPages - 1, Math.floor(offsetX / stride)));
    currentBookPageIndex = pageIndex;
    container.scrollLeft = pageIndex * stride;
    return true;
}

// 책 모드에서 스크롤이 페이지 경계가 아니면(브라우저가 캐럿을 보이려 가로 스크롤한 경우 등)
// 가장 가까운 페이지로 즉시 스냅해 화면이 한쪽으로 치우치지 않게 한다.
function handleBookScrollSnap(e) {
    if (!isBookNavMode()) return;
    const container = e.currentTarget;
    // 책 모드는 세로 스크롤이 없어야 한다. 브라우저가 캐럿을 보이려 세로로 민 경우 항상 0으로 되돌림
    if (container.scrollTop !== 0) container.scrollTop = 0;
    if (isTurningPage) return;
    const stride = Math.floor(container.clientWidth);
    if (stride <= 0) return;
    // 고정 중(탭/페이지이동 후): 브라우저가 캐럿을 보이려 스크롤해도 현재 페이지로 되돌린다 (타이핑 시작 전까지)
    if (state.currentViewMode === 'book-edit' && bookPinActive) {
        if (Math.abs(container.scrollLeft - currentBookPageIndex * stride) > 1) {
            container.scrollLeft = currentBookPageIndex * stride;
            updateBookNav();
        }
        return;
    }
    // 평소(타이핑 중 등): 페이지 경계에 정렬돼 있으면 그대로, 어긋났을 때만 가장 가까운 페이지로 정렬
    const nearest = Math.round(container.scrollLeft / stride);
    if (Math.abs(container.scrollLeft - nearest * stride) <= 1) return;
    currentBookPageIndex = nearest;
    container.scrollLeft = nearest * stride;
    updateBookNav();
}
function toggleBookEventListeners(enable) {
    const container = document.getElementById('editor-container');
    if (!container) return;
    container.removeEventListener('wheel', handleBookWheel);
    container.removeEventListener('touchstart', handleBookTouchStart);
    container.removeEventListener('touchmove', handleBookTouchMove);
    container.removeEventListener('touchend', handleBookTouchEnd);
    container.removeEventListener('scroll', handleBookScrollSnap);
    if (enable) {
        container.addEventListener('wheel', handleBookWheel, { passive: false });
        container.addEventListener('touchstart', handleBookTouchStart, { passive: true });
        container.addEventListener('touchmove', handleBookTouchMove, { passive: false });
        container.addEventListener('touchend', handleBookTouchEnd, { passive: true });
        container.addEventListener('scroll', handleBookScrollSnap, { passive: true });
    }
}

export function turnPage(direction) {
    const container = document.getElementById('editor-container');
    if (!container) return;
    const stride = Math.floor(container.clientWidth);
    if (stride <= 0) return;
    const maxPage = getBookPageCount(container, stride) - 1;
    let nextIndex = Math.max(0, Math.min(maxPage, currentBookPageIndex + direction));
    if (nextIndex === currentBookPageIndex) return;
    currentBookPageIndex = nextIndex;
    container.scrollLeft = currentBookPageIndex * stride;
    container.scrollTop = 0;
    bookPinActive = true; // 넘긴 페이지를 고정 유지 (브라우저 자동 스크롤 방지)
    updateBookNav();
}

export function jumpToPage(index) {
    const container = document.getElementById('editor-container');
    if (!container) return;
    const stride = Math.floor(container.clientWidth);
    if (stride <= 0) return;
    const maxPage = getBookPageCount(container, stride) - 1;
    let nextIndex = Math.max(0, Math.min(maxPage, index));
    currentBookPageIndex = nextIndex;
    container.scrollLeft = currentBookPageIndex * stride;
    updateBookNav();
}

function findVisibleAnchor() {
    const container = document.getElementById('editor-container');
    if (!container) return null;
    const cr = container.getBoundingClientRect();
    const ys = [cr.top + 8, cr.top + 40, cr.top + 100, cr.top + 200, cr.top + 320];
    const xs = [cr.left + 24, cr.left + 80, cr.left + 200, cr.left + 360];
    for (const y of ys) {
        if (y >= cr.bottom - 4) break;
        for (const x of xs) {
            if (x >= cr.right - 4) break;
            const el = document.elementFromPoint(x, y);
            if (el && container.contains(el) && el !== container) return el;
        }
    }
    return null;
}

function scrollAnchorIntoView(anchor, mode) {
    if (!anchor || !anchor.isConnected) return false;
    const container = document.getElementById('editor-container');
    if (!container) return false;
    const cr = container.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    if (mode === 'book') {
        const stride = Math.floor(container.clientWidth);
        if (stride <= 0) return false;
        const offsetX = r.left - cr.left + container.scrollLeft;
        const totalPages = Math.max(1, Math.ceil(container.scrollWidth / stride));
        const pageIndex = Math.max(0, Math.min(totalPages - 1, Math.floor(offsetX / stride)));
        currentBookPageIndex = pageIndex;
        container.scrollLeft = pageIndex * stride;
    } else {
        const offsetY = r.top - cr.top + container.scrollTop;
        container.scrollTop = Math.max(0, offsetY);
    }
    return true;
}

function getBookViewportHeight() {
    return (window.visualViewport && window.visualViewport.height) ? window.visualViewport.height : window.innerHeight;
}

function getBookPageContentSize(container) {
    const colWidth = Math.floor(container.clientWidth);
    const isMobile = window.innerWidth <= 650;
    const horizontalPad = isMobile ? 56 : 96; // editor-body padding-left + padding-right
    const verticalPad = isMobile ? 40 : 48; // editor-container 상/하 패딩 합 (페이지 세로 여백)
    const pageWidth = Math.max(50, colWidth - horizontalPad);
    const pageHeight = Math.max(50, getBookViewportHeight() - 120 - verticalPad - 20);
    return { pageWidth, pageHeight };
}

function captureBookTargetSizes() {
    const body = document.getElementById('editor-body');
    if (!body) return;
    body.querySelectorAll('img').forEach(img => {
        if (img.dataset.bookTargetW !== undefined) return;
        const r = img.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            img.dataset.bookTargetW = String(Math.round(r.width));
            img.dataset.bookTargetH = String(Math.round(r.height));
        } else if (img.naturalWidth && img.naturalHeight) {
            img.dataset.bookTargetW = String(img.naturalWidth);
            img.dataset.bookTargetH = String(img.naturalHeight);
        }
    });
}

function fitImageToBookPage(img, container) {
    const { pageWidth, pageHeight } = getBookPageContentSize(container);
    const apply = () => {
        let tW = parseFloat(img.dataset.bookTargetW);
        let tH = parseFloat(img.dataset.bookTargetH);
        if (!tW || !tH) {
            const nW = img.naturalWidth, nH = img.naturalHeight;
            if (nW && nH) { tW = nW; tH = nH; }
        }
        if (!tW || !tH) {
            img.style.width = '';
            img.style.height = '';
            img.style.maxWidth = pageWidth + 'px';
            img.style.maxHeight = pageHeight + 'px';
            return;
        }
        const scale = Math.min(1, pageWidth / tW, pageHeight / tH);
        const w = Math.floor(tW * scale);
        const h = Math.floor(tH * scale);
        img.style.width = w + 'px';
        img.style.height = h + 'px';
        img.style.maxWidth = '';
        img.style.maxHeight = '';
    };
    if (img.complete && (img.naturalWidth || img.dataset.bookTargetW)) {
        apply();
    } else if (!img._bookLoadHooked) {
        img._bookLoadHooked = true;
        img.addEventListener('load', () => {
            img._bookLoadHooked = false;
            if (state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') {
                if (img.dataset.bookTargetW === undefined && img.naturalWidth) {
                    img.dataset.bookTargetW = String(img.naturalWidth);
                    img.dataset.bookTargetH = String(img.naturalHeight);
                }
                apply();
                updateBookNav();
            }
        }, { once: true });
        // placeholder constraints while loading
        img.style.width = '';
        img.style.height = '';
        img.style.maxWidth = pageWidth + 'px';
        img.style.maxHeight = pageHeight + 'px';
    }
}

// 책 모드에서 사용자가 이미지 크기를 바꾸면, 그 크기를 책 기준값에도 반영해
// 이후 레이아웃 재계산 시에도 조절한 크기가 그대로 유지되도록 한다.
function markBookImageResized(img) {
    if (!img || img.tagName !== 'IMG') return;
    if (state.currentViewMode !== 'book' && state.currentViewMode !== 'book-edit') return;
    const r = img.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
        img.dataset.bookTargetW = String(Math.round(r.width));
        img.dataset.bookTargetH = String(Math.round(r.height));
    }
    img.dataset.bookOrigWidth = img.style.width || '';
    img.dataset.bookOrigHeight = img.style.height || '';
}

function updateBookLayout() {
    const container = document.getElementById('editor-container');
    if (!container) return;
    lastBookColWidth = container.clientWidth; // 재배치 기준 컨테이너 폭 기록 (키보드로 높이만 변한 경우 구분)
    lastBookViewportH = getBookViewportHeight(); // 재배치 기준 가시 높이 기록 (키보드 표시/숨김 판별용)
    container.style.columnWidth = `${Math.floor(container.clientWidth)}px`;
    container.style.columnGap = '0px';
    // style.css의 책 모드 규칙이 height를 !important로 고정하므로, 인라인도 important로 지정해야
    // 실제로 적용된다. (그냥 style.height = ... 로 두면 캐스케이드에서 밀려 무시되어
    // 키보드가 떴을 때 페이지 높이가 줄지 않는다 — iOS 사파리에서 하단 줄이 가려지던 원인)
    container.style.setProperty('height', `${getBookViewportHeight() - 120}px`, 'important');
    container.style.overflow = 'hidden';
    const body = document.getElementById('editor-body');
    if (body) {
        body.querySelectorAll('img').forEach(img => {
            if (img.dataset.bookOrigWidth === undefined) {
                img.dataset.bookOrigWidth = img.style.width || '';
                img.dataset.bookOrigHeight = img.style.height || '';
            }
            fitImageToBookPage(img, container);
        });
    }
}

export function updateBookNav() {
    if (state.currentViewMode !== 'book' && state.currentViewMode !== 'book-edit') return;
    const container = document.getElementById('editor-container');
    if(!container) return;
    const stride = Math.floor(container.clientWidth);
    if (stride <= 0) return;
    const totalPages = getBookPageCount(container, stride);
    document.getElementById('book-nav-left')?.classList.toggle('hidden', currentBookPageIndex <= 0);
    document.getElementById('book-nav-right')?.classList.toggle('hidden', currentBookPageIndex + 1 >= totalPages);
    const pageIndicator = document.getElementById('page-indicator');
    if (pageIndicator) { pageIndicator.innerText = `${currentBookPageIndex + 1} / ${totalPages}`; pageIndicator.classList.remove('hidden'); }
    const slider = document.getElementById('book-page-slider');
    if (slider) { slider.max = totalPages - 1; slider.value = currentBookPageIndex; }
}

function linkifyContents(element, force = false) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const nodes = []; let node; while(node = walker.nextNode()) nodes.push(node);
    const urlRegex = /((https?:\/\/|www\.)[^\s]+)/g;
    nodes.forEach(node => {
        if (node.parentNode.tagName === 'A' || (!force && node.parentNode.isContentEditable)) return;
        const text = node.nodeValue;
        if (text.match(urlRegex)) {
            const fragment = document.createDocumentFragment(); let lastIdx = 0;
            text.replace(urlRegex, (match, url, protocol, offset) => {
                fragment.appendChild(document.createTextNode(text.slice(lastIdx, offset)));
                const a = document.createElement('a'); a.href = protocol === 'www.' ? 'http://' + url : url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = url;
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
    // colspan/rowspan을 고려한 논리적 좌표로 범위 계산
    const startR = startTd.parentElement.rowIndex, startC = getCellColumnIndex(startTd);
    const endR = endTd.parentElement.rowIndex, endC = getCellColumnIndex(endTd);
    const minR = Math.min(startR, endR);
    const maxR = Math.max(startR + (startTd.rowSpan || 1) - 1, endR + (endTd.rowSpan || 1) - 1);
    const minC = Math.min(startC, endC);
    const maxC = Math.max(startC + (startTd.colSpan || 1) - 1, endC + (endTd.colSpan || 1) - 1);
    const isSingleCell = (startTd === endTd);
    if (!isSingleCell) startTable.classList.add('selecting-cells');
    startTable.querySelectorAll('td').forEach(td => {
        const r1 = td.parentElement.rowIndex, r2 = r1 + (td.rowSpan || 1) - 1;
        const c1 = getCellColumnIndex(td), c2 = c1 + (td.colSpan || 1) - 1;
        if (!isSingleCell && r2 >= minR && r1 <= maxR && c2 >= minC && c1 <= maxC) td.classList.add('selected-cell');
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
        onAfterPaste: () => triggerAutoSave(),
        onPasteImage: (src) => {
            if (typeof window.processImageDataUrl === 'function') {
                window.processImageDataUrl(src);
            } else {
                insertImage(src);
            }
        },
        getSelectedElement: () => currentSelectedElement,
        clearSelectedElement: () => hideSelection()
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

    // 읽기/책 모드에서 이미지를 탭하면 전체화면으로 보기 (편집 모드에선 선택 동작 유지)
    editorBody.addEventListener('click', (e) => {
        const img = e.target.closest('img');
        if (!img) return;
        if (state.currentViewMode === 'default' || state.currentViewMode === 'book-edit') return;
        e.preventDefault();
        openImageFullscreen(img.src);
    });

    editorBody.onkeydown = (e) => {
        // Ctrl+Z / Cmd+Z: Undo
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            e.preventDefault(); 
            formatDoc('undo'); 
            return; 
        }
        // Ctrl+Y / Cmd+Y 또는 Ctrl+Shift+Z / Cmd+Shift+Z: Redo
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
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

        // 본문에서 Tab 입력 시 3칸 들여쓰기
        if (e.key === 'Tab') {
            e.preventDefault();
            saveBeforeChange('typing');
            document.execCommand('insertText', false, '   ');
            return;
        }
        
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
            if (currentSelectedElement && currentSelectedElement.tagName !== 'TABLE' && document.activeElement?.tagName !== 'TD') {
                e.preventDefault(); 
                saveBeforeChange('delete'); 
                deleteSelectedElement(); 
                return;
            }
        }
        
        // 일반 타이핑 시 히스토리 기록 (단어 경계에서)
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
            if (WORD_BREAK_CHARS.includes(e.key)) {
                // 매 단어 경계마다 전체 본문을 직렬화하면 이미지가 많은 긴 글에서
                // 타이핑 렉의 원인이 되므로, beforeinput과 동일한 그룹핑 게이트를 적용
                const now = Date.now();
                if (lastInputType !== 'typing' || now - lastInputTime > TYPING_GROUP_DELAY) {
                    saveBeforeChange('typing');
                }
            }
        }
    }

    // IME 조합 이벤트 (한글 등)
    editorBody.addEventListener('compositionstart', () => {
        isComposing = true;
        // 조합 시작 전 상태 저장 — 단, 음절마다 조합이 반복되는 IME(안드로이드 등)에서
        // 매 음절 전체 본문 직렬화가 일어나지 않도록 타이핑 그룹핑 게이트를 적용
        const now = Date.now();
        if (lastInputType !== 'typing' || now - lastInputTime > TYPING_GROUP_DELAY) {
            pendingSnapshot = createSnapshot();
        }
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

    // beforeinput: 변경 직전 상태를 Undo 시작점으로 캡처 (타이핑 그룹핑 적용)
    editorBody.addEventListener('beforeinput', () => {
        if (isComposing) return;
        const now = Date.now();
        if (lastInputType !== 'typing' || now - lastInputTime > TYPING_GROUP_DELAY) {
            const snapshot = createSnapshot();
            if (snapshot) pushToHistory(snapshot);
        }
        lastInputTime = now;
        lastInputType = 'typing';
    });

    editorBody.addEventListener('input', () => {
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
    
    window.addEventListener('resize', () => { updateSelectionBox(); if(state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') handleBookResize(); });

    // 가상 키보드 등으로 visualViewport가 변할 때 책 모드 레이아웃을 다시 맞춰 하단이 가려지지 않도록 한다.
    // (scroll 이벤트에는 반응하지 않음 — 사용자가 스크롤할 때 커서로 화면이 튕기는 것을 방지)
    if (window.visualViewport) {
        const onViewportChange = () => {
            if (state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') handleBookResize();
            else if (state.currentViewMode === 'default') scrollCaretIntoDefaultView();
        };
        window.visualViewport.addEventListener('resize', onViewportChange);
    }

    // 타이핑/방향키 이동 시에만 커서가 보이도록 스크롤 (focus·click 시에는 하지 않아 화면 튕김 방지)
    const editorBodyEl = document.getElementById('editor-body');
    if (editorBodyEl) {
        const ensureCaretVisible = () => {
            // 실제 편집(타이핑/방향키)이 시작되면 탭-페이지 고정을 풀어, 글이 다음 페이지로 넘어갈 때
            // 브라우저 스크롤 + 페이지 스냅으로 커서를 따라가게 한다 (캐럿 좌표에 의존하지 않음)
            if (state.currentViewMode === 'book-edit') { bookPinActive = false; }
            else if (state.currentViewMode === 'default') requestAnimationFrame(scrollCaretIntoDefaultView);
        };
        editorBodyEl.addEventListener('input', ensureCaretVisible);
        editorBodyEl.addEventListener('keyup', (e) => {
            if (state.currentViewMode !== 'book-edit' && state.currentViewMode !== 'default') return;
            if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Enter','Backspace','Delete'].includes(e.key)) {
                ensureCaretVisible();
            }
        });
        // 데스크톱 등 마우스 클릭으로 커서를 둘 때: 캐럿 좌표 대신 '보이던 페이지'를 잠시 고정해
        // 브라우저 자동 스크롤로 페이지가 바뀌지 않게 한다 (터치는 touchend에서 처리)
        editorBodyEl.addEventListener('mousedown', () => {
            if (state.currentViewMode !== 'book-edit') return;
            if (Date.now() - lastBookTouchTime < 800) return; // 터치로 발생한 에뮬레이트 mousedown 무시
            const container = document.getElementById('editor-container');
            if (!container) return;
            const stride = Math.floor(container.clientWidth);
            if (stride <= 0) return;
            currentBookPageIndex = Math.round(container.scrollLeft / stride);
            bookPinActive = true;
        });
    }
}

/**
 * 저장된 본문을 innerHTML에 넣기 전에 위험 요소만 제거합니다.
 * 서식은 그대로 보존하고 script/이벤트 핸들러/javascript: URL만 차단.
 * (PDF 내보내기 등 본문을 실제 DOM에 넣는 다른 경로에서도 공용으로 사용)
 */
export function sanitizeEntryHtml(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, form, meta, link, style, base').forEach(el => el.remove());
    doc.body.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) el.removeAttribute(attr.name);
            // 스킴 안에 탭·개행을 끼우면 정규식 비교를 빠져나가지만 브라우저는 javascript: 로 해석한다.
            // 공용 판정(isSafeUrl)이 공백류를 걷어낸 뒤 허용 목록으로 검사한다.
            else if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'srcdoc' ||
                      name === 'formaction' || name === 'srcset' || name === 'action' || name === 'data') &&
                     !isSafeUrl(attr.value)) el.removeAttribute(attr.name);
        });
    });
    return doc.body.innerHTML;
}

/**
 * 본문 요소를 복제하여 책 모드 레이아웃 흔적(축소된 이미지 크기, data-book-* 속성)을
 * 제거한 깨끗한 HTML을 반환합니다. 저장 시 사용.
 */
export function getCleanBodyHtml(bodyEl) {
    if (!bodyEl) return '';
    // 책 모드 흔적(data-book-*)이 없으면 전체 복제 없이 innerHTML을 그대로 사용
    // (일반 편집 중 매 저장마다 대용량 본문을 깊은 복제하던 비용 제거 → 타이핑 끊김 완화)
    const hasBookArtifacts = state.currentViewMode === 'book'
        || state.currentViewMode === 'book-edit'
        || !!bodyEl.querySelector('[data-book-orig-width]');
    if (!hasBookArtifacts) return bodyEl.innerHTML;
    const clone = bodyEl.cloneNode(true);
    clone.querySelectorAll('img').forEach(img => {
        if (img.dataset.bookOrigWidth !== undefined) {
            img.style.width = img.dataset.bookOrigWidth || '';
            img.style.height = img.dataset.bookOrigHeight || '';
            img.style.maxWidth = '';
            img.style.maxHeight = '';
        }
    });
    clone.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            if (attr.name.startsWith('data-book-')) el.removeAttribute(attr.name);
        });
    });
    return clone.innerHTML;
}

// ── 맞춤법 검사 (브라우저 내장 검사기) ──────────────────────────────────
// 본문을 외부로 전송하지 않고 기기 안에서만 검사한다(오프라인 동작, 개인 기록 보호).
// 한국어 인식률은 기기/브라우저의 사전 지원에 따라 다르다(아이폰·맥은 한국어 지원, 일부 안드로이드는 영어 위주).
const SPELLCHECK_KEY = 'faith_spellcheck';

export function isSpellcheckOn() {
    return localStorage.getItem(SPELLCHECK_KEY) !== 'off'; // 기본값: 켜짐
}

// 맞춤법 표시는 '편집 중'일 때만 의미가 있으므로, 읽기/책(읽기) 모드에서는 끈다.
export function applySpellcheck() {
    const on = isSpellcheckOn();
    const editable = state.currentViewMode === 'default' || state.currentViewMode === 'book-edit';
    const active = on && editable;
    ['edit-title', 'edit-subtitle', 'editor-body'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('spellcheck', active ? 'true' : 'false');
        // 한국어/영어가 섞여 있으므로 특정 언어로 고정하지 않고 브라우저가 판단하게 둔다.
        if (active) el.removeAttribute('lang');
    });
    const btn = document.getElementById('toolbar-spellcheck-btn');
    if (btn) {
        btn.classList.toggle('active', on);
        btn.title = on ? '맞춤법 검사 끄기' : '맞춤법 검사 켜기';
    }
}

export function toggleSpellcheck() {
    const next = !isSpellcheckOn();
    localStorage.setItem(SPELLCHECK_KEY, next ? 'on' : 'off');
    applySpellcheck();
    // 이미 렌더된 밑줄 표시를 즉시 갱신하려면 편집 영역을 다시 포커스해야 하는 브라우저가 있다.
    const body = document.getElementById('editor-body');
    if (body && next && document.activeElement === body) { body.blur(); body.focus(); }
    return next;
}

export function openEditor(isEdit, entryData) {
    hideTransientPopups(); // 홈 화면에서 열려 있던 팝업/메뉴를 닫고 에디터로 진입
    state.isEditMode = isEdit; const writeModal = document.getElementById('write-modal'); openModal(writeModal); writeModal.scrollTop = 0; currentBookPageIndex = 0; savedRange = null; setupBasicHandling();
    applySpellcheck();
    // 이전 글의 TTS 구간이 남아 새 글을 엉뚱한 위치부터 읽는 것을 방지
    import('./tts.js').then(m => m.clearTTSRangeForNewEntry && m.clearTTSRangeForNewEntry()).catch(() => {});
    const catName = state.allCategories.find(c => c.id === state.currentCategory)?.name || '기록';
    document.getElementById('display-category').innerText = catName; document.getElementById('display-date').innerText = entryData ? entryData.date : new Date().toLocaleDateString('ko-KR');
    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');
    
    if(isEdit && entryData) {
        state.editingId = entryData.id;
        state.editBaseModifiedAt = new Date(entryData.modifiedAt || entryData.timestamp || 0).getTime(); // 충돌 감지 기준
        editTitle.value = entryData.title || '';
        editSubtitle.value = entryData.subtitle || ''; 
        editBody.innerHTML = sanitizeEntryHtml(entryData.body || '');
        linkifyContents(editBody, true);
        setupTableWrapperScroll(editBody);
        state.currentFontFamily = entryData.fontFamily || 'Pretendard';
        state.currentFontSize = entryData.fontSize || 16;
        applyFontStyle(state.currentFontFamily, state.currentFontSize); 
    }
    else {
        state.editingId = Date.now().toString();
        state.editBaseModifiedAt = Date.now(); // 새 글: 충돌 대상 없음
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

// 충돌 해소 시 다른 기기의 내용을 에디터에 강제로 다시 불러온다 (포커스 여부와 무관하게 교체)
export function reloadEntryIntoEditor(entry) {
    const writeModal = document.getElementById('write-modal');
    if (!writeModal || writeModal.classList.contains('hidden') || !entry) return;
    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');
    if (editTitle) editTitle.value = entry.title || '';
    if (editSubtitle) editSubtitle.value = entry.subtitle || '';
    if (editBody) {
        editBody.innerHTML = sanitizeEntryHtml(entry.body || '');
        linkifyContents(editBody, true);
        setupTableWrapperScroll(editBody);
    }
    state.editingId = entry.id;
    state.editBaseModifiedAt = new Date(entry.modifiedAt || entry.timestamp || 0).getTime();
    lastLocalEditTime = 0; // 외부 내용으로 교체했으므로 로컬 편집 보호창 해제
    // 대기 중이던 자동저장이 방금 불러온 내용을 새 타임스탬프로 되올리지 않도록 취소
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    // 본문을 통째로 교체했으므로 실행취소 히스토리를 새로 시작 (이전 로컬 편집 복원 방지)
    saveInitialState();
    // 책 모드였다면 레이아웃·페이지 내비를 다시 계산
    if (state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') {
        updateBookLayout();
        updateBookNav();
    }
}

export function refreshEditorContent() {
    const writeModal = document.getElementById('write-modal');
    if (!writeModal || writeModal.classList.contains('hidden') || !state.editingId) return;
    // 최근 로컬 편집 후 5초 이내이면 동기화로 인한 덮어쓰기 방지
    if (Date.now() - lastLocalEditTime < 5000) return;
    // 표 편집 모달이 열려있으면 덮어쓰기 방지
    const tableModal = document.getElementById('table-modal');
    if (tableModal && !tableModal.classList.contains('hidden')) return;
    const latestEntry = state.entries.find(e => e.id === state.editingId);
    if (!latestEntry) return;
    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');
    if (!editTitle || !editSubtitle || !editBody) return;
    const isEditableMode = state.currentViewMode === 'default' || state.currentViewMode === 'book-edit';
    if (!isEditableMode || document.activeElement !== editBody) {
        if (editTitle.value !== latestEntry.title) editTitle.value = latestEntry.title || '';
        if (editSubtitle.value !== latestEntry.subtitle) editSubtitle.value = latestEntry.subtitle || '';
        // 편집 가능한 모드에서는 본문을 자동 교체하지 않음 (편집 중인 글 보호 — 충돌은 확인창으로만 해소)
        // 책 모드에서는 정리된 형태로 비교해 불필요한 재설정(커서/스크롤 흔들림) 방지
        if (!isEditableMode && getCleanBodyHtml(editBody) !== latestEntry.body) {
            editBody.innerHTML = sanitizeEntryHtml(latestEntry.body || '');
            linkifyContents(editBody);
            setupTableWrapperScroll(editBody);
            if (state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') updateBookNav();
        }
    }
}

export function toggleViewMode(mode) {
    const container = document.getElementById('editor-container'), writeModal = document.getElementById('write-modal'), editBody = document.getElementById('editor-body'), editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editorToolbar = document.getElementById('editor-toolbar');
    const wasBookMode = state.currentViewMode === 'book' || state.currentViewMode === 'book-edit', oldScrollTop = container ? container.scrollTop : 0, oldHeight = container ? container.clientHeight : 0, lastPageIndex = currentBookPageIndex;
    const isBookToBook = wasBookMode && (mode === 'book' || mode === 'book-edit');
    const willBeBookMode = mode === 'book' || mode === 'book-edit';
    // 편집(default) ↔ 보기(readOnly)는 본문 레이아웃이 동일한 흐름 모드 전환 → 보던 스크롤 위치를 그대로 유지
    const isFlowToFlow = !wasBookMode && !willBeBookMode;
    const anchor = (isBookToBook || isFlowToFlow) ? null : findVisibleAnchor();
    // 편집 모드에서 벗어날 때 보류 중인 자동 저장을 즉시 반영 (디바운스 중 모드 전환으로 인한 편집 유실 방지)
    const wasEditable = state.currentViewMode === 'default' || state.currentViewMode === 'book-edit';
    const willBeEditable = mode === 'default' || mode === 'book-edit';
    if (wasEditable && !willBeEditable && autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        // 즉시 로컬 저장 후, 대기 중인 클라우드 업로드도 바로 전송 (편집 종료 시점 → 다른 기기 반영 보장)
        // 편집 종료는 의도된 동작이므로 충돌 시 확인창 표시
        saveEntry()
            .then(() => { flushCloudSync(true); })
            .catch(err => console.error('자동 저장 실패:', err));
    }
    state.currentViewMode = mode;
    applySpellcheck(); // 읽기 모드에서는 맞춤법 밑줄을 감추고, 편집 모드로 돌아오면 다시 표시
    const btnReadOnly = document.getElementById('btn-readonly'), btnBookMode = document.getElementById('btn-bookmode');
    if(btnReadOnly) btnReadOnly.classList.toggle('active', mode === 'readOnly');
    if(btnBookMode) btnBookMode.classList.toggle('active', mode === 'book' || mode === 'book-edit');
    if(!isBookToBook && container) { container.style.removeProperty('height'); container.style.overflow = ''; container.style.columnWidth = ''; container.style.columnGap = ''; container.scrollLeft = 0; }
    if (wasBookMode && !isBookToBook) { const body = document.getElementById('editor-body'); if (body) body.querySelectorAll('img').forEach(img => { img.style.maxHeight = ''; img.style.maxWidth = ''; img.style.width = img.dataset.bookOrigWidth || ''; img.style.height = img.dataset.bookOrigHeight || ''; delete img.dataset.bookOrigWidth; delete img.dataset.bookOrigHeight; delete img.dataset.bookTargetW; delete img.dataset.bookTargetH; }); }
    writeModal.classList.remove('mode-read-only', 'mode-book', 'mode-book-edit');
    if (!wasBookMode && (mode === 'book' || mode === 'book-edit')) {
        // 책 모드 진입 직전(기본 레이아웃 상태)에서 이미지 렌더링 크기를 기록해 둔다.
        captureBookTargetSizes();
    }
    document.querySelectorAll('.book-nav, #page-indicator, #book-slider-container, #btn-scroll-top').forEach(el => el.classList.add('hidden'));
    hideSelection();
    toggleBookEventListeners(mode === 'book' || mode === 'book-edit');
    if (mode === 'book') {
        editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false";
        linkifyContents(editBody);
        writeModal.classList.add('mode-book');
        updateBookLayout();
        editorToolbar?.classList.add('collapsed');
        if (!isBookToBook) {
            if (!scrollAnchorIntoView(anchor, 'book')) {
                if (!wasBookMode && oldHeight > 0) currentBookPageIndex = Math.floor(oldScrollTop / oldHeight);
                if (container) container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth);
            }
        }
        updateBookNav();
    }
    else if (mode === 'book-edit') {
        editTitle.readOnly = false; editSubtitle.readOnly = false; editBody.contentEditable = "true";
        writeModal.classList.add('mode-book', 'mode-book-edit');
        if (!isBookToBook) updateBookLayout();
        editorToolbar?.classList.add('collapsed');
        updateBookNav();
    }
    else if (mode === 'readOnly') {
        editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false";
        linkifyContents(editBody);
        writeModal.classList.add('mode-read-only');
        editorToolbar?.classList.add('collapsed');
        requestAnimationFrame(() => {
            // 편집↔보기는 동일한 흐름 레이아웃이므로 보던 위치를 그대로 유지 (앵커 추정으로 인한 튕김 방지)
            if (isFlowToFlow) { if (container) container.scrollTop = oldScrollTop; }
            else if (!scrollAnchorIntoView(anchor, 'normal') && wasBookMode && container) {
                container.scrollTop = lastPageIndex * oldHeight;
            }
        });
    }
    else {
        editTitle.readOnly = false; editSubtitle.readOnly = false; editBody.contentEditable = "true";
        editorToolbar?.classList.remove('collapsed');
        requestAnimationFrame(() => {
            if (isFlowToFlow) { if (container) container.scrollTop = oldScrollTop; }
            else if (!scrollAnchorIntoView(anchor, 'normal') && wasBookMode && container) {
                container.scrollTop = lastPageIndex * oldHeight;
            }
        });
    }
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
    if (!document.activeElement?.closest('#editor-body')) editor.focus();

    if (cmd.startsWith('justify')) {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        const alignMap = { 'justifyLeft': 'left', 'justifyCenter': 'center', 'justifyRight': 'right' };
        const alignValue = alignMap[cmd];
        if (selectedCells.length > 0) { selectedCells.forEach(cell => cell.style.textAlign = alignValue); }
        else if (currentSelectedElement && currentSelectedElement.tagName === 'IMG') {
            const img = currentSelectedElement;
            img.style.display = 'block';
            if (alignValue === 'left') { img.style.marginLeft = '0'; img.style.marginRight = 'auto'; }
            else if (alignValue === 'right') { img.style.marginLeft = 'auto'; img.style.marginRight = '0'; }
            else { img.style.marginLeft = 'auto'; img.style.marginRight = 'auto'; }
            updateSelectionBox();
        }
        else { const selection = window.getSelection(); const td = selection.anchorNode?.nodeType === 3 ? selection.anchorNode.parentElement?.closest('td') : selection.anchorNode?.closest('td'); if (td) td.style.textAlign = alignValue; else document.execCommand(cmd, false, value); }
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
    if (isNaN(size) || size < 1) return;

    state.currentFontSize = size;
    saveBeforeChange('fontSize');

    // 글자 크기 입력칸 업데이트
    const sizeInput = document.getElementById('font-size-input');
    if (sizeInput) sizeInput.value = size;

    if (selection.rangeCount > 0 && selection.toString().length > 0) {
        document.execCommand('fontSize', false, '7');
        const fontTags = document.querySelectorAll('font[size="7"]');
        const newSpans = [];
        fontTags.forEach(t => {
            const span = document.createElement('span');
            span.style.fontSize = size + 'px';
            span.innerHTML = t.innerHTML;
            t.parentNode.replaceChild(span, t);
            newSpans.push(span);
        });
        // 선택 영역 복원 (span 내부를 선택해야 detectSelectionFontSize가 올바른 크기를 감지)
        if (newSpans.length > 0) {
            const newRange = document.createRange();
            const firstSpan = newSpans[0];
            const lastSpan = newSpans[newSpans.length - 1];
            newRange.setStart(firstSpan, 0);
            newRange.setEnd(lastSpan, lastSpan.childNodes.length);
            selection.removeAllRanges();
            selection.addRange(newRange);
        }
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

/**
 * MS Word 스타일 글자 크기 단계별 증가
 */
const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

export function increaseFontSize() {
    const current = detectSelectionFontSize() || state.currentFontSize;
    let next = FONT_SIZE_PRESETS.find(s => s > current);
    if (!next) next = Math.min(current + 2, 200);
    const sizeInput = document.getElementById('font-size-input');
    if (sizeInput) sizeInput.value = next;
    changeGlobalFontSize(next);
}

export function decreaseFontSize() {
    const current = detectSelectionFontSize() || state.currentFontSize;
    let next = [...FONT_SIZE_PRESETS].reverse().find(s => s < current);
    if (!next) next = Math.max(current - 1, 1);
    const sizeInput = document.getElementById('font-size-input');
    if (sizeInput) sizeInput.value = next;
    changeGlobalFontSize(next);
}

/**
 * 현재 선택 영역 또는 커서 위치의 글자 크기를 감지합니다.
 */
export function detectSelectionFontSize() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return state.currentFontSize;

    let node = selection.anchorNode;
    if (!node) return state.currentFontSize;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node) return state.currentFontSize;

    // editor-body 안에 있는지 확인
    const editorBody = document.getElementById('editor-body');
    if (!editorBody || !editorBody.contains(node)) return state.currentFontSize;

    const computed = window.getComputedStyle(node);
    const px = parseFloat(computed.fontSize);
    return Math.round(px) || state.currentFontSize;
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
                    markBookImageResized(currentSelectedElement);
                    updateSelectionBox();
                    triggerAutoSave();
                } 
            }; 
            resizeBtnGroup.appendChild(btn);
        });
        // 자르기(다시 자르기) 버튼 — 이미지에서만 표시
        cropBtn = document.createElement('button');
        cropBtn.className = 'img-resize-btn img-crop-btn';
        cropBtn.innerHTML = '<i class="ph ph-crop"></i> 자르기';
        cropBtn.onclick = () => {
            const img = currentSelectedElement;
            if (!img || img.tagName !== 'IMG' || typeof window.openImageCropper !== 'function') return;
            saveBeforeChange('crop');
            window.openImageCropper(img.src, (result, wasCropped) => {
                if (!wasCropped || !result) return;
                // 자르기 결과는 원본 해상도 무손실 PNG라 그대로 넣으면 본문이 수 MB로 불어난다.
                // 새로 삽입하는 경로와 동일한 상한(1280px)을 적용한 뒤 넣는다.
                const apply = (src) => {
                    img.style.height = 'auto'; // 비율이 바뀌었으므로 세로 자동
                    img.addEventListener('load', () => { updateSelectionBox(); markBookImageResized(img); }, { once: true });
                    img.src = src;
                    updateSelectionBox();
                    triggerAutoSave();
                };
                if (typeof window.compressImageDataUrl === 'function') {
                    window.compressImageDataUrl(result, 1280, 0.82).then(apply).catch(() => apply(result));
                } else {
                    apply(result);
                }
            });
        };
        resizeBtnGroup.appendChild(cropBtn);
        document.body.appendChild(resizeBtnGroup);
    }
    selectionBox.style.display = 'block'; resizeHandle.style.display = 'block'; deleteBtn.style.display = 'flex'; resizeBtnGroup.style.display = 'flex';
    // 자르기 버튼은 이미지일 때만 노출
    if (cropBtn) cropBtn.style.display = (currentSelectedElement && currentSelectedElement.tagName === 'IMG') ? 'flex' : 'none';
    
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
    resizeHandle.style.top = (rect.bottom + scrollTop - 11) + 'px'; resizeHandle.style.left = (rect.right + scrollLeft - 11) + 'px';
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

// 이미지 전체화면 보기 (읽기/책 모드에서 이미지 탭 시) — 다시 탭하면 닫힘
function fullscreenEscHandler(e) { if (e.key === 'Escape') closeImageFullscreen(); }
function openImageFullscreen(src) {
    if (!src) return;
    if (!imgFullscreenOverlay) {
        imgFullscreenOverlay = document.createElement('div');
        imgFullscreenOverlay.className = 'img-fullscreen-overlay';
        const im = document.createElement('img');
        im.className = 'img-fullscreen-img';
        im.alt = '';
        imgFullscreenOverlay.appendChild(im);
        imgFullscreenOverlay.addEventListener('click', closeImageFullscreen);
        document.body.appendChild(imgFullscreenOverlay);
    }
    imgFullscreenOverlay.querySelector('img').src = src;
    imgFullscreenOverlay.classList.add('show');
    document.addEventListener('keydown', fullscreenEscHandler);
}
function closeImageFullscreen() {
    if (imgFullscreenOverlay) {
        imgFullscreenOverlay.classList.remove('show');
        // 대용량 base64 이미지가 닫힌 뒤에도 DOM에 남아 메모리를 점유하지 않도록 해제
        const im = imgFullscreenOverlay.querySelector('img');
        if (im) im.src = '';
    }
    document.removeEventListener('keydown', fullscreenEscHandler);
}
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
    if (currentSelectedElement.tagName === 'IMG') {
        // 이미지는 가로만 조절하고 세로는 자동(원본 비율 유지) → 찌그러짐 방지
        if (newWidth > 40) { currentSelectedElement.style.width = newWidth + 'px'; currentSelectedElement.style.height = 'auto'; }
        updateSelectionBox();
        return;
    }
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
    if (currentSelectedElement.tagName === 'IMG') {
        // 이미지는 가로만 조절하고 세로는 자동(원본 비율 유지)
        if (newWidth > 40) { currentSelectedElement.style.width = newWidth + 'px'; currentSelectedElement.style.height = 'auto'; }
        updateSelectionBox();
        return;
    }
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
    markBookImageResized(currentSelectedElement);
    triggerAutoSave();
}

function stopResizeTouch() {
    isResizing = false;
    document.removeEventListener('touchmove', resizingTouch);
    document.removeEventListener('touchend', stopResizeTouch);
    markBookImageResized(currentSelectedElement);
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
        // 병합된 셀(colspan)이 있는 행에서도 범위를 벗어나지 않도록 보정
        const newCell = table.rows[i].insertCell(Math.min(colIdx + 1, table.rows[i].cells.length));
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
        // 병합된 셀(colspan)로 셀 수가 적은 행은 건너뜀 (범위 초과 방지)
        if (colIdx < table.rows[i].cells.length) table.rows[i].deleteCell(colIdx);
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
    
    let coveredArea = 0;
    selectedCells.forEach(cell => {
        // colspan/rowspan을 고려한 논리적 좌표 사용
        const rowIdx = cell.parentElement.rowIndex;
        const colIdx = getCellColumnIndex(cell);
        const rowSpan = cell.rowSpan || 1;
        const colSpan = cell.colSpan || 1;

        minRow = Math.min(minRow, rowIdx);
        maxRow = Math.max(maxRow, rowIdx + rowSpan - 1);
        minCol = Math.min(minCol, colIdx);
        maxCol = Math.max(maxCol, colIdx + colSpan - 1);
        coveredArea += rowSpan * colSpan;

        cellsInfo.push({ cell, rowIdx, colIdx });
    });

    // 직사각형 영역 확인
    const expectedCount = (maxRow - minRow + 1) * (maxCol - minCol + 1);
    if (coveredArea !== expectedCount) {
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
    
    // 첫 번째 셀 (왼쪽 위) - 논리 좌표 기준으로 선택된 셀 중에서 찾음
    const firstCell = cellsInfo[0].cell;
    if (!firstCell) return;

    const colsToMerge = maxCol - minCol + 1;
    const rowsToMerge = maxRow - minRow + 1;

    // 첫 번째 셀을 제외한 선택된 셀들만 정확히 삭제 (인덱스 추측 대신 실제 셀 제거)
    cellsInfo.forEach(info => {
        if (info.cell !== firstCell) info.cell.remove();
    });
    
    // 첫 번째 셀에 colspan, rowspan 설정
    if (colsToMerge > 1) {
        firstCell.colSpan = colsToMerge;
    }
    if (rowsToMerge > 1) {
        firstCell.rowSpan = rowsToMerge;
    }
    
    firstCell.innerHTML = mergedContent || '<br>';
    firstCell.classList.remove('selected-cell');

    // 병합 후 셀이 하나도 남지 않은 행은 제거 (이후 행/열 편집 인덱스 어긋남 방지)
    Array.from(table.rows).forEach(row => { if (row.cells.length === 0) row.remove(); });

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
export function insertImage(src) { saveBeforeChange('insert'); document.execCommand('insertImage', false, src); triggerAutoSave(); if (state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') { updateBookLayout(); updateBookNav(); } }
export function insertPlainText(text) {
    if (!text) return;
    const editor = document.getElementById('editor-body');
    if (!editor) return;
    saveBeforeChange('insert');
    editor.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
    const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = escape(text).replace(/\r\n|\r|\n/g, '<br>');
    document.execCommand('insertHTML', false, html);
    triggerAutoSave();
    if (state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') { updateBookLayout(); updateBookNav(); }
}
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

    // 저장된 커서 위치가 유효하면 복원하여 해당 위치에 표 삽입
    if (savedRange) {
        const selection = window.getSelection();
        if (editor.contains(savedRange.startContainer)) {
            selection.removeAllRanges();
            selection.addRange(savedRange);
        } else {
            // 저장된 위치가 더 이상 유효하지 않으면 본문 끝으로
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }
        savedRange = null;
    }

    document.execCommand('insertHTML', false, tableHtml);

    // 새로 삽입된 표에 스크롤 이벤트 리스너 추가
    setTimeout(() => {
        setupTableWrapperScroll(editor);
    }, 100);

    triggerAutoSave();
}
export function createHyperlink() { const selection = window.getSelection(); if (selection.rangeCount > 0 && selection.toString().length > 0) { const url = prompt("연결할 주소(URL)를 입력하세요:", "https://"); if (url && url !== "https://") { let href = url.trim(); if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) href = 'https://' + href; if (!/^https?:\/\//i.test(href)) { alert("http(s) 주소만 링크로 사용할 수 있습니다."); return; } saveBeforeChange('link'); document.execCommand('createLink', false, href); const anchor = selection.anchorNode?.parentElement; if (anchor && anchor.tagName === 'A') { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.style.color = '#2563EB'; anchor.style.textDecoration = 'underline'; anchor.style.cursor = 'pointer'; } triggerAutoSave(); } } else { alert("링크를 걸 문구를 먼저 드래그하여 선택해주세요."); } }

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
