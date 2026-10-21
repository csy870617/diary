/**
 * Gemini(구글 AI) 연결 — 사용자가 자기 Gemini API 키를 넣어 맞춤법 검사에 쓴다.
 *
 * 무료 등급 키와 유료 등급 키를 모두 받는다. 다만 무료 등급에서는 보낸 글이 Google 서비스 개선에 쓰이고
 * 사람이 읽을 수도 있어(가격표의 '제품 개선에 사용: 예') 연결 창에 그 차이를 안내하고, 지금 키의 등급을 보여 준다.
 *  - 등급을 알려 주는 공식 기능은 없어, 무료 등급에서는 쓸 수 없는 모델(TIER_PROBE_MODEL)을 아주 짧게 불러 살핀다.
 *    결제를 연결하거나 끊으면 등급이 바뀌므로 하루에 한 번 다시 살피고, 바뀌면 알린다('gemini-change' tier).
 *  - 무료 등급은 1분·하루에 쓸 수 있는 양이 적다 — 한도에 걸리면 기다렸다가 다시 시도한다(withRetry).
 *  - 요청마다 store:false — Interactions API는 기본으로 요청을 서버에 저장하므로 끈다.
 * 키는 이 기기 브라우저(localStorage)에만 두고 구글 드라이브로 동기화하지 않는다.
 *
 * 이 파일은 화면(DOM)을 건드리지 않는다. 연결 상태가 바뀌면 window에 'gemini-change'를 알린다.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_ITEM = 'faith_gemini_key';
const META_ITEM = 'faith_gemini_meta';      // { tier: 'paid'|'free'|'unknown', checkedAt, agreedAt }
// 예전 Gemini 음성 기능이 남긴 것 — 기능을 뺐으므로 지운다 (removeOldVoiceData)
const OLD_AUDIO_DB = 'diary-gemini-voice';
const OLD_ITEMS = ['faith_gemini_style', 'faith_gemini_cps'];

// 무료 등급에는 없는 모델 — 이 모델이 답하면 유료 등급이다 (8토큰까지만 받아 요금은 1원 미만)
const TIER_PROBE_MODEL = 'gemini-4-argon';
const RECHECK_MS = 24 * 60 * 60 * 1000;
export const WON_PER_USD = 1400;

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
        tier: meta.tier === 'paid' || meta.tier === 'free' ? meta.tier : 'unknown',
        checkedAt: meta.checkedAt || 0
    };
}

function announce(what, extra) {
    if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
    window.dispatchEvent(new CustomEvent('gemini-change', { detail: { what, ...extra } }));
}

/** 키·설정을 지운다 (연결 해제·로그아웃) */
export async function forgetGemini() {
    try {
        localStorage.removeItem(KEY_ITEM);
        localStorage.removeItem(META_ITEM);
    } catch (e) { /* 저장소 접근 불가 */ }
    announce('disconnected');
    await removeOldVoiceData();
}

/**
 * 예전 Gemini 음성 기능이 이 기기에 남긴 음성 저장소와 설정을 지운다.
 * 음성 기능을 뺐으므로 앱을 열 때 한 번 부른다 (없으면 아무 일도 하지 않는다).
 */
export function removeOldVoiceData() {
    try { OLD_ITEMS.forEach(k => localStorage.removeItem(k)); } catch (e) { /* 저장소 접근 불가 */ }
    try {
        const v = localStorage.getItem('faith_tts_voice');
        if (v && v.startsWith('gm:')) localStorage.removeItem('faith_tts_voice');   // 고르던 Gemini 음성
    } catch (e) { /* 저장소 접근 불가 */ }
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') { resolve(); return; }
        let timer = null;
        try {
            const req = indexedDB.deleteDatabase(OLD_AUDIO_DB);
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
    billing: '이 키의 프로젝트에 결제가 설정되어 있지 않아 이 기능을 쓸 수 없습니다. AI Studio에서 결제를 연결해 주세요.',
    not_on_free: '이 기능에 쓰는 Gemini 모델은 무료 등급에서 쓸 수 없습니다. AI Studio에서 결제를 연결하면 쓸 수 있습니다.',
    no_credit: 'Gemini 선불 잔액이 없습니다. AI Studio의 결제 화면에서 충전한 뒤 다시 시도해 주세요.',
    permission: '이 키로는 Gemini를 쓸 수 없습니다. 키의 사용 제한(허용한 API·웹사이트)에 Gemini API와 이 앱 주소가 들어 있는지 확인해 주세요.',
    region: '지금 계신 지역에서는 Gemini API를 쓸 수 없습니다.',
    rate_limit: 'Gemini에 요청이 잠시 몰렸습니다. 조금 뒤 다시 시도해 주세요.',
    rate_limit_free: '무료 등급은 1분에 쓸 수 있는 양이 적습니다. 1분쯤 뒤에 다시 시도해 주세요.',
    quota: '오늘 쓸 수 있는 Gemini 사용량을 다 썼습니다. AI Studio에서 사용 한도를 확인해 주세요.',
    quota_free: '무료 등급의 오늘 사용량을 다 썼습니다. 내일 다시 쓰거나, AI Studio에서 결제를 연결하면 한도가 늘어납니다.',
    blocked: 'Gemini가 이 글은 처리하지 않았습니다(내용 정책).',
    server: 'Gemini 서버가 잠시 응답하지 않습니다. 조금 뒤 다시 시도해 주세요.',
    network: '인터넷에 연결되어 있지 않거나 Gemini에 접속하지 못했습니다.',
    timeout: 'Gemini가 너무 오래 응답하지 않습니다. 조금 뒤 다시 시도해 주세요.',
    not_found: 'Gemini 모델을 찾지 못했습니다. 앱을 새로 고친 뒤 다시 시도해 주세요.',
    no_key: 'Gemini가 연결되어 있지 않습니다. 맞춤법 버튼을 눌러 Gemini를 연결해 주세요.',
    bad_response: 'Gemini가 답을 주지 않았습니다. 다시 시도해 주세요.',
    bad_request: 'Gemini가 요청을 처리하지 못했습니다.',
    tier_changed: 'Gemini 키가 무료 등급으로 바뀌었습니다(결제 연결이 끊긴 것 같습니다).\n무료 등급에서는 보낸 글이 Google 서비스 개선에 쓰일 수 있어, 이번에는 글을 보내지 않았습니다.\n그래도 괜찮다면 맞춤법 버튼을 다시 누르세요. 원하지 않으면 AI Studio에서 결제를 다시 연결하거나 Gemini 연결을 해제해 주세요.'
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
    // 무료 등급의 한도에 걸린 답에는 'free_tier'가 들어 있다 — 같은 종류라도 무료 등급에 맞는 안내를 보인다
    const free = FREE_RE.test(everything);
    const make = (kind, extra) => {
        const text = (free && MESSAGES[kind + '_free']) || MESSAGES[kind];
        return new GeminiError(kind, text + (kind === 'bad_request' && message ? `\n(${message.slice(0, 160)})` : ''),
            { httpStatus, code: code || status, detail: message, free, ...extra });
    };

    if (/API_KEY_INVALID|API_KEY_EXPIRED/.test(reasons) || /api key (not valid|expired)/i.test(message)
        || httpStatus === 401 || code === 'authentication') return make('invalid_key');
    if (httpStatus === 402 || code === 'payment_required') return make('no_credit');
    if (/BILLING_DISABLED|BILLING_NOT_ENABLED/.test(reasons)
        || ((code === 'failed_precondition' || status === 'FAILED_PRECONDITION') && /billing/i.test(message))) return make('billing');
    if (/location is not supported|not available in your (country|region)/i.test(message)) return make('region');
    if (BLOCKED_CODES.has(code)) return make('blocked');
    if (free && /not (available|supported)/i.test(message)) return make('not_on_free');
    if (httpStatus === 403 || code === 'permission_denied' || status === 'PERMISSION_DENIED') return make('permission');
    if (httpStatus === 404 || code === 'not_found' || code === 'model_not_found') return make('not_found');
    if (code === 'quota_exceeded' || httpStatus === 429 || status === 'RESOURCE_EXHAUSTED' || code === 'rate_limit_exceeded' || code === 'too_many_requests') {
        // 무료 등급에서 쓸 수 없는 모델은 한도가 0이다
        if (/limit:\s*0\b/.test(message)) return make('not_on_free');
        // 하루 한도를 넘긴 것은 기다려도 오늘은 풀리지 않는다
        if (code === 'quota_exceeded' || /per ?day|daily/i.test(message) || /PerDay/.test(everything)) return make('quota');
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

// ─── 등급 확인 · 다시 시도 ───

/** 'paid' | 'free' | 'unknown'. 키가 틀렸거나 잔액이 없거나 접속하지 못하면 오류를 던진다 */
async function probeTier(key) {
    try {
        await callApi('/interactions', {
            model: TIER_PROBE_MODEL,
            input: '1',
            generation_config: { thinking_level: 'low', max_output_tokens: 8 },
            store: false
        }, { key, timeoutMs: 30000 });
        return 'paid';
    } catch (err) {
        if (!(err instanceof GeminiError)) throw err;
        // 무료 등급이 이 모델을 부르면 '한도 0' 또는 무료 등급이라는 답이 온다
        if (err.kind === 'not_on_free' || err.kind === 'billing' || (err.free && (err.kind === 'rate_limit' || err.kind === 'quota'))) return 'free';
        if (['invalid_key', 'no_credit', 'network', 'timeout'].includes(err.kind)) throw err;
        return 'unknown';
    }
}

let tierCheck = null;

/**
 * 하루에 한 번 키의 등급을 다시 살펴 적어 둔다 (결제를 연결하거나 끊으면 바뀐다).
 * 등급이 바뀌었으면 알리고 { tier, from }을 돌려준다.
 */
function refreshTier(key) {
    const meta = readMeta();
    if (meta.checkedAt && Date.now() - meta.checkedAt < RECHECK_MS) return Promise.resolve(null);
    if (!tierCheck) {
        tierCheck = (async () => {
            let tier;
            try {
                tier = await probeTier(key);
            } catch (err) {
                if (err.kind === 'invalid_key' || err.kind === 'no_credit') throw err;
                return null;   // 잠시 접속이 안 되는 등 — 다음에 다시 살핀다
            }
            const m = readMeta();
            const before = m.tier || 'unknown';
            if (tier !== 'unknown') m.tier = tier;
            m.checkedAt = Date.now();
            writeMeta(m);
            if (tier === 'unknown' || tier === before) return null;
            announce('tier', { tier, from: before });
            return { tier, from: before };
        })().finally(() => { tierCheck = null; });
    }
    return tierCheck;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 잠깐의 문제(요청 몰림·서버 오류·접속 끊김)는 기다렸다가 다시 시도한다.
 * 무료 등급은 1분 한도가 작아 Gemini가 1분 가까이 기다리라고 할 수 있다 — 기다리는 동안 'gemini-wait'를 알린다.
 */
export async function withRetry(task) {
    let delay = 1500;
    for (let attempt = 0; ; attempt++) {
        try {
            return await task();
        } catch (err) {
            const kind = err && err.kind;
            const again = (kind === 'rate_limit' || kind === 'server') ? attempt < 3
                : (kind === 'network' || kind === 'timeout') ? attempt < 1 : false;
            if (!again || (typeof navigator !== 'undefined' && navigator.onLine === false)) throw err;
            const wait = Math.min(65000, err.retryAfterMs || delay) + Math.random() * 400;
            if (kind === 'rate_limit' && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('gemini-wait', { detail: { ms: wait, free: !!err.free } }));
            }
            await sleep(wait);
            delay *= 2;
        }
    }
}

/**
 * 저장된 키로 Gemini를 부르는 모든 기능이 거치는 길 (하루 한 번 등급을 다시 살핀다).
 * 결제가 끊겨 무료 등급이 된 것을 방금 알았다면, 글을 보내기 전에 멈추고 알린다
 * (무료 등급에서는 보낸 글이 Google 개선에 쓰일 수 있다 — 모르고 보내지 않게).
 */
async function withKey(run) {
    const key = getGeminiKey();
    if (!key) throw new GeminiError('no_key', MESSAGES.no_key);
    const change = await refreshTier(key);
    if (change && change.from === 'paid' && change.tier === 'free') throw new GeminiError('tier_changed', MESSAGES.tier_changed);
    return run(key);
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
    return withKey(async (key) => {
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
            throw new GeminiError('bad_response', MESSAGES.bad_response);
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
 * 키를 확인하고 저장한다. 순서: 등급 확인(안내용 — 무료 등급도 받는다)
 * → 맞춤법 검사에 쓰는 모델을 아주 짧게 불러 이 키로 쓸 수 있는지 확인 → 저장.
 * (키의 사용 제한·지역 때문에 못 쓰는 경우를 검사하기 전에 알 수 있다. 1원 미만)
 */
export async function connectGemini(rawKey) {
    const key = String(rawKey || '').replace(/\s+/g, '');
    if (key.length < 20) throw new GeminiError('invalid_key', MESSAGES.invalid_key);
    const tier = await probeTier(key);
    await withRetry(() => callApi('/interactions', {
        model: TEXT_MODEL,
        input: '1',
        generation_config: { thinking_level: 'low', max_output_tokens: 8 },
        store: false
    }, { key, timeoutMs: 30000 }));
    try {
        localStorage.setItem(KEY_ITEM, key);
    } catch (e) {
        throw new GeminiError('bad_request', '이 기기에 키를 저장하지 못했습니다. 브라우저의 사생활 보호 모드라면 일반 창에서 다시 시도해 주세요.');
    }
    const now = Date.now();
    writeMeta({ tier, checkedAt: now, agreedAt: now });
    announce('connected');
    return { tier };
}
