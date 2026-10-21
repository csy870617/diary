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
const JONG_N = 4;   // 받침 'ㄴ'의 번호

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

/** 따옴표로 묶은 말 + 은·는 ('것'은, '수'는) */
function topic(word) {
    return `'${word}'${hasJong(word[word.length - 1]) ? '은' : '는'}`;
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
// 두 글자 이하의 말(이름·줄임말이 많다)에는 사이시옷을 뺀 것만 받는다 (지유 → 치유, 인싸 → 인사처럼 바꾸지 않게)
const MIXUPS_SHORT = [[], [], [['', 'ㅅ']]];

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
// 틀린 꼴이 다른 뜻의 맞는 말일 수도 있는 것(일부로·들렸다·놀랬다 …)은 넣지 않는다.
const SPELL_RULES = [
    [/^몇일/, '며칠', "'몇 일'이 아니라 '며칠'이 표준어입니다"],
    [/^몇칠/, '며칠', "'며칠'이 표준어입니다"],
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
    [/^왠$/, '웬', "'어찌 된·어떠한'을 뜻하는 말은 '웬'입니다"],
    [/^어떻해/, '어떡해', "'어떻게 해'가 줄어든 말은 '어떡해'입니다"],
    [/^어떻하/, '어떡하', "'어떻게 하-'가 줄어든 말은 '어떡하-'입니다"],
    [/^어떡게/, '어떻게', "'어떠하게'가 줄어든 말은 '어떻게'입니다"],
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
    [/^짜집기/, '짜깁기', "'짜깁기'가 표준어입니다"],
    [/^눈쌀/, '눈살', "'눈살'이 표준어입니다"],
    [/^떡볶기/, '떡볶이', "'떡볶이'가 표준어입니다"],
    [/^(있|없)슴$/, '$1음', "'-음'으로 끝맺습니다 (있음·없음)"],
    [/슴니(다|까)$/, '습니$1', "'-습니다'가 맞는 말입니다"],
    // 받침 뒤의 '-읍니다'만 옛 맞춤법이다 (있읍니다 → 있습니다). '모으다 → 모읍니다'처럼 어간이 '으'로 끝나면 맞는 말
    [/([가-힣])읍니(다|까)$/, (m, a, b) => (hasJong(a) ? a + '습니' + b : m), "받침 뒤에서는 '-습니다'가 맞는 말입니다"],
    [/^(배게|배개|베게)(?=를|가|는|에|도|만|위|커버|속|$)/, '베개', "'베개'가 표준어입니다"],
    [/^쉽상/, '십상', "'십상(十常)'이 맞는 말입니다"],
    [/^희노애락/, '희로애락', "'희로애락(喜怒哀樂)'이 맞는 말입니다"],
    [/^어짜피/, '어차피', "'어차피(於此彼)'가 맞는 말입니다"],
    [/^서슴치/, '서슴지', "기본형이 '서슴다'라서 '서슴지'로 씁니다"],
    [/^제작년(?!도)/, '재작년', "'재작년(再昨年)'이 맞는 말입니다"],
    [/^해매(?=[다고는며어었이지게])/, '헤매', "'헤매다'가 표준어입니다"],
    [/^내노라/, '내로라', "'내로라하다'가 표준어입니다"],
    [/^(개구|멋|겁|욕심|고집|수다|거짓말|심술|허풍|깍|변덕|주정|트집|말썽|게으름)장이/, '$1쟁이', "'-장이'는 기술자에게만 쓰고, 그 밖에는 '-쟁이'로 씁니다"],
    [/^(그|이|저)(사람|친구|아이|애들|남자|여자|말씀|책|영화)(?=$|[이가을를은는도만의에과와])/, '$1 $2', "'그·이·저'는 뒷말과 띄어 씁니다"],
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
    [/스런$/, '스러운', "'-스럽다'는 '-스러운'으로 씁니다 (자연스러운·사랑스러운)"],
    [/십시요$/, '십시오', "'-십시오'가 맞는 말입니다"],
    [/^(어디|뭐|무엇|무엇이|누구|언제)던지$/, '$1든지', "'무엇이든 가리지 않음'을 나타낼 때는 '-든지'를 씁니다"],
    [/^않(?=하|해|했|할|한|합|함|되|돼|됐|될|된|됨|됩)/, '안 ', "'아니'가 줄어든 말은 '안'이고 뒤 말과 띄어 씁니다"],
    [/(할|볼|될|탈|잘|칠|뛸|쉴|을|올(?=려[고면]))려(?=고|면|는|던)/, (m, a) => ({ 할: '하', 볼: '보', 올: '오', 될: '되', 탈: '타', 잘: '자', 칠: '치', 뛸: '뛰', 쉴: '쉬', 을: '으' })[a] + '려',
        "'-려고'는 앞에 'ㄹ'을 더 적지 않습니다 (하려고·먹으려고)"],
];

// 부사의 '-이·-히' — 틀린 꼴 그대로 쓴 때만 고친다 ('굳히다'·'열심이다'·'조심이 필요하다'는 그대로)
const ADVERB_FIXES = {
    깨끗히: '깨끗이', 일일히: '일일이', 곰곰히: '곰곰이', 틈틈히: '틈틈이', 번번히: '번번이', 깊숙히: '깊숙이', 따뜻히: '따뜻이',
    가까히: '가까이', 반듯히: '반듯이', 버젓히: '버젓이', 느긋히: '느긋이', 수북히: '수북이', 깊히: '깊이', 높히: '높이',
    많히: '많이', 같히: '같이', 굳히: '굳이',
    꼼꼼이: '꼼꼼히', 솔직이: '솔직히', 조용이: '조용히', 가만이: '가만히', 당연이: '당연히', 정확이: '정확히', 확실이: '확실히',
    분명이: '분명히', 충분이: '충분히', 천천이: '천천히', 간단이: '간단히', 특별이: '특별히', 꾸준이: '꾸준히', 대단이: '대단히',
    상당이: '상당히', 철저이: '철저히', 편안이: '편안히', 나란이: '나란히', 촘촘이: '촘촘히', 쓸쓸이: '쓸쓸히',
};

function adverbFix(core) {
    const m = /^(.+?)(도)?$/.exec(core);
    const to = m && ADVERB_FIXES[m[1]];
    if (!to) return null;
    return { to: to + (m[2] || ''), why: `'${to}'가 맞는 말입니다 (부사의 '-이·-히')` };
}

// 'ㄹ' 받침 하나로 된 말 가운데 동사의 꼴로 흔히 쓰는 것 — '할 때', '갈 수'처럼 띄운다
// ('물때'·'술수'처럼 명사로 쓰는 말은 넣지 않는다)
const L_VERBS = new Set('할갈볼올될줄쓸잘탈칠뛸쉴울놀살알열팔걸들빌깰셀낼맬펼벌켤끌찰필'.split(''));
// 그 가운데 기본형 어간이 'ㄹ'로 끝나는 동사 — '살거라·알거든·알거니와'처럼 어미가 바로 붙는다
const L_STEMS = new Set('갈쓸줄울놀살알열팔걸들빌벌끌'.split(''));
// '-ㄹ 것'처럼 보이지만 한 낱말인 명사
const GEOT_NOUNS = new Set(['탈것', '들것', '날것', '물것']);

/**
 * 의존 명사 띄어쓰기: '-ㄹ' 꼴 뒤의 의존 명사(수·것·거·줄·뿐·만큼·리·듯·때·텐데·뻔)는 띄어 쓴다.
 * ('하늘만큼'처럼 명사 뒤의 '만큼·뿐'은 조사라 붙여 쓴다 — 'ㄹ' 받침 명사와 헷갈리므로 여러 글자 앞말은 사전으로 가린다)
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
        else if (/^것(이|은|을|도|만|에|처럼|보다|부터|까지|같|$)/.test(rest) && !GEOT_NOUNS.has(head + '것')) {
            to = head + ' 것' + rest.slice(1).replace(/^같/, ' 같');
        } else if (/^[거꺼](야|예요|에요|다|면|라|지|니(?!와)|요|잖|는|를|가|도|고|같|$)/.test(rest) && !(rest === '거라' && L_STEMS.has(before))) {
            to = head + ' 거' + rest.slice(1).replace(/^같/, ' 같');
        } else if (/^줄(알|몰)/.test(rest)) to = head + ' 줄 ' + rest.slice(1);
        else if (/^줄(은|을|도|이야)/.test(rest) || (rest === '줄' && /^(알|몰)/.test(next || ''))) to = head + ' ' + rest;
        else if (/^(텐데|테니|테야|테지)/.test(rest) || (k === 1 && /^(뿐|만큼)/.test(rest))) to = head + ' ' + rest;
        else if (/^리(없|만무)/.test(rest)) to = head + ' 리 ' + rest.slice(1);
        else if (/^리가/.test(rest)) to = head + ' ' + rest;
        else if (/^듯(이|한|하|싶|말|도|$)/.test(rest)) to = head + ' ' + rest;
        else if (/^때(는|도|에|까지|마다|면|부터|의|만|가|를|엔|쯤|$)/.test(rest) && core !== '물때') to = head + ' ' + rest;
        else if (/^뻔(했|하|한|$)/.test(rest)) to = head + ' ' + rest;
        if (to) {
            const sp = rest[0] === '꺼'
                ? "'것'을 뜻하는 '거'는 예사소리로 적고 앞말과 띄어 씁니다"
                : `${topic(rest.replace(/^(수|것|거|줄|뿐|만큼|텐데|테니|테야|테지|리|듯|때|뻔).*/, '$1'))} 의존 명사라 앞말과 띄어 씁니다`;
            return { to, why: sp };
        }
    }
    return null;
}

// 늘 띄어 쓰는 보조 용언·의존 명사 (붙여 쓰는 것을 허용하지 않는 것만) — [꼴, 이유, 한 낱말이라 빼는 꼴]
const AUX_SPLITS = [
    [/^(.+지)(않|못|마$|마요$|마라$|마세요$|마십시오$|말고|말아|말자|말라|맙시다|말길|말기를|말았)/,
        "'-지 않다·못하다·말다'는 앞말과 띄어 씁니다", /^(마지않|못지않|머지않|마지못)/],
    [/^(.+고)(싶|있|계시|계신|계셨|계십|계세|나서|나니|나면|나자|보니|보면|말았|말겠)/,
        "'-고' 뒤의 '싶다·있다·나다·보다·말다'는 띄어 씁니다", /고말고$/],
    [/^(.+게)(되|돼|됐|된|될|됨|됩|하|해|했|한|할|함|합|만들|만드|만든)/, "'-게 되다·-게 하다'는 띄어 씁니다", null],
    [/^(.+기)(위해|위하여|위한|위함|전에|전까지|전부터|시작|싫|힘들|힘든|힘듭|쉬워|쉬운|쉽|어려|어렵|나름|마련|일쑤|십상)/,
        "'-기' 뒤의 말은 띄어 씁니다", null],
    [/^(.+?)(때문)/, "'때문'은 의존 명사라 앞말과 띄어 씁니다", null],
];

/** 보조 용언·의존 명사 띄어쓰기 (먹고싶다 → 먹고 싶다, 하지마 → 하지 마, 너때문에 → 너 때문에) */
function auxSpacing(core) {
    for (const [re, why, except] of AUX_SPLITS) {
        if (except && except.test(core)) continue;
        const m = re.exec(core);
        if (m) return { to: m[1] + ' ' + core.slice(m[1].length), why };
    }
    // 것 같다·거 같다 (할것같다 → 할 것 같다, 그거같아 → 그거 같아)
    const g = /^(.*?)([것거])같(?=[이은다아았던네지게고으습])/.exec(core);
    if (g) {
        const head = g[1], adn = head && [JONG_N, JONG_L].includes(jongOf(head[head.length - 1]));
        return { to: (adn ? head + ' ' : head) + g[2] + ' ' + core.slice(g[0].length - 1), why: "'같다'는 앞말과 띄어 씁니다" };
    }
    // -어야 하다 (가야한다 → 가야 한다)
    for (let k = 1; k < core.length - 1; k++) {
        if (core[k] !== '야' || !/^(하|해|했|한|할|함|합|돼|되|됐|된|될|됨|됩)/.test(core.slice(k + 1))) continue;
        const [, v, j] = partsOf(core[k - 1]);
        if (!j && 'ㅏㅓㅕㅐㅘㅝㅙㅔ'.includes(v)) return { to: core.slice(0, k + 1) + ' ' + core.slice(k + 1), why: "'-어야 하다'는 띄어 씁니다" };
    }
    return countSpacing(core);
}

// 수를 나타내는 말 + 단위 (두개 → 두 개, 여러가지 → 여러 가지). '한번·한가지·한군데·한잔'처럼 한 낱말인 것은 뺀다
const COUNT = /^(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|열한|열두|스무|몇|여러|서너|두세|첫)(개월|가지|번째|번|개|명|사람|군데|차례|마리|시간|달|살|권|잔|장|분|가족)(?=$|[이가을를은는도만씩째의에과와로나])/;
const COUNT_ONE_WORD = /^(한(번|가지|군데|차례|잔|가족|분)(?!째)|여러분|첫(?!번째))/;

function countSpacing(core) {
    if (COUNT_ONE_WORD.test(core)) return null;
    const m = COUNT.exec(core);
    if (!m) return null;
    return { to: m[1] + ' ' + core.slice(m[1].length), why: '수를 나타내는 말과 단위는 띄어 씁니다' };
}

/** -ㄹ께 → -ㄹ게, -ㄹ껄 → -ㄹ걸 (끝에 오는 어미) */
function willEnding(core) {
    const m = /^(.*)([께껄])(요)?$/.exec(core);
    if (!m || !m[1] || !endsWithL(m[1][m[1].length - 1])) return null;
    const fixed = m[2] === '께' ? '게' : '걸';
    return { to: m[1] + fixed + (m[3] || ''), why: `${topic('-ㄹ' + fixed)} 예사소리로 적습니다` };
}

/** '-하지'에서 '하'가 줄면 'ㄱ·ㄷ·ㅂ' 받침 소리 뒤에서는 '-지'로 적는다 (생각치 않게 → 생각지 않게, 익숙치 → 익숙지) */
function chiToJi(core, next) {
    const m = /^(.+)치(않|못)?(.*)$/.exec(core);
    if (!m || (!m[2] && (m[3] || !/^(않|못)/.test(next || '')))) return null;
    const j = partsOf(m[1][m[1].length - 1])[2];
    if (!j || !['ㄱ', 'ㄷ', 'ㅂ'].includes(repOf(j)) || j === 'ㅎ') return null;
    return { to: m[1] + '지' + (m[2] || '') + m[3], why: "'-하지'의 '하'가 줄면 '-지'로 적습니다 (생각지·익숙지)" };
}

/** -ㄹ런지 → -ㄹ는지 (올런지 → 올는지) */
function lRunji(core) {
    const k = core.indexOf('런지');
    if (k < 1 || !endsWithL(core[k - 1])) return null;
    return { to: core.slice(0, k) + '는지' + core.slice(k + 2), why: "'-ㄹ는지'가 맞는 말입니다" };
}

/** 율·률 — 앞 글자에 받침이 없거나 'ㄴ' 받침이면 '율', 그 밖에는 '률' (비율·환율·합격률) */
function rateSuffix(core) {
    const m = /^(.*[가-힣])(율|률)(이|은|을|도|만|의|과|로|에|이다|이었다|이야|이에요|이고)?$/.exec(core);
    if (!m) return null;
    const j = jongOf(m[1][m[1].length - 1]);
    const right = j === 0 || j === JONG_N ? '율' : '률';
    if (right === m[2]) return null;
    return { to: m[1] + right + (m[3] || ''), why: "앞 글자에 받침이 없거나 'ㄴ' 받침이면 '율', 그 밖에는 '률'로 적습니다" };
}

/**
 * 받침 있는 말 + 이에요/이었/이어서 (학생이예요 → 학생이에요, 학생이였다 → 학생이었다)
 * '고양이예요'·'계란말이였다'처럼 '이'가 명사의 끝인 경우와 글자만 보고는 구별할 수 없어,
 * 사전이 틀렸다고 할 때만 쓴다 (checkLines).
 */
export function copulaEnding(core) {
    const m = /^(.*[가-힣])이(예요|였|여서|여도|여야)(.*)$/.exec(core);
    if (!m || !hasJong(m[1][m[1].length - 1])) return null;
    const fixed = { 예요: '이에요', 였: '이었', 여서: '이어서', 여도: '이어도', 여야: '이어야' }[m[2]];
    const past = m[2] === '였';
    return { to: m[1] + fixed + m[3], why: `받침 있는 말 뒤에는 '${fixed}${past ? '-' : ''}'${past ? '을' : '를'} 씁니다` };
}

/** '안되다'의 '안'을 띄운다 ('되지 않다'라는 뜻으로 쓴 경우 — '안됐다'(딱하다)처럼 한 낱말인 경우는 그대로) */
function negationSpacing(core) {
    if (!/^안(되|돼|됩|될)/.test(core) || /^안(됐|된|되다$)/.test(core)) return null;
    return { to: '안 ' + core.slice(1), why: "'되지 않다'라는 뜻이면 '안 되다'로 띄어 씁니다" };
}

/** 한 낱말 안의 띄어쓰기를 차례로 고친다 (먹고싶지않다 → 먹고 싶지 않다) → { parts, whys } */
function spaceWord(word, next) {
    let parts = [word];
    const whys = [];
    for (let round = 0; round < 4; round++) {
        let changed = false;
        const out = [];
        parts.forEach((p, i) => {
            const r = depNounSpacing(p, i === parts.length - 1 ? next : parts[i + 1]) || auxSpacing(p) || negationSpacing(p);
            if (r) {
                out.push(...r.to.split(' '));
                if (!whys.includes(r.why)) whys.push(r.why);
                changed = true;
            } else out.push(p);
        });
        parts = out;
        if (!changed) break;
    }
    return { parts, whys };
}

/**
 * 낱말 하나에 규칙을 적용한다 → { to, whys } (고칠 것이 없으면 null)
 * prev·next: 앞뒤 낱말 (맥락이 필요한 규칙에 쓴다)
 */
export function fixKoreanWord(core, prev, next) {
    let cur = core;
    const whys = [];
    const apply = (r) => {
        if (!r || r.to === cur) return;
        cur = r.to;
        for (const y of [].concat(r.whys || r.why)) if (y && !whys.includes(y)) whys.push(y);
    };
    for (const [re, rep, why] of SPELL_RULES) {
        const out = cur.replace(re, rep);
        if (out !== cur) apply({ to: out, why });
    }
    if (!/\s/.test(cur)) {
        apply(adverbFix(cur));
        apply(chiToJi(cur, next));
        apply(willEnding(cur));
        apply(lRunji(cur));
        apply(rateSuffix(cur));
    }
    // 띄어쓰기는 낱말을 나누므로 마지막에 (이미 나뉜 꼴이면 그 조각마다)
    const pieces = cur.split(' ');
    const spaced = pieces.map((p, i) => spaceWord(p, i === pieces.length - 1 ? next : pieces[i + 1]));
    if (spaced.some(s => s.parts.length > 1)) apply({ to: spaced.map(s => s.parts.join(' ')).join(' '), whys: spaced.flatMap(s => s.whys) });
    // '다행이 큰 병은 아니었다'처럼 부사로 쓴 '다행이' → '다행히' ('다행이 아니다'는 그대로)
    if (cur === '다행이' && next && !/^아니/.test(next)) apply({ to: '다행히', why: "부사는 '다행히'로 씁니다" });
    // '-길 바래요' → '-길 바라요' (빛이 바래다는 그대로 둔다)
    if (/^바(래|랬)/.test(cur) && /(기를|길|기|기만|기도|기는)$/.test(prev || '')) {
        apply({ to: cur.replace(/^바래/, '바라').replace(/^바랬/, '바랐'), why: "'바라다'가 기본형이라 '바라요·바랐다'로 씁니다" });
    }
    return cur === core ? null : { to: cur, whys };
}

// 늘 앞말에 붙여 쓰는 조사·접미사 (나 처럼 → 나처럼, 3시 까지 → 3시까지, 우리 끼리 → 우리끼리)
const BOUND = /^(처럼|부터|까지|에게서|에게|에서부터|에서|으로서|으로써|으로부터|으로|로서|로써|한테서|한테|께서|끼리|쯤|짜리|어치)(은|는|도|만|요|이|가|을|를|의|라도|이나|나|에|에서|이다|이야|이에요|예요|입니다)?$/;
// '씩'은 수량 뒤에서만 붙인다 ('씩 웃었다'는 그대로)
const COUNTABLE = /^([0-9]+.*|하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|조금|몇|한두|두세|서너|.*(개|명|번|장|권|잔|마리|시간|분|쪽|줄|그릇|사람|가지|개월|주|달|일|년))$/;
// '째'는 단위 뒤에서만 붙인다
const ORDINAL_UNIT = /(번|개|명|주|일|달|년|해|날|잔|그릇|권|장|시간|차례|바퀴)$/;
// '-지 않다'를 '-지 안다'로 쓴 것 (먹지 안았다 → 먹지 않았다)
const NOT_AN = /^안(?=았|아|다|고|는|으|을|은|게|기|지|도|네|니|습|죠|잖|겠)/;
// '-ㄴ 지 (오래)': 지난 동안을 나타내는 '지'는 띄어 쓴다 (결혼한지 10년 → 결혼한 지 10년)
const DURATION = /^(([0-9]+|[일이삼사오육칠팔구십백]+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|몇|수십|수)(년|해|달|개월|주|주일|일|날|시간|분|초)|며칠|오래(?=되|됐|된|다|이다|야|예요|입니다)|벌써|어느덧|어언)/;
// '-ㄴ지'가 어미인 흔한 말 (누군지 몰라 · 어떤지 궁금해) — 뒤에 때를 나타내는 말이 와도 띄우지 않는다
const WHETHER = /(어떤지|누군지|뭔지|왠지|웬지|인지|건지|던지|는지)$/;

/**
 * 두 낱말에 걸친 규칙 — [{ i, j, to, why, valid?, invalid? }] (words[i]의 core 처음부터 words[j]의 core 끝까지를 to로)
 * valid·invalid가 있으면 사전에서 그 말이 각각 있고·없을 때만 고친다.
 *  - 몇 일 → 며칠, 그리고 나서 → 그러고 나서, 할 수록 → 할수록, 수 밖에 → 수밖에
 *  - 나 처럼 → 나처럼 (늘 붙여 쓰는 조사), 하나 씩 → 하나씩
 *  - 먹지 안았다 → 먹지 않았다, 결혼한지 10년 → 결혼한 지 10년, 가던지 말던지 → 가든지 말든지
 *  - the the → the
 */
export function pairRules(words) {
    const out = [];
    for (let j = 1; j < words.length; j++) {
        const p = words[j - 1], w = words[j];
        if (p.b !== p.cb || w.a !== w.ca) continue;   // 사이에 문장 부호가 있으면 건너뛴다
        const push = (to, why) => out.push({ i: j - 1, j, to, why });
        if (p.lang === 'en' && w.lang === 'en') {
            if (p.core.toLowerCase() === w.core.toLowerCase() && EN_DUP.has(w.core.toLowerCase())) push(p.core, '같은 낱말을 두 번 썼습니다');
            continue;
        }
        if (w.lang === 'ko' && p.core && BOUND.test(w.core) && p.lang !== 'en') { push(p.core + w.core, `${topic(w.core.replace(BOUND, '$1'))} 앞말에 붙여 씁니다`); continue; }
        if (w.lang === 'ko' && /^씩(은|만|이라도)?$/.test(w.core) && COUNTABLE.test(p.core)) { push(p.core + w.core, "'-씩'은 앞말에 붙여 씁니다"); continue; }
        if (w.lang === 'ko' && /^째(로|는|도|야)?$/.test(w.core) && ORDINAL_UNIT.test(p.core)) { push(p.core + w.core, "'-째'는 앞말에 붙여 씁니다"); continue; }
        if (p.lang === 'ko' && /[가-힣]지$/.test(p.core) && jongOf(p.core[p.core.length - 2]) === JONG_N && !WHETHER.test(p.core)
            && DURATION.test(w.core)) {
            out.push({ i: j - 1, j, to: p.core.slice(0, -1) + ' 지 ' + w.core, why: "지난 동안을 나타내는 '지'는 의존 명사라 띄어 씁니다",
                valid: [p.core.slice(0, -1)], invalid: [p.core] });
            continue;
        }
        if (p.lang !== 'ko' || w.lang !== 'ko') continue;
        if (p.core === '몇') {
            const m = /^일(이|을|은|간|째|동안|만에|부터|까지|에|이나|이면|이라도|도)?$/.exec(w.core);
            if (m) push('며칠' + (m[1] || ''), "'몇 일'이 아니라 '며칠'이 표준어입니다");
        } else if (p.core === '그리고' && /^나(서|니|면|자)/.test(w.core)) {
            push('그러고 ' + w.core, "'그렇게 하고 나서'라는 뜻이면 '그러고 나서'입니다");
        } else if (w.core === '수록' && endsWithL(p.core[p.core.length - 1])) {
            push(p.core + '수록', "'-ㄹ수록'은 앞말에 붙여 씁니다");
        } else if (p.core === '수' && /^밖에(는|도)?$/.test(w.core)) {
            push('수' + w.core, "'밖에'는 조사라 앞말에 붙여 씁니다");
        } else if (/지$/.test(p.core) && p.core.length >= 2 && NOT_AN.test(w.core)) {
            push(p.core + ' 않' + w.core.slice(1), "'-지 않다'의 '않-'은 '아니하-'가 줄어든 말입니다");
        } else if (/던지$/.test(p.core) && /^말던지/.test(w.core)) {
            push(p.core.replace(/던지$/, '든지') + ' ' + w.core.replace(/^말던지/, '말든지'), "고르는 뜻일 때는 '-든지'를 씁니다");
        }
    }
    return out;
}

// 성경 구절·기도문의 옛말 꼴(하소서·없으리로다·하시니라 …) — 사전에 없어도 고치라고 하지 않는다
const ARCHAIC = new RegExp('(' + ['소서', '나이다', '로다', '도다', '노라', '리라', '니라', '지어다', '찌어다', '더라', '시니', '옵고',
    '옵시며', '옵시고', '사옵', '시옵', '지라', '리니', '이니', '시라', '하사', '시사', '으사', '리이까', '니이까', '나이까', '오리까',
    '소이다', '나니', '노니', '니이다', '지이다', '리요', '리오', '[으이시하되르]매', '지니', '사오며', '사오니', '사오매', '사오나',
    '[인런]즉', '진대', '하라'].join('|') + ')$');

// ─── 영어 ───

// 붙여 쓴 영어 (alot → a lot …)
const EN_SPLIT = { alot: 'a lot', incase: 'in case', eachother: 'each other', infact: 'in fact', atleast: 'at least',
    aswell: 'as well', noone: 'no one', everytime: 'every time', thankyou: 'thank you', alright: null };
// 글자만 보고 고칠 수 있는 것 (나를 뜻하는 i는 늘 대문자)
const EN_FIX = { i: 'I', "i'm": "I'm", "i've": "I've", "i'll": "I'll", "i'd": "I'd", im: "I'm", ive: "I've", cant: "can't", wont: "won't" };
// 두 번 겹쳐 쓰면 거의 늘 실수인 짧은 말 (the the)
const EN_DUP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'for', 'with', 'and', 'my']);
// 사전에 없지만 고치지 않는 말 (줄임말·인터넷 말·한국 음식 이름 …)
const EN_SKIP = new Set(('lol lmao lmfao rofl omg omw btw idk tbh imo imho fyi asap brb ttyl thx pls plz ok okay yay haha hahaha hehe '
    + 'hmm hmmm umm uhh ugh wow yep yup nope yeah gonna wanna gotta kinda sorta lemme gimme vlog vlogs vlogger kpop kdrama '
    + 'oppa unnie hyung noona kimchi bibimbap bulgogi tteokbokki soju makgeolli ramyeon hanbok aegyo daebak hwaiting mukbang '
    + 'selfie selfies hashtag emoji emojis wifi bday bff tho cuz').split(' '));

/** 영어 낱말에 사전이 권한 말 가운데 흔한 오타 꼴로 고친 것 하나 (확실하지 않으면 null) */
export function pickEnglish(word, suggestions) {
    // 줄임말에 작은따옴표만 빠뜨린 것 (dont → don't)
    const bare = (x) => x.replace(/['’]/g, '');
    const quoted = suggestions.find(s => /'/.test(s) && !/['’]/.test(word) && bare(s).toLowerCase() === word.toLowerCase());
    if (quoted) return matchCase(word, quoted);
    const w = word.toLowerCase();
    if (w.length < 4) return null;   // 짧은 말은 줄임말·이름이 많아 고치지 않는다
    for (const s of suggestions) {
        if (/[\s-]/.test(s) || s.toLowerCase() === w) continue;
        const t = s.toLowerCase();
        // 첫 글자가 다르면 다른 말로 본다 (vlog → clog). 앞 두 글자가 바뀐 것(hte → the)만 받는다
        if (t[0] !== w[0] && !(t[0] === w[1] && t[1] === w[0])) continue;
        const d = letterDistance(w, t);
        const collapse = (x) => x.replace(/(.)\1+/g, '$1');
        if ((d === 1 && (w.length >= 5 || typoLike(w, t))) || (d === 2 && w.length >= 8 && letterDistance(collapse(w), collapse(t)) <= 1)) return matchCase(word, s);
    }
    return null;
}

/** 네 글자 낱말의 흔한 오타: 이웃 글자 바뀜·겹글자·모음 하나 */
function typoLike(a, b) {
    if (a.length === b.length) {
        const diff = [...a].map((ch, i) => ch !== b[i] ? i : -1).filter(i => i >= 0);
        if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
        return diff.length === 1 && /[aeiou]/.test(a[diff[0]]) && /[aeiou]/.test(b[diff[0]]);
    }
    const [long, short] = a.length > b.length ? [a, b] : [b, a];
    for (let i = 0; i < long.length; i++) {
        if (long.slice(0, i) + long.slice(i + 1) === short) return i > 0 && long[i] === long[i - 1];
    }
    return false;
}

/** 원래 낱말이 대문자로 시작하면 고친 말도 대문자로 */
function matchCase(word, s) {
    return /^[A-Z]/.test(word) && /^[a-z]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s;
}

/** 영어 고친 곳의 이유 */
function englishWhy(from, to) {
    if (/'/.test(to) && !/['’]/.test(from)) return "줄여 쓴 말에는 작은따옴표(')를 씁니다";
    const a = from.toLowerCase(), b = to.toLowerCase();
    if (a.length !== b.length) return a.length > b.length ? '글자를 더 썼습니다' : '글자를 빠뜨렸습니다';
    return '철자가 틀렸습니다';
}

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
 * dict.lookup({ ko: [낱말], en: [낱말] }) → { ko: { 낱말: 판정 }, en: {…} }
 *   판정: null(사전에 있는 말) | false(사전에 없지만 고칠 말을 확실히 모른다 — 이름 등) | { to, why }
 * skip(낱말): 검사하지 않을 말인가 (사용자가 사전에 넣은 말 등)
 * → [{ id, a, b, from, to, type, why, word, src: 'rule'|'dict' }] (a, b: 그 줄에서의 위치)
 */
export async function checkLines(lines, dict, { skip = () => false } = {}) {
    const fixes = [];
    const ask = { ko: new Set(), en: new Set() };
    const later = [];   // 규칙으로 고치지 않은 낱말 — 사전에 물은 뒤 처리한다
    const checked = [];   // 사전으로 확인한 뒤에 고칠 두 낱말 규칙
    for (const line of lines) {
        const text = line.text;
        const words = wordsOf(text);
        const code = (text.match(/[{};=<>|&]|=>|\(\)/g) || []).length >= 3;   // 프로그램 코드처럼 보이는 줄의 영어는 검사하지 않는다
        const used = new Set();
        for (const r of pairRules(words)) {
            if (used.has(r.i) || used.has(r.j)) continue;
            const a = words[r.i].ca, b = words[r.j].cb;
            const fix = { id: line.id, a, b, from: text.slice(a, b), to: r.to, type: spellKind(text.slice(a, b), r.to), why: r.why, src: 'rule' };
            if (r.valid || r.invalid) {
                [...(r.valid || []), ...(r.invalid || [])].forEach(x => ask.ko.add(x));
                checked.push({ fix, valid: r.valid || [], invalid: r.invalid || [] });
            } else fixes.push(fix);
            used.add(r.i); used.add(r.j);
        }
        words.forEach((w, i) => {
            if (used.has(i) || !w.lang || skip(w.core)) return;
            if (/:\/\/|www\.|@/.test(text.slice(w.a, w.b))) return;   // 주소·전자우편
            if (w.lang === 'ko' && w.core.length >= 3 && /^[일이삼사오육칠팔구십백천만억조]+$/.test(w.core)) return;   // 한자어 수 (백이십만)
            const rule = (to, why, type) => fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to, type: type || spellKind(w.core, to), why, src: 'rule' });
            if (w.lang === 'ko') {
                const r = fixKoreanWord(w.core, words[i - 1] && words[i - 1].core, words[i + 1] && words[i + 1].core);
                if (r) { rule(r.to, r.whys.join(' · ')); return; }
                if (w.core.length < 2 || ARCHAIC.test(w.core)) return;   // 한 글자 낱말·옛말 꼴은 사전에 묻지 않는다
                ask.ko.add(w.core);
                later.push({ line, w, lang: 'ko', alt: copulaEnding(w.core) });
                return;
            }
            const low = w.core.toLowerCase();
            const fix = EN_FIX[low.replace(/’/g, "'")];
            // 홀로 쓴 'i'는 앞뒤에 영어 낱말이 있을 때만 '나'로 본다 (목록의 i 같은 것은 그대로)
            const inEnglish = [words[i - 1], words[i + 1]].some(n => n && n.lang === 'en' && n.core.length >= 2);
            if (fix && w.core.replace(/’/g, "'") !== fix && (low !== 'i' || inEnglish)) {
                const to = fix[0] === 'I' ? fix : matchCase(w.core, fix);
                rule(w.core.includes('’') ? to.replace(/'/g, '’') : to, fix[0] === 'I' ? "'나'를 뜻하는 I는 늘 대문자로 씁니다" : englishWhy(w.core, to));
            } else if (EN_SPLIT[low]) {
                let to = EN_SPLIT[low];
                if (/^[A-Z]/.test(w.core)) to = to[0].toUpperCase() + to.slice(1);
                rule(to, '두 낱말로 띄어 씁니다', '띄어쓰기');
            } else if (!code && !EN_SKIP.has(low) && checkEnglish(w, text)) {
                const q = w.core.replace(/’/g, "'");
                ask.en.add(q);
                later.push({ line, w, lang: 'en', q });
            }
        });
    }
    if (later.length || checked.length) {
        const res = await dict.lookup({ ko: [...ask.ko], en: [...ask.en] });
        const known = (x) => res.ko && res.ko[x] === null;
        for (const c of checked) if (c.valid.every(known) && !c.invalid.some(known)) fixes.push(c.fix);
        for (const { line, w, lang, q, alt } of later) {
            const d = lang === 'ko' ? res.ko && res.ko[w.core] : res.en && res.en[q];
            if (d === null || d === undefined) continue;   // 사전에 있는 말
            if (alt) {
                fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to: alt.to, type: spellKind(w.core, alt.to), why: alt.why, src: 'rule' });
                continue;
            }
            if (!d) continue;   // 사전에 없지만 확실히 고칠 말이 없다 — 이름 등은 그대로 둔다
            const to = lang === 'en' && w.core.includes('’') ? d.to.replace(/'/g, '’') : d.to;
            fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to, type: spellKind(w.core, to), why: d.why, word: w.core, src: 'dict' });
        }
    }
    fixes.sort((x, y) => x.id - y.id || x.a - y.a);
    return fixes;
}

// ─── 사전 다루기 (spell-worker.js가 쓴다. Node 시험에서도 같은 함수를 쓴다) ───

// 조사 (긴 것부터) — 사용자가 '사전에 추가'한 말에서 떼어 내고, 이름처럼 짧은 말인지 볼 때 쓴다
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

// 사전이 잘 모르는 조사 꼴 — 떼어 보고 앞말이 명사이면 맞는 말로 본다 ('기도뿐이다', '너만큼은', '아버지께로')
// ('원하는만큼'처럼 꾸며 주는 말 뒤의 '만큼·뿐'은 의존 명사라 띄어 써야 하므로 받지 않는다)
const LOOSE_PARTICLES = /(뿐이다|뿐이야|뿐이에요|뿐이었다|뿐인|뿐만|뿐|만큼은|만큼|처럼|조차|마저|밖에|이라도|라도|나마|께로부터|에게로부터|께로|에게로|한테로)$/;

/** 명사인가 — '의'와 '을·를'을 붙여 보아 둘 다 사전에 있으면 명사로 본다 ('그래의'·'먹었을의'는 없다) */
function isNoun(dict, w) {
    return !!w && dict.spell(w + '의') && dict.spell(w + (hasJong(w[w.length - 1]) ? '을' : '를'));
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

/** 사전에 있는 말로 볼까 (조사·부르는 말·직함의 '님'·붙여 쓴 보조 용언까지 헤아린다) */
function knownKorean(dict, q) {
    return dict.spell(q) || (/님/.test(q) && q.length > 2 && dict.spell(q.replace(/님/, '')))
        || attachedAux(dict, q)
        || (LOOSE_PARTICLES.test(q) && isNoun(dict, q.replace(LOOSE_PARTICLES, '')))
        || nounWithEnding(dict, q);
}

// ─── 사전에 없는 한국어 낱말 고치기 ───
// 사전에 없는 말이라고 다 고치지 않는다. 자주 틀리는 꼴(띄어쓰기·헷갈리는 낱자·소리 나는 대로 적은 것)로
// 고쳐 본 말이 사전에 있고, 그런 말이 하나뿐일 때만 고친다. 이름·새 낱말처럼 그냥 사전에 없는 말은 그대로 둔다.

// 띄어 써야 하는 앞말 (사전으로 확인한 뒤 띄운다)
// ('한'은 성씨와 헷갈려 빼고 '한개·한명'처럼 흔한 것만 규칙(countSpacing)으로 고친다 — 한가인·한지수)
const NUM_DET = new Set(['두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '스무', '몇', '여러', '서너', '두세', '첫', '몇몇']);
const TIME_DET = new Set(['이번', '다음', '저번', '지지난', '다다음', '오늘', '내일', '어제', '모레', '그저께', '엊그제']);
// ('이·전'은 성씨, '그·저'는 외래어(그레이스·저스틴)와 헷갈려 넣지 않는다)
const DET1 = new Set(['새', '헌', '옛', '각', '온', '매', '첫']);
const ADVERBS = new Set(['다시', '많이', '너무', '정말', '진짜', '아주', '매우', '같이', '함께', '먼저', '빨리', '천천히', '미리', '계속',
    '열심히', '조금', '항상', '자주', '가끔', '벌써', '이미', '아직', '이제', '모두', '서로', '혼자', '일찍', '늦게', '오래', '제일', '가장',
    '별로', '전혀', '결코', '절대', '아마', '혹시', '분명히', '정말로', '무척', '몹시', '굉장히', '그냥', '바로', '이렇게', '그렇게',
    '어떻게', '너무나', '조금씩', '얼른', '어서', '마침내', '드디어', '겨우', '또다시', '오랫동안']);
const ADVERBS1 = new Set(['잘', '더', '덜', '또', '다', '꼭', '좀', '참', '늘', '곧', '막', '꽉', '쭉', '푹']);
// '-ㄴ·-ㄹ' 꼴 뒤에 띄어 쓰는 의존 명사 (+ 조사)
const ADN_DEP = /^(것|거|게|걸|건|수|줄|데|때|땐|리|듯|척|체|채|텐|테|터|뻔|적|바|김|겸|중|후|뒤|전|날|길|곳|분|일|말|집|쪽|편|자|대로|만큼|동안|다음|대신|덕분|덕|탓|순간|무렵|사이|이상|이후|이전|정도|경우|가운데|동시|마당|셈|따름|나름|모양|뿐|둥)(이|가|을|를|은|는|도|만|에|에서|에는|에도|으로|로|이다|이야|야|이에요|예요|이었|였|입니다|이라|라|처럼|까지|부터|마다|엔|이나|나|과|와|의|이고|고|이지|지)?$/;
// 꾸며 주는 말 뒤에 띄어 쓸 한 글자 명사 ('하는대'의 '대'처럼 어미와 헷갈리는 글자는 넣지 않는다)
const ONE_NOUNS = new Set('꽃 옷 집 책 밥 물 차 길 날 말 일 곳 손 발 눈 코 입 귀 몸 맘 산 강 땅 별 달 해 빛 꿈 돈 글 빵 떡 술 약 방 문 잠 쌀 국 컵 표 뜻 힘 맛 멋 짐 옆 앞 뒤 위 밑 속 끝 숲 섬 개 소 닭 새 잎 풀 비 옷 신 펜 컵'.split(' '));
// 명사 뒤에 띄어 쓰는 말 (+ 조사). 한 글자인 '후·전·중·뒤'는 이름(지후·민중)과 헷갈려 '-에·-이다' 같은 꼴일 때만
const NOUN_DEP = /^((때문|동안|대신|덕분|이후|이전|무렵|가운데)(이|가|을|를|은|는|도|만|에|에는|에도|으로|로|이다|이야|이에요|예요|입니다|까지|부터|이라|라|엔)?|(후|전|중|뒤)(에|에는|에도|에야|으로|로|부터|까지|엔|이다|이었다|이야|이라|인데|이에요|입니다))$/;

/** 낱말 앞쪽의 명사 (조사를 떼어 명사인 것) — '개를' → '개', '사람이' → '사람' */
function nounPart(dict, w) {
    for (let k = w.length; k >= 1; k--) {
        const stem = w.slice(0, k), rest = w.slice(k);
        if (rest && !PARTICLE_TAIL.test(rest)) continue;
        if (isNoun(dict, stem)) return stem;
    }
    return '';
}
const PARTICLE_TAIL = /^(이|가|을|를|은|는|도|만|의|에|에서|에게|께|와|과|로|으로|랑|이랑|하고|까지|부터|마다|보다|처럼|이나|나|이든|든|이라도|라도|이야|야|이다|다|이에요|예요|이었다|였다|이고|고|이며|며|요|이요|에는|에도|에만|에서는|에서도|으로는|로는|까지는|부터는|이었|였|입니다)+$/;

/** 띄어 쓴 두 조각이 무슨 까닭으로 띄어야 하는지 → { why, rank } (띄울 까닭이 없으면 null) */
function splitReason(dict, head, tail) {
    const last = head[head.length - 1];
    const adnominal = [JONG_N, JONG_L].includes(jongOf(last));
    const tailNoun = () => nounPart(dict, tail);
    if (head === '안' || head === '못') {
        if (!isNoun(dict, tail) && !tailNoun()) return { why: `'${head}'은 뒷말과 띄어 씁니다`, rank: 5 };
        return null;
    }
    if (adnominal && head.length >= 2 && !isNoun(dict, head)) {
        const m = ADN_DEP.exec(tail);
        if (m) return { why: `${topic(m[1])} 앞말과 띄어 씁니다`, rank: 4 };
        const n = tailNoun();
        if (n.length >= 2 || ONE_NOUNS.has(n)) return { why: '꾸며 주는 말과 꾸밈을 받는 말은 띄어 씁니다', rank: 3 };
    }
    if (NUM_DET.has(head)) {
        if (tailNoun()) return { why: '수를 나타내는 말과 단위는 띄어 씁니다', rank: 4 };
        return null;
    }
    const nd = NOUN_DEP.exec(tail);
    if (nd && head.length >= 2 && (isNoun(dict, head) || nounPart(dict, head))) return { why: `${topic(nd[2] || nd[4])} 앞말과 띄어 씁니다`, rank: 3 };
    if (TIME_DET.has(head) && tailNoun()) return { why: '때를 나타내는 말은 띄어 씁니다', rank: 3 };
    if (DET1.has(head) && tailNoun().length >= 2) return { why: '꾸며 주는 말과 꾸밈을 받는 말은 띄어 씁니다', rank: 3 };
    // 부사 + 뒷말 (너무좋아 → 너무 좋아). 조사·'이다'가 붙은 꼴(정말요·별로야·아직이면·지금까지)은 그대로
    const predicate = tail.length >= 2 && !PARTICLE_TAIL.test(tail) && !/^(이|인|입|일|예|였)/.test(tail);
    if (ADVERBS.has(head) && predicate) return { why: '꾸며 주는 말(부사)은 뒷말과 띄어 씁니다', rank: 2 };
    if (ADVERBS1.has(head) && predicate && !isNoun(dict, tail) && !tailNoun()) return { why: '꾸며 주는 말(부사)은 뒷말과 띄어 씁니다', rank: 2 };
    return null;
}

/** 한 곳을 띄워 앞뒤가 모두 사전에 있고 띄울 까닭이 있는 것 → { to, why } (어느 곳인지 하나로 정해지지 않으면 null) */
function splitFix(dict, q) {
    const found = [];
    for (let k = 1; k < q.length; k++) {
        const head = q.slice(0, k), tail = q.slice(k);
        if (!dict.spell(head) || !knownKorean(dict, tail)) continue;
        const r = splitReason(dict, head, tail);
        if (r) found.push({ to: head + ' ' + tail, ...r });
    }
    if (!found.length) return null;
    const top = Math.max(...found.map(f => f.rank));
    const best = found.filter(f => f.rank === top);
    return best.length === 1 ? { to: best[0].to, why: best[0].why } : null;
}

const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const VOWEL_SETS = ['ㅐㅔ', 'ㅒㅖ', 'ㅙㅚㅞ'];

/** [초성, 중성, 종성] → 음절 */
function compose([c, v, j]) {
    return String.fromCharCode(SBASE + (CHO.indexOf(c) * 21 + JUNG.indexOf(v)) * 28 + JONG.indexOf(j));
}

/**
 * 틀리게 적은 꼴을 바로잡은 후보들 → Map(후보 → 종류)
 *  - 'mix': 헷갈리기 쉬운 낱자 한 곳 (바빳다 → 바빴다, 도데체 → 도대체, 댓가 → 대가)
 *  - 'vowels': ㅐ·ㅔ(ㅙ·ㅚ·ㅞ)를 여러 곳 함께 (배게 → 베개)
 *  - 'move': 받침을 다음 글자로 넘겨 적은 것 (건들이다 → 건드리다). 거꾸로 당기는 것(이미 → 임이)은 이름·조사와 헷갈려 만들지 않는다
 *  - 'gem': 받침 소리를 다음 글자에 겹쳐 적은 것 (떡볶기 → 떡볶이, 있슴 → 있음)
 */
function koreanCandidates(word) {
    const syl = [...word].map(partsOf);
    const out = new Map();
    const put = (parts, kind) => {
        const s = parts.map(compose).join('');
        if (s !== word && !out.has(s)) out.set(s, kind);
    };
    const copy = () => syl.map(x => x.slice());
    syl.forEach((s, k) => {
        for (let p = 0; p < 3; p++) {
            for (const g of MIXUPS[p]) {
                if (!g.includes(s[p])) continue;
                for (const alt of g) {
                    if (alt === s[p]) continue;
                    const t = copy();
                    t[k][p] = alt;
                    put(t, 'mix');
                }
            }
        }
    });
    // ㅐ·ㅔ 등을 여러 곳 함께 바꾼 것 (네 곳까지)
    const pos = syl.map((s, k) => (VOWEL_SETS.some(g => g.includes(s[1])) ? k : -1)).filter(k => k >= 0);
    if (pos.length >= 2 && pos.length <= 4) {
        const walk = (i, t) => {
            if (i === pos.length) { put(t, 'vowels'); return; }
            for (const v of VOWEL_SETS.find(g => g.includes(syl[pos[i]][1]))) {
                const u = t.map(x => x.slice());
                u[pos[i]][1] = v;
                walk(i + 1, u);
            }
        };
        walk(0, copy());
    }
    for (let k = 0; k + 1 < syl.length; k++) {
        const a = syl[k], b = syl[k + 1];
        const last = a[2] ? a[2][a[2].length - 1] : '';
        if (a[2] && b[0] === 'ㅇ' && last !== 'ㅇ' && last !== 'ㅎ' && CHO.includes(last)) {
            const t = copy();
            t[k][2] = a[2].length > 1 ? a[2][0] : '';
            t[k + 1][0] = last;
            put(t, 'move');
        }
        if (a[2] && b[0] !== 'ㅇ' && MIXUPS[0].some(g => g.includes(b[0]) && g.includes(last))) {
            const t = copy();
            t[k + 1][0] = 'ㅇ';
            put(t, 'gem');
        }
    }
    return out;
}

/** 받침이 없던 글자에 받침을 더했나 */
function addsFinal(word, cand) {
    return [...word].some((ch, k) => ch !== cand[k] && !partsOf(ch)[2] && partsOf(cand[k])[2]);
}

/** 무엇을 잘못 적었는지 */
function mistakeWhy(word, to, kind) {
    if (kind === 'vowels') return "'ㅐ'와 'ㅔ'처럼 소리가 비슷한 모음을 헷갈렸습니다";
    if (kind === 'move') return '받침을 잘못 나누어 적었습니다';
    if (kind === 'gem') return '받침 소리를 다음 글자에 겹쳐 적었습니다';
    for (let k = 0; k < word.length; k++) {
        if (word[k] === to[k]) continue;
        const a = partsOf(word[k]), b = partsOf(to[k]);
        if (a[2] !== b[2]) {
            if (!a[2] || !b[2]) {
                const j = a[2] || b[2];
                if (j === 'ㅅ') return a[2] ? '사이시옷을 적지 않는 말입니다' : '사이시옷을 적어야 합니다';
                if (j === 'ㄹ') return a[2] ? "'ㄹ'을 더 적었습니다" : "'ㄹ'을 빠뜨렸습니다";
            }
            return '받침을 잘못 적었습니다';
        }
        if (a[0] !== b[0]) {
            if ('ㄴㄹ'.includes(a[0]) && 'ㄴㄹ'.includes(b[0])) return "'ㄴ'과 'ㄹ'을 헷갈렸습니다";
            if ('ㅇㅎ'.includes(a[0]) && 'ㅇㅎ'.includes(b[0])) return "'ㅇ'과 'ㅎ'을 헷갈렸습니다";
            return '예사소리·된소리·거센소리를 헷갈렸습니다';
        }
        if ('ㅐㅔㅒㅖ'.includes(a[1]) && 'ㅐㅔㅒㅖ'.includes(b[1])) return `'${a[1]}'가 아니라 '${b[1]}'로 적습니다`;
        if ('ㅚㅙㅞ'.includes(a[1]) && 'ㅚㅙㅞ'.includes(b[1])) return `'${a[1]}'가 아니라 '${b[1]}'로 적습니다`;
        return '모음을 잘못 적었습니다';
    }
    return '소리 나는 대로 잘못 적었습니다';
}

// 받침을 옮긴 결과 끝 글자가 조사처럼 되는 것(구글 → 국을, 들여쓸 → 들였을)은 받지 않는다
const PARTICLE_SYL = new Set('이을를은는의에와과도로가나랑만'.split(''));

/** 글자 수가 같은 두 말에서 바뀐 낱자들 → [{ k: 몇째 글자, p: 0 초성·1 중성·2 종성, from, to }] */
function slotDiffs(word, cand) {
    const out = [];
    for (let k = 0; k < word.length; k++) {
        if (word[k] === cand[k]) continue;
        const a = partsOf(word[k]), b = partsOf(cand[k]);
        for (let p = 0; p < 3; p++) if (a[p] !== b[p]) out.push({ k, p, from: a[p], to: b[p] });
    }
    return out;
}

/**
 * 사전에 없는 말을 이렇게 고쳐도 될까 — 잘 알려진 틀림 꼴만 믿는다.
 * 사전에 없는 말에는 외래어·새 낱말·한자어 합성어(재시도·리스너·붙여넣기)가 많아, 비슷한 다른 말로 바꾸면 안 된다.
 *  - 소리가 같은 것(감사함니다 → 감사합니다): 받침을 옮겨 끝 글자가 조사처럼 되는 것(구글 → 국을)만 빼고 믿는다
 *  - 요즘 소리로는 같은 것(찌게 → 찌개): 첫 글자의 모음을 바꾸는 것(재시도 → 제시도, 엑셀 → 액셀)은 믿지 않는다
 *  - 소리가 달라지는 것: 모음 조화(바뻐서 → 바빠서)와 사이시옷(장마비 → 장맛비, 머릿말 → 머리말)만 믿는다
 */
function trusted(word, cand, kind, rank) {
    if (kind === 'move' || kind === 'gem') {
        const lastChanged = word[word.length - 1] !== cand[cand.length - 1];
        return word.length >= 3 && !(lastChanged && PARTICLE_SYL.has(cand[cand.length - 1]));
    }
    const diffs = slotDiffs(word, cand);
    if (rank === 3) return true;
    if (rank === 2) return !diffs.some(d => d.p === 1 && d.k === 0);
    if (diffs.length !== 1) return false;
    const d = diffs[0];
    // 모음 조화: 'ㅏ·ㅗ' 뒤의 '-어'를 '-아'로 (바뻐서 → 바빠서, 아펐다 → 아팠다)
    if (d.p === 1) return d.k >= 1 && d.from === 'ㅓ' && d.to === 'ㅏ' && 'ㅏㅗㅑ'.includes(partsOf(word[d.k - 1])[1]);
    // 사이시옷: 낱말 가운데 글자의 받침 'ㅅ'을 더하거나 뺀 것 (다음 글자가 자음으로 시작하거나 '잎·일'처럼 'ㄴ' 소리가 덧나는 것)
    if (d.p !== 2 || d.k >= word.length - 1 || (d.from && d.to) || (d.from || d.to) !== 'ㅅ') return false;
    const next = partsOf(word[d.k + 1]);
    return next[0] !== 'ㅇ' || 'ㅣㅑㅕㅛㅠ'.includes(next[1]);
}

/**
 * 사전에 없는 한국어 낱말의 철자를 고친다 → { to, why } | null
 * 틀린 말과 소리가 같은 것 > 요즘 소리로는 같은 것(ㅐ·ㅔ) > 헷갈리는 낱자 한 곳 순으로 고르고,
 * 같은 등급에 둘 이상이면 어느 것인지 몰라 고치지 않는다.
 * 조사를 떼면 두 글자 이하인 말(이름·땅 이름이 많다)은 조사는 그대로 두고, 소리가 같거나 사이시옷만 다른 것만 받는다.
 */
function spellingFix(dict, word) {
    const stem = nounStem(word);
    const ending = word.slice(stem.length);
    const short = (stem !== word && stem.length <= 2) || word.length <= 2;
    const sound = pronounce(word), loose = looseSound(word);
    const ranked = [];
    for (const [cand, kind] of koreanCandidates(word)) {
        if (!dict.spell(cand)) continue;
        const same = pronounce(cand) === sound;
        const rank = same ? 3 : looseSound(cand) === loose ? 2 : kind === 'mix' ? 1 : 0;
        if (!rank || !trusted(word, cand, kind, rank)) continue;
        // 짧은 말(이름이 많다)은 조사를 그대로 두고, 받침을 새로 더하는 것(자들 → 잣들)은 받지 않는다
        if (short && (!cand.endsWith(ending) || (rank === 1 && (mixupCount(word, cand, MIXUPS_SHORT) !== 1 || addsFinal(word, cand))))) continue;
        ranked.push({ cand, kind, rank });
    }
    if (!ranked.length) return null;
    const top = Math.max(...ranked.map(r => r.rank));
    const best = ranked.filter(r => r.rank === top);
    if (best.length > 1) return null;
    return { to: best[0].cand, why: mistakeWhy(word, best[0].cand, best[0].kind) };
}

/** 한국어 낱말들 → { 낱말: null(맞음) | false(고칠 말을 모름) | { to, why } } */
export function lookupKorean(dict, words, onEach) {
    const out = {};
    for (const w of words) {
        const q = w.normalize('NFC');
        if (!/^[가-힣]+$/.test(q) || knownKorean(dict, q)) out[w] = null;
        else out[w] = splitFix(dict, q) || spellingFix(dict, q) || false;
        if (onEach) onEach();
    }
    return out;
}

/** 영어 낱말들 → { 낱말: null(맞음) | false(고칠 말을 모름) | { to, why } } */
export function lookupEnglish(dict, words, onEach) {
    const out = {};
    for (const w of words) {
        if (dict.spell(w) || (w !== w.toLowerCase() && dict.spell(w.toLowerCase()))) out[w] = null;
        else {
            const to = pickEnglish(w, dict.suggest(w));
            out[w] = to ? { to, why: englishWhy(w, to) } : false;
        }
        if (onEach) onEach();
    }
    return out;
}
