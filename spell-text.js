/**
 * 맞춤법 검사 — Gemini에게 줄마다 고친 모습을 받고, 원래 줄과 견주어 고친 곳을 찾는다.
 *
 * 고친 곳의 위치(몇 번째 글자)를 Gemini에게 직접 묻지 않는다. 같은 말이 한 줄에 여러 번 나오거나
 * 글자 수를 세는 일은 자주 틀리기 때문이다. 고친 줄 전체를 받아 글자 단위로 견주어(diff)
 * 바뀐 자리를 정확히 찾고, 낱말(띄어쓰기 단위) 하나를 단위로 보여 준다. 이유(notes)는 바뀐 말과 맞춰 붙인다.
 *
 * 이 파일은 화면(DOM)과 상관없는 함수만 둔다 (Node에서 그대로 시험할 수 있게).
 */
import { geminiJson } from './gemini.js';

const BATCH_CHARS = 1500;   // 한 번에 보내는 분량 — 길면 답이 늦고, 짧으면 앞뒤 줄의 맥락이 끊긴다
const PARALLEL = 2;

const SYSTEM = [
    '너는 한국어 맞춤법 검사기다. 사용자가 보낸 lines의 각 줄을 한글 맞춤법·표준어 규정·띄어쓰기 규정·문장 부호 규정에 따라 검사한다.',
    '규칙:',
    '1. 맞춤법(철자), 띄어쓰기, 문장 부호, 명백한 오타만 고친다.',
    '2. 낱말을 다른 낱말로 바꾸거나 문장을 다듬지 않는다. 말투·문체·어휘·내용은 그대로 둔다(구어체, 기도문, 신앙 표현 포함).',
    '3. 성경 구절·찬송가·인용문의 옛 표현(예: "하시니라", "없으리로다"), 고유명사(사람·교회·지명), 주소(URL)·이메일·숫자는 고치지 않는다.',
    '4. 확실한 오류만 고친다. 애매하거나 두 가지 다 맞는 표기는 고치지 않는다.',
    '5. 고칠 곳이 있는 줄만 fixes에 넣는다. corrected에는 그 줄 전체를 쓰되, 고친 곳 말고는 한 글자도 바꾸지 않는다.',
    '6. notes에는 고친 곳마다 원래 말(from), 고친 말(to), 짧은 이유(why, 한국어 25자 안쪽)를 쓴다.'
].join('\n');

const SCHEMA = {
    type: 'object',
    properties: {
        fixes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'integer', description: '고친 줄의 id' },
                    corrected: { type: 'string', description: '고친 줄 전체' },
                    notes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                from: { type: 'string' },
                                to: { type: 'string' },
                                why: { type: 'string' }
                            },
                            required: ['from', 'to', 'why']
                        }
                    }
                },
                required: ['id', 'corrected', 'notes']
            }
        }
    },
    required: ['fixes']
};

const MAX_EDITS = 600;   // 이보다 많이 다르면 고친 것이 아니라 다시 쓴 것 — 통째로 하나의 구간으로 본다

/**
 * 가장 적게 고친 차례(Myers 방법)로 두 글을 견준다 → [{ a, b, c, d }], 너무 다르면 null.
 * 고친 곳이 적을수록 빠르다 — 긴 문단에 몇 군데만 고친 경우가 대부분이다.
 */
function myersSpans(x, y) {
    const n = x.length, m = y.length;
    const off = n + m + 1;
    const v = new Int32Array(2 * off + 1);   // v[off + k]: 대각선 k에서 가장 멀리 간 x
    const trace = [];                        // 단계마다 그 전 v의 쓰는 부분만 남긴다 (k = -d-1 … d+1)
    let found = -1;
    for (let d = 0; d <= Math.min(n + m, MAX_EDITS) && found < 0; d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let px = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let py = px - k;
            while (px < n && py < m && x[px] === y[py]) { px++; py++; }
            v[off + k] = px;
            if (px >= n && py >= m) { found = d; break; }
        }
    }
    if (found < 0) return null;
    // 끝에서부터 되짚으며 고친 자리(지운 글자·넣은 글자)를 모은다
    const edits = [];
    let cx = n, cy = m;
    for (let d = found; d >= 0; d--) {
        const w = trace[d];
        const at = (k) => w[k + d + 1];
        const k = cx - cy;
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK), prevY = prevX - prevK;
        while (cx > prevX && cy > prevY) { cx--; cy--; }   // 같은 글자
        if (d > 0) edits.push({ del: cx !== prevX, x: prevX, y: prevY });
        cx = prevX; cy = prevY;
    }
    edits.reverse();
    const spans = [];
    for (const e of edits) {
        const last = spans[spans.length - 1];
        if (last && last.b === e.x && last.d === e.y) { if (e.del) last.b++; else last.d++; }
        else spans.push({ a: e.x, b: e.x + (e.del ? 1 : 0), c: e.y, d: e.y + (e.del ? 0 : 1) });
    }
    return spans;
}

/**
 * 두 글을 글자 단위로 견주어 바뀐 구간들을 돌려준다 → [{ a, b, c, d }] (원래 [a, b) → 고친 [c, d))
 * 앞뒤의 같은 부분을 떼어 낸 뒤 가운데만 견준다.
 */
export function diffSpans(x, y) {
    let p = 0;
    const max = Math.min(x.length, y.length);
    while (p < max && x[p] === y[p]) p++;
    let s = 0;
    while (s < max - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
    const xs = x.slice(p, x.length - s), ys = y.slice(p, y.length - s);
    if (!xs.length && !ys.length) return [];
    const spans = (xs.length && ys.length && myersSpans(xs, ys)) || [{ a: 0, b: xs.length, c: 0, d: ys.length }];
    return spans.map(sp => ({ a: sp.a + p, b: sp.b + p, c: sp.c + p, d: sp.d + p }));
}

const isSpace = (ch) => /\s/.test(ch);

/**
 * 바뀐 구간을 낱말(띄어쓰기 단위) 경계까지 넓히고, 겹치거나 맞닿은 것은 합친다.
 * 예: '할수있다' → '할 수 있다'는 띄어쓰기가 두 군데 들어가지만 한 낱말이라 하나로 보여 준다.
 * → [{ a, b, from, to }] (a, b: 원래 줄에서의 위치)
 */
export function wordHunks(orig, corr) {
    const out = [];
    for (const span of diffSpans(orig, corr)) {
        let { a, b, c, d } = span;
        while (a > 0 && c > 0 && !isSpace(orig[a - 1]) && orig[a - 1] === corr[c - 1]) { a--; c--; }
        while (b < orig.length && d < corr.length && !isSpace(orig[b]) && orig[b] === corr[d]) { b++; d++; }
        // 띄어쓰기만 지우는 경우 등 원래 쪽이 비면 앞 글자를 하나 붙인다 (밑줄을 그을 자리가 있도록)
        if (a === b && a > 0) { a--; c--; }
        const prev = out[out.length - 1];
        if (prev && a <= prev.b) { prev.b = Math.max(prev.b, b); prev.d = Math.max(prev.d, d); }
        else out.push({ a, b, c, d });
    }
    return out.map(h => ({ a: h.a, b: h.b, from: orig.slice(h.a, h.b), to: corr.slice(h.c, h.d) }));
}

/** 고친 종류: 띄어쓰기만 / 문장 부호만 / 그 밖(맞춤법) */
export function spellKind(from, to) {
    const noSpace = (s) => s.replace(/\s+/g, '');
    if (noSpace(from) === noSpace(to)) return '띄어쓰기';
    const letters = (s) => s.replace(/[^\p{L}\p{N}]/gu, '');
    if (letters(from) === letters(to)) return '문장 부호';
    return '맞춤법';
}

function editDistance(x, y) {
    const prev = new Array(y.length + 1);
    for (let j = 0; j <= y.length; j++) prev[j] = j;
    for (let i = 1; i <= x.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= y.length; j++) {
            const keep = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
            diag = keep;
        }
    }
    return prev[y.length];
}

/** 맞춤법이 아니라 낱말을 바꿔 쓴 것으로 보이면 true (지시를 어기고 문장을 다듬은 경우를 걸러 낸다) */
export function looksLikeRewrite(from, to) {
    const x = from.replace(/\s+/g, ''), y = to.replace(/\s+/g, '');
    if (x === y) return false;
    return editDistance(x, y) > Math.max(3, Math.ceil(Math.max(x.length, y.length) * 0.5));
}

/** 바뀐 곳에 맞는 이유를 Gemini의 notes에서 찾는다 */
function pickNote(hunk, notes) {
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const f = norm(hunk.from), t = norm(hunk.to);
    for (const n of notes || []) {
        const nf = norm(n && n.from), nt = norm(n && n.to);
        if (!nf && !nt) continue;
        if ((nf && (f.includes(nf) || nf.includes(f))) || (nt && (t.includes(nt) || nt.includes(t)))) {
            return String(n.why || '').trim();
        }
    }
    return '';
}

/** 받은 고친 줄 하나 → 고칠 곳들 */
export function fixesForLine(line, corrected, notes) {
    const orig = line.text;
    if (typeof corrected !== 'string') return [];
    // 앞뒤 공백(들여쓰기)은 원래대로 둔다
    const lead = orig.match(/^\s*/)[0], trail = orig.match(/\s*$/)[0];
    const corr = lead + corrected.trim() + trail;
    if (corr === orig) return [];
    const out = [];
    for (const h of wordHunks(orig, corr)) {
        if (!h.from || looksLikeRewrite(h.from, h.to)) continue;
        out.push({ id: line.id, a: h.a, b: h.b, from: h.from, to: h.to, type: spellKind(h.from, h.to), why: pickNote(h, notes) });
    }
    return out;
}

/** 줄들을 BATCH_CHARS 안쪽의 묶음으로 */
export function batchLines(lines, maxChars = BATCH_CHARS) {
    const batches = [];
    let cur = [], size = 0;
    for (const ln of lines) {
        if (cur.length && size + ln.text.length > maxChars) { batches.push(cur); cur = []; size = 0; }
        cur.push(ln);
        size += ln.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
}

/**
 * lines: [{ id, text }] → { fixes: [{ id, a, b, from, to, type, why }], usage: { input, output } }
 * onProgress(끝낸 묶음 수, 전체 묶음 수). ask: 시험에서 Gemini 대신 쓸 함수
 */
export async function checkSpelling(lines, { onProgress, ask = geminiJson } = {}) {
    const batches = batchLines(lines);
    const byId = new Map(lines.map(l => [l.id, l]));
    const fixes = [];
    const usage = { input: 0, output: 0 };
    let next = 0, done = 0;
    const worker = async () => {
        while (next < batches.length) {
            const batch = batches[next++];
            const res = await ask({
                system: SYSTEM,
                input: JSON.stringify({ lines: batch.map(l => ({ id: l.id, text: l.text })) }),
                schema: SCHEMA
            });
            usage.input += (res.usage && res.usage.input) || 0;
            usage.output += (res.usage && res.usage.output) || 0;
            const ids = new Set(batch.map(l => l.id));
            for (const f of (res.data && Array.isArray(res.data.fixes)) ? res.data.fixes : []) {
                if (!f || !ids.has(f.id)) continue;   // 보내지 않은 줄 번호는 버린다
                fixes.push(...fixesForLine(byId.get(f.id), f.corrected, f.notes));
            }
            done++;
            if (onProgress) onProgress(done, batches.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
    fixes.sort((x, y) => x.id - y.id || x.a - y.a);
    return { fixes, usage };
}
