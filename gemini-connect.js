/**
 * Gemini 연결 창 — 사용자가 자기 Gemini API 키(무료·유료 등급 모두)를 넣고 확인한 뒤 연결한다.
 * 두 등급의 차이(무료 등급은 보낸 글이 Google 개선에 쓰일 수 있음)를 안내하고, 연결한 키의 등급을 보여 준다.
 * 이 키로 Gemini 음성(tts.js)과 맞춤법 검사(spellcheck.js)를 쓴다.
 * 키 확인·저장은 gemini.js, 받은 음성 저장소는 gemini-voice.js가 맡고, 이 파일은 창만 다룬다.
 */
import { connectGemini, forgetGemini, getGeminiInfo, setGeminiModel, GEMINI_TTS_MODELS, wonPerMinute, formatWon } from './gemini.js';
import { DEFAULT_GEMINI_VOICE, getGeminiStyle, geminiStyleText, geminiCacheBytes, clearGeminiAudioCache, int16ToFloat } from './gemini-voice.js';
import { unlockNeuralAudio, playNeuralAudio } from './neural-tts.js';

const $ = (id) => document.getElementById(id);
let wired = false;
let busy = false;

/** hint: 창을 연 까닭 (예: 맞춤법 검사를 누르면 '먼저 연결해 주세요') */
export function openGeminiModal({ hint } = {}) {
    const modal = $('gemini-modal');
    if (!modal) return;
    wire();
    const input = $('gemini-key-input');
    if (input) { input.value = ''; input.type = 'password'; }
    setStatus(hint || '');
    render();
    modal.classList.remove('hidden');
    if (!getGeminiInfo().connected) setTimeout(() => $('gemini-key-input')?.focus(), 60);
}

function closeGeminiModal() {
    $('gemini-modal')?.classList.add('hidden');
    const input = $('gemini-key-input');
    if (input) input.value = '';   // 붙여 넣은 키가 화면에 남지 않게
}

function setStatus(text, kind) {
    const el = $('gemini-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gm-status' + (kind ? ' ' + kind : '');
}

function setBusy(on) {
    busy = on;
    ['gemini-connect-btn', 'gemini-disconnect-btn', 'gemini-clear-cache-btn', 'gemini-key-input', 'gemini-model-select']
        .forEach(id => { const el = $(id); if (el) el.disabled = on; });
}

// 연결한 키의 등급에 따른 안내 (하루에 한 번 다시 살핀다)
const TIER_TEXT = {
    paid: '유료 등급 키입니다. 보낸 글은 Google 서비스 개선에 쓰이지 않습니다.',
    free: '무료 등급 키입니다. 요금은 들지 않지만 보낸 글이 Google 서비스와 AI 모델 개선에 쓰이고 사람이 검토할 수도 있습니다. 사용량 한도가 작아 긴 글은 중간에 잠시 기다릴 수 있습니다.',
    unknown: '등급을 자동으로 확인하지 못했습니다. AI Studio의 API 키 화면에서 요금제(무료·유료)를 확인할 수 있습니다.'
};

function render() {
    const info = getGeminiInfo();
    $('gemini-connect-view')?.classList.toggle('hidden', info.connected);
    $('gemini-connected-view')?.classList.toggle('hidden', !info.connected);
    $('gemini-connected-actions')?.classList.toggle('hidden', !info.connected);
    $('gemini-connect-btn')?.classList.toggle('hidden', info.connected);
    $('gemini-disconnect-btn')?.classList.toggle('hidden', !info.connected);

    const sel = $('gemini-model-select');
    if (sel) {
        sel.innerHTML = '';
        GEMINI_TTS_MODELS.forEach(m => {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = `${m.label} · 1분 ${formatWon(wonPerMinute(m.id))}(유료)`;
            sel.appendChild(o);
        });
        sel.value = info.model;
    }
    if (!info.connected) return;
    const mask = $('gemini-key-mask');
    if (mask) mask.textContent = '••••' + info.last4;
    const tier = $('gemini-tier-text');
    if (tier) {
        tier.textContent = TIER_TEXT[info.tier];
        tier.className = 'gm-tier ' + info.tier;
    }
    const cache = $('gemini-cache-text');
    if (cache) {
        cache.textContent = '';
        geminiCacheBytes().then(bytes => {
            cache.textContent = bytes > 0
                ? `이 기기에 저장된 Gemini 음성 ${(bytes / 1048576).toFixed(1)}MB`
                : '이 기기에 저장된 Gemini 음성 없음';
        });
    }
}

async function onConnect() {
    if (busy) return;
    const key = ($('gemini-key-input')?.value || '').trim();
    if (!key) { setStatus('Gemini API 키를 붙여 넣어 주세요.', 'err'); return; }
    unlockNeuralAudio();   // 누른 순간에 소리 장치를 깨워 둔다 (아이폰 — 확인 뒤 들려줄 인사말)
    setBusy(true);
    setStatus('키와 요금 등급을 확인하는 중…');
    try {
        const res = await connectGemini(key, {
            model: $('gemini-model-select')?.value,
            voice: DEFAULT_GEMINI_VOICE,
            style: geminiStyleText(getGeminiStyle())
        });
        const input = $('gemini-key-input');
        if (input) input.value = '';
        render();
        setStatus('연결했습니다. 음성 목록의 🎙️ 음성으로 읽어 드리고, 글쓰기 도구 막대의 맞춤법 버튼으로 검사할 수 있습니다.', 'ok');
        if (res.sample && res.sample.pcm.length) playNeuralAudio(int16ToFloat(res.sample.pcm), res.sample.sampleRate);
    } catch (err) {
        setStatus((err && err.message) || String(err), 'err');
    } finally {
        setBusy(false);
    }
}

async function onDisconnect() {
    if (busy) return;
    if (!confirm('Gemini 연결을 해제할까요?\n이 기기에 저장된 키와 Gemini 음성이 모두 지워집니다.')) return;
    setBusy(true);
    try { await forgetGemini(); } finally { setBusy(false); }
    render();
    setStatus('연결을 해제했습니다.', 'ok');
}

async function onClearCache() {
    if (busy) return;
    if (!confirm('이 기기에 저장된 Gemini 음성을 지울까요?\n다시 들을 때 새로 만들며 요금이 듭니다.')) return;
    setBusy(true);
    try { await clearGeminiAudioCache(); } finally { setBusy(false); }
    render();
}

function wire() {
    if (wired) return;
    wired = true;
    const modal = $('gemini-modal');
    $('gemini-connect-btn')?.addEventListener('click', onConnect);
    $('gemini-disconnect-btn')?.addEventListener('click', onDisconnect);
    $('gemini-clear-cache-btn')?.addEventListener('click', onClearCache);
    $('gemini-close-btn')?.addEventListener('click', closeGeminiModal);
    $('gemini-close-x')?.addEventListener('click', closeGeminiModal);
    $('gemini-model-select')?.addEventListener('change', (e) => {
        if (getGeminiInfo().connected) setGeminiModel(e.target.value);   // 연결 전이면 연결할 때 쓴다
    });
    $('gemini-key-toggle')?.addEventListener('click', () => {
        const input = $('gemini-key-input');
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        $('gemini-key-toggle')?.setAttribute('aria-label', input.type === 'password' ? '키 보이기' : '키 가리기');
    });
    $('gemini-key-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onConnect(); });
    // 창 바깥(어두운 배경)을 누르면 닫는다
    modal?.addEventListener('click', (e) => { if (e.target === modal && !busy) closeGeminiModal(); });
    // 글 쓰는 화면의 되돌리기 단축키(Ctrl+Z)가 이 창의 입력칸을 가로채지 않게 하고, Esc로 닫는다
    window.addEventListener('keydown', (e) => {
        if (!modal || modal.classList.contains('hidden')) return;
        if (e.key === 'Escape' && !busy) { closeGeminiModal(); return; }
        if (modal.contains(e.target)) e.stopPropagation();
    }, true);
}
