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
// 사전이 바뀔 때만 올린다 — 앱 판이 바뀌어도 기기에 저장한 사전을 다시 받지 않게
const DICT_VERSION = 'ko-0.7.94.en-2020.12.07';
const FILES = { ko: ['ko.aff.gz', 'ko.dic.gz'], en: ['en_US.aff.gz', 'en_US.dic.gz'] };
const DB_NAME = 'diary-spell', DB_STORE = 'files';

let text = null;          // spell-text.js (사전에 말 넣기·낱말 검사)
let hunspellModule = null; // Hunspell 모듈
const opened = {};        // 'ko'·'en' → Promise<사전>
const userAdded = new Set();
const memo = { ko: new Map(), en: new Map() };   // 한 번 물어본 낱말의 답 (사용자 사전이 바뀌면 지운다)

// ─── 저장소 ───
let dbPromise = null;
function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { dbPromise = null; reject(req.error); };
        });
    }
    return dbPromise;
}
async function dbDo(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
const dbGet = (key) => dbDo('readonly', s => s.get(key));
const dbPut = (key, value) => dbDo('readwrite', s => s.put(value, key));

/** 예전 판의 사전은 지운다 */
async function dropOldFiles() {
    try {
        const keys = await dbDo('readonly', s => s.getAllKeys());
        for (const k of keys || []) if (!String(k).startsWith(DICT_VERSION + '/')) await dbDo('readwrite', s => s.delete(k));
    } catch (e) { /* 정리는 실패해도 괜찮다 */ }
}

// ─── 사전 파일 ───

/** 저장소에서 꺼내거나, 없으면 받아서 저장한다 → Blob (gzip) */
async function getFile(name, report) {
    const key = DICT_VERSION + '/' + name;
    try {
        const saved = await dbGet(key);
        if (saved) { report(saved.size); return saved; }
    } catch (e) { /* 저장소를 못 쓰면 받아서 쓴다 */ }
    const res = await fetch(new URL(`./vendor/spell/${name}?d=${DICT_VERSION}`, self.location.href));
    if (!res.ok) throw new Error(`맞춤법 사전을 받지 못했습니다 (${res.status})`);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        report(got);
    }
    const blob = new Blob(chunks);
    try { await dbPut(key, blob); } catch (e) { /* 저장하지 못해도 이번 검사는 한다 */ }
    return blob;
}

/** gzip을 푼다 (서버가 이미 풀어서 보냈으면 그대로) */
async function gunzip(blob) {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (head[0] !== 0x1f || head[1] !== 0x8b) return new Uint8Array(await blob.arrayBuffer());
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저에서는 맞춤법 사전을 열 수 없습니다. 브라우저를 최신으로 업데이트해 주세요.');
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ─── Hunspell ───

async function loadModule() {
    if (!hunspellModule) {
        const { default: createHunspellModule } = await import('./vendor/hunspell/hunspell.web.mjs' + APP_VERSION);
        hunspellModule = await createHunspellModule();
    }
    return hunspellModule;
}

/** 문자열을 Hunspell 메모리에 잠깐 올려 fn을 부른다 */
function withStrings(M, values, fn) {
    const ptrs = values.map(v => M.stringToNewUTF8(v));
    try { return fn(...ptrs); } finally { ptrs.forEach(p => M._free(p)); }
}

/** 사전 하나를 연다 → { spell, suggest, add, addWithAffix } */
function createDict(M, affPath, dicPath) {
    const api = {
        create: M.cwrap('Hunspell_create', 'number', ['number', 'number']),
        spell: M.cwrap('Hunspell_spell', 'number', ['number', 'number']),
        suggest: M.cwrap('Hunspell_suggest', 'number', ['number', 'number', 'number']),
        freeList: M.cwrap('Hunspell_free_list', null, ['number', 'number', 'number']),
        add: M.cwrap('Hunspell_add', 'number', ['number', 'number']),
        addWithAffix: M.cwrap('Hunspell_add_with_affix', 'number', ['number', 'number', 'number'])
    };
    const h = withStrings(M, [affPath, dicPath], (a, d) => api.create(a, d));
    return {
        spell: (w) => withStrings(M, [w], p => api.spell(h, p)) !== 0,
        suggest: (w) => withStrings(M, [w], (p) => {
            const listPtr = M._malloc(4);
            try {
                const n = api.suggest(h, listPtr, p);
                const arr = M.getValue(listPtr, '*');
                const out = [];
                for (let i = 0; i < n; i++) out.push(M.UTF8ToString(M.getValue(arr + i * 4, '*')));
                api.freeList(h, listPtr, n);
                return out;
            } finally { M._free(listPtr); }
        }),
        add: (w) => withStrings(M, [w], p => api.add(h, p)),
        addWithAffix: (w, example) => withStrings(M, [w, example], (p, e) => api.addWithAffix(h, p, e))
    };
}

/** 'ko' 또는 'en' 사전을 연다 (한 번만) */
function openLang(lang, progress) {
    if (!opened[lang]) {
        opened[lang] = (async () => {
            if (!text) text = await import('./spell-text.js' + APP_VERSION);
            const [aff, dic] = FILES[lang];
            // 받은 양을 두 파일 합쳐서 알린다 (크기는 대략 — 받는 동안의 안내용)
            const sizes = { 'ko.aff.gz': 471865, 'ko.dic.gz': 382003, 'en_US.aff.gz': 996, 'en_US.dic.gz': 190824 };
            const total = sizes[aff] + sizes[dic];
            const got = { [aff]: 0, [dic]: 0 };
            const report = (name) => (n) => { got[name] = n; progress('download', got[aff] + got[dic], total, lang); };
            const [affBlob, dicBlob] = await Promise.all([getFile(aff, report(aff)), getFile(dic, report(dic))]);
            dropOldFiles();
            progress('open', 0, 0, lang);
            const M = await loadModule();
            const dir = '/' + lang;
            M.FS.mkdir(dir);
            M.FS.writeFile(`${dir}/${lang}.aff`, await gunzip(affBlob));
            M.FS.writeFile(`${dir}/${lang}.dic`, await gunzip(dicBlob));
            const dict = createDict(M, `${dir}/${lang}.aff`, `${dir}/${lang}.dic`);
            // 사전 파일은 Hunspell이 읽어 들였으니 메모리를 돌려준다
            M.FS.unlink(`${dir}/${lang}.aff`);
            M.FS.unlink(`${dir}/${lang}.dic`);
            if (lang === 'ko') {
                const words = await import('./spell-words.js' + APP_VERSION);
                text.addKoreanWords(dict, { nouns: words.EXTRA_NOUNS, verbs: words.EXTRA_VERBS,
                    adjectives: words.EXTRA_ADJECTIVES, exact: words.EXTRA_WORDS });
            }
            return dict;
        })();
        opened[lang].catch(() => { delete opened[lang]; });
    }
    return opened[lang];
}

/** 사용자가 사전에 넣은 말 — 새로 들어온 것만 더한다 */
function addUserWords(dicts, words) {
    let changed = false;
    for (const w of words || []) {
        if (!w || userAdded.has(w)) continue;
        userAdded.add(w);
        changed = true;
        if (/^[가-힣]+$/.test(w) && dicts.ko) {
            // 조사를 뗀 말을 명사로 넣고, 넣은 꼴 그대로도 넣는다
            text.addKoreanWords(dicts.ko, { nouns: [text.nounStem(w)], exact: [w] });
        } else if (dicts.en) {
            dicts.en.add(w);
            dicts.en.add(w.toLowerCase());
        }
    }
    if (changed) { memo.ko.clear(); memo.en.clear(); }
}

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
        const ko = msg.ko || [], en = msg.en || [];
        const dicts = {};
        if (ko.length) dicts.ko = await openLang('ko', progress);
        if (en.length) dicts.en = await openLang('en', progress);
        // 사용자 사전은 열린 사전에 넣는다 (아직 안 연 사전의 말은 그 사전을 열 때 넣도록 기억에서 뺀다)
        const pending = (msg.words || []).filter(w => (/^[가-힣]+$/.test(w) ? dicts.ko : dicts.en));
        addUserWords(dicts, pending);
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
