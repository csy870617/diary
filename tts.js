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

// 재생 시간 추적
let ttsTotalSec = 0;           // 예상 총 재생 시간
let ttsPlayStartMs = 0;        // 현재 재생 세션 시작 시각
let ttsElapsedBeforePause = 0; // 일시정지 전까지 누적된 경과(ms)
let ttsTimerInterval = null;

// 1x 속도에서 TTS가 읽는 평균 문자 수/초 (경험적 추정)
const CHARS_PER_SEC = 13;

// 마침표 1개를 초과하는 각 마침표마다 추가되는 쉼(초). "..." = 기본 간격 + 1.0초
const DOT_EXTRA_PAUSE_SEC = 0.5;

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
        refreshTTSTotalTime();
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

// 자연스러운(Neural/Natural) 음성을 식별하기 위한 키워드
const NATURAL_VOICE_RE = /natural|neural|online|enhanced|premium|wavenet|studio|neural2/i;

export function loadVoices() {
    const sel = document.getElementById('tts-voice-select');
    if (!sel) return;

    const populate = () => {
        ttsVoices = speechSynthesis.getVoices();
        sel.innerHTML = '';

        // 자연스러움 점수 기반 정렬: Neural/Natural → 온라인 → 로컬 순
        const sortByNaturalness = (voices) => {
            const score = (v) => {
                let s = 0;
                if (NATURAL_VOICE_RE.test(v.name)) s += 10;
                if (v.localService === false) s += 1;
                return s;
            };
            return [...voices].sort((a, b) => score(b) - score(a));
        };

        // 한국어 및 미국 영어(en-US)만 유지
        const normLang = (l) => (l || '').toLowerCase().replace('_', '-');
        const ko = sortByNaturalness(
            ttsVoices
                .filter(v => normLang(v.lang).startsWith('ko'))
                .filter(v => !/india/i.test(v.name))
        );
        const enUs = sortByNaturalness(ttsVoices.filter(v => normLang(v.lang) === 'en-us'));

        const addGroup = (voices, label) => {
            if (!voices.length) return;
            const g = document.createElement('optgroup');
            g.label = label;
            voices.forEach(v => {
                const o = document.createElement('option');
                o.value = v.name;
                let displayName = v.name.replace(/Microsoft |Google |Apple /i, '');
                // 자연스러운 음성은 ✨ 표시, 온라인 전용은 ☁️ 표시
                if (NATURAL_VOICE_RE.test(v.name)) displayName = '✨ ' + displayName;
                o.textContent = displayName;
                if (v.localService === false) o.textContent += ' ☁️';
                g.appendChild(o);
            });
            sel.appendChild(g);
        };

        addGroup(ko, '🇰🇷 한국어');
        addGroup(enUs, '🇺🇸 English (US)');

        // 저장된 음성 복원, 없으면 가장 자연스러운 한국어 음성 우선 선택
        const allowed = [...ko, ...enUs];
        const saved = localStorage.getItem('faith_tts_voice');
        if (saved && allowed.find(v => v.name === saved)) {
            sel.value = saved;
        } else if (ko.length) {
            sel.value = ko[0].name;
        } else if (enUs.length) {
            sel.value = enUs[0].name;
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

    if (!isTTSSpeaking) refreshTTSTotalTime();
}

// ─── 재생 시간 계산/표시 ───

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const total = Math.round(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function estimateTotalTime() {
    const text = getTextToSpeak();
    if (!text) return 0;
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    const gap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0;
    const chunks = splitChunks(text, 180);
    const speakTime = text.length / CHARS_PER_SEC / speed;
    const baseGapTime = Math.max(0, chunks.length - 1) * gap;
    const dotGapTime = chunks
        .slice(0, -1)
        .reduce((sum, c) => sum + extraPauseForDots(c.dots), 0);
    return speakTime + baseGapTime + dotGapTime;
}

function getElapsedSec() {
    let ms = ttsElapsedBeforePause;
    if (isTTSSpeaking && !isTTSPaused && ttsPlayStartMs) {
        ms += Date.now() - ttsPlayStartMs;
    }
    return ms / 1000;
}

function updateTimeDisplay() {
    const el = document.getElementById('tts-time-text');
    if (!el) return;
    const total = ttsTotalSec || estimateTotalTime();
    const elapsed = Math.min(getElapsedSec(), total);
    el.textContent = `${formatTime(elapsed)} / ${formatTime(total)}`;
}

function buildChunkTimings(chunks, speed, gapSec) {
    const timings = [];
    let elapsed = 0;
    for (let i = 0; i < chunks.length; i++) {
        const spokenLen = cleanForSpeech(chunks[i].text).length;
        const speakSec = spokenLen / CHARS_PER_SEC / speed;
        timings.push({ index: i, startSec: elapsed, speakSec });
        elapsed += speakSec;
        if (i < chunks.length - 1) {
            elapsed += gapSec + extraPauseForDots(chunks[i].dots);
        }
    }
    return timings;
}

function getSeekState(text, percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const chunks = splitChunks(text, 180);
    if (!chunks.length) {
        return { percent: clamped, chunks: [], chunkIndex: 0, targetMs: 0 };
    }
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    const gap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0;
    const timings = buildChunkTimings(chunks, speed, gap);
    const totalSec = ttsTotalSec || estimateTotalTime();
    const targetSec = totalSec * (clamped / 100);
    const targetMs = Math.round(targetSec * 1000);

    let chunkIndex = chunks.length - 1;
    for (const t of timings) {
        if (targetSec < t.startSec + t.speakSec) {
            chunkIndex = t.index;
            break;
        }
    }
    return { percent: clamped, chunks, chunkIndex, targetMs };
}

function startTimeTicker() {
    stopTimeTicker();
    ttsTimerInterval = setInterval(updateTimeDisplay, 500);
}

function stopTimeTicker() {
    if (ttsTimerInterval) {
        clearInterval(ttsTimerInterval);
        ttsTimerInterval = null;
    }
}

export function refreshTTSTotalTime() {
    ttsTotalSec = estimateTotalTime();
    updateTimeDisplay();
}

// ─── 재생 ───

/** 괄호 () 및 전각 괄호 （） 안의 내용은 TTS에서 제외 */
function stripParentheses(text) {
    if (!text) return '';
    let prev;
    let cur = text;
    // 중첩 괄호까지 처리하기 위해 변화가 없을 때까지 반복
    do {
        prev = cur;
        cur = cur.replace(/\([^()]*\)/g, '').replace(/（[^（）]*）/g, '');
    } while (cur !== prev);
    return cur;
}

/**
 * 이모지·기호·특수문자는 제거하지만 운율(prosody)에 쓰이는 기본 문장부호는 남긴다.
 * 한국어 TTS 엔진은 쉼표·마침표 등을 소리내어 읽지 않고 "쉼/억양"에 사용하므로,
 * 이걸 남겨야 훨씬 자연스럽게 들린다.
 */
function cleanForSpeech(text) {
    if (!text) return '';
    // 일부 엔진이 아포스트로피/대시를 기호명으로 읽는 문제를 피하기 위해 사전 제거
    // 예) ' -> "아포스트로피", - -> "대시/다시"
    const normalized = text.replace(/['’`´\-‐‑‒–—―]+/g, ' ');
    // 허용: 글자(\p{L}), 숫자(\p{N}), 공백, 운율용 기본 문장부호
    //  . , ! ? : ; … · ~ 및 한중일 대응 부호(。、，．！？：；‥)
    //  큰따옴표·작은따옴표·한국식 인용부호(「」『』)
    const allowed = /[\p{L}\p{N}\s.,!?:;…·~。、，．！？：；‥"「」『』]/u;
    let out = '';
    for (const ch of normalized) {
        out += allowed.test(ch) ? ch : ' ';
    }
    return out.replace(/[ \t]+/g, ' ').trim();
}

function getTextToSpeak() {
    const full = getFullText();
    const s = ttsStartOffset || 0;
    const e = ttsEndOffset || full.length;
    return stripParentheses(full.substring(s, e)).trim();
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
        ttsPlayStartMs = Date.now();
        startTimeTicker();
        syncUI();
        return;
    }

    const text = getTextToSpeak();
    if (!text) { alert('읽을 내용이 없습니다.'); return; }

    // 새 재생 시: 사용자가 옮긴 진행바 위치(정지 상태에서도)를 시작점으로 반영
    const sliderPercent = Number(document.getElementById('tts-progress-slider')?.value || '0');
    const seekPercent = (sliderPercent > 0 && sliderPercent < 100) ? sliderPercent : 0;
    const seekState = getSeekState(text, seekPercent);

    speechSynthesis.cancel();
    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;

    ttsChunks = seekState.chunks;
    ttsChunkIndex = seekState.chunkIndex;
    ttsTotalSec = estimateTotalTime();
    ttsElapsedBeforePause = seekState.targetMs;
    ttsPlayStartMs = Date.now();
    setProgress(seekState.percent);
    updateTimeDisplay();
    startTimeTicker();
    speakNext();
}

export function seekTTSByPercent(percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const text = getTextToSpeak();
    const seekState = getSeekState(text, clamped);

    setProgress(clamped);
    ttsElapsedBeforePause = seekState.targetMs;
    ttsPlayStartMs = isTTSSpeaking && !isTTSPaused ? Date.now() : 0;
    updateTimeDisplay();

    if (!text) return;
    if (!seekState.chunks.length) return;

    const wasPlaying = isTTSSpeaking && !isTTSPaused;
    const wasPaused = isTTSPaused;

    ttsChunks = seekState.chunks;
    ttsChunkIndex = seekState.chunkIndex;

    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;
    speechSynthesis.cancel();

    if (wasPlaying) {
        isTTSPaused = false;
        isTTSSpeaking = true;
        ttsPlayStartMs = Date.now();
        startTimeTicker();
        speakNext();
    } else if (wasPaused) {
        isTTSPaused = true;
        isTTSSpeaking = true;
        syncUI();
    }
}

function splitChunks(text, max) {
    const chunks = [];
    // 문장 단위로 분리: "내용 + 종결부호(.!?。 연속 허용) 또는 줄바꿈"
    // 연속 마침표(예: "...")는 하나의 청크 끝에 그대로 유지되어 쉼 길이 계산에 사용된다.
    const sentences = text.match(/[^.!?。\n]*(?:[.!?。]+|\n+|$)/g) || [];
    for (const s of sentences) {
        const trimmed = s.trim();
        if (!trimmed) continue;
        // 말미 마침표 개수 추출 (쉼 길이 계산용)
        const dotMatch = trimmed.match(/\.+$/);
        const dots = dotMatch ? dotMatch[0].length : 0;

        // 문장이 max를 넘으면 쉼표/중간 구두점에서 한번 더 나눔
        if (trimmed.length > max) {
            const sub = trimmed.split(/(?<=[,;:·])\s*/);
            let cur = '';
            for (const part of sub) {
                if ((cur + ' ' + part).length > max && cur) {
                    chunks.push({ text: cur.trim(), dots: 0 });
                    cur = part;
                } else {
                    cur += (cur ? ' ' : '') + part;
                }
            }
            if (cur.trim()) chunks.push({ text: cur.trim(), dots });
        } else {
            chunks.push({ text: trimmed, dots });
        }
    }
    return chunks.length ? chunks : [{ text, dots: 0 }];
}

/** 청크의 마침표 개수에 따른 추가 쉼(초) — 1개는 일반 문장 종결이므로 추가 없음 */
function extraPauseForDots(dots) {
    return Math.max(0, (dots || 0) - 1) * DOT_EXTRA_PAUSE_SEC;
}

function speakNext() {
    if (ttsChunkIndex >= ttsChunks.length) {
        isTTSSpeaking = false;
        isTTSPaused = false;
        ttsChunkIndex = 0;
        setProgress(100);
        stopTimeTicker();
        ttsElapsedBeforePause = (ttsTotalSec || 0) * 1000;
        ttsPlayStartMs = 0;
        updateTimeDisplay();
        syncUI();
        return;
    }

    // 현재 청크에서 문장부호·이모지 등을 제거하고 글자만 남김
    const currentChunk = ttsChunks[ttsChunkIndex];
    const spoken = cleanForSpeech(currentChunk.text);
    if (!spoken) {
        // 읽을 내용이 없으면 다음 청크로 스킵
        ttsChunkIndex++;
        setProgress(Math.round((ttsChunkIndex / ttsChunks.length) * 100));
        speakNext();
        return;
    }

    const utt = new SpeechSynthesisUtterance(spoken);

    // 음성: 선택된 음성 하나로 고정 (lang까지 맞춰 다른 음성이 섞이지 않도록)
    const voiceName = document.getElementById('tts-voice-select')?.value;
    if (voiceName) {
        const v = ttsVoices.find(x => x.name === voiceName);
        if (v) {
            utt.voice = v;
            utt.lang = v.lang;
        }
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
        const baseGap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') * 1000;
        const dotGap = extraPauseForDots(currentChunk.dots) * 1000;
        const totalGap = baseGap + dotGap;
        if (totalGap > 0 && ttsChunkIndex < ttsChunks.length) {
            ttsGapTimer = setTimeout(() => speakNext(), totalGap);
        } else {
            speakNext();
        }
    };
    utt.onerror = (e) => {
        if (e.error !== 'canceled') console.error('TTS error:', e.error);
        isTTSSpeaking = false; isTTSPaused = false;
        stopTimeTicker();
        syncUI();
    };

    setProgress(Math.round((ttsChunkIndex / ttsChunks.length) * 100));
    speechSynthesis.speak(utt);
}

export function pauseTTS() {
    if (isTTSSpeaking && !isTTSPaused) {
        speechSynthesis.pause();
        isTTSPaused = true;
        if (ttsPlayStartMs) {
            ttsElapsedBeforePause += Date.now() - ttsPlayStartMs;
            ttsPlayStartMs = 0;
        }
        stopTimeTicker();
        updateTimeDisplay();
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
    stopTimeTicker();
    ttsElapsedBeforePause = 0;
    ttsPlayStartMs = 0;
    ttsTotalSec = estimateTotalTime();
    updateTimeDisplay();
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
    const selText = stripParentheses(info.text).trim();
    if (!selText) { alert('읽을 내용이 없습니다.'); return; }
    ttsChunks = splitChunks(selText, 180);
    ttsChunkIndex = 0;
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    const gap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0;
    const dotGapTime = ttsChunks
        .slice(0, -1)
        .reduce((sum, c) => sum + extraPauseForDots(c.dots), 0);
    ttsTotalSec = selText.length / CHARS_PER_SEC / speed
        + Math.max(0, ttsChunks.length - 1) * gap
        + dotGapTime;
    ttsElapsedBeforePause = 0;
    ttsPlayStartMs = Date.now();
    updateTimeDisplay();
    startTimeTicker();
    speakNext();
}

// ─── UI 동기화 ───

function setProgress(pct) {
    const bar = document.getElementById('tts-progress-bar');
    const txt = document.getElementById('tts-progress-text');
    const slider = document.getElementById('tts-progress-slider');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = pct + '%';
    if (slider) slider.value = String(Math.round(pct));
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
    if (!isTTSSpeaking) refreshTTSTotalTime();
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
    if (!isTTSSpeaking) refreshTTSTotalTime();
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
    updateTimeDisplay();
}

export { refreshRangeDisplay as updateTTSRange };
