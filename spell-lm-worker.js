/**
 * 맞춤법 정밀 검사 작업자 — 문맥 언어 모델(Kiwi)로 고칠 곳을 더 찾는다 (고르는 방법은 spell-lm.js).
 *
 * 언어 모델(약 80MB)은 사용자가 '받기'를 누를 때 한 번 받아 이 앱만 쓰는 IndexedDB(diary-spell-lm)에 둔다.
 * 그 뒤로는 인터넷 없이 검사한다. 글은 어디로도 보내지 않는다.
 * 모델은 메모리를 많이 써서(약 500MB) 맞춤법 사전 작업자와 따로 돈다 — 이 작업자가 멈춰도 기본 검사는 된다.
 *
 * 메시지:
 *   → { type:'status', id }                       ← { type:'status', id, ready }   (모델을 다 받아 두었나)
 *   → { type:'download', id }                     ← { type:'progress', id, stage:'download', got, total } … ← { type:'done', id }
 *   → { type:'cancel' }                           (받기를 멈춘다 — 받은 파일은 남겨 두고 다음에 이어 받는다)
 *   → { type:'delete', id }                       ← { type:'done', id }
 *   → { type:'check', id, lines, base, words }    ← { type:'progress', id, stage:'open'|'check', got, total } … ← { type:'result', id, fixes }
 *   실패하면 ← { type:'error', id, message, abort? }
 */

const APP_VERSION = new URL(self.location.href).search;
const KIWI_DIR = './vendor/kiwi-0.24.1/';
// 모델이 바뀔 때만 올린다 — 앱 판이 바뀌어도 받아 둔 모델을 다시 받지 않게
const MODEL = 'kiwi-0.24.1-cong-base';
// [받을 파일, 크기(진행 표시용), Kiwi에 넣을 이름]
const FILES = [
    ['kiwi-wasm.wasm.gz', 1267833, null],
    ['model/cong.mdl.0', 38000000, 'cong.mdl'],
    ['model/cong.mdl.1', 37854705, 'cong.mdl'],
    ['model/sj.morph.gz', 2126432, 'sj.morph'],
    ['model/combiningRule.txt.gz', 1649, 'combiningRule.txt'],
    ['model/extract.mdl.gz', 14275, 'extract.mdl'],
    ['model/typo.dict.gz', 272, 'typo.dict'],
    ['model/dialect.dict.gz', 312, 'dialect.dict'],
];
const TOTAL = FILES.reduce((n, f) => n + f[1], 0);
const DB_NAME = 'diary-spell-lm', DB_STORE = 'files';

let modules = null;   // { hunspell: spell-hunspell.js, lm: spell-lm.js }
const loadModules = () => modules || (modules = Promise.all([
    import('./spell-hunspell.js' + APP_VERSION), import('./spell-lm.js' + APP_VERSION),
]).then(([hunspell, lm]) => ({ hunspell, lm })));
let kiwiPromise = null;
let downloading = null;   // AbortController

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
const keyOf = (name) => MODEL + '/' + name;

async function isReady() {
    try { return !!(await dbGet(keyOf('complete'))); } catch (e) { return false; }
}

// ─── 받기 ───
async function download(progress) {
    const ctl = new AbortController();
    downloading = ctl;
    try {
        let before = 0;
        for (const [name, size] of FILES) {
            const saved = await dbGet(keyOf(name)).catch(() => null);
            if (saved && saved.size === size) { before += size; progress(before, TOTAL); continue; }   // 받아 둔 파일은 건너뛴다
            const res = await fetch(new URL(KIWI_DIR + name + '?m=' + MODEL, self.location.href), { signal: ctl.signal });
            if (!res.ok) throw new Error(`정밀 검사 모델을 받지 못했습니다 (${res.status})`);
            const reader = res.body.getReader();
            const chunks = [];
            let got = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                got += value.byteLength;
                progress(before + Math.min(got, size), TOTAL);
            }
            const blob = new Blob(chunks);
            if (blob.size !== size) throw new Error('정밀 검사 모델을 끝까지 받지 못했습니다. 다시 받아 주세요.');
            await dbPut(keyOf(name), blob);
            before += size;
        }
        await dbPut(keyOf('complete'), true);
    } finally {
        if (downloading === ctl) downloading = null;
    }
}

async function removeModel() {
    kiwiPromise = null;
    await dbDo('readwrite', s => s.clear());
}

// ─── Kiwi 열기 ───
function openKiwi(progress) {
    if (!kiwiPromise) {
        kiwiPromise = (async () => {
            const { hunspell } = await loadModules();
            progress('open', 0, 0);
            const blobs = {};
            for (const [name] of FILES) {
                const b = await dbGet(keyOf(name));
                if (!b) throw new Error('정밀 검사 모델이 기기에 없습니다. 다시 받아 주세요.');
                blobs[name] = b;
            }
            const wasm = await hunspell.gunzip(blobs['kiwi-wasm.wasm.gz']);
            const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
            try {
                const { KiwiBuilder } = await import(new URL(KIWI_DIR + 'kiwi-builder.js', self.location.href).href);
                const builder = await KiwiBuilder.create(wasmUrl);
                const modelFiles = {};
                // 큰 모델 파일은 둘로 나눠 두었다 — 이어 붙인다
                modelFiles['cong.mdl'] = new Uint8Array(await new Blob([blobs['model/cong.mdl.0'], blobs['model/cong.mdl.1']]).arrayBuffer());
                for (const [name, , as] of FILES) {
                    if (!as || as === 'cong.mdl') continue;
                    modelFiles[as] = await hunspell.gunzip(blobs[name]);
                }
                return await builder.build({ modelFiles, modelType: 'none', loadDefaultDict: false, loadMultiDict: false, loadTypoDict: true });
            } finally {
                URL.revokeObjectURL(wasmUrl);
            }
        })();
        kiwiPromise.catch(() => { kiwiPromise = null; });
    }
    return kiwiPromise;
}

// ─── 검사 ───
async function check(msg, progress) {
    const { hunspell, lm } = await loadModules();
    if (!(await isReady())) throw new Error('정밀 검사 모델이 기기에 없습니다.');
    const dict = await hunspell.openLang('ko', (stage, got, total) => progress(stage === 'download' ? 'open' : stage, got, total));
    const words = (msg.words || []).filter(w => /^[가-힣]+$/.test(w));
    hunspell.addUserWords({ ko: dict }, words);
    const kiwi = await openKiwi(progress);
    const mine = new Set(words);
    let last = 0;
    return lm.lmFixes(msg.lines || [], dict, kiwi, {
        base: msg.base || [],
        skip: (w) => mine.has(w),
        onLine: (done, total) => { if (total > 6 && (done === 0 || Date.now() - last > 200)) { last = Date.now(); progress('check', done, total); } },
    });
}

self.onmessage = async (e) => {
    const msg = e.data || {};
    const id = msg.id;
    const progress = (stage, got, total) => self.postMessage({ type: 'progress', id, stage, got, total });
    try {
        if (msg.type === 'status') self.postMessage({ type: 'status', id, ready: await isReady() });
        else if (msg.type === 'download') {
            await download((got, total) => progress('download', got, total));
            self.postMessage({ type: 'done', id });
        } else if (msg.type === 'cancel') {
            if (downloading) downloading.abort();
        } else if (msg.type === 'delete') {
            if (downloading) downloading.abort();
            await removeModel();
            self.postMessage({ type: 'done', id });
        } else if (msg.type === 'check') {
            const fixes = await check(msg, progress);
            self.postMessage({ type: 'result', id, fixes });
        }
    } catch (err) {
        const abort = err && err.name === 'AbortError';
        self.postMessage({ type: 'error', id, abort, message: abort ? '받기를 멈췄습니다.' : String((err && err.message) || err) });
    }
};
