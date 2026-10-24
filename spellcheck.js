/**
 * 맞춤법 검사 (한국어·영어, 기기 안에서) — 글쓰기 도구 막대의 버튼으로 시작한다.
 *
 * 제목·소제목·본문을 줄 단위로 검사하고(spell-engine.js), 고칠 곳을 본문에 물결 밑줄로 보여 준다.
 * 밑줄 색은 고친 종류를 나타낸다 — 맞춤법(빨강)·띄어쓰기(초록)·표준어(보라)·문맥(파랑).
 * 글은 어디로도 보내지 않는다. 사전은 처음 한 번 받아 기기에 저장한다.
 * 밑줄은 CSS Highlight API로 그린다 — 본문 HTML을 건드리지 않으므로 표시가 글에 저장될 일이 없다.
 * 아래 창의 목록에서 하나씩 고치거나 무시하고, '모두 고치기'로 한 번에 고친다.
 * 목록의 항목을 누르면 글에서 그 자리로 옮겨 가 잠깐 빛나는 테두리로 보여 준다 (책 보기면 그 쪽으로 넘긴다).
 * 고칠 때마다 되돌릴 자리를 남겨 되돌리기(Ctrl+Z) 한 번으로 돌아갈 수 있다.
 * 정밀 검사(문맥 언어 모델, 약 80MB)를 받아 두면 기본 검사 결과를 먼저 보여 준 뒤 문맥으로 더 찾은 곳을 덧붙인다.
 * 밑줄은 글과 함께 움직이는 Range로 잡고, 고치기 직전에 그 자리의 글자가 그대로인지 확인한다
 * (검사하는 동안이나 결과를 보는 동안 글을 고쳐도 엉뚱한 곳을 고치지 않도록).
 */
import { diffSpans } from './spell-text.js';
import { checkDocument, addPersonalWord, lmSupported, lmStatus, lmDownload, lmCancel, lmDelete, checkDocumentLM } from './spell-engine.js';
import { markEditPoint, afterProgrammaticEdit, jumpToPage } from './editor.js';
import { showToast } from './tts.js';
import { state, isReadOnlyView } from './state.js';

const $ = (id) => document.getElementById(id);
const canHighlight = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
const FOCUS = 'spell-focus';
// 고친 곳의 종류마다 밑줄 색을 달리한다 (네이버 맞춤법 검사기처럼) — 맞춤법 빨강·띄어쓰기 초록·표준어 보라·문맥 파랑
const KINDS = [
    { type: '맞춤법', mark: 'spell-error', cls: 'kind-spell' },
    { type: '띄어쓰기', mark: 'spell-space', cls: 'kind-space' },
    { type: '문장 부호', mark: 'spell-space', cls: 'kind-space' },
    { type: '표준어', mark: 'spell-std', cls: 'kind-std' },
    { type: '문맥', mark: 'spell-ctx', cls: 'kind-ctx' },
];
const kindOf = (type) => KINDS.find(k => k.type === type) || KINDS[0];
const MARKS = [...new Set(KINDS.map(k => k.mark))];
const HAS_LETTER = /\p{L}/u;

let items = [];      // { id, where: 'body'|'title'|'subtitle', range | (el, a), from, to, type, why, word, src, ctx, row }
let running = false;
let runSeq = 0;      // 검사 중에 창을 닫거나 다른 글을 열면 늦게 온 결과를 버린다
let lastRun = null;  // { seq, lines, plan, base } — 정밀 검사를 받은 뒤 같은 결과에 바로 덧붙이려고 기억한다
let dismissed = new Set();   // 무시한 자리 ('줄:시작:끝') — 정밀 검사가 같은 자리를 다시 내놓지 않게

// ─── 본문 글자 펼치기 ───
// 음성 읽기(tts.js)와 같은 방식이지만 표의 칸(TD·TH)도 줄로 나눈다 — 칸끼리 붙어 '띄어쓰기 틀림'으로 보이지 않게.

const BLOCKS = new Set(['DIV', 'P', 'LI', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
    'HR', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE', 'CAPTION', 'FIGCAPTION']);

function indexText(root) {
    let text = '';
    const segs = [];
    const lineBreak = () => { if (text && !text.endsWith('\n')) text += '\n'; };
    const walk = (parent) => {
        for (const node of parent.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                segs.push({ node, start: text.length });
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName;
                if (tag === 'BR') { text += '\n'; continue; }
                if (tag === 'SCRIPT' || tag === 'STYLE') continue;
                const block = BLOCKS.has(tag);
                if (block) lineBreak();
                walk(node);
                if (block) lineBreak();
            }
        }
    };
    if (root) walk(root);
    return { text, segs };
}

function pointAt(index, pos, isEnd) {
    for (const sg of index.segs) {
        const len = sg.node.textContent.length;
        if (isEnd ? (pos > sg.start && pos <= sg.start + len) : (pos >= sg.start && pos < sg.start + len)) {
            return { node: sg.node, offset: pos - sg.start };
        }
    }
    return null;
}

function rangeAt(index, a, b) {
    if (b <= a) return null;
    const s = pointAt(index, a, false), e = pointAt(index, b, true);
    if (!s || !e) return null;
    try {
        const r = document.createRange();
        r.setStart(s.node, s.offset);
        r.setEnd(e.node, e.offset);
        return r;
    } catch (err) { return null; }
}

function bodyLines(text) {
    const out = [];
    let start = 0;
    for (const part of text.split('\n')) {
        if (HAS_LETTER.test(part)) out.push({ text: part, start });
        start += part.length + 1;
    }
    return out;
}

/** 검사하는 동안 글이 바뀌었으면 같은 줄을 원래 자리에서 가장 가까운 곳에서 찾는다 (없으면 -1) */
function relocate(text, line) {
    if (text.substr(line.start, line.text.length) === line.text) return line.start;
    let best = -1;
    for (let k = text.indexOf(line.text); k >= 0; k = text.indexOf(line.text, k + 1)) {
        if (best < 0 || Math.abs(k - line.start) < Math.abs(best - line.start)) best = k;
    }
    return best;
}

// ─── 검사 ───

async function startSpellcheck() {
    if (running) return;
    if (isReadOnlyView()) { showToast('편집 화면에서 쓸 수 있습니다.'); return; }
    const body = $('editor-body');
    const lines = [], plan = [];
    for (const [el, where] of [[$('edit-title'), 'title'], [$('edit-subtitle'), 'subtitle']]) {
        const v = (el && el.value) || '';
        if (HAS_LETTER.test(v)) { plan.push({ where, el }); lines.push({ id: plan.length - 1, text: v }); }
    }
    for (const ln of bodyLines(indexText(body).text)) {
        plan.push({ where: 'body', ...ln });
        lines.push({ id: plan.length - 1, text: ln.text });
    }
    if (!lines.length) { showToast('검사할 글이 없습니다.'); return; }

    const seq = ++runSeq;
    running = true;
    clearResults();
    openPanel();
    setBusy(true);
    setSummary('검사하는 중…');
    try {
        const fixes = await checkDocument(lines, {
            onProgress: (p) => {
                if (seq !== runSeq) return;
                const name = p.lang === 'en' ? '영어' : '한국어';
                if (p.stage === 'download') setSummary(`${name} 사전을 받는 중… ${p.total ? Math.min(100, Math.round(p.got / p.total * 100)) : 0}% (처음 한 번)`);
                else if (p.stage === 'open') setSummary(`${name} 사전을 여는 중…`);
                else if (p.stage === 'check' && p.total > 8) setSummary(`검사하는 중… (${p.got}/${p.total})`);
            }
        });
        if (seq !== runSeq) return;
        // 검사하는 동안 글을 고쳤을 수 있다 — 지금 글에서 자리를 다시 잡는다
        const index = indexText(body);
        const starts = new Map();
        for (const f of fixes) {
            const p = plan[f.id];
            const ctx = around(lines[f.id].text, f.a, f.b);
            if (p.where !== 'body') { items.push({ ...f, where: p.where, el: p.el, ctx }); continue; }
            if (!starts.has(f.id)) starts.set(f.id, relocate(index.text, p));
            const base = starts.get(f.id);
            if (base < 0) continue;
            const range = rangeAt(index, base + f.a, base + f.b);
            if (range && range.toString() === f.from) items.push({ ...f, where: 'body', range, ctx });
        }
        render();
        lastRun = { seq, lines, plan, base: fixes };
        runPrecision(lastRun);
    } catch (err) {
        if (seq !== runSeq) return;
        setSummary('');
        showMessage('맞춤법을 검사하지 못했습니다.\n' + ((err && err.message) || err));
    } finally {
        if (seq === runSeq) { running = false; setBusy(false); }
    }
}

// ─── 정밀 검사 (문맥 언어 모델) ───

/** 기본 검사 결과 뒤에 정밀 검사로 더 찾은 곳을 덧붙인다 (모델이 없으면 받기를 권한다) */
async function runPrecision(run) {
    if (!lmSupported()) return;
    const st = await lmStatus();
    if (run.seq !== runSeq) return;
    if (!st.ready) { showLmOffer(); return; }
    if (st.broken) { showLmBroken(st.broken); return; }
    setLmRow('<i class="ph ph-spinner-gap tts-spin"></i> 정밀 검사로 문맥을 살피는 중…');
    try {
        const extra = await checkDocumentLM(run.lines, run.base, {
            onProgress: (p) => {
                if (run.seq !== runSeq) return;
                if (p.stage === 'open') setLmRow('<i class="ph ph-spinner-gap tts-spin"></i> 정밀 검사 모델을 여는 중… (처음엔 조금 걸립니다)');
                else if (p.stage === 'check' && p.total) setLmRow(`<i class="ph ph-spinner-gap tts-spin"></i> 정밀 검사 중… (${p.got}/${p.total})`);
            }
        });
        if (run.seq !== runSeq) return;
        const added = mergePrecision(run, extra);
        setLmRow(added ? `정밀 검사 ✓ ${added}곳 더 찾았습니다` : '정밀 검사 ✓ 더 찾은 곳이 없습니다', [['삭제', 'ghost', deletePrecision]]);
    } catch (err) {
        if (run.seq !== runSeq) return;
        showLmBroken((err && err.message) || String(err));
    }
}

/** 정밀 검사 결과를 목록에 넣는다 → 새로 찾았거나 고쳐 고른 곳의 수 */
function mergePrecision(run, extra) {
    const body = $('editor-body');
    const index = indexText(body);
    const starts = new Map();
    let count = 0;
    for (const f of extra) {
        const key = `${f.id}:${f.a}:${f.b}`;
        if (dismissed.has(key)) continue;
        if (f.replaces) {
            // 기본 검사가 사전으로 고른 말을 문맥에 맞는 말로 바꾼다 (아직 목록에 남아 있을 때만)
            const it = items.find(o => o.id === f.replaces.id && o.a === f.replaces.a && o.b === f.replaces.b && o.src === 'dict' && !o.stale);
            if (!it) continue;
            Object.assign(it, { to: f.to, why: f.why, type: f.type, src: 'lm', word: f.word });
            count++;
            continue;
        }
        if (items.some(o => o.id === f.id && o.a < f.b && f.a < o.b)) continue;   // 이미 다른 고침이 있는 자리
        const p = run.plan[f.id];
        if (!p) continue;
        const ctx = around(run.lines[f.id].text, f.a, f.b);
        if (p.where !== 'body') {
            if ((p.el.value || '').slice(f.a, f.b) !== f.from) continue;
            items.push({ ...f, where: p.where, el: p.el, ctx });
            count++;
            continue;
        }
        if (!starts.has(f.id)) starts.set(f.id, relocate(index.text, p));
        const base = starts.get(f.id);
        if (base < 0) continue;
        const range = rangeAt(index, base + f.a, base + f.b);
        if (!range || range.toString() !== f.from) continue;
        items.push({ ...f, where: 'body', range, ctx });
        count++;
    }
    if (count) {
        items.sort((x, y) => x.id - y.id || x.a - y.a);
        render();
    }
    return count;
}

function lmRow() { return $('spell-lm'); }

/** 정밀 검사 줄 — html: 안내(아이콘 포함), buttons: [[이름, 'primary'|'ghost', 누를 때]] */
function setLmRow(html, buttons = [], pct = null) {
    const row = lmRow();
    if (!row) return;
    row.innerHTML = '';
    const text = document.createElement('span');
    text.className = 'spell-lm-text';
    text.innerHTML = html;
    row.appendChild(text);
    if (pct != null) {
        const bar = document.createElement('div');
        bar.className = 'spell-lm-bar';
        const fill = document.createElement('div');
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        row.appendChild(bar);
    }
    for (const [label, kind, fn] of buttons) row.appendChild(button(label, 'spell-btn ' + kind, fn));
    row.classList.remove('hidden');
}

function hideLmRow() { lmRow()?.classList.add('hidden'); }

function showLmOffer() {
    setLmRow('<b>정밀 검사</b> · 문맥을 보고 더 찾아냅니다 (약 80MB)', [['받기', 'primary', downloadPrecision]]);
}

function showLmBroken(message) {
    setLmRow(message, [['다시 받기', 'ghost', downloadPrecision], ['삭제', 'ghost', deletePrecision]]);
}

async function downloadPrecision() {
    if (!confirm('맞춤법 정밀 검사 모델(약 80MB)을 내려받습니다.\n데이터 요금이 들 수 있으니 와이파이에서 받기를 권장합니다.\n\n한 번 받으면 인터넷 없이도 쓸 수 있고, 글은 기기 밖으로 나가지 않습니다. 계속할까요?')) return;
    setLmRow('받는 중… 0%', [['취소', 'ghost', () => lmCancel()]], 0);
    try {
        await lmDownload((p) => {
            const pct = p.total ? Math.floor(p.got / p.total * 100) : 0;
            setLmRow(`받는 중… ${pct}% (${Math.round(p.got / 1e6)}/${Math.round(p.total / 1e6)}MB)`, [['취소', 'ghost', () => lmCancel()]], pct);
        });
        showToast('정밀 검사 모델을 받았습니다.');
        // 창이 열려 있으면 지금 결과에 바로 정밀 검사를 덧붙인다
        if (lastRun && lastRun.seq === runSeq && !$('spell-panel')?.classList.contains('hidden')) runPrecision(lastRun);
        else hideLmRow();
    } catch (err) {
        if (err && err.abort) { showToast('받기를 멈췄습니다. 다시 누르면 이어서 받습니다.'); showLmOffer(); return; }
        setLmRow('정밀 검사 모델을 받지 못했습니다. ' + ((err && err.message) || ''), [['다시 받기', 'ghost', downloadPrecision]]);
    }
}

async function deletePrecision() {
    if (!confirm('맞춤법 정밀 검사 모델을 기기에서 지울까요?\n(필요하면 언제든 다시 받을 수 있습니다)')) return;
    try { await lmDelete(); } catch (e) { /* 지우지 못했으면 다음에 다시 */ }
    showToast('정밀 검사 모델을 지웠습니다.');
    showLmOffer();
}

// ─── 목록 ───

function render() {
    const list = $('spell-list');
    if (!list) return;
    list.innerHTML = '';
    if (!items.length) {
        showMessage('고칠 곳을 찾지 못했습니다 ✓');
        setSummary('');
    } else {
        items.forEach(it => list.appendChild(itemRow(it)));
        updateSummary();
    }
    paint();
}

function updateSummary() {
    $('spell-fix-all')?.classList.toggle('hidden', items.length < 2);
    setSummary(items.length ? `${items.length}곳` : '');
    // 종류별 개수를 밑줄과 같은 색의 꼬리표로 (맞춤법 2 · 띄어쓰기 3 …)
    const box = $('spell-kinds');
    if (!box) return;
    box.innerHTML = '';
    for (const k of KINDS.filter((k, i) => KINDS.findIndex(o => o.cls === k.cls) === i)) {
        const n = items.filter(it => kindOf(it.type).cls === k.cls).length;
        if (!n) continue;
        const chip = document.createElement('span');
        chip.className = `spell-kind ${k.cls}`;
        chip.textContent = `${k.type} ${n}`;
        box.appendChild(chip);
    }
    box.classList.toggle('hidden', !items.length);
}

function showMessage(text) {
    const list = $('spell-list');
    if (!list) return;
    list.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'spell-empty';
    msg.textContent = text;
    list.appendChild(msg);
}

function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

/** 고칠 곳 앞뒤의 글 몇 자 → { before, word, after } (목록에서 어디인지 알아보게) */
function around(text, a, b) {
    const n = 14;
    let before = text.slice(Math.max(0, a - n), a);
    let after = text.slice(b, b + n);
    if (a > n) before = '…' + before;
    if (b + n < text.length) after += '…';
    return { before, word: text.slice(a, b), after };
}

function itemRow(it) {
    const row = document.createElement('div');
    row.className = 'spell-item';
    row.title = '글에서 보기';
    // 항목 어디를 눌러도 글에서 그 자리를 보여 준다 (고치기·무시 단추는 빼고)
    row.addEventListener('click', (e) => { if (!e.target.closest('.spell-actions')) focusItem(it); });
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'spell-change';
    const from = document.createElement('span');
    from.className = 'spell-from';
    from.textContent = it.from;
    const arrow = document.createElement('i');
    arrow.className = 'ph ph-arrow-right';
    const to = document.createElement('span');
    to.className = 'spell-to';
    to.textContent = it.to;
    change.append(from, arrow, to);
    const ctx = document.createElement('div');
    ctx.className = 'spell-ctx';
    const mark = document.createElement('mark');
    mark.textContent = it.ctx.word;
    ctx.append(it.ctx.before, mark, it.ctx.after);
    const why = document.createElement('div');
    why.className = 'spell-why';
    const kind = document.createElement('span');
    kind.className = `spell-kind ${kindOf(it.type).cls}`;
    kind.textContent = it.type;
    why.append(kind);
    if (it.src === 'lm') {
        const lm = document.createElement('span');
        lm.className = 'spell-kind kind-lm';
        lm.textContent = '정밀';
        lm.title = '정밀 검사(문맥 언어 모델)가 찾았습니다';
        why.append(lm);
    }
    why.append(' ' + [it.where === 'title' ? '제목' : it.where === 'subtitle' ? '소제목' : '', it.why].filter(Boolean).join(' · '));
    const actions = document.createElement('div');
    actions.className = 'spell-actions';
    actions.append(button('고치기', 'spell-btn', () => fixOne(it)), button('무시', 'spell-btn ghost', () => removeItem(it)));
    // 사전에 없어서 잡힌 말(사람 이름 등)은 사전에 넣어 다음부터 잡지 않게 할 수 있다
    if ((it.src === 'dict' || it.src === 'lm') && it.word && it.type === '맞춤법') actions.append(button('사전에 추가', 'spell-btn ghost', () => addToDictionary(it)));
    row.append(change, ctx, why, actions);
    it.row = row;
    return row;
}

function paint() {
    clearSpot();
    if (!canHighlight) return;
    for (const mark of MARKS) {
        const ranges = items.filter(it => it.where === 'body' && it.range && !it.stale && kindOf(it.type).mark === mark).map(it => it.range);
        if (ranges.length) CSS.highlights.set(mark, new Highlight(...ranges));
        else CSS.highlights.delete(mark);
    }
    CSS.highlights.delete(FOCUS);
}

function removeItem(it) {
    dismissed.add(`${it.id}:${it.a}:${it.b}`);
    items = items.filter(o => o !== it);
    it.row?.remove();
    paint();
    if (items.length) updateSummary();
    else { showMessage('모두 살펴봤습니다 ✓'); updateSummary(); }
}

function addToDictionary(it) {
    addPersonalWord(it.word);
    const same = items.filter(o => (o.src === 'dict' || o.src === 'lm') && o.word === it.word);
    same.forEach(o => { items = items.filter(x => x !== o); o.row?.remove(); });
    paint();
    showToast(`'${it.word}'을(를) 사전에 넣었습니다.`);
    if (items.length) updateSummary();
    else { showMessage('모두 살펴봤습니다 ✓'); updateSummary(); }
}

function markStale(it) {
    it.stale = true;
    if (it.row) {
        it.row.classList.add('stale');
        const actions = it.row.querySelector('.spell-actions');
        if (actions) {
            actions.innerHTML = '';
            const note = document.createElement('span');
            note.className = 'spell-why';
            note.textContent = '글이 바뀌어 고치지 못했습니다 · 다시 검사해 주세요';
            actions.append(note, button('닫기', 'spell-btn ghost', () => removeItem(it)));
        }
    }
    paint();
}

// ─── 보기 · 고치기 ───

function inputOffset(it) {
    const v = it.el.value;
    if (v.slice(it.a, it.a + it.from.length) === it.from) return it.a;
    const k = v.indexOf(it.from);   // 앞에서 글자를 고쳤으면 자리가 밀렸다 — 한 군데뿐일 때만 따라간다
    return (k >= 0 && v.indexOf(it.from, k + 1) < 0) ? k : -1;
}

function canApply(it) {
    if (it.stale) return false;
    if (it.where === 'body') return !!it.range && it.range.toString() === it.from;
    return inputOffset(it) >= 0;
}

function scrollParent(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
}

/** 글이 보이는 띠 — 도구 막대 아래부터 맞춤법 창 위까지 */
function visibleBand() {
    const bar = $('editor-toolbar'), container = $('editor-container'), panel = $('spell-panel');
    const barBottom = bar && bar.offsetParent ? bar.getBoundingClientRect().bottom : 0;
    const top = Math.max(0, barBottom, container ? container.getBoundingClientRect().top : 0);
    const bottom = panel && !panel.classList.contains('hidden') ? panel.getBoundingClientRect().top : window.innerHeight;
    return { top, bottom };
}

/** rect가 보이는 띠 밖이면 띠의 위쪽 3분의 1쯤으로 옮긴다 */
function bringIntoView(rect, fromEl) {
    const band = visibleBand();
    if (rect.top >= band.top + 8 && rect.bottom <= band.bottom - 8) return;
    const scroller = scrollParent(fromEl) || $('editor-container');
    scroller?.scrollBy({ top: rect.top - (band.top + (band.bottom - band.top) * 0.33), behavior: 'smooth' });
}

// ─── 고칠 곳을 빛나는 테두리로 보여 주기 ───
// 밑줄(CSS Highlight)을 못 그리는 브라우저에서도 보이고, 옅은 밑줄 사이에서도 눈에 띄게 잠깐 깜빡인다.
// 맞춤법 창과 도구 막대를 덮지 않도록 글이 보이는 띠 안에만 그린다.
let spot = null;   // { layer, place, timer }

function showSpot(getRects) {
    clearSpot();
    const modal = $('write-modal');
    if (!modal) return;
    const layer = document.createElement('div');
    layer.className = 'spell-spot-layer';
    modal.appendChild(layer);
    const place = () => {
        const band = visibleBand();
        layer.style.top = `${band.top}px`;
        layer.style.height = `${Math.max(0, band.bottom - band.top)}px`;
        const rects = getRects().filter(r => r && (r.width || r.height));
        while (layer.children.length < rects.length) {
            const d = document.createElement('div');
            d.className = 'spell-spot';
            layer.appendChild(d);
        }
        [...layer.children].forEach((d, i) => {
            const r = rects[i];
            d.hidden = !r;
            if (!r) return;
            Object.assign(d.style, { left: `${r.left - 3}px`, top: `${r.top - band.top - 2}px`, width: `${r.width + 6}px`, height: `${r.height + 4}px` });
        });
    };
    place();
    window.addEventListener('scroll', place, true);   // 본문이 움직이면 따라간다 (안쪽 스크롤도)
    window.addEventListener('resize', place);
    spot = { layer, place, timer: setTimeout(clearSpot, 2400) };
}

function clearSpot() {
    if (!spot) return;
    clearTimeout(spot.timer);
    window.removeEventListener('scroll', spot.place, true);
    window.removeEventListener('resize', spot.place);
    spot.layer.remove();
    spot = null;
}

/** 책 보기: 그 자리가 있는 쪽으로 넘긴다 */
function turnToRange(range) {
    const container = $('editor-container');
    if (!container) return;
    const stride = Math.floor(container.clientWidth);
    const rect = range.getBoundingClientRect();
    if (stride <= 0 || (!rect.width && !rect.height)) return;
    const offsetX = rect.left - container.getBoundingClientRect().left + container.scrollLeft;
    jumpToPage(Math.max(0, Math.floor(offsetX / stride)));
}

/** 고칠 곳을 글에서 보여 준다 — 화면 밖이면 옮겨 가고, 잠깐 빛나는 테두리를 두른다 */
function focusItem(it) {
    items.forEach(o => o.row && o.row.classList.toggle('active', o === it));
    if (it.where !== 'body') {
        // 제목·소제목 칸: 칸을 보여 주고, 마우스로 쓰는 화면이면 그 글자를 골라 둔다 (휴대폰은 자판이 올라오지 않게 고르지 않는다)
        bringIntoView(it.el.getBoundingClientRect(), it.el);
        const a = inputOffset(it);
        if (a >= 0 && window.matchMedia && matchMedia('(pointer: fine)').matches) { it.el.focus({ preventScroll: true }); it.el.setSelectionRange(a, a + it.from.length); }
        showSpot(() => [it.el.getBoundingClientRect()]);
        return;
    }
    if (!it.range || it.stale) return;
    if (canHighlight) {
        const h = new Highlight(it.range);
        h.priority = 1;
        CSS.highlights.set(FOCUS, h);
    }
    if (state.currentViewMode === 'book' || state.currentViewMode === 'book-edit') turnToRange(it.range);
    else {
        const rect = it.range.getBoundingClientRect();
        if (rect.width || rect.height) bringIntoView(rect, it.range.startContainer.parentElement);
    }
    showSpot(() => [...it.range.getClientRects()]);
}

/** range 안의 글자 마디들 → [{ node, from: 마디 안 시작, len, at: range 글자에서의 시작 }] */
function textPieces(range) {
    const pieces = [];
    let at = 0;
    const add = (node, s, e) => { if (e > s) { pieces.push({ node, from: s, len: e - s, at }); at += e - s; } };
    const root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) { add(root, range.startOffset, range.endOffset); return pieces; }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!range.intersectsNode(n)) continue;
        add(n, n === range.startContainer ? range.startOffset : 0, n === range.endContainer ? range.endOffset : n.length);
    }
    return pieces;
}

/**
 * 본문의 글자를 고친다. 낱말을 통째로 갈아 끼우지 않고 실제로 바뀐 글자만 그 글자가 있던 마디에서 고친다 —
 * '<b>할수있다</b>는'처럼 낱말이 서식으로 나뉘어 있어도 '는'이 굵어지지 않는다.
 * 뒤에서부터 고치므로 앞쪽 글자의 자리(처음 잰 그대로)가 흔들리지 않는다.
 */
function replaceRangeText(range, from, to) {
    const pieces = textPieces(range);
    if (!pieces.length) return;
    const spans = diffSpans(from, to);
    for (let k = spans.length - 1; k >= 0; k--) {
        const { a, b, c, d } = spans[k];
        let target = null;
        for (let i = pieces.length - 1; i >= 0; i--) {
            const p = pieces[i];
            const s = Math.max(a, p.at), e = Math.min(b, p.at + p.len);
            if (s < e) {
                p.node.deleteData(p.from + (s - p.at), e - s);
                target = { node: p.node, offset: p.from + (s - p.at) };
            }
        }
        const text = to.slice(c, d);
        if (!text) continue;
        if (!target) {
            // 넣기만 하는 자리: 바로 앞 글자가 있는 마디에 붙인다 (맨 앞이면 첫 마디 앞)
            const p = pieces.find(q => a > q.at && a <= q.at + q.len) || pieces[0];
            target = { node: p.node, offset: p.from + (a - p.at) };
        }
        target.node.insertData(target.offset, text);
    }
}

function applyItem(it) {
    if (it.where === 'body') { replaceRangeText(it.range, it.from, it.to); return; }
    const a = inputOffset(it);
    const v = it.el.value;
    it.el.value = v.slice(0, a) + it.to + v.slice(a + it.from.length);
    const delta = it.to.length - it.from.length;
    for (const o of items) if (o !== it && o.el === it.el && o.a > a) o.a += delta;
}

function editable() {
    if (isReadOnlyView()) { showToast('편집 화면에서 고칠 수 있습니다.'); return false; }
    return true;
}

function fixOne(it) {
    if (!editable()) return;
    if (!canApply(it)) { markStale(it); return; }
    markEditPoint('spell');
    applyItem(it);
    afterProgrammaticEdit();
    removeItem(it);
}

function fixAll() {
    if (!editable()) return;
    const ready = items.filter(canApply);
    items.filter(it => !ready.includes(it)).forEach(markStale);
    if (!ready.length) return;
    markEditPoint('spell');
    // 뒤에서부터 고친다 — 앞의 자리가 밀리지 않게
    const body = ready.filter(it => it.where === 'body')
        .sort((x, y) => y.range.compareBoundaryPoints(Range.START_TO_START, x.range));
    const inputs = ready.filter(it => it.where !== 'body').sort((x, y) => inputOffset(y) - inputOffset(x));
    for (const it of [...body, ...inputs]) applyItem(it);
    afterProgrammaticEdit();
    ready.forEach(it => { items = items.filter(o => o !== it); it.row?.remove(); });
    paint();
    if (items.length) updateSummary();
    else { showMessage(`${ready.length}곳을 고쳤습니다 ✓`); updateSummary(); }
}

// ─── 창 ───

function setSummary(text) {
    const el = $('spell-summary');
    if (el) el.textContent = text || '';
}

function setBusy(on) {
    const btn = $('toolbar-spell-btn');
    if (!btn) return;
    btn.classList.toggle('rotating', on);
    btn.disabled = on;
}

function openPanel() {
    // 화면 아래의 다른 창(음성 바)은 닫는다 — 같은 자리를 쓴다
    window.dispatchEvent(new CustomEvent('bottom-panel-open', { detail: 'spell' }));
    $('spell-panel')?.classList.remove('hidden');
    $('write-modal')?.classList.add('spell-open');
}

function clearResults() {
    clearSpot();
    items = [];
    dismissed = new Set();
    lastRun = null;
    hideLmRow();
    $('spell-kinds')?.classList.add('hidden');
    const list = $('spell-list');
    if (list) list.innerHTML = '';
    $('spell-fix-all')?.classList.add('hidden');
    if (canHighlight) { MARKS.forEach(m => CSS.highlights.delete(m)); CSS.highlights.delete(FOCUS); }
}

function closePanel() {
    runSeq++;   // 검사 중이었다면 늦게 온 결과는 버린다
    running = false;
    setBusy(false);
    clearResults();
    setSummary('');
    $('spell-panel')?.classList.add('hidden');
    $('write-modal')?.classList.remove('spell-open');
}

/** 다른 글을 열 때 (editor.js) */
export function resetSpellcheck() {
    closePanel();
}

function caretFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) return { node: p.offsetNode, offset: p.offset };
    }
    if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
}

/** 밑줄 친 곳을 누르면 목록에서 그 항목을 찾아 보여 준다 */
function onBodyClick(e) {
    if (!items.length || $('spell-panel')?.classList.contains('hidden')) return;
    const pt = caretFromPoint(e.clientX, e.clientY);
    if (!pt) return;
    const it = items.find(o => {
        if (o.where !== 'body' || !o.range || o.stale) return false;
        try { return o.range.isPointInRange(pt.node, pt.offset); } catch (err) { return false; }
    });
    if (!it) return;
    focusItem(it);
    it.row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function initSpellcheck() {
    $('toolbar-spell-btn')?.addEventListener('click', startSpellcheck);
    $('spell-close')?.addEventListener('click', closePanel);
    $('spell-fix-all')?.addEventListener('click', fixAll);
    $('editor-body')?.addEventListener('click', onBodyClick);
    window.addEventListener('bottom-panel-open', (e) => {
        if (e.detail !== 'spell' && !$('spell-panel')?.classList.contains('hidden')) closePanel();
    });
    setTimeout(removeOldGeminiData, 3000);
}

/**
 * 예전 Gemini 연결(맞춤법 검사·음성)이 이 기기에 남긴 것을 지운다 — Gemini 연결은 뺐다.
 * 특히 키는 요금이 청구될 수 있는 열쇠라 남겨 두지 않는다. (없으면 아무 일도 하지 않는다)
 */
function removeOldGeminiData() {
    try {
        ['faith_gemini_key', 'faith_gemini_meta', 'faith_gemini_style', 'faith_gemini_cps'].forEach(k => localStorage.removeItem(k));
        const v = localStorage.getItem('faith_tts_voice');
        if (v && v.startsWith('gm:')) localStorage.removeItem('faith_tts_voice');
    } catch (e) { /* 저장소 접근 불가 */ }
    try { if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('diary-gemini-voice'); } catch (e) { /* 지우지 못해도 쓰지 않는다 */ }
}
