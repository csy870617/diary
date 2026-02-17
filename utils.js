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

// 전역 셀 클립보드
let globalCellClipboard = { cellData: null, rows: 0, cols: 0 };

/**
 * 에디터에 복사/붙여넣기 이벤트 리스너를 추가합니다.
 * 표 셀의 복사/잘라내기/붙여넣기와 하이퍼링크 유지를 지원합니다.
 * @param {HTMLElement} editorElement - 에디터 요소
 * @param {Object} callbacks - 콜백 함수들 { onBeforePaste, onAfterPaste }
 */
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
     * 선택 영역의 HTML을 가져오되, 부분 선택된 링크도 완전히 포함
     */
    function getSelectionHtmlWithLinks() {
        const selection = window.getSelection();
        if (!selection.rangeCount) return { html: '', text: '' };
        
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const div = document.createElement('div');
        div.appendChild(fragment.cloneNode(true));
        
        let startNode = range.startContainer;
        let startAnchor = startNode.nodeType === 3 ? startNode.parentElement?.closest('a') : startNode.closest?.('a');
        
        let html = div.innerHTML;
        
        if (startAnchor && !html.includes('<a ')) {
            const href = startAnchor.getAttribute('href');
            const target = startAnchor.getAttribute('target') || '_blank';
            const style = startAnchor.getAttribute('style') || 'color:#2563EB; text-decoration:underline; cursor:pointer;';
            html = `<a href="${href}" target="${target}" style="${style}">${html}</a>`;
        }
        
        return { html, text: selection.toString() };
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
            if (selectedCells.length > 0) {
                e.preventDefault();
                e.stopPropagation();

                const data = getSelectedCellsData();
                if (data) {
                    globalCellClipboard = data;

                    // 텍스트(TSV) + HTML 표 모두 시스템 클립보드에 복사
                    const textContent = data.cellData.map(row =>
                        row.map(cell => {
                            const div = document.createElement('div');
                            div.innerHTML = cell;
                            return div.textContent || '';
                        }).join('\t')
                    ).join('\n');

                    const tableHtml = buildTableHtml(data);

                    if (navigator.clipboard && window.ClipboardItem) {
                        const htmlBlob = new Blob([tableHtml], { type: 'text/html' });
                        const textBlob = new Blob([textContent], { type: 'text/plain' });
                        navigator.clipboard.write([
                            new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })
                        ]).catch(() => {
                            navigator.clipboard.writeText(textContent).catch(() => {});
                        });
                    } else {
                        navigator.clipboard?.writeText(textContent).catch(() => {});
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
            }
        }
        
        // Ctrl+X / Cmd+X: 잘라내기
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            if (selectedCells.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                
                const data = getSelectedCellsData();
                if (data) {
                    globalCellClipboard = data;
                    
                    const textContent = data.cellData.map(row => 
                        row.map(cell => {
                            const div = document.createElement('div');
                            div.innerHTML = cell;
                            return div.textContent || '';
                        }).join('\t')
                    ).join('\n');
                    
                    navigator.clipboard?.writeText(textContent).catch(() => {});
                    
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
            }
        }
        
        // Ctrl+V / Cmd+V: 붙여넣기
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            // 대상 셀 찾기: 선택된 셀 중 첫 번째 또는 현재 커서 위치의 셀
            let targetCell = null;

            if (selectedCells.length > 0) {
                // 선택된 셀 중 가장 왼쪽 위 셀 찾기
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
            } else {
                targetCell = getCurrentCell();
            }

            // 셀 클립보드에 데이터가 있으면 붙여넣기 처리
            if (globalCellClipboard.cellData) {
                e.preventDefault();
                e.stopPropagation();

                if (callbacks.onBeforePaste) callbacks.onBeforePaste();

                if (targetCell) {
                    // 기존 표의 셀에 붙여넣기
                    if (pasteCellData(targetCell, globalCellClipboard)) {
                        clearCellSelection();
                        if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                        console.log('셀 붙여넣기 완료');
                    }
                } else {
                    // 표 밖 커서 위치에 새 표로 붙여넣기
                    const tableHtml = buildTableHtml(globalCellClipboard);
                    document.execCommand('insertHTML', false, tableHtml);
                    if (callbacks.onAfterPaste) callbacks.onAfterPaste();
                    console.log('새 표로 붙여넣기 완료');
                }
                return;
            }
        }
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
    
    // ========== 일반 복사 이벤트 (링크 보존) ==========
    editorElement.addEventListener('copy', (e) => {
        // 선택된 셀이 있으면 키보드 핸들러에서 처리됨
        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length > 0) return;
        
        // 일반 텍스트 선택 복사 - 셀 클립보드 초기화
        globalCellClipboard = { cellData: null, rows: 0, cols: 0 };
        
        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;
        
        const { html, text } = getSelectionHtmlWithLinks();
        
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        internalClipboard = { html, text };
        
        e.preventDefault();
    });
    
    // ========== 일반 잘라내기 이벤트 ==========
    editorElement.addEventListener('cut', (e) => {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        if (selectedCells.length > 0) return;
        
        // 일반 텍스트 잘라내기 - 셀 클립보드 초기화
        globalCellClipboard = { cellData: null, rows: 0, cols: 0 };
        
        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;
        
        const { html, text } = getSelectionHtmlWithLinks();
        
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        internalClipboard = { html, text };
        
        const range = selection.getRangeAt(0);
        range.deleteContents();
        
        if (callbacks.onAfterPaste) callbacks.onAfterPaste();
        e.preventDefault();
    });
    
    // ========== 붙여넣기 이벤트 ==========
    editorElement.addEventListener('paste', (e) => {
        const selectedCells = document.querySelectorAll('td.selected-cell');
        const currentCell = getCurrentCell();

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

        let html = e.clipboardData.getData('text/html');
        let text = e.clipboardData.getData('text/plain');

        // 외부에서 복사한 테이블이 있고 현재 셀 안에 있는 경우 → 셀 내용 교체
        if (html && html.includes('<table') && currentCell) {
            const table = currentCell.closest('table');
            if (table) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
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
            const doc = parser.parseFromString(html, 'text/html');
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
        
        // 내부에서 복사한 링크가 있으면 서식 유지
        if (isInternalCopy && internalClipboard.html && internalClipboard.html.includes('<a ')) {
            document.execCommand('insertHTML', false, internalClipboard.html);
            if (callbacks.onAfterPaste) callbacks.onAfterPaste();
            return;
        }
        
        // 외부에서 복사한 것은 순수 텍스트로 붙여넣기 (URL만 자동 링크)
        if (text) {
            // 줄바꿈 유지하면서 HTML 이스케이프
            let cleanText = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>');
            
            // URL 자동 링크
            cleanText = cleanText.replace(
                /(https?:\/\/[^\s<]+)/g, 
                '<a href="$1" target="_blank" style="color:#2563EB; text-decoration:underline; cursor:pointer;">$1</a>'
            );
            
            document.execCommand('insertHTML', false, cleanText);
        }
        
        if (callbacks.onAfterPaste) callbacks.onAfterPaste();
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
    }
    
    return Math.floor(textNode.textContent.length / 2);
}