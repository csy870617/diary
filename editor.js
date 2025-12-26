import { state } from './state.js';
import { saveEntry } from './data.js';
import { saveToDrive } from './drive.js';
import { openModal } from './ui.js';

// ============================================
// [1] 전역 변수 및 상태
// ============================================
let currentSelectedImg = null;
let selectionBox = null;
let resizeHandle = null;
let deleteBtn = null;
let resizeBtnGroup = null;

let autoSaveTimer = null;
let isTurningPage = false;    
let currentBookPageIndex = 0; 
let touchStartX = 0;          
let wheelLockTimer = null;    

/**
 * 실시간 자동 저장 및 클라우드 동기화
 */
async function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    
    autoSaveTimer = setTimeout(async () => {
        const editBody = document.getElementById('editor-body');
        if (!editBody || state.currentViewMode !== 'default') return;

        console.log("자동 저장 및 동기화...");
        await saveEntry(); 
        
        if (window.gapi && gapi.client && gapi.client.getToken()) {
            await saveToDrive(); 
        }
    }, 3000);
}

// ============================================
// [2] 이벤트 핸들러
// ============================================

function handleBookWheel(e) {
    if (state.currentViewMode !== 'book') return;
    e.preventDefault(); e.stopPropagation();

    if (wheelLockTimer) clearTimeout(wheelLockTimer);

    if (!isTurningPage) {
        if (Math.abs(e.deltaY) > 20) {
            turnPage(e.deltaY > 0 ? 1 : -1);
            isTurningPage = true; 
        }
    }

    wheelLockTimer = setTimeout(() => {
        isTurningPage = false; wheelLockTimer = null;
    }, 500);
}

function handleBookTouchStart(e) {
    if (state.currentViewMode === 'book') touchStartX = e.changedTouches[0].screenX;
}

function handleBookTouchMove(e) {
    if (state.currentViewMode === 'book') e.preventDefault(); 
}

function handleBookTouchEnd(e) {
    if (state.currentViewMode !== 'book' || isTurningPage) return;

    const diff = touchStartX - e.changedTouches[0].screenX;
    if (Math.abs(diff) > 50) {
        turnPage(diff > 0 ? 1 : -1);
        isTurningPage = true;
        setTimeout(() => isTurningPage = false, 300);
    }
}

function handleBookResize() {
    if (state.currentViewMode === 'book') {
        updateBookLayout();
        const container = document.getElementById('editor-container');
        if(container) {
            container.scrollLeft = currentBookPageIndex * Math.floor(container.clientWidth);
            updateBookNav();
        }
    }
}

// ============================================
// [3] 페이지 이동
// ============================================

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
}

// ============================================
// [4] 에디터 모드 관리
// ============================================

function linkifyContents(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    const nodes = [];
    while(walker.nextNode()) nodes.push(walker.currentNode);
    const urlRegex = /((https?:\/\/|www\.)[^\s]+)/g;
    nodes.forEach(node => {
        if (node.parentNode.tagName === 'A' || node.parentNode.isContentEditable) return;
        const text = node.nodeValue;
        if (text.match(urlRegex)) {
            const fragment = document.createDocumentFragment();
            let lastIdx = 0;
            text.replace(urlRegex, (match, url, protocol, offset) => {
                fragment.appendChild(document.createTextNode(text.slice(lastIdx, offset)));
                const a = document.createElement('a');
                a.href = protocol === 'www.' ? 'http://' + url : url;
                a.target = '_blank'; a.textContent = url;
                a.style.textDecoration = 'underline'; a.style.color = '#2563EB'; a.style.cursor = 'pointer'; 
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
    if (!editorBody) return;

    editorBody.onclick = (e) => {
        if (!editorBody.isContentEditable) return;
        if (e.target.tagName === 'IMG') { e.stopPropagation(); e.preventDefault(); selectImage(e.target); }
        else hideImageSelection();
    };
    
    editorBody.addEventListener('input', () => { updateSelectionBox(); triggerAutoSave(); });
    editTitle?.addEventListener('input', triggerAutoSave);
    editSubtitle?.addEventListener('input', triggerAutoSave);

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
    if(!writeModal) return;
    
    // [수정] openModal을 사용하여 히스토리 상태를 관리
    openModal(writeModal);

    writeModal.scrollTop = 0;
    currentBookPageIndex = 0;
    setupBasicHandling();
    
    const catName = state.allCategories.find(c => c.id === state.currentCategory)?.name || '기록';
    document.getElementById('display-category').innerText = catName;
    document.getElementById('display-date').innerText = entryData ? entryData.date : new Date().toLocaleDateString('ko-KR');

    const editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editBody = document.getElementById('editor-body');

    if(isEdit && entryData) { 
        state.editingId = entryData.id; 
        editTitle.value = entryData.title || ''; editSubtitle.value = entryData.subtitle || ''; editBody.innerHTML = entryData.body || ''; 
        linkifyContents(editBody); applyFontStyle(entryData.fontFamily || 'Pretendard', entryData.fontSize || 16); 
    } else { 
        state.editingId = Date.now().toString(); 
        editTitle.value = ''; editSubtitle.value = ''; editBody.innerHTML = ''; 
        applyFontStyle('Pretendard', 16); setTimeout(() => editTitle.focus(), 100);
    } 
    toggleViewMode('default');
}

export function toggleViewMode(mode) {
    const container = document.getElementById('editor-container');
    state.currentViewMode = mode;
    const writeModal = document.getElementById('write-modal'), editBody = document.getElementById('editor-body'), editTitle = document.getElementById('edit-title'), editSubtitle = document.getElementById('edit-subtitle'), editorToolbar = document.getElementById('editor-toolbar');

    if(container) {
        container.style.height = ''; container.style.overflow = ''; 
        container.style.columnWidth = ''; container.style.columnGap = '';
        container.scrollLeft = 0;
    }

    writeModal.classList.remove('mode-read-only', 'mode-book');
    document.querySelectorAll('.book-nav, #page-indicator').forEach(el => el.classList.add('hidden'));
    hideImageSelection(); toggleBookEventListeners(false);

    if (mode === 'book') {
        editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false";
        linkifyContents(editBody); writeModal.classList.add('mode-book');
        updateBookLayout(); toggleBookEventListeners(true); updateBookNav();
    } else if (mode === 'readOnly') {
        editTitle.readOnly = true; editSubtitle.readOnly = true; editBody.contentEditable = "false";
        writeModal.classList.add('mode-read-only'); editorToolbar?.classList.add('collapsed');
    } else {
        editTitle.readOnly = false; editSubtitle.readOnly = false; editBody.contentEditable = "true";
        editorToolbar?.classList.remove('collapsed');
    }
}

function selectImage(img) { currentSelectedImg = img; createSelectionUI(); updateSelectionBox(); }
function hideImageSelection() {
    currentSelectedImg = null;
    ['img-selection-box', 'resize-handle', 'img-delete-btn', 'img-resize-group'].forEach(id => {
        const el = document.querySelector('.' + id) || document.getElementById(id);
        if(el) el.style.display = 'none';
    });
}
function createSelectionUI() {
    if (!selectionBox) {
        selectionBox = document.createElement('div'); selectionBox.className = 'img-selection-box'; document.body.appendChild(selectionBox);
        resizeHandle = document.createElement('div'); resizeHandle.className = 'resize-handle se'; document.body.appendChild(resizeHandle);
        resizeHandle.onmousedown = (e) => startResize(e);
        deleteBtn = document.createElement('button'); deleteBtn.className = 'img-delete-btn'; deleteBtn.innerHTML = '<i class="ph ph-trash"></i> 삭제'; document.body.appendChild(deleteBtn);
        deleteBtn.onclick = deleteSelectedImage;
        resizeBtnGroup = document.createElement('div'); resizeBtnGroup.className = 'img-resize-group';
        [25, 50, 75, 100].forEach(size => {
            const btn = document.createElement('button'); btn.className = 'img-resize-btn'; btn.innerText = size + '%';
            btn.onclick = () => { if (currentSelectedImg) { currentSelectedImg.style.width = size + '%'; currentSelectedImg.style.height = 'auto'; updateSelectionBox(); triggerAutoSave(); } };
            resizeBtnGroup.appendChild(btn);
        });
        document.body.appendChild(resizeBtnGroup);
    }
    selectionBox.style.display = 'block'; resizeHandle.style.display = 'block'; deleteBtn.style.display = 'flex'; resizeBtnGroup.style.display = 'flex';
}
function updateSelectionBox() {
    if (!currentSelectedImg || !selectionBox) return;
    const rect = currentSelectedImg.getBoundingClientRect();
    const scrollTop = window.scrollY, scrollLeft = window.scrollX;
    selectionBox.style.top = (rect.top + scrollTop) + 'px'; selectionBox.style.left = (rect.left + scrollLeft) + 'px'; selectionBox.style.width = rect.width + 'px'; selectionBox.style.height = rect.height + 'px';
    resizeHandle.style.top = (rect.bottom + scrollTop - 10) + 'px'; resizeHandle.style.left = (rect.right + scrollLeft - 10) + 'px';
    deleteBtn.style.top = (rect.top + scrollTop - 40) + 'px'; deleteBtn.style.left = (rect.left + scrollLeft + rect.width / 2) + 'px';
    resizeBtnGroup.style.top = (rect.bottom + scrollTop + 10) + 'px'; resizeBtnGroup.style.left = (rect.left + scrollLeft + rect.width / 2) + 'px';
}
function deleteSelectedImage() { if (currentSelectedImg) { currentSelectedImg.remove(); hideImageSelection(); triggerAutoSave(); } }
let isResizing = false, startX, startWidth;
function startResize(e) { e.preventDefault(); isResizing = true; startX = e.clientX; startWidth = currentSelectedImg.clientWidth; document.addEventListener('mousemove', resizing); document.addEventListener('mouseup', stopResize); }
function resizing(e) { if (!isResizing || !currentSelectedImg) return; const newWidth = startWidth + (e.clientX - startX); if (newWidth > 50) { currentSelectedImg.style.width = newWidth + 'px'; updateSelectionBox(); } }
function stopResize() { isResizing = false; document.removeEventListener('mousemove', resizing); document.removeEventListener('mouseup', stopResize); triggerAutoSave(); }

export function formatDoc(cmd, value = null) { document.execCommand(cmd, false, value); triggerAutoSave(); }
export function applyFontStyle(f, s) { state.currentFontFamily = f; state.currentFontSize = s; const editBody = document.getElementById('editor-body'); if(editBody) { editBody.style.fontFamily = f; editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; } }
export function changeGlobalFontSize(delta) { 
    state.currentFontSize = Math.max(12, Math.min(60, state.currentFontSize + delta));
    applyFontStyle(state.currentFontFamily, state.currentFontSize); triggerAutoSave(); 
}
export function insertSticker(emoji) { document.execCommand('insertText', false, emoji); triggerAutoSave(); }
export function insertImage(src) { document.execCommand('insertImage', false, src); triggerAutoSave(); }