/**
 * 자연스러운 음성(Supertonic 3) 생성 작업자 — 화면이 멈추지 않도록 계산은 여기서 한다.
 *
 * 모델 파일은 앱(neural-tts.js)이 내려받아 Cache Storage에 넣어 둔 것을 그대로 읽는다.
 * (메인 스레드에서 수백 MB를 넘겨받지 않기 위해 작업자가 캐시에서 직접 연다)
 *
 * 추론 순서는 공식 웹 예제(supertone-inc/supertonic web/helper.js)를 따르되,
 * 중첩 배열 대신 Float32Array를 써서 메모리와 시간을 줄였다.
 *
 * 메시지:
 *   → { type:'init', base, cacheName }            ← { type:'ready', backend } | { type:'error' }
 *   → { type:'synth', id, gen, text, lang, style, speed, steps }
 *                                                  ← { type:'audio', id, wav, sampleRate } | { type:'error', id } | { type:'skipped', id }
 *   → { type:'cancelBefore', gen }                 (이 세대보다 오래된 대기 요청은 건너뜀)
 */

let O = null;            // onnxruntime-web (전역 ort와 이름이 겹치지 않게 O로 둔다)
let cfgs = null;
let indexer = null;
let sessions = null;          // { dp, te, ve, voc }
const styles = new Map();     // 'F1' → { ttl, dp }
let base = '';
let cacheName = '';

const AVAILABLE_LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];

async function readCached(path) {
    const url = base + path;
    const cache = await caches.open(cacheName);
    const res = await cache.match(url);
    if (!res) throw new Error('내려받은 음성 파일이 없습니다: ' + path);
    return res;
}

async function readJson(path) { return (await readCached(path)).json(); }
async function readBytes(path) { return new Uint8Array(await (await readCached(path)).arrayBuffer()); }

async function createSessions(providers) {
    const opts = { executionProviders: providers, graphOptimizationLevel: 'all' };
    // 큰 파일을 하나씩 열고 바로 놓아 주어, 수백 MB가 한꺼번에 메모리에 올라가지 않게 한다
    const dp = await O.InferenceSession.create(await readBytes('onnx/duration_predictor.onnx'), opts);
    const te = await O.InferenceSession.create(await readBytes('onnx/text_encoder.onnx'), opts);
    const ve = await O.InferenceSession.create(await readBytes('onnx/vector_estimator.onnx'), opts);
    const voc = await O.InferenceSession.create(await readBytes('onnx/vocoder.onnx'), opts);
    return { dp, te, ve, voc };
}

async function init(msg) {
    base = msg.base;
    cacheName = msg.cacheName;
    // WebGPU 빌드와 WASM 빌드는 서로 다른 엔진 파일을 쓰고, 한 번 초기화에 실패하면
    // 같은 작업자에서는 다른 쪽으로 다시 열 수 없다. 그래서 먼저 GPU를 확인하고 하나만 불러온다.
    // (WebGPU로 열다 실패하면 앱이 forceWasm으로 작업자를 새로 띄운다)
    let useGpu = false;
    if (!msg.forceWasm && self.navigator && navigator.gpu) {
        try { useGpu = !!(await navigator.gpu.requestAdapter()); } catch (e) { useGpu = false; }
    }
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
            sessions = await createSessions(['webgpu']);
            return 'webgpu';
        } catch (e) {
            const err = new Error('WEBGPU_FAILED: ' + (e && e.message || e));
            err.webgpuFailed = true;
            throw err;
        }
    }
    sessions = await createSessions(['wasm']);
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

    const dpOut = await sessions.dp.run({ text_ids: textIds, style_dp: st.dp, text_mask: textMask });
    const duration = dpOut.duration.data[0] / speed;

    const teOut = await sessions.te.run({ text_ids: textIds, style_ttl: st.ttl, text_mask: textMask });
    const textEmb = teOut.text_emb;

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

    const vocOut = await sessions.voc.run({ latent: new O.Tensor('float32', xt, [1, latentDim, latentLen]) });
    const full = vocOut.wav_tts.data;
    // 예측한 길이 뒤에 붙는 여분(무음)은 잘라 다음 문장과의 간격이 들쭉날쭉하지 않게 한다
    const wav = new Float32Array(full.subarray(0, Math.min(full.length, Math.max(wavLen, 1))));
    return { wav, sampleRate };
}

/**
 * 음높이를 바꾸지 않고 소리를 빠르게 한다 (WSOLA: 겹쳐 잇기 + 파형이 가장 잘 맞는 자리 찾기).
 * 모델에 직접 빠르게 말하게 하면 1.3배쯤부터 말을 빼먹어(받아쓰기로 확인: 1.6배에서 원문의 43%만
 * 읽힘) 모델은 안정적인 속도까지만 쓰고, 나머지 배율은 여기서 맞춘다.
 */
function timeStretch(x, rate) {
    if (!(rate > 1.001) || x.length < 4096) return x;
    const N = 1536, Hs = N >> 1, tol = 384;          // 44.1kHz에서 약 35ms 창, 절반 겹침, ±9ms 탐색
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const outLen = Math.round(x.length / rate);
    const out = new Float32Array(outLen + N);
    for (let j = 0; j < N && j < x.length; j++) out[j] += x[j] * win[j];
    let prev = 0;
    // 겹치는 앞 절반이 바로 앞 조각의 자연스러운 이어짐과 가장 비슷한 자리를 고른다
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
        // 거칠게(4칸씩) 찾은 뒤 주변을 촘촘히 다듬는다 — 계산량을 1/8로 줄인다
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
                self.postMessage({ type: 'ready', backend, sampleRate: cfgs.ae.sample_rate });
            } else if (msg.type === 'synth') {
                const t0 = performance.now();
                const { wav: raw, sampleRate } = await synth(msg);
                const wav = (msg.stretch > 1.001) ? new Float32Array(timeStretch(raw, msg.stretch)) : raw;
                self.postMessage({ type: 'audio', id: msg.id, wav, sampleRate, ms: performance.now() - t0, steps: msg.steps }, [wav.buffer]);
            }
        } catch (err) {
            self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err), webgpuFailed: !!(err && err.webgpuFailed) });
        }
    });
};
