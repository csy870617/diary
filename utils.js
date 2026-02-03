export function autoLink(text) {
    const div = document.createElement('div');
    div.innerHTML = text;
    
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const nodesToReplace = [];
    
    while(node = walker.nextNode()) {
        if(node.parentElement.tagName === 'A') continue; 
        if(node.nodeValue.match(/(https?:\/\/[^\s]+)/)) {
            nodesToReplace.push(node);
        }
    }
    
    nodesToReplace.forEach(node => {
        const span = document.createElement('span');
        span.innerHTML = node.nodeValue.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#2563EB; text-decoration:underline; pointer-events: auto !important; cursor: pointer;">$1</a>');
        node.parentElement.replaceChild(span, node);
        const parent = span.parentElement;
        while(span.firstChild) {
            parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
    });
    
    return div.innerHTML;
}

/**
 * 에디터에 복사/붙여넣기 이벤트 리스너를 추가하여 하이퍼링크를 유지합니다.
 * editor-body 요소에 이 함수를 호출하세요.
 */
export function setupLinkPreservation(editorElement) {
    if (!editorElement) return;
    
    // 복사 이벤트: 선택된 HTML을 클립보드에 저장
    editorElement.addEventListener('copy', (e) => {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(fragment);
        
        // HTML과 텍스트 둘 다 클립보드에 저장
        e.clipboardData.setData('text/html', div.innerHTML);
        e.clipboardData.setData('text/plain', selection.toString());
        e.preventDefault();
    });
    
    // 잘라내기 이벤트: 선택된 HTML을 클립보드에 저장하고 삭제
    editorElement.addEventListener('cut', (e) => {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(fragment);
        
        // HTML과 텍스트 둘 다 클립보드에 저장
        e.clipboardData.setData('text/html', div.innerHTML);
        e.clipboardData.setData('text/plain', selection.toString());
        
        // 선택된 내용 삭제
        range.deleteContents();
        e.preventDefault();
    });
    
    // 붙여넣기 이벤트: HTML 형식으로 붙여넣기
    editorElement.addEventListener('paste', (e) => {
        e.preventDefault();
        
        // HTML 형식 우선, 없으면 일반 텍스트
        let html = e.clipboardData.getData('text/html');
        const text = e.clipboardData.getData('text/plain');
        
        if (!html && text) {
            // HTML이 없으면 텍스트에서 URL을 찾아 링크로 변환
            html = autoLink(text);
        }
        
        if (html || text) {
            // 현재 커서 위치에 삽입
            const selection = window.getSelection();
            if (selection.rangeCount) {
                const range = selection.getRangeAt(0);
                range.deleteContents();
                
                const temp = document.createElement('div');
                temp.innerHTML = html || text;
                
                const fragment = document.createDocumentFragment();
                let node;
                while ((node = temp.firstChild)) {
                    fragment.appendChild(node);
                }
                
                range.insertNode(fragment);
                
                // 커서를 삽입된 내용 끝으로 이동
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    });
}

/**
 * 표(table) 셀 안에서 더블클릭으로 단어를 선택할 수 있게 합니다.
 * editor-body 요소에 이 함수를 호출하세요.
 */
export function setupTableTextSelection(editorElement) {
    if (!editorElement) return;
    
    editorElement.addEventListener('dblclick', (e) => {
        // td 또는 th 요소를 찾기
        let target = e.target;
        while (target && target !== editorElement) {
            if (target.tagName === 'TD' || target.tagName === 'TH') {
                // 더블클릭한 위치에서 단어 선택
                const selection = window.getSelection();
                const range = document.createRange();
                
                // 클릭한 텍스트 노드 찾기
                let node = e.target;
                if (node.nodeType !== Node.TEXT_NODE) {
                    // 텍스트 노드가 아니면 자식 중 텍스트 노드 찾기
                    const walker = document.createTreeWalker(
                        node,
                        NodeFilter.SHOW_TEXT,
                        null,
                        false
                    );
                    node = walker.nextNode();
                }
                
                if (node && node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent;
                    const clickOffset = getClickOffset(node, e);
                    
                    // 단어의 시작과 끝 찾기
                    let start = clickOffset;
                    let end = clickOffset;
                    
                    // 단어 경계 문자 (공백, 구두점 등)
                    const wordBoundary = /[\s\.,;:!?\(\)\[\]\{\}'"]/;
                    
                    // 시작 위치 찾기
                    while (start > 0 && !wordBoundary.test(text[start - 1])) {
                        start--;
                    }
                    
                    // 끝 위치 찾기
                    while (end < text.length && !wordBoundary.test(text[end])) {
                        end++;
                    }
                    
                    // 단어 선택
                    if (start !== end) {
                        range.setStart(node, start);
                        range.setEnd(node, end);
                        selection.removeAllRanges();
                        selection.addRange(range);
                    }
                }
                
                e.preventDefault();
                break;
            }
            target = target.parentElement;
        }
    });
}

/**
 * 클릭한 위치의 텍스트 오프셋을 계산합니다.
 */
function getClickOffset(textNode, event) {
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (range && range.startContainer === textNode) {
            return range.startOffset;
        }
    }
    
    // 폴백: 텍스트 중간 위치 반환
    return Math.floor(textNode.textContent.length / 2);
}
