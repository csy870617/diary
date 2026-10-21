/**
 * 맞춤법 검사 엔진 — 화면 쪽 창구. 사전은 작업자(spell-worker.js)가 열고, 규칙과 고를 말은 spell-text.js가 정한다.
 * 모두 기기 안에서 하며 글을 밖으로 보내지 않는다.
 *
 * 사용자가 '사전에 추가'한 말(사람 이름 등)은 이 기기에만 저장한다(faith_spell_words).
 */
import { checkLines } from './spell-text.js';

const WORDS_ITEM = 'faith_spell_words';
// 한국어 사전은 메모리를 많이 쓴다 — 3분 동안 검사하지 않으면 작업자를 닫는다 (다시 검사하면 저장소에서 금방 연다)
const IDLE_MS = 3 * 60 * 1000;

let worker = null;
let seq = 0;
const calls = new Map();   // id → { resolve, reject, onProgress }
let idleTimer = null;

function stopWorker() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (worker) { worker.terminate(); worker = null; }
    calls.forEach(c => c.reject(new Error('맞춤법 검사를 멈췄습니다.')));
    calls.clear();
}

function getWorker() {
    if (worker) return worker;
    // 이 파일과 같은 판(?v=…)으로 작업자를 불러온다 (캐시에 남은 옛 작업자와 섞이지 않게)
    worker = new Worker(new URL('./spell-worker.js' + new URL(import.meta.url).search, import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
        const d = e.data || {};
        const call = calls.get(d.id);
        if (!call) return;
        if (d.type === 'progress') { if (call.onProgress) call.onProgress(d); return; }
        calls.delete(d.id);
        if (d.type === 'result') call.resolve(d);
        else call.reject(new Error(d.message || '맞춤법 사전을 열지 못했습니다.'));
    };
    worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        const err = new Error('맞춤법 사전을 열지 못했습니다. 브라우저를 최신으로 업데이트하거나 앱을 새로 고쳐 주세요.');
        calls.forEach(c => c.reject(err));
        calls.clear();
        if (worker) worker.terminate();
        worker = null;
    };
    return worker;
}

function lookup(req, onProgress) {
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
        const id = ++seq;
        calls.set(id, { resolve, reject, onProgress });
        getWorker().postMessage({ type: 'lookup', id, ko: req.ko || [], en: req.en || [], words: getPersonalWords() });
    }).finally(() => {
        if (!calls.size) idleTimer = setTimeout(stopWorker, IDLE_MS);
    });
}

/**
 * 줄들을 검사한다 → [{ id, a, b, from, to, type, why, word, src }]
 * onProgress({ stage: 'download'|'open'|'check', got, total })
 */
export function checkDocument(lines, { onProgress } = {}) {
    const mine = new Set(getPersonalWords());
    return checkLines(lines, { lookup: (req) => lookup(req, onProgress) }, { skip: (w) => mine.has(w) });
}

/** 사용자가 사전에 넣은 말 */
export function getPersonalWords() {
    try {
        const list = JSON.parse(localStorage.getItem(WORDS_ITEM) || '[]');
        return Array.isArray(list) ? list.filter(w => typeof w === 'string') : [];
    } catch (e) { return []; }
}

export function addPersonalWord(word) {
    const w = String(word || '').trim();
    if (!w) return;
    const list = getPersonalWords();
    if (list.includes(w)) return;
    list.push(w);
    try { localStorage.setItem(WORDS_ITEM, JSON.stringify(list.slice(-2000))); } catch (e) { /* 저장 공간 문제 — 이번만 무시된다 */ }
}

/** 로그아웃: 사용자 사전(사람 이름 등이 들어 있다)을 지운다 */
export function forgetSpellData() {
    try { localStorage.removeItem(WORDS_ITEM); } catch (e) { /* 저장소 접근 불가 */ }
    stopWorker();
}
