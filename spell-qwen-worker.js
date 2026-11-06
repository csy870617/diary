/**
 * AI 정밀 검사 작업자 — Qwen3.5-0.8B 언어 모델로 고칠 후보 문장들의 자연스러움을 잰다 (고르는 방법은 spell-qwen.js).
 *
 * 모델(약 570MB)은 사용자가 '받기'를 누를 때 Hugging Face에서 정해 둔 판(REV)을 조각으로 받아
 * 이 앱만 쓰는 IndexedDB(diary-spell-ai)에 둔다. 그 뒤로는 인터넷 없이 검사한다. 글은 어디로도 보내지 않는다.
 * 모델은 메모리를 많이 써서(약 700MB) 다른 작업자와 따로 돌고, 다 쓰면 spell-engine.js가 작업자를 닫는다.
 *
 * 메시지:
 *   → { type:'status', id }                         ← { type:'status', id, ready }
 *   → { type:'download', id }                       ← { type:'progress', id, stage:'download', got, total } … ← { type:'done', id }
 *   → { type:'cancel' }                             (받기를 멈춘다 — 받은 조각은 남겨 두고 다음에 이어 받는다)
 *   → { type:'delete', id }                         ← { type:'done', id }
 *   → { type:'check', id, pending, lm, base }       ← { type:'progress', id, stage:'open'|'check', got, total } … ← { type:'result', id, fixes }
 *   실패하면 ← { type:'error', id, message, abort? }
 */

const APP_VERSION = new URL(self.location.href).search;
const DIR = './vendor/qwen/';
// 모델 판을 바꿀 때만 올린다 (받아 둔 모델을 다시 받지 않게)
const REV = '25cdf33f386b487a25f3d743e86442517bdb77ff';
const HF = `https://huggingface.co/onnx-community/Qwen3.5-0.8B-Text-ONNX/resolve/${REV}/`;
const MODEL = 'qwen3.5-0.8b-q4-' + REV.slice(0, 8);
const TOKENIZER_SIZE = 19226111;
const DB_NAME = 'diary-spell-ai', DB_STORE = 'files';
// 모델 입력 모양 (Qwen3.5-0.8B: 선형 주의 층의 상태와 보통 주의 층의 키·값)
const CONV = [6144, 3], RECUR = [16, 128, 128], KV = [2, 0, 256];

const appUrl = (path) => new URL(path + APP_VERSION, self.location.href).href;
let modules = null;   // { hunspell: spell-hunspell.js(gunzip), qwen: spell-qwen.js }
const loadModules = () => modules || (modules = Promise.all([import(appUrl('./spell-hunspell.js')), import(appUrl('./spell-qwen.js'))])
    .then(([hunspell, qwen]) => ({ hunspell, qwen })));
let opened = null;    // Promise<{ ort, sess, tok }>
let downloading = null;

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
const chunkList = () => fetch(appUrl(DIR + 'chunks.json')).then(r => r.json());

// ─── 받기 ───
/** url을 받아 Blob으로 (range: [시작, 끝) 바이트) — 받는 동안 got(바이트)을 알린다 */
async function fetchBlob(url, range, signal, onBytes) {
    const res = await fetch(url, { signal, headers: range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : {} });
    if (!res.ok || (range && res.status !== 206)) throw new Error(`AI 정밀 검사 모델을 받지 못했습니다 (${res.status})`);
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.byteLength;
        onBytes(got);
    }
    return new Blob(parts);
}

async function download(progress, base = HF) {
    const ctl = new AbortController();
    downloading = ctl;
    try {
        const chunks = await chunkList();
        const total = chunks[chunks.length - 1][1] + TOKENIZER_SIZE;
        let before = 0;
        for (let k = 0; k < chunks.length; k++) {
            const [s, e] = chunks[k];
            const saved = await dbGet(keyOf('q' + k)).catch(() => null);
            if (!(saved && saved.size === e - s)) {
                const blob = await fetchBlob(base + 'onnx/model_q4.onnx_data', [s, e], ctl.signal, (got) => progress(before + Math.min(got, e - s), total));
                if (blob.size !== e - s) throw new Error('AI 정밀 검사 모델을 끝까지 받지 못했습니다. 다시 받아 주세요.');
                await dbPut(keyOf('q' + k), blob);
            }
            before += e - s;
            progress(before, total);
        }
        const savedTok = await dbGet(keyOf('tokenizer.json')).catch(() => null);
        if (!(savedTok && savedTok.size === TOKENIZER_SIZE)) {
            const blob = await fetchBlob(base + 'tokenizer.json', null, ctl.signal, (got) => progress(before + Math.min(got, TOKENIZER_SIZE), total));
            if (blob.size !== TOKENIZER_SIZE) throw new Error('AI 정밀 검사 모델을 끝까지 받지 못했습니다. 다시 받아 주세요.');
            await dbPut(keyOf('tokenizer.json'), blob);
        }
        await dbPut(keyOf('complete'), true);
    } finally {
        if (downloading === ctl) downloading = null;
    }
}

async function removeModel() {
    opened = null;
    await dbDo('readwrite', s => s.clear());
}

// ─── 열기 ───
function openModel(progress) {
    if (!opened) {
        opened = (async () => {
            const { hunspell } = await loadModules();
            progress('open', 0, 0);
            const chunks = await chunkList();
            const blobs = [];
            for (let k = 0; k < chunks.length; k++) {
                const b = await dbGet(keyOf('q' + k));
                if (!b) throw new Error('AI 정밀 검사 모델이 기기에 없습니다. 다시 받아 주세요.');
                blobs.push(b);
            }
            const tokBlob = await dbGet(keyOf('tokenizer.json'));
            if (!tokBlob) throw new Error('AI 정밀 검사 모델이 기기에 없습니다. 다시 받아 주세요.');
            const [ort, { Tokenizer }] = await Promise.all([import(appUrl(DIR + 'ort.wasm.min.mjs')), import(appUrl(DIR + 'tokenizers.min.mjs'))]);
            const tokConfig = await fetch(appUrl(DIR + 'tokenizer_config.json')).then(r => r.json());
            const tok = new Tokenizer(JSON.parse(await tokBlob.text()), tokConfig);
            ort.env.wasm.numThreads = 1;   // GitHub Pages는 여러 스레드에 필요한 헤더를 보낼 수 없다
            ort.env.wasm.wasmPaths = { mjs: appUrl(DIR + 'ort-wasm-simd-threaded.mjs') };
            ort.env.wasm.wasmBinary = await hunspell.gunzip(await fetch(appUrl(DIR + 'ort-wasm-simd-threaded.wasm.gz')).then(r => r.blob()));
            const graph = await hunspell.gunzip(await fetch(appUrl(DIR + 'model.onnx.gz')).then(r => r.blob()));
            // 조각마다 Blob 주소를 넘긴다 — 엔진이 하나씩 읽어 들여 한꺼번에 메모리에 두 벌 올리지 않는다
            const urls = blobs.map(b => URL.createObjectURL(b));
            try {
                const sess = await ort.InferenceSession.create(graph, {
                    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
                    externalData: urls.map((u, k) => ({ path: 'q' + k, data: u })),
                });
                return { ort, sess, tok };
            } finally {
                urls.forEach(u => URL.revokeObjectURL(u));
            }
        })();
        opened.catch(() => { opened = null; });
    }
    return opened;
}

/**
 * 문장들의 점수 — 공통 앞부분 뒤의 토큰들의 로그 확률 합 (앞부분은 모두 같아 견줄 때 빠진다)
 * texts: [원래, 후보1, …]
 */
async function scoreTexts({ ort, sess, tok }, texts) {
    const enc = texts.map(t => tok.encode(t, { add_special_tokens: false }).ids);
    let common = 0;
    while (enc.every(e => common < e.length - 1 && e[common] === enc[0][common])) common++;
    const B = enc.length, T = Math.max(...enc.map(e => e.length));
    const keep = Math.max(1, T - Math.max(0, common - 1));   // common-1번째 자리부터의 다음 토큰 확률만 셈한다
    const ids = new BigInt64Array(B * T), mask = new BigInt64Array(B * T);
    enc.forEach((e, b) => e.forEach((x, t) => { ids[b * T + t] = BigInt(x); mask[b * T + t] = 1n; }));
    const feeds = {
        input_ids: new ort.Tensor('int64', ids, [B, T]), attention_mask: new ort.Tensor('int64', mask, [B, T]),
        num_logits_to_keep: new ort.Tensor('int64', new BigInt64Array([BigInt(keep)]), []),
    };
    for (const n of sess.inputNames) {
        if (n.startsWith('past_conv')) feeds[n] = new ort.Tensor('float32', new Float32Array(B * CONV[0] * CONV[1]), [B, ...CONV]);
        else if (n.startsWith('past_recurrent')) feeds[n] = new ort.Tensor('float32', new Float32Array(B * RECUR[0] * RECUR[1] * RECUR[2]), [B, ...RECUR]);
        else if (n.startsWith('past_key_values')) feeds[n] = new ort.Tensor('float32', new Float32Array(0), [B, ...KV]);
    }
    const out = await sess.run(feeds, ['logits']);
    const d = out.logits.data, V = out.logits.dims[2], K = out.logits.dims[1];
    const first = T - K;   // 남긴 첫 자리
    return enc.map((e, b) => {
        let s = 0;
        for (let t = Math.max(first, common - 1); t < e.length - 1; t++) {
            const off = (b * K + (t - first)) * V;
            let m = -Infinity;
            for (let v = 0; v < V; v++) if (d[off + v] > m) m = d[off + v];
            let z = 0;
            for (let v = 0; v < V; v++) z += Math.exp(d[off + v] - m);
            s += d[off + e[t + 1]] - m - Math.log(z);
        }
        return s;
    });
}

// ─── 검사 ───
async function check(msg, progress) {
    if (!(await isReady())) throw new Error('AI 정밀 검사 모델이 기기에 없습니다.');
    const { qwen } = await loadModules();
    const model = await openModel(progress);
    const pending = msg.pending || [], lm = msg.lm || [], base = msg.base || [];
    const reqs = qwen.qwenRequests(pending, lm);
    const scores = {};
    for (let k = 0; k < reqs.length; k++) {
        progress('check', k, reqs.length);
        scores[reqs[k].key] = await scoreTexts(model, reqs[k].texts);
    }
    return qwen.qwenDecide(pending, lm, base, scores);
}

self.onmessage = async (e) => {
    const msg = e.data || {};
    const id = msg.id;
    const progress = (stage, got, total) => self.postMessage({ type: 'progress', id, stage, got, total });
    try {
        if (msg.type === 'status') self.postMessage({ type: 'status', id, ready: await isReady() });
        else if (msg.type === 'download') {
            await download((got, total) => progress('download', got, total), typeof msg.base === 'string' ? msg.base : HF);
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
