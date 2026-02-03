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
 * @param {HTMLElement} editorElement - 에디터 요소
 * @param {Object} callbacks - 콜백 함수들 { onBeforePaste, onAfterPaste }
 */
export function setupLinkPreservation(editorElement, callbacks = {}) {
    if (!editorElement) return;
    
    // 이미 설정된 경우 중복 설정 방지
    if (editorElement._linkPreservationSetup) return;
    editorElement._linkPreservationSetup = true;
    
    // 내부 클립보드 (브라우저 제한 우회용)
    let internalClipboard = { html: '', text: '' };
    
    /**
     * 선택 영역의 HTML을 가져오되, 부분 선택된 링크도 완전히 포함
     */
    function getSelectionHtmlWithLinks() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return { html: '', text: '' };
        
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(fragment.cloneNode(true));
        
        // 선택 시작점이 링크 내부인 경우 처리
        let startNode = range.startContainer;
        let startAnchor = startNode.nodeType === 3 ? startNode.parentElement?.closest('a') : startNode.closest?.('a');
        
        // 선택 끝점이 링크 내부인 경우 처리
        let endNode = range.endContainer;
        let endAnchor = endNode.nodeType === 3 ? endNode.parentElement?.closest('a') : endNode.closest?.('a');
        
        let html = div.innerHTML;
        
        // 시작점이 링크 내부이고, 복사된 HTML에 <a> 태그가 없으면 링크로 감싸기
        if (startAnchor && !html.includes('<a ')) {
            const href = startAnchor.getAttribute('href');
            const target = startAnchor.getAttribute('target') || '_blank';
            const style = startAnchor.getAttribute('style') || 'color:#2563EB; text-decoration:underline; cursor:pointer;';
            html = `<a href="${href}" target="${target}" style="${style}">${html}</a>`;
        }
        
        return { html, text: selection.toString() };
    }
    
    // 복사 이벤트
    editorElement.addEventListener('copy', (e) => {
        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;
        
        const { html, text } = getSelectionHtmlWithLinks();
        
        // 클립보드에 저장
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        
        // 내부 클립보드에도 저장 (브라우저 제한 우회)
        internalClipboard = { html, text };
        
        e.preventDefault();
    });
    
    // 잘라내기 이벤트
    editorElement.addEventListener('cut', (e) => {
        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;
        
        const { html, text } = getSelectionHtmlWithLinks();
        
        // 클립보드에 저장
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        
        // 내부 클립보드에도 저장
        internalClipboard = { html, text };
        
        // 선택된 내용 삭제
        const range = selection.getRangeAt(0);
        range.deleteContents();
        
        // 콜백 호출
        if (callbacks.onAfterPaste) callbacks.onAfterPaste();
        
        e.preventDefault();
    });
    
    // 붙여넣기 이벤트
    editorElement.addEventListener('paste', (e) => {
        e.preventDefault();
        
        // 콜백: 히스토리 기록
        if (callbacks.onBeforePaste) callbacks.onBeforePaste();
        
        // 시스템 클립보드에서 데이터 가져오기
        let html = e.clipboardData.getData('text/html');
        let text = e.clipboardData.getData('text/plain');
        
        // 테이블이 포함된 경우 셀 내용만 추출
        if (html && html.includes('<table')) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const cells = doc.querySelectorAll('td');
            if (cells.length > 0) {
                let combinedContent = "";
                cells.forEach((cell, idx) => {
                    combinedContent += cell.innerHTML + (idx < cells.length - 1 ? " " : "");
                });
                document.execCommand('insertHTML', false, combinedContent);
                if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                return;
            }
        }
        
        // 시스템 클립보드의 HTML에 링크가 없고, 내부 클립보드에 링크가 있으면 내부 클립보드 사용
        if (internalClipboard.html && internalClipboard.html.includes('<a ')) {
            if (internalClipboard.text === text || !html || !html.includes('<a ')) {
                html = internalClipboard.html;
            }
        }
        
        // HTML이 있으면 HTML로 삽입
        if (html) {
            // HTML 파싱하여 body 내용만 추출 (메타 태그 등 제거)
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const bodyContent = doc.body.innerHTML;
            
            if (bodyContent) {
                document.execCommand('insertHTML', false, bodyContent);
                if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                return;
            }
        }
        
        // HTML이 없으면 텍스트에서 URL 자동 링크
        if (text) {
            const linkedText = text.replace(
                /(https?:\/\/[^\s]+)/g, 
                '<a href="$1" target="_blank" style="color:#2563EB; text-decoration:underline; cursor:pointer;">$1</a>'
            );
            document.execCommand('insertHTML', false, linkedText);
        }
        
        // 콜백: 자동 저장
        if (callbacks.onAfterPaste) callbacks.onAfterPaste();
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