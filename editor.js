import { state } from './state.js';
import { saveEntry } from './data.js';

// ============================================
// [1] 전역 변수 및 상태
// ============================================
let currentSelectedImg = null;
let selectionBox = null;
let resizeHandle = null;
let deleteBtn = null;
let resizeBtnGroup = null;

// 책 모드 상태
let isTurningPage = false;    // 페이지 넘김 락
let currentBookPageIndex = 0; // 현재 페이지 번호
let touchStartX = 0;          // 터치 시작 좌표

// 휠 쿨타임 (관성 제어용)
let wheelLockTimer = null;

// ============================================
// [2] 이벤트 핸들러
// ============================================

function handleBookWheel(e) {
    if (state.currentViewMode !== 'book') return;

    // 1. 브라우저의 모든 기본 스크롤 동작 차단
    e.preventDefault();
    e.stopPropagation();

    // 2. 락이 걸려있으면(페이지 넘어가는 중 or 관성 남음) 무시
    if (isTurningPage) return;

    // 3. 휠 감도 설정 (작은 떨림 무시)
    if (Math.abs(e.deltaY) < 30) return;

    // 4. 방향 결정
    const direction = e.deltaY > 0 ? 1 : -1;
    turnPage(direction);
    
    // 5. 휠 이벤트가 발생하면 즉시 락을 걸고, 0.5초 뒤에 품
    // (연속 휠 동작을 하나의 동작으로 처리)
    isTurningPage = true;
    if (wheelLockTimer) clearTimeout(wheelLockTimer);
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
    e.preventDefault(); // 모바일 스크롤 차단
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
        updateBookLayout(); // 레이아웃 및 높이 재계산
        const container = document.getElementById('editor-container');
        if(container) {
            // 리사이즈 시 현재 페이지 위치 유지
            const stride = Math.floor(container.clientWidth);
            container.scrollLeft = currentBookPageIndex * stride;
            updateBookNav();
        }
    }
}

// ============================================
// [3] 페이지 이동 (순간 이동 방식)
// ============================================

export function turnPage(direction) { 
    const container = document.getElementById('editor-container');
    if (!container) return;

    // 정확한 1페이지 너비 계산
    const stride = Math.floor(container.clientWidth);
    const maxPage = Math.ceil(container.scrollWidth / stride) - 1;

    let nextIndex = currentBookPageIndex + direction;

    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex > maxPage) nextIndex = maxPage;

    if (nextIndex === currentBookPageIndex) return;

    currentBookPageIndex = nextIndex;

    // [핵심] 애니메이션 없이 좌표 강제 주입 (텔레포트)
    container.scrollLeft = currentBookPageIndex * stride;

    updateBookNav();
}

function updateBookLayout() {
    const container = document.getElementById('editor-container');
    if (!container) return;
    
    // [중요] JS로 스타일 강제 주입 (CSS 무시 방지)
    // 1. 가로 너비 설정
    const width = Math.floor(container.clientWidth);
    container.style.columnWidth = `${width}px`;
    container.style.columnGap = '0px';
    
    // 2. 높이 설정 (화면 높이 - 120px) -> 하단 여백 확보
    // 모바일 주소창 등을 고려해 window.innerHeight 사용
    const targetHeight = window.innerHeight - 120; 
    container.style.height = `${targetHeight}px`;
    
    // 3. 스크롤바 숨김 강제
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
// [4] 에디터 모드 관리 (위치 동기화 포함)
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
    editorBody.addEventListener('input', updateSelectionBox);

    document.onkeydown = (e) => {
        if (currentSelectedImg && (e.key === 'Delete' || e.key === 'Backspace')) {
            deleteSelectedImage(e);
        }
    };
    
    // 리사이즈 이벤트 등록 (기존 리스너 제거 후 등록)
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
        state.editingId = null; 
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
        if (previousMode === 'book') {
            savedPageIndex = currentBookPageIndex;
        } else {
            savedScrollTop = container.scrollTop;
        }
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

    // 스타일 초기화 (일반 모드로 복귀 시 필수)
    if(container) {
        container.style.height = ''; // JS 강제 스타일 제거
        container.style.overflow = ''; // JS 강제 스타일 제거
        container.style.columnWidth = ''; 
        container.style.columnGap = '';
        container.scrollLeft = 0; 
        container.scrollTop = 0;
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
        // [책 모드]
        editTitle.readOnly = true; 
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        linkifyContents(editBody);
        
        writeModal.classList.add('mode-book');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnBookMode) btnBookMode.classList.add('active');
        if(editorToolbar) {
            editorToolbar.classList.add('collapsed');
            if(toolbarIcon) { toolbarIcon.classList.remove('ph-caret-up'); toolbarIcon.classList.add('ph-caret-down'); }
        }

        // [중요] 초기화 및 리스너 등록
        currentBookPageIndex = 0;
        updateBookLayout(); 
        toggleBookEventListeners(true);
        
        // 위치 복원 (일반 -> 책)
        setTimeout(() => {
            if(container) {
                // 현재 높이는 JS로 강제 설정된 값 사용
                const pageHeight = container.clientHeight; 
                const stride = Math.floor(container.clientWidth);
                // 안전장치: 0으로 나누기 방지
                if(pageHeight > 0) {
                    const targetIndex = Math.floor(savedScrollTop / pageHeight);
                    currentBookPageIndex = targetIndex;
                    container.scrollLeft = currentBookPageIndex * stride;
                    updateBookNav();
                }
            }
        }, 50);

    } else {
        // [일반/읽기 모드]
        if (mode === 'readOnly') {
            editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false"; linkifyContents(editBody);
            writeModal.classList.add('mode-read-only');
            if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
            if(btnReadOnly) btnReadOnly.classList.add('active');
            if(editorToolbar) editorToolbar.classList.add('collapsed');
        } else {
            editTitle.readOnly = false; editSubtitle.readOnly = false; editBody.contentEditable = "true";
            if(editorToolbar) { 
                editorToolbar.style.transition = ''; 
                editorToolbar.classList.remove('collapsed'); 
                if(toolbarIcon) { toolbarIcon.classList.remove('ph-caret-down'); toolbarIcon.classList.add('ph-caret-up'); } 
            }
        }

        // 위치 복원 (책 -> 일반)
        setTimeout(() => {
            if(container && previousMode === 'book') {
                // 이전 모드(책)에서의 페이지 높이를 추정해야 함. 
                // 지금은 일반모드로 돌아왔으므로 container.clientHeight는 다름.
                // 따라서 저장 당시의 높이(화면높이 - 120)를 역산
                const estimatedPageHeight = window.innerHeight - 120;
                container.scrollTop = savedPageIndex * estimatedPageHeight;
            } else if (container) {
                container.scrollTop = savedScrollTop;
            }
        }, 50);
    }
}

// ============================================
// [5] 기타 유틸리티 함수
// ============================================

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
            btn.onclick = (e) => { e.stopPropagation(); if (currentSelectedImg) { currentSelectedImg.style.width = size + '%'; currentSelectedImg.style.height = 'auto'; updateSelectionBox(); debouncedSave(); } };
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
function deleteSelectedImage(e) { if(e) { e.preventDefault(); e.stopPropagation(); } if (currentSelectedImg) { currentSelectedImg.remove(); hideImageSelection(); debouncedSave(); } }
let isResizing = false; let startX, startWidth;
function startResize(e) { e.preventDefault(); e.stopPropagation(); isResizing = true; const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX; startX = clientX; startWidth = currentSelectedImg.clientWidth; document.addEventListener('mousemove', resizing); document.addEventListener('touchmove', resizing, {passive: false}); document.addEventListener('mouseup', stopResize); document.addEventListener('touchend', stopResize); }
function resizing(e) { if (!isResizing || !currentSelectedImg) return; const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX; const dx = clientX - startX; const newWidth = startWidth + dx; const containerWidth = document.getElementById('editor-body').clientWidth; if (newWidth > 50 && newWidth <= containerWidth) { currentSelectedImg.style.width = newWidth + 'px'; currentSelectedImg.style.height = 'auto'; updateSelectionBox(); } }
function stopResize() { isResizing = false; document.removeEventListener('mousemove', resizing); document.removeEventListener('touchmove', resizing); document.removeEventListener('mouseup', stopResize); document.removeEventListener('touchend', stopResize); debouncedSave(); }

export function formatDoc(cmd, value = null) { const editBody = document.getElementById('editor-body'); if (!editBody) return; editBody.focus(); document.execCommand(cmd, false, value); debouncedSave(); }
export function applyFontStyle(f, s) { state.currentFontFamily = f; state.currentFontSize = s; const editBody = document.getElementById('editor-body'); if(editBody) { editBody.style.fontFamily = f; editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; } }
export function changeGlobalFontSize(delta) { const editBody = document.getElementById('editor-body'); if(!editBody) return; const style = window.getComputedStyle(editBody); let currentSize = parseFloat(style.fontSize) || 16; let newSize = currentSize + delta; if(newSize < 12) newSize = 12; if(newSize > 60) newSize = 60; state.currentFontSize = newSize; applyFontStyle(state.currentFontFamily, newSize); debouncedSave(); }
export function insertSticker(emoji) { const editBody = document.getElementById('editor-body'); if (editBody) { editBody.focus(); document.execCommand('insertText', false, emoji); } debouncedSave(); }
export function insertImage(src) { const editBody = document.getElementById('editor-body'); if (editBody) { editBody.focus(); document.execCommand('insertImage', false, src); } debouncedSave(); }
function debouncedSave() { if(state.autoSaveTimer) clearTimeout(state.autoSaveTimer); state.autoSaveTimer = setTimeout(saveEntry, 1000); }