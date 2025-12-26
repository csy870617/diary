import { state } from './state.js';
import { saveEntry } from './data.js';
import { saveToDrive } from './drive.js';

// ============================================
// [1] 전역 변수 및 상태
// ============================================
let currentSelectedImg = null;
let selectionBox = null;
let resizeHandle = null;
let deleteBtn = null;
let resizeBtnGroup = null;

// 자동 저장 타이머
let autoSaveTimer = null;

// 책 모드 상태
let isTurningPage = false;    
let currentBookPageIndex = 0; 
let touchStartX = 0;          
let wheelLockTimer = null;    

// ============================================
// [2] 자동 저장 (Auto-Save) 로직 - 작성 중 동기화 핵심
// ============================================
async function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    
    // 3초 동안 입력이 없으면 실행
    autoSaveTimer = setTimeout(async () => {
        const editBody = document.getElementById('editor-body');
        if (!editBody || state.currentViewMode !== 'default') return;

        console.log("작성 중인 내용을 자동 저장 및 클라우드 동기화 중...");
        
        // 1. 로컬 상태 업데이트
        await saveEntry(); 
        
        // 2. 즉시 클라우드 전송 (작성 중인 글은 강제로 밀어넣음)
        // 리스트를 리렌더링하지 않고 백그라운드에서 조용히 전송
        if (gapi.client && gapi.client.getToken()) {
            await saveToDrive(false); 
        }
    }, 3000);
}

// ============================================
// [3] 이벤트 핸들러
// ============================================

function handleBookWheel(e) {
    if (state.currentViewMode !== 'book') return;
    e.preventDefault();
    e.stopPropagation();

    if (wheelLockTimer) clearTimeout(wheelLockTimer);

    if (!isTurningPage) {
        if (Math.abs(e.deltaY) > 20) {
            const direction = e.deltaY > 0 ? 1 : -1;
            turnPage(direction);
            isTurningPage = true; 
        }
    }

    wheelLockTimer = setTimeout(() => {
        isTurningPage = false;
        wheelLockTimer = null;
    }, 500);
}

function handleBookTouchStart(e) {
    if (state.currentViewMode !== 'book') return;
    touchStartX = e.changedTouches[0].screenX;
}

function handleBookTouchMove(e) {
    if (state.currentViewMode !== 'book') return;
    e.preventDefault(); 
}

function handleBookTouchEnd(e) {
    if (state.currentViewMode !== 'book') return;
    if (isTurningPage) return;

    const touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > 50) {
        const direction = diff > 0 ? 1 : -1;
        turnPage(direction);
        isTurningPage = true;
        setTimeout(() => isTurningPage = false, 300);
    }
}

function handleBookResize() {
    if (state.currentViewMode === 'book') {
        updateBookLayout();
        const container = document.getElementById('editor-container');
        if(container) {
            const stride = Math.floor(container.clientWidth);
            container.scrollLeft = currentBookPageIndex * stride;
            updateBookNav();
        }
    }
}

// ============================================
// [4] 페이지 이동
// ============================================

export function turnPage(direction) { 
    const container = document.getElementById('editor-container');
    if (!container) return;

    const stride = Math.floor(container.clientWidth);
    const maxPage = Math.ceil(container.scrollWidth / stride) - 1;

    let nextIndex = currentBookPageIndex + direction;

    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex > maxPage) nextIndex = maxPage;

    if (nextIndex === currentBookPageIndex) return;

    currentBookPageIndex = nextIndex;
    container.scrollLeft = currentBookPageIndex * stride;
    updateBookNav();
}

function updateBookLayout() {
    const container = document.getElementById('editor-container');
    if (!container) return;
    
    const width = Math.floor(container.clientWidth);
    container.style.columnWidth = `${width}px`;
    container.style.columnGap = '0px';
    
    const targetHeight = window.innerHeight - 120; 
    container.style.height = `${targetHeight}px`;
    container.style.overflow = 'hidden';
}

export function updateBookNav() { 
    if (state.currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    const bookNavLeft = document.getElementById('book-nav-left');
    const bookNavRight = document.getElementById('book-nav-right');
    const pageIndicator = document.getElementById('page-indicator');

    if(!container) return;

    const stride = Math.floor(container.clientWidth);
    const scrollWidth = container.scrollWidth; 
    
    const currentPage = currentBookPageIndex + 1;
    const totalPages = Math.ceil(scrollWidth / stride) || 1; 
    
    if (bookNavLeft) {
        if (currentBookPageIndex > 0) bookNavLeft.classList.remove('hidden'); 
        else bookNavLeft.classList.add('hidden');
    }
    
    if (bookNavRight) {
        if (currentPage < totalPages) bookNavRight.classList.remove('hidden'); 
        else bookNavRight.classList.add('hidden');
    }
    
    if (pageIndicator) {
        pageIndicator.innerText = `${currentPage} / ${totalPages}`; 
        pageIndicator.classList.remove('hidden');
    }
}

// ============================================
// [5] 에디터 모드 관리
// ============================================

function linkifyContents(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    while(walker.nextNode()) nodes.push(walker.currentNode);
    const urlRegex = /((https?:\/\/|www\.)[^\s]+)/g;
    nodes.forEach(node => {
        if (node.parentNode.tagName === 'A' || node.parentNode.tagName === 'BUTTON' || node.parentNode.isContentEditable) return;
        const text = node.nodeValue;
        if (text.match(urlRegex)) {
            const fragment = document.createDocumentFragment();
            let lastIdx = 0;
            text.replace(urlRegex, (match, url, protocol, offset) => {
                fragment.appendChild(document.createTextNode(text.slice(lastIdx, offset)));
                const a = document.createElement('a');
                a.href = protocol === 'www.' ? 'http://' + url : url;
                a.target = '_blank';
                a.textContent = url;
                a.style.textDecoration = 'underline';
                a.style.color = '#2563EB'; a.style.cursor = 'pointer'; a.style.pointerEvents = 'auto'; 
                fragment.appendChild(a);
                lastIdx = offset + match.length;
            });
            fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
            node.parentNode.replaceChild(fragment, node);
        }
    });
}

function setupBasicHandling() {
    const editorBody = document.getElementById('editor-body');
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const writeModal = document.getElementById('write-modal');
    
    if (!editorBody) return;

    editorBody.onclick = (e) => {
        if (!editorBody.isContentEditable) return;
        if (e.target.tagName === 'IMG') {
            e.stopPropagation(); e.preventDefault(); selectImage(e.target);
        } else {
            hideImageSelection();
        }
    };

    if(writeModal) writeModal.addEventListener('scroll', updateSelectionBox);
    
    // 내용 입력 시 자동 저장 트리거
    editorBody.addEventListener('input', () => {
        updateSelectionBox();
        triggerAutoSave();
    });
    
    if(editTitle) editTitle.addEventListener('input', triggerAutoSave);
    if(editSubtitle) editSubtitle.addEventListener('input', triggerAutoSave);

    document.onkeydown = (e) => {
        if (currentSelectedImg && (e.key === 'Delete' || e.key === 'Backspace')) {
            deleteSelectedImage(e);
        }
    };
    
    window.removeEventListener('resize', handleBookResize); 
    window.addEventListener('resize', () => {
        updateSelectionBox();
        if(state.currentViewMode === 'book') handleBookResize();
    });
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
    state.isEditMode = isEdit; 
    const writeModal = document.getElementById('write-modal');
    writeModal.classList.remove('hidden');
    
    writeModal.scrollTop = 0;
    const editorContainer = document.getElementById('editor-container');
    if (editorContainer) {
        editorContainer.scrollTop = 0;
        editorContainer.scrollLeft = 0;
    }
    
    currentBookPageIndex = 0;
    isTurningPage = false;
    if(wheelLockTimer) clearTimeout(wheelLockTimer);
    
    if (!history.state || history.state.modal !== 'open') {
        history.pushState({ modal: 'open' }, null, '');
    }

    setupBasicHandling();
    
    const catName = state.allCategories.find(c => c.id === state.currentCategory)?.name || '기록';
    const displayCat = document.getElementById('display-category');
    if(displayCat) displayCat.innerText = catName;
    const displayDate = document.getElementById('display-date');
    if(displayDate) displayDate.innerText = entryData ? entryData.date : new Date().toLocaleDateString('ko-KR');

    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const editBody = document.getElementById('editor-body');

    if(isEdit && entryData) { 
        state.editingId = entryData.id; 
        editTitle.value = entryData.title || ''; 
        editSubtitle.value = entryData.subtitle || ''; 
        editBody.innerHTML = entryData.body || ''; 
        linkifyContents(editBody);
        applyFontStyle(entryData.fontFamily || 'Pretendard', entryData.fontSize || 16); 
    } else { 
        // 새 글 작성 시 즉시 ID 발급하여 동기화 준비
        state.editingId = Date.now().toString(); 
        editTitle.value = ''; 
        editSubtitle.value = ''; 
        editBody.innerHTML = ''; 
        applyFontStyle('Pretendard', 16); 
        setTimeout(() => editTitle.focus(), 100);
    } 
    state.lastFocusedEdit = editBody;
    
    toggleViewMode('default');
}

export function toggleViewMode(mode) {
    const previousMode = state.currentViewMode;
    const container = document.getElementById('editor-container');
    
    let savedScrollTop = 0;
    let savedPageIndex = 0;

    if (container) {
        if (previousMode === 'book') savedPageIndex = currentBookPageIndex;
        else savedScrollTop = container.scrollTop;
    }

    state.currentViewMode = mode;
    const writeModal = document.getElementById('write-modal');
    const editBody = document.getElementById('editor-body');
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const exitFocusBtn = document.getElementById('exit-view-btn');
    const editorToolbar = document.getElementById('editor-toolbar');
    const btnReadOnly = document.getElementById('btn-readonly');
    const btnBookMode = document.getElementById('btn-bookmode');
    const toolbarToggleBtn = document.getElementById('toolbar-toggle-btn');
    const toolbarIcon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;

    if(container) {
        container.style.height = ''; container.style.overflow = ''; 
        container.style.columnWidth = ''; container.style.columnGap = '';
        container.scrollLeft = 0; container.scrollTop = 0;
    }

    writeModal.classList.remove('mode-read-only', 'mode-book');
    const navs = document.querySelectorAll('.book-nav, #page-indicator');
    navs.forEach(el => el.classList.add('hidden'));
    if(exitFocusBtn) exitFocusBtn.classList.add('hidden');
    if(btnReadOnly) btnReadOnly.classList.remove('active');
    if(btnBookMode) btnBookMode.classList.remove('active');
    
    hideImageSelection();
    toggleBookEventListeners(false);

    if (mode === 'book') {
        editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false";
        linkifyContents(editBody);
        writeModal.classList.add('mode-book');
        if(btnBookMode) btnBookMode.classList.add('active');
        if(editorToolbar) {
            editorToolbar.classList.add('collapsed');
            if(toolbarIcon) { toolbarIcon.classList.remove('ph-caret-up'); toolbarIcon.classList.add('ph-caret-down'); }
        }
        currentBookPageIndex = 0;
        updateBookLayout(); 
        toggleBookEventListeners(true);
        setTimeout(() => {
            if(container) {
                const pageHeight = container.clientHeight; 
                const stride = Math.floor(container.clientWidth);
                if(pageHeight > 0) {
                    currentBookPageIndex = Math.floor(savedScrollTop / pageHeight);
                    container.scrollLeft = currentBookPageIndex * stride;
                    updateBookNav();
                }
            }
        }, 50);
    } else {
        if (mode === 'readOnly') {
            editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false"; linkifyContents(editBody);
            writeModal.classList.add('mode-read-only');
            if(btnReadOnly) btnReadOnly.classList.add('active');
            if(editorToolbar) editorToolbar.classList.add('collapsed');
        } else {
            editTitle.readOnly = false; editSubtitle.readOnly = false; editBody.contentEditable = "true";
            if(editorToolbar) { editorToolbar.classList.remove('collapsed'); }
        }
        setTimeout(() => {
            if(container) container.scrollTop = (previousMode === 'book') ? savedPageIndex * (window.innerHeight - 120) : savedScrollTop;
        }, 50);
    }
}

function selectImage(img) {
    if (currentSelectedImg === img) return;
    currentSelectedImg = img;
    createSelectionUI();
    updateSelectionBox();
}
function hideImageSelection() {
    currentSelectedImg = null;
    if (selectionBox) selectionBox.style.display = 'none';
    if (resizeHandle) resizeHandle.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (resizeBtnGroup) resizeBtnGroup.style.display = 'none';
}
function createSelectionUI() {
    if (!selectionBox) {
        selectionBox = document.createElement('div'); selectionBox.className = 'img-selection-box'; document.body.appendChild(selectionBox);
        resizeHandle = document.createElement('div'); resizeHandle.className = 'resize-handle se'; document.body.appendChild(resizeHandle);
        resizeHandle.addEventListener('mousedown', startResize); resizeHandle.addEventListener('touchstart', startResize, {passive: false});
        deleteBtn = document.createElement('button'); deleteBtn.className = 'img-delete-btn'; deleteBtn.innerHTML = '<i class="ph ph-trash"></i> 삭제'; document.body.appendChild(deleteBtn);
        deleteBtn.addEventListener('click', deleteSelectedImage);
        resizeBtnGroup = document.createElement('div'); resizeBtnGroup.className = 'img-resize-group';
        [25, 50, 75, 100].forEach(size => {
            const btn = document.createElement('button'); btn.className = 'img-resize-btn'; btn.innerText = size + '%';
            btn.onclick = (e) => { e.stopPropagation(); if (currentSelectedImg) { currentSelectedImg.style.width = size + '%'; currentSelectedImg.style.height = 'auto'; updateSelectionBox(); triggerAutoSave(); } };
            resizeBtnGroup.appendChild(btn);
        });
        document.body.appendChild(resizeBtnGroup);
    }
    selectionBox.style.display = 'block'; resizeHandle.style.display = 'block'; deleteBtn.style.display = 'flex'; resizeBtnGroup.style.display = 'flex';
}
function updateSelectionBox() {
    if (!currentSelectedImg || !selectionBox) return;
    const rect = currentSelectedImg.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
    selectionBox.style.top = (rect.top + scrollTop) + 'px'; selectionBox.style.left = (rect.left + scrollLeft) + 'px'; selectionBox.style.width = rect.width + 'px'; selectionBox.style.height = rect.height + 'px';
    resizeHandle.style.top = (rect.bottom + scrollTop - 10) + 'px'; resizeHandle.style.left = (rect.right + scrollLeft - 10) + 'px';
    deleteBtn.style.top = (rect.top + scrollTop - 40) + 'px'; deleteBtn.style.left = (rect.left + scrollLeft + rect.width / 2) + 'px';
    resizeBtnGroup.style.top = (rect.bottom + scrollTop + 10) + 'px'; resizeBtnGroup.style.left = (rect.left + scrollLeft + rect.width / 2) + 'px';
}
function deleteSelectedImage(e) { if(e) { e.preventDefault(); e.stopPropagation(); } if (currentSelectedImg) { currentSelectedImg.remove(); hideImageSelection(); triggerAutoSave(); } }
let isResizing = false; let startX, startWidth;
function startResize(e) { e.preventDefault(); e.stopPropagation(); isResizing = true; const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX; startX = clientX; startWidth = currentSelectedImg.clientWidth; document.addEventListener('mousemove', resizing); document.addEventListener('touchmove', resizing, {passive: false}); document.addEventListener('mouseup', stopResize); document.addEventListener('touchend', stopResize); }
function resizing(e) { if (!isResizing || !currentSelectedImg) return; const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX; const dx = clientX - startX; const newWidth = startWidth + dx; const containerWidth = document.getElementById('editor-body').clientWidth; if (newWidth > 50 && newWidth <= containerWidth) { currentSelectedImg.style.width = newWidth + 'px'; currentSelectedImg.style.height = 'auto'; updateSelectionBox(); } }
function stopResize() { isResizing = false; document.removeEventListener('mousemove', resizing); document.removeEventListener('touchmove', resizing); document.removeEventListener('mouseup', stopResize); document.removeEventListener('touchend', stopResize); triggerAutoSave(); }

export function formatDoc(cmd, value = null) { const editBody = document.getElementById('editor-body'); if (!editBody) return; editBody.focus(); document.execCommand(cmd, false, value); triggerAutoSave(); }
export function applyFontStyle(f, s) { state.currentFontFamily = f; state.currentFontSize = s; const editBody = document.getElementById('editor-body'); if(editBody) { editBody.style.fontFamily = f; editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; } }
export function changeGlobalFontSize(delta) { const editBody = document.getElementById('editor-body'); if(!editBody) return; const style = window.getComputedStyle(editBody); let currentSize = parseFloat(style.fontSize) || 16; let newSize = currentSize + delta; if(newSize < 12) newSize = 12; if(newSize > 60) newSize = 60; state.currentFontSize = newSize; applyFontStyle(state.currentFontFamily, newSize); triggerAutoSave(); }
export function insertSticker(emoji) { const editBody = document.getElementById('editor-body'); if (editBody) { editBody.focus(); document.execCommand('insertText', false, emoji); } triggerAutoSave(); }
export function insertImage(src) { const editBody = document.getElementById('editor-body'); if (editBody) { editBody.focus(); document.execCommand('insertImage', false, src); } triggerAutoSave(); }