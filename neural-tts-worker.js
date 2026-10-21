/**
 * 자연스러운 음성(Supertonic 3) 생성 작업자 — 화면이 멈추지 않도록 계산은 여기서 한다.
 *
 * 모델 파일은 앱(neural-tts.js)이 내려받아 IndexedDB(diary-voice)에 넣어 둔 것을 그대로 읽는다.
 * (메인 스레드에서 수백 MB를 넘겨받지 않기 위해 작업자가 저장소에서 직접 연다)
 *
 * 추론 순서는 공식 웹 예제(supertone-inc/supertonic web/helper.js)를 따르되,
 * 중첩 배열 대신 Float32Array를 써서 메모리와 시간을 줄였다.
 *
 * 메시지:
 *   → { type:'init', dbName, dbStore }             ← { type:'ready', backend } | { type:'error' }
 *   → { type:'synth', id, gen, text, lang, style, speed, steps }
 *                                                  ← { type:'audio', id, wav, sampleRate } | { type:'error', id } | { type:'skipped', id }
 *   → { type:'cancelBefore', gen }                 (이 세대보다 오래된 대기 요청은 건너뜀)
 */

let O = null;            // onnxruntime-web (전역 ort와 이름이 겹치지 않게 O로 둔다)
let cfgs = null;
let indexer = null;
let sessions = null;          // { dp, te, ve, voc }
const styles = new Map();     // 'F1' → { ttl, dp }
let modelName = '';
// 역할: 'full'(전부) | 'acoustic'(길이예측·글자처리·음성생성까지, 결과는 잠재값) | 'vocoder'(잠재값 → 소리)
// CPU로 계산할 때는 작업자 여러 개가 나눠 맡아 휴대폰의 여러 코어를 함께 쓴다.
let role = 'full';

const AVAILABLE_LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];

// 앱(neural-tts.js)이 IndexedDB에 넣어 둔 파일을 읽는다 — 파일 하나 = { blob, size, type }, 열쇠는 경로
let dbName = '', dbStore = '';
let dbPromise = null;
function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            // 저장소는 앱이 먼저 만들어 둔다 (판 번호를 정하지 않고 지금 판으로 연다)
            const req = indexedDB.open(dbName);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { dbPromise = null; reject(req.error); };
        });
    }
    return dbPromise;
}
async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(dbStore, 'readonly').objectStore(dbStore).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function readCached(path) {
    const rec = await dbGet(path);
    if (!rec || !rec.blob) throw new Error('내려받은 음성 파일이 없습니다: ' + path);
    return new Response(rec.blob);
}

async function readJson(path) { return (await readCached(path)).json(); }
async function hasCached(path) {
    const rec = await dbGet(path);
    return !!(rec && rec.blob);
}
async function readBytes(path) { return new Uint8Array(await (await readCached(path)).arrayBuffer()); }

async function createSessions(providers, vePath) {
    // 메모리 미리 잡아 두기(arena·패턴)를 끈다 — 휴대폰에서 작업자 여러 개를 띄울 수 있도록
    const opts = { executionProviders: providers, graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
    const open = async (path) => O.InferenceSession.create(await readBytes(path), opts);
    // 큰 파일을 하나씩 열고 바로 놓아 주어, 수백 MB가 한꺼번에 메모리에 올라가지 않게 한다
    // 역할에 필요한 모델만 연다 (작업자마다 메모리를 아끼기 위해)
    const out = {};
    if (role !== 'vocoder') {
        out.dp = await open('onnx/duration_predictor.onnx');
        out.te = await open('onnx/text_encoder.onnx');
        out.ve = await open(vePath);
    }
    if (role !== 'acoustic') out.voc = await open('onnx/vocoder.onnx');
    return out;
}

async function init(msg) {
    dbName = msg.dbName;
    dbStore = msg.dbStore;
    role = msg.role || 'full';
    // WebGPU 빌드와 WASM 빌드는 서로 다른 엔진 파일을 쓰고, 한 번 초기화에 실패하면
    // 같은 작업자에서는 다른 쪽으로 다시 열 수 없다. 그래서 먼저 GPU를 확인하고 하나만 불러온다.
    // (WebGPU로 열다 실패하면 앱이 forceWasm으로 작업자를 새로 띄운다)
    let useGpu = false;
    if (role === 'full' && !msg.forceWasm && self.navigator && navigator.gpu) {
        try { useGpu = !!(await navigator.gpu.requestAdapter()); } catch (e) { useGpu = false; }
    }
    // 계산량이 가장 큰 모델: GPU는 원본, CPU는 8비트(약 40% 빠름). 받아 둔 쪽에 맞춘다.
    const hasFp32 = await hasCached('onnx/vector_estimator.onnx');
    const hasInt8 = await hasCached('onnx/vector_estimator_int8.onnx');
    if (useGpu && !hasFp32) useGpu = false;          // GPU용 원본을 받지 않은 기기 → CPU로
    const vePath = (!useGpu && hasInt8) ? 'onnx/vector_estimator_int8.onnx' : 'onnx/vector_estimator.onnx';
    modelName = vePath.includes('int8') ? 'int8' : 'fp32';
    if (!O) {
        // 실행 엔진도 내려받아 둔 사본에서 읽는다 (인터넷 없이도 동작하도록)
        const blobUrl = async (path, type) => URL.createObjectURL(new Blob([await (await readCached(path)).arrayBuffer()], { type }));
        const flavor = useGpu ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded';
        importScripts(await blobUrl(useGpu ? 'ort/ort.webgpu.min.js' : 'ort/ort.wasm.min.js', 'text/javascript'));
        O = self.ort;
        O.env.wasm.wasmPaths = {
            mjs: await blobUrl(`ort/${flavor}.mjs`, 'text/javascript'),
            wasm: await blobUrl(`ort/${flavor}.wasm`, 'application/wasm')
        };
        // GitHub Pages는 다중 스레드에 필요한 헤더를 줄 수 없어 단일 스레드로 고정 (경고·실패 방지)
        O.env.wasm.numThreads = 1;
    }
    cfgs = await readJson('onnx/tts.json');
    indexer = await readJson('onnx/unicode_indexer.json');

    if (useGpu) {
        try {
            sessions = await createSessions(['webgpu'], vePath);
            return 'webgpu';
        } catch (e) {
            const err = new Error('WEBGPU_FAILED: ' + (e && e.message || e));
            err.webgpuFailed = true;
            throw err;
        }
    }
    sessions = await createSessions(['wasm'], vePath);
    return 'wasm';
}

async function getStyle(name) {
    if (styles.has(name)) return styles.get(name);
    const j = await readJson(`voice_styles/${name}.json`);
    const toTensor = (o) => new O.Tensor('float32', Float32Array.from(o.data.flat(Infinity)), o.dims);
    const st = { ttl: toTensor(j.style_ttl), dp: toTensor(j.style_dp) };
    styles.set(name, st);
    return st;
}

// 공식 예제의 전처리와 동일 (모델이 학습된 형식에 맞춘다)
function preprocessText(text, lang) {
    text = text.normalize('NFKD');
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
    const replacements = {
        '–': '-', '‑': '-', '—': '-', '_': ' ',
        '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'",
        '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' '
    };
    for (const [k, v] of Object.entries(replacements)) text = text.replaceAll(k, v);
    text = text.replace(/[♥☆♡©\\]/g, '');
    text = text.replaceAll('@', ' at ');
    text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?')
               .replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
    while (text.includes('""')) text = text.replace('""', '"');
    while (text.includes("''")) text = text.replace("''", "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
    if (!AVAILABLE_LANGS.includes(lang)) lang = 'ko';
    return `<${lang}>${text}</${lang}>`;
}

function gaussian() {
    const u1 = Math.max(0.0001, Math.random());
    const u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

async function synth({ text, lang, style, speed, steps }) {
    const st = await getStyle(style);
    const processed = preprocessText(text, lang);
    const L = processed.length;
    const ids = new BigInt64Array(L);
    for (let j = 0; j < L; j++) {
        const cp = processed.codePointAt(j);
        ids[j] = BigInt(cp < indexer.length ? indexer[cp] : -1);
    }
    const textIds = new O.Tensor('int64', ids, [1, L]);
    const textMask = new O.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);

    const tm = { start: performance.now() };
    const dpOut = await sessions.dp.run({ text_ids: textIds, style_dp: st.dp, text_mask: textMask });
    tm.dp = performance.now();
    const duration = dpOut.duration.data[0] / speed;

    const teOut = await sessions.te.run({ text_ids: textIds, style_ttl: st.ttl, text_mask: textMask });
    const textEmb = teOut.text_emb;
    tm.te = performance.now();

    const sampleRate = cfgs.ae.sample_rate;
    const chunkSize = cfgs.ae.base_chunk_size * cfgs.ttl.chunk_compress_factor;
    const latentDim = cfgs.ttl.latent_dim * cfgs.ttl.chunk_compress_factor;
    const wavLen = Math.floor(duration * sampleRate);
    const latentLen = Math.max(1, Math.floor((wavLen + chunkSize - 1) / chunkSize));

    let xt = new Float32Array(latentDim * latentLen);
    for (let i = 0; i < xt.length; i++) xt[i] = gaussian();
    const latentMask = new O.Tensor('float32', new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStep = new O.Tensor('float32', new Float32Array([steps]), [1]);

    for (let step = 0; step < steps; step++) {
        const out = await sessions.ve.run({
            noisy_latent: new O.Tensor('float32', xt, [1, latentDim, latentLen]),
            text_emb: textEmb,
            style_ttl: st.ttl,
            latent_mask: latentMask,
            text_mask: textMask,
            current_step: new O.Tensor('float32', new Float32Array([step]), [1]),
            total_step: totalStep
        });
        xt = new Float32Array(out.denoised_latent.data);
    }

    tm.ve = performance.now();
    if (role === 'acoustic') {
        // 소리 만들기(보코더)는 다른 작업자가 맡는다 — 그동안 이 작업자는 다음 문장을 만든다
        return { latent: xt, latentDim, latentLen, wavLen, sampleRate,
                 parts: { dp: tm.dp - tm.start, te: tm.te - tm.dp, ve: tm.ve - tm.te } };
    }
    const vocOut = await sessions.voc.run({ latent: new O.Tensor('float32', xt, [1, latentDim, latentLen]) });
    tm.voc = performance.now();
    const full = vocOut.wav_tts.data;
    // 예측한 길이 뒤에 붙는 여분(무음)은 잘라 다음 문장과의 간격이 들쭉날쭉하지 않게 한다
    const wav = new Float32Array(full.subarray(0, Math.min(full.length, Math.max(wavLen, 1))));
    // 진단용: 단계별 걸린 시간(ms)
    const parts = { dp: tm.dp - tm.start, te: tm.te - tm.dp, ve: tm.ve - tm.te, voc: tm.voc - tm.ve };
    return { wav, sampleRate, parts };
}

/**
 * 문장 앞뒤의 긴 무음을 걷어 낸다.
 * 모델은 문장마다 앞에 0.2~0.6초, 뒤에 0.3~0.7초쯤 소리 없는 구간을 붙인다. 그대로 이어 틀면 문장 사이가
 * 1초 넘게, 그것도 문장마다 들쭉날쭉하게 벌어져 느리고 어색하게 들렸다(쉼표에서 나눈 곳도 마침표처럼 오래 쉼).
 * 쉼은 앱(tts.js)이 문장 끝·쉼표·줄바꿈에 맞춰 일정하게 둔다.
 * 들숨·끝소리의 여운은 남기도록 가장 큰 소리보다 60dB 넘게 작은 구간만 무음으로 보고, 앞뒤에 여유를 둔다.
 */
const TRIM_FLOOR = 0.001;          // 가장 큰 소리 대비 -60dB
const TRIM_LEAD_SEC = 0.05, TRIM_TAIL_SEC = 0.1, TRIM_FADE_SEC = 0.005;
function trimSilence(x, sampleRate) {
    const hop = Math.max(1, Math.round(sampleRate * 0.01));   // 10ms씩 소리 크기를 잰다
    const n = Math.floor(x.length / hop);
    if (n < 10) return x;
    const rms = new Float32Array(n);
    let peak = 0;
    for (let f = 0; f < n; f++) {
        let acc = 0;
        for (let j = f * hop, e = j + hop; j < e; j++) acc += x[j] * x[j];
        rms[f] = Math.sqrt(acc / hop);
        if (rms[f] > peak) peak = rms[f];
    }
    if (!(peak > 0)) return x;
    const floor = peak * TRIM_FLOOR;
    let a = 0, b = n - 1;
    while (a < n && rms[a] < floor) a++;
    while (b > a && rms[b] < floor) b--;
    if (a >= n) return x;
    const start = Math.max(0, a * hop - Math.round(sampleRate * TRIM_LEAD_SEC));
    const end = Math.min(x.length, (b + 1) * hop + Math.round(sampleRate * TRIM_TAIL_SEC));
    if (start === 0 && end === x.length) return x;
    const y = x.slice(start, end);
    // 자른 자리가 '틱' 하고 튀지 않게 아주 짧게 줄였다 키운다
    const fade = Math.min(Math.round(sampleRate * TRIM_FADE_SEC), y.length >> 1);
    for (let j = 0; j < fade; j++) {
        const g = j / fade;
        if (start > 0) y[j] *= g;
        if (end < x.length) y[y.length - 1 - j] *= g;
    }
    return y;
}

/**
 * 음높이를 바꾸지 않고 소리를 빠르게 한다 (WSOLA: 겹쳐 잇기 + 파형이 가장 잘 맞는 자리 찾기).
 * 모델에 직접 빠르게 말하게 하면 말을 빼먹어(받아쓰기로 확인: 모델 1.37배에서 원문의 91%, 1.68배에서 43%만
 * 읽힘. 1.2배로 낮춰도 짧은 문장은 끝이 잘렸다 — neural-tts.js의 MODEL_MAX_SPEED) 모델은 제 빠르기로만
 * 말하게 하고, 빠르게 듣는 배율은 모두 여기서 맞춘다.
 */
function timeStretch(x, rate) {
    if (!(rate > 1.001) || x.length < 4096) return x;
    const N = 1536, Hs = N >> 1, tol = 384;          // 44.1kHz에서 약 35ms 창, 절반 겹침, ±9ms 탐색
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const outLen = Math.round(x.length / rate);
    // 끝에 무음을 덧대어 마지막 조각까지 창 안에 온전히 들어오게 한다
    // (덧대지 않으면 끝 30ms쯤을 찾을 자리가 없어 빠지고, 남은 부분도 창 모양대로 줄어들었다)
    const src = new Float32Array(x.length + N + tol);
    src.set(x);
    const out = new Float32Array(outLen + N);
    // 첫 조각의 앞 절반은 겹칠 조각이 없으므로 줄이지 않고 그대로 둔다 (첫소리가 작아지지 않게)
    for (let j = 0; j < N; j++) out[j] = src[j] * (j < Hs ? 1 : win[j]);
    let prev = 0;
    // 겹치는 앞 절반이 바로 앞 조각의 자연스러운 이어짐과 가장 비슷한 자리를 고른다
    const score = (pos, nat, step) => {
        let acc = 0;
        for (let j = 0; j < Hs; j += step) acc += src[pos + j] * src[nat + j];
        return acc;
    };
    for (let k = 1; ; k++) {
        const outPos = k * Hs;
        if (outPos >= outLen) break;
        const nominal = Math.round(outPos * rate);
        const natural = prev + Hs;
        const lo = Math.max(0, nominal - tol), hi = Math.min(src.length - N, nominal + tol);
        if (hi < lo || natural + Hs > src.length) break;
        // 거칠게(2칸씩, 4칸 간격으로 견줘) 찾은 뒤 주변을 촘촘히 다듬는다 — 계산량을 1/8로 줄인다
        let best = lo, bestScore = -Infinity;
        for (let p = lo; p <= hi; p += 2) { const sc = score(p, natural, 4); if (sc > bestScore) { bestScore = sc; best = p; } }
        const a = Math.max(lo, best - 2), b = Math.min(hi, best + 2);
        bestScore = -Infinity;
        for (let p = a; p <= b; p++) { const sc = score(p, natural, 1); if (sc > bestScore) { bestScore = sc; best = p; } }
        for (let j = 0; j < N; j++) out[outPos + j] += src[best + j] * win[j];
        prev = best;
    }
    return out.subarray(0, outLen);
}

/** 만든 소리를 다듬는다: 앞뒤 무음을 걷고, 빠르게 들을 배율만큼 빠르게 한다 */
function finishWav(raw, sampleRate, stretch) {
    const trimmed = trimSilence(raw, sampleRate);
    return (stretch > 1.001) ? new Float32Array(timeStretch(trimmed, stretch)) : new Float32Array(trimmed);
}

/** 잠재값을 소리로 (보코더 전담 작업자) */
async function vocode({ latent, latentDim, latentLen, wavLen }) {
    const t0 = performance.now();
    const vocOut = await sessions.voc.run({ latent: new O.Tensor('float32', latent, [1, latentDim, latentLen]) });
    const full = vocOut.wav_tts.data;
    const wav = new Float32Array(full.subarray(0, Math.min(full.length, Math.max(wavLen, 1))));
    return { wav, sampleRate: cfgs.ae.sample_rate, vocMs: performance.now() - t0 };
}

// 한 번에 하나씩 처리 (모델 세션은 동시 실행을 보장하지 않는다)
let queue = Promise.resolve();
// 정지·탐색으로 버려진 재생 세대의 요청은 만들지 않고 건너뛴다 (느린 기기에서 헛계산 방지)
let minGen = 0;
self.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'cancelBefore') { minGen = Math.max(minGen, msg.gen || 0); return; }
    queue = queue.then(async () => {
        if (msg.type === 'synth' && (msg.gen || 0) < minGen) {
            self.postMessage({ type: 'skipped', id: msg.id });
            return;
        }
        try {
            if (msg.type === 'init') {
                const backend = await init(msg);
                self.postMessage({ type: 'ready', backend, model: modelName, sampleRate: cfgs.ae.sample_rate });
            } else if (msg.type === 'vocode') {
                const { wav: raw, sampleRate, vocMs } = await vocode(msg);
                const wav = finishWav(raw, sampleRate, msg.stretch);
                self.postMessage({ type: 'audio', id: msg.id, wav, sampleRate, vocMs }, [wav.buffer]);
            } else if (msg.type === 'synth' && role === 'acoustic') {
                const t0 = performance.now();
                const r = await synth(msg);
                self.postMessage({ type: 'latent', id: msg.id, latent: r.latent, latentDim: r.latentDim, latentLen: r.latentLen,
                                   wavLen: r.wavLen, sampleRate: r.sampleRate, ms: performance.now() - t0, steps: msg.steps, parts: r.parts },
                                 [r.latent.buffer]);
            } else if (msg.type === 'synth') {
                const t0 = performance.now();
                const { wav: raw, sampleRate, parts } = await synth(msg);
                const wav = finishWav(raw, sampleRate, msg.stretch);
                self.postMessage({ type: 'audio', id: msg.id, wav, sampleRate, ms: performance.now() - t0, steps: msg.steps, parts }, [wav.buffer]);
            }
        } catch (err) {
            self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err), webgpuFailed: !!(err && err.webgpuFailed) });
        }
    });
};
