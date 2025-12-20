import { state } from './state.js';
import { saveEntry } from './data.js';

// 책 모드에서 '수정' 버튼(연필 아이콘)을 만드는 함수
export function makeBookEditButton() {
    const btnBookMode = document.getElementById('btn-bookmode');
    
    // 이미 버튼이 있으면 전역 변수만 갱신하고 종료
    if (document.getElementById('btn-book-edit')) {
        window.btnBookEdit = document.getElementById('btn-book-edit');
        return;
    }

    if (btnBookMode && btnBookMode.parentElement) {
        const btn = document.createElement('button');
        btn.id = 'btn-book-edit';
        btn.className = 'icon-btn';
        btn.title = "페이지 편집";
        btn.innerHTML = '<i class="ph ph-pencil-simple" style="font-size: 18px;"></i>';
        // 원래 코드의 스타일 적용
        btn.style.cssText = "display: none; align-items: center; justify-content: center; gap: 4px; font-family: 'Pretendard'; font-size: 14px; font-weight: 600; color: #4B5563; background: transparent; border: none; cursor: pointer; padding: 8px; margin-left: 4px; border-radius: 6px; width: 36px; height: 36px;";
        
        btn.addEventListener('mouseover', () => btn.style.backgroundColor = '#F3F4F6');
        btn.addEventListener('mouseout', () => btn.style.backgroundColor = 'transparent');
        btn.addEventListener('click', toggleBookEditing);

        // 책 모드 버튼 옆에 삽입
        if (btnBookMode.nextSibling) btnBookMode.parentElement.insertBefore(btn, btnBookMode.nextSibling);
        else btnBookMode.parentElement.appendChild(btn);
        
        window.btnBookEdit = btn;
    }
    
    // 닫기 버튼 위치 조정 (UI 디테일)
    const closeWriteBtn = document.getElementById('close-write-btn');
    const headerLeft = document.querySelector('.write-header .header-left');
    if (headerLeft && closeWriteBtn && !headerLeft.contains(closeWriteBtn)) {
        headerLeft.prepend(closeWriteBtn);
    }
}

// 에디터 열기 (서식 적용 핵심 수정 포함)
export function openEditor(isEdit, entryData) { 
    state.isEditMode = isEdit; 
    const writeModal = document.getElementById('write-modal');
    writeModal.classList.remove('hidden');
    
    if (!history.state || history.state.modal !== 'open') {
        history.pushState({ modal: 'open' }, null, '');
    }

    makeBookEditButton();
    
    // 카테고리/날짜 표시
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
        
        // [핵심 수정] autoLink 함수 제거 후 HTML 직접 주입
        // (저장된 서식을 그대로 불러오기 위함)
        editBody.innerHTML = entryData.body || ''; 
        
        // 저장된 폰트/사이즈 적용 (없으면 기본값)
        applyFontStyle(entryData.fontFamily || 'Pretendard', entryData.fontSize || 16); 
    } else { 
        state.editingId = null; 
        editTitle.value = ''; 
        editSubtitle.value = ''; 
        editBody.innerHTML = ''; 
        applyFontStyle('Pretendard', 16); 
        
        // 새 글일 때 제목에 포커스
        setTimeout(() => editTitle.focus(), 100);
    } 
    state.lastFocusedEdit = editBody;
    toggleViewMode('default', false);
}

// 책 모드에서 편집/보기 전환
export function toggleBookEditing() {
    if(state.currentViewMode !== 'book') return;

    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const editBody = document.getElementById('editor-body');
    const editorToolbar = document.getElementById('editor-toolbar');
    const toolbarToggleBtn = document.getElementById('toolbar-toggle-btn');
    const btn = window.btnBookEdit || document.getElementById('btn-book-edit');

    const isEditable = editBody.isContentEditable;

    if (!isEditable) {
        // 편집 모드 켜기
        editTitle.readOnly = false;
        editSubtitle.readOnly = false;
        editBody.contentEditable = "true";
        editBody.focus();

        // 툴바 보이기
        if(editorToolbar) {
            editorToolbar.style.transition = ''; 
            editorToolbar.classList.remove('collapsed');
            const icon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
            if(icon) {
                icon.classList.remove('ph-caret-down');
                icon.classList.add('ph-caret-up');
            }
        }

        // 버튼 아이콘 변경 (체크 모양)
        if(btn) {
            btn.innerHTML = '<i class="ph ph-check" style="font-size: 18px; color: #10B981;"></i>';
            btn.title = "편집 완료";
        }

    } else {
        // 편집 모드 끄기 (저장)
        editTitle.readOnly = true;
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";

        // 툴바 숨기기
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
        
        debouncedSave(); // 편집 종료 시 자동 저장
    }
}

export function enableBookEditing() {
    toggleBookEditing();
}

// 뷰 모드 전환 (기본 / 읽기전용 / 책모드)
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
    const toolbarIcon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;

    // 책 모드 진입 시 툴바 미리 접기
    if (mode === 'book' && editorToolbar) {
        editorToolbar.style.transition = 'none'; 
        editorToolbar.classList.add('collapsed'); 
        if(toolbarIcon) {
            toolbarIcon.classList.remove('ph-caret-up');
            toolbarIcon.classList.add('ph-caret-down');
        }
    }

    writeModal.classList.remove('mode-read-only', 'mode-book');
    bookNavLeft.classList.add('hidden');
    bookNavRight.classList.add('hidden');
    pageIndicator.classList.add('hidden');
    if(exitFocusBtn) exitFocusBtn.classList.add('hidden');
    
    const btnReadOnly = document.getElementById('btn-readonly');
    const btnBookMode = document.getElementById('btn-bookmode');
    if(btnReadOnly) btnReadOnly.classList.remove('active');
    if(btnBookMode) btnBookMode.classList.remove('active');
    
    if (mode === 'readOnly') {
        // 읽기 전용 모드
        editTitle.readOnly = true;
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        
        writeModal.classList.add('mode-read-only');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnReadOnly) btnReadOnly.classList.add('active');
        if(btnBookEdit) btnBookEdit.style.display = 'none';

    } else if (mode === 'book') {
        // 책 모드
        editTitle.readOnly = true; 
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        
        writeModal.classList.add('mode-book');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnBookMode) btnBookMode.classList.add('active');
        
        const container = document.getElementById('editor-container');
        if(container) container.scrollLeft = 0; 
        updateBookNav(); // 네비게이션 화살표 업데이트
        
        // 애니메이션 다시 켜기 (부드러운 전환 위해)
        if(editorToolbar) {
             setTimeout(() => {
                editorToolbar.style.transition = '';
            }, 50);
        }
        
        if(!btnBookEdit) makeBookEditButton();
        const btn = window.btnBookEdit || document.getElementById('btn-book-edit');
        if(btn) {
            btn.style.display = 'inline-flex';
            btn.innerHTML = '<i class="ph ph-pencil-simple" style="font-size: 18px;"></i>'; 
        }

    } else {
        // 기본 편집 모드
        editTitle.readOnly = false;
        editSubtitle.readOnly = false;
        editBody.contentEditable = "true";
        
        if(btnBookEdit) btnBookEdit.style.display = 'none';
        
        if(editorToolbar) {
            editorToolbar.style.transition = ''; 
            editorToolbar.classList.remove('collapsed');
            if(toolbarIcon) {
                toolbarIcon.classList.remove('ph-caret-down');
                toolbarIcon.classList.add('ph-caret-up');
            }
        }
    }
}

// 서식 적용 (굵게, 기울임 등)
export function formatDoc(cmd, value = null) {
    const editBody = document.getElementById('editor-body');
    if (!editBody) return;
    
    // 제목/소제목에서는 실행 안 함
    if (document.activeElement === document.getElementById('edit-title') || 
        document.activeElement === document.getElementById('edit-subtitle')) return;
        
    editBody.focus();
    document.execCommand(cmd, false, value);
    debouncedSave(); // 서식 적용 시 자동 저장
}

// 폰트 스타일 적용
export function applyFontStyle(f, s) { 
    state.currentFontFamily = f; 
    state.currentFontSize = s; 
    const editBody = document.getElementById('editor-body');
    if(editBody) {
        editBody.style.fontFamily = f; 
        // 나눔손글씨는 조금 작아 보여서 보정
        editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; 
    }
    const fontSelector = document.getElementById('font-selector');
    if(fontSelector) fontSelector.value = f; 
}

// 글자 크기 조절
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
    
    // 개별적으로 크기가 지정된 span들도 같이 조절
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

// 책 모드 페이지 넘김
export function turnPage(direction) { 
    if (state.currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    
    // 페이지 너비 + gap(80) 고려
    const pageWidth = container.clientWidth + 80; 
    const currentScroll = container.scrollLeft; 
    
    const currentPageIndex = Math.round(currentScroll / pageWidth);
    const nextPageIndex = currentPageIndex + direction;
    const newScroll = nextPageIndex * pageWidth;
    
    container.scrollTo({ left: newScroll, behavior: 'smooth' }); 
    setTimeout(updateBookNav, 300); 
}

// 책 모드 네비게이션(화살표, 쪽수) 업데이트
export function updateBookNav() { 
    if (state.currentViewMode !== 'book') return; 
    const container = document.getElementById('editor-container');
    const bookNavLeft = document.getElementById('book-nav-left');
    const bookNavRight = document.getElementById('book-nav-right');
    const pageIndicator = document.getElementById('page-indicator');

    const scrollLeft = container.scrollLeft; 
    const scrollWidth = container.scrollWidth; 
    const clientWidth = container.clientWidth; 
    
    // 갭 포함한 페이지 너비
    const effectivePageWidth = clientWidth + 80;

    if (scrollLeft > 10) bookNavLeft.classList.remove('hidden'); else bookNavLeft.classList.add('hidden'); 
    if (scrollLeft + clientWidth < scrollWidth - 10) bookNavRight.classList.remove('hidden'); else bookNavRight.classList.add('hidden'); 
    
    const currentPage = Math.round(scrollLeft / effectivePageWidth) + 1; 
    const totalPages = Math.ceil(scrollWidth / effectivePageWidth) || 1; 
    
    pageIndicator.innerText = `${currentPage} / ${totalPages}`; 
    pageIndicator.classList.remove('hidden'); 
}

// 스티커 삽입
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

// 자동 저장 (1초 딜레이)
function debouncedSave() {
    if(state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(saveEntry, 1000); 
}