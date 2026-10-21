/**
 * Gemini 음성 — 문단 안의 몇 문장을 묶어 Gemini에게 한 번에 읽혀 받고, 문장마다 잘라 재생한다.
 *
 * 문장마다 따로 만들면 문장끼리 억양이 이어지지 않아 어색하게 들린다(지금까지의 음성이 그랬다).
 * 그래서 문단 안의 문장들을 300자 안쪽으로 묶어 한 번에 만들고(첫 묶음만 짧게 — 처음 소리가 빨리 나도록),
 * 받은 소리에서 문장 사이의 쉼(조용한 구간)을 찾아 문장별로 자른다.
 * 그래서 지금 읽는 문장 강조·문장을 눌러 거기서부터 읽기·쉼 설정이 그대로 동작한다.
 * 묶음은 글 내용만으로 정해지므로(어디서부터 읽든 같다) 한 번 만든 소리를 다시 쓸 수 있다.
 * 받은 소리는 이 기기(IndexedDB)에 저장해 다시 들을 때는 요금이 들지 않는다.
 *
 * 화면(DOM)은 건드리지 않는다 — 재생은 tts.js가 자연음과 같은 길(playNeuralAudio)로 한다.
 */
import { geminiSpeak, getGeminiInfo, isGeminiConnected, GEMINI_AUDIO_DB, GeminiError } from './gemini.js';

export const GEMINI_PREFIX = 'gm:';   // 음성 목록에서 Gemini 음성을 구분하는 접두어

// 설명은 Google이 붙인 목소리 성격(Warm, Gentle, Soft …)을 옮긴 것이다. 신앙일지를 읽기에 어울리는 것만 골랐다.
export const GEMINI_VOICES = [
    { id: 'Sulafat', label: '여성 · 따뜻한 목소리' },
    { id: 'Vindemiatrix', label: '여성 · 다정하고 부드러운 목소리' },
    { id: 'Achernar', label: '여성 · 여리고 고운 목소리' },
    { id: 'Aoede', label: '여성 · 산뜻하고 가벼운 목소리' },
    { id: 'Gacrux', label: '여성 · 차분하고 성숙한 목소리' },
    { id: 'Kore', label: '여성 · 또렷하고 단단한 목소리' },
    { id: 'Schedar', label: '남성 · 고르고 차분한 목소리' },
    { id: 'Algieba', label: '남성 · 부드럽고 매끄러운 목소리' },
    { id: 'Iapetus', label: '남성 · 맑고 또렷한 목소리' },
    { id: 'Sadaltager', label: '남성 · 지적이고 침착한 목소리' },
    { id: 'Achird', label: '남성 · 친근한 목소리' },
    { id: 'Charon', label: '남성 · 또박또박 전하는 목소리' }
];
export const DEFAULT_GEMINI_VOICE = 'Sulafat';

// 말투: '어떻게 읽을지'만 짧게 알려 준다(글은 그대로 읽는다).
// 지시가 길수록 목소리가 흔들린다는 안내(speech-generation 문서)에 따라 짧게 쓴다.
export const GEMINI_STYLES = [
    { id: 'calm', label: '차분하게', style: 'calm, warm and unhurried' },
    { id: 'meditative', label: '묵상하듯 천천히', style: 'soft, slow and reflective, like a quiet prayer' },
    { id: 'warm', label: '따뜻하게', style: 'warm, gentle and heartfelt' },
    { id: 'narration', label: '또박또박 낭독', style: 'clear, steady audiobook narration' },
    { id: 'bright', label: '밝고 생기 있게', style: 'bright, cheerful and lively' },
    { id: 'plain', label: '지시 없이 (목소리 그대로)', style: '' }
];
export const DEFAULT_GEMINI_STYLE = 'calm';

const STYLE_ITEM = 'faith_gemini_style';
const RATE_ITEM = 'faith_gemini_cps';

// 문장 조각의 최대 길이(강조 단위). 속도와 상관없이 고정해야 묶음이 늘 같아 저장해 둔 소리를 다시 쓴다.
export const GEMINI_MAX_CHUNK = 160;
const PASSAGE_MAX = 300;          // 한 번에 만드는 묶음 (약 45초 분량)
const PASSAGE_HARD_MAX = 420;     // 문장이 끝나지 않아도 여기서는 나눈다
const FIRST_PASSAGE_MAX = 100;    // 글의 첫 묶음은 짧게 — 처음 소리가 빨리 나도록
export const GEMINI_PASSAGE_GAP_MS = 300;   // 묶음과 묶음 사이의 쉼 (묶음 안의 쉼은 소리에 들어 있다)
const AHEAD_SEC = 40;             // 읽는 동안 미리 만들어 둘 분량
const DEFAULT_CPS = 6.6;          // 1배속에서 1초에 읽는 글자 수(어림) — 받은 소리의 실제 길이로 맞춰 간다

export function isGeminiVoice(value) {
    return typeof value === 'string' && value.startsWith(GEMINI_PREFIX);
}

function voiceName(value) {
    const name = String(value || '').slice(GEMINI_PREFIX.length);
    return GEMINI_VOICES.some(v => v.id === name) ? name : DEFAULT_GEMINI_VOICE;
}

export function getGeminiStyle() {
    try {
        const s = localStorage.getItem(STYLE_ITEM);
        if (GEMINI_STYLES.some(x => x.id === s)) return s;
    } catch (e) { /* 저장소 접근 불가 시 기본값 */ }
    return DEFAULT_GEMINI_STYLE;
}

export function setGeminiStyle(id) {
    if (!GEMINI_STYLES.some(x => x.id === id)) return;
    try { localStorage.setItem(STYLE_ITEM, id); } catch (e) { /* 저장소 접근 불가 */ }
}

export function geminiStyleText(id) {
    return (GEMINI_STYLES.find(x => x.id === id) || GEMINI_STYLES[0]).style;
}

function currentContext(voiceValue) {
    const model = getGeminiInfo().model;
    const voice = voiceName(voiceValue);
    const styleId = getGeminiStyle();
    return { model, voice, styleId, style: geminiStyleText(styleId), rateKey: `${model}|${voice}|${styleId}` };
}

// ─── 읽는 빠르기 (재생 시간 표시용) ───
// 목소리·말투마다 빠르기가 달라, 받은 소리의 실제 길이로 '1초에 읽는 글자 수'를 배워 둔다.

function readRates() {
    try { return JSON.parse(localStorage.getItem(RATE_ITEM) || '{}') || {}; } catch (e) { return {}; }
}

export function geminiCharsPerSec(voiceValue) {
    const r = readRates()[currentContext(voiceValue).rateKey];
    return r > 2 && r < 20 ? r : DEFAULT_CPS;
}

function learnRate(key, chars, sec) {
    if (!(sec > 1) || !(chars > 8)) return;
    const r = chars / sec;
    if (r < 2 || r > 20) return;
    const all = readRates();
    all[key] = all[key] ? all[key] * 0.7 + r * 0.3 : r;
    try { localStorage.setItem(RATE_ITEM, JSON.stringify(all)); } catch (e) { /* 저장 공간 문제 — 다음에 다시 */ }
}

// ─── 묶음 나누기 ───

const SENTENCE_END_RE = /[.!?。…"'」』)\]]\s*$/;
const LETTER_RE = /\p{L}/u;

/** 말하는 데 걸리는 양(대략 음절 수). 문장 사이의 경계를 소리에서 찾을 때 쓴다 */
export function speechUnits(text) {
    let u = 0;
    for (const ch of String(text || '')) {
        const c = ch.codePointAt(0);
        if (c >= 0xAC00 && c <= 0xD7A3) u += 1;                                  // 한글 음절
        else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) u += 0.35;      // 영문: 세 글자쯤이 한 음절
        else if (c >= 48 && c <= 57) u += 0.8;                                   // 숫자
        else if (LETTER_RE.test(ch)) u += 0.6;                                   // 그 밖의 글자(한자 등)
    }
    return Math.max(0.5, u);
}

const passageMemo = new WeakMap();

/**
 * 문장 조각들(chunks)을 묶음으로 나눈다 → { list: [{ idx, text, weights, spokenChars }], of: 조각 → 묶음 번호(-1: 읽을 말 없음) }
 * spokenOf(i): i번째 조각의 실제로 읽을 글. 빈 줄(문단이 바뀜)에서는 늘 나누고, 그 밖에는 문장이 끝나는 곳에서만 나눈다.
 * 같은 조각 배열에는 같은 결과를 돌려준다.
 */
export function buildPassages(chunks, spokenOf) {
    const hit = passageMemo.get(chunks);
    if (hit) return hit;
    const list = [];
    const of = new Int32Array(chunks.length).fill(-1);
    let cur = null, last = -1;
    for (let i = 0; i < chunks.length; i++) {
        const text = spokenOf(i);
        if (!text) continue;
        if (cur) {
            const prev = chunks[last];
            const nl = prev.nl || 0;
            const limit = list.length === 0 ? FIRST_PASSAGE_MAX : PASSAGE_MAX;
            const size = cur.chars + 1 + text.length;
            const sentenceEnded = nl > 0 || SENTENCE_END_RE.test(prev.text || '');
            if (nl >= 2 || (size > limit && sentenceEnded) || size > PASSAGE_HARD_MAX) { list.push(cur); cur = null; }
        }
        if (!cur) cur = { idx: [], parts: [], chars: 0 };
        else {
            // 줄이 바뀐 자리는 줄바꿈으로 남긴다 — 마침표 없는 제목·짧은 줄도 쉬어 읽는다
            cur.parts.push((chunks[last].nl || 0) > 0 ? '\n' : ' ');
            cur.chars += 1;
        }
        cur.idx.push(i);
        cur.parts.push(text);
        cur.chars += text.length;
        of[i] = list.length;
        last = i;
    }
    if (cur) list.push(cur);
    for (const p of list) {
        p.text = p.parts.join('');
        p.weights = p.idx.map(i => speechUnits(spokenOf(i)));
        p.spokenChars = p.idx.reduce((sum, i) => sum + spokenOf(i).length, 0);
        delete p.parts;
    }
    const result = { list, of };
    passageMemo.set(chunks, result);
    return result;
}

/** i번째 조각 뒤의 쉼(ms): 묶음의 마지막 조각이면 묶음 사이의 쉼, 묶음 안이면 0 (쉼이 소리에 들어 있다) */
export function geminiGapAfterMs(chunks, i, spokenOf) {
    const { list, of } = buildPassages(chunks, spokenOf);
    const pi = of[i];
    if (pi < 0 || pi >= list.length - 1) return 0;
    const idx = list[pi].idx;
    return idx[idx.length - 1] === i ? GEMINI_PASSAGE_GAP_MS : 0;
}

/** i번째 조각이 든 묶음의 마지막 조각 번호 (그 묶음을 건너뛸 때) */
export function geminiPassageLast(chunks, i, spokenOf) {
    const { list, of } = buildPassages(chunks, spokenOf);
    const pi = of[i];
    if (pi < 0) return i;
    const idx = list[pi].idx;
    return idx[idx.length - 1];
}

// ─── 소리 다루기 ───

export function int16ToFloat(pcm) {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    return out;
}

/** 10ms마다 소리 크기(dB)를 재고, '조용함'의 기준을 정한다 (가장 큰 말소리보다 30dB 작으면 조용함) */
function frameLevels(wav, sr) {
    const hop = Math.max(1, Math.round(sr / 100));
    const n = Math.floor(wav.length / hop);
    const db = new Float32Array(n);
    for (let f = 0; f < n; f++) {
        let s = 0;
        const o = f * hop;
        for (let j = 0; j < hop; j++) { const v = wav[o + j]; s += v * v; }
        db[f] = 10 * Math.log10(s / hop + 1e-12);
    }
    const sorted = Array.from(db).sort((a, b) => a - b);
    const loud = n ? sorted[Math.min(n - 1, Math.floor(n * 0.9))] : -20;
    return { db, hop, n, thr: Math.max(-70, loud - 30) };
}

/** 앞뒤의 긴 침묵은 0.1초만 남기고 잘라낸다 (묶음 사이가 너무 길게 쉬지 않도록) */
export function trimSilence(wav, sr) {
    const { db, hop, n, thr } = frameLevels(wav, sr);
    let a = 0;
    while (a < n && db[a] <= thr) a++;
    if (a >= n) return wav;
    let b = n - 1;
    while (b > a && db[b] <= thr) b--;
    const keep = 10;
    return wav.subarray(Math.max(0, (a - keep) * hop), Math.min(wav.length, (b + 1 + keep) * hop));
}

/**
 * 묶음 소리에서 문장 사이를 자를 자리(표본 번호)를 찾는다.
 * 각 문장의 말 길이(weights)에 비례해 '여기쯤 끝나겠다'를 어림하고, 소리 속의 쉼(조용한 구간)들 가운데
 * 그 어림에 가깝고 길게 쉰 것을 문장 수만큼 순서대로 고른다. 한 문장씩 가까운 쉼을 고르면 어림이
 * 조금만 어긋나도(문장마다 읽는 빠르기가 다르다) 쉼표 자리를 문장 끝으로 잘못 잡아, 전체를 한꺼번에 맞춘다.
 * 맞는 쉼이 없는 경계는 어림한 자리 근처에서 가장 조용한 곳을 쓴다.
 */
export function findCuts(wav, sr, weights) {
    const m = weights.length;
    if (m <= 1) return [];
    const { db, hop, n, thr } = frameLevels(wav, sr);
    if (n < 2) return weights.slice(1).map(() => 0);
    // 말소리가 있는 틀만 센 누적값 — 쉼을 빼고 비례로 나누기 위해서
    const speechCum = new Float64Array(n + 1);
    for (let f = 0; f < n; f++) speechCum[f + 1] = speechCum[f] + (db[f] > thr ? 1 : 0);
    const totalSpeech = speechCum[n] || n;
    const runs = [];   // 50ms 이상 이어진 조용한 구간 [시작, 끝) — 맨 앞·맨 끝의 침묵은 뺀다
    for (let f = 0; f < n;) {
        if (db[f] <= thr) {
            let g = f;
            while (g < n && db[g] <= thr) g++;
            if (g - f >= 5 && f > 0 && g < n) runs.push([f, g]);
            f = g;
        } else f++;
    }
    const B = m - 1;
    const totalW = weights.reduce((a, b) => a + b, 0) || 1;
    const expect = [];   // 각 문장의 말이 끝날 것으로 어림한 자리(틀 번호)
    for (let k = 0, acc = 0; k < B; k++) {
        acc += weights[k];
        const target = acc / totalW * totalSpeech;
        let lo = 0, hi = n;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (speechCum[mid] < target) lo = mid + 1; else hi = mid; }
        expect.push(lo);
    }
    // 거리는 앞뒤 문장 길이를 단위로 잰다. 0.4초 이상 쉰 곳은 문장 끝일 가능성이 커서 덜 멀게 친다.
    // (값은 문장마다 빠르기가 ±30% 다른 흉내 소리 750개로 맞췄다: 쉼표 자리를 문장 끝으로 잡는 일이 5% → 1% 안쪽)
    const unit = (k) => Math.max(30, ((k + 1 < B ? expect[k + 1] : n) - (k > 0 ? expect[k - 1] : 0)) / 2);
    const cost = (k, [s, e]) => Math.abs(s - expect[k]) / unit(k) - 1.5 * Math.min(e - s, 40) / 40;
    const SKIP = 1.5;   // 맞는 쉼 없이 어림한 자리를 쓸 때의 비용
    // dp[st]: 지금까지의 최소 비용, st = 마지막으로 쓴 쉼 번호 + 1 (0 = 아직 없음)
    const R = runs.length;
    let dp = new Float64Array(R + 1).fill(Infinity);
    dp[0] = 0;
    const back = [];
    for (let k = 0; k < B; k++) {
        const next = new Float64Array(R + 1).fill(Infinity);
        const from = new Int32Array(R + 1).fill(-2);   // -1: 쉼을 쓰지 않음(상태 그대로)
        for (let st = 0; st <= R; st++) {
            if (dp[st] + SKIP < next[st]) { next[st] = dp[st] + SKIP; from[st] = -1; }
        }
        let best = Infinity, bestSt = -1;
        for (let j = 0; j < R; j++) {
            if (dp[j] < best) { best = dp[j]; bestSt = j; }   // j번 쉼 앞에서 끝난 상태들 가운데 최소
            const v = best + cost(k, runs[j]);
            if (v < next[j + 1]) { next[j + 1] = v; from[j + 1] = bestSt; }
        }
        dp = next;
        back.push(from);
    }
    let st = 0;
    for (let s = 1; s <= R; s++) if (dp[s] < dp[st]) st = s;
    const use = new Array(B).fill(-1);
    for (let k = B - 1; k >= 0; k--) {
        const b = back[k][st];
        if (b !== -1) { use[k] = st - 1; st = b; }
    }
    const cuts = [];
    let prevF = 0;
    for (let k = 0; k < B; k++) {
        let cutF;
        if (use[k] >= 0) cutF = (runs[use[k]][0] + runs[use[k]][1]) >> 1;   // 쉼의 가운데에서 자른다
        else {
            cutF = expect[k];
            let low = Infinity;
            for (let f = Math.max(prevF + 1, expect[k] - 20); f <= Math.min(n - 1, expect[k] + 20); f++) {
                if (db[f] < low) { low = db[f]; cutF = f; }
            }
        }
        cutF = Math.max(prevF + 1, Math.min(n - 1, cutF));
        cuts.push(cutF * hop);
        prevF = cutF;
    }
    return cuts;
}

/**
 * 음높이를 바꾸지 않고 빠르기만 바꾼다 (WSOLA: 겹쳐 잇기 + 파형이 가장 잘 맞는 자리 찾기).
 * rate > 1이면 빠르게, < 1이면 느리게. 자연음 작업자(neural-tts-worker.js)의 방식을 느리게도 쓸 수 있게 넓혔다.
 * Gemini는 빠르기를 숫자로 정할 수 없어, 보통 빠르기로 받은 소리를 여기서 맞춘다 — 속도를 바꿔도 새로 받지 않는다.
 */
export function timeStretch(x, rate, sr) {
    if (!(Math.abs(rate - 1) > 0.01) || x.length < 4096) return x;
    const N = 2 * Math.round((sr || 24000) * 0.016);   // 약 32ms 창
    const Hs = N >> 1, tol = N >> 2;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const outLen = Math.round(x.length / rate);
    const out = new Float32Array(outLen + N);
    for (let j = 0; j < N && j < x.length; j++) out[j] += x[j] * win[j];
    let prev = 0;
    const score = (pos, nat, step) => {
        let acc = 0;
        for (let j = 0; j < Hs; j += step) acc += x[pos + j] * x[nat + j];
        return acc;
    };
    for (let k = 1; ; k++) {
        const outPos = k * Hs;
        if (outPos >= outLen) break;
        const nominal = Math.round(outPos * rate);
        const natural = prev + Hs;
        const lo = Math.max(0, nominal - tol), hi = Math.min(x.length - N, nominal + tol);
        if (hi < lo || natural + Hs > x.length) break;
        let best = lo, bestScore = -Infinity;
        for (let p = lo; p <= hi; p += 2) { const sc = score(p, natural, 4); if (sc > bestScore) { bestScore = sc; best = p; } }
        const a = Math.max(lo, best - 2), b = Math.min(hi, best + 2);
        bestScore = -Infinity;
        for (let p = a; p <= b; p++) { const sc = score(p, natural, 1); if (sc > bestScore) { bestScore = sc; best = p; } }
        for (let j = 0; j < N; j++) out[outPos + j] += x[best + j] * win[j];
        prev = best;
    }
    return out.subarray(0, outLen);
}

// ─── 저장소 (IndexedDB) ───
// audio: { k, pcm(16비트 원본), sr } / meta: { k, bytes, used } — 오래 안 쓴 것부터 지워 CACHE_MAX_BYTES 안으로.
// 열쇠는 '모델·목소리·말투·글'의 지문(SHA-256)이라 글 자체를 열쇠로 남기지 않는다.

const CACHE_MAX_BYTES = 80 * 1024 * 1024;   // 약 28분 분량
let dbPromise = null;

function openDb() {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB 없음'));
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(GEMINI_AUDIO_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'k' });
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' }).createIndex('used', 'used');
            };
            req.onsuccess = () => {
                const db = req.result;
                // 연결 해제 때 저장소를 통째로 지울 수 있도록 바로 닫아 준다
                db.onversionchange = () => { db.close(); dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('저장소를 열 수 없습니다'));
        });
        dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
}

function finish(t) {
    return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error);
    });
}

async function loadCached(id) {
    const db = await openDb();
    const t = db.transaction(['audio', 'meta'], 'readwrite');
    let rec = null;
    const req = t.objectStore('audio').get(id);
    req.onsuccess = () => {
        rec = req.result || null;
        if (rec) t.objectStore('meta').put({ k: id, bytes: rec.pcm.byteLength, used: Date.now() });
    };
    await finish(t);
    return rec;
}

async function allMeta(db) {
    const t = db.transaction('meta', 'readonly');
    const req = t.objectStore('meta').index('used').getAll();   // 오래 안 쓴 것부터
    await finish(t);
    return req.result || [];
}

async function saveCached(id, pcm, sr) {
    // 받는 사이에 연결을 해제했다면 저장하지 않는다 (지운 저장소를 다시 만들지 않게)
    if (!isGeminiConnected()) return;
    const db = await openDb();
    const buf = (pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength) ? pcm.buffer : pcm.slice().buffer;
    const t = db.transaction(['audio', 'meta'], 'readwrite');
    t.objectStore('audio').put({ k: id, pcm: buf, sr });
    t.objectStore('meta').put({ k: id, bytes: buf.byteLength, used: Date.now() });
    await finish(t);
    const metas = await allMeta(db);
    let total = metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
    const drop = [];
    for (const m of metas) {
        if (total <= CACHE_MAX_BYTES) break;
        if (m.k === id) continue;
        drop.push(m.k);
        total -= m.bytes || 0;
    }
    if (!drop.length) return;
    const t2 = db.transaction(['audio', 'meta'], 'readwrite');
    for (const k of drop) { t2.objectStore('audio').delete(k); t2.objectStore('meta').delete(k); }
    await finish(t2);
}

/** 이 기기에 저장된 Gemini 음성의 크기(바이트) */
export async function geminiCacheBytes() {
    try {
        const metas = await allMeta(await openDb());
        return metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
    } catch (e) { return 0; }
}

/** 저장된 Gemini 음성을 모두 지운다 (연결은 그대로) */
export async function clearGeminiAudioCache() {
    clearGeminiMemory();
    try {
        const db = await openDb();
        const t = db.transaction(['audio', 'meta'], 'readwrite');
        t.objectStore('audio').clear();
        t.objectStore('meta').clear();
        await finish(t);
    } catch (e) { /* 저장소를 못 쓰면 지울 것도 없다 */ }
}

async function cacheId(str) {
    try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        // 보안 연결이 아니어서 crypto.subtle이 없을 때 — 간단한 지문 두 개를 이어 쓴다
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 2654435761);
            h2 = Math.imul(h2 ^ c, 1597334677);
        }
        return 'h' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + str.length;
    }
}

// ─── 요청 줄 세우기 ───
// 지금 읽을 묶음이 미리 만들기보다 먼저다. 동시에 두 개까지만 보낸다 (사용량 한도·요금 보호).

const MAX_PARALLEL = 2;
let running = 0;
const waiting = [];

function pump() {
    while (running < MAX_PARALLEL && waiting.length) waiting.shift().start();
}

function queued(task, urgent, entry) {
    return new Promise((resolve, reject) => {
        const item = {
            start: () => {
                running++;
                task().then(resolve, reject).finally(() => { running--; pump(); });
            },
            cancel: (err) => reject(err)
        };
        if (entry) entry.item = item;
        if (urgent) waiting.unshift(item); else waiting.push(item);
        pump();
    });
}

function promote(entry) {
    const i = entry && entry.item ? waiting.indexOf(entry.item) : -1;
    if (i > 0) { waiting.splice(i, 1); waiting.unshift(entry.item); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 잠깐의 문제(요청 몰림·서버 오류·접속 끊김)는 조금 기다렸다가 다시 시도한다 */
async function withRetry(task) {
    let delay = 1500;
    for (let attempt = 0; ; attempt++) {
        try {
            return await task();
        } catch (err) {
            const kind = err && err.kind;
            const again = (kind === 'rate_limit' || kind === 'server') ? attempt < 3
                : (kind === 'network' || kind === 'timeout') ? attempt < 1 : false;
            if (!again || (typeof navigator !== 'undefined' && navigator.onLine === false)) throw err;
            await sleep(Math.min(20000, err.retryAfterMs || delay) + Math.random() * 400);
            delay *= 2;
        }
    }
}

// ─── 묶음 소리 (메모리 → 기기 저장소 → Gemini) ───

const MEM_MAX = 8;
const mem = new Map();   // 열쇠 → { promise, done, item }

export function clearGeminiMemory() {
    mem.clear();
    const err = new GeminiError('no_key', 'Gemini 연결이 해제되었습니다.');
    while (waiting.length) waiting.shift().cancel(err);
}

if (typeof window !== 'undefined') {
    window.addEventListener('gemini-change', (e) => {
        if (e.detail && e.detail.what === 'disconnected') clearGeminiMemory();
    });
}

function passageKey(p, ctx) {
    return `${ctx.model}|${ctx.voice}|${ctx.styleId}|${p.text}`;
}

function passageAudio(p, ctx, urgent) {
    const key = passageKey(p, ctx);
    let entry = mem.get(key);
    if (entry) {
        mem.delete(key);
        mem.set(key, entry);
        if (urgent) promote(entry);
        return entry.promise;
    }
    entry = { done: false, item: null };
    entry.promise = (async () => {
        const id = await cacheId(key);
        let pcm = null, sr = 0;
        try {
            const rec = await loadCached(id);
            if (rec) { pcm = new Int16Array(rec.pcm); sr = rec.sr; }
        } catch (e) { /* 저장소를 못 쓰면 새로 받는다 */ }
        if (!pcm) {
            const res = await queued(() => withRetry(() => geminiSpeak(p.text, { voice: ctx.voice, style: ctx.style, model: ctx.model })), urgent, entry);
            pcm = res.pcm;
            sr = res.sampleRate;
            saveCached(id, pcm, sr).catch(() => {});
        }
        const wav = trimSilence(int16ToFloat(pcm), sr);
        learnRate(ctx.rateKey, p.spokenChars, wav.length / sr);
        const cuts = findCuts(wav, sr, p.weights);
        entry.done = true;
        return { wav, sampleRate: sr, cuts };
    })();
    // 실패한 묶음은 다음에 다시 시도할 수 있게 비워 둔다
    entry.promise.catch(() => { if (mem.get(key) === entry) mem.delete(key); });
    mem.set(key, entry);
    while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
    return entry.promise;
}

/**
 * index번째 조각의 소리 → { wav, sampleRate, gapAfterMs } (읽을 말이 없으면 null)
 * 그 조각이 든 묶음을 (없으면 만들어) 문장 경계에서 잘라 주고, 속도에 맞춰 늘이거나 줄인다.
 */
export async function getGeminiSegment(chunks, index, { voiceValue, speed = 1, spokenOf }) {
    const { list, of } = buildPassages(chunks, spokenOf);
    const pi = of[index];
    if (pi < 0) return null;
    const p = list[pi];
    const audio = await passageAudio(p, currentContext(voiceValue), true);
    const k = p.idx.indexOf(index);
    const start = k <= 0 ? 0 : audio.cuts[k - 1];
    const end = k >= p.idx.length - 1 ? audio.wav.length : audio.cuts[k];
    let wav = audio.wav.subarray(start, Math.max(start, end));
    if (wav.length < audio.sampleRate * 0.02) wav = new Float32Array(Math.round(audio.sampleRate * 0.05));
    else if (Math.abs(speed - 1) > 0.01) wav = timeStretch(wav, speed, audio.sampleRate);
    const lastInPassage = k === p.idx.length - 1 && pi < list.length - 1;
    return { wav, sampleRate: audio.sampleRate, gapAfterMs: lastInPassage ? GEMINI_PASSAGE_GAP_MS : 0 };
}

/** index번째 조각의 소리가 이미 준비되어 있는가 (아니면 '만드는 중' 안내를 띄운다) */
export function isGeminiSegmentReady(chunks, index, { voiceValue, spokenOf }) {
    const { list, of } = buildPassages(chunks, spokenOf);
    const pi = of[index];
    if (pi < 0) return true;
    const entry = mem.get(passageKey(list[pi], currentContext(voiceValue)));
    return !!(entry && entry.done);
}

/** 읽는 동안 뒤의 묶음을 미리 만들어 둔다 (앞으로 AHEAD_SEC초 분량까지) */
export function prefetchGemini(chunks, index, { voiceValue, spokenOf }) {
    const { list, of } = buildPassages(chunks, spokenOf);
    let pi = of[index];
    if (pi < 0) {
        // 읽을 말이 없는 조각이면 그 뒤의 첫 묶음부터
        let next = -1;
        for (let j = index + 1; j < chunks.length && next < 0; j++) next = of[j];
        if (next < 0) return;
        pi = next - 1;
    }
    const ctx = currentContext(voiceValue);
    const cps = geminiCharsPerSec(voiceValue);
    let ahead = 0;
    for (let q = pi + 1; q < list.length && q <= pi + 3 && ahead < AHEAD_SEC; q++) {
        passageAudio(list[q], ctx, false).catch(() => {});
        ahead += list[q].spokenChars / cps;
    }
}
