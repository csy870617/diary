/**
 * 맞춤법 사전 작업자 — Hunspell(WebAssembly)로 한국어·영어 낱말을 검사한다.
 * 한국어 사전은 열 때 1초쯤 걸리고 메모리를 많이 써서, 화면이 멈추지 않도록 따로 돈다.
 *
 * 사전 파일(vendor/spell/*.gz, 모두 약 1MB)은 처음 검사할 때 한 번 받아 이 앱만 쓰는
 * IndexedDB(diary-spell)에 둔다. 그 뒤로는 인터넷 없이 검사한다. 글은 어디로도 보내지 않는다.
 *
 * 메시지:
 *   → { type:'lookup', id, ko:[낱말], en:[낱말], words:[사용자가 사전에 넣은 말] }
 *   ← { type:'progress', id, stage:'download'|'open'|'check', lang, got, total } …
 *   ← { type:'result', id, ko:{ 낱말: 판정 }, en:{…} } | { type:'error', id, message }
 *     판정: null(사전에 있는 말) | false(사전에 없지만 고칠 말을 확실히 모름) | { to, why }
 */

// 앱과 같은 판(?v=…)으로 다른 파일을 불러온다 (작업자는 화면의 import map을 쓰지 못한다)
const APP_VERSION = new URL(self.location.href).search;
// 사전 열기는 맞춤법 정밀 검사 작업자와 함께 쓴다 (spell-hunspell.js). 첫 메시지가 왔을 때 불러온다
let hunspell = null;
const loadHunspell = () => hunspell || (hunspell = import('./spell-hunspell.js' + APP_VERSION));

const memo = { ko: new Map(), en: new Map() };   // 한 번 물어본 낱말의 답 (사용자 사전이 바뀌면 지운다)

let text = null;
/** 낱말들을 검사한다 (한 번 물어본 낱말은 기억해 둔 답을 쓴다) */
function lookup(dict, lang, words, tick) {
    const out = {};
    const fresh = words.filter(w => !memo[lang].has(w));
    const got = (lang === 'ko' ? text.lookupKorean : text.lookupEnglish)(dict, fresh, tick);
    for (const w of fresh) memo[lang].set(w, got[w]);
    for (const w of words) out[w] = memo[lang].get(w);
    return out;
}

self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.type !== 'lookup') return;
    const id = msg.id;
    const progress = (stage, got, total, lang) => self.postMessage({ type: 'progress', id, stage, lang, got, total });
    try {
        const { openLang, addUserWords, textModule } = await loadHunspell();
        const ko = msg.ko || [], en = msg.en || [];
        const dicts = {};
        if (ko.length) dicts.ko = await openLang('ko', progress);
        if (en.length) dicts.en = await openLang('en', progress);
        // 사용자 사전은 열린 사전에 넣는다 (아직 안 연 사전의 말은 그 사전을 열 때 넣도록 기억에서 뺀다)
        const pending = (msg.words || []).filter(w => (/^[가-힣]+$/.test(w) ? dicts.ko : dicts.en));
        if (addUserWords(dicts, pending)) { memo.ko.clear(); memo.en.clear(); }
        text = await textModule();
        const total = ko.length + en.length;
        let done = 0;
        const tick = () => { done++; if (done % 4 === 0 || done === total) progress('check', done, total); };
        const result = { type: 'result', id, ko: {}, en: {} };
        if (dicts.ko) result.ko = lookup(dicts.ko, 'ko', ko, tick);
        if (dicts.en) result.en = lookup(dicts.en, 'en', en, tick);
        self.postMessage(result);
    } catch (err) {
        self.postMessage({ type: 'error', id, message: String((err && err.message) || err) });
    }
};
