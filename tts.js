/**
 * TTS (Text-to-Speech) 모듈 v2
 * Web Speech API 기반 - 미니 플레이어 UI
 */

let ttsVoices = [];
let isTTSSpeaking = false;
let isTTSPaused = false;
let ttsChunks = [];
let ttsChunkIndex = 0;
let ttsStartOffset = null;
let ttsEndOffset = null;

// ─── 텍스트 추출 (Range 기반으로 일관성 유지) ───

function getFullText() {
    const editor = document.getElementById('editor-body');
    if (!editor) return '';
    const range = document.createRange();
    range.selectNodeContents(editor);
    return range.toString();
}

function getSelectionInfo() {
    const editor = document.getElementById('editor-body');
    const sel = window.getSelection();
    if (!sel.rangeCount || !editor) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer) || range.collapsed) return null;

    const pre = document.createRange();
    pre.selectNodeContents(editor);
    pre.setEnd(range.startContainer, range.startOffset);
    const startOff = pre.toString().length;

    const preEnd = document.createRange();
    preEnd.selectNodeContents(editor);
    preEnd.setEnd(range.endContainer, range.endOffset);
    const endOff = preEnd.toString().length;

    return { start: startOff, end: endOff, text: sel.toString() };
}

// ─── 패널 토글 ───

export function toggleTTSPanel() {
    const panel = document.getElementById('tts-panel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        panel.classList.remove('hidden');
        loadVoices();
        refreshRangeDisplay();
    } else {
        panel.classList.add('hidden');
        stopTTS();
        closeTTSSettings();
    }
}

export function toggleTTSSettings() {
    const settings = document.getElementById('tts-settings');
    if (!settings) return;
    settings.classList.toggle('hidden');
    refreshRangeDisplay();
}

function closeTTSSettings() {
    const settings = document.getElementById('tts-settings');
    if (settings) settings.classList.add('hidden');
}

// ─── 음성 로드 ───

export function loadVoices() {
    const sel = document.getElementById('tts-voice-select');
    if (!sel) return;

    const populate = () => {
        ttsVoices = speechSynthesis.getVoices();
        sel.innerHTML = '';

        const ko = ttsVoices.filter(v => v.lang.startsWith('ko'));
        const en = ttsVoices.filter(v => v.lang.startsWith('en'));
        const etc = ttsVoices.filter(v => !v.lang.startsWith('ko') && !v.lang.startsWith('en'));

        const addGroup = (voices, label) => {
            if (!voices.length) return;
            const g = document.createElement('optgroup');
            g.label = label;
            voices.forEach(v => {
                const o = document.createElement('option');
                o.value = v.name;
                // 음성 이름 깔끔하게 표시
                let displayName = v.name.replace(/Microsoft |Google |Apple /i, '');
                // 언어 태그 간소화
                const langShort = v.lang.split('-')[0].toUpperCase();
                o.textContent = `${displayName}`;
                if (v.localService === false) o.textContent += ' (온라인)';
                g.appendChild(o);
            });
            sel.appendChild(g);
        };

        addGroup(ko, '🇰🇷 한국어');
        addGroup(en, '🇺🇸 English');
        addGroup(etc, '🌐 기타');

        const saved = localStorage.getItem('faith_tts_voice');
        if (saved && ttsVoices.find(v => v.name === saved)) {
            sel.value = saved;
        } else if (ko.length) {
            sel.value = ko[0].name;
        }
    };

    populate();
    if (!ttsVoices.length) speechSynthesis.onvoiceschanged = populate;
}

// ─── 구간 선택 ───

export function setTTSStart() {
    const info = getSelectionInfo();
    if (info) {
        ttsStartOffset = info.start;
        if (ttsEndOffset !== null && ttsEndOffset <= ttsStartOffset) ttsEndOffset = null;
        showToast('시작 지점이 설정되었습니다.');
    } else {
        ttsStartOffset = null;
        showToast('시작 지점이 초기화되었습니다 (처음부터).');
    }
    refreshRangeDisplay();
}

export function setTTSEnd() {
    const info = getSelectionInfo();
    if (info) {
        ttsEndOffset = info.end;
        if (ttsStartOffset !== null && ttsStartOffset >= ttsEndOffset) ttsStartOffset = null;
        showToast('끝 지점이 설정되었습니다.');
    } else {
        ttsEndOffset = null;
        showToast('끝 지점이 초기화되었습니다 (끝까지).');
    }
    refreshRangeDisplay();
}

export function resetTTSRange() {
    ttsStartOffset = null;
    ttsEndOffset = null;
    refreshRangeDisplay();
    showToast('구간이 초기화되었습니다.');
}

function showToast(msg) {
    let toast = document.getElementById('tts-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'tts-toast';
        toast.className = 'tts-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function refreshRangeDisplay() {
    const full = getFullText();
    const startInfo = document.getElementById('tts-start-info');
    const endInfo = document.getElementById('tts-end-info');
    const barLabel = document.getElementById('tts-bar-range-label');

    if (ttsStartOffset !== null && ttsStartOffset < full.length) {
        const t = full.substring(ttsStartOffset, ttsStartOffset + 20).replace(/\n/g, ' ').trim();
        if (startInfo) { startInfo.textContent = `"${t}…"`; startInfo.classList.add('set'); }
    } else {
        ttsStartOffset = null;
        if (startInfo) { startInfo.textContent = '처음부터'; startInfo.classList.remove('set'); }
    }

    if (ttsEndOffset !== null && ttsEndOffset <= full.length) {
        const s = Math.max(0, ttsEndOffset - 20);
        const t = full.substring(s, ttsEndOffset).replace(/\n/g, ' ').trim();
        if (endInfo) { endInfo.textContent = `"…${t}"`; endInfo.classList.add('set'); }
    } else {
        ttsEndOffset = null;
        if (endInfo) { endInfo.textContent = '끝까지'; endInfo.classList.remove('set'); }
    }

    // 바 라벨
    if (barLabel) {
        if (ttsStartOffset !== null || ttsEndOffset !== null) {
            barLabel.textContent = '구간';
            barLabel.classList.add('active');
        } else {
            barLabel.textContent = '전체';
            barLabel.classList.remove('active');
        }
    }
}

// ─── 재생 ───

function getTextToSpeak() {
    const full = getFullText();
    const s = ttsStartOffset || 0;
    const e = ttsEndOffset || full.length;
    return full.substring(s, e).trim();
}

export function playTTS() {
    if (!('speechSynthesis' in window)) {
        alert('이 브라우저는 TTS를 지원하지 않습니다.');
        return;
    }

    // 일시정지 → 재개
    if (isTTSPaused) {
        speechSynthesis.resume();
        isTTSPaused = false;
        isTTSSpeaking = true;
        syncUI();
        return;
    }

    stopTTS();
    const text = getTextToSpeak();
    if (!text) { alert('읽을 내용이 없습니다.'); return; }

    ttsChunks = splitChunks(text, 180);
    ttsChunkIndex = 0;
    speakNext();
}

function splitChunks(text, max) {
    const chunks = [];
    // 한국어 문장 부호 포함
    const parts = text.split(/(?<=[.!?。\n·])\s*/);
    let cur = '';
    for (const p of parts) {
        if (!p.trim()) continue;
        if ((cur + ' ' + p).length > max && cur) {
            chunks.push(cur.trim());
            cur = p;
        } else {
            cur += (cur ? ' ' : '') + p;
        }
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.length ? chunks : [text];
}

function speakNext() {
    if (ttsChunkIndex >= ttsChunks.length) {
        isTTSSpeaking = false;
        isTTSPaused = false;
        ttsChunkIndex = 0;
        setProgress(100);
        syncUI();
        return;
    }

    const utt = new SpeechSynthesisUtterance(ttsChunks[ttsChunkIndex]);

    // 음성
    const voiceName = document.getElementById('tts-voice-select')?.value;
    if (voiceName) {
        const v = ttsVoices.find(x => x.name === voiceName);
        if (v) utt.voice = v;
        localStorage.setItem('faith_tts_voice', voiceName);
    }

    // 속도 & 피치
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1');
    const pitch = parseFloat(document.getElementById('tts-pitch-slider')?.value || '1');
    utt.rate = speed;
    utt.pitch = pitch;
    localStorage.setItem('faith_tts_speed', String(speed));
    localStorage.setItem('faith_tts_pitch', String(pitch));

    utt.onstart = () => { isTTSSpeaking = true; isTTSPaused = false; syncUI(); };
    utt.onend = () => {
        ttsChunkIndex++;
        setProgress(Math.round((ttsChunkIndex / ttsChunks.length) * 100));
        speakNext();
    };
    utt.onerror = (e) => {
        if (e.error !== 'canceled') console.error('TTS error:', e.error);
        isTTSSpeaking = false; isTTSPaused = false; syncUI();
    };

    setProgress(Math.round((ttsChunkIndex / ttsChunks.length) * 100));
    speechSynthesis.speak(utt);
}

export function pauseTTS() {
    if (isTTSSpeaking && !isTTSPaused) {
        speechSynthesis.pause();
        isTTSPaused = true;
        syncUI();
    }
}

export function stopTTS() {
    speechSynthesis.cancel();
    isTTSSpeaking = false;
    isTTSPaused = false;
    ttsChunks = [];
    ttsChunkIndex = 0;
    setProgress(0);
    syncUI();
}

// ─── 선택 텍스트만 바로 듣기 ───

export function playSelection() {
    const info = getSelectionInfo();
    if (!info || !info.text.trim()) {
        alert('먼저 본문에서 텍스트를 선택해주세요.');
        return;
    }
    stopTTS();
    ttsChunks = splitChunks(info.text, 180);
    ttsChunkIndex = 0;
    speakNext();
}

// ─── UI 동기화 ───

function setProgress(pct) {
    const bar = document.getElementById('tts-progress-bar');
    const txt = document.getElementById('tts-progress-text');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = pct + '%';
}

function syncUI() {
    const playBtn = document.getElementById('tts-play-btn');
    const pauseBtn = document.getElementById('tts-pause-btn');
    const stopBtn = document.getElementById('tts-stop-btn');

    const playing = isTTSSpeaking && !isTTSPaused;
    if (playBtn) playBtn.classList.toggle('hidden', playing);
    if (pauseBtn) pauseBtn.classList.toggle('hidden', !playing);
    if (stopBtn) stopBtn.disabled = !isTTSSpeaking && !isTTSPaused;

    // 헤더 버튼 활성
    const headerBtn = document.getElementById('btn-tts');
    if (headerBtn) headerBtn.classList.toggle('tts-active', isTTSSpeaking);
}

export function updateSpeedDisplay() {
    const s = document.getElementById('tts-speed-slider');
    const d = document.getElementById('tts-speed-value');
    if (s && d) d.textContent = parseFloat(s.value).toFixed(1) + 'x';
}

export function updatePitchDisplay() {
    const s = document.getElementById('tts-pitch-slider');
    const d = document.getElementById('tts-pitch-value');
    if (s && d) {
        const v = parseFloat(s.value);
        let label = v < 0.9 ? '낮음' : v > 1.1 ? '높음' : '보통';
        d.textContent = label;
    }
}

export function initTTS() {
    const speed = localStorage.getItem('faith_tts_speed');
    const pitch = localStorage.getItem('faith_tts_pitch');
    const ss = document.getElementById('tts-speed-slider');
    const ps = document.getElementById('tts-pitch-slider');
    if (speed && ss) { ss.value = speed; updateSpeedDisplay(); }
    if (pitch && ps) { ps.value = pitch; updatePitchDisplay(); }
}

export { refreshRangeDisplay as updateTTSRange };
