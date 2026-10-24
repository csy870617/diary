/**
 * Hunspell 사전 열기 — 맞춤법 작업자(spell-worker.js)와 정밀 검사 작업자(spell-lm-worker.js)가 함께 쓴다.
 *
 * 사전 파일(vendor/spell/*.gz, 모두 약 1MB)은 처음 검사할 때 한 번 받아 이 앱만 쓰는
 * IndexedDB(diary-spell)에 둔다. 그 뒤로는 인터넷 없이 검사한다. 글은 어디로도 보내지 않는다.
 */

// 앱과 같은 판(?v=…)으로 다른 파일을 불러온다 (작업자는 화면의 import map을 쓰지 못한다)
const APP_VERSION = new URL(import.meta.url).search;
// 사전이 바뀔 때만 올린다 — 앱 판이 바뀌어도 기기에 저장한 사전을 다시 받지 않게
const DICT_VERSION = 'ko-0.7.94.en-2020.12.07';
const FILES = { ko: ['ko.aff.gz', 'ko.dic.gz'], en: ['en_US.aff.gz', 'en_US.dic.gz'] };
const DB_NAME = 'diary-spell', DB_STORE = 'files';

let text = null;          // spell-text.js (사전에 말 넣기·낱말 검사)
let hunspellModule = null; // Hunspell 모듈
const opened = {};        // 'ko'·'en' → Promise<사전>
const userAdded = new Set();

/** spell-text.js (사전을 연 뒤에 쓴다) */
export async function textModule() {
    if (!text) text = await import(new URL('./spell-text.js' + APP_VERSION, import.meta.url).href);
    return text;
}

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
    const res = await fetch(new URL(`./vendor/spell/${name}?d=${DICT_VERSION}`, import.meta.url));
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
export async function gunzip(blob) {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (head[0] !== 0x1f || head[1] !== 0x8b) return new Uint8Array(await blob.arrayBuffer());
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저에서는 맞춤법 사전을 열 수 없습니다. 브라우저를 최신으로 업데이트해 주세요.');
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ─── Hunspell ───

async function loadModule() {
    if (!hunspellModule) {
        const { default: createHunspellModule } = await import(new URL('./vendor/hunspell/hunspell.web.mjs' + APP_VERSION, import.meta.url).href);
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
export function openLang(lang, progress) {
    if (!opened[lang]) {
        opened[lang] = (async () => {
            await textModule();
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
                const words = await import(new URL('./spell-words.js' + APP_VERSION, import.meta.url).href);
                text.addKoreanWords(dict, { nouns: words.EXTRA_NOUNS, verbs: words.EXTRA_VERBS,
                    adjectives: words.EXTRA_ADJECTIVES, exact: words.EXTRA_WORDS });
            }
            return dict;
        })();
        opened[lang].catch(() => { delete opened[lang]; });
    }
    return opened[lang];
}

/** 사용자가 사전에 넣은 말 — 새로 들어온 것만 더한다 → 새로 더한 말이 있었나 */
export function addUserWords(dicts, words) {
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
    return changed;
}
