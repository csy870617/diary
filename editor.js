import { state } from './state.js';
import { saveEntry } from './data.js';

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
                a.style.color = '#2563EB'; 
                a.style.cursor = 'pointer';
                a.style.pointerEvents = 'auto'; 
                fragment.appendChild(a);
                lastIdx = offset + match.length;
            });
            fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
            node.parentNode.replaceChild(fragment, node);
        }
    });
}

// ============================================
// 이미지 조작 로직
// ============================================
let currentSelectedImg = null;
let selectionBox = null;
let resizeHandle = null;
let deleteBtn = null;
let resizeBtnGroup = null;

function setupImageHandling() {
    const editorBody = document.getElementById('editor-body');
    const writeModal = document.getElementById('write-modal');
    
    if (!editorBody) return;

    // [Scroll Guard] 터치 시작 시 현재 위치 기억 -> 튐 방지
    const guardScroll = () => {
        const container = document.getElementById('editor-container');
        if(state.currentViewMode === 'book' && editorBody.isContentEditable) {
            const currentLeft = container.scrollLeft;
            // 프레임 단위로 위치 복구 시도
            requestAnimationFrame(() => {
                if(Math.abs(container.scrollLeft - currentLeft) > 5) {
                    container.scrollLeft = currentLeft;
                }
            });
            setTimeout(() => {
                if(Math.abs(container.scrollLeft - currentLeft) > 5) {
                    container.scrollLeft = currentLeft;
                }
            }, 50);
        }
    };

    editorBody.addEventListener('mousedown', guardScroll);
    editorBody.addEventListener('touchstart', guardScroll, {passive: true});

    editorBody.addEventListener('click', (e) => {
        if (!editorBody.isContentEditable) return;

        if (e.target.tagName === 'IMG') {
            e.stopPropagation(); 
            e.preventDefault(); 
            selectImage(e.target);
        } else {
            hideImageSelection();
        }
    });

    if(writeModal) writeModal.addEventListener('scroll', updateSelectionBox);
    window.addEventListener('resize', updateSelectionBox);
    editorBody.addEventListener('input', updateSelectionBox);

    document.addEventListener('keydown', (e) => {
        if (currentSelectedImg && (e.key === 'Delete' || e.key === 'Backspace')) {
            deleteSelectedImage(e);
        }
    });
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
        selectionBox = document.createElement('div');
        selectionBox.className = 'img-selection-box';
        document.body.appendChild(selectionBox);

        resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle se';
        document.body.appendChild(resizeHandle);
        resizeHandle.addEventListener('mousedown', startResize);
        resizeHandle.addEventListener('touchstart', startResize, {passive: false});

        deleteBtn = document.createElement('button');
        deleteBtn.className = 'img-delete-btn';
        deleteBtn.innerHTML = '<i class="ph ph-trash"></i> 삭제';
        document.body.appendChild(deleteBtn);
        deleteBtn.addEventListener('click', deleteSelectedImage);

        resizeBtnGroup = document.createElement('div');
        resizeBtnGroup.className = 'img-resize-group';
        
        const sizes = [25, 50, 75, 100];
        sizes.forEach(size => {
            const btn = document.createElement('button');
            btn.className = 'img-resize-btn';
            btn.innerText = size + '%';
            btn.onclick = (e) => {
                e.stopPropagation();
                if (currentSelectedImg) {
                    currentSelectedImg.style.width = size + '%';
                    currentSelectedImg.style.height = 'auto';
                    updateSelectionBox();
                    debouncedSave();
                }
            };
            resizeBtnGroup.appendChild(btn);
        });
        document.body.appendChild(resizeBtnGroup);
    }

    selectionBox.style.display = 'block';
    resizeHandle.style.display = 'block';
    deleteBtn.style.display = 'flex';
    resizeBtnGroup.style.display = 'flex';
}

function updateSelectionBox() {
    if (!currentSelectedImg || !selectionBox) return;

    const rect = currentSelectedImg.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;

    selectionBox.style.top = (rect.top + scrollTop) + 'px';
    selectionBox.style.left = (rect.left + scrollLeft) + 'px';
    selectionBox.style.width = rect.width + 'px';
    selectionBox.style.height = rect.height + 'px';

    resizeHandle.style.top = (rect.bottom + scrollTop - 10) + 'px';
    resizeHandle.style.left = (rect.right + scrollLeft - 10) + 'px';

    deleteBtn.style.top = (rect.top + scrollTop - 40) + 'px';
    deleteBtn.style.left = (rect.left + scrollLeft + rect.width / 2) + 'px';
    
    resizeBtnGroup.style.top = (rect.bottom + scrollTop + 10) + 'px';
    resizeBtnGroup.style.left = (rect.left + scrollLeft + rect.width / 2) + 'px';
}

function deleteSelectedImage(e) {
    if(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    if (currentSelectedImg) {
        currentSelectedImg.remove();
        hideImageSelection();
        debouncedSave();
    }
}

let isResizing = false;
let startX, startWidth;

function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    
    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    startX = clientX;
    startWidth = currentSelectedImg.clientWidth;

    document.addEventListener('mousemove', resizing);
    document.addEventListener('touchmove', resizing, {passive: false});
    document.addEventListener('mouseup', stopResize);
    document.addEventListener('touchend', stopResize);
}

function resizing(e) {
    if (!isResizing || !currentSelectedImg) return;
    
    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const dx = clientX - startX;
    const newWidth = startWidth + dx;

    const containerWidth = document.getElementById('editor-body').clientWidth;
    if (newWidth > 50 && newWidth <= containerWidth) {
        currentSelectedImg.style.width = newWidth + 'px';
        currentSelectedImg.style.height = 'auto'; 
        updateSelectionBox(); 
    }
}

function stopResize() {
    isResizing = false;
    document.removeEventListener('mousemove', resizing);
    document.removeEventListener('touchmove', resizing);
    document.removeEventListener('mouseup', stopResize);
    document.removeEventListener('touchend', stopResize);
    debouncedSave();
}
// ============================================

export function makeBookEditButton() {
    const btnBookMode = document.getElementById('btn-bookmode');
    
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
        btn.style.cssText = "display: none; align-items: center; justify-content: center; gap: 4px; font-family: 'Pretendard'; font-size: 14px; font-weight: 600; color: #4B5563; background: transparent; border: none; cursor: pointer; padding: 8px; margin-left: 4px; border-radius: 6px; width: 36px; height: 36px;";
        
        btn.addEventListener('mouseover', () => btn.style.backgroundColor = '#F3F4F6');
        btn.addEventListener('mouseout', () => btn.style.backgroundColor = 'transparent');
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
    const writeModal = document.getElementById('write-modal');
    writeModal.classList.remove('hidden');
    
    if (!history.state || history.state.modal !== 'open') {
        history.pushState({ modal: 'open' }, null, '');
    }

    makeBookEditButton();
    setupImageHandling(); 
    
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
    toggleViewMode('default', false);
}

// [단순화 + Scroll Guard] 책 모드 상태 그대로 편집 활성화
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
        // [편집 모드 ON]
        editTitle.readOnly = false;
        editSubtitle.readOnly = false;
        editBody.contentEditable = "true";
        
        // 포커스 이동 없음 (사용자가 터치한 곳이 곧 커서 위치)
        // 단, Scroll Guard가 터치 시 튐 방지함

        if(editorToolbar) {
            editorToolbar.style.transition = ''; 
            editorToolbar.classList.add('collapsed');
            const icon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
            if(icon) {
                icon.classList.remove('ph-caret-up');
                icon.classList.add('ph-caret-down');
            }
        }

        if(btn) {
            btn.innerHTML = '<i class="ph ph-check" style="font-size: 18px; color: #10B981;"></i>';
            btn.title = "편집 완료";
        }

    } else {
        // [편집 모드 OFF]
        editTitle.readOnly = true;
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        hideImageSelection(); 

        linkifyContents(editBody);
        
        if(editorToolbar) {
            editorToolbar.classList.add('collapsed');
            const icon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
            if(icon) {
                icon.classList.remove('ph-caret-up');
                icon.classList.add('ph-caret-down');
            }
        }

        if(btn) {
            btn.innerHTML = '<i class="ph ph-pencil-simple" style="font-size: 18px;"></i>';
            btn.title = "페이지 편집";
        }
        
        debouncedSave(); 
    }
}

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
    const toolbarIcon = toolbarToggleBtn ? toolbarToggleBtn.querySelector('i') : null;
    const container = document.getElementById('editor-container');

    if(container) {
        container.style.height = '';
        container.style.minHeight = '';
    }

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
    
    hideImageSelection();

    if (mode === 'readOnly') {
        editTitle.readOnly = true;
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        
        linkifyContents(editBody);
        
        writeModal.classList.add('mode-read-only');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnReadOnly) btnReadOnly.classList.add('active');
        if(btnBookEdit) btnBookEdit.style.display = 'none';

    } else if (mode === 'book') {
        editTitle.readOnly = true; 
        editSubtitle.readOnly = true;
        editBody.contentEditable = "false";
        
        linkifyContents(editBody);
        
        writeModal.classList.add('mode-book');
        if(exitFocusBtn) exitFocusBtn.classList.remove('hidden');
        if(btnBookMode) btnBookMode.classList.add('active');
        
        if(container) container.scrollLeft = 0; 
        updateBookNav(); 
        
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

export function formatDoc(cmd, value = null) {
    const editBody = document.getElementById('editor-body');
    if (!editBody) return;
    
    if (document.activeElement === document.getElementById('edit-title') || 
        document.activeElement === document.getElementById('edit-subtitle')) return;
        
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
    const pageWidth = window.innerWidth;
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
    const pageWidth = window.innerWidth;

    if (scrollLeft > 10) bookNavLeft.classList.remove('hidden'); else bookNavLeft.classList.add('hidden'); 
    if (scrollLeft + pageWidth < scrollWidth - 10) bookNavRight.classList.remove('hidden'); else bookNavRight.classList.add('hidden'); 
    
    const currentPage = Math.round(scrollLeft / pageWidth) + 1; 
    const totalPages = Math.ceil(scrollWidth / pageWidth) || 1; 
    
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

export function insertImage(src) {
    const editBody = document.getElementById('editor-body');
    const target = state.lastFocusedEdit || editBody;
    
    if (target === editBody) {
        target.focus();
        document.execCommand('insertImage', false, src);
        debouncedSave();
    }
}

function debouncedSave() {
    if(state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(saveEntry, 1000); 
}