/**
 * 자연스러운 음성(Supertonic 3) — 내려받기·생성·재생
 *
 * 음성 모델(약 250~500MB)은 같은 주소 아래의 별도 저장소(faith-voice)에 두고,
 * 사용자가 원할 때 한 번만 내려받아 브라우저 저장소(Cache Storage)에 보관한다.
 * 받은 뒤에는 인터넷 없이 기기 안에서 음성을 만든다(서버·이용료 없음).
 *
 * GitHub는 파일 하나에 100MB 제한이 있어 큰 모델은 조각으로 올려 두었다.
 * manifest.json에 조각 목록이 있고, 받을 때 다시 하나로 합쳐 저장한다.
 */

// 받은 음성은 이 앱만 쓰는 IndexedDB(diary-voice)에 둔다.
// 같은 주소(csy870617.github.io)의 다른 앱들과 브라우저 저장소를 함께 쓰는데, 그 앱들이
// 업데이트할 때 '자기 것이 아닌 Cache Storage'를 모두 지우거나(FAITHS·stock),
// 예전 이름(faith-voice-v1·faith_voice_ready)을 자기 옛 음성으로 알고 지워서(engo)
// 받아 둔 음성이 자꾸 사라졌다. IndexedDB의 이 이름은 다른 앱이 건드리지 않는다.
const DB_NAME = 'diary-voice';
const DB_STORE = 'files';
const READY_REC = '__ready__';                // 다 받았을 때만 남기는 목록(manifest)
const OLD_CACHE_NAME = 'faith-voice-v1';      // 예전 저장 위치 (남아 있으면 옮겨 온다)
const OLD_READY_KEY = 'faith_voice_ready';
export const NEURAL_PREFIX = 'st:';          // 음성 목록에서 자연스러운 음성을 구분하는 접두어

// 목소리 이름은 소리에서 잰 값으로 붙였다 (문장 4개 × 2번, 품질 8단계, 같은 성별끼리 견줌):
//          높이(Hz) 억양 폭(반음) 빠르기(음절/초) 밝기(고음 대 저음, dB) 크기 변화(dB)
//   F1      196      8.3        4.71          -12.1             8.6   — 모든 값이 가운데, 숨소리가 가장 적어 맑다
//   F2      236      9.5        5.02           -7.9            10.9   — 가장 높고 밝고 억양·크기 변화가 크다
//   F3      182     10.1        4.57          -16.6            10.5   — 억양 폭이 가장 넓고 가장 느리다
//   F4      198      5.7        5.49           -8.8             9.1   — 억양이 가장 평평하고 가장 빠르다
//   F5      166      7.8        4.86          -20.5             7.7   — 가장 낮고 어둡고(따뜻) 고르다
//   M1      153      9.1        4.71           -8.0             8.1   — 남성 중 가장 높고 밝으며 숨결이 많다
//   M2       94      7.7        4.81           -9.9             9.8   — 낮지만 밝은 편이고 숨결이 섞였다
//   M3      104      7.8        5.71          -12.4             5.7   — 가장 빠르고 크기 변화가 가장 적다
//   M4      123      9.2        5.03          -16.0             8.3   — 가운데 높이, 어두운(따뜻한) 음색, 억양 폭이 넓다
//   M5       91      8.3        4.72          -18.5             6.4   — 가장 낮고 가장 어둡고 고르다
export const NEURAL_VOICES = [
    { id: 'F1', label: '여성 · 맑고 단정한 기본 목소리' },
    { id: 'F2', label: '여성 · 높고 밝은, 생기 있는 목소리' },
    { id: 'F3', label: '여성 · 부드럽고 느긋한, 억양이 풍부한 목소리' },
    { id: 'F4', label: '여성 · 또렷하고 담담한, 조금 빠른 목소리' },
    { id: 'F5', label: '여성 · 낮고 차분한, 따뜻한 목소리' },
    { id: 'M1', label: '남성 · 밝고 부드러운, 젊은 목소리' },
    { id: 'M2', label: '남성 · 낮고 부드러운 목소리' },
    { id: 'M3', label: '남성 · 담담하고 고른, 조금 빠른 목소리' },
    { id: 'M4', label: '남성 · 따뜻한 중저음, 억양이 풍부한 목소리' },
    { id: 'M5', label: '남성 · 가장 낮고 묵직한, 차분한 목소리' }
];

// 공식 예제 기본값. 앱의 1.0배속이 모델의 1.05에 해당한다.
const MODEL_BASE_SPEED = 1.05;
// 모델에 맡기는 최대 속도. 모델에 빠르게 말하게 하면 말을 빼먹는다(받아쓰기로 확인: 1.37배 91%,
// 1.68배 43%, 2.1배 30%만 읽힘). 예전에는 1.2배까지 맡겼는데, 그래도 짧은 문장일수록 끝이 잘렸다
// (1.5·2배속 받아쓰기: '정말 감사한 하루였다!' → '정말 간', '많았다.' → '많았' 등 문장 60개 중 4개, 글자 오류 2.5~2.8%).
// 이제 모델은 제 빠르기로만 말하고, 빠르게 듣는 배율은 모두 만든 소리를 음높이 그대로 빠르게 해서 맞춘다
// (작업자의 timeStretch). 같은 시험에서 끝이 틀린 문장 1개, 글자 오류 1.2~1.3%.
const MODEL_MAX_SPEED = MODEL_BASE_SPEED;
// 품질 단계(반복 횟수). 많을수록 곱지만 느리다. 기기 속도에 맞춰 4~8 사이에서 자동 조절한다.
// (측정: 단계 8은 5보다 약 1.5배 느림. 느린 기기에서 8로 고정하면 문장 사이가 끊긴다)
const MAX_STEPS = 8, MIN_STEPS = 4;
let denoiseSteps = MAX_STEPS;
let backendName = null;
// 한 번에 만드는 최대 글자 수. 한국어는 120자 안쪽이 안정적이지만(공식 예제), 긴 조각은
// 작업자 하나가 오래 붙잡고 있어 다음 조각이 늦어진다. 90자로 나눠 여러 작업자가 동시에 만들게 한다.
export const NEURAL_MAX_CHUNK = 90;
// 자연스러운 음성이 1배속에서 읽는 평균 글자 수/초 — 문장 앞뒤 무음을 걷어 낸 소리 기준
// (측정: 문장 20개 × 목소리 4개, 7.6. 문장 사이 쉼은 tts.js가 따로 더한다)
export const NEURAL_CHARS_PER_SEC = 7.6;

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

export function isNeuralSupported() {
    return typeof indexedDB !== 'undefined' && typeof Worker !== 'undefined'
        && (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined');
}

async function fetchManifest(timeoutMs) {
    const ctl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
        const res = await fetch(voiceBase() + 'manifest.json', { cache: 'no-cache', signal: ctl.signal });
        if (!res.ok) throw new Error('음성 목록을 불러오지 못했습니다 (' + res.status + ')');
        return await res.json();
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// 이 기기가 GPU(WebGPU)로 계산할 수 있는가 — 받을 파일을 고를 때 쓴다
let gpuCheck = null;
function hasWebGPU() {
    if (!gpuCheck) {
        gpuCheck = (async () => {
            try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { return false; }
        })();
    }
    return gpuCheck;
}

/**
 * 이 기기에 필요한 파일만 고른다.
 * 계산량이 가장 큰 모델은 두 가지가 있다: 원본(GPU용, 257MB)과 8비트(CPU용, 66MB).
 * CPU로 계산하는 기기는 8비트가 두 배 넘게 빠르고 받을 용량도 4분의 1이라 원본을 받지 않는다.
 * (8비트는 계산할 때마다 값의 범위를 새로 재는 '동적 양자화'판 — 소리는 원본에 가깝다. faith-voice/README.md)
 */
async function applicableFiles(manifest) {
    const gpu = await hasWebGPU();
    return manifest.files.filter(f => !f.only || (f.only === 'webgpu' && gpu));
}

// ─── 저장소 (IndexedDB) ───
// 파일 하나 = { blob, size, type }, 열쇠는 음성 저장소 안의 경로(예: 'onnx/vocoder.onnx')
let dbPromise = null;
function openDb() {
    if (!dbPromise) {
        const open = (version) => new Promise((resolve, reject) => {
            const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => { db.close(); dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('저장소를 열 수 없습니다'));
        });
        dbPromise = (async () => {
            let db = await open();
            // 파일 칸이 없는 채로 만들어진 저장소면 판을 올려 칸을 만든다
            if (!db.objectStoreNames.contains(DB_STORE)) {
                const v = db.version + 1;
                db.close();
                db = await open(v);
            }
            return db;
        })();
        dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
}
async function dbDo(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('저장하지 못했습니다'));
    });
}
const dbGet = (key) => dbDo('readonly', st => st.get(key));
const dbPut = (key, val) => dbDo('readwrite', st => st.put(val, key));
const dbDel = (key) => dbDo('readwrite', st => st.delete(key));
const dbKeys = () => dbDo('readonly', st => st.getAllKeys());
const dbClear = () => dbDo('readwrite', st => st.clear());

/** 이 파일을 온전히 받아 두었는가 (크기까지 맞아야 한다) */
async function hasFile(f) {
    const rec = await dbGet(f.path);
    return !!(rec && rec.blob && (!f.size || rec.size === f.size));
}

let evictedNotice = false;   // 받아 둔 기록은 있는데 파일이 사라졌다 (브라우저가 저장 공간을 비움)

/** 받아 둔 목록(manifest) — 다 받았을 때만 남는다 */
async function storedManifest() {
    try {
        const m = await dbGet(READY_REC);
        return m && m.version && Array.isArray(m.files) ? m : null;
    } catch (e) { return null; }
}

/**
 * 예전 저장 위치(Cache Storage)에 받아 둔 음성이 남아 있으면 새 저장소로 옮긴다 (다시 받지 않도록).
 * 옮긴 뒤 예전 사본은 지워 저장 공간을 돌려준다.
 */
let migrating = null;
function migrateFromOldCache() {
    if (!migrating) migrating = (async () => {
        if (typeof caches === 'undefined') return false;
        let manifest = null;
        try { manifest = JSON.parse(localStorage.getItem(OLD_READY_KEY + '_manifest') || 'null'); } catch (e) { manifest = null; }
        const base = voiceBase();
        if (!(await caches.has(OLD_CACHE_NAME))) return false;
        const cache = await caches.open(OLD_CACHE_NAME);
        if (!manifest) {
            const res = await cache.match(base + '__faith_ready__.json');
            manifest = res ? await res.json().catch(() => null) : null;
        }
        if (!manifest || !Array.isArray(manifest.files)) return false;
        for (const f of manifest.files) {
            const res = await cache.match(base + f.path);
            if (!res) return false;
            const blob = await res.blob();
            if (f.size && blob.size !== f.size) return false;
            await dbPut(f.path, { blob, size: blob.size, type: f.type || 'application/octet-stream' });
        }
        await dbPut(READY_REC, manifest);
        try { await caches.delete(OLD_CACHE_NAME); } catch (e) {}
        try { localStorage.removeItem(OLD_READY_KEY); localStorage.removeItem(OLD_READY_KEY + '_manifest'); } catch (e) {}
        return true;
    })().catch((e) => { console.warn('예전 음성 옮기기 실패:', e); return false; }).finally(() => { migrating = null; });
    return migrating;
}

/**
 * 받아 둔 음성이 온전히 남아 있는가.
 * (아이폰 Safari는 오래 쓰지 않은 사이트의 저장 공간을 비울 수 있어 실제 파일까지 확인한다)
 */
export async function isNeuralReady() {
    if (!isNeuralSupported()) return false;
    let manifest = await storedManifest();
    if (!manifest && await migrateFromOldCache()) manifest = await storedManifest();
    if (!manifest) return false;
    try {
        for (const f of manifest.files) {
            if (!(await hasFile(f))) { evictedNotice = true; return false; }
        }
        evictedNotice = false;
        return true;
    } catch (e) {
        return false;
    }
}

/** 받아 둔 기록은 있는데 파일이 사라졌는가 (화면에 이유를 알려 주는 데 쓴다) */
export function neuralWasEvicted() { return evictedNotice; }

/**
 * 받은 파일을 브라우저가 지우기 쉬운 환경인가.
 * 카카오톡·네이버 등 앱 안 브라우저는 앱을 다시 열 때마다 저장 공간을 비우는 경우가 많다.
 */
export function inAppBrowserName() {
    const ua = navigator.userAgent || '';
    if (/KAKAOTALK/i.test(ua)) return '카카오톡';
    if (/NAVER\(inapp|NAVER\//i.test(ua)) return '네이버 앱';
    if (/DaumApps/i.test(ua)) return '다음 앱';
    if (/Instagram/i.test(ua)) return '인스타그램';
    if (/FBAN|FBAV/i.test(ua)) return '페이스북';
    if (/\bLine\//i.test(ua)) return '라인';
    if (/everytimeApp|BAND\//i.test(ua)) return '앱';
    return '';
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
    const remote = await fetchManifest();
    const manifest = { ...remote, files: await applicableFiles(remote) };
    // 이미 받아 둔 파일은 다시 받지 않으므로, 실제로 받을 양만 센다 (업데이트 때 용량 확인용)
    let total = 0;
    try {
        for (const f of manifest.files) if (!(await hasFile(f))) total += f.size || 0;
    } catch (e) { total = neuralDownloadSize(manifest); }
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
    await openDb();   // 저장소를 열 수 없으면 받기 전에 알린다
    let done = 0;
    try {
        for (const f of manifest.files) {
            // 이미 받은 파일은 건너뛴다 (중간에 끊겼다가 다시 받을 때, 업데이트 때)
            if (await hasFile(f)) continue;
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
            await dbPut(f.path, { blob, size: blob.size, type: f.type || 'application/octet-stream' });
        }
        // 이 기기에 더는 필요 없는 파일(예: CPU 기기에 남은 원본 모델 257MB)은 지운다
        try {
            const keep = new Set(manifest.files.map(f => f.path));
            for (const k of await dbKeys()) if (k !== READY_REC && !keep.has(k)) await dbDel(k);
        } catch (e) { /* 정리는 실패해도 괜찮다 */ }
        await dbPut(READY_REC, manifest);
        // 예전 저장 위치에 남은 사본은 지운다
        try { if (typeof caches !== 'undefined') await caches.delete(OLD_CACHE_NAME); } catch (e) {}
        evictedNotice = false;
        // 새 엔진을 쓰도록 열려 있던 작업자를 닫는다 (다음 재생 때 다시 연다)
        shutdownNeural();
        return manifest;
    } finally {
        downloadAbort = null;
    }
}

/**
 * 받아 둔 음성보다 새 버전(예: 더 빠른 엔진)이 있으면 { bytes }를, 없거나 확인할 수 없으면 null.
 * (인터넷이 없거나 느리면 조용히 넘어간다)
 */
export async function checkNeuralUpdate() {
    if (!navigator.onLine) return null;
    const stored = await storedManifest();
    if (!stored) return null;
    try {
        const remote = await fetchManifest(5000);
        if (!remote || remote.version === stored.version) return null;
        const files = await applicableFiles(remote);
        let bytes = 0;
        for (const f of files) if (!(await hasFile(f))) bytes += f.size || 0;
        // note: 무엇이 좋아졌는지 한 줄 (예: '더 자연스러운 음성') — 목록(manifest.json)의 updateNote
        return { bytes, version: remote.version, note: typeof remote.updateNote === 'string' ? remote.updateNote : '' };
    } catch (e) {
        return null;
    }
}

export function cancelNeuralDownload() {
    if (downloadAbort) downloadAbort.abort();
}

export async function deleteNeuralVoice() {
    shutdownNeural();
    try { await dbClear(); } catch (e) {}
    try { if (typeof caches !== 'undefined') await caches.delete(OLD_CACHE_NAME); } catch (e) {}
    evictedNotice = false;
}

// ─── 생성 (작업자) ───────────────────────────────────────────────
// GPU로 계산하는 기기: 작업자 1개가 전부 처리한다 (GPU가 알아서 병렬로 계산).
// CPU로 계산하는 기기: 브라우저의 다중 스레드는 GitHub Pages에서 쓸 수 없어(필요한 헤더를 못 줌)
// 예전에는 코어 하나만 썼다. 대신 작업자를 여러 개 띄워 나눠 맡긴다 —
//   '음성 생성'(acoustic) 작업자 1~2개가 문장들을 동시에 만들고,
//   '보코더' 작업자 1개가 그 결과를 소리로 바꾼다.
// 측정(4코어, 8비트, 품질 4): 작업자 1개 실시간의 1.44배 → 생성2+보코더1 2.74배.

let workers = [];           // [{ w, role, n }] — n: 맡긴 일 수
let workerReady = null;     // Promise<backend>
let modelName = null;       // 'int8' | 'fp32'
let poolMode = false;       // CPU 작업자 여러 개로 나눠 맡기는가

// ─── 진단 기록 ───
// 최근 문장들의 만드는 시간·소리 길이·대기 시간을 남긴다 (빠른 속도 시작 단계 판단 등에 쓴다).
const DIAG_MAX = 40;
const diagLog = [];
export function addNeuralDiag(ev) {
    diagLog.push({ t: Date.now(), ...ev });
    if (diagLog.length > DIAG_MAX) diagLog.shift();
}
let reqSeq = 0;
const pending = new Map();  // id → { resolve, reject, chars, stretch, acMs, parts }

function workerUrl() {
    // 이 파일과 같은 버전(?v=…)으로 작업자를 불러온다 (캐시에 남은 옛 작업자와 섞이지 않게)
    return new URL('./neural-tts-worker.js' + new URL(import.meta.url).search, import.meta.url);
}

function finishAudio(p, d, genSec) {
    const audioSec = d.wav.length / d.sampleRate;
    addNeuralDiag({ type: 'synth', chars: p.chars, audioSec, genSec, steps: p.steps, stretch: p.stretch, parts: p.parts || d.parts });
    // 이 문장을 읽는 시간과 뒤의 쉼 동안 다음 문장을 만든다
    adaptSteps(audioSec + (p.pauseSec || 0), genSec, p.steps);
    p.resolve({ wav: d.wav, sampleRate: d.sampleRate });
}

function spawnWorker(role, forceWasm) {
    const entry = { w: new Worker(workerUrl()), role, n: 0 };
    const w = entry.w;
    w.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'ready' || (d.type === 'error' && d.id == null)) return; // init 응답은 아래에서 처리
        const p = pending.get(d.id);
        if (!p) return;
        entry.n = Math.max(0, entry.n - 1);
        if (d.type === 'latent') {
            // 음성 생성 작업자가 끝낸 것 → 보코더 작업자에게 넘긴다 (그동안 이 작업자는 다음 문장을 만든다)
            p.acMs = d.ms || 0;
            p.parts = d.parts;
            const voc = workers.find(x => x.role === 'vocoder');
            if (!voc) { pending.delete(d.id); p.resolve(null); return; }
            voc.n++;
            voc.w.postMessage({ type: 'vocode', id: d.id, latent: d.latent, latentDim: d.latentDim, latentLen: d.latentLen,
                                wavLen: d.wavLen, stretch: p.stretch }, [d.latent.buffer]);
            return;
        }
        pending.delete(d.id);
        if (d.type === 'audio') {
            // 나눠 맡길 때 실제 처리 속도는 '가장 느린 단계'가 정한다 (생성은 작업자 수만큼 동시에 돈다)
            const nAc = Math.max(1, workers.filter(x => x.role === 'acoustic').length);
            const genSec = role === 'vocoder'
                ? Math.max((p.acMs || 0) / nAc, d.vocMs || 0) / 1000
                : (d.ms || 0) / 1000;
            if (role === 'vocoder' && p.parts) p.parts = { ...p.parts, voc: d.vocMs || 0 };
            finishAudio(p, d, genSec);
        }
        else if (d.type === 'skipped') p.resolve(null);
        else p.reject(new Error(d.message || '음성을 만들지 못했습니다.'));
    };
    entry.ready = new Promise((resolve, reject) => {
        const h = (e) => {
            const d = e.data || {};
            if (d.type === 'ready') { w.removeEventListener('message', h); if (d.model) modelName = d.model; resolve(d.backend); }
            else if (d.type === 'error' && d.id == null) { w.removeEventListener('message', h); reject(d); }
        };
        w.addEventListener('message', h);
    });
    w.postMessage({ type: 'init', dbName: DB_NAME, dbStore: DB_STORE, forceWasm: !!forceWasm, role });
    return entry;
}

/** CPU 기기: 코어 수에 맞춰 음성 생성 작업자 1~2개 + 보코더 1개 */
async function startPool() {
    // 측정(파일을 받아 둔 상태): 작업자 1개 약 570MB·실시간 1.5배 / 생성1+보코더1 약 750MB·2.0배 /
    // 생성2+보코더1 약 1,070MB·2.5배. 기본은 생성1+보코더1, 코어·메모리가 넉넉하다고 확인된 기기만 생성 2개.
    // (아이폰 등은 메모리 크기를 알려 주지 않으므로 기본값)
    const cores = navigator.hardwareConcurrency || 2;
    const mem = navigator.deviceMemory;
    let nAc = (cores >= 6 && mem >= 6) ? 2 : 1;
    try { const o = Number(localStorage.getItem('faith_voice_workers')); if (o === 1 || o === 2) nAc = o; } catch (e) {}
    workers = [];
    for (let k = 0; k < nAc; k++) workers.push(spawnWorker('acoustic', true));
    workers.push(spawnWorker('vocoder', true));
    poolMode = true;
    try {
        await Promise.all(workers.map(x => x.ready));
    } catch (err) {
        // 메모리가 부족해 여러 개를 못 열면 작업자 1개로 다시 연다
        workers.forEach(x => x.w.terminate());
        workers = [spawnWorker('full', true)];
        poolMode = false;
        await workers[0].ready;
    }
    return 'wasm';
}

async function gpuWillBeUsed() {
    if (!(await hasWebGPU())) return false;
    try {
        return !!(await dbGet('onnx/vector_estimator.onnx'));
    } catch (e) { return false; }
}

/**
 * 만드는 속도가 읽는 속도를 못 따라가면 품질 단계를 낮추고, 여유가 많으면 다시 올린다.
 * (지금 문장을 읽는 동안 다음 문장을 만들기 때문에 1배보다 조금만 빠르면 끊기지 않는다)
 */
function adaptSteps(audioSec, genSec, stepsUsed) {
    if (!(audioSec > 0.5) || !(genSec > 0) || !stepsUsed) return;   // 아주 짧은 문장은 판단 근거로 쓰지 않는다
    // 만드는 시간 ≈ 고정 부분 + 단계 수 × 단계당 시간
    // (측정: 원본은 고정 부분이 약 17%, 8비트는 단계 계산이 빨라져 약 30% — 그 사이 값을 쓴다)
    const fixed = genSec * 0.22;
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

export function getNeuralMinSteps() { return MIN_STEPS; }

export function isNeuralLoaded() {
    return !!backendName && workers.length > 0;
}

/** 모델을 연다 (처음 한 번은 수 초 걸린다). WebGPU로 열다 실패하면 CPU 작업자들로 다시 연다. */
export function ensureNeuralReady() {
    if (workerReady) return workerReady;
    workerReady = (async () => {
        if (await gpuWillBeUsed()) {
            const full = spawnWorker('full', false);
            workers = [full];
            poolMode = false;
            try {
                backendName = await full.ready;
            } catch (err) {
                full.w.terminate();
                if (!err.webgpuFailed) throw new Error(err.message || '자연스러운 음성을 열지 못했습니다.');
                backendName = await startPool();
            }
        } else {
            backendName = await startPool();
        }
        // GPU 없이 계산하는 기기는 중간 단계에서 시작한다 (빠르면 자동으로 올라가고, 못 따라가면 내려간다)
        // 측정(자연스러움 점수, 원본 8단계 3.92): CPU용 모델 4단계 3.11 · 5단계 3.42 · 6단계 3.73 · 8단계 3.86.
        // 5→6단계의 차이가 가장 크고, 지금 CPU용 모델은 단계당 계산이 예전보다 약 15% 빨라 6단계도 예전 5단계만큼 걸린다.
        denoiseSteps = backendName === 'webgpu' ? MAX_STEPS : 6;
        return backendName;
    })();
    workerReady.catch(() => { shutdownNeural(); });
    return workerReady;
}

export function shutdownNeural() {
    workers.forEach(x => x.w.terminate());
    workers = [];
    poolMode = false;
    workerReady = null;
    backendName = null;
    modelName = null;
    pending.forEach(p => p.resolve(null));
    pending.clear();
    stopNeuralAudio();
}

/**
 * 문장 하나를 음성으로 만든다. 버려진 세대면 null.
 * pauseSec: 이 문장 뒤에 쉬는 시간(초) — 그동안에도 다음 문장을 만들 수 있어 품질 단계 조절에 쓴다
 */
export async function synthesizeNeural(text, voiceValue, appSpeed, gen, pauseSec = 0) {
    await ensureNeuralReady();
    const id = ++reqSeq;
    const style = voiceValue.slice(NEURAL_PREFIX.length) || 'F1';
    const total = Math.max(0.5, Math.min(2.5, MODEL_BASE_SPEED * (appSpeed || 1)));
    const speed = Math.min(total, MODEL_MAX_SPEED);
    const stretch = total / speed;
    // 빠르게 들을수록 같은 시간에 더 많이 만들어야 한다. CPU 기기에서 1.4배 이상이면 처음부터 가장 빠른 단계로.
    if (backendName !== 'webgpu' && (appSpeed || 1) >= 1.4 && denoiseSteps > MIN_STEPS && !diagLog.some(e => e.type === 'synth')) denoiseSteps = MIN_STEPS;
    const steps = denoiseSteps;
    // 맡긴 일이 가장 적은 생성 작업자에게 (GPU 기기는 작업자 1개)
    const target = workers.filter(x => x.role !== 'vocoder').reduce((a, b) => (a.n <= b.n ? a : b));
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, chars: text.length, stretch, steps, pauseSec });
        target.n++;
        target.w.postMessage({ type: 'synth', id, gen, text, lang: 'ko', style, speed, stretch, steps });
    });
}

/** 정지·탐색 시: 이 세대보다 오래된 대기 요청은 만들지 않게 한다 */
export function cancelNeuralBefore(gen) {
    workers.forEach(x => x.w.postMessage({ type: 'cancelBefore', gen }));
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
