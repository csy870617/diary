/**
 * Gemini 연결 창 — 사용자가 자기 Gemini API 키(결제를 연결한 유료 등급)를 넣고 확인한 뒤 연결한다.
 * 키 확인·저장은 gemini.js, 받은 음성 저장소는 gemini-voice.js가 맡고, 이 파일은 창만 다룬다.
 */
import { connectGemini, forgetGemini, getGeminiInfo, setGeminiModel, GEMINI_TTS_MODELS, wonPerMinute, formatWon } from './gemini.js';
import { DEFAULT_GEMINI_VOICE, getGeminiStyle, geminiStyleText, geminiCacheBytes, clearGeminiAudioCache, int16ToFloat } from './gemini-voice.js';
import { unlockNeuralAudio, playNeuralAudio } from './neural-tts.js';

const $ = (id) => document.getElementById(id);
let wired = false;
let busy = false;

export function openGeminiModal() {
    const modal = $('gemini-modal');
    if (!modal) return;
    wire();
    const input = $('gemini-key-input');
    if (input) { input.value = ''; input.type = 'password'; }
    const check = $('gemini-paid-check');
    if (check) check.checked = false;
    setStatus('');
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
            o.textContent = `${m.label} · 1분에 ${formatWon(wonPerMinute(m.id))}`;
            sel.appendChild(o);
        });
        sel.value = info.model;
    }
    if (!info.connected) return;
    const mask = $('gemini-key-mask');
    if (mask) mask.textContent = '••••' + info.last4;
    const tier = $('gemini-tier-text');
    if (tier) {
        tier.textContent = info.tier === 'paid'
            ? '유료 등급을 확인했습니다. 하루에 한 번 다시 확인합니다.'
            : '유료 등급인지 자동으로 확인하지 못했습니다. AI Studio에서 이 키의 프로젝트가 유료(Paid)로 표시되는지 꼭 확인해 주세요.';
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
    if (!$('gemini-paid-check')?.checked) {
        setStatus('결제를 연결한 유료 등급 키인지 확인하고 체크해 주세요. 무료 등급 키는 쓸 수 없습니다.', 'err');
        return;
    }
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
        setStatus(res.tier === 'paid'
            ? '연결했습니다. 유료 등급을 확인했습니다.\n음성 목록의 🎙️ 음성으로 읽어 드립니다.'
            : '연결했습니다. 음성 목록의 🎙️ 음성으로 읽어 드립니다.', 'ok');
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
