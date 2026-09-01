// URL 끝에 붙은 문장부호(마침표·쉼표·닫는 괄호 등)는 링크에 포함하지 않도록 분리
// 단, URL 안에 여는 괄호가 더 많으면(위키백과식 주소) 닫는 괄호는 URL로 되돌린다
function splitTrailingPunctuation(rawUrl) {
    let url = rawUrl, trail = '';
    const m = url.match(/[.,:!?)\]}'"…]+$/);
    if (m) { trail = m[0]; url = url.slice(0, url.length - trail.length); }
    while (trail.startsWith(')') && (url.split('(').length - 1) > (url.split(')').length - 1)) {
        url += ')'; trail = trail.slice(1);
    }
    return { url, trail };
}

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
        span.innerHTML = node.nodeValue.replace(/(https?:\/\/[^\s]+)/g, (match) => {
            const { url, trail } = splitTrailingPunctuation(match);
            const safeUrl = url.replace(/"/g, '&quot;'); // 따옴표 이스케이프로 속성 주입 방지
            return `<a href="${safeUrl}" target="_blank" style="color:#2563EB; text-decoration:underline; pointer-events: auto !important; cursor: pointer;">${safeUrl}</a>${trail}`;
        });
        node.parentElement.replaceChild(span, node);
        const parent = span.parentElement;
        while(span.firstChild) {
            parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
    });
    
    return div.innerHTML;
}

// 전역 셀 클립보드
let globalCellClipboard = { cellData: null, rows: 0, cols: 0 };

/**
 * 에디터에 복사/붙여넣기 이벤트 리스너를 추가합니다.
 * 표 셀의 복사/잘라내기/붙여넣기와 하이퍼링크 유지를 지원합니다.
 * @param {HTMLElement} editorElement - 에디터 요소
 * @param {Object} callbacks - 콜백 함수들 { onBeforePaste, onAfterPaste }
 */
/**
 * 외부에서 복사한 HTML을 안전하게 정제합니다.
 * 서식(색상, 굵기, 기울임, 밑줄, 글꼴 등)은 보존하고
 * 위험한 요소(script, iframe 등)는 제거합니다.
 */
/**
 * URL 속성값이 안전한지 판정한다.
 *
 * 브라우저는 URL 스킴 안의 탭·개행·공백을 무시하고 해석하므로
 * `java\tscript:` 도 정상적인 javascript: 링크가 된다.
 * 따라서 startsWith('javascript:') 같은 단순 비교로는 막을 수 없다.
 * 공백류와 제어문자를 모두 걷어낸 뒤, 허용 목록 방식으로 판정한다.
 */
export function isSafeUrl(value) {
    if (value == null) return false;
    // 공백류(탭/개행/캐리지리턴/폼피드)와 널 등 제어문자를 제거해 스킴을 드러낸다.
    const bare = String(value).replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, '').toLowerCase();
    if (bare === '') return true; // 빈 값은 무해
    // 스킴이 없으면(상대경로·앵커·쿼리) 안전
    const m = bare.match(/^([a-z][a-z0-9+.-]*):/);
    if (!m) return true;
    const scheme = m[1];
    const ALLOWED = new Set(['http', 'https', 'mailto', 'tel']);
    if (!ALLOWED.has(scheme)) {
        // data:image 는 본문에 삽입된 사진이라 허용 (그 외 data: 는 차단)
        if (scheme === 'data' && /^data:image\/(png|jpe?g|gif|webp|bmp);/.test(bare)) return true;
        return false;
    }
    return true;
}

export function sanitizeExternalHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 위험한 요소 제거
    const dangerousTags = ['script', 'iframe', 'object', 'embed', 'form', 'input',
        'textarea', 'select', 'button', 'meta', 'link', 'style', 'base'];
    dangerousTags.forEach(tag => {
        doc.querySelectorAll(tag).forEach(el => el.remove());
    });

    // 허용할 태그 목록
    const allowedTags = new Set([
        'p', 'br', 'div', 'span',
        'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'sub', 'sup',
        'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li',
        'a', 'img',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
        'blockquote', 'pre', 'code', 'hr'
    ]);

    // 허용할 CSS 속성 목록 (서식 관련)
    const allowedStyleProps = new Set([
        'color', 'background-color', 'background',
        'font-size', 'font-family', 'font-weight', 'font-style', 'font-variant',
        'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
        'text-align', 'text-indent', 'text-transform',
        'line-height', 'letter-spacing', 'word-spacing',
        'vertical-align',
        'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
        'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
        'border-color', 'border-width', 'border-style', 'border-collapse',
        'width', 'height', 'min-width', 'max-width',
        'list-style-type', 'list-style',
        'white-space', 'word-break', 'overflow-wrap'
    ]);

    // 허용할 속성 목록
    const allowedAttrs = {
        '*': ['style', 'class'],
        'a': ['href', 'target', 'title'],
        'img': ['src', 'alt', 'width', 'height'],
        'font': ['color', 'size', 'face'],
        'td': ['colspan', 'rowspan', 'align', 'valign'],
        'th': ['colspan', 'rowspan', 'align', 'valign'],
        'ol': ['start', 'type'],
        'li': ['value']
    };

    function sanitizeStyle(styleStr) {
        if (!styleStr) return '';
        const filtered = [];
        // style 문자열 파싱
        const props = styleStr.split(';');
        for (const prop of props) {
            const colonIdx = prop.indexOf(':');
            if (colonIdx === -1) continue;
            const name = prop.substring(0, colonIdx).trim().toLowerCase();
            const value = prop.substring(colonIdx + 1).trim();
            if (allowedStyleProps.has(name) && !value.includes('expression') && !value.includes('javascript')) {
                filtered.push(`${name}: ${value}`);
            }
        }
        return filtered.join('; ');
    }

    function sanitizeNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return;
        if (node.nodeType !== Node.ELEMENT_NODE) {
            node.remove();
            return;
        }

        const tag = node.tagName.toLowerCase();

        // 허용되지 않는 태그는 내용만 유지.
        // 이때 부모 자리로 올린 자식들은 호출부의 순회 목록(이미 찍어둔 스냅샷)에 없으므로
        // 여기서 직접 정화해야 한다. 빠뜨리면 <foo><img onerror=...></foo> 처럼
        // 한 겹만 감싸는 것으로 핸들러가 그대로 통과한다.
        if (!allowedTags.has(tag)) {
            const parent = node.parentNode;
            const promoted = [];
            while (node.firstChild) {
                const child = node.firstChild;
                parent.insertBefore(child, node);
                promoted.push(child);
            }
            parent.removeChild(node);
            for (const child of promoted) sanitizeNode(child);
            return;
        }

        // 속성 정제
        const attrs = Array.from(node.attributes);
        const tagAllowed = allowedAttrs[tag] || [];
        const globalAllowed = allowedAttrs['*'] || [];
        const permitted = new Set([...globalAllowed, ...tagAllowed]);

        for (const attr of attrs) {
            const name = attr.name.toLowerCase();
            if (!permitted.has(name)) {
                node.removeAttribute(attr.name);
                continue;
            }
            // on* 이벤트 핸들러 제거
            if (name.startsWith('on')) {
                node.removeAttribute(attr.name);
                continue;
            }
            // 위험한 스킴 차단 (스킴 안의 탭·개행까지 고려한 공용 판정)
            if ((name === 'href' || name === 'src' || name === 'srcset') && !isSafeUrl(attr.value)) {
                node.removeAttribute(attr.name);
            }
        }

        // style 속성 정제
        if (node.hasAttribute('style')) {
            const cleaned = sanitizeStyle(node.getAttribute('style'));
            if (cleaned) {
                node.setAttribute('style', cleaned);
            } else {
                node.removeAttribute('style');
            }
        }

        // a 태그에 target="_blank" 보장
        if (tag === 'a' && node.hasAttribute('href')) {
            node.setAttribute('target', '_blank');
        }

        // 자식 노드 재귀 처리 (역순 순회 - 노드 변경에 안전)
        const children = Array.from(node.childNodes);
        for (const child of children) {
            sanitizeNode(child);
        }
    }

    const body = doc.body;
    const children = Array.from(body.childNodes);
    for (const child of children) {
        sanitizeNode(child);
    }

    let result = body.innerHTML.trim();

    // URL 자동 링크 (링크가 아닌 텍스트 내 URL)
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = result;
    const walker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, null, false);
    let textNode;
    const nodesToProcess = [];
    while (textNode = walker.nextNode()) {
        if (textNode.parentElement.tagName === 'A') continue;
        if (textNode.nodeValue.match(/(https?:\/\/[^\s]+)/)) {
            nodesToProcess.push(textNode);
        }
    }
    // 주의: 여기서 innerHTML을 쓰면 안 된다.
    // 텍스트 노드의 값은 '글자'일 뿐인데 innerHTML에 넣으면 다시 HTML로 해석되어,
    // 정화 단계에서 안전하게 글자로 바뀌어 있던 <img onerror=...> 가 실제 태그로 되살아난다.
    // 그래서 DOM API로만 조립한다.
    const URL_RE = /(https?:\/\/[^\s]+)/g;
    nodesToProcess.forEach(tn => {
        const text = tn.nodeValue;
        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let m;
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(text)) !== null) {
            const { url, trail } = splitTrailingPunctuation(m[0]);
            if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
            if (isSafeUrl(url)) {
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.style.color = '#2563EB';
                a.style.textDecoration = 'underline';
                a.style.cursor = 'pointer';
                a.textContent = url;
                frag.appendChild(a);
            } else {
                frag.appendChild(document.createTextNode(url));
            }
            if (trail) frag.appendChild(document.createTextNode(trail));
            lastIdx = m.index + m[0].length;
        }
        if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        tn.parentElement.replaceChild(frag, tn);
    });
    result = tempDiv.innerHTML;

    return result || null;
}

export function setupLinkPreservation(editorElement, callbacks = {}) {
    if (!editorElement) return;
    
    // 이미 설정된 경우 중복 설정 방지
    if (editorElement._linkPreservationSetup) return;
    editorElement._linkPreservationSetup = true;
    
    // 내부 클립보드 (링크 보존용)
    let internalClipboard = { html: '', text: '' };
    
    /**
     * 선택된 셀들의 데이터를 가져옵니다
     */
    function getSelectedCellsData() {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length === 0) return null;
        
        const table = selectedCells[0].closest('table');
        if (!table) return null;
        
        let minRow = Infinity, maxRow = -1, minCol = Infinity, maxCol = -1;
        
        selectedCells.forEach(cell => {
            const row = cell.parentElement.rowIndex;
            const col = cell.cellIndex;
            minRow = Math.min(minRow, row);
            maxRow = Math.max(maxRow, row);
            minCol = Math.min(minCol, col);
            maxCol = Math.max(maxCol, col);
        });
        
        const cellData = [];
        for (let r = minRow; r <= maxRow; r++) {
            const rowData = [];
            for (let c = minCol; c <= maxCol; c++) {
                const cell = table.rows[r]?.cells[c];
                if (cell && cell.classList.contains('selected-cell')) {
                    rowData.push(cell.innerHTML);
                } else {
                    rowData.push('');
                }
            }
            cellData.push(rowData);
        }
        
        return { cellData, rows: maxRow - minRow + 1, cols: maxCol - minCol + 1 };
    }
    
    /**
     * 셀 데이터를 대상 셀에 붙여넣기
     */
    function pasteCellData(targetCell, data) {
        if (!targetCell || !data || !data.cellData) return false;

        const table = targetCell.closest('table');
        if (!table) return false;

        const startRow = targetCell.parentElement.rowIndex;
        const startCol = targetCell.cellIndex;

        data.cellData.forEach((rowData, rIdx) => {
            rowData.forEach((cellContent, cIdx) => {
                const targetRow = table.rows[startRow + rIdx];
                if (targetRow) {
                    const cell = targetRow.cells[startCol + cIdx];
                    if (cell) {
                        cell.innerHTML = cellContent || '<br>';
                    }
                }
            });
        });

        return true;
    }

    /**
     * 셀 데이터로 표 HTML 생성 (새 표로 붙여넣기용)
     */
    function buildTableHtml(data) {
        if (!data || !data.cellData) return '';
        let html = '<div class="table-wrapper"><table><tbody>';
        data.cellData.forEach(rowData => {
            html += '<tr>';
            rowData.forEach(cellContent => {
                html += `<td>${cellContent || '<br>'}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table></div><p><br></p>';
        return html;
    }
    
    /**
     * 선택 영역의 HTML을 가져오되, 부분 선택된 링크도 완전히 포함하고
     * 모든 서식(색상, 굵기, 기울임, 글꼴, 크기 등)을 보존합니다.
     * 상속된 스타일도 인라인으로 포함하여 붙여넣기 시 서식이 유지됩니다.
     */
    function getSelectionHtmlWithFormatting() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return { html: '', text: '' };

        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(fragment.cloneNode(true));

        // 부분 선택된 링크 복원
        let startNode = range.startContainer;
        let startAnchor = startNode.nodeType === 3 ? startNode.parentElement?.closest('a') : startNode.closest?.('a');

        // 선택 영역의 각 텍스트 노드에 상속된 스타일을 인라인으로 적용
        embedInheritedStyles(div, range);

        let html = div.innerHTML;

        if (startAnchor && !html.includes('<a ')) {
            // 속성값의 따옴표 이스케이프 (속성 주입 방지)
            const escAttr = (v) => String(v ?? '').replace(/"/g, '&quot;');
            const href = startAnchor.getAttribute('href');
            const target = startAnchor.getAttribute('target') || '_blank';
            const style = startAnchor.getAttribute('style') || 'color:#2563EB; text-decoration:underline; cursor:pointer;';
            html = `<a href="${escAttr(href)}" target="${escAttr(target)}" style="${escAttr(style)}">${html}</a>`;
        }

        // 부분 선택된 상위 서식 요소(span, b, i, u, s, font 등) 복원
        let ancestor = range.commonAncestorContainer;
        if (ancestor.nodeType === 3) ancestor = ancestor.parentElement;

        // 에디터 루트까지 올라가며 서식 태그 수집
        const formatWrappers = [];
        let node = ancestor;
        while (node && node !== editorElement) {
            const tag = node.tagName?.toLowerCase();
            if (['span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'font', 'sub', 'sup'].includes(tag)) {
                const outer = node.cloneNode(false).outerHTML;
                // 첫 '>'까지 잘라 여는 태그만 추출 (replace('')는 no-op이라 닫는 태그까지 포함됐었음)
                formatWrappers.unshift(outer.slice(0, outer.indexOf('>') + 1));
            }
            node = node.parentElement;
        }

        // 서식 래퍼 적용 (이미 fragment에 포함되어 있지 않은 경우)
        if (formatWrappers.length > 0 && div.children.length === 0 && div.childNodes.length > 0) {
            // 텍스트만 있는 경우 상위 서식 적용
            let wrapped = html;
            for (const wrapper of formatWrappers) {
                const closingTag = '</' + wrapper.match(/<(\w+)/)[1] + '>';
                wrapped = wrapper + wrapped + closingTag;
            }
            html = wrapped;
        }

        return { html, text: selection.toString() };
    }

    /**
     * 복사된 fragment의 텍스트/요소 노드에 원본 문서에서의 상속된 스타일을 인라인으로 적용합니다.
     * 이를 통해 붙여넣기 시 글꼴, 크기, 색상 등의 서식이 보존됩니다.
     */
    function embedInheritedStyles(fragmentDiv, range) {
        const stylesToCapture = ['font-size', 'font-family', 'color', 'font-weight', 'font-style', 'text-decoration', 'background-color'];

        // 원본 선택 영역의 시작 노드에서 기본 computed style 가져오기
        let sourceNode = range.startContainer;
        if (sourceNode.nodeType === 3) sourceNode = sourceNode.parentElement;
        if (!sourceNode) return;

        // fragment 내의 직접 텍스트 노드와 인라인 스타일이 없는 요소들에 스타일 적용
        function processNode(fragNode, origParent) {
            if (fragNode.nodeType === Node.TEXT_NODE) {
                // 텍스트 노드의 부모가 이미 인라인 스타일을 가지고 있으면 건너뛰기
                const parent = fragNode.parentElement;
                if (parent && parent !== fragmentDiv && parent.style && parent.style.fontSize) return;

                // 텍스트 노드를 span으로 감싸서 스타일 적용
                if (fragNode.textContent.trim() === '') return;
                const computed = origParent ? window.getComputedStyle(origParent) : null;
                if (!computed) return;

                const span = document.createElement('span');
                const stylesParts = [];
                for (const prop of stylesToCapture) {
                    const val = computed.getPropertyValue(prop);
                    if (val && prop === 'font-size') {
                        stylesParts.push(`font-size: ${val}`);
                    } else if (val && prop === 'font-family') {
                        stylesParts.push(`font-family: ${val}`);
                    } else if (val && prop === 'color') {
                        stylesParts.push(`color: ${val}`);
                    } else if (val && prop === 'font-weight' && val !== 'normal' && val !== '400') {
                        stylesParts.push(`font-weight: ${val}`);
                    } else if (val && prop === 'font-style' && val !== 'normal') {
                        stylesParts.push(`font-style: ${val}`);
                    } else if (val && prop === 'text-decoration' && !val.startsWith('none')) {
                        stylesParts.push(`text-decoration: ${val}`);
                    } else if (val && prop === 'background-color' && val !== 'rgba(0, 0, 0, 0)' && val !== 'transparent') {
                        stylesParts.push(`background-color: ${val}`);
                    }
                }
                if (stylesParts.length > 0) {
                    span.setAttribute('style', stylesParts.join('; '));
                    fragNode.parentNode.insertBefore(span, fragNode);
                    span.appendChild(fragNode);
                }
            } else if (fragNode.nodeType === Node.ELEMENT_NODE) {
                const tag = fragNode.tagName.toLowerCase();
                // 블록 요소나 이미 인라인 font-size를 가진 요소는 건너뛰기
                if (['br', 'img', 'hr', 'table'].includes(tag)) return;

                // 인라인 스타일이 없는 요소에 computed style 적용
                if (!fragNode.style.fontSize && origParent) {
                    const computed = window.getComputedStyle(origParent);
                    const fontSize = computed.getPropertyValue('font-size');
                    const fontFamily = computed.getPropertyValue('font-family');
                    if (fontSize) fragNode.style.fontSize = fontSize;
                    if (fontFamily) fragNode.style.fontFamily = fontFamily;
                    const color = computed.getPropertyValue('color');
                    if (color) fragNode.style.color = color;
                }

                // 자식 노드 재귀 처리
                const children = Array.from(fragNode.childNodes);
                children.forEach(child => processNode(child, origParent));
            }
        }

        // fragment의 최상위 자식들에 대해 처리
        const topChildren = Array.from(fragmentDiv.childNodes);
        topChildren.forEach(child => processNode(child, sourceNode));
    }
    
    /**
     * 현재 커서가 있는 셀 찾기
     */
    function getCurrentCell() {
        const selection = window.getSelection();
        if (!selection.anchorNode) return null;
        
        let node = selection.anchorNode;
        if (node.nodeType === 3) {
            node = node.parentElement;
        }
        
        return node?.closest?.('td') || null;
    }
    
    /**
     * 셀 선택 해제
     */
    function clearCellSelection() {
        document.querySelectorAll('td.selected-cell').forEach(td => {
            td.classList.remove('selected-cell');
        });
        document.querySelectorAll('table.selecting-cells').forEach(t => {
            t.classList.remove('selecting-cells');
        });
    }
    
    // ========== 키보드 이벤트 핸들러 ==========
    const handleKeyDown = (e) => {
        // 에디터가 보이지 않으면 무시
        const writeModal = document.getElementById('write-modal');
        if (!writeModal || writeModal.classList.contains('hidden')) return;
        
        const selectedCells = document.querySelectorAll('td.selected-cell');
        
        // Ctrl+C / Cmd+C: 복사
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            if (selectedCells.length > 1) {
                e.preventDefault();
                e.stopPropagation();

                const data = getSelectedCellsData();
                if (data) {
                    // 마커를 시스템 클립보드(text/plain)에 기록하여, 붙여넣기 시
                    // 마커가 일치할 때만 셀 클립보드를 사용 (이미지 copyId 패턴과 동일)
                    const copyId = `__cells_${Date.now()}`;
                    data.copyId = copyId;
                    globalCellClipboard = data;

                    const tableHtml = buildTableHtml(data);

                    if (navigator.clipboard && window.ClipboardItem) {
                        const htmlBlob = new Blob([tableHtml], { type: 'text/html' });
                        const textBlob = new Blob([copyId], { type: 'text/plain' });
                        navigator.clipboard.write([
                            new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
                        ]).catch(() => {
                            navigator.clipboard.writeText(copyId).catch(() => {});
                        });
                    } else {
                        navigator.clipboard?.writeText(copyId).catch(() => {});
                    }

                    // 복사 완료 시각적 피드백
                    selectedCells.forEach(cell => {
                        cell.style.transition = 'background-color 0.2s';
                        const originalBg = cell.style.backgroundColor;
                        cell.style.backgroundColor = 'rgba(59, 130, 246, 0.4)';
                        setTimeout(() => {
                            cell.style.backgroundColor = originalBg || '';
                        }, 200);
                    });

                    console.log('셀 복사:', data.rows, 'x', data.cols);
                }
                return;
            } else {
                // 일반 복사 - 셀 클립보드 초기화
                globalCellClipboard = { cellData: null, rows: 0, cols: 0 };

                // 선택된 이미지 복사 (에디터에 포커스가 없을 때 대비)
                const selectedImg = callbacks.getSelectedElement?.();
                if (selectedImg && selectedImg.tagName === 'IMG') {
                    e.preventDefault();
                    e.stopPropagation();

                    const imgHtml = selectedImg.outerHTML;
                    const copyId = `__img_${Date.now()}`;
                    internalClipboard = { html: imgHtml, text: copyId };

                    if (navigator.clipboard && window.ClipboardItem) {
                        const htmlBlob = new Blob([imgHtml], { type: 'text/html' });
                        const textBlob = new Blob([copyId], { type: 'text/plain' });
                        navigator.clipboard.write([
                            new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
                        ]).catch(() => {});
                    }
                    return;
                }
            }
        }

        // Ctrl+X / Cmd+X: 잘라내기
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            // 읽기 전용 모드에서는 잘라내기 차단 (복사만 허용)
            if (editorElement.contentEditable === 'false' || editorElement.getAttribute('contenteditable') === 'false') {
                e.preventDefault();
                return;
            }
            if (selectedCells.length > 1) {
                e.preventDefault();
                e.stopPropagation();
                
                const data = getSelectedCellsData();
                if (data) {
                    // 마커를 시스템 클립보드에 기록 (복사 경로와 동일한 패턴)
                    const copyId = `__cells_${Date.now()}`;
                    data.copyId = copyId;
                    globalCellClipboard = data;

                    navigator.clipboard?.writeText(copyId).catch(() => {});
                    
                    // 셀 내용 삭제
                    if (callbacks.onBeforePaste) callbacks.onBeforePaste();
                    selectedCells.forEach(cell => {
                        cell.innerHTML = '<br>';
                    });
                    if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                    
                    console.log('셀 잘라내기:', data.rows, 'x', data.cols);
                }
                return;
            } else {
                // 일반 잘라내기 - 셀 클립보드 초기화
                globalCellClipboard = { cellData: null, rows: 0, cols: 0 };

                // 선택된 이미지 잘라내기 (에디터에 포커스가 없을 때 대비)
                const selectedImg = callbacks.getSelectedElement?.();
                if (selectedImg && selectedImg.tagName === 'IMG') {
                    e.preventDefault();
                    e.stopPropagation();

                    const imgHtml = selectedImg.outerHTML;
                    const copyId = `__img_${Date.now()}`;
                    internalClipboard = { html: imgHtml, text: copyId };

                    if (navigator.clipboard && window.ClipboardItem) {
                        const htmlBlob = new Blob([imgHtml], { type: 'text/html' });
                        const textBlob = new Blob([copyId], { type: 'text/plain' });
                        navigator.clipboard.write([
                            new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
                        ]).catch(() => {});
                    }

                    if (callbacks.onBeforePaste) callbacks.onBeforePaste();
                    selectedImg.remove();
                    if (callbacks.clearSelectedElement) callbacks.clearSelectedElement();
                    if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                    return;
                }
            }
        }

        // Ctrl+V / Cmd+V: 여기서 가로채지 않고 브라우저의 paste 이벤트에 맡긴다.
        // paste 핸들러는 clipboardData로 마커를 동기적으로 검사할 수 있어,
        // readText() 권한 거부/미지원(Firefox) 시 오래된 셀 데이터가 붙던 문제가 없다.
    };
    
    // Document 레벨 키 이벤트 (캡처 단계에서 처리)
    document.addEventListener('keydown', handleKeyDown, true);
    
    // Document 레벨 copy 이벤트 - 에디터 외부에서 복사해도 셀 클립보드 초기화
    document.addEventListener('copy', (e) => {
        // 선택된 셀이 없으면 셀 클립보드 초기화
        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length === 0) {
            globalCellClipboard = { cellData: null, rows: 0, cols: 0 };
        }
    });
    
    document.addEventListener('cut', (e) => {
        // 선택된 셀이 없으면 셀 클립보드 초기화
        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length === 0) {
            globalCellClipboard = { cellData: null, rows: 0, cols: 0 };
        }
    });
    
    // ========== 일반 복사 이벤트 (서식 보존) ==========
    editorElement.addEventListener('copy', (e) => {
        // 다중 셀이 선택되어 있으면 키보드 핸들러에서 처리됨
        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length > 1) return;

        // 일반 텍스트 선택 복사 - 셀 클립보드 초기화
        globalCellClipboard = { cellData: null, rows: 0, cols: 0 };

        // 선택된 이미지 복사
        const selectedImg = callbacks.getSelectedElement?.();
        if (selectedImg && selectedImg.tagName === 'IMG') {
            const imgHtml = selectedImg.outerHTML;
            const copyId = `__img_${Date.now()}`;
            e.clipboardData.setData('text/html', imgHtml);
            e.clipboardData.setData('text/plain', copyId);
            internalClipboard = { html: imgHtml, text: copyId };
            e.preventDefault();
            return;
        }

        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;

        const { html, text } = getSelectionHtmlWithFormatting();

        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        internalClipboard = { html, text };

        e.preventDefault();
    });

    // ========== 일반 잘라내기 이벤트 ==========
    editorElement.addEventListener('cut', (e) => {
        // 읽기 전용 모드에서는 잘라내기 차단
        if (editorElement.contentEditable === 'false' || editorElement.getAttribute('contenteditable') === 'false') {
            e.preventDefault();
            return;
        }

        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length > 1) return;

        // 일반 텍스트 잘라내기 - 셀 클립보드 초기화
        globalCellClipboard = { cellData: null, rows: 0, cols: 0 };

        // 선택된 이미지 잘라내기
        const selectedImg = callbacks.getSelectedElement?.();
        if (selectedImg && selectedImg.tagName === 'IMG') {
            const imgHtml = selectedImg.outerHTML;
            const copyId = `__img_${Date.now()}`;
            e.clipboardData.setData('text/html', imgHtml);
            e.clipboardData.setData('text/plain', copyId);
            internalClipboard = { html: imgHtml, text: copyId };

            if (callbacks.onBeforePaste) callbacks.onBeforePaste();
            selectedImg.remove();
            if (callbacks.clearSelectedElement) callbacks.clearSelectedElement();
            if (callbacks.onAfterPaste) callbacks.onAfterPaste();

            e.preventDefault();
            return;
        }

        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;

        const { html, text } = getSelectionHtmlWithFormatting();

        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        internalClipboard = { html, text };

        const range = selection.getRangeAt(0);
        range.deleteContents();

        if (callbacks.onAfterPaste) callbacks.onAfterPaste();
        e.preventDefault();
    });
    
    async function readImageFileAsDataUrl(file) {
        if (!file || !file.type?.startsWith('image/')) return null;
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target?.result || null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
    }

    async function compressImageDataUrl(dataUrl, maxWidth = 800, quality = 0.7) {
        if (!dataUrl) return null;
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    let { width, height } = img;
                    if (width > maxWidth) {
                        height *= maxWidth / width;
                        width = maxWidth;
                    }
                    canvas.width = width;
                    canvas.height = height;
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch {
                    resolve(dataUrl);
                }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    async function getPastedImageDataUrl(clipboardData) {
        if (!clipboardData) return null;

        const items = Array.from(clipboardData.items || []);
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                const rawDataUrl = await readImageFileAsDataUrl(file);
                return compressImageDataUrl(rawDataUrl);
            }
        }

        const files = Array.from(clipboardData.files || []);
        const imageFile = files.find(file => file.type.startsWith('image/'));
        if (imageFile) {
            const rawDataUrl = await readImageFileAsDataUrl(imageFile);
            return compressImageDataUrl(rawDataUrl);
        }

        return null;
    }

    /**
     * 클립보드에 '읽을 글'이 들어 있는가.
     *
     * 그림만 복사한 경우(화면 캡처, 웹페이지에서 이미지 복사)와
     * 글을 복사한 경우(워드·엑셀·한글·브라우저)를 가르는 기준이다.
     * 웹에서 이미지를 복사하면 text/html이 <img> 하나뿐이고 글자가 없으므로
     * 태그를 걷어낸 '실제 글자'로 판단한다.
     */
    function clipboardHasText(clipboardData) {
        if (!clipboardData) return false;
        if ((clipboardData.getData('text/plain') || '').trim()) return true;
        const html = clipboardData.getData('text/html') || '';
        if (!html) return false;
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            // 표는 칸이 비어 있어도 '글'로 본다 (빈 표를 그림으로 바꾸지 않도록)
            if (doc.querySelector('table')) return true;
            return !!(doc.body.textContent || '').trim();
        } catch (err) {
            return false;
        }
    }

    // ========== 붙여넣기 이벤트 ==========
    editorElement.addEventListener('paste', (e) => {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        const currentCell = getCurrentCell();

        // 시스템 클립보드의 마커가 일치하지 않으면 스테일 셀 클립보드 무시
        // (다른 앱에서 새로 복사한 경우)
        if (globalCellClipboard.cellData) {
            const clipText = e.clipboardData?.getData('text/plain') || '';
            if (clipText && clipText !== globalCellClipboard.copyId) {
                globalCellClipboard = { cellData: null, rows: 0, cols: 0 };
            }
        }

        // 셀 클립보드에 데이터가 있으면 붙여넣기 처리
        if (globalCellClipboard.cellData) {
            e.preventDefault();

            if (callbacks.onBeforePaste) callbacks.onBeforePaste();

            if (currentCell || selectedCells.length > 0) {
                // 기존 표의 셀에 붙여넣기
                let targetCell = currentCell;
                if (selectedCells.length > 0) {
                    let minRow = Infinity, minCol = Infinity;
                    selectedCells.forEach(cell => {
                        const row = cell.parentElement.rowIndex;
                        const col = cell.cellIndex;
                        if (row < minRow || (row === minRow && col < minCol)) {
                            minRow = row;
                            minCol = col;
                            targetCell = cell;
                        }
                    });
                }

                if (targetCell && pasteCellData(targetCell, globalCellClipboard)) {
                    clearCellSelection();
                    if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                }
            } else {
                // 표 밖 커서 위치에 새 표로 붙여넣기
                const tableHtml = buildTableHtml(globalCellClipboard);
                document.execCommand('insertHTML', false, tableHtml);
                if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                console.log('새 표로 붙여넣기 완료 (paste 이벤트)');
            }
            return;
        }

        e.preventDefault();
        if (callbacks.onBeforePaste) callbacks.onBeforePaste();

        // 워드·엑셀·한글에서 복사하면 클립보드에 '글'과 '그 선택 영역을 찍은 그림'이
        // 함께 담긴다. 그림을 먼저 보면 글이 통째로 그림이 되어(자르기 창까지 뜬다)
        // 원문이 사라진다. 그래서 글이 함께 들어 있으면 글로 취급한다.
        const pasteAsImage = !clipboardHasText(e.clipboardData);

        (pasteAsImage ? getPastedImageDataUrl(e.clipboardData) : Promise.resolve(null)).then((imageDataUrl) => {
            if (imageDataUrl) {
                if (callbacks.onPasteImage) {
                    callbacks.onPasteImage(imageDataUrl);
                } else {
                    document.execCommand('insertImage', false, imageDataUrl);
                    if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                }
                return;
            }

            let html = e.clipboardData.getData('text/html');
            let text = e.clipboardData.getData('text/plain');

            // 외부에서 복사한 테이블이 있고 현재 셀 안에 있는 경우 → 셀 내용 교체
            if (html && html.includes('<table') && currentCell) {
                const table = currentCell.closest('table');
                if (table) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(sanitizeExternalHtml(html), 'text/html');
                    const pastedTable = doc.querySelector('table');

                    if (pastedTable) {
                        const startRow = currentCell.parentElement.rowIndex;
                        const startCol = currentCell.cellIndex;

                        Array.from(pastedTable.rows).forEach((pastedRow, rIdx) => {
                            const targetRow = table.rows[startRow + rIdx];
                            if (targetRow) {
                                Array.from(pastedRow.cells).forEach((pastedCell, cIdx) => {
                                    const targetCellEl = targetRow.cells[startCol + cIdx];
                                    if (targetCellEl) {
                                        targetCellEl.innerHTML = pastedCell.innerHTML || '<br>';
                                    }
                                });
                            }
                        });

                        if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                        return;
                    }
                }
            }

            // 외부에서 복사한 테이블이 있고 표 밖인 경우 → 새 표로 삽입
            if (html && html.includes('<table') && !currentCell) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(sanitizeExternalHtml(html), 'text/html');
                const pastedTable = doc.querySelector('table');

                if (pastedTable) {
                    const tableHtml = `<div class="table-wrapper"><table>${pastedTable.innerHTML}</table></div><p><br></p>`;
                    document.execCommand('insertHTML', false, tableHtml);
                    if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                    return;
                }
            }

            // 내부에서 복사한 것인지 확인 (텍스트 내용이 같으면 내부 복사)
            const isInternalCopy = internalClipboard.text && internalClipboard.text === text;

            // 내부에서 복사한 것이면 서식 전체 유지
            if (isInternalCopy && internalClipboard.html) {
                document.execCommand('insertHTML', false, internalClipboard.html);
                if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                return;
            }

            // 외부에서 복사한 내용은 서식을 제거하고 기본 서식으로 붙여넣기
            if (text) {
                let cleanText = text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/\n/g, '<br>');

                cleanText = cleanText.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
                    const { url, trail } = splitTrailingPunctuation(match);
                    const safeUrl = url.replace(/"/g, '&quot;'); // 따옴표 이스케이프로 속성 주입 방지
                    return `<a href="${safeUrl}" target="_blank" style="color:#2563EB; text-decoration:underline; cursor:pointer;">${safeUrl}</a>${trail}`;
                });

                document.execCommand('insertHTML', false, cleanText);
            }

            if (callbacks.onAfterPaste) callbacks.onAfterPaste();
        });
    });
}

/**
 * 셀 클립보드 데이터 가져오기 (외부에서 접근용)
 */
export function getCellClipboard() {
    return globalCellClipboard;
}

/**
 * 셀 클립보드 데이터 설정 (외부에서 접근용)
 */
export function setCellClipboard(data) {
    globalCellClipboard = data;
}

/**
 * 표(table) 셀 안에서 더블클릭으로 단어를 선택할 수 있게 합니다.
 */
export function setupTableTextSelection(editorElement) {
    if (!editorElement) return;
    
    editorElement.addEventListener('dblclick', (e) => {
        let target = e.target;
        while (target && target !== editorElement) {
            if (target.tagName === 'TD' || target.tagName === 'TH') {
                const selection = window.getSelection();
                const range = document.createRange();
                
                let node = e.target;
                if (node.nodeType !== Node.TEXT_NODE) {
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
                    
                    let start = clickOffset;
                    let end = clickOffset;
                    
                    const wordBoundary = /[\s\.,;:!?\(\)\[\]\{\}'"]/;
                    
                    while (start > 0 && !wordBoundary.test(text[start - 1])) {
                        start--;
                    }
                    
                    while (end < text.length && !wordBoundary.test(text[end])) {
                        end++;
                    }
                    
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

function getClickOffset(textNode, event) {
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (range && range.startContainer === textNode) {
            return range.startOffset;
        }
    } else if (document.caretPositionFromPoint) {
        // Firefox는 caretRangeFromPoint가 없고 표준 caretPositionFromPoint만 지원
        const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (pos && pos.offsetNode === textNode) {
            return pos.offset;
        }
    }

    return Math.floor(textNode.textContent.length / 2);
}
