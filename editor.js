import { state } from './state.js';
import { saveEntry } from './data.js';
import { autoLink } from './utils.js';

export function makeBookEditButton() {
    const btnBookMode = document.getElementById('btn-bookmode');
    
    // 이미 버튼이 존재하면 전역 변수에 할당하고 종료
    if (document.getElementById('btn-book-edit')) {
        window.btnBookEdit = document.getElementById('btn-book-edit');
        return;
    }

    if (btnBookMode && btnBookMode.parentElement) {
        const btn = document.createElement('button');
        btn.id = 'btn-book-edit';
        btn.className = 'icon-btn';
        btn.title = "페이지 편집";
        // 기본 상태: 연필 아이콘
        btn.innerHTML = '<i class="ph ph-pencil-simple" style="font-size: 18px;"></i>';
        btn.style.cssText = "display: none; align-items: center; justify-content: center; gap: 4px; font-family: 'Pretendard'; font-size: 14px; font-weight: 600; color: #4B5563; background: transparent; border: none; cursor: pointer; padding: 8px; margin-left: 4px; border-radius: 6px; width: 36px; height: 36px;";
        
        btn.addEventListener('mouseover', () => btn.style.backgroundColor = '#F3F4F6');
        btn.addEventListener('mouseout', () => btn.style.backgroundColor = 'transparent');
        // 클릭 시 토글 함수 실행
        btn.addEventListener('click', toggleBookEditing);

        if (btnBookMode.nextSibling) btnBookMode.parentElement.insertBefore(btn, btnBookMode.nextSibling);
        else btnBookMode.parentElement.appendChild(btn);
        
        window.btnBookEdit = btn;
    }
    
    const closeWriteBtn = document.getElementById('close-write-btn');
    const headerLeft = document.querySelector('.write-header .header-left');
    if (headerLeft && closeWriteBtn && !headerLeft.contains(closeWriteBtn)) {
        headerLeft.prepend(closeWriteBtn);
    }
}

export function openEditor(isEdit, entryData) { 
    state.isEditMode = isEdit; 
    document.getElementById('write-modal').classList.remove('hidden');
    
    if (!history.state || history.state.modal !== 'open') {
        history.pushState({ modal: 'open' }, null, '');
    }

    makeBookEditButton();
    
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
        editTitle.value = entryData.title; 
        editSubtitle.value = entryData.subtitle; 
        editBody.innerHTML = autoLink(entryData.body); 
        applyFontStyle(entryData.fontFamily||'Pretendard', entryData.fontSize||16); 
    } else { 
        state.editingId = null; 
        editTitle.value = ''; 
        editSubtitle.value = ''; 
        editBody.innerHTML = ''; 
        applyFontStyle('Pretendard', 16); 
    } 
    state.lastFocusedEdit = editBody;
    toggleViewMode('default', false);
}

// [수정] 책 편집 모드 토글 함수
export function toggleBookEditing() {
    if(state.currentViewMode !== 'book') return;

    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const editBody = document.getElementById('editor-body');
    const editorToolbar = document.getElementById('editor-toolbar');
    const toolbarToggleBtn = document.getElementById('toolbar-toggle-btn');
    const btn = window.btnBookEdit || document.getElementById('btn-book-edit');

    // 현재 편집 가능 상태인지 확인
    const isEditable = editBody.isContentEditable;

    if (!isEditable) {
        // --- 편집 모드 켜기 ---
        editTitle.readOnly = false;
        editSubtitle.readOnly = false;
        editBody.contentEditable = "true";
        editBody.focus();

        // 툴바 펼치기
        if(editorToolbar) {
            editorToolbar.classList.remove('collapsed');
            const icon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
            if(icon) {
                icon.classList.remove('ph-caret-down');
                icon.classList.add('ph-caret-up');
            }
        }

        // 버튼 아이콘 변경 (V 체크 모양)
        if(btn) {
            btn.innerHTML = '<i class="ph ph-check" style="font-size: 18px; color: #10B981;"></i>'; // 녹색 체크
            btn.title = "편집 완료";
        }

    } else {
        // --- 편집 모드 끄기 (저장 & 책 모드 복귀) ---
        editTitle.readOnly = true;
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";

        // 툴바 접기
        if(editorToolbar) {
            editorToolbar.classList.add('collapsed');
            const icon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
            if(icon) {
                icon.classList.remove('ph-caret-up');
                icon.classList.add('ph-caret-down');
            }
        }

        // 버튼 아이콘 복구 (연필 모양)
        if(btn) {
            btn.innerHTML = '<i class="ph ph-pencil-simple" style="font-size: 18px;"></i>';
            btn.title = "페이지 편집";
        }
        
        // 변경사항 저장 (디바운스 트리거)
        debouncedSave();
    }
}

// 기존 호환성을 위해 이름만 남겨둠 (실제 사용은 toggleBookEditing)
export function enableBookEditing() {
    toggleBookEditing();
}

export function toggleViewMode(mode) {
    state.currentViewMode = mode;
    const writeModal = document.getElementById('write-modal');
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const editBody = document.getElementById('editor-body');
    const bookNavLeft = document.getElementById('book-nav-left');
    const bookNavRight = document.getElementById('book-nav-right');
    const pageIndicator = document.getElementById('page-indicator');
    const exitFocusBtn = document.getElementById('exit-view-btn'); 
    const editorToolbar = document.getElementById('editor-toolbar');
    const toolbarToggleBtn = document.getElementById('toolbar-toggle-btn');
    const btnBookEdit = window.btnBookEdit || document.getElementById('btn-book-edit');

    writeModal.classList.remove('mode-read-only', 'mode-book');
    bookNavLeft.classList.add('hidden');
    bookNavRight.classList.add('hidden');
    pageIndicator.classList.add('hidden');
    if(exitFocusBtn) exitFocusBtn.classList.add('hidden');
    
    const btnReadOnly = document.getElementById('btn-readonly');
    const btnBookMode = document.getElementById('btn-bookmode');
    if(btnReadOnly) btnReadOnly.classList.remove('active');
    if(btnBookMode) btnBookMode.classList.remove('active');
    
    const toolbarIcon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;

    if (mode === 'readOnly') {
        editTitle.readOnly = true;
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        editBody.style.pointerEvents = "auto";
        editBody.style.userSelect = "text";
        
        writeModal.classList.add('mode-read-only');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnReadOnly) btnReadOnly.classList.add('active');
        if(btnBookEdit) btnBookEdit.style.display = 'none';

    } else if (mode === 'book') {
        // 책 모드 진입 시 초기화 (편집 불가능 상태)
        editTitle.readOnly = true; 
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        editBody.style.pointerEvents = "auto";
        editBody.style.userSelect = "text";
        
        writeModal.classList.add('mode-book');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnBookMode) btnBookMode.classList.add('active');
        const container = document.getElementById('editor-container');
        if(container) container.scrollLeft = 0; 
        updateBookNav();
        
        // 툴바 접기
        if(editorToolbar) {
            editorToolbar.classList.add('collapsed');
            if(toolbarIcon) {
                toolbarIcon.classList.remove('ph-caret-up');
                toolbarIcon.classList.add('ph-caret-down');
            }
        }
        
        // 편집 버튼 보이기 및 초기화
        if(!btnBookEdit) makeBookEditButton();
        const btn = window.btnBookEdit || document.getElementById('btn-book-edit');
        if(btn) {
            btn.style.display = 'inline-flex';
            btn.innerHTML = '<i class="ph ph-pencil-simple" style="font-size: 18px;"></i>'; // 아이콘 초기화
        }

    } else {
        // 기본 모드
        editTitle.readOnly = false;
        editSubtitle.readOnly = false;
        editBody.contentEditable = "true";
        editBody.style.pointerEvents = "auto";
        editBody.style.userSelect = "text";
        
        if(btnBookEdit) btnBookEdit.style.display = 'none';
        
        if(editorToolbar) {
            editorToolbar.classList.remove('collapsed');
            if(toolbarIcon) {
                toolbarIcon.classList.remove('ph-caret-down');
                toolbarIcon.classList.add('ph-caret-up');
            }
        }
    }
}

export function formatDoc(cmd, value = null) {
    const editBody = document.getElementById('editor-body');
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    
    if (document.activeElement === editTitle || document.activeElement === editSubtitle) return;
    if (!editBody) return;
    editBody.focus();
    document.execCommand(cmd, false, value);
    debouncedSave(); 
}

export function applyFontStyle(f, s) { 
    state.currentFontFamily = f; 
    state.currentFontSize = s; 
    const editBody = document.getElementById('editor-body');
    if(editBody) {
        editBody.style.fontFamily = f; 
        editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; 
    }
    const fontSelector = document.getElementById('font-selector');
    if(fontSelector) fontSelector.value = f; 
}

export function changeGlobalFontSize(delta) { 
    const editBody = document.getElementById('editor-body');
    if(!editBody) return;
    const style = window.getComputedStyle(editBody);
    let currentSize = parseFloat(style.fontSize);
    if(isNaN(currentSize)) currentSize = 16;
    let newSize = currentSize + delta;
    if(newSize < 12) newSize = 12;
    if(newSize > 60) newSize = 60;
    state.currentFontSize = newSize; 
    applyFontStyle(state.currentFontFamily, newSize);
    const spans = editBody.querySelectorAll('span[style*="font-size"]');
    spans.forEach(span => {
        let spanCurrentStyle = window.getComputedStyle(span);
        let spanSize = parseFloat(spanCurrentStyle.fontSize);
        if(!isNaN(spanSize)) {
            let newSpanSize = spanSize + delta;
            if(newSpanSize < 10) newSpanSize = 10;
            span.style.fontSize = newSpanSize + 'px';
        }
    });
    debouncedSave();
}

export function turnPage(direction) { 
    if (state.currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    const pageWidth = container.clientWidth; 
    const currentScroll = container.scrollLeft; 
    
    const currentPageIndex = Math.round(currentScroll / pageWidth);
    const nextPageIndex = currentPageIndex + direction;
    const newScroll = nextPageIndex * pageWidth;
    
    container.scrollTo({ left: newScroll, behavior: 'auto' }); 
    setTimeout(updateBookNav, 50); 
}

export function updateBookNav() { 
    if (state.currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    const bookNavLeft = document.getElementById('book-nav-left');
    const bookNavRight = document.getElementById('book-nav-right');
    const pageIndicator = document.getElementById('page-indicator');

    const scrollLeft = container.scrollLeft; 
    const scrollWidth = container.scrollWidth; 
    const clientWidth = container.clientWidth; 
    if (scrollLeft > 10) bookNavLeft.classList.remove('hidden'); else bookNavLeft.classList.add('hidden'); 
    if (scrollLeft + clientWidth < scrollWidth - 10) bookNavRight.classList.remove('hidden'); else bookNavRight.classList.add('hidden'); 
    const currentPage = Math.round(scrollLeft / clientWidth) + 1; 
    const totalPages = Math.ceil(scrollWidth / clientWidth); 
    pageIndicator.innerText = `${currentPage} / ${totalPages}`; 
    pageIndicator.classList.remove('hidden'); 
}

export function insertSticker(emoji) { 
    const editBody = document.getElementById('editor-body');
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const target = state.lastFocusedEdit || editBody;
    
    if (target === editTitle || target === editSubtitle) { 
        const start = target.selectionStart; 
        const end = target.selectionEnd; 
        const text = target.value; 
        target.value = text.substring(0, start) + emoji + text.substring(end); 
        target.selectionStart = target.selectionEnd = start + emoji.length; 
        target.focus();
    } else { 
        editBody.focus(); 
        document.execCommand('insertText', false, emoji); 
    } 
    debouncedSave();
}

function debouncedSave() {
    if(state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(saveEntry, 1000); 
}