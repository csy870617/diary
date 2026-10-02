/**
 * 자연스러운 음성(Supertonic 3) — 내려받기·생성·재생
 *
 * 음성 모델(약 440MB)은 같은 주소 아래의 별도 저장소(faith-voice)에 두고,
 * 사용자가 원할 때 한 번만 내려받아 브라우저 저장소(Cache Storage)에 보관한다.
 * 받은 뒤에는 인터넷 없이 기기 안에서 음성을 만든다(서버·이용료 없음).
 *
 * GitHub는 파일 하나에 100MB 제한이 있어 큰 모델은 조각으로 올려 두었다.
 * manifest.json에 조각 목록이 있고, 받을 때 다시 하나로 합쳐 저장한다.
 */

const CACHE_NAME = 'faith-voice-v1';
const READY_KEY = 'faith_voice_ready';      // 받은 버전 (다 받았을 때만 기록)
export const NEURAL_PREFIX = 'st:';          // 음성 목록에서 자연스러운 음성을 구분하는 접두어

export const NEURAL_VOICES = [
    { id: 'F1', label: '여성 1' }, { id: 'F2', label: '여성 2' }, { id: 'F3', label: '여성 3' },
    { id: 'F4', label: '여성 4' }, { id: 'F5', label: '여성 5' },
    { id: 'M1', label: '남성 1' }, { id: 'M2', label: '남성 2' }, { id: 'M3', label: '남성 3' },
    { id: 'M4', label: '남성 4' }, { id: 'M5', label: '남성 5' }
];

// 공식 예제 기본값. 앱의 1.0배속이 모델의 1.05에 해당한다.
const MODEL_BASE_SPEED = 1.05;
// 품질 단계(반복 횟수). 많을수록 곱지만 느리다. 기기 속도에 맞춰 4~8 사이에서 자동 조절한다.
// (측정: 단계 8은 5보다 약 1.5배 느림. 느린 기기에서 8로 고정하면 문장 사이가 끊긴다)
const MAX_STEPS = 8, MIN_STEPS = 4;
let denoiseSteps = MAX_STEPS;
let backendName = null;
// 한국어는 한 번에 120자 안쪽으로 만들 때 가장 안정적이다(공식 예제 기준)
export const NEURAL_MAX_CHUNK = 120;
// 자연스러운 음성이 1배속에서 읽는 평균 글자 수/초 (측정값 약 6.5~7)
export const NEURAL_CHARS_PER_SEC = 7;

/** 음성 저장소 주소: 앱이 /diary/ 에 있으면 /faith-voice/ (같은 주소라 별도 허용 설정이 필요 없다) */
export function voiceBase() {
    try {
        const override = localStorage.getItem('faith_voice_base');
        if (override) return override.endsWith('/') ? override : override + '/';
    } catch (e) { /* 저장소 접근 불가 시 기본값 */ }
    return new URL('../faith-voice/', new URL('.', location.href)).href;
}

export function isNeuralVoice(value) {
    return typeof value === 'string' && value.startsWith(NEURAL_PREFIX);
}

function hasCacheStorage() {
    return typeof caches !== 'undefined' && typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined'
        || (typeof caches !== 'undefined' && typeof Worker !== 'undefined' && typeof webkitAudioContext !== 'undefined');
}

export function isNeuralSupported() {
    return hasCacheStorage();
}

async function fetchManifest() {
    const res = await fetch(voiceBase() + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('음성 목록을 불러오지 못했습니다 (' + res.status + ')');
    return res.json();
}

/**
 * 받아 둔 음성이 온전히 남아 있는가.
 * (아이폰 Safari는 오래 쓰지 않은 사이트의 저장 공간을 비울 수 있어 실제 파일까지 확인한다)
 */
export async function isNeuralReady() {
    if (!isNeuralSupported()) return false;
    let manifest;
    try { manifest = JSON.parse(localStorage.getItem(READY_KEY + '_manifest') || 'null'); } catch (e) { manifest = null; }
    if (!manifest || localStorage.getItem(READY_KEY) !== manifest.version) return false;
    try {
        const cache = await caches.open(CACHE_NAME);
        const base = voiceBase();
        for (const f of manifest.files) {
            if (!(await cache.match(base + f.path))) return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

export function neuralDownloadSize(manifest) {
    return manifest.files.reduce((s, f) => s + (f.size || 0), 0);
}

let downloadAbort = null;

/**
 * 음성 모델 전체를 내려받아 저장한다.
 * onProgress(받은 바이트, 전체 바이트)
 */
export async function downloadNeuralVoice(onProgress) {
    if (!isNeuralSupported()) throw new Error('이 브라우저에서는 자연스러운 음성을 쓸 수 없습니다.');
    const manifest = await fetchManifest();
    const total = neuralDownloadSize(manifest);
    // 저장 공간이 부족할 때 브라우저가 이 파일들을 먼저 지우지 않도록 요청 (거절돼도 계속 진행)
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    try {
        if (navigator.storage && navigator.storage.estimate) {
            const { quota, usage } = await navigator.storage.estimate();
            if (quota && usage != null && quota - usage < total * 1.1) {
                throw new Error(`기기 저장 공간이 부족합니다. 약 ${Math.ceil(total / 1e6)}MB가 필요합니다.`);
            }
        }
    } catch (e) {
        if (/저장 공간/.test(e.message)) throw e;
    }

    const controller = new AbortController();
    downloadAbort = controller;
    const base = voiceBase();
    const cache = await caches.open(CACHE_NAME);
    let done = 0;
    try {
        for (const f of manifest.files) {
            const url = base + f.path;
            // 이미 받은 파일은 건너뛴다 (중간에 끊겼다가 다시 받을 때)
            const existing = await cache.match(url);
            if (existing && f.size && Number(existing.headers.get('X-Size')) === f.size) {
                done += f.size; onProgress && onProgress(done, total);
                continue;
            }
            const parts = f.parts && f.parts.length ? f.parts : [f.path];
            const blobs = [];
            for (const part of parts) {
                // 휴대폰 네트워크에서는 큰 파일을 받다 끊기는 일이 흔하다. 조각 하나는 몇 번 다시 받아 본다.
                let partBlob = null;
                for (let attempt = 1; !partBlob; attempt++) {
                    const before = done;
                    try {
                        const res = await fetch(base + part, { signal: controller.signal, cache: 'no-cache' });
                        if (!res.ok) throw new Error(`음성 파일을 받지 못했습니다 (${res.status}): ${part}`);
                        const reader = res.body.getReader();
                        const chunks = [];
                        for (;;) {
                            const { done: end, value } = await reader.read();
                            if (end) break;
                            chunks.push(value);
                            done += value.byteLength;
                            onProgress && onProgress(Math.min(done, total), total);
                        }
                        partBlob = new Blob(chunks);
                    } catch (err) {
                        done = before;   // 이 조각은 처음부터 다시 받는다
                        if (controller.signal.aborted || attempt >= 3) throw err;
                        await new Promise(r => setTimeout(r, 2000 * attempt));
                    }
                }
                blobs.push(partBlob);
            }
            const blob = new Blob(blobs);
            if (f.size && blob.size !== f.size) throw new Error('받은 파일 크기가 맞지 않습니다: ' + f.path);
            await cache.put(url, new Response(blob, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Size': String(blob.size) } }));
        }
        localStorage.setItem(READY_KEY + '_manifest', JSON.stringify(manifest));
        localStorage.setItem(READY_KEY, manifest.version);
        return manifest;
    } finally {
        downloadAbort = null;
    }
}

export function cancelNeuralDownload() {
    if (downloadAbort) downloadAbort.abort();
}

export async function deleteNeuralVoice() {
    shutdownNeural();
    try { await caches.delete(CACHE_NAME); } catch (e) {}
    localStorage.removeItem(READY_KEY);
    localStorage.removeItem(READY_KEY + '_manifest');
}

// ─── 생성 (작업자) ───────────────────────────────────────────────

let worker = null;
let workerReady = null;     // Promise<backend>
let reqSeq = 0;
const pending = new Map();  // id → { resolve, reject }

function spawnWorker(forceWasm) {
    const w = new Worker(new URL('./neural-tts-worker.js', import.meta.url));
    w.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'ready' || (d.type === 'error' && d.id == null)) return; // init 응답은 아래에서 처리
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        if (d.type === 'audio') {
            adaptSteps(d.wav.length / d.sampleRate, (d.ms || 0) / 1000, d.steps);
            p.resolve({ wav: d.wav, sampleRate: d.sampleRate });
        }
        else if (d.type === 'skipped') p.resolve(null);
        else p.reject(new Error(d.message || '음성을 만들지 못했습니다.'));
    };
    const ready = new Promise((resolve, reject) => {
        const h = (e) => {
            const d = e.data || {};
            if (d.type === 'ready') { w.removeEventListener('message', h); resolve(d.backend); }
            else if (d.type === 'error' && d.id == null) { w.removeEventListener('message', h); reject(d); }
        };
        w.addEventListener('message', h);
    });
    w.postMessage({ type: 'init', base: voiceBase(), cacheName: CACHE_NAME, forceWasm: !!forceWasm });
    return { w, ready };
}

/**
 * 만드는 속도가 읽는 속도를 못 따라가면 품질 단계를 낮추고, 여유가 많으면 다시 올린다.
 * (지금 문장을 읽는 동안 다음 문장을 만들기 때문에 1배보다 조금만 빠르면 끊기지 않는다)
 */
function adaptSteps(audioSec, genSec, stepsUsed) {
    if (!(audioSec > 0.5) || !(genSec > 0) || !stepsUsed) return;   // 아주 짧은 문장은 판단 근거로 쓰지 않는다
    // 만드는 시간 ≈ 고정 부분(약 17%) + 단계 수 × 단계당 시간 (측정: 단계 8→11.4초, 5→7.6초, 4→6.5초)
    const fixed = genSec * 0.17;
    const perStep = (genSec - fixed) / stepsUsed;
    // 읽는 시간보다 30% 빨리 만들 수 있는 가장 높은 단계
    const sustainable = Math.floor((audioSec / 1.3 - fixed) / perStep);
    const target = Math.max(MIN_STEPS, Math.min(MAX_STEPS, sustainable));
    if (target < denoiseSteps) denoiseSteps = target;         // 못 따라가면 곧바로 낮춘다
    else if (target > denoiseSteps) denoiseSteps++;           // 여유가 있으면 한 단계씩만 올린다
}

/** 재생이 다음 문장을 기다려야 했을 때(끊김) 품질을 한 단계 바로 낮춘다 */
export function lowerNeuralQuality() {
    if (denoiseSteps > MIN_STEPS) denoiseSteps--;
}

/** 진단용: 계산 장치와 지금 품질 단계 */
export function getNeuralInfo() {
    return { backend: backendName, steps: denoiseSteps };
}

export function isNeuralLoaded() {
    return !!backendName && !!worker;
}

/** 모델을 연다 (처음 한 번은 수 초 걸린다). WebGPU로 열다 실패하면 WASM으로 다시 연다. */
export function ensureNeuralReady() {
    if (workerReady) return workerReady;
    workerReady = (async () => {
        let { w, ready } = spawnWorker(false);
        worker = w;
        try {
            backendName = await ready;
        } catch (err) {
            w.terminate();
            if (!err.webgpuFailed) throw new Error(err.message || '자연스러운 음성을 열지 못했습니다.');
            ({ w, ready } = spawnWorker(true));
            worker = w;
            backendName = await ready;
        }
        // GPU 없이 계산하는 기기는 중간 단계에서 시작한다 (빠르면 자동으로 올라간다)
        denoiseSteps = backendName === 'webgpu' ? MAX_STEPS : 5;
        return backendName;
    })();
    workerReady.catch(() => { shutdownNeural(); });
    return workerReady;
}

export function shutdownNeural() {
    if (worker) worker.terminate();
    worker = null;
    workerReady = null;
    backendName = null;
    pending.forEach(p => p.resolve(null));
    pending.clear();
    stopNeuralAudio();
}

/** 문장 하나를 음성으로 만든다. 버려진 세대면 null */
export async function synthesizeNeural(text, voiceValue, appSpeed, gen) {
    await ensureNeuralReady();
    const id = ++reqSeq;
    const style = voiceValue.slice(NEURAL_PREFIX.length) || 'F1';
    const speed = Math.max(0.5, Math.min(2.0, MODEL_BASE_SPEED * (appSpeed || 1)));
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'synth', id, gen, text, lang: 'ko', style, speed, steps: denoiseSteps });
    });
}

/** 정지·탐색 시: 이 세대보다 오래된 대기 요청은 만들지 않게 한다 */
export function cancelNeuralBefore(gen) {
    if (worker) worker.postMessage({ type: 'cancelBefore', gen });
}

// ─── 재생 (Web Audio) ────────────────────────────────────────────

let audioCtx = null;
let currentSource = null;

/** 재생 버튼을 누른 순간(사용자 동작 안)에 불러야 아이폰에서 소리가 난다 */
export function unlockNeuralAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
}

/** 만든 음성을 재생하고, 끝나면 resolve(true). 중간에 멈추면 resolve(false) */
export function playNeuralAudio(wav, sampleRate) {
    const ctx = unlockNeuralAudio();
    stopNeuralAudio();
    const buf = ctx.createBuffer(1, wav.length, sampleRate);
    buf.copyToChannel(wav, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    currentSource = src;
    return new Promise((resolve) => {
        src.onended = () => {
            const finished = currentSource === src;
            if (finished) currentSource = null;
            resolve(finished && !src._stopped);
        };
        src.start();
    });
}

export function stopNeuralAudio() {
    if (currentSource) {
        currentSource._stopped = true;
        try { currentSource.stop(); } catch (e) {}
        currentSource = null;
    }
    // 일시정지 상태에서 멈췄다면 다음 재생을 위해 다시 깨워 둔다
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

export function pauseNeuralAudio() {
    if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
}

export function resumeNeuralAudio() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
