/**
 * 맞춤법 검사 — 기기 안에서 한다 (글을 밖으로 보내지 않는다).
 *
 * 두 가지로 찾는다.
 *  1. 규칙: 자주 틀리는 말(되요→돼요, 몇일→며칠, 할께→할게 …)과 의존 명사 띄어쓰기(할수있다→할 수 있다 …).
 *     사전은 이런 말을 맞다고 하거나 엉뚱한 말을 권하기도 해서, 확실한 것은 규칙으로 먼저 고친다.
 *  2. 사전: Hunspell 한국어·영어 사전(spell-worker.js)에 없는 낱말에 사전이 권하는 말.
 *     사전이 권하는 말은 엉뚱한 것이 섞여 있어(예: 할수있다 → 밀수입하다), 소리가 같거나 헷갈리기 쉬운
 *     낱자 한두 개만 다른 말과 의존 명사 앞 띄어쓰기만 받는다. 사람 이름처럼 사전에 없을 뿐인 말과
 *     성경 구절의 옛말 꼴(하시니라·있나니·영혼아)은 대개 걸러진다.
 *
 * 이 파일은 화면(DOM)과 상관없는 함수만 둔다 (Node에서 그대로 시험할 수 있게).
 */

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

/** 고친 종류: 띄어쓰기만 / 문장 부호만 / 그 밖(맞춤법) */
export function spellKind(from, to) {
    const noSpace = (s) => s.replace(/\s+/g, '');
    if (noSpace(from) === noSpace(to)) return '띄어쓰기';
    const letters = (s) => s.replace(/[^\p{L}\p{N}]/gu, '');
    if (letters(from) === letters(to)) return '문장 부호';
    return '맞춤법';
}


// ─── 한글 음절 ───

const SBASE = 0xAC00, SCOUNT = 11172;
const JONG_L = 8;   // 받침 'ㄹ'의 번호

function isSyllable(ch) {
    const c = ch ? ch.charCodeAt(0) : 0;
    return c >= SBASE && c < SBASE + SCOUNT;
}

/** 받침 번호 (없으면 0) */
function jongOf(ch) {
    return isSyllable(ch) ? (ch.charCodeAt(0) - SBASE) % 28 : 0;
}

function hasJong(ch) {
    return jongOf(ch) > 0;
}

/** 'ㄹ' 받침이 있는 음절 (할·갈·먹을의 '을' …) */
function endsWithL(ch) {
    return jongOf(ch) === JONG_L;
}

// ─── 소리 나는 대로 ───
// 한국어 맞춤법 실수는 대개 소리 나는 대로 적은 것이다(감사합니다 → 감사함니다, 했다 → 햇다).
// 사전이 권한 말 가운데 틀린 말과 소리가 같은 것을 먼저 고르고, 짧은 이름 같은 말은 소리가 같을 때만 권한다.
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄱㅅ', 'ㄴ', 'ㄴㅈ', 'ㄴㅎ', 'ㄷ', 'ㄹ', 'ㄹㄱ', 'ㄹㅁ', 'ㄹㅂ', 'ㄹㅅ', 'ㄹㅌ', 'ㄹㅍ', 'ㄹㅎ', 'ㅁ', 'ㅂ', 'ㅂㅅ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 받침의 대표음 (겹받침은 앞 자음으로 본다)
const REP = { 'ㄱ': 'ㄱ', 'ㄲ': 'ㄱ', 'ㅋ': 'ㄱ', 'ㄴ': 'ㄴ', 'ㄷ': 'ㄷ', 'ㅅ': 'ㄷ', 'ㅆ': 'ㄷ', 'ㅈ': 'ㄷ', 'ㅊ': 'ㄷ', 'ㅌ': 'ㄷ', 'ㅎ': 'ㄷ', 'ㄹ': 'ㄹ', 'ㅁ': 'ㅁ', 'ㅂ': 'ㅂ', 'ㅍ': 'ㅂ', 'ㅇ': 'ㅇ' };
// 겹받침의 대표음
const DOUBLE_REP = { 'ㄱㅅ': 'ㄱ', 'ㄴㅈ': 'ㄴ', 'ㄴㅎ': 'ㄴ', 'ㄹㄱ': 'ㄱ', 'ㄹㅁ': 'ㅁ', 'ㄹㅂ': 'ㄹ', 'ㄹㅅ': 'ㄹ', 'ㄹㅌ': 'ㄹ', 'ㄹㅍ': 'ㅂ', 'ㄹㅎ': 'ㄹ', 'ㅂㅅ': 'ㅂ' };
const repOf = (j) => DOUBLE_REP[j] || REP[j] || j;
const ASPIRATE = { 'ㄱ': 'ㅋ', 'ㄷ': 'ㅌ', 'ㅈ': 'ㅊ', 'ㅂ': 'ㅍ' };
const TENSE = { 'ㄱ': 'ㄲ', 'ㄷ': 'ㄸ', 'ㅂ': 'ㅃ', 'ㅅ': 'ㅆ', 'ㅈ': 'ㅉ' };

/** 음절 → [초성, 중성, 종성] (받침이 없으면 '', 겹받침은 'ㄹㄱ'처럼 두 글자) */
function partsOf(ch) {
    const i = ch.charCodeAt(0) - SBASE;
    return [CHO[Math.floor(i / 588)], String.fromCharCode(0x314F + Math.floor((i % 588) / 28)), JONG[i % 28]];
}

/** 대략의 발음을 낱자로 (연음·받침 대표음·비음화·유음화·거센소리·된소리) */
export function pronounce(word) {
    const syl = [];
    for (const ch of word) {
        if (!isSyllable(ch)) { syl.push({ raw: ch }); continue; }
        const [c, v, j] = partsOf(ch);
        syl.push({ c, v, j });
    }
    for (let k = 0; k < syl.length; k++) {
        const s = syl[k], n = syl[k + 1];
        if (s.raw || !s.j) continue;
        let j = s.j;
        if (n && !n.raw) {
            if (n.c === 'ㅇ') {
                // 받침이 다음 음절로 넘어간다 (ㅎ은 소리 나지 않고, ㅇ은 그대로)
                if (j === 'ㅇ') continue;
                const last = j[j.length - 1];
                if (last === 'ㅎ') { s.j = ''; n.c = j.length > 1 ? j[0] : 'ㅇ'; continue; }   // 좋아 → 조아, 많이 → 마니
                s.j = j.length > 1 ? j[0] : '';
                n.c = last;
                continue;
            }
            if (j[j.length - 1] === 'ㅎ' && ASPIRATE[n.c]) { n.c = ASPIRATE[n.c]; s.j = j.length > 1 ? j[0] : ''; continue; }
            j = repOf(j);
            if (n.c === 'ㅎ' && ASPIRATE[j]) { n.c = ASPIRATE[j]; s.j = ''; continue; }
            if (n.c === 'ㄴ' || n.c === 'ㅁ') j = { 'ㄱ': 'ㅇ', 'ㄷ': 'ㄴ', 'ㅂ': 'ㅁ' }[j] || j;
            if ((j === 'ㄴ' && n.c === 'ㄹ') || (j === 'ㄹ' && n.c === 'ㄴ')) { j = 'ㄹ'; n.c = 'ㄹ'; }
            if ('ㄱㄷㅂ'.includes(j) && TENSE[n.c]) n.c = TENSE[n.c];
            s.j = j;
        } else {
            s.j = repOf(j);
        }
    }
    return syl.map(s => s.raw || s.c + s.v + s.j).join('');
}

/** 요즘 말소리로는 거의 가리지 않는 것(ㅐ·ㅔ, ㅙ·ㅚ·ㅞ, 된소리 앞의 받침)까지 같게 본 소리 — 찌게·찌개, 윗층·위층 */
function looseSound(word) {
    return pronounce(word)
        .replace(/ㄱ(?=[ㄲㅋ])|ㄷ(?=[ㄸㅆㅉㅌㅊ])|ㅂ(?=[ㅃㅍ])/g, '')
        .replace(/[ㅐㅒㅖ]/g, 'ㅔ').replace(/[ㅙㅞ]/g, 'ㅚ');
}

// 자주 헷갈려 잘못 적는 낱자 무리 [초성, 중성, 종성]. 사전이 권한 말이 이 무리 안에서만 바뀐 것이면 믿는다
// (바빳다 → 바빴다, 도데체 → 도대체, 할려고 → 하려고). '예린이가 → 어린이가', '있나니 → 있느니'처럼
// 헷갈릴 일이 없는 낱자가 바뀐 것은 사전에 없는 이름·옛말일 때가 많아 받지 않는다.
// 종성의 ''는 받침이 없는 것 (사이시옷 댓가 → 대가, 'ㄹ'을 더 쓴 할려고 → 하려고).
const MIXUPS = [
    ['ㄱㄲㅋ', 'ㄷㄸㅌ', 'ㅂㅃㅍ', 'ㅅㅆ', 'ㅈㅉㅊ', 'ㄴㄹ', 'ㅇㅎ'],
    ['ㅐㅔㅒㅖ', 'ㅚㅙㅞ', 'ㅢㅣ', 'ㅢㅡ', 'ㅢㅔ', 'ㅓㅕ', 'ㅗㅛ', 'ㅗㅜ', 'ㅓㅗ', 'ㅏㅐ', 'ㅏㅓ', 'ㅟㅣ', 'ㅜㅡ'],
    [['ㄷ', 'ㅅ', 'ㅆ', 'ㅈ', 'ㅊ', 'ㅌ', 'ㅎ'], ['ㄱ', 'ㄲ', 'ㅋ', 'ㄱㅅ', 'ㄹㄱ'], ['ㅂ', 'ㅍ', 'ㅂㅅ', 'ㄹㅂ', 'ㄹㅍ'],
        ['ㄴ', 'ㄴㅈ', 'ㄴㅎ'], ['ㄹ', 'ㄹㅂ', 'ㄹㅅ', 'ㄹㅌ', 'ㄹㅎ'], ['ㅁ', 'ㄹㅁ'], ['ㅁ', 'ㅂ'], ['', 'ㅅ'], ['', 'ㄹ']]
];
// 두 글자 이하의 말(이름일 때가 많다)에는 된소리와 사이시옷만 받는다 (지유 → 치유처럼 이름이 다른 말로 바뀌지 않게)
const MIXUPS_SHORT = [['ㄱㄲ', 'ㄷㄸ', 'ㅂㅃ', 'ㅅㅆ', 'ㅈㅉ'], [], [['', 'ㅅ']]];

/** 글자 수가 같은 두 말에서 낱자가 몇 곳 다른가 (헷갈리기 쉬운 낱자끼리가 아닌 곳이 있으면 Infinity) */
function mixupCount(x, y, groups = MIXUPS) {
    if (x.length !== y.length) return Infinity;
    let n = 0;
    for (let k = 0; k < x.length; k++) {
        if (x[k] === y[k]) continue;
        if (!isSyllable(x[k]) || !isSyllable(y[k])) return Infinity;
        const a = partsOf(x[k]), b = partsOf(y[k]);
        for (let p = 0; p < 3; p++) {
            if (a[p] === b[p]) continue;
            if (!groups[p].some(g => g.includes(a[p]) && g.includes(b[p]))) return Infinity;
            n++;
        }
    }
    return n;
}

/** 영어 낱말 사이의 거리 (글자를 넣기·빼기·바꾸기·이웃끼리 바꾸기) */
function letterDistance(x, y) {
    const a = x.toLowerCase(), b = y.toLowerCase();
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

// ─── 낱말 나누기 ───

const LETTER = /[\p{L}\p{N}]/u;

/**
 * 한 줄을 낱말(띄어쓰기 단위)로 나눈다 → [{ a, b, ca, cb, core, lang }]
 * core: 앞뒤의 문장 부호·따옴표·괄호를 뗀 부분, [ca, cb)가 그 자리.
 * lang: 'ko'(한글만), 'en'(로마자만), ''(숫자·섞인 말·한자 등 — 검사하지 않는다)
 */
export function wordsOf(text) {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
        const w = m[0];
        let s = 0, e = w.length;
        while (s < e && !LETTER.test(w[s])) s++;
        while (e > s && !LETTER.test(w[e - 1])) e--;
        const core = w.slice(s, e);
        let lang = '';
        if (/^[가-힣]+$/.test(core)) lang = 'ko';
        else if (/^[A-Za-z]+(?:['’][A-Za-z]+)*$/.test(core)) lang = 'en';
        out.push({ a: m.index, b: m.index + w.length, ca: m.index + s, cb: m.index + e, core, lang });
    }
    return out;
}

// ─── 규칙: 자주 틀리는 말 ───
// [찾을 꼴, 바꿀 말, 이유]. 낱말 하나(core)에 차례로 적용한다.
// 사전에는 맞는 말로 올라 있지만 거의 늘 틀리게 쓰인 말(되요·할께 …)도 여기서 고친다.
const SPELL_RULES = [
    [/^몇일/, '며칠', "'몇 일'이 아니라 '며칠'이 표준어입니다"],
    [/^금새$/, '금세', "'금시에'가 줄어든 말은 '금세'입니다"],
    [/^설겆이/, '설거지', "'설거지'가 표준어입니다"],
    [/^오랫만/, '오랜만', "'오래간만'이 줄어든 말은 '오랜만'입니다"],
    [/^오랜동안/, '오랫동안', "'오랫동안'이 표준어입니다"],
    [/^희안/, '희한', "'희한하다'가 표준어입니다"],
    [/^어의없/, '어이없', "'어이없다'가 표준어입니다"],
    [/^역활/, '역할', "'역할(役割)'이 표준어입니다"],
    [/^왠만/, '웬만', "'웬만하다'가 표준어입니다"],
    [/^웬지/, '왠지', "'왜인지'가 줄어든 말은 '왠지'입니다"],
    [/^왠일/, '웬일', "'어찌 된 일'을 뜻하는 말은 '웬일'입니다"],
    [/^어떻해/, '어떡해', "'어떻게 해'가 줄어든 말은 '어떡해'입니다"],
    [/^어떻하/, '어떡하', "'어떻게 하-'가 줄어든 말은 '어떡하-'입니다"],
    [/^어줍잖/, '어쭙잖', "'어쭙잖다'가 표준어입니다"],
    [/^생각컨데/, '생각건대', "'생각하건대'가 줄어든 말은 '생각건대'입니다"],
    [/^설레임/, '설렘', "'설레다'의 명사형은 '설렘'입니다"],
    [/^설레였/, '설레었', "기본형이 '설레다'라서 '설레었-'으로 씁니다"],
    [/^설레이/, '설레', "기본형이 '설레다'라서 '설레이-'로 쓰지 않습니다"],
    [/^되뇌였/, '되뇌었', "기본형이 '되뇌다'라서 '되뇌었-'으로 씁니다"],
    [/^되뇌이/, '되뇌', "기본형이 '되뇌다'라서 '되뇌이-'로 쓰지 않습니다"],
    [/^헤매였/, '헤매었', "기본형이 '헤매다'라서 '헤매었-'으로 씁니다"],
    [/^헤매이/, '헤매', "기본형이 '헤매다'라서 '헤매이-'로 쓰지 않습니다"],
    [/^목메였/, '목메었', "기본형이 '목메다'라서 '목메었-'으로 씁니다"],
    [/^목메이/, '목메', "기본형이 '목메다'라서 '목메이-'로 쓰지 않습니다"],
    [/^삼가해야/, '삼가야', "기본형이 '삼가다'라서 '삼가하다'로 쓰지 않습니다"],
    [/^삼가해서/, '삼가서', "기본형이 '삼가다'라서 '삼가하다'로 쓰지 않습니다"],
    [/^삼가해/, '삼가', "기본형이 '삼가다'라서 '삼가하다'로 쓰지 않습니다"],
    [/^삼가했/, '삼갔', "기본형이 '삼가다'라서 '삼가하다'로 쓰지 않습니다"],
    [/^삼가하/, '삼가', "기본형이 '삼가다'라서 '삼가하다'로 쓰지 않습니다"],
    [/^치뤘/, '치렀', "기본형이 '치르다'라서 '치렀다'로 씁니다"],
    [/^치뤄/, '치러', "기본형이 '치르다'라서 '치러'로 씁니다"],
    [/^치루(?=[고는다기면며지게])/, '치르', "기본형은 '치르다'입니다"],
    [/^잠궜/, '잠갔', "기본형이 '잠그다'라서 '잠갔다'로 씁니다"],
    [/^잠궈/, '잠가', "기본형이 '잠그다'라서 '잠가'로 씁니다"],
    [/^잠구(?=[고는다기면며지게])/, '잠그', "기본형은 '잠그다'입니다"],
    [/^담궜/, '담갔', "기본형이 '담그다'라서 '담갔다'로 씁니다"],
    [/^담궈/, '담가', "기본형이 '담그다'라서 '담가'로 씁니다"],
    [/^담구(?=[고는다기면며지게])/, '담그', "기본형은 '담그다'입니다"],
    [/^뵈요/, '봬요', "'뵈어요'가 줄어든 말은 '봬요'입니다"],
    [/^뵈서/, '봬서', "'뵈어서'가 줄어든 말은 '봬서'입니다"],
    [/뵜/g, '뵀', "'뵈었'이 줄어든 말은 '뵀'입니다"],
    [/됬/g, '됐', "'되었'이 줄어든 말은 '됐'입니다"],
    [/되요$/, '돼요', "'되어요'가 줄어든 말은 '돼요'입니다"],
    [/되서(요)?$/, '돼서$1', "'되어서'가 줄어든 말은 '돼서'입니다"],
    [/되야(?=해|한|할|합|하)/, '돼야 ', "'되어야'가 줄어든 말은 '돼야'이고, '-어야 하다'는 띄어 씁니다"],
    [/되야(?=$|지|겠|만|죠|요)/, '돼야', "'되어야'가 줄어든 말은 '돼야'입니다"],
    [/돼(?=고|는|니|면|며|도록|기|게|던|다가|든지|었|다$)/, '되', "'되-' 뒤에 '-어'가 오지 않으면 '되'로 씁니다"],
    [/^아니예요/, '아니에요', "'아니다' 뒤에는 '-에요'가 붙어 '아니에요'입니다"],
    [/^아니였/, '아니었', "'아니다' 뒤에는 '-었-'이 붙어 '아니었다'입니다"],
    [/^바램/, '바람', "'바라다'의 명사형은 '바람'입니다"],
    [/^구지$/, '굳이', "'굳이'가 맞는 말입니다"],
    [/^좋와/, '좋아', "'좋다'에 '-아'가 붙으면 '좋아'입니다"],
    [/^하마트면/, '하마터면', "'하마터면'이 표준어입니다"],
    [/^비로서$/, '비로소', "'비로소'가 맞는 말입니다"],
    [/^(알|걸)맞는(?=$|지|데|가)/, '$1맞은', "'알맞다·걸맞다'는 형용사라 '-은'이 붙습니다"],
    [/^귀뜸/, '귀띔', "'귀띔'이 표준어입니다"],
    [/^통채/, '통째', "'통째'가 표준어입니다"],
    [/^아둥바둥/, '아등바등', "'아등바등'이 표준어입니다"],
    [/^뒤치닥거리/, '뒤치다꺼리', "'뒤치다꺼리'가 표준어입니다"],
    [/^갯수/, '개수', "'개수(個數)'는 사이시옷을 적지 않습니다"],
    [/^촛점/, '초점', "'초점(焦點)'은 사이시옷을 적지 않습니다"],
    [/^홧병/, '화병', "'화병(火病)'은 사이시옷을 적지 않습니다"],
    [/^왠$/, '웬', "'어찌 된·어떠한'을 뜻하는 말은 '웬'입니다"],
    [/^짜집기/, '짜깁기', "'짜깁기'가 표준어입니다"],
    [/^눈꼽/, '눈곱', "'눈곱'이 표준어입니다"],
    [/^곱배기/, '곱빼기', "'곱빼기'가 표준어입니다"],
    [/^어리버리/, '어리바리', "'어리바리'가 표준어입니다"],
    [/^오도방정/, '오두방정', "'오두방정'이 표준어입니다"],
    [/^닥달/, '닦달', "'닦달'이 표준어입니다"],
    [/^수근(?=거|대|수근)/, '수군', "'수군거리다'가 표준어입니다"],
    [/^소근(?=거|대|소근)/, '소곤', "'소곤거리다'가 표준어입니다"],
    [/^움추(?=리|려|렸)/, '움츠', "기본형이 '움츠리다'입니다"],
    [/^으시대/, '으스대', "'으스대다'가 표준어입니다"],
    [/^끼여들/, '끼어들', "'끼어들다'가 표준어입니다"],
    [/^들어(?=[나났난날납])/, '드러', "'드러나다'가 표준어입니다"],
    [/^일찌기/, '일찍이', "'일찍이'가 맞는 말입니다"],
    [/^더우기/, '더욱이', "'더욱이'가 맞는 말입니다"],
    [/^깨끗히/, '깨끗이', "'깨끗하다'의 부사는 '깨끗이'입니다"],
    [/^일일히/, '일일이', "'일일이'가 맞는 말입니다"],
    [/^곰곰히/, '곰곰이', "'곰곰이'가 맞는 말입니다"],
    [/^틈틈히/, '틈틈이', "'틈틈이'가 맞는 말입니다"],
    [/^번번히/, '번번이', "'번번이'가 맞는 말입니다"],
    [/^깊숙히/, '깊숙이', "'깊숙이'가 맞는 말입니다"],
    [/^따뜻히/, '따뜻이', "'따뜻이'가 맞는 말입니다"],
    [/^가까히/, '가까이', "'가까이'가 맞는 말입니다"],
    [/^반듯히/, '반듯이', "'반듯이'가 맞는 말입니다"],
    [/^버젓히/, '버젓이', "'버젓이'가 맞는 말입니다"],
    [/^느긋히/, '느긋이', "'느긋이'가 맞는 말입니다"],
    [/^꼼꼼이/, '꼼꼼히', "'꼼꼼히'가 맞는 말입니다"],
    [/^솔직이/, '솔직히', "'솔직히'가 맞는 말입니다"],
    [/^조용이/, '조용히', "'조용히'가 맞는 말입니다"],
    [/^가만이/, '가만히', "'가만히'가 맞는 말입니다"],
    [/^않(?=하|해|했|할|한|합|함|되|돼|됐|될|된|됨|됩)/, '안 ', "'아니'가 줄어든 말은 '안'이고 뒤 말과 띄어 씁니다"],
    [/(할|볼|될|탈|잘|칠|뛸|쉴|을|올(?=려[고면]))려(?=고|면|는|던)/, (m, a) => ({ 할: '하', 볼: '보', 올: '오', 될: '되', 탈: '타', 잘: '자', 칠: '치', 뛸: '뛰', 쉴: '쉬', 을: '으' })[a] + '려',
        "'-려고'는 앞에 'ㄹ'을 더 적지 않습니다 (하려고·먹으려고)"],
];

// 'ㄹ' 받침 하나로 된 말 가운데 동사의 꼴로 흔히 쓰는 것 — '할 때', '갈 수'처럼 띄운다
// ('물때'·'술수'처럼 명사로 쓰는 말은 넣지 않는다)
const L_VERBS = new Set('할갈볼올될줄쓸잘탈칠뛸쉴울놀살알열팔걸들빌깰셀낼맬펼벌켤끌찰필'.split(''));
// 그 가운데 기본형 어간이 'ㄹ'로 끝나는 동사 — '살거라·알거든·알거니와'처럼 어미가 바로 붙는다
const L_STEMS = new Set('갈쓸줄울놀살알열팔걸들빌벌끌'.split(''));

/**
 * 의존 명사 띄어쓰기: '-ㄹ' 꼴 뒤의 의존 명사(수·거·줄·뿐·만큼·리·듯·때·텐데·뻔)는 띄어 쓴다.
 * 할수있다 → 할 수 있다, 먹을거야 → 먹을 거야, 갈때 → 갈 때 …
 * next: 다음 낱말 ('할수 있다'처럼 둘로 나뉜 경우를 보려고)
 */
function depNounSpacing(core, next) {
    for (let k = 1; k < core.length; k++) {
        const before = core[k - 1];
        if (!(endsWithL(before) || before === '을')) continue;
        if (k === 1 && !L_VERBS.has(before)) continue;
        const head = core.slice(0, k), rest = core.slice(k);
        let to = null;
        if (/^수(있|없)/.test(rest)) to = head + ' 수 ' + rest.slice(1);
        else if (/^수밖에/.test(rest)) to = head + ' ' + rest;
        else if (/^수(도|는|가|만|조차|마저|라도|야)?$/.test(rest) && /^(있|없)/.test(next || '')) to = head + ' ' + rest;
        else if (/^[거꺼](야|예요|에요|다|면|라|지|니(?!와)|요|잖|는|를|가|도|고|같|$)/.test(rest) && !(rest === '거라' && L_STEMS.has(before))) {
            to = head + ' 거' + rest.slice(1).replace(/^같/, ' 같');
        } else if (/^줄(알|몰)/.test(rest)) to = head + ' 줄 ' + rest.slice(1);
        else if (/^줄(은|을|도|이야)/.test(rest) || (rest === '줄' && /^(알|몰)/.test(next || ''))) to = head + ' ' + rest;
        else if (/^(뿐|만큼|텐데|테니|테야|테지)/.test(rest)) to = head + ' ' + rest;
        else if (/^리(없|만무)/.test(rest)) to = head + ' 리 ' + rest.slice(1);
        else if (/^리가/.test(rest)) to = head + ' ' + rest;
        else if (/^듯(이|한|하|싶|말|도|$)/.test(rest)) to = head + ' ' + rest;
        else if (/^때(는|도|에|까지|마다|면|부터|의|만|가|를|엔|쯤|$)/.test(rest) && core !== '물때') to = head + ' ' + rest;
        else if (/^뻔(했|하|한|$)/.test(rest)) to = head + ' ' + rest;
        if (to) {
            const sp = rest[0] === '꺼'
                ? "'것'을 뜻하는 '거'는 예사소리로 적고 앞말과 띄어 씁니다"
                : `'${rest.replace(/^(수|거|줄|뿐|만큼|텐데|테니|테야|테지|리|듯|때|뻔).*/, '$1')}'는 의존 명사라 앞말과 띄어 씁니다`;
            return { to, why: sp };
        }
    }
    return null;
}

/** -ㄹ께 → -ㄹ게, -ㄹ껄 → -ㄹ걸 (끝에 오는 어미) */
function willEnding(core) {
    const m = /^(.*)([께껄])(요)?$/.exec(core);
    if (!m || !m[1] || !endsWithL(m[1][m[1].length - 1])) return null;
    const fixed = m[2] === '께' ? '게' : '걸';
    return { to: m[1] + fixed + (m[3] || ''), why: `'-ㄹ${fixed}'는 예사소리로 적습니다` };
}

/**
 * 받침 있는 말 + 이에요/이었 (학생이예요 → 학생이에요, 학생이였다 → 학생이었다)
 * '고양이예요'·'계란말이였다'처럼 '이'가 명사의 끝인 경우와 글자만 보고는 구별할 수 없어,
 * 사전이 틀렸다고 할 때만 쓴다 (checkLines).
 */
export function copulaEnding(core) {
    const m = /^(.*[가-힣])이(예요|였)(.*)$/.exec(core);
    if (!m || !hasJong(m[1][m[1].length - 1])) return null;
    const to = m[1] + (m[2] === '예요' ? '이에요' : '이었') + m[3];
    return { to, why: m[2] === '예요' ? "받침 있는 말 뒤에는 '이에요'를 씁니다" : "받침 있는 말 뒤에는 '이었-'을 씁니다" };
}

/** '안되다'의 '안'을 띄운다 ('되지 않다'라는 뜻으로 쓴 경우 — '안됐다'(딱하다)처럼 한 낱말인 경우는 그대로) */
function negationSpacing(core) {
    if (!/^안(되|돼|됩|될)/.test(core) || /^안(됐|된|되다$)/.test(core)) return null;
    return { to: '안 ' + core.slice(1), why: "'되지 않다'라는 뜻이면 '안 되다'로 띄어 씁니다" };
}

/**
 * 낱말 하나에 규칙을 적용한다 → { to, whys } (고칠 것이 없으면 null)
 * prev·next: 앞뒤 낱말 (맥락이 필요한 규칙에 쓴다)
 */
export function fixKoreanWord(core, prev, next) {
    let cur = core;
    const whys = [];
    const apply = (r) => { if (r && r.to !== cur) { cur = r.to; if (!whys.includes(r.why)) whys.push(r.why); } };
    for (const [re, rep, why] of SPELL_RULES) {
        const out = cur.replace(re, rep);
        if (out !== cur) apply({ to: out, why });
    }
    apply(willEnding(cur));
    // 띄어쓰기는 낱말을 나누므로 마지막에, 나뉜 뒤의 첫 부분에만 적용한다
    if (!/\s/.test(cur)) apply(depNounSpacing(cur, next));
    if (!/\s/.test(cur)) apply(negationSpacing(cur));
    else {
        const [first, ...restParts] = cur.split(' ');
        const n = negationSpacing(first);
        if (n) apply({ to: [n.to, ...restParts].join(' '), why: n.why });
    }
    // '다행이 큰 병은 아니었다'처럼 부사로 쓴 '다행이' → '다행히' ('다행이 아니다'는 그대로)
    if (cur === '다행이' && next && !/^아니/.test(next)) apply({ to: '다행히', why: "부사는 '다행히'로 씁니다" });
    // '-길 바래요' → '-길 바라요' (빛이 바래다는 그대로 둔다)
    if (/^바(래|랬)/.test(cur) && /(기를|길|기|기만|기도|기는)$/.test(prev || '')) {
        apply({ to: cur.replace(/^바래/, '바라').replace(/^바랬/, '바랐'), why: "'바라다'가 기본형이라 '바라요·바랐다'로 씁니다" });
    }
    return cur === core ? null : { to: cur, whys };
}

/**
 * 두 낱말에 걸친 규칙 — [{ i, j, to, why }] (words[i]의 core 처음부터 words[j]의 core 끝까지를 to로)
 *  - 몇 일 → 며칠
 *  - 그리고 나서 → 그러고 나서
 *  - 할 수록 → 할수록 ('-ㄹ수록'은 어미라 붙여 씀)
 */
export function pairRules(words) {
    const out = [];
    for (let j = 1; j < words.length; j++) {
        const p = words[j - 1], w = words[j];
        if (p.lang !== 'ko' || w.lang !== 'ko') continue;
        if (p.b !== p.cb || w.a !== w.ca) continue;   // 사이에 문장 부호가 있으면 건너뛴다
        if (p.core === '몇') {
            const m = /^일(이|을|은|간|째|동안|만에|부터|까지|에|이나|이면|이라도|도)?$/.exec(w.core);
            if (m) out.push({ i: j - 1, j, to: '며칠' + (m[1] || ''), why: "'몇 일'이 아니라 '며칠'이 표준어입니다" });
        } else if (p.core === '그리고' && /^나(서|니|면|자)/.test(w.core)) {
            out.push({ i: j - 1, j, to: '그러고 ' + w.core, why: "'그렇게 하고 나서'라는 뜻이면 '그러고 나서'입니다" });
        } else if (w.core === '수록' && endsWithL(p.core[p.core.length - 1])) {
            out.push({ i: j - 1, j, to: p.core + '수록', why: "'-ㄹ수록'은 앞말에 붙여 씁니다" });
        }
    }
    return out;
}

// ─── 사전이 권하는 말 고르기 ───

// 사전이 띄어 쓰라고 권할 때 받는 것
//  - 의존 명사(것·수·때 …) 앞: 앞말이 '-ㄴ·-ㄹ'로 끝날 때만 (먹을때 → 먹을 때, 하는척 → 하는 척)
//  - '하다·되다' 꼴 앞: 앞말이 부사(다시·많이 …)이거나 '-게'로 끝날 때만 (다시했다 → 다시 했다)
// '잠잠하라 → 잠잠 하라', '구역모임 → 구역 모임'처럼 한 낱말이나 붙여 써도 되는 말을 쪼개는 제안은 받지 않는다.
// ('뿐·만큼'은 명사 뒤에서는 붙여 쓰는 조사라 넣지 않는다 — '기도뿐이다'는 맞는 말)
const DEP_NOUN = /^(것|거|수|줄|데|때|리|듯|척|체|텐|테|터|뻔|적|바)/;
const HA_FORM = /^(해|하|했|할|한|함|합|돼|되|됐|된|될|됩)/;
const ADVERBS = new Set(['다시', '많이', '먼저', '빨리', '천천히', '미리', '계속', '꼭', '또', '열심히', '조금', '좀']);
const JONG_N = 4;   // 받침 'ㄴ'의 번호

function splitOk(head, tail) {
    if (head === '못' || head === '안') return true;
    if (DEP_NOUN.test(tail)) return head.length >= 2 && [JONG_N, JONG_L].includes(jongOf(head[head.length - 1]));
    if (HA_FORM.test(tail)) return ADVERBS.has(head) || /게$/.test(head);
    return false;
}

/**
 * 한국어 낱말에 사전이 권한 말 가운데 믿을 만한 것 하나 (없으면 null)
 *  - 띄어쓰기: splitOk에 맞는 것만
 *  - 철자: 틀린 말과 소리가 같은 것을 먼저 고르고, 그 밖에는 헷갈리기 쉬운 낱자(MIXUPS)만 바뀐 것을 받는다
 *    (한 곳, 다섯 글자 넘는 말은 두 곳까지). 조사를 떼면 두 글자 이하인 말(이름·땅 이름이 많다)은
 *    조사는 그대로 두고 소리가 같거나 된소리·사이시옷만 다른 것만 받는다.
 */
export function pickKorean(word, suggestions) {
    for (const s of suggestions) {
        if (s.replace(/\s+/g, '') !== word) continue;
        const parts = s.split(/\s+/);
        if (parts.length === 2 && splitOk(parts[0], parts[1])) return s;
    }
    const stem = nounStem(word);
    const ending = word.slice(stem.length);
    const short = (stem !== word && stem.length <= 2) || word.length <= 2;
    const limit = word.length >= 5 ? 2 : 1;
    const sound = pronounce(word), loose = looseSound(word);
    let best = null;
    suggestions.forEach((s, order) => {
        if (/\s/.test(s)) return;   // 띄우면서 글자까지 바꾸는 제안은 믿기 어렵다
        const same = pronounce(s) === sound;
        const alike = same || looseSound(s) === loose;
        let score;
        if (short) {
            // 민준이 → 민주니처럼 조사까지 바꾸는 것은 받지 않는다
            if (!s.endsWith(ending)) return;
            if (alike) score = (same ? 0 : 50) + order;
            else if (mixupCount(word, s, MIXUPS_SHORT) === 1) score = 100 + order;
            else return;
        } else {
            const n = mixupCount(word, s);
            if (alike) score = (same ? 0 : 50) + order;
            else if (n <= limit) score = 100 + n * 10 + order;
            else return;
        }
        if (!best || score < best.score) best = { s, score };
    });
    return best ? best.s : null;
}

// 성경 구절·기도문의 옛말 꼴(하소서·없으리로다·하시니라 …) — 사전에 없어도 고치라고 하지 않는다
const ARCHAIC = new RegExp('(' + ['소서', '나이다', '로다', '도다', '노라', '리라', '니라', '지어다', '찌어다', '더라', '시니', '옵고',
    '옵시며', '옵시고', '사옵', '시옵', '지라', '리니', '이니', '시라', '하사', '시사', '으사', '리이까', '니이까', '나이까', '오리까',
    '소이다', '나니', '노니', '니이다', '지이다', '리요', '리오', '[으이시하되르]매', '지니', '사오며', '사오니', '사오매', '사오나',
    '[인런]즉', '진대', '하라'].join('|') + ')$');

/** 영어 낱말에 사전이 권한 말 가운데 믿을 만한 것 하나 */
export function pickEnglish(word, suggestions) {
    // 따옴표만 다른 제안이 있으면 그것 (dont → don't)
    const bare = (x) => x.replace(/['’]/g, '').toLowerCase();
    const same = suggestions.find(s => bare(s) === bare(word));
    if (same) return same;
    // 두 낱말로 나누는 제안은 받지 않는다 (wonderfull → wonder full). 흔한 경우는 EN_SPLIT에서 고친다
    const limit = word.length >= 7 ? 2 : 1;
    for (const s of suggestions) {
        if (!/\s/.test(s) && letterDistance(word, s) <= limit) return s;
    }
    return null;
}

// 붙여 쓴 영어 (alot → a lot …)
const EN_SPLIT = { alot: 'a lot', incase: 'in case', eachother: 'each other', infact: 'in fact', atleast: 'at least',
    aswell: 'as well', noone: 'no one', everytime: 'every time', thankyou: 'thank you', alright: null };

/** 이 영어 낱말을 검사할까? — 대문자로만 쓴 말(QT·CCM)·문장 가운데의 대문자 이름은 건너뛴다 */
function checkEnglish(w, text) {
    const c = w.core;
    if (c.length < 3 || c === c.toUpperCase()) return false;
    if (/[A-Z]/.test(c.slice(1))) return false;
    if (/^[A-Z]/.test(c)) {
        const before = text.slice(0, w.a).replace(/\s+$/, '');
        if (before && !/[.!?。]$/.test(before)) return false;   // 문장 처음이 아니면 이름으로 본다
    }
    return true;
}

/**
 * 줄들을 검사한다.
 * lines: [{ id, text }]
 * dict.lookup({ ko: [낱말], en: [낱말] }) → { ko: { 낱말: null(맞음) | [권하는 말] }, en: {…} }
 * skip(낱말): 검사하지 않을 말인가 (사용자가 사전에 넣은 말 등)
 * → [{ id, a, b, from, to, type, why, word, src: 'rule'|'dict' }] (a, b: 그 줄에서의 위치)
 */
export async function checkLines(lines, dict, { skip = () => false } = {}) {
    const fixes = [];
    const ask = { ko: new Set(), en: new Set() };
    const later = [];   // 규칙으로 고치지 않은 낱말 — 사전에 물은 뒤 처리한다
    for (const line of lines) {
        const text = line.text;
        const words = wordsOf(text);
        const used = new Set();
        for (const r of pairRules(words)) {
            if (used.has(r.i) || used.has(r.j)) continue;
            const a = words[r.i].ca, b = words[r.j].cb;
            fixes.push({ id: line.id, a, b, from: text.slice(a, b), to: r.to, type: spellKind(text.slice(a, b), r.to), why: r.why, src: 'rule' });
            used.add(r.i); used.add(r.j);
        }
        words.forEach((w, i) => {
            if (used.has(i) || !w.lang || skip(w.core)) return;
            if (w.lang === 'ko') {
                const r = fixKoreanWord(w.core, words[i - 1] && words[i - 1].core, words[i + 1] && words[i + 1].core);
                if (r) {
                    fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to: r.to, type: spellKind(w.core, r.to), why: r.whys.join(' · '), src: 'rule' });
                    return;
                }
                if (w.core.length < 2 || ARCHAIC.test(w.core)) return;   // 한 글자 낱말·옛말 꼴은 사전에 묻지 않는다
                ask.ko.add(w.core);
                later.push({ line, w, lang: 'ko', alt: copulaEnding(w.core) });
            } else if (EN_SPLIT[w.core.toLowerCase()]) {
                let to = EN_SPLIT[w.core.toLowerCase()];
                if (/^[A-Z]/.test(w.core)) to = to[0].toUpperCase() + to.slice(1);
                fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to, type: '띄어쓰기', why: '두 낱말로 띄어 씁니다', src: 'rule' });
            } else if (checkEnglish(w, text)) {
                const q = w.core.replace(/’/g, "'");
                ask.en.add(q);
                later.push({ line, w, lang: 'en', q });
            }
        });
    }
    if (later.length) {
        const res = await dict.lookup({ ko: [...ask.ko], en: [...ask.en] });
        for (const { line, w, lang, q, alt } of later) {
            const sugs = lang === 'ko' ? res.ko && res.ko[w.core] : res.en && res.en[q];
            if (!sugs) continue;   // 사전에 있는 말
            if (alt) {
                fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to: alt.to, type: spellKind(w.core, alt.to), why: alt.why, src: 'rule' });
                continue;
            }
            let to = lang === 'ko' ? pickKorean(w.core, sugs) : pickEnglish(q, sugs);
            if (!to) continue;     // 믿을 만한 제안이 없다 — 이름 등 사전에 없을 뿐인 말로 본다
            if (lang === 'en' && w.core.includes('’')) to = to.replace(/'/g, '’');
            const type = spellKind(w.core, to);
            const why = type === '띄어쓰기' ? '앞말과 띄어 써야 합니다' : lang === 'ko' ? '사전에 없는 말입니다' : '영어 사전에 없는 말입니다';
            fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to, type, why, word: w.core, src: 'dict' });
        }
    }
    fixes.sort((x, y) => x.id - y.id || x.a - y.a);
    return fixes;
}

// ─── 사전 다루기 (spell-worker.js가 쓴다. Node 시험에서도 같은 함수를 쓴다) ───

// 사용자가 '사전에 추가'한 말에서 조사를 떼어 낼 때 쓰는 조사들 (긴 것부터)
const PARTICLES = ['으로부터', '에서부터', '에게서', '한테서', '이라도', '이라고', '께서는', '에서는', '에게는', '으로는',
    '처럼', '보다', '에서', '에게', '한테', '께서', '으로', '까지', '부터', '이랑', '이나', '하고', '마저', '조차', '밖에', '라도', '라고',
    '을', '를', '이', '가', '은', '는', '의', '에', '께', '와', '과', '도', '만', '로', '랑'];

/** 조사를 뗀 말 (조사가 없으면 그대로) — '지민이와' → '지민이' */
export function nounStem(word) {
    for (const p of PARTICLES) if (word.length > p.length + 1 && word.endsWith(p)) return word.slice(0, -p.length);
    return word;
}

/**
 * 한국어 사전에 말을 더한다. 사전은 낱자로 풀어(NFD) 저장되어 있어 그 꼴로 넣어야 한다.
 * 사전에 있는 보기 말과 같은 성질로 넣어서 조사·어미가 붙은 꼴도 맞다고 보게 한다.
 *  - nouns: 명사 (받침 있으면 '사람', 없으면 '사과'처럼) — 여호와께서·시편을
 *  - verbs: '-하다' 동사 ('공부하다'처럼) — 합력하여·큐티했다
 *  - adjectives: '-하다' 형용사 ('행복하다'처럼) — 성결한·성결하게
 *  - exact: 그 꼴 그대로
 * dict: { add(word), addWithAffix(word, example) }
 */
export function addKoreanWords(dict, { nouns = [], verbs = [], adjectives = [], exact = [] }) {
    const nfd = (w) => w.normalize('NFD');
    const hangul = (w) => /^[가-힣]+$/.test(w);
    for (const w of nouns) if (hangul(w)) dict.addWithAffix(nfd(w), nfd(hasJong(w[w.length - 1]) ? '사람' : '사과'));
    for (const w of verbs) if (hangul(w)) dict.addWithAffix(nfd(w), nfd('공부하다'));
    for (const w of adjectives) if (hangul(w)) dict.addWithAffix(nfd(w), nfd('행복하다'));
    for (const w of exact) if (hangul(w)) dict.add(nfd(w));
}

// 보조 용언을 붙여 쓴 말 (만들어준·먹어봤다 — 띄어 쓰는 것이 원칙이지만 붙여 써도 된다)
const AUX_HEAD = /^(주|준|줄|줍|줬|줘|드리|드려|드린|드릴|드렸|드립|보|본|볼|봐|봤|봅|두|둔|둘|둬|뒀|놓|놔|놨|버리|버린|버릴|버려|버렸|가|간|갈|갔|오|온|올|와|왔|내|낸|낼|냈|대|댄|댔|싶|있|계)/;
const AUX_LEFT = /[아어여워와해돼줘봐둬놔워야]$/;
function attachedAux(dict, w) {
    for (let k = 2; k < w.length; k++) {
        const left = w.slice(0, k), right = w.slice(k);
        if (AUX_LEFT.test(left) && AUX_HEAD.test(right) && dict.spell(left) && dict.spell(right)) return true;
    }
    return false;
}

// 사전이 잘 모르는 조사 꼴 — 떼어 보고 앞말이 맞으면 맞는 말로 본다 ('기도뿐이다', '너만큼은', '아버지께로')
const LOOSE_PARTICLES = /(뿐이다|뿐이야|뿐이에요|뿐이었다|뿐인|뿐만|뿐|만큼은|만큼|처럼|조차|마저|밖에|이라도|라도|나마|께로부터|에게로부터|께로|에게로|한테로)$/;

/** 명사인가 — 목적격 조사를 붙여 보아 사전에 있으면 명사로 본다 ('그래를'·'좋아를'은 없다) */
function isNoun(dict, w) {
    return dict.spell(w + (hasJong(w[w.length - 1]) ? '을' : '를'));
}

// 부르는 말 — 영혼아·형제들아·아버지여·하나님이여 (사전은 '-아·-여'를 모른다)
const VOCATIVE = /^(.+?)(들)?(아|야|여|이여|이시여)$/;
// 명사 + '-시요' — '주는 나의 피난처시요 힘이시요' (옛 성경 말투)
const HONORIFIC_YO = /^(.+?)(이)?시요$/;

/** 사전에는 없지만 명사에 부르는 말·'-시요'가 붙은 꼴인가 (한 글자 명사는 '되여'처럼 틀린 말과 헷갈려 빼되, '-들아'·'-이시요'는 받는다) */
function nounWithEnding(dict, q) {
    const v = VOCATIVE.exec(q);
    if (v && (v[1].length >= 2 || v[2]) && isNoun(dict, v[1])) return true;
    const h = HONORIFIC_YO.exec(q);
    return !!h && (h[1].length >= 2 || h[2]) && isNoun(dict, h[1]);
}

/** 낱말마다 사전에 있는지 보고, 없으면 권하는 말을 받는다 → { 낱말: null | [권하는 말] } */
export function lookupWords(dict, words, onEach) {
    const out = {};
    for (const w of words) {
        const q = w.normalize('NFC');
        // '팀장님께'처럼 직함에 '님'을 붙인 말은 '님'을 떼고 맞으면 맞는 말로 본다
        const ok = dict.spell(q) || (/님/.test(q) && q.length > 2 && dict.spell(q.replace(/님/, '')))
            || (/^[가-힣]+$/.test(q) && attachedAux(dict, q))
            || (LOOSE_PARTICLES.test(q) && q.replace(LOOSE_PARTICLES, '').length >= 1 && dict.spell(q.replace(LOOSE_PARTICLES, '')))
            || (/^[가-힣]+$/.test(q) && nounWithEnding(dict, q));
        out[w] = ok ? null : dict.suggest(q);
        if (onEach) onEach();
    }
    return out;
}
