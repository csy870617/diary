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
let ttsGapTimer = null;

// ─── 텍스트 추출 (Range 기반으로 일관성 유지) ───

function getFullText() {
    const editor = document.getElementById('editor-body');
    if (!editor) return '';
    return extractTextWithBreaks(editor);
}

/** DOM을 순회하며 블록 요소·<br> 경계에 \n을 삽입해 텍스트 추출 */
function extractTextWithBreaks(root) {
    const blocks = new Set([
        'DIV','P','BR','LI','TR','H1','H2','H3','H4','H5','H6',
        'BLOCKQUOTE','PRE','HR','UL','OL','TABLE','SECTION','ARTICLE'
    ]);
    let text = '';
    for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName;
            if (tag === 'BR') {
                text += '\n';
            } else if (blocks.has(tag)) {
                const inner = extractTextWithBreaks(node);
                if (inner) {
                    if (text && !text.endsWith('\n')) text += '\n';
                    text += inner;
                }
            } else {
                text += extractTextWithBreaks(node);
            }
        }
    }
    return text;
}

function getSelectionInfo() {
    const editor = document.getElementById('editor-body');
    const sel = window.getSelection();
    if (!sel.rangeCount || !editor) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer) || range.collapsed) return null;

    const startOff = getExtractedOffsetAt(editor, range.startContainer, range.startOffset);
    const endOff = getExtractedOffsetAt(editor, range.endContainer, range.endOffset);

    return { start: startOff, end: endOff, text: sel.toString() };
}

/** extractTextWithBreaks 기준으로 특정 DOM 위치까지의 문자 오프셋 계산 */
function getExtractedOffsetAt(root, targetNode, targetOffset) {
    const blocks = new Set([
        'DIV','P','BR','LI','TR','H1','H2','H3','H4','H5','H6',
        'BLOCKQUOTE','PRE','HR','UL','OL','TABLE','SECTION','ARTICLE'
    ]);
    let text = '';
    let found = false;

    function processChildren(parent) {
        if (found) return;
        for (let i = 0; i < parent.childNodes.length; i++) {
            if (found) return;
            if (parent === targetNode && i === targetOffset) { found = true; return; }
            processNode(parent.childNodes[i]);
        }
        if (!found && parent === targetNode && targetOffset === parent.childNodes.length) {
            found = true;
        }
    }

    function processNode(node) {
        if (found) return;
        if (node.nodeType === Node.TEXT_NODE) {
            if (node === targetNode) {
                text += node.textContent.substring(0, targetOffset);
                found = true;
                return;
            }
            text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName;
            if (tag === 'BR') {
                text += '\n';
            } else if (blocks.has(tag)) {
                if (text && !text.endsWith('\n')) text += '\n';
                processChildren(node);
            } else {
                processChildren(node);
            }
        }
    }

    processChildren(root);
    return text.length;
}

// ─── 패널 토글 ───

export function toggleTTSPanel() {
    const panel = document.getElementById('tts-panel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        panel.classList.remove('hidden');
        document.getElementById('write-modal')?.classList.add('tts-open');
        loadVoices();
        refreshRangeDisplay();
    } else {
        panel.classList.add('hidden');
        document.getElementById('write-modal')?.classList.remove('tts-open');
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

        // 로컬(기기 내장) 음성 우선 정렬
        const sortLocal = (voices) => {
            const local = voices.filter(v => v.localService !== false);
            const online = voices.filter(v => v.localService === false);
            return [...local, ...online];
        };

        const ko = sortLocal(ttsVoices.filter(v => v.lang.startsWith('ko')));
        const en = sortLocal(ttsVoices.filter(v => v.lang.startsWith('en')));
        const etc = sortLocal(ttsVoices.filter(v => !v.lang.startsWith('ko') && !v.lang.startsWith('en')));

        const addGroup = (voices, label) => {
            if (!voices.length) return;
            const g = document.createElement('optgroup');
            g.label = label;
            voices.forEach(v => {
                const o = document.createElement('option');
                o.value = v.name;
                let displayName = v.name.replace(/Microsoft |Google |Apple /i, '');
                o.textContent = displayName;
                // 로컬 음성은 기기 아이콘, 온라인은 표시
                if (v.localService === false) o.textContent += ' ☁️';
                g.appendChild(o);
            });
            sel.appendChild(g);
        };

        addGroup(ko, '🇰🇷 한국어');
        addGroup(en, '🇺🇸 English');
        addGroup(etc, '🌐 기타');

        // 저장된 음성 복원, 없으면 한국어 로컬 음성 우선 선택
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
    // 문장 부호 기준으로 분리 (한국어·영어 포함)
    const sentences = text.split(/(?<=[.!?。\n])\s*/);
    for (const s of sentences) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        // 문장이 max를 넘으면 쉼표/중간 구두점에서 한번 더 나눔
        if (trimmed.length > max) {
            const sub = trimmed.split(/(?<=[,;:·])\s*/);
            let cur = '';
            for (const part of sub) {
                if ((cur + ' ' + part).length > max && cur) {
                    chunks.push(cur.trim());
                    cur = part;
                } else {
                    cur += (cur ? ' ' : '') + part;
                }
            }
            if (cur.trim()) chunks.push(cur.trim());
        } else {
            chunks.push(trimmed);
        }
    }
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
        const gap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') * 1000;
        if (gap > 0 && ttsChunkIndex < ttsChunks.length) {
            ttsGapTimer = setTimeout(() => speakNext(), gap);
        } else {
            speakNext();
        }
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
    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;
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

export function updateGapDisplay() {
    const s = document.getElementById('tts-gap-slider');
    const d = document.getElementById('tts-gap-value');
    if (s && d) {
        const v = parseFloat(s.value);
        d.textContent = v === 0 ? '없음' : v.toFixed(1) + '초';
        localStorage.setItem('faith_tts_gap', String(v));
    }
}

export function initTTS() {
    const speed = localStorage.getItem('faith_tts_speed');
    const pitch = localStorage.getItem('faith_tts_pitch');
    const gap = localStorage.getItem('faith_tts_gap');
    const ss = document.getElementById('tts-speed-slider');
    const ps = document.getElementById('tts-pitch-slider');
    const gs = document.getElementById('tts-gap-slider');
    if (speed && ss) { ss.value = speed; updateSpeedDisplay(); }
    if (pitch && ps) { ps.value = pitch; updatePitchDisplay(); }
    if (gap && gs) { gs.value = gap; updateGapDisplay(); }
}

export { refreshRangeDisplay as updateTTSRange };
