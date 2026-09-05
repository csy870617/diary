/**
 * 표 안에서 쓰는 간단한 계산식.
 *
 *   =SUM(B1:B3)      =합계(B1:B3)
 *   =AVERAGE(B1:B3)  =평균(B1:B3)
 *   =COUNT(B1:B3)    =개수(B1:B3)
 *   =MAX(B1:B3)      =최대(B1:B3)
 *   =MIN(B1:B3)      =최소(B1:B3)
 *
 * 칸 주소는 엑셀과 같다. 가로는 A·B·C…, 세로는 1·2·3….
 * 여러 구간을 쉼표로 이어 쓸 수 있다 — =SUM(B1:B3, D1)
 *
 * 칸에는 계산 결과를 보여주고, 식 자체는 data-formula에 넣어 둔다.
 * 그래야 숫자를 고쳤을 때 다시 계산할 수 있다.
 */

// 사용자가 쓰는 이름 → 내부 이름
const FUNCTIONS = {
    SUM: 'SUM', 합계: 'SUM', 더하기: 'SUM',
    AVERAGE: 'AVERAGE', AVG: 'AVERAGE', 평균: 'AVERAGE',
    COUNT: 'COUNT', 개수: 'COUNT',
    MAX: 'MAX', 최대: 'MAX', 최댓값: 'MAX',
    MIN: 'MIN', 최소: 'MIN', 최솟값: 'MIN',
};

export const FUNCTION_LABELS = [
    { fn: 'SUM', label: '합계' },
    { fn: 'AVERAGE', label: '평균' },
    { fn: 'COUNT', label: '개수' },
    { fn: 'MAX', label: '최대' },
    { fn: 'MIN', label: '최소' },
];

const ERR_FORMULA = '#수식';   // 식을 못 알아봄
const ERR_CYCLE = '#순환';     // 자기 자신을 참조

/** 0 → A, 1 → B, … 26 → AA */
export function columnLabel(index) {
    let label = '';
    let n = index;
    while (n >= 0) {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    }
    return label;
}

/** "B3" → { col: 1, row: 2 } (0부터). 형식이 아니면 null */
function parseRef(ref) {
    const m = /^([A-Z]+)([0-9]+)$/.exec(ref.trim().toUpperCase());
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    const row = parseInt(m[2], 10);
    if (!row) return null;
    return { col: col - 1, row: row - 1 };
}

/**
 * 표를 눈에 보이는 격자로 편다.
 * 칸 합치기(colspan·rowspan)가 있어도 화면에서 보이는 위치 그대로 주소가 매겨진다.
 */
export function buildGrid(table) {
    const grid = [];
    const rows = Array.from(table.rows);
    rows.forEach((tr, r) => {
        if (!grid[r]) grid[r] = [];
        let c = 0;
        Array.from(tr.cells).forEach(cell => {
            while (grid[r][c]) c++;                       // 위에서 내려온 칸은 건너뛴다
            const cs = Math.max(1, cell.colSpan || 1);
            const rs = Math.max(1, cell.rowSpan || 1);
            for (let dr = 0; dr < rs; dr++) {
                for (let dc = 0; dc < cs; dc++) {
                    if (!grid[r + dr]) grid[r + dr] = [];
                    grid[r + dr][c + dc] = cell;
                }
            }
            c += cs;
        });
    });
    return grid;
}

/** 격자에서 이 칸의 위치를 찾는다 (합친 칸은 왼쪽 위 기준) */
export function findCellPosition(grid, cell) {
    for (let r = 0; r < grid.length; r++) {
        const row = grid[r] || [];
        for (let c = 0; c < row.length; c++) {
            if (row[c] === cell) return { row: r, col: c };
        }
    }
    return null;
}

/**
 * 칸의 글자에서 숫자를 읽는다.
 * "1,200" → 1200, "12명" → 12, "1,200원" → 1200 처럼 단위가 붙어도 읽는다.
 * 숫자로 시작하지 않으면(예: "제1주", "합계") 계산에서 뺀다.
 */
export function parseNumber(text) {
    const s = String(text == null ? '' : text).trim().replace(/[,\s]/g, '');
    if (!s) return null;
    const m = /^-?\d+(\.\d+)?/.exec(s);
    if (!m) return null;
    const rest = s.slice(m[0].length);
    if (/\d/.test(rest)) return null;      // "1-2" 같은 건 숫자로 보지 않는다
    const n = parseFloat(m[0]);
    return Number.isFinite(n) ? n : null;
}

/** 칸이 보여줄 값 — 수식 칸이면 계산 결과, 아니면 적힌 글자 */
function cellValue(cell, table, visited) {
    if (!cell) return null;
    const formula = cell.getAttribute('data-formula');
    if (formula) {
        const result = evaluateFormula(table, formula, cell, visited);
        return typeof result === 'number' ? result : null;
    }
    return parseNumber(cell.textContent);
}

/**
 * 식을 계산한다. 결과는 숫자, 또는 '#수식'·'#순환' 같은 오류 글자.
 * visited: 자기 자신을 도로 참조하는 식을 잡기 위한 추적용
 */
export function evaluateFormula(table, formula, ownerCell, visited) {
    const text = String(formula || '').trim();
    const m = /^=\s*([A-Za-z가-힣]+)\s*\(([^()]*)\)$/.exec(text);
    if (!m) return ERR_FORMULA;

    const fn = FUNCTIONS[m[1].toUpperCase()] || FUNCTIONS[m[1]];
    if (!fn) return ERR_FORMULA;

    const seen = visited || new Set();
    if (ownerCell) {
        if (seen.has(ownerCell)) return ERR_CYCLE;
        seen.add(ownerCell);
    }

    const grid = buildGrid(table);
    const numbers = [];
    const parts = m[2].split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return ERR_FORMULA;

    for (const part of parts) {
        const [fromRaw, toRaw] = part.split(':');
        const from = parseRef(fromRaw || '');
        if (!from) { if (ownerCell) seen.delete(ownerCell); return ERR_FORMULA; }
        const to = toRaw === undefined ? from : parseRef(toRaw);
        if (!to) { if (ownerCell) seen.delete(ownerCell); return ERR_FORMULA; }

        const r1 = Math.min(from.row, to.row), r2 = Math.max(from.row, to.row);
        const c1 = Math.min(from.col, to.col), c2 = Math.max(from.col, to.col);
        const counted = new Set();   // 합친 칸이 두 번 세어지지 않도록
        for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
                const cell = (grid[r] || [])[c];
                if (!cell || cell === ownerCell || counted.has(cell)) continue;
                counted.add(cell);
                const v = cellValue(cell, table, seen);
                if (v !== null) numbers.push(v);
            }
        }
    }
    if (ownerCell) seen.delete(ownerCell);

    if (fn === 'COUNT') return numbers.length;
    if (!numbers.length) return 0;
    if (fn === 'SUM') return numbers.reduce((a, b) => a + b, 0);
    if (fn === 'AVERAGE') return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    if (fn === 'MAX') return Math.max(...numbers);
    if (fn === 'MIN') return Math.min(...numbers);
    return ERR_FORMULA;
}

/** 보여줄 글자로 다듬는다 (소수점이 길어지지 않게) */
export function formatResult(value) {
    if (typeof value !== 'number') return String(value);
    if (!Number.isFinite(value)) return ERR_FORMULA;
    const rounded = Math.round(value * 100) / 100;
    return String(rounded);
}

/** 표 안의 모든 수식 칸을 다시 계산한다 */
export function recalcTable(table) {
    if (!table) return;
    const cells = table.querySelectorAll('td[data-formula], th[data-formula]');
    cells.forEach(cell => {
        // 사용자가 그 칸에서 식을 고치는 중이면 건드리지 않는다
        if (cell.dataset.editingFormula === '1') return;
        cell.textContent = formatResult(evaluateFormula(table, cell.getAttribute('data-formula'), cell));
    });
}

/** 본문 전체의 표를 다시 계산한다 (글을 열 때) */
export function recalcAll(root) {
    if (!root) return;
    root.querySelectorAll('table').forEach(recalcTable);
}

/** 칸에 식을 넣고 결과를 보여준다 */
export function applyFormula(cell, formula) {
    const table = cell && cell.closest('table');
    if (!table) return;
    cell.setAttribute('data-formula', String(formula).trim());
    delete cell.dataset.editingFormula;
    recalcTable(table);
}

/** 칸에서 식을 걷어내고 지금 보이는 값만 남긴다 */
export function clearFormula(cell) {
    if (!cell) return;
    cell.removeAttribute('data-formula');
    delete cell.dataset.editingFormula;
}

/**
 * 선택한 칸들로 =SUM(B1:B3) 같은 식을 만든다.
 * 한 줄로 이어진 선택이면 그 구간을, 흩어져 있으면 각각을 쉼표로 잇는다.
 */
export function buildRangeFormula(table, cells, fn) {
    const grid = buildGrid(table);
    const positions = cells.map(c => findCellPosition(grid, c)).filter(Boolean);
    if (!positions.length) return null;

    const rows = positions.map(p => p.row), cols = positions.map(p => p.col);
    const r1 = Math.min(...rows), r2 = Math.max(...rows);
    const c1 = Math.min(...cols), c2 = Math.max(...cols);

    // 고른 칸들이 네모 구간을 빈틈없이 채우면 A1:B3 형태로 줄여 쓴다
    const filled = (r2 - r1 + 1) * (c2 - c1 + 1);
    const unique = new Set(positions.map(p => p.row + ',' + p.col));
    const ref = (p) => columnLabel(p.col) + (p.row + 1);
    const args = unique.size === filled
        ? `${columnLabel(c1)}${r1 + 1}:${columnLabel(c2)}${r2 + 1}`
        : positions.map(ref).join(', ');
    return `=${fn}(${args})`;
}

/**
 * 계산 결과를 넣을 칸을 정한다.
 * 세로로 고른 칸들이면 바로 아래, 가로로 고른 칸들이면 바로 오른쪽.
 * 그 자리가 표 밖이면 null을 돌려주고, 호출부가 줄·칸을 새로 만든다.
 */
export function targetCellFor(table, cells) {
    const grid = buildGrid(table);
    const positions = cells.map(c => findCellPosition(grid, c)).filter(Boolean);
    if (!positions.length) return null;
    const rows = positions.map(p => p.row), cols = positions.map(p => p.col);
    const r1 = Math.min(...rows), r2 = Math.max(...rows);
    const c1 = Math.min(...cols), c2 = Math.max(...cols);

    const vertical = (r2 - r1) >= (c2 - c1);   // 세로로 길게 골랐는가
    const target = vertical ? { row: r2 + 1, col: c1 } : { row: r1, col: c2 + 1 };
    const cell = (grid[target.row] || [])[target.col] || null;
    return { cell, vertical, at: target, grid };
}
