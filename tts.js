/**
 * TTS (Text-to-Speech) 모듈
 * Web Speech API 기반
 */

let ttsUtterance = null;
let ttsVoices = [];
let isTTSSpeaking = false;
let isTTSPaused = false;
let ttsStartMarker = null;  // 시작 지점 텍스트 오프셋
let ttsEndMarker = null;    // 끝 지점 텍스트 오프셋
let ttsFullText = '';        // 에디터 전체 텍스트
let ttsSelectedText = '';    // 선택된 구간 텍스트

/**
 * TTS 패널 열기/닫기
 */
export function toggleTTSPanel() {
    const panel = document.getElementById('tts-panel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        panel.classList.remove('hidden');
        loadVoices();
        updateTTSRange();
    } else {
        panel.classList.add('hidden');
        stopTTS();
    }
}

/**
 * 음성 목록 로드
 */
export function loadVoices() {
    const voiceSelect = document.getElementById('tts-voice-select');
    if (!voiceSelect) return;

    const populateVoices = () => {
        ttsVoices = speechSynthesis.getVoices();
        voiceSelect.innerHTML = '';

        // 한국어 음성 우선, 그 다음 영어, 나머지
        const koVoices = ttsVoices.filter(v => v.lang.startsWith('ko'));
        const enVoices = ttsVoices.filter(v => v.lang.startsWith('en'));
        const otherVoices = ttsVoices.filter(v => !v.lang.startsWith('ko') && !v.lang.startsWith('en'));

        const addGroup = (voices, label) => {
            if (voices.length === 0) return;
            const group = document.createElement('optgroup');
            group.label = label;
            voices.forEach(voice => {
                const opt = document.createElement('option');
                opt.value = voice.name;
                opt.textContent = `${voice.name} (${voice.lang})`;
                if (voice.default) opt.textContent += ' *';
                group.appendChild(opt);
            });
            voiceSelect.appendChild(group);
        };

        addGroup(koVoices, '한국어');
        addGroup(enVoices, 'English');
        addGroup(otherVoices, '기타');

        // 저장된 음성 복원
        const savedVoice = localStorage.getItem('faith_tts_voice');
        if (savedVoice && ttsVoices.find(v => v.name === savedVoice)) {
            voiceSelect.value = savedVoice;
        } else if (koVoices.length > 0) {
            voiceSelect.value = koVoices[0].name;
        }
    };

    populateVoices();
    if (ttsVoices.length === 0) {
        speechSynthesis.onvoiceschanged = populateVoices;
    }
}

/**
 * 에디터 본문에서 텍스트 추출 (HTML 태그 제거)
 */
function getEditorText() {
    const editorBody = document.getElementById('editor-body');
    if (!editorBody) return '';
    // 블록 요소 뒤에 줄바꿈 추가
    const clone = editorBody.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    clone.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, tr').forEach(el => {
        el.prepend(document.createTextNode('\n'));
    });
    return (clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 현재 에디터에서 선택된 텍스트의 전체 텍스트 내 위치 계산
 */
function getSelectionOffsetInEditor() {
    const editorBody = document.getElementById('editor-body');
    const selection = window.getSelection();
    if (!selection.rangeCount || !editorBody) return null;

    const range = selection.getRangeAt(0);
    if (!editorBody.contains(range.startContainer)) return null;

    // 선택 텍스트
    const selectedText = selection.toString().trim();
    if (!selectedText) return null;

    // 전체 텍스트에서 위치 찾기
    const fullText = getEditorText();

    // TreeWalker로 정확한 오프셋 계산
    const preRange = document.createRange();
    preRange.setStart(editorBody, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    const preText = preRange.toString();

    const endPreRange = document.createRange();
    endPreRange.setStart(editorBody, 0);
    endPreRange.setEnd(range.endContainer, range.endOffset);
    const endText = endPreRange.toString();

    return {
        start: preText.length,
        end: endText.length,
        text: selectedText
    };
}

/**
 * TTS 구간 업데이트 (시작/끝 마커 기준)
 */
export function updateTTSRange() {
    ttsFullText = getEditorText();
    const startInfo = document.getElementById('tts-start-info');
    const endInfo = document.getElementById('tts-end-info');
    const rangePreview = document.getElementById('tts-range-preview');

    if (ttsStartMarker !== null && ttsStartMarker <= ttsFullText.length) {
        const preview = ttsFullText.substring(ttsStartMarker, ttsStartMarker + 30).replace(/\n/g, ' ');
        if (startInfo) startInfo.textContent = `"${preview}..."`;
        if (startInfo) startInfo.classList.add('set');
    } else {
        ttsStartMarker = null;
        if (startInfo) { startInfo.textContent = '처음부터'; startInfo.classList.remove('set'); }
    }

    if (ttsEndMarker !== null && ttsEndMarker <= ttsFullText.length) {
        const start = Math.max(0, ttsEndMarker - 30);
        const preview = ttsFullText.substring(start, ttsEndMarker).replace(/\n/g, ' ');
        if (endInfo) { endInfo.textContent = `"...${preview}"`; endInfo.classList.add('set'); }
    } else {
        ttsEndMarker = null;
        if (endInfo) { endInfo.textContent = '끝까지'; endInfo.classList.remove('set'); }
    }

    // 재생할 텍스트 결정
    const start = ttsStartMarker || 0;
    const end = ttsEndMarker || ttsFullText.length;
    ttsSelectedText = ttsFullText.substring(start, end).trim();

    if (rangePreview) {
        if (ttsSelectedText.length > 0) {
            const maxLen = 100;
            const preview = ttsSelectedText.length > maxLen
                ? ttsSelectedText.substring(0, maxLen) + '...'
                : ttsSelectedText;
            rangePreview.textContent = preview;
            rangePreview.classList.remove('empty');
        } else {
            rangePreview.textContent = '재생할 텍스트가 없습니다.';
            rangePreview.classList.add('empty');
        }
    }
}

/**
 * 시작 지점 설정
 */
export function setTTSStart() {
    const offset = getSelectionOffsetInEditor();
    if (offset) {
        ttsStartMarker = offset.start;
        // 끝 지점이 시작보다 앞이면 리셋
        if (ttsEndMarker !== null && ttsEndMarker <= ttsStartMarker) {
            ttsEndMarker = null;
        }
    } else {
        ttsStartMarker = null;
    }
    updateTTSRange();
}

/**
 * 끝 지점 설정
 */
export function setTTSEnd() {
    const offset = getSelectionOffsetInEditor();
    if (offset) {
        ttsEndMarker = offset.end;
        // 시작 지점이 끝보다 뒤이면 리셋
        if (ttsStartMarker !== null && ttsStartMarker >= ttsEndMarker) {
            ttsStartMarker = null;
        }
    } else {
        ttsEndMarker = null;
    }
    updateTTSRange();
}

/**
 * 구간 초기화
 */
export function resetTTSRange() {
    ttsStartMarker = null;
    ttsEndMarker = null;
    updateTTSRange();
}

/**
 * TTS 재생
 */
export function playTTS() {
    if (!('speechSynthesis' in window)) {
        alert('이 브라우저는 TTS를 지원하지 않습니다.');
        return;
    }

    if (isTTSPaused) {
        speechSynthesis.resume();
        isTTSPaused = false;
        isTTSSpeaking = true;
        updateTTSButtons();
        return;
    }

    // 새로 시작
    stopTTS();
    updateTTSRange();

    const text = ttsSelectedText || ttsFullText;
    if (!text.trim()) {
        alert('읽을 내용이 없습니다.');
        return;
    }

    // 긴 텍스트를 청크로 나누어 재생 (브라우저 제한 우회)
    const chunks = splitTextIntoChunks(text, 200);
    speakChunks(chunks, 0);
}

/**
 * 텍스트를 문장 단위로 청크 분할
 */
function splitTextIntoChunks(text, maxLen) {
    const chunks = [];
    const sentences = text.split(/(?<=[.!?。\n])\s*/);
    let current = '';

    for (const sentence of sentences) {
        if ((current + sentence).length > maxLen && current.length > 0) {
            chunks.push(current.trim());
            current = sentence;
        } else {
            current += (current ? ' ' : '') + sentence;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
}

/**
 * 청크 순차 재생
 */
function speakChunks(chunks, index) {
    if (index >= chunks.length) {
        isTTSSpeaking = false;
        isTTSPaused = false;
        updateTTSButtons();
        return;
    }

    const voiceSelect = document.getElementById('tts-voice-select');
    const speedSlider = document.getElementById('tts-speed-slider');

    ttsUtterance = new SpeechSynthesisUtterance(chunks[index]);

    // 음성 설정
    const selectedVoiceName = voiceSelect?.value;
    if (selectedVoiceName) {
        const voice = ttsVoices.find(v => v.name === selectedVoiceName);
        if (voice) ttsUtterance.voice = voice;
        localStorage.setItem('faith_tts_voice', selectedVoiceName);
    }

    // 속도 설정
    const speed = speedSlider ? parseFloat(speedSlider.value) : 1.0;
    ttsUtterance.rate = speed;
    localStorage.setItem('faith_tts_speed', speed.toString());

    // 진행률 업데이트
    const progressBar = document.getElementById('tts-progress-bar');
    const progressText = document.getElementById('tts-progress-text');

    ttsUtterance.onstart = () => {
        isTTSSpeaking = true;
        isTTSPaused = false;
        updateTTSButtons();
    };

    ttsUtterance.onend = () => {
        const progress = Math.round(((index + 1) / chunks.length) * 100);
        if (progressBar) progressBar.style.width = `${progress}%`;
        if (progressText) progressText.textContent = `${progress}%`;
        speakChunks(chunks, index + 1);
    };

    ttsUtterance.onerror = (e) => {
        if (e.error !== 'canceled') {
            console.error('TTS 오류:', e.error);
        }
        isTTSSpeaking = false;
        isTTSPaused = false;
        updateTTSButtons();
    };

    const progress = Math.round((index / chunks.length) * 100);
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (progressText) progressText.textContent = `${progress}%`;

    speechSynthesis.speak(ttsUtterance);
}

/**
 * TTS 일시정지
 */
export function pauseTTS() {
    if (isTTSSpeaking && !isTTSPaused) {
        speechSynthesis.pause();
        isTTSPaused = true;
        updateTTSButtons();
    }
}

/**
 * TTS 정지
 */
export function stopTTS() {
    speechSynthesis.cancel();
    isTTSSpeaking = false;
    isTTSPaused = false;
    ttsUtterance = null;
    updateTTSButtons();
    const progressBar = document.getElementById('tts-progress-bar');
    const progressText = document.getElementById('tts-progress-text');
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = '0%';
}

/**
 * 버튼 상태 업데이트
 */
function updateTTSButtons() {
    const playBtn = document.getElementById('tts-play-btn');
    const pauseBtn = document.getElementById('tts-pause-btn');
    const stopBtn = document.getElementById('tts-stop-btn');

    if (playBtn) playBtn.classList.toggle('hidden', isTTSSpeaking && !isTTSPaused);
    if (pauseBtn) pauseBtn.classList.toggle('hidden', !isTTSSpeaking || isTTSPaused);
    if (stopBtn) stopBtn.disabled = !isTTSSpeaking && !isTTSPaused;
}

/**
 * 속도 표시 업데이트
 */
export function updateSpeedDisplay() {
    const slider = document.getElementById('tts-speed-slider');
    const display = document.getElementById('tts-speed-value');
    if (slider && display) {
        display.textContent = `${parseFloat(slider.value).toFixed(1)}x`;
    }
}

/**
 * 초기화 - 저장된 설정 복원
 */
export function initTTS() {
    const savedSpeed = localStorage.getItem('faith_tts_speed');
    const slider = document.getElementById('tts-speed-slider');
    if (savedSpeed && slider) {
        slider.value = savedSpeed;
        updateSpeedDisplay();
    }
}
