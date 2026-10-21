/**
 * Gemini(구글 AI) 연결 — 사용자가 자기 Gemini API 키를 넣어 쓴다.
 *
 * 개인정보: Gemini 무료 등급에서는 보낸 글이 Google 서비스 개선에 쓰이고 사람이 읽을 수도 있다
 * (가격표의 '제품 개선에 사용: 예'). 신앙일지는 개인적인 기록이라 결제를 연결한 '유료 등급' 키만 받는다.
 *  - 연결할 때 사용자가 유료 등급 키임을 직접 확인(체크)한다.
 *  - 무료 등급에서는 쓸 수 없는 모델(PAID_PROBE_MODEL)을 아주 짧게 불러 등급을 살핀다.
 *    무료 등급이라는 답이 오면 연결하지 않는다. 결제를 끊으면 무료 등급으로 돌아가므로 하루에 한 번 다시 살핀다.
 *    (등급을 알려 주는 공식 기능은 없다. 답이 애매하면 사용자의 확인을 믿는다)
 *  - 요청마다 store:false — Interactions API는 기본으로 요청을 서버에 저장하므로 끈다.
 * 키는 이 기기 브라우저(localStorage)에만 두고 구글 드라이브로 동기화하지 않는다.
 *
 * 이 파일은 화면(DOM)을 건드리지 않는다. 연결 상태가 바뀌면 window에 'gemini-change'를 알린다.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_ITEM = 'faith_gemini_key';
const META_ITEM = 'faith_gemini_meta';      // { model, tier: 'paid'|'unknown', checkedAt, agreedAt }
export const GEMINI_AUDIO_DB = 'diary-gemini-voice';   // 받은 음성 저장소 (gemini-voice.js)

// 무료 등급에는 없는 모델 — 이 모델이 답하면 유료 등급이다 (8토큰까지만 받아 요금은 1원 미만)
const PAID_PROBE_MODEL = 'gemini-4-argon';
const RECHECK_MS = 24 * 60 * 60 * 1000;
export const SAMPLE_RATE = 24000;

export const GEMINI_TTS_MODELS = [
    { id: 'gemini-3.8-flash-tts', label: '가장 자연스럽게' },
    { id: 'gemini-3.8-flash-lite-tts', label: '빠르고 저렴하게' }
];
export const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-tts';

// 가격: 1백만 토큰당 달러(글자 입력 / 소리 출력). 소리는 1초에 25토큰.
// 2027년 1월 1일부터 두 배로 오른다고 공지되어 있다 (ai.google.dev/gemini-api/docs/pricing).
const PRICES = {
    'gemini-3.8-flash-tts':      [{ until: Date.UTC(2027, 0, 1), text: 0.5, audio: 9 }, { text: 1, audio: 18 }],
    'gemini-3.8-flash-lite-tts': [{ until: Date.UTC(2027, 0, 1), text: 0.5, audio: 6 }, { text: 1, audio: 12 }]
};
const AUDIO_TOKENS_PER_SEC = 25;
export const WON_PER_USD = 1400;

/** 소리 audioSec초(글자 chars자)를 만드는 데 드는 대략의 요금(원) */
export function estimateWon(audioSec, chars, model) {
    const table = PRICES[model] || PRICES[DEFAULT_TTS_MODEL];
    const now = Date.now();
    const p = table.find(x => !x.until || now < x.until);
    const usd = ((audioSec || 0) * AUDIO_TOKENS_PER_SEC * p.audio + (chars || 0) * p.text) / 1e6;
    return usd * WON_PER_USD;
}

export function wonPerMinute(model) {
    return estimateWon(60, 0, model);
}

export function formatWon(won) {
    if (!(won >= 1)) return '1원 미만';
    if (won < 100) return `약 ${Math.round(won)}원`;
    return `약 ${(Math.round(won / 10) * 10).toLocaleString('ko-KR')}원`;
}

// ─── 키·설정 보관 (이 기기에만) ───

function readMeta() {
    try { return JSON.parse(localStorage.getItem(META_ITEM) || '{}') || {}; } catch (e) { return {}; }
}

function writeMeta(meta) {
    try { localStorage.setItem(META_ITEM, JSON.stringify(meta)); } catch (e) { /* 저장 공간 문제 — 다음에 다시 살핀다 */ }
}

export function getGeminiKey() {
    try { return localStorage.getItem(KEY_ITEM) || ''; } catch (e) { return ''; }
}

export function isGeminiConnected() {
    return !!getGeminiKey();
}

export function getGeminiInfo() {
    const meta = readMeta();
    const key = getGeminiKey();
    return {
        connected: !!key,
        last4: key ? key.slice(-4) : '',
        model: PRICES[meta.model] ? meta.model : DEFAULT_TTS_MODEL,
        tier: meta.tier === 'paid' ? 'paid' : 'unknown',
        checkedAt: meta.checkedAt || 0
    };
}

export function setGeminiModel(model) {
    if (!PRICES[model]) return;
    const meta = readMeta();
    meta.model = model;
    writeMeta(meta);
    announce('model');
}

function announce(what, extra) {
    if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
    window.dispatchEvent(new CustomEvent('gemini-change', { detail: { what, ...extra } }));
}

/**
 * 키·설정과 이 기기에 저장한 Gemini 음성을 모두 지운다 (연결 해제·로그아웃·무료 등급 확인 시).
 * auto: 사용자가 누른 것이 아니라 무료 등급이 확인되어 앱이 끊은 경우 (읽던 쪽이 이유를 알린다)
 */
export async function forgetGemini({ auto = false } = {}) {
    try {
        localStorage.removeItem(KEY_ITEM);
        localStorage.removeItem(META_ITEM);
    } catch (e) { /* 저장소 접근 불가 */ }
    announce('disconnected', { auto });
    await deleteAudioDb();
}

function deleteAudioDb() {
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') { resolve(); return; }
        let timer = null;
        try {
            const req = indexedDB.deleteDatabase(GEMINI_AUDIO_DB);
            req.onsuccess = req.onerror = () => { clearTimeout(timer); resolve(); };
            // 열려 있는 연결이 닫히기를 기다리는 중 — 너무 오래 붙잡지 않는다 (닫히면 이어서 지워진다)
            req.onblocked = () => { timer = setTimeout(resolve, 3000); };
        } catch (e) { resolve(); }
    });
}

// ─── 오류 ───

export class GeminiError extends Error {
    constructor(kind, message, extra = {}) {
        super(message);
        this.name = 'GeminiError';
        this.kind = kind;
        Object.assign(this, extra);
    }
}

const MESSAGES = {
    invalid_key: 'Gemini 키가 올바르지 않습니다. AI Studio에서 복사한 키를 다시 확인해 주세요.',
    free_tier: '무료 등급 키로 확인되었습니다.\n개인정보 보호를 위해 무료 등급 키는 쓸 수 없습니다. AI Studio에서 이 키의 프로젝트에 결제를 연결(유료 등급)한 뒤 다시 연결해 주세요.',
    no_credit: 'Gemini 선불 잔액이 없습니다. AI Studio의 결제 화면에서 충전한 뒤 다시 시도해 주세요.',
    permission: '이 키로는 Gemini를 쓸 수 없습니다. 키의 사용 제한(허용한 API·웹사이트)에 Gemini API와 이 앱 주소가 들어 있는지 확인해 주세요.',
    region: '지금 계신 지역에서는 Gemini API를 쓸 수 없습니다.',
    rate_limit: 'Gemini에 요청이 잠시 몰렸습니다. 조금 뒤 다시 시도해 주세요.',
    quota: '오늘 쓸 수 있는 Gemini 사용량을 다 썼습니다. AI Studio에서 사용 한도를 확인해 주세요.',
    blocked: 'Gemini가 이 부분은 읽지 않았습니다(내용 정책).',
    server: 'Gemini 서버가 잠시 응답하지 않습니다. 조금 뒤 다시 시도해 주세요.',
    network: '인터넷에 연결되어 있지 않거나 Gemini에 접속하지 못했습니다.',
    timeout: 'Gemini가 너무 오래 응답하지 않습니다. 조금 뒤 다시 시도해 주세요.',
    not_found: 'Gemini 음성 모델을 찾지 못했습니다. 앱을 새로 고친 뒤 다시 시도해 주세요.',
    no_key: 'Gemini가 연결되어 있지 않습니다. 음성 설정에서 Gemini를 연결해 주세요.',
    bad_response: 'Gemini의 답에서 소리를 찾지 못했습니다. 다시 시도해 주세요.',
    bad_request: 'Gemini가 요청을 처리하지 못했습니다.'
};

const BLOCKED_CODES = new Set(['safety', 'recitation', 'language', 'prohibited_content', 'spii', 'blocklist', 'content_blocked']);
const FREE_RE = /free[\s_-]?tier/i;

function retryAfterMs(body, message) {
    const text = JSON.stringify(body || '') + ' ' + (message || '');
    const m = text.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/) || text.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
    return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
}

/**
 * 오류 답을 종류별로 나눈다. Gemini는 두 가지 모양으로 답한다:
 *  - Interactions API: { error: { code: 'rate_limit_exceeded', message } }
 *  - 키 확인 단계(구글 공통): [{ error: { code: 400, status: 'INVALID_ARGUMENT', message, details: [{ reason }] } }]
 */
export function classifyError(httpStatus, body) {
    let e = Array.isArray(body) ? body[0] : body;
    e = (e && e.error) || e || {};
    const code = typeof e.code === 'string' ? e.code.toLowerCase() : '';
    const status = String(e.status || '').toUpperCase();
    const message = String(e.message || '');
    const reasons = (Array.isArray(e.details) ? e.details : []).map(d => (d && d.reason) || '').join(' ');
    const everything = JSON.stringify(body || '');
    const make = (kind, extra) => new GeminiError(kind,
        MESSAGES[kind] + (kind === 'bad_request' && message ? `\n(${message.slice(0, 160)})` : ''),
        { httpStatus, code: code || status, detail: message, ...extra });

    if (/API_KEY_INVALID|API_KEY_EXPIRED/.test(reasons) || /api key (not valid|expired)/i.test(message)
        || httpStatus === 401 || code === 'authentication') return make('invalid_key');
    if (FREE_RE.test(everything)) return make('free_tier');
    if (httpStatus === 402 || code === 'payment_required') return make('no_credit');
    if (/BILLING_DISABLED|BILLING_NOT_ENABLED/.test(reasons)
        || ((code === 'failed_precondition' || status === 'FAILED_PRECONDITION') && /billing/i.test(message))) return make('free_tier');
    if (/location is not supported|not available in your (country|region)/i.test(message)) return make('region');
    if (BLOCKED_CODES.has(code)) return make('blocked');
    if (httpStatus === 403 || code === 'permission_denied' || status === 'PERMISSION_DENIED') return make('permission');
    if (httpStatus === 404 || code === 'not_found' || code === 'model_not_found') return make('not_found');
    if (code === 'quota_exceeded') return make('quota');
    if (httpStatus === 429 || status === 'RESOURCE_EXHAUSTED' || code === 'rate_limit_exceeded' || code === 'too_many_requests') {
        // 하루 한도를 넘긴 것은 기다려도 오늘은 풀리지 않는다
        if (/per ?day|daily/i.test(message) || /PerDay/.test(everything)) return make('quota');
        return make('rate_limit', { retryAfterMs: retryAfterMs(body, message) });
    }
    if (httpStatus >= 500 || code === 'api_error' || code === 'service_unavailable' || code === 'deadline_exceeded') return make('server');
    return make('bad_request');
}

// ─── 요청 ───

async function callApi(path, body, { key, signal, timeoutMs = 60000 } = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new GeminiError('network', MESSAGES.network);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    if (signal) {
        if (signal.aborted) ctl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        let res;
        try {
            res = await fetch(API + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify(body),
                signal: ctl.signal,
                cache: 'no-store'
            });
        } catch (err) {
            if (signal && signal.aborted) throw err;
            if (ctl.signal.aborted) throw new GeminiError('timeout', MESSAGES.timeout);
            throw new GeminiError('network', MESSAGES.network);
        }
        let data = null;
        try { data = await res.json(); } catch (err) {
            if (ctl.signal.aborted && !(signal && signal.aborted)) throw new GeminiError('timeout', MESSAGES.timeout);
            if (signal && signal.aborted) throw err;
        }
        if (!res.ok) throw classifyError(res.status, data);
        return data;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

// ─── 유료 등급 확인 ───

/** 'paid' | 'free' | 'unknown'. 키가 틀렸거나 잔액이 없거나 접속하지 못하면 오류를 던진다 */
async function probePaidTier(key) {
    try {
        await callApi('/interactions', {
            model: PAID_PROBE_MODEL,
            input: '1',
            generation_config: { thinking_level: 'low', max_output_tokens: 8 },
            store: false
        }, { key, timeoutMs: 30000 });
        return 'paid';
    } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        if (err.kind === 'free_tier') return 'free';
        // 무료 등급이 쓸 수 없는 모델을 부르면 '한도 0'으로 답한다
        if (/limit:\s*0\b/.test(err.detail || '')) return 'free';
        if (['invalid_key', 'no_credit', 'network', 'timeout'].includes(err.kind)) throw err;
        return 'unknown';
    }
}

let tierCheck = null;

/** 하루에 한 번 등급을 다시 살핀다. 무료 등급이면 연결을 끊고 오류를 던진다 (그 전에는 글을 보내지 않는다) */
function ensurePaidTier(key) {
    const meta = readMeta();
    if (meta.checkedAt && Date.now() - meta.checkedAt < RECHECK_MS) return Promise.resolve();
    if (!tierCheck) {
        tierCheck = (async () => {
            let tier;
            try {
                tier = await probePaidTier(key);
            } catch (err) {
                if (err.kind === 'invalid_key' || err.kind === 'no_credit') throw err;
                return;   // 잠시 접속이 안 되는 등 — 다음에 다시 살핀다
            }
            if (tier === 'free') {
                await forgetGemini({ auto: true });
                throw new GeminiError('free_tier', MESSAGES.free_tier + '\n(연결을 해제했습니다)', { disconnected: true });
            }
            const m = readMeta();
            if (tier === 'paid') m.tier = 'paid';
            m.checkedAt = Date.now();
            writeMeta(m);
        })().finally(() => { tierCheck = null; });
    }
    return tierCheck;
}

// ─── 음성 만들기 ───

function findAudioBlock(data) {
    let found = null;
    for (const step of (data && data.steps) || []) {
        for (const c of (step && step.content) || []) if (c && c.type === 'audio' && c.data) found = c;
    }
    if (!found) for (const o of (data && data.outputs) || []) if (o && o.type === 'audio' && o.data) found = o;
    return found;
}

async function base64ToBytes(b64) {
    try {
        const res = await fetch('data:application/octet-stream;base64,' + b64);
        return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
}

/** 받은 소리(WAV 또는 머리말 없는 16비트 PCM)를 { pcm: Int16Array, sampleRate }로 */
export function pcmFromBytes(bytes, fallbackRate = SAMPLE_RATE) {
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    let start = 0, end = bytes.length, rate = fallbackRate, channels = 1;
    if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let o = 12; o + 8 <= bytes.length;) {
            const id = tag(o);
            const size = view.getUint32(o + 4, true);
            if (id === 'fmt ') {
                channels = view.getUint16(o + 10, true) || 1;
                rate = view.getUint32(o + 12, true) || fallbackRate;
            } else if (id === 'data') {
                start = o + 8;
                end = Math.min(bytes.length, start + size);
                break;
            }
            o += 8 + size + (size & 1);
        }
    }
    const count = Math.floor((end - start) / 2);
    // Int16Array는 2바이트 경계에서만 만들 수 있다 — 어긋나 있으면 복사한다
    const aligned = ((bytes.byteOffset + start) & 1) === 0;
    let pcm = aligned
        ? new Int16Array(bytes.buffer, bytes.byteOffset + start, count)
        : new Int16Array(bytes.slice(start, start + count * 2).buffer);
    if (channels === 2) {
        const mono = new Int16Array(count >> 1);
        for (let i = 0; i < mono.length; i++) mono[i] = (pcm[2 * i] + pcm[2 * i + 1]) >> 1;
        pcm = mono;
    }
    return { pcm, sampleRate: rate };
}

async function speakWithKey(key, text, { voice, style, model, signal } = {}) {
    const content = { type: 'text', text };
    if (style) content.annotations = [{ type: 'speech_metadata', style }];
    const data = await callApi('/interactions', {
        model: PRICES[model] ? model : DEFAULT_TTS_MODEL,
        input: [{ type: 'user_input', content: [content] }],
        response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: SAMPLE_RATE },
        generation_config: { speech_config: [{ voice }] },
        store: false
    }, { key, signal, timeoutMs: 90000 });
    const block = findAudioBlock(data);
    if (!block) {
        // 소리 없이 끝났다 — 내용 정책으로 막혔는지 살핀다
        const why = (data && (data.error || (data.status !== 'completed' && data.status))) || null;
        if (why) {
            const err = classifyError(200, { error: typeof why === 'string' ? { code: why } : why });
            if (err.kind === 'blocked') throw err;
        }
        throw new GeminiError('bad_response', MESSAGES.bad_response);
    }
    const bytes = await base64ToBytes(block.data);
    const rateMatch = /rate=(\d+)/.exec(block.mime_type || '');
    return pcmFromBytes(bytes, rateMatch ? Number(rateMatch[1]) : SAMPLE_RATE);
}

/**
 * 저장된 키로 Gemini를 부르는 모든 기능이 거치는 길: 하루 한 번 유료 등급을 살핀 뒤에야 글을 보내고,
 * 무료 등급이라는 답이 오면 연결을 끊는다.
 */
async function withPaidKey(run) {
    const key = getGeminiKey();
    if (!key) throw new GeminiError('no_key', MESSAGES.no_key);
    await ensurePaidTier(key);
    try {
        return await run(key);
    } catch (err) {
        if (err instanceof GeminiError && err.kind === 'free_tier' && !err.disconnected) {
            await forgetGemini({ auto: true });
            err.disconnected = true;
            err.message += '\n(연결을 해제했습니다)';
        }
        throw err;
    }
}

/** 저장된 키로 음성을 만든다 → { pcm: Int16Array, sampleRate } */
export function geminiSpeak(text, options = {}) {
    return withPaidKey(key => speakWithKey(key, text, options));
}

// ─── 글 다루기 (맞춤법 검사 등) ───

// 가격: 1백만 토큰당 달러(입력 / 출력 — 출력에는 생각하는 데 쓴 토큰도 들어간다). 2027년부터 두 배.
const TEXT_PRICES = {
    'gemini-3.8-flash': [{ until: Date.UTC(2027, 0, 1), input: 0.75, output: 3.75 }, { input: 1.5, output: 7.5 }]
};
export const TEXT_MODEL = 'gemini-3.8-flash';

/** 사용량({ input, output } 토큰) → 대략의 요금(원) */
export function textUsageWon(usage, model = TEXT_MODEL) {
    if (!usage) return 0;
    const table = TEXT_PRICES[model] || TEXT_PRICES[TEXT_MODEL];
    const now = Date.now();
    const p = table.find(x => !x.until || now < x.until);
    return ((usage.input || 0) * p.input + (usage.output || 0) * p.output) / 1e6 * WON_PER_USD;
}

function findText(data) {
    let text = '';
    for (const step of (data && data.steps) || []) {
        if (step && step.type && step.type !== 'model_output') continue;
        const parts = ((step && step.content) || []).filter(c => c && c.type === 'text' && typeof c.text === 'string');
        if (parts.length) text = parts.map(c => c.text).join('');
    }
    if (!text) for (const o of (data && data.outputs) || []) if (o && o.type === 'text' && typeof o.text === 'string') text += o.text;
    return text;
}

/**
 * 정해 준 모양(JSON 스키마)대로 답을 받는다 → { data, usage: { input, output } }
 * system: 지시문, input: 보낼 글(문자열), schema: 답의 모양
 */
export function geminiJson({ system, input, schema, model = TEXT_MODEL, thinking = 'low', maxOutputTokens = 16384, signal } = {}) {
    return withPaidKey(async (key) => {
        const data = await callApi('/interactions', {
            model,
            system_instruction: system,
            input,
            response_format: { type: 'text', mime_type: 'application/json', schema },
            generation_config: { thinking_level: thinking, max_output_tokens: maxOutputTokens },
            store: false
        }, { key, signal, timeoutMs: 90000 });
        const text = findText(data);
        if (!text) {
            const why = (data && (data.error || (data.status !== 'completed' && data.status))) || null;
            if (why) {
                const err = classifyError(200, { error: typeof why === 'string' ? { code: why } : why });
                if (err.kind === 'blocked') throw err;
            }
            throw new GeminiError('bad_response', 'Gemini가 답을 주지 않았습니다. 다시 시도해 주세요.');
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) {
            throw new GeminiError('bad_response', 'Gemini의 답을 읽지 못했습니다. 다시 시도해 주세요.');
        }
        const u = (data && data.usage) || {};
        return {
            data: parsed,
            usage: { input: u.total_input_tokens || 0, output: (u.total_output_tokens || 0) + (u.total_thought_tokens || 0) }
        };
    });
}

/**
 * 키를 확인하고 저장한다. 순서: 등급 확인(글을 보내기 전에) → 짧은 인사말로 음성 확인 → 저장.
 * 인사말 소리를 돌려주어 고른 목소리를 바로 들려줄 수 있게 한다.
 */
export async function connectGemini(rawKey, { model, voice, style, sampleText } = {}) {
    const key = String(rawKey || '').replace(/\s+/g, '');
    if (key.length < 20) throw new GeminiError('invalid_key', MESSAGES.invalid_key);
    const tier = await probePaidTier(key);
    if (tier === 'free') throw new GeminiError('free_tier', MESSAGES.free_tier);
    const use = PRICES[model] ? model : DEFAULT_TTS_MODEL;
    const sample = await speakWithKey(key, sampleText || '안녕하세요. 이제 이 목소리로 글을 읽어 드릴게요.', { voice, style, model: use });
    try {
        localStorage.setItem(KEY_ITEM, key);
    } catch (e) {
        throw new GeminiError('bad_request', '이 기기에 키를 저장하지 못했습니다. 브라우저의 사생활 보호 모드라면 일반 창에서 다시 시도해 주세요.');
    }
    const now = Date.now();
    writeMeta({ model: use, tier: tier === 'paid' ? 'paid' : 'unknown', checkedAt: now, agreedAt: now });
    announce('connected');
    return { tier, sample };
}
