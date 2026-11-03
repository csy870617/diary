/**
 * TTS (Text-to-Speech) 모듈 v2
 * Web Speech API 기반 - 미니 플레이어 UI
 * + 자연스러운 음성(Supertonic 3, 내려받아 기기에서 생성) — neural-tts.js
 */

import {
    NEURAL_PREFIX, NEURAL_VOICES, NEURAL_MAX_CHUNK, NEURAL_SENTENCE_MAX, NEURAL_CHARS_PER_SEC,
    isNeuralVoice, isNeuralSupported, isNeuralReady, isNeuralLoaded, downloadNeuralVoice, cancelNeuralDownload,
    deleteNeuralVoice, synthesizeNeural, cancelNeuralBefore, unlockNeuralAudio, playNeuralAudio,
    stopNeuralAudio, pauseNeuralAudio, resumeNeuralAudio, reportNeuralStall, beginNeuralSession, getNeuralInfo,
    scheduleNeuralAudio, unscheduleNeuralAfter, neuralClock, neuralModelSpeed, restretchNeural,
    checkNeuralUpdate, addNeuralDiag, getNeuralMinSteps, neuralWasEvicted, inAppBrowserName
} from './neural-tts.js';
import { state } from './state.js';
import { jumpToPage } from './editor.js';
import { normalizeForSpeech, noBreakMask } from './speech-text.js';

let ttsVoices = [];
let isTTSSpeaking = false;
let isTTSPaused = false;
let ttsChunks = [];
let ttsChunkIndex = 0;
let ttsGapTimer = null;
let ttsGen = 0;                // 재생 세대 카운터 — 이전 발화의 stale onend/onerror 무시용
let ttsGapInterrupted = false; // 청크 간 쉼 도중 일시정지됨 → 재개 시 speakNext로 진입
let systemWatchTimer = null;   // 기본 음성이 읽는 동안 살피는 타이머 (startSystemWatch)
let currentUtterance = null;   // 읽고 있는 발화 — 크롬이 읽는 도중 객체를 치워 끝 알림이 오지 않는 일을 막는다
let ttsVoicesListener = null;

// 재생 시간 추적
let ttsTotalSec = 0;           // 예상 총 재생 시간
let ttsPlayStartMs = 0;        // 현재 재생 세션 시작 시각
let ttsElapsedBeforePause = 0; // 일시정지 전까지 누적된 경과(ms)
let ttsTimerInterval = null;
let ttsTimingParams = null;     // 지금 시간 계산에 쓴 속도·쉼 — 읽는 중에 바꾸면 이 값과 비교해 다시 계산

// 1x 속도에서 TTS가 읽는 평균 문자 수/초 (경험적 추정)
const CHARS_PER_SEC = 13;
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
// 아이폰·아이패드(모든 브라우저가 WebKit)와 맥 사파리 — 읽기를 멈춘(cancel) 직후 바로 읽히면 새 발화를
// 시작도 않고 끝내 버리는 일이 있어 잠깐 기다렸다 읽는다 (Readium speech가 쓰는 250ms)
const IS_WEBKIT_SPEECH = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent || '')
    || (/Macintosh/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1)
    || (/Safari/.test(navigator.userAgent || '') && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(navigator.userAgent || '')));
const CANCEL_SETTLE_MS = IS_WEBKIT_SPEECH ? 250 : 0;
/** 멈춘 뒤 다음 문장을 읽기 시작한다 (기본 음성은 엔진이 멈춤을 다 처리할 틈을 준다) */
// 일시정지·정지·다른 탐색이 이 기다림을 거둘 수 있게 문장 사이 쉼과 같은 타이머(ttsGapTimer)에 둔다
// (따로 두면 진행바를 끄는 동안 같은 문장이 여러 번 줄 서 읽히고, 그 사이 누른 일시정지가 무시됐다)
function speakSoon() {
    clearTimeout(ttsGapTimer);
    const g = ttsGen;
    ttsGapTimer = setTimeout(() => { ttsGapTimer = null; if (g === ttsGen) speakNext(); }, usingNeural() ? 0 : CANCEL_SETTLE_MS);
}

function currentSpeed() {
    return parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
}

function selectedVoiceValue() {
    return document.getElementById('tts-voice-select')?.value || '';
}
function usingNeural() {
    return isNeuralVoice(selectedVoiceValue());
}
// 자연스러운 음성은 기본 음성보다 천천히 읽는다 (재생 시간 예상·탐색 위치 계산용)
function charsPerSec() {
    return timingNeural() ? NEURAL_CHARS_PER_SEC : CHARS_PER_SEC;
}
// 음성 바를 연 직후에는 받아 둔 음성 확인이 끝나기 전이라 목록에 아직 기본 음성이 골라져 있다.
// 그사이 시간을 기본 음성 빠르기로 잠깐 잘못 보여 주지 않도록, 저장해 둔 음성이 자연스러운 음성이면 그것으로 계산한다.
let neuralGroupPending = false;
function timingNeural() {
    if (usingNeural()) return true;
    if (!neuralGroupPending) return false;
    try { return isNeuralVoice(localStorage.getItem('faith_tts_voice')); } catch (e) { return false; }
}

// 마침표 1개를 초과하는 각 마침표마다 추가되는 쉼(초). "..." = 기본 간격 + 1.0초
const DOT_EXTRA_PAUSE_SEC = 0.5;

// ─── 텍스트 추출 (Range 기반으로 일관성 유지) ───

const TEXT_BLOCKS = new Set([
    'DIV','P','BR','LI','TR','H1','H2','H3','H4','H5','H6',
    'BLOCKQUOTE','PRE','HR','UL','OL','TABLE','SECTION','ARTICLE'
]);

/**
 * 본문을 읽을 글자로 펼치면서, 각 글자 마디(text node)가 어디서 시작하는지도 기록한다.
 * 블록 요소·<br> 경계에는 \n을 넣는다.
 * 기록한 위치로 '지금 읽는 문장'을 화면에서 찾아 강조하고, 두 번 누른 곳이 몇 번째 글자인지 계산한다.
 * → { text, segs: [{ node, start }] }
 */
function buildTextIndex(root) {
    function walk(parent) {
        let text = '';
        const segs = [];
        for (const node of parent.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                segs.push({ node, start: text.length });
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName;
                if (tag === 'BR') {
                    text += '\n';
                } else {
                    const inner = walk(node);
                    if (TEXT_BLOCKS.has(tag)) {
                        if (!inner.text) continue;
                        if (text && !text.endsWith('\n')) text += '\n';
                    }
                    const base = text.length;
                    inner.segs.forEach(sg => segs.push({ node: sg.node, start: base + sg.start }));
                    text += inner.text;
                }
            }
        }
        return { text, segs };
    }
    return root ? walk(root) : { text: '', segs: [] };
}

function getTextIndex() {
    return buildTextIndex(document.getElementById('editor-body'));
}

function getFullText() {
    return getTextIndex().text;
}

/** 화면의 한 위치(마디, 그 안의 위치)가 펼친 글자에서 몇 번째인지 */
function offsetAtPosition(index, container, offset) {
    if (!container) return null;
    if (container.nodeType === Node.TEXT_NODE) {
        const seg = index.segs.find(sg => sg.node === container);
        if (seg) return seg.start + Math.min(offset, container.textContent.length);
    }
    // 요소 사이의 위치이거나 기록에 없는 마디 → 그 뒤에 처음 나오는 글자 마디의 시작
    try {
        const r = document.createRange();
        r.setStart(container, container.nodeType === Node.TEXT_NODE ? Math.min(offset, container.textContent.length) : offset);
        r.collapse(true);
        for (const seg of index.segs) {
            if (r.comparePoint(seg.node, 0) >= 0) return seg.start;
        }
    } catch (e) { return null; }
    return index.text.length;
}

/** 펼친 글자의 [start, end) 구간을 화면의 Range로 */
function rangeFromOffsets(index, start, end) {
    const segs = index.segs;
    let startPt = null, endPt = null;
    for (const seg of segs) {
        const len = seg.node.textContent.length;
        if (!len) continue;
        if (!startPt && start < seg.start + len) {
            startPt = { node: seg.node, offset: Math.max(0, start - seg.start) };
        }
        if (seg.start < end) endPt = { node: seg.node, offset: Math.min(len, end - seg.start) };
        else break;
    }
    if (!startPt || !endPt) return null;
    try {
        const r = document.createRange();
        r.setStart(startPt.node, startPt.offset);
        r.setEnd(endPt.node, endPt.offset);
        return r.collapsed ? null : r;
    } catch (e) { return null; }
}


// ─── 지금 읽는 문장 강조 · 문장을 두 번 눌러 거기서부터 읽기 ───
// 강조는 CSS Highlight API로 그린다. 본문 HTML을 건드리지 않으므로 표시가 글에 저장될 일이 없다.
// (지원하지 않는 브라우저에서는 강조만 생략되고 나머지는 그대로 동작)
const HIGHLIGHT_NAME = 'tts-current';
const canHighlight = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
let lastUserScrollMs = 0;

function clearTTSHighlight() {
    if (canHighlight) CSS.highlights.delete(HIGHLIGHT_NAME);
}

function isBookMode() {
    return state.currentViewMode === 'book' || state.currentViewMode === 'book-edit';
}

function highlightChunk(chunk) {
    if (!canHighlight || !chunk || chunk.fullStart == null) { clearTTSHighlight(); return; }
    const range = rangeFromOffsets(getTextIndex(), chunk.fullStart, chunk.fullEnd);
    if (!range) { clearTTSHighlight(); return; }
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
    followRange(range);
}

/** 읽는 문장이 화면 밖이면 따라간다. 사용자가 방금 직접 스크롤했다면 방해하지 않는다. */
function followRange(range) {
    if (Date.now() - lastUserScrollMs < 4000) return;
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const container = document.getElementById('editor-container');
    if (!container) return;
    if (isBookMode()) {
        // 책 보기: 그 문장이 있는 쪽으로 넘긴다
        const stride = Math.floor(container.clientWidth);
        if (stride <= 0) return;
        const cRect = container.getBoundingClientRect();
        const page = Math.floor((rect.left - cRect.left + container.scrollLeft + 1) / stride);
        if (page !== Math.round(container.scrollLeft / stride)) jumpToPage(page);
        return;
    }
    // 화면 아래쪽은 음성 바가 가리므로 그만큼 빼고 본다
    const panel = document.getElementById('tts-panel');
    const panelTop = panel && !panel.classList.contains('hidden') ? panel.getBoundingClientRect().top : window.innerHeight;
    const visTop = Math.max(0, container.getBoundingClientRect().top);
    const visBottom = Math.min(window.innerHeight, panelTop);
    if (rect.top >= visTop + 8 && rect.bottom <= visBottom - 8) return;
    const scroller = findScrollParent(range.startContainer.parentElement) || container;
    const delta = rect.top - (visTop + (visBottom - visTop) * 0.3);
    scroller.scrollBy({ top: delta, behavior: 'smooth' });
}

function findScrollParent(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
}

function caretFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) return { node: p.offsetNode, offset: p.offset };
    }
    if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
}

function ttsPanelOpen() {
    const panel = document.getElementById('tts-panel');
    return !!panel && !panel.classList.contains('hidden');
}

/* 음성 바가 열려 있으면 문장을 두 번 누른(두 번 클릭한) 곳부터 읽는다 (보기·편집 모두).
   예전에는 한 번만 눌러도 읽는 자리가 옮겨 가, 글을 고치려고 커서를 놓을 때마다 거기서부터 다시 읽었다.
   이제 한 번 누르기는 커서 놓기·쪽 넘기기에 그대로 두고, 두 번 누를 때만 읽을 자리를 정한다. */
const DOUBLE_TAP_MS = 400;   // 앞 손가락을 뗀 뒤 이 안에 다시 눌러야 두 번 누르기
const DOUBLE_TAP_PX = 30;    // 두 번 누른 자리가 이만큼 안에 있어야 한다
const TAP_MOVE_PX = 10;      // 누른 채 이보다 많이 움직이면 누르기가 아니라 밀기
let lastTap = null;          // 바로 앞 누르기 { x, y, t }
let tapStart = null;         // 지금 누르고 있는 손가락 { x, y, t, second }
let lastTouchMs = 0;
let seekGuardUntil = 0;

function canSeekFrom(target) {
    // 예전 아이폰은 손가락이 닿은 글자 마디(text node)를 대상으로 주기도 한다
    const el = target && target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    if (!ttsPanelOpen() || !el || el.nodeType !== Node.ELEMENT_NODE) return false;
    return !el.closest('a, img, button, input, select, textarea, .tts-panel');
}

function seekToPoint(x, y) {
    const pt = caretFromPoint(x, y);
    if (!pt) return;
    const pos = offsetAtPosition(getTextIndex(), pt.node, pt.offset);
    if (pos == null) return;
    seekGuardUntil = Date.now() + 500;
    playFromOffset(pos);
}

/** 마우스: 두 번째로 누르는 순간에 읽을 자리를 정한다 (그 자리의 단어를 고르지 않는다) */
function onEditorMouseDownForTTS(e) {
    if (e.button !== 0 || e.detail !== 2) return;
    if (Date.now() - lastTouchMs < 1000) return;                  // 손가락 뒤에 따라오는 흉내 마우스는 아래에서 이미 처리했다
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // 늘려 고르기 등 키를 함께 누른 경우는 그대로
    if (!canSeekFrom(e.target)) return;
    e.preventDefault();
    seekToPoint(e.clientX, e.clientY);
}

/* 손가락: 브라우저마다 두 번 누르기를 다르게 다루므로(아이폰은 dblclick을 보내지 않기도 한다) 직접 센다 */
function onEditorTouchStartForTTS(e) {
    lastTouchMs = Date.now();
    if (e.touches.length !== 1) { tapStart = null; lastTap = null; return; }
    const t = e.touches[0];
    const now = Date.now();
    const second = !!lastTap && now - lastTap.t < DOUBLE_TAP_MS
        && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < DOUBLE_TAP_PX
        && canSeekFrom(e.target);
    // 두 번째 누르기에는 브라우저가 단어를 고르거나 확대하지 않게 한다
    if (second && e.cancelable) e.preventDefault();
    tapStart = { x: t.clientX, y: t.clientY, t: now, second };
}

function onEditorTouchEndForTTS(e) {
    lastTouchMs = Date.now();
    const s = tapStart;
    tapStart = null;
    const t = e.changedTouches[0];
    if (!s || !t || e.touches.length > 0) { lastTap = null; return; }
    if (Math.hypot(t.clientX - s.x, t.clientY - s.y) > TAP_MOVE_PX || Date.now() - s.t > 500) {
        lastTap = null;   // 밀기·길게 누르기
        return;
    }
    if (s.second) {
        lastTap = null;
        if (e.cancelable) e.preventDefault();
        seekToPoint(t.clientX, t.clientY);
        return;
    }
    lastTap = { x: t.clientX, y: t.clientY, t: Date.now() };
}

/** 그래도 그 자리의 단어가 골라지면(아이폰의 단어 고르기, 표 칸의 두 번 클릭 고르기) 곧바로 풀어 준다 */
function onSelectionChangeForTTS() {
    if (Date.now() > seekGuardUntil) return;
    const sel = window.getSelection();
    const body = document.getElementById('editor-body');
    if (sel && !sel.isCollapsed && body && body.contains(sel.anchorNode)) sel.collapseToStart();
}

function playFromOffset(pos) {
    const neural = usingNeural();
    if (!neural && !('speechSynthesis' in window)) return;
    if (neural) unlockNeuralAudio();   // 누른 순간에 소리 장치를 깨워 둔다 (아이폰)
    const src = getSpeechSource();
    if (!src.text) return;
    const { chunks, index } = buildReadingChunks(src, pos);
    startPlaybackAt(chunks, index);
}

/** chunks[index]부터 읽기 시작 (경과 시간·진행률도 그 위치로 맞춘다) */
function startPlaybackAt(chunks, index) {
    ttsGen++; // 이전 발화의 stale 이벤트 무효화
    ttsGapInterrupted = false;
    cancelSystemSpeech();
    stopNeuralAudio();
    cancelNeuralBefore(ttsGen);
    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;

    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    const gap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0;
    const timings = buildChunkTimings(chunks, speed, gap);
    ttsChunks = chunks;
    ttsChunkIndex = index;
    ttsTimingParams = { speed, gap };
    ttsTotalSec = estimateTotalTime();
    const startSec = timings[index] ? timings[index].startSec : 0;
    ttsElapsedBeforePause = Math.round(startSec * 1000);
    setProgress(ttsTotalSec > 0 ? Math.min(100, Math.round(startSec / ttsTotalSec * 100)) : 0);
    isTTSSpeaking = true;
    isTTSPaused = false;
    ttsPlayStartMs = Date.now();
    updateTimeDisplay();
    startTimeTicker();
    syncUI();
    speakSoon();
}

// ─── 패널 토글 ───

// 설정 창이 펼쳐져 있는지를 글쓰기 창에 표시한다(tts-settings-open) — 좁은 화면에서 '맨 위로' 버튼이
// 설정 창을 가리지 않게 하는 데 쓴다(style.css). 설정 창은 설정 버튼뿐 아니라 바깥 누르기·화면 전환 등
// 여러 곳에서 닫히므로, 닫는 곳마다 고치는 대신 class 변화를 직접 지켜본다.
let settingsWatcher = null;
function watchSettingsDrawer() {
    const settings = document.getElementById('tts-settings');
    const modal = document.getElementById('write-modal');
    if (settingsWatcher || !settings || !modal || typeof MutationObserver === 'undefined') return;
    const sync = () => modal.classList.toggle('tts-settings-open', !settings.classList.contains('hidden'));
    settingsWatcher = new MutationObserver(sync);
    settingsWatcher.observe(settings, { attributes: true, attributeFilter: ['class'] });
    sync();
}

export function toggleTTSPanel() {
    const panel = document.getElementById('tts-panel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        watchSettingsDrawer();
        // 화면 아래의 다른 창(맞춤법 검사)은 닫는다 — 같은 자리를 쓴다
        window.dispatchEvent(new CustomEvent('bottom-panel-open', { detail: 'tts' }));
        panel.classList.remove('hidden');
        document.getElementById('write-modal')?.classList.add('tts-open');
        // 새 기능 안내: 처음 몇 번만 알려 준다
        try {
            const seen = Number(localStorage.getItem('faith_tts_dbltap_hint') || '0');
            if (seen < 3) {
                localStorage.setItem('faith_tts_dbltap_hint', String(seen + 1));
                setTimeout(() => showToast('문장을 두 번 누르면 그 문장부터 읽습니다.'), 300);
            }
        } catch (_) {}
        loadVoices();
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
    if (!settings.classList.contains('hidden')) refreshNeuralRow();   // 계산 장치·품질 표시를 최신으로
}

function closeTTSSettings() {
    const settings = document.getElementById('tts-settings');
    if (settings) settings.classList.add('hidden');
}

// ─── 음성 로드 ───

// 자연스러운(Neural/Natural) 음성을 식별하기 위한 키워드
const NATURAL_VOICE_RE = /natural|neural|online|enhanced|premium|wavenet|studio|neural2/i;

// 내려받아 둔 자연스러운 음성을 목록 맨 위에 넣는다 (받지 않았으면 넣지 않는다)
async function addNeuralGroup(sel, saved) {
    neuralGroupPending = true;
    let ready = false;
    try { ready = await isNeuralReady(); } finally { neuralGroupPending = false; }
    sel.querySelector('optgroup[data-neural]')?.remove();
    if (ready) {
        const g = document.createElement('optgroup');
        g.label = '✨ 자연스러운 음성';
        g.dataset.neural = '1';
        NEURAL_VOICES.forEach(v => {
            const o = document.createElement('option');
            o.value = NEURAL_PREFIX + v.id;
            o.textContent = '✨ ' + v.label;
            g.appendChild(o);
        });
        sel.insertBefore(g, sel.firstChild);
        if (isNeuralVoice(saved)) sel.value = saved;
    } else if (isNeuralVoice(sel.value)) {
        // 받아 둔 음성이 지워졌으면 기본 음성 중 첫 번째로
        const first = sel.querySelector('option:not([value^="' + NEURAL_PREFIX + '"])');
        if (first) sel.value = first.value;
    }
    // 받아 둔 음성 확인은 조금 늦게 끝난다 — 음성이 정해진 뒤 그 음성의 빠르기로 시간을 다시 계산한다
    if (!isTTSSpeaking) refreshTTSTotalTime();
}

export function loadVoices() {
    const sel = document.getElementById('tts-voice-select');
    if (!sel) return;
    if (!('speechSynthesis' in window)) {
        // 기본 음성 엔진이 없어도 자연스러운 음성은 쓸 수 있다
        sel.innerHTML = '';
        addNeuralGroup(sel, localStorage.getItem('faith_tts_voice'));
        refreshNeuralRow();
        return;
    }
    refreshNeuralRow();

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
        addNeuralGroup(sel, saved);
    };

    populate();
    // 음성 목록은 늦게, 여러 번에 나눠 채워지기도 한다 (엣지의 온라인 음성 등).
    // 예전에는 처음 몇 개가 오면 더 듣지 않아 나중에 온 음성이 목록에 없었고, 저장해 둔 음성 대신
    // 다른 음성으로 읽었다. 목록이 바뀔 때마다(이름이 달라졌을 때만) 다시 채운다.
    if (!ttsVoicesListener) {
        ttsVoicesListener = () => {
            const names = speechSynthesis.getVoices().map(v => v.voiceURI || v.name).join('|');
            if (names === ttsVoicesListener.names) return;
            ttsVoicesListener.names = names;
            // 읽는 중에는 목록을 다시 그리지 않는다 (고른 음성이 잠깐 다른 음성으로 바뀐다) — 다음 재생 때 다시 그린다
            if (isTTSSpeaking || isTTSPaused) { ttsVoices = speechSynthesis.getVoices(); ttsVoicesListener.stale = true; return; }
            populate();
        };
        ttsVoicesListener.names = ttsVoices.map(v => v.voiceURI || v.name).join('|');
        speechSynthesis.addEventListener('voiceschanged', ttsVoicesListener);
    }
}

/**
 * 음성 목록·받아 둔 자연스러운 음성 확인이 끝나기 전에 재생을 누르면 첫 문장은 엔진의 기본 음성으로,
 * 다음 문장부터는 고른 음성으로 읽혀 목소리가 바뀌었다. 끝날 때까지(최대 1.2초) 기다린다.
 */
function voicesSettled() {
    if (neuralGroupPending) {
        let saved = '';
        try { saved = localStorage.getItem('faith_tts_voice') || ''; } catch (e) {}
        if (isNeuralVoice(saved)) return false;
    }
    if (usingNeural() || !('speechSynthesis' in window)) return true;
    return ttsVoices.length > 0;
}
function waitForVoices(ms = 1200) {
    if (voicesSettled()) return Promise.resolve();
    return new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            if ('speechSynthesis' in window && !ttsVoices.length && speechSynthesis.getVoices().length) loadVoices();
            if (voicesSettled() || Date.now() - t0 > ms) { clearInterval(timer); resolve(); }
        }, 50);
    });
}

// ─── 자연스러운 음성 내려받기 ───
let neuralDownloading = false;

function setNeuralRow(statusText, btnText, progressPct, detail) {
    const status = document.getElementById('tts-neural-status');
    const btn = document.getElementById('tts-neural-btn');
    const bar = document.getElementById('tts-neural-progress');
    const fill = document.getElementById('tts-neural-progress-fill');
    if (status) { status.textContent = statusText; status.title = detail || statusText; }
    if (btn) btn.textContent = btnText;
    if (bar) bar.classList.toggle('hidden', progressPct == null);
    if (fill && progressPct != null) fill.style.width = progressPct + '%';
}

let neuralUpdate = null;   // { bytes, note } — 받아 둔 음성보다 새 버전(더 빠른 엔진 등)이 있을 때

// 새 버전 안내 이름: 음성 목록이 알려 주는 한 줄(예: '더 자연스러운 음성')을 쓰고, 없으면 일반 이름
function neuralUpdateName() {
    const note = (neuralUpdate && neuralUpdate.note || '').trim();
    return note ? `${note} 엔진` : '새 음성 엔진';
}

async function refreshNeuralRow() {
    const row = document.getElementById('tts-neural-row');
    if (!row) return;
    if (!isNeuralSupported()) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    if (neuralDownloading) return;
    // 확인이 오래 걸리면(예전 저장 위치에서 옮겨 오는 중) 그동안 내려받기 버튼 대신 안내를 보여 준다
    const slow = setTimeout(() => setNeuralRow('받아 둔 음성을 확인하는 중…', '…', null), 400);
    let ready = false;
    try { ready = await isNeuralReady(); } finally { clearTimeout(slow); }
    if (neuralDownloading) return;
    if (ready) {
        const info = getNeuralInfo();
        // 받은 뒤에는 짧게 한 줄만 (계산 방식·품질은 누르고 있으면 보이는 설명으로)
        const where = info.backend ? `${info.backend === 'webgpu' ? 'GPU로 계산' : 'CPU로 계산'} · 품질 ${info.steps}/8` : '';
        setNeuralRow('받아 둠 ✓', '삭제', null, where ? '인터넷 없이 사용 가능 · ' + where : '인터넷 없이 사용 가능');
        // 더 자연스럽거나 빠른 엔진 등 새 버전이 있으면 업데이트를 권한다 (확인은 인터넷이 될 때만)
        neuralUpdate = await checkNeuralUpdate();
        if (neuralUpdate && !neuralDownloading) {
            const mb = Math.max(1, Math.round(neuralUpdate.bytes / 1e6));
            setNeuralRow(`새 버전 · 약 ${mb}MB`, '업데이트', null, `${neuralUpdateName()}이 있습니다 (약 ${mb}MB)`);
        }
    } else {
        // 받아 둔 파일을 브라우저가 지웠다면 이유를 알려 준다 (앱 안 브라우저·사생활 보호 모드·종료 시 데이터 삭제 설정 등)
        const app = inAppBrowserName();
        // 휴대폰에서도 한 줄에 들어가게 짧게 쓰고, 자세한 안내는 누르고 있으면 보이는 설명과 내려받기 확인 창에 둔다
        const msg = neuralWasEvicted() ? '지워짐 · 다시 받아 주세요' : '약 250~500MB · 와이파이 권장';
        let detail = neuralWasEvicted() ? '브라우저가 받아 둔 음성을 지웠습니다. 다시 받아 주세요.' : '약 250~500MB · 와이파이에서 받기를 권장합니다';
        if (app) detail += ` · ${app} 안에서는 받은 음성이 지워질 수 있어 Chrome·Safari로 여는 것을 권장합니다`;
        setNeuralRow(msg, '내려받기', null, detail);
    }
}

async function onNeuralButton() {
    if (document.getElementById('tts-neural-btn')?.textContent === '…') return;   // 확인 중
    if (neuralDownloading) {
        cancelNeuralDownload();
        return;
    }
    if (neuralUpdate && await isNeuralReady()) {
        const mb = Math.max(1, Math.round(neuralUpdate.bytes / 1e6));
        if (!confirm(`${neuralUpdateName()}(약 ${mb}MB)을 받습니다.\n받은 부분은 그대로 두고 새로 필요한 파일만 받습니다. 계속할까요?`)) return;
        if (usingNeural()) stopTTS();
        neuralDownloading = true;
        setNeuralRow('받는 중… 0%', '취소', 0);
        try {
            await downloadNeuralVoice((got, total) => {
                const pct = total ? Math.floor(got / total * 100) : 0;
                setNeuralRow(`받는 중… ${pct}%`, '취소', pct, `${Math.round(got / 1e6)} / ${Math.round(total / 1e6)}MB`);
            });
            neuralUpdate = null;
            showToast('음성 엔진을 업데이트했습니다.');
        } catch (err) {
            if (err && err.name === 'AbortError') showToast('업데이트를 취소했습니다.');
            else alert('업데이트를 받지 못했습니다.\n' + (err && err.message || err));
        } finally {
            neuralDownloading = false;
            refreshNeuralRow();
        }
        return;
    }
    if (await isNeuralReady()) {
        if (!confirm('내려받은 자연스러운 음성을 기기에서 지울까요?\n(필요하면 언제든 다시 받을 수 있습니다)')) return;
        if (usingNeural()) stopTTS();
        await deleteNeuralVoice();
        loadVoices();
        showToast('자연스러운 음성을 지웠습니다.');
        return;
    }
    const inApp = inAppBrowserName();
    const appWarn = inApp ? `\n\n지금은 ${inApp} 안의 브라우저입니다. 여기서 받으면 앱을 다시 열 때 지워질 수 있으니, Chrome이나 Safari에서 열어 받는 것을 권장합니다.` : '';
    if (!confirm('자연스러운 음성(약 250~500MB, 기기에 따라 다름)을 내려받습니다.\n데이터 요금이 들 수 있으니 와이파이에서 받기를 권장합니다.\n\n한 번 받으면 인터넷 없이도 쓸 수 있습니다. 계속할까요?' + appWarn)) return;
    neuralDownloading = true;
    setNeuralRow('받는 중… 0%', '취소', 0);
    try {
        await downloadNeuralVoice((got, total) => {
            const pct = total ? Math.floor(got / total * 100) : 0;
            setNeuralRow(`받는 중… ${pct}% (${Math.round(got / 1e6)}/${Math.round(total / 1e6)}MB)`, '취소', pct);
        });
        neuralDownloading = false;
        localStorage.setItem('faith_tts_voice', NEURAL_PREFIX + 'F1');
        loadVoices();
        showToast('자연스러운 음성을 받았습니다. 음성 목록에서 고를 수 있습니다.');
    } catch (err) {
        neuralDownloading = false;
        if (err && err.name === 'AbortError') showToast('내려받기를 취소했습니다.');
        else alert('자연스러운 음성을 받지 못했습니다.\n' + (err && err.message || err) + '\n\n받은 부분은 남아 있어 다시 누르면 이어서 받습니다.');
        refreshNeuralRow();
    }
}

// ─── 미리 듣기 ───
// 음성을 고를 때 글을 재생하지 않고도 목소리를 들어 볼 수 있게, 고른 음성으로 짧은 문장 하나를 읽는다.
const PREVIEW_KO = '안녕하세요. 오늘도 주님의 은혜 안에서 평안한 하루 보내세요.';
const PREVIEW_EN = 'Hello. May the grace of the Lord be with you today.';
let previewGen = 0;   // 미리 듣기 차례 — 다시 누르거나 재생을 시작하면 앞의 것은 버린다
let previewing = false;

function setPreviewButton(mode) {   // 'play' | 'stop' | 'wait'
    const btn = document.getElementById('tts-preview-btn');
    if (!btn) return;
    btn.innerHTML = mode === 'wait' ? '<i class="ph ph-spinner-gap tts-spin"></i>' : `<i class="ph-fill ph-${mode === 'stop' ? 'stop' : 'play'}"></i>`;
    btn.title = mode === 'play' ? '미리 듣기' : mode === 'wait' ? '목소리를 준비하는 중' : '미리 듣기 멈추기';
    btn.setAttribute('aria-label', btn.title);
}

/** 미리 듣기를 멈춘다 (재생을 시작하거나 음성을 바꿀 때도 부른다) */
export function stopVoicePreview() {
    if (!previewing) return;
    previewGen++;
    previewing = false;
    stopNeuralAudio();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    setPreviewButton('play');
}

export async function previewVoice() {
    if (previewing) { stopVoicePreview(); return; }
    const value = selectedVoiceValue();
    if (!value) return;
    const neural = usingNeural();
    if (neural) unlockNeuralAudio();   // 아이폰: 누른 순간에 소리 장치를 깨운다
    else if (!('speechSynthesis' in window)) return;
    if (isTTSSpeaking || isTTSPaused) stopTTS();   // 글을 읽던 중이면 멈추고 들려준다
    const my = ++previewGen;
    previewing = true;
    const voice = neural ? null : selectedSystemVoice();
    const english = voice && /^en/i.test(voice.lang || '');
    const text = english ? PREVIEW_EN : PREVIEW_KO;
    const done = () => { if (my === previewGen) { previewing = false; setPreviewButton('play'); } };
    if (!neural) {
        cancelSystemSpeech();
        const utt = new SpeechSynthesisUtterance(text);
        if (voice) { utt.voice = voice; utt.lang = voice.lang; }
        utt.rate = currentSpeed();
        utt.onend = done;
        utt.onerror = done;
        currentUtterance = utt;   // 크롬이 읽는 도중 객체를 치워 끝 알림이 오지 않는 일을 막는다
        setPreviewButton('stop');
        speechSynthesis.speak(utt);
        return;
    }
    setPreviewButton('wait');
    try {
        beginNeuralSession(currentSpeed());
        const audio = await synthesizeNeural(text, value, currentSpeed(), neuralSynthGen(ttsGen));
        if (my !== previewGen || !audio) { done(); return; }
        setPreviewButton('stop');
        await playNeuralAudio(audio.wav, audio.sampleRate);
    } catch (err) {
        if (my === previewGen) showToast('목소리를 들려주지 못했습니다.');
    }
    done();
}

// 다른 글을 열 때 호출 — 이전 글의 강조 표시를 지운다
export function clearTTSRangeForNewEntry() {
    clearTTSHighlight();
}

export function showToast(msg, ms = 1800) {
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
    toast._timer = setTimeout(() => toast.classList.remove('show'), ms);
}


// ─── 재생 시간 계산/표시 ───

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const total = Math.round(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// 기본 음성이 한 번에 읽을 최대 글자 수 (1배속)
// 크롬의 구글 온라인 음성은 한 번에 15초쯤 넘게 읽으면 말이 끊기는 오래된 문제가 있다.
// 예전에는 빠르게 읽을수록 더 길게 묶었는데(2배속 300자), 속도를 올려도 실제로는 그만큼 빨라지지 않는
// 음성이 있어 오히려 15초를 넘겨 문장이 잘렸다. 이제 빠르게 읽어도 늘리지 않고, 느리게 읽을 때만 줄인다.
// 한 문장을 이 길이까지는 자르지 않는다. 자르면 조각마다 엔진이 새로 시작해 억양이 끊긴다.
// 기기 안의 음성은 길이 제한이 없고(안드로이드는 4000자), Read Aloud도 자르지 않는다.
const SYSTEM_MAX_CHUNK = 300;
// 크롬의 구글 온라인 음성만 15초쯤 넘게 읽으면 말이 끊긴다 — 이 음성만 짧게 (1배속 10초 안팎).
// 예전에는 온라인 음성 모두(엣지의 Microsoft … Online (Natural) 포함)를 이렇게 다뤘는데, 그 음성들은
// 끊기지 않고, 오히려 10초마다 하는 pause()+resume()에 말이 끊기거나 건너뛰었다 (easy-speech #242, Readium).
const GOOGLE_MAX_CHUNK = 100;
// 같은 문단의 짧은 문장들은 묶어 한 번에 읽힌다 — 문장마다 엔진이 새로 시작하면 사이가 뚝뚝 끊기고
// 억양이 매번 처음으로 돌아간다. 엔진은 문장 끝에서 알아서 쉰다.
const SYSTEM_PACK_MAX = 200;

function selectedSystemVoice() {
    const name = selectedVoiceValue();
    return name ? ttsVoices.find(v => v.name === name) || null : null;
}

/** 크롬의 구글 온라인 음성 (15초 끊김 대책이 필요한 음성은 이것뿐이다) */
function isGoogleNetworkVoice(v = selectedSystemVoice()) {
    return !!v && v.localService === false && /google/i.test(v.name || '');
}

function getMaxChunkLen() {
    // 자연스러운 음성: 문장은 180자까지 자르지 않고, 짧은 문장들은 120자까지 묶는다 (packLimit)
    if (timingNeural()) return NEURAL_SENTENCE_MAX;
    if (isGoogleNetworkVoice()) return Math.max(40, Math.round(GOOGLE_MAX_CHUNK * Math.min(1, currentSpeed())));
    return SYSTEM_MAX_CHUNK;
}

/** 문장들을 한 번에 읽을 묶음의 최대 길이 (0이면 묶지 않는다) */
function packLimit() {
    // '문장 사이 쉼'을 정해 두었으면 문장마다 그만큼 쉬어야 하므로 묶지 않는다
    if ((parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0) > 0) return 0;
    if (timingNeural()) return NEURAL_MAX_CHUNK;
    if (isGoogleNetworkVoice()) return getMaxChunkLen();
    return SYSTEM_PACK_MAX;
}

/**
 * 같은 문단 안에서 이어지는 문장들을 max자까지 한 묶음으로 (공식 Supertonic 예제의 chunk_text와 같은 방식).
 * 문단(빈 줄)·말줄임표(..)·문장 가운데서 나눈 조각은 넘어 묶지 않는다.
 * startIdx 문장은 새 묶음의 첫 문장이 되고, aloneFirst면 혼자 한 묶음이 된다 (첫 소리를 빨리 내려고).
 * 묶음: { text, parts: [문장들], start, end, fullStart, fullEnd, dots, nl, cont }
 */
function packChunks(sents, max, startIdx = -1, aloneFirst = false) {
    if (!(max > 0) || sents.length < 2) return { chunks: sents, index: Math.max(0, startIdx) };
    const out = [];
    let group = [], len = 0, index = 0;
    const flush = () => {
        if (!group.length) return;
        if (group.length === 1) out.push(group[0]);
        else {
            const last = group[group.length - 1];
            const g = { text: group.map(c => c.text).join(' '), parts: group, start: group[0].start, end: last.end,
                        dots: last.dots, nl: last.nl, cont: last.cont };
            if (group[0].fullStart != null) { g.fullStart = group[0].fullStart; g.fullEnd = last.fullEnd; }
            out.push(g);
        }
        group = []; len = 0;
    };
    sents.forEach((c, i) => {
        const n = spokenText(c).length;
        if (i === startIdx) { flush(); index = out.length; }
        const prev = group[group.length - 1];
        const joinable = prev && !(prev.nl >= 2) && !prev.cont && !c.cont && (prev.dots || 0) < 2 && len + 1 + n <= max;
        if (group.length && !joinable) flush();
        len += (group.length ? 1 : 0) + n;
        group.push(c);
        if (i === startIdx && aloneFirst) flush();
    });
    flush();
    return { chunks: out, index };
}

/** 읽을 묶음들과, startPos(본문 위치)가 든 문장부터 읽을 때의 시작 번호 */
function buildReadingChunks(src, startPos = null) {
    const sents = splitChunks(src.text, getMaxChunkLen(), src.map);
    let startIdx = -1;
    if (startPos != null) {
        startIdx = sents.findIndex(c => c.fullEnd != null && c.fullEnd > startPos);
        if (startIdx < 0) startIdx = sents.length - 1;
    }
    return packChunks(sents, packLimit(), startIdx, timingNeural());
}

// 재생 전·재생 중·탐색이 모두 같은 계산(buildChunkTimings)을 써야 시간이 서로 맞는다
function estimateTotalTime() {
    const text = getTextToSpeak();
    if (!text) return 0;
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    const gap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0;
    const timings = buildChunkTimings(packChunks(splitChunks(text, getMaxChunkLen()), packLimit()).chunks, speed, gap);
    const last = timings[timings.length - 1];
    return last ? last.startSec + last.speakSec : 0;
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

// 묶음 안의 문장 사이에서 엔진·모델이 스스로 쉬는 시간 (1배속, 초)
const IN_GROUP_PAUSE_SEC = 0.25;

function buildChunkTimings(chunks, speed, gapSec) {
    const timings = [];
    const neural = timingNeural();
    const cps = charsPerSec();
    let elapsed = 0;
    for (let i = 0; i < chunks.length; i++) {
        const spokenLen = spokenText(chunks[i]).length;
        const inner = chunks[i].parts ? (chunks[i].parts.length - 1) * IN_GROUP_PAUSE_SEC : 0;
        const speakSec = (spokenLen / cps + inner) / speed;
        timings.push({ index: i, startSec: elapsed, speakSec });
        elapsed += speakSec;
        // 실제 재생과 같은 쉼
        if (i < chunks.length - 1) elapsed += gapAfterSec(chunks[i], speed, neural, gapSec);
    }
    return timings;
}

/**
 * 한 묶음 뒤에 쉬는 시간(초): 음성마다 두는 쉼과, 설정한 '문장 사이 쉼'(+말줄임표) 중 긴 쪽.
 * 문장 가운데서 나눈 조각 뒤에는 설정한 쉼을 더하지 않는다 (한 문장 안에서 길게 쉬면 끊겨 들린다).
 */
function gapAfterSec(chunk, speed, neural = usingNeural(), setGap = null) {
    const own = (neural ? neuralGapAfter(chunk, speed) : systemGapAfter(chunk, speed)) / 1000;
    const slider = setGap != null ? setGap : (parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0);
    const set = chunk.cont ? 0 : slider + extraPauseForDots(chunk.dots);
    return Math.max(own, set);
}

/** 읽고 있는 묶음 목록의 시간표 (같은 목록·속도·쉼이면 다시 계산하지 않는다) */
let timingsCache = { chunks: null, speed: 0, gap: 0, list: [] };
function currentTimings() {
    const { speed, gap } = currentTimingParams();
    if (timingsCache.chunks !== ttsChunks || timingsCache.speed !== speed || timingsCache.gap !== gap) {
        timingsCache = { chunks: ttsChunks, speed, gap, list: buildChunkTimings(ttsChunks, speed, gap) };
    }
    return timingsCache.list;
}
/** index번째 묶음을 읽기 시작할 때의 진행률(%) — 묶음 수가 아니라 시간으로 (묶음마다 길이가 다르다) */
function progressFor(index) {
    if (!ttsChunks.length || index >= ttsChunks.length) return index > 0 ? 100 : 0;
    const list = currentTimings();
    const last = list[list.length - 1];
    const total = last ? last.startSec + last.speakSec : 0;
    const t = list[Math.max(0, index)];
    return total > 0 && t ? Math.min(100, Math.round(t.startSec / total * 100)) : Math.round(index / ttsChunks.length * 100);
}

function getSeekState(src, percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const chunks = buildReadingChunks(src).chunks;
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
    // 여러 문장 묶음이면 그 안에서 고른 자리가 든 문장부터 읽는다 (자연스러운 음성은 그 문장만 따로 만들어 소리가 빨리 나게).
    // 시간·진행률은 실제로 읽기 시작하는 그 문장의 시작으로 맞춘다 (예전에는 고른 자리를 그대로 두어 읽는 곳과 어긋났다)
    const g = chunks[chunkIndex];
    let startPos = g ? g.fullStart : null;
    if (g && g.parts && startPos != null) {
        const cps = charsPerSec();
        let at = timings[chunkIndex].startSec;
        for (const part of g.parts) {
            startPos = part.fullStart;
            const sec = spokenText(part).length / cps / speed;
            if (targetSec < at + sec) break;
            at += sec + IN_GROUP_PAUSE_SEC / speed;
        }
    }
    if (startPos == null || clamped <= 0) return { percent: clamped, chunks: startPos == null ? chunks : buildReadingChunks(src, startPos).chunks,
        chunkIndex: startPos == null ? chunkIndex : buildReadingChunks(src, startPos).index, targetMs: clamped <= 0 ? 0 : targetMs };
    const again = buildReadingChunks(src, startPos);
    const t = buildChunkTimings(again.chunks, speed, gap)[again.index];
    const startSec = t ? t.startSec : targetSec;
    return { percent: totalSec > 0 ? Math.min(100, Math.round(startSec / totalSec * 100)) : clamped,
             chunks: again.chunks, chunkIndex: again.index, targetMs: Math.round(startSec * 1000) };
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

/**
 * 기본 음성이 한 발화를 읽는 동안 0.5초마다 살핀다.
 *  - 크롬의 온라인 음성은 15초쯤 넘게 이어 읽으면 말이 끊긴다. 10초마다 잠깐 멈췄다 바로 이어 읽게 해 막는다.
 *    (예전에는 resume()만 불렀는데 요즘 크롬은 그것만으로 막지 못한다. 안드로이드는 pause()가 발화를
 *    끝내 버리므로 resume()만 부른다)
 *  - 다 읽고도 끝 알림을 보내지 않는 음성이 있다(윈도우 11의 구글 음성 등). 엔진이 2초 넘게 아무것도
 *    읽고 있지 않으면 끝난 것으로 보고 다음 문장으로 넘어간다. 한 번도 읽기 시작하지 못했다면 멈춘다.
 */
const KEEPALIVE_MS = 10000;
// 끝 알림을 보내지 않는 엔진에서 다음 문장으로 넘어가기까지 (예전 2초 + 살피는 간격 0.5초 → 문장 사이가 2~2.8초 비었다)
const ENGINE_IDLE_MS = 700;
// started.yes: 엔진이 이 발화를 받아 읽기 시작했는가 (시작 알림·speak 직후·살피는 중에 확인)
function startSystemWatch(gen, online, started, finish, fail) {
    stopSystemWatch();
    let lastKeep = Date.now(), idleSince = 0;
    systemWatchTimer = setInterval(() => {
        if (gen !== ttsGen) { stopSystemWatch(); return; }
        if (isTTSPaused) { idleSince = 0; lastKeep = Date.now(); return; }
        if (speechSynthesis.speaking || speechSynthesis.pending) {
            started.yes = true;
            idleSince = 0;
            if (Date.now() - lastKeep >= KEEPALIVE_MS) {
                lastKeep = Date.now();
                if (online && !IS_ANDROID) speechSynthesis.pause();
                speechSynthesis.resume();
            }
            return;
        }
        if (!idleSince) { idleSince = Date.now(); return; }
        if (Date.now() - idleSince < ENGINE_IDLE_MS) return;
        stopSystemWatch();
        if (started.yes) finish(); else fail();
    }, 250);
}

function stopSystemWatch() {
    if (systemWatchTimer) {
        clearInterval(systemWatchTimer);
        systemWatchTimer = null;
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
    // 성경 구절(3:16)·날짜(2026.10.9)·큰 수·%처럼 기호가 섞인 표기를 먼저 읽는 말로 풀어 쓴다
    // (기호를 지우고 나면 뜻을 잃는다 — speech-text.js)
    // 일부 엔진이 아포스트로피/대시를 기호명으로 읽는 문제를 피하기 위해 사전 제거
    // 예) ' -> "아포스트로피", - -> "대시/다시"
    // 따옴표는 지운다 — 빈칸으로 바꾸면 '“감사합니다”라고'가 '감사합니다 라고'로 읽혀 조사 앞에서 끊겼다.
    // 앞뒤를 띄운 줄표(오늘 — 감사)는 쉼표처럼 쉬게 한다.
    const normalized = normalizeForSpeech(text)
        .replace(/[“”„‟«»]/g, '"')
        // 영어 줄임말은 풀어 쓴다 (따옴표를 지우면 He'll→Hell, we're→were처럼 다른 말이 된다)
        .replace(/\b(can)['’]t\b/gi, '$1not').replace(/\b(won)['’]t\b/gi, 'will not').replace(/([A-Za-z])n['’]t\b/g, '$1 not')
        .replace(/([A-Za-z])['’](ll|re|ve|m)\b/gi, (m, a, x) => a + ' ' + ({ ll: 'will', re: 'are', ve: 'have', m: 'am' })[x.toLowerCase()])
        .replace(/[‘’‛′`´']/g, '')
        .replace(/\s[—–―]+\s|\s-{1,2}\s/g, ', ')
        .replace(/[\-‐‑‒–—―]+/g, ' ');
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

/**
 * 조각 하나를 실제로 읽힐 글로. 끝에 문장 부호가 없으면 붙인다 — 일기는 마침표 없이 줄을 바꾸는 일이 많은데,
 * 부호가 없으면 엔진이 말이 끝난 줄 모르고 끝을 덜 내린 채 뚝 끊는다. 문장이 끝났으면 마침표,
 * 문장 가운데서 나눈 조각이면 쉼표를 붙여 다음 조각으로 이어지는 말투로 읽게 한다.
 */
function spokenText(chunk) {
    // 여러 문장 묶음: 문장마다 읽힐 글을 이어 붙인다 (각 문장이 글 안에서 어디서 시작하는지도 기억)
    if (chunk.parts) {
        if (chunk._spoken == null) {
            const pieces = chunk.parts.map(p => spokenText(p));
            chunk._offsets = [];
            let at = 0;
            pieces.forEach((t, k) => { chunk._offsets.push(at); at += t.length + (t && k < pieces.length - 1 ? 1 : 0); });
            chunk._spoken = pieces.filter(Boolean).join(' ');
        }
        return chunk._spoken;
    }
    const s = cleanForSpeech(chunk.text);
    // 닫는 따옴표 앞에 문장 부호가 있어야 끝난 것으로 본다 ('“두려워 말라”' 뒤에도 마침표를 붙인다)
    if (!s || /[.!?,;:…~。、，．！？：；‥]["'」』]*$/.test(s)) return s;
    return s + (chunk.cont ? ',' : '.');
}

/**
 * full[s, e)에서 괄호 안 내용을 빼고 앞뒤 공백을 걷어낸 '읽을 글'을 만들되,
 * 남은 각 글자가 full의 몇 번째 글자였는지(map)도 함께 돌려준다.
 * 결과 글은 stripParentheses(full.substring(s, e)).trim()과 같다.
 */
function buildSpeechText(full, s, e) {
    if (e < s) [s, e] = [e, s];
    s = Math.max(0, s); e = Math.min(full.length, e);
    let chars = full.substring(s, e).split('');
    let map = chars.map((_, i) => s + i);
    // 예전 stripParentheses와 똑같이: 안쪽 괄호 쌍을 정규식으로 한 번에 지우고(ASCII → 전각),
    // 변화가 없을 때까지 반복한다. 지운 글자는 위치표에서도 함께 뺀다.
    const removeMatches = (re) => {
        const str = chars.join('');
        const drop = new Uint8Array(chars.length);
        let hit = false;
        for (const m of str.matchAll(re)) {
            hit = true;
            for (let k = m.index; k < m.index + m[0].length; k++) drop[k] = 1;
        }
        if (!hit) return;
        chars = chars.filter((_, k) => !drop[k]);
        map = map.filter((_, k) => !drop[k]);
    };
    for (let prev = -1; prev !== chars.length;) {
        prev = chars.length;
        removeMatches(/\([^()]*\)/g);
        removeMatches(/（[^（）]*）/g);
    }
    let a = 0, b = chars.length;
    while (a < b && /\s/.test(chars[a])) a++;
    while (b > a && /\s/.test(chars[b - 1])) b--;
    return { text: chars.slice(a, b).join(''), map: map.slice(a, b) };
}

/** 본문 전체에서 읽을 글과 위치표 */
function getSpeechSource() {
    const full = getFullText();
    return buildSpeechText(full, 0, full.length);
}

function getTextToSpeak() {
    return getSpeechSource().text;
}

// 기본 음성 엔진의 발화를 멈춘다 (엔진이 없는 브라우저에서도 안전하게)
function cancelSystemSpeech() {
    stopSystemWatch();
    currentUtterance = null;
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
        speechSynthesis.resume(); // paused 고착 방지 (발화 없을 땐 무해)
    }
}

let playWaiting = false;
export async function playTTS() {
    stopVoicePreview();
    // 음성 목록·받아 둔 자연스러운 음성 확인이 덜 끝났으면 기다린다 (첫 문장만 다른 목소리로 읽히지 않게).
    // 아이폰은 누른 순간에 소리 장치를 깨워야 하므로, 저장해 둔 음성이 자연스러운 음성이면 먼저 깨운다.
    if (!isTTSPaused && !isTTSSpeaking && ttsVoicesListener && ttsVoicesListener.stale) {
        ttsVoicesListener.stale = false;
        loadVoices();   // 읽는 동안 늦게 온 음성들을 이제 목록에 넣는다
    }
    if (!isTTSPaused && !voicesSettled()) {
        if (playWaiting) return;            // 기다리는 동안 다시 누른 것은 한 번으로
        let saved = '';
        try { saved = localStorage.getItem('faith_tts_voice') || ''; } catch (e) {}
        if (isNeuralVoice(saved)) unlockNeuralAudio();
        const g = ttsGen;
        playWaiting = true;
        try { await waitForVoices(); } finally { playWaiting = false; }
        if (g !== ttsGen) return;           // 기다리는 사이 정지·창 닫기·문장 두 번 누르기가 있었다
    }
    const neural = usingNeural();
    if (!neural && !('speechSynthesis' in window)) {
        alert('이 브라우저는 TTS를 지원하지 않습니다.');
        return;
    }
    // 아이폰은 재생 버튼을 누른 순간에 소리 장치를 깨워 두어야 이후 생성된 음성이 재생된다
    if (neural) unlockNeuralAudio();

    // 일시정지 → 재개
    if (isTTSPaused) {
        // 일시정지한 사이에 엔진이 발화를 놓아 버렸다 → 이어 읽을 것이 없으니 읽던 문장부터 다시 읽는다
        // (여러 문장 묶음이면 묶음 처음이 아니라 강조된 문장부터)
        if (!neural && !ttsGapInterrupted && !speechSynthesis.speaking && !speechSynthesis.pending) restartFromCurrentChunk();
        isTTSPaused = false;
        isTTSSpeaking = true;
        ttsPlayStartMs = Date.now();
        startTimeTicker();
        syncUI();
        if (ttsGapInterrupted) {
            // 청크 간 쉼 도중 일시정지된 경우 → 살아있는 발화가 없으므로 speakNext로 재진입
            ttsGapInterrupted = false;
            // 엔진이 paused로 남아 있으면 새 발화가 무음 대기하므로 먼저 해제 (발화 없을 땐 무해)
            if (!neural && 'speechSynthesis' in window) speechSynthesis.resume();
            speakSoon();
        } else if (neural) {
            resumeNeuralAudio();
        } else {
            speechSynthesis.resume();
        }
        return;
    }

    const src = getSpeechSource();
    if (!src.text) { alert('읽을 내용이 없습니다.'); return; }

    // 새 재생 시: 사용자가 옮긴 진행바 위치(정지 상태에서도)를 시작점으로 반영
    const sliderPercent = Number(document.getElementById('tts-progress-slider')?.value || '0');
    const seekPercent = (sliderPercent > 0 && sliderPercent < 100) ? sliderPercent : 0;
    const seekState = getSeekState(src, seekPercent);

    ttsGen++; // 이전 발화의 stale 이벤트 무효화
    ttsGapInterrupted = false;
    cancelSystemSpeech(); // 일시정지 상태에서 새 재생 시 paused 고착으로 무음이 되는 것 방지
    stopNeuralAudio();
    cancelNeuralBefore(ttsGen);
    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;

    ttsChunks = seekState.chunks;
    ttsChunkIndex = seekState.chunkIndex;
    ttsTimingParams = currentTimingParams();
    ttsTotalSec = estimateTotalTime();
    ttsElapsedBeforePause = seekState.targetMs;
    ttsPlayStartMs = Date.now();
    setProgress(seekState.percent);
    updateTimeDisplay();
    startTimeTicker();
    // cancel() 직후 곧바로 speak()를 호출하면 일부 브라우저(Chrome)에서 새 발화가
    // 무시되거나 엔진이 꼬이는 경우가 있어, 한 틱 미뤄서 cancel()이 먼저 처리되게 한다.
    speakSoon();
}

export function seekTTSByPercent(percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const src = getSpeechSource();
    const text = src.text;
    const seekState = getSeekState(src, clamped);

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
    ttsTimingParams = currentTimingParams();

    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;
    ttsGen++; // 이전 발화의 stale 이벤트 무효화
    cancelSystemSpeech();
    stopNeuralAudio();
    cancelNeuralBefore(ttsGen);

    if (wasPlaying) {
        ttsGapInterrupted = false;
        isTTSPaused = false;
        isTTSSpeaking = true;
        ttsPlayStartMs = Date.now();
        startTimeTicker();
        // cancel() 직후 곧바로 speak()를 호출하면 일부 브라우저(Chrome)에서 새 발화가
        // 무시되거나 엔진이 꼬이는 경우가 있어, 한 틱 미뤄서 cancel()이 먼저 처리되게 한다.
        speakSoon();
    } else if (wasPaused) {
        // cancel()로 발화가 사라졌으므로 재개 시 speakNext로 진입해야 함
        ttsGapInterrupted = true;
        isTTSPaused = true;
        isTTSSpeaking = true;
        syncUI();
    }
}

/**
 * 읽을 글을 문장 단위 조각으로 나눈다. map(위치표)을 주면 각 조각에 본문에서의
 * 위치(fullStart, fullEnd)를 붙인다 — 지금 읽는 문장 강조·탭한 문장부터 읽기에 쓴다.
 */
function splitChunks(text, max, map) {
    const chunks = [];
    const isWs = (ch) => /\s/.test(ch);
    // [a, b) 구간을 앞뒤 공백을 걷어 한 조각으로. cont: 문장 가운데서 나눈 조각(뒤에 같은 문장이 이어진다)
    const add = (a, b, dots, cont) => {
        while (a < b && isWs(text[a])) a++;
        while (b > a && isWs(text[b - 1])) b--;
        if (a >= b) return;
        const c = { text: text.slice(a, b), dots, start: a, end: b };
        if (cont) c.cont = true;
        if (map) { c.fullStart = map[a]; c.fullEnd = map[b - 1] + 1; }
        chunks.push(c);
    };
    // 구두점으로도 나눌 수 없는 긴 조각은 max 길이로 강제 분할해 Chrome ~15초 컷오프 방지.
    // 낱말 한가운데서 자르면 그 낱말이 두 번에 나뉘어 어색하게 읽히므로 띄어쓰기에서 자르고,
    // 끝에 두어 글자만 따로 남지 않도록 조각 길이를 고르게 나눈다.
    const pushHardSliced = (a, b, dots, last) => {
        while (a < b && isWs(text[a])) a++;
        while (b > a && isWs(text[b - 1])) b--;
        while (b - a > max) {
            const target = a + Math.ceil((b - a) / Math.ceil((b - a) / max));
            let cut = a + max;
            for (let d = 0; d <= max / 2; d++) {
                if (target - d > a && isWs(text[target - d])) { cut = target - d; break; }
                if (target + d < a + max && isWs(text[target + d])) { cut = target + d; break; }
            }
            add(a, cut, 0, true);
            a = cut;
            while (a < b && isWs(text[a])) a++;
        }
        add(a, b, dots, !last);
    };
    // 숫자 사이의 부호(1.5 · 1,200 · 3:16)와 날짜 안의 점에서는 끊지 않는다
    const keep = noBreakMask(text);
    const isEnd = (k) => '.!?。'.includes(text[k]) && !keep[k];
    // 문장 단위로 분리: "내용 + 종결부호(.!?。 연속 허용) 또는 줄바꿈"
    // 연속 마침표(예: "...")는 하나의 청크 끝에 그대로 유지되어 쉼 길이 계산에 사용된다.
    const sentences = [];
    for (let s = 0, k = 0; k <= text.length; k++) {
        if (k === text.length) { if (s < k) sentences.push([s, k]); break; }
        if (isEnd(k)) {
            while (k + 1 < text.length && isEnd(k + 1)) k++;
            sentences.push([s, k + 1]); s = k + 1;
        } else if (text[k] === '\n') {
            while (k + 1 < text.length && text[k + 1] === '\n') k++;
            sentences.push([s, k + 1]); s = k + 1;
        }
    }
    for (let [a, b] of sentences) {
        while (a < b && isWs(text[a])) a++;
        while (b > a && isWs(text[b - 1])) b--;
        if (a >= b) continue;
        // 말미 마침표 개수 추출 (쉼 길이 계산용)
        const dotMatch = text.slice(a, b).match(/\.+$/);
        const dots = dotMatch ? dotMatch[0].length : 0;

        if (b - a > max) {
            // 문장이 max를 넘으면 쉼표/중간 구두점에서 한번 더 나눔
            const parts = [];
            let ps = a;
            for (let k = a; k < b; k++) {
                if (',;:·'.includes(text[k]) && !keep[k]) { parts.push([ps, k + 1]); ps = k + 1; }
            }
            if (ps < b) parts.push([ps, b]);
            let cs = -1, ce = -1;
            for (const [pa, pb] of parts) {
                if (cs >= 0 && pb - cs > max) {
                    pushHardSliced(cs, ce, 0, false);
                    cs = pa; ce = pb;
                } else {
                    if (cs < 0) cs = pa;
                    ce = pb;
                }
            }
            if (cs >= 0) pushHardSliced(cs, ce, dots, true);
        } else {
            add(a, b, dots, false);
        }
    }
    // 다음 조각과의 사이에 줄바꿈이 몇 번 있는가 (1 = 줄이 바뀜, 2 이상 = 빈 줄로 문단이 바뀜) — 쉼 길이에 쓴다
    for (let i = 0; i < chunks.length - 1; i++) {
        const between = text.slice(chunks[i].end, chunks[i + 1].start);
        const nl = (between.match(/\n/g) || []).length;
        if (nl) chunks[i].nl = nl;
    }
    if (chunks.length) return chunks;
    const only = { text, dots: 0 };
    if (map && text) { only.fullStart = map[0]; only.fullEnd = map[text.length - 1] + 1; }
    return [only];
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
        stopSystemWatch();
        ttsElapsedBeforePause = (ttsTotalSec || 0) * 1000;
        ttsPlayStartMs = 0;
        updateTimeDisplay();
        syncUI();
        clearTTSHighlight();
        stopNeuralTicker();
        return;
    }

    // 현재 청크에서 문장부호·이모지 등을 제거하고 글자만 남김
    const currentChunk = ttsChunks[ttsChunkIndex];
    const spoken = spokenText(currentChunk);
    if (!spoken) {
        // 읽을 내용이 없으면 다음 청크로 스킵
        ttsChunkIndex++;
        setProgress(progressFor(ttsChunkIndex));
        speakNext();
        return;
    }

    if (usingNeural()) { startNeuralLoop(ttsChunkIndex, ttsGen); return; }

    const utt = new SpeechSynthesisUtterance(spoken);

    // 음성: 선택된 음성 하나로 고정 (lang까지 맞춰 다른 음성이 섞이지 않도록).
    // 음성을 아직 못 찾았어도 lang은 꼭 정한다 — 비워 두면 엔진이 영어 등 아무 음성으로 읽었다.
    // (여기서 고른 음성을 저장하지 않는다 — 목록이 덜 채워진 때 대신 고른 음성이 사용자가 고른 음성을 덮어썼다)
    const voice = selectedSystemVoice();
    if (voice) utt.voice = voice;
    utt.lang = voice ? voice.lang : 'ko-KR';

    // 속도 (음높이는 음성 그대로 둔다)
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1');
    utt.rate = speed;
    localStorage.setItem('faith_tts_speed', String(speed));
    const spokeAt = Date.now();
    let gotStart = false;

    const myGen = ttsGen; // 발화 세대 캡처 — 교체된 발화의 stale 이벤트 무시
    let done = false;     // 끝 알림과 지켜보기(startSystemWatch) 중 먼저 온 쪽만 다음 문장으로 넘긴다
    const finish = () => {
        if (done || myGen !== ttsGen) return;
        done = true;
        stopSystemWatch();
        stopPartTimer();
        if (currentUtterance === utt) currentUtterance = null;
        // 사파리: 멈춘 직후 건넨 발화를 시작도 않고 곧바로 끝내 버리는 일이 있다 → 한 번만 다시 읽힌다
        if (IS_WEBKIT_SPEECH && !gotStart && Date.now() - spokeAt < 150 && !currentChunk._retried) {
            currentChunk._retried = true;
            speakSoon();
            return;
        }
        // 일시정지한 사이에 엔진이 발화를 끝냈다(일시정지를 '그만 읽기'로 다루는 엔진) → 재개하면 이 문장부터 다시 읽는다
        if (isTTSPaused) { restartFromCurrentChunk(); return; }
        advanceAfterChunk(currentChunk);
    };
    const fail = (why) => {
        if (done || myGen !== ttsGen) return;
        done = true;
        console.error('TTS error:', why);
        stopSystemWatch();
        stopPartTimer();
        isTTSSpeaking = false;
        isTTSPaused = false;
        stopTimeTicker();
        syncUI();
    };
    const started = { yes: false };
    // 여러 문장 묶음: 엔진이 알려 주는 낱말 위치(boundary)로 지금 읽는 문장을 강조한다.
    // 알려 주지 않는 엔진에서는 지난 시간으로 짐작한다.
    let shownPart = 0, sawBoundary = false;
    const myIndex = ttsChunkIndex;
    const showPart = (p) => {
        if (!currentChunk.parts || p === shownPart || myGen !== ttsGen) return;
        shownPart = p;
        readingAt = { gen: myGen, index: myIndex, part: p };
        highlightChunk(currentChunk.parts[p]);
    };
    if (currentChunk.parts) {
        const offs = currentChunk._offsets || [];
        utt.onboundary = (e) => {
            if (typeof e.charIndex !== 'number') return;
            sawBoundary = true;
            let p = 0;
            for (let q = 1; q < offs.length; q++) if (e.charIndex >= offs[q]) p = q;
            showPart(p);
        };
    }
    utt.onstart = () => {
        started.yes = true;
        gotStart = true;
        if (myGen !== ttsGen) return;
        isTTSSpeaking = true; isTTSPaused = false; syncUI();
        readingAt = { gen: myGen, index: myIndex, part: 0 };
        highlightChunk(currentChunk.parts ? currentChunk.parts[0] : currentChunk);
        if (currentChunk.parts) {
            const offs = currentChunk._offsets || [];
            const t0 = Date.now();
            let pausedMs = 0, pausedAt = 0;
            startPartTimer(() => {
                if (sawBoundary || myGen !== ttsGen) return;
                if (isTTSPaused) { if (!pausedAt) pausedAt = Date.now(); return; }
                if (pausedAt) { pausedMs += Date.now() - pausedAt; pausedAt = 0; }
                const chars = (Date.now() - t0 - pausedMs) / 1000 * CHARS_PER_SEC * speed;
                let p = 0;
                for (let q = 1; q < offs.length; q++) if (chars >= offs[q]) p = q;
                showPart(p);
            });
        }
    };
    utt.onend = () => finish();
    utt.onerror = (e) => {
        if (myGen !== ttsGen) return;
        // cancel()로 인해 발생하는 canceled/interrupted 에러는 탐색/정지/재시작 과정의 정상 동작
        if (e.error === 'canceled' || e.error === 'interrupted') return;
        fail(e.error);
    };

    setProgress(progressFor(ttsChunkIndex));
    currentUtterance = utt;
    speechSynthesis.speak(utt);
    // 브라우저는 speak 직후부터 '읽는 중(또는 기다리는 중)'으로 표시한다. 짧은 문장은 살피기 전에 끝날 수 있어 바로 확인해 둔다
    if (speechSynthesis.speaking || speechSynthesis.pending) started.yes = true;
    startSystemWatch(myGen, isGoogleNetworkVoice(voice), started, finish, () => fail('no-speech'));
}

// 묶음 안에서 문장 강조를 옮기는 타이머 (기본 음성이 낱말 위치를 알려 주지 않을 때)
let partTimer = null;
function startPartTimer(fn) { stopPartTimer(); partTimer = setInterval(fn, 250); }
function stopPartTimer() { if (partTimer) { clearInterval(partTimer); partTimer = null; } }

// 기본 음성은 문장 끝에서 엔진이 알맞게 쉰다. 빈 줄로 문단이 바뀌는 곳만 조금 더 쉰다 (빠르게 들을수록 짧게)
const SYSTEM_PARAGRAPH_GAP_MS = 350;
function systemGapAfter(chunk, speed) {
    return chunk && chunk.nl >= 2 ? SYSTEM_PARAGRAPH_GAP_MS / Math.max(0.5, speed || 1) : 0;
}

/** 한 문장을 다 읽은 뒤: 진행률을 올리고, 설정한 쉼만큼 기다렸다가 다음 문장으로 */
function advanceAfterChunk(currentChunk) {
    ttsChunkIndex++;
    setProgress(progressFor(ttsChunkIndex));
    const totalGap = gapAfterSec(currentChunk, currentSpeed(), false) * 1000;
    if (totalGap > 0 && ttsChunkIndex < ttsChunks.length) {
        ttsGapTimer = setTimeout(() => { ttsGapTimer = null; speakNext(); }, totalGap);
    } else {
        speakNext();
    }
}

// ─── 자연스러운 음성 재생 ───
// 문장 하나를 만드는 데 몇 초 걸리므로, 읽는 동안 앞으로 읽을 문장들을 미리 만들어 둔다.
// 미리 만들 분량: 문장 수가 아니라 '앞으로 읽을 시간'으로 정한다.
// (문장 수로 정하면 짧은 문장들 뒤에 오는 아주 긴 문장을 너무 늦게 만들기 시작해 그 앞에서 끊겼다)
const NEURAL_AHEAD_SEC = 40;
const NEURAL_AHEAD_MAX = 10;
let neuralCache = null;             // { gen, voice, map: Map<index, Promise> }
let neuralErrorShown = false;
// 가장 낮은 품질로도 따라가지 못해 계속 끊기면, 이유를 알려 주고 할 수 있는 일을 안내한다 (재생마다 한 번)
let slowWarnedGen = -1;
let stallsInGen = 0, stallGen = -1;
function warnIfTooSlow() {
    if (stallGen !== ttsGen) { stallGen = ttsGen; stallsInGen = 0; }
    stallsInGen++;
    if (stallsInGen < 2 || slowWarnedGen === ttsGen) return;
    if (getNeuralInfo().steps > getNeuralMinSteps()) return;
    slowWarnedGen = ttsGen;
    showToast('이 기기에서는 음성을 만드는 속도가 읽는 속도를 못 따라가 끊길 수 있습니다. 읽기 속도를 낮추면 덜 끊깁니다.', 5000);
}

// 묶음 사이의 쉼 (1배속 기준, 빠르게 들을수록 짧게).
// 작업자가 앞뒤 무음을 걷고도 들숨·여운이 0.4초쯤 남는다(측정: 앞 0.13초 + 뒤 0.27초). 예전에는 여기에
// 0.35초를 더해 문장 사이가 0.75초나 됐는데, 묶음 안에서 모델이 문장 사이에 두는 쉼은 0.25초 안팎이라
// 쉼이 들쭉날쭉하게 들렸다. 묶음 사이는 0.55초 안팎(+0.15초)이 되게 한다.
const NEURAL_SENTENCE_GAP_MS = 150;
// 아주 긴 문장(180자 넘게)을 쉼표 등에서 나눈 자리 — 남은 숨 0.4초면 쉼표 쉼으로 충분하다
const NEURAL_CLAUSE_GAP_MS = 0;
// 빈 줄로 문단이 바뀌는 자리 (모두 0.9초 안팎)
const NEURAL_PARAGRAPH_GAP_MS = 500;

function neuralGapAfter(chunk, speed) {
    const ms = chunk.nl >= 2 ? NEURAL_PARAGRAPH_GAP_MS
        : (chunk.cont ? NEURAL_CLAUSE_GAP_MS : NEURAL_SENTENCE_GAP_MS);
    return ms / Math.max(0.5, speed || 1);
}

// 읽는 중에 속도를 바꾸면, 옛 속도로 미리 만들려고 줄 세워 둔 문장들만 버린다 (지금 읽는 문장은 그대로).
// 작업자는 '이 번호보다 작은 요청'을 건너뛰므로 같은 재생 안에서 번호를 조금씩 올려 구분한다.
let neuralSpeedRev = 0, neuralSpeedRevGen = -1;
function neuralSynthGen(gen) {
    if (neuralSpeedRevGen !== gen) { neuralSpeedRevGen = gen; neuralSpeedRev = 0; }
    return gen + Math.min(neuralSpeedRev, 999) / 1000;
}

function requestNeural(index, gen) {
    const voice = selectedVoiceValue();
    const speed = currentSpeed();
    if (!neuralCache || neuralCache.gen !== gen || neuralCache.voice !== voice || neuralCache.speed !== speed) {
        neuralCache = { gen, voice, speed, map: new Map() };
    }
    const map = neuralCache.map;
    if (map.has(index)) return map.get(index);
    const chunk = ttsChunks[index];
    const text = chunk ? spokenText(chunk) : '';
    // 이 문장 뒤의 쉼도 알려 준다 — 다음 문장을 만들 수 있는 시간이 그만큼 늘어난다 (품질 단계 조절)
    const promise = text ? synthesizeNeural(text, voice, speed, neuralSynthGen(gen), neuralGapAfter(chunk, speed) / 1000) : Promise.resolve(null);
    promise.catch(() => {});   // 미리 만들다 실패해도 그 문장 차례에 다시 처리한다
    map.set(index, promise);
    return promise;
}

/** 지금 문장 뒤로 몇 문장을 미리 만들어 두고, 지나간 문장은 버린다 */
function fillNeuralAhead(index, gen) {
    if (!neuralCache || neuralCache.gen !== gen) return;
    for (const k of [...neuralCache.map.keys()]) if (k < index) neuralCache.map.delete(k);
    const speed = currentSpeed();
    let aheadSec = 0;
    for (let k = index + 1; k < ttsChunks.length && k <= index + NEURAL_AHEAD_MAX && aheadSec < NEURAL_AHEAD_SEC; k++) {
        requestNeural(k, gen);
        aheadSec += spokenText(ttsChunks[k]).length / NEURAL_CHARS_PER_SEC / speed;
    }
}

// ─── 오디오 시계에 줄 세워 읽기 ───
// 묶음 하나를 다 만들면 '앞 묶음 끝 + 쉼' 시각에 미리 걸어 둔다 (neural-tts.js scheduleNeuralAudio).
// 쉼이 화면 일·타이머에 흔들리지 않는다. 미리 거는 것은 지금 소리 나는 묶음의 다음 하나까지만 —
// 정지·탐색·빠르기 바꾸기 때 거둘 것이 적도록.
// 강조·진행률·시간은 오디오 시계를 보는 타이머(tickNeural)가 옮긴다.
let neuralLoopId = 0;
let neuralTimeline = [];   // [{ index, startAt, endAt, partStarts }] — 걸어 둔 묶음들 (오디오 시계, 초)
let neuralTicker = null;
let neuralShown = { index: -1, part: -1 };
// 지금 읽고 있는 묶음과 그 안의 문장 (두 음성 모두) — 읽는 중에 설정을 바꿔 다시 읽을 때 그 문장부터
let readingAt = { gen: -1, index: -1, part: 0 };

function startNeuralLoop(fromIndex, gen, keepTimeline = false) {
    const loop = ++neuralLoopId;
    if (!keepTimeline) {
        neuralTimeline = [];
        neuralShown = { index: -1, part: -1 };
        beginNeuralSession(currentSpeed());   // 이번 읽기의 품질 단계를 정한다 (읽는 동안 그대로)
    }
    startNeuralTicker(gen);
    runNeuralLoop(fromIndex, gen, loop);
}

/** 오디오 시계가 t에 이를 때까지 (일시정지 중에는 시계가 멈추므로 그만큼 기다린다) */
function waitForClock(t, alive) {
    return new Promise((resolve) => {
        const check = () => {
            if (!alive() || neuralClock() >= t) { resolve(); return; }
            setTimeout(check, Math.min(250, Math.max(20, (t - neuralClock()) * 1000)));
        };
        check();
    });
}

async function runNeuralLoop(fromIndex, gen, loop) {
    const alive = () => gen === ttsGen && loop === neuralLoopId;
    if (!isNeuralLoaded()) showToast('자연스러운 음성을 준비하고 있습니다…');
    for (let k = fromIndex; k < ttsChunks.length; k++) {
        const chunk = ttsChunks[k];
        if (!spokenText(chunk)) continue;
        const prev = neuralTimeline[neuralTimeline.length - 1];
        // 앞 묶음이 소리 나기 시작한 뒤에 다음 묶음을 건다
        if (prev) { await waitForClock(prev.startAt, alive); if (!alive()) return; }
        let audio;
        try {
            const pending = requestNeural(k, gen);
            fillNeuralAhead(k, gen);
            audio = await pending;
        } catch (err) {
            if (!alive()) return;
            neuralFailed(err);
            return;
        }
        if (!alive()) return;
        if (!audio) continue;
        // 재생을 막 시작했는데 첫 묶음이 아주 짧으면(예: "감사합니다."), 그걸 읽는 동안 다음 묶음을
        // 다 못 만들어 바로 끊긴다. 이때만 다음 묶음까지 준비한 뒤 시작한다.
        if (!prev && audio.wav.length / audio.sampleRate < 3 && k + 1 < ttsChunks.length) {
            try { await requestNeural(k + 1, gen); } catch (e) { /* 다음 묶음 실패는 그 차례에 처리 */ }
            if (!alive()) return;
        }
        const gap = prev ? gapAfterSec(ttsChunks[prev.index], currentSpeed(), true) : 0;
        const e = scheduleNeuralAudio(audio.wav, audio.sampleRate, gap);
        if (e.late) {
            // 제때 만들지 못해 쉼보다 늦게 나온다 (끊김)
            reportNeuralStall();
            addNeuralDiag({ type: 'wait', ms: Math.round((e.startAt - (prev ? prev.endAt + gap : e.startAt)) * 1000), index: k });
            warnIfTooSlow();
        }
        neuralTimeline.push({ index: k, startAt: e.startAt, endAt: e.endAt, partStarts: partStartsFor(chunk, audio, e.startAt) });
        if (!isTTSSpeaking) { isTTSSpeaking = true; syncUI(); }
    }
    const last = neuralTimeline[neuralTimeline.length - 1];
    if (last) await waitForClock(last.endAt, alive);
    if (!alive()) return;
    ttsChunkIndex = ttsChunks.length;   // 다 읽었다 → speakNext가 마무리한다
    speakNext();
}

/**
 * 여러 문장 묶음에서 문장마다 소리가 시작하는 시각 — 강조를 옮길 때 쓴다.
 * 글자 수 비율로 짐작한 자리에서 가장 가까운 '소리 안의 쉼'(작업자가 찾음)에 맞춘다.
 */
function partStartsFor(chunk, audio, startAt) {
    if (!chunk.parts) return null;
    const dur = audio.wav.length / audio.sampleRate;
    const lens = chunk.parts.map(p => Math.max(1, spokenText(p).length));
    const total = lens.reduce((a, b) => a + b, 0);
    const mids = (audio.pauses || []).map(([a, b]) => (a + b) / 2);
    const guesses = [];
    let acc = 0;
    for (let p = 1; p < lens.length; p++) { acc += lens[p - 1]; guesses.push(dur * acc / total); }
    const starts = [0];
    let used = -1;
    guesses.forEach((guess, i) => {
        const next = guesses[i + 1];
        let best = -1, bestD = Infinity;
        for (let q = used + 1; q < mids.length; q++) {
            const d = Math.abs(mids[q] - guess);
            // 다음 문장 경계에 더 가까운 쉼은 그쪽 몫이다 (짧은 문장 '아멘.'이 강조되지 않고 지나가던 문제)
            if (next != null && Math.abs(mids[q] - next) < d) continue;
            if (d < bestD) { bestD = d; best = q; }
        }
        let t = guess;
        if (best >= 0 && bestD < Math.min(dur * 0.25, 0.8)) { t = mids[best]; used = best; }
        starts.push(Math.max(starts[starts.length - 1], t));
    });
    return starts.map(t => startAt + t);
}

function startNeuralTicker(gen) {
    stopNeuralTicker();
    neuralTicker = setInterval(() => tickNeural(gen), 100);
}
function stopNeuralTicker() {
    if (neuralTicker) { clearInterval(neuralTicker); neuralTicker = null; }
}

/** 오디오 시계를 보고 지금 소리 나는 묶음·문장으로 강조·진행률·시간을 옮긴다 */
function tickNeural(gen) {
    if (gen !== ttsGen) { stopNeuralTicker(); return; }
    const now = neuralClock();
    let cur = null;
    for (const t of neuralTimeline) { if (t.startAt <= now + 0.02) cur = t; else break; }
    if (!cur) return;
    let part = 0;
    if (cur.partStarts) for (let p = 1; p < cur.partStarts.length; p++) if (now >= cur.partStarts[p]) part = p;
    if (cur.index === neuralShown.index && part === neuralShown.part) return;
    const chunk = ttsChunks[cur.index];
    if (!chunk) return;
    const newChunk = cur.index !== neuralShown.index;
    neuralShown = { index: cur.index, part };
    readingAt = { gen, index: cur.index, part };
    highlightChunk(chunk.parts ? chunk.parts[part] : chunk);
    if (!newChunk) return;
    ttsChunkIndex = cur.index;
    setProgress(progressFor(cur.index));
    // 시간 표시를 이 묶음의 시작에 맞춘다 (만드느라 기다린 시간은 세지 않게)
    const { speed, gap } = currentTimingParams();
    const t = buildChunkTimings(ttsChunks, speed, gap)[cur.index];
    if (t && !isTTSPaused) {
        ttsElapsedBeforePause = Math.round(t.startSec * 1000);
        ttsPlayStartMs = Date.now() - Math.max(0, (now - cur.startAt) * 1000);
        updateTimeDisplay();
    }
}

function neuralFailed(err) {
    console.error('자연스러운 음성 생성 실패:', err);
    neuralCache = null;
    stopNeuralTicker();
    stopNeuralAudio();
    neuralTimeline = [];
    isTTSSpeaking = false;
    isTTSPaused = false;
    stopTimeTicker();
    syncUI();
    if (!neuralErrorShown) {
        neuralErrorShown = true;
        setTimeout(() => { neuralErrorShown = false; }, 3000);
        const missing = /내려받은 음성 파일이 없습니다/.test(err.message || '');
        alert(missing
            ? '내려받은 자연스러운 음성이 기기에서 지워졌습니다.\n음성 설정에서 다시 내려받거나 다른 음성을 골라 주세요.'
            : '자연스러운 음성을 만들지 못했습니다.\n기기 메모리가 부족할 수 있습니다. 다른 앱을 닫거나 기본 음성을 골라 주세요.');
        if (missing) refreshNeuralRow();
    }
}

export function pauseTTS() {
    if (isTTSSpeaking && !isTTSPaused) {
        // 청크 간 쉼(gap) 도중이면 대기 타이머를 해제하고 재개 시 speakNext로 진입하도록 표시
        if (ttsGapTimer) {
            clearTimeout(ttsGapTimer);
            ttsGapTimer = null;
            ttsGapInterrupted = true;
            // 살아있는 발화가 없는데 pause()를 호출하면 엔진이 paused로 고착되어
            // 다음 발화가 무음 대기하므로, 이 경우에는 pause()를 건너뛴다
        } else if (usingNeural()) {
            pauseNeuralAudio();   // 오디오 시계를 멈춘다 — 걸어 둔 소리·쉼이 그대로 멈췄다가 이어진다
        } else if (IS_ANDROID) {
            // 안드로이드는 pause()가 발화를 끝내 버려 이어 읽을 수 없다 (끝 알림이 와서 다음 문장으로 넘어가기도 했다)
            // → 지금 문장을 멈추고, 다시 누르면 그 문장을 처음부터 읽는다 (여러 문장 묶음이면 강조된 문장부터)
            isTTSPaused = true;
            restartFromCurrentChunk();
        } else {
            speechSynthesis.pause();
        }
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
    stopVoicePreview();
    ttsGen++; // 이전 발화의 stale 이벤트 무효화
    ttsGapInterrupted = false;
    // 음성 읽기를 지원하지 않는 브라우저(일부 앱 내 WebView)에서는 여기서 예외가 나
    // 편집기 닫기·저장까지 멈췄다. 엔진이 있을 때만 호출한다.
    // 일시정지 중 정지하면 Chrome이 paused 상태를 유지해 다음 재생이 무음이 되므로 해제
    cancelSystemSpeech();
    stopNeuralAudio();
    stopNeuralTicker();
    neuralTimeline = [];
    cancelNeuralBefore(ttsGen);
    neuralCache = null;
    clearTTSHighlight();
    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;
    isTTSSpeaking = false;
    isTTSPaused = false;
    ttsChunks = [];
    ttsChunkIndex = 0;
    setProgress(0);
    stopTimeTicker();
    stopSystemWatch();
    ttsElapsedBeforePause = 0;
    ttsPlayStartMs = 0;
    ttsTotalSec = estimateTotalTime();
    updateTimeDisplay();
    syncUI();
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
    if (s) {
        const v = parseFloat(s.value);
        if (d) d.textContent = v.toFixed(1) + 'x';
        localStorage.setItem('faith_tts_speed', String(v));
    }
    if (!isTTSSpeaking) refreshTTSTotalTime();
    else { retimeFromCurrent(); scheduleLiveApply(usingNeural() ? 'neural-speed' : 'restart'); }
}

export function saveTTSVoice() {
    stopVoicePreview();
    const sel = document.getElementById('tts-voice-select');
    if (sel && sel.value) localStorage.setItem('faith_tts_voice', sel.value);
    // 음성마다 문장을 나누는 길이·읽는 속도가 달라 읽는 중이면 지금 문장부터 새 음성으로 다시 읽는다
    if (isTTSSpeaking) { clearTimeout(liveApplyTimer); liveApplyTimer = null; restartFromCurrentChunk(); }
    else refreshTTSTotalTime();
}

export function updateGapDisplay() {
    const s = document.getElementById('tts-gap-slider');
    const d = document.getElementById('tts-gap-value');
    if (s && d) {
        const v = parseFloat(s.value);
        d.textContent = v === 0 ? '없음' : v.toFixed(1) + '초';
        localStorage.setItem('faith_tts_gap', String(v));
    }
    // 문장 사이 쉼은 다음 쉼부터 저절로 반영되므로 남은 시간만 다시 계산한다.
    // 다만 쉼을 0에서 켜거나 0으로 끄면 문장을 묶는지가 바뀌므로 지금 문장부터 다시 나눠 읽는다
    if (!isTTSSpeaking) { refreshTTSTotalTime(); return; }
    const before = ttsTimingParams ? ttsTimingParams.gap : 0;
    retimeFromCurrent();
    const after = currentTimingParams().gap;
    if ((before > 0) !== (after > 0)) scheduleLiveApply('restart');
}

// ─── 읽는 중에 설정 바꾸기 ───

function currentTimingParams() {
    return {
        speed: parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1,
        gap: parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0,
    };
}

/** 바뀐 속도·쉼으로 전체 시간과 지금까지 읽은 시간을 다시 계산한다 (지금 문장 안에서 읽은 비율은 그대로) */
function retimeFromCurrent() {
    const next = currentTimingParams();
    const prev = ttsTimingParams || next;
    ttsTimingParams = next;
    if (!ttsChunks.length) { refreshTTSTotalTime(); return; }
    const idx = Math.max(0, Math.min(ttsChunks.length - 1, ttsChunkIndex));
    const o = buildChunkTimings(ttsChunks, prev.speed, prev.gap)[idx];
    const n = buildChunkTimings(ttsChunks, next.speed, next.gap)[idx];
    const into = Math.max(0, Math.min(o.speakSec, getElapsedSec() - o.startSec));
    const frac = o.speakSec > 0 ? into / o.speakSec : 0;
    ttsElapsedBeforePause = Math.round((n.startSec + frac * n.speakSec) * 1000);
    ttsPlayStartMs = isTTSSpeaking && !isTTSPaused ? Date.now() : 0;
    ttsTotalSec = estimateTotalTime();
    updateTimeDisplay();
}

// 막대를 끄는 동안 매번 다시 읽지 않도록, 손을 멈춘 뒤 한 번만 적용한다
let liveApplyTimer = null;
function scheduleLiveApply(kind) {
    clearTimeout(liveApplyTimer);
    liveApplyTimer = setTimeout(() => {
        liveApplyTimer = null;
        if (!isTTSSpeaking && !isTTSPaused) return;
        if (kind === 'neural-speed' && usingNeural()) refreshNeuralAhead();
        else restartFromCurrentChunk();
    }, 400);
}

/** 자연스러운 음성: 지금 소리 나는 묶음은 끝까지 읽고, 그 뒤는 새 속도로 다시 만든다 */
function refreshNeuralAhead() {
    const gen = ttsGen;
    const now = neuralClock();
    let cur = null;
    for (const t of neuralTimeline) { if (t.startAt <= now) cur = t; else break; }
    // 아직 소리가 나기 전(만드는 중)이거나 일시정지 중이면 지금 문장부터 새 속도로 다시 시작한다
    if (!cur || isTTSPaused || now >= cur.endAt) { restartFromCurrentChunk(); return; }
    unscheduleNeuralAfter(now);                          // 옛 속도로 걸어 둔 다음 묶음을 거둔다
    neuralTimeline = neuralTimeline.filter(t => t.startAt <= now);
    const old = neuralCache && neuralCache.gen === gen ? neuralCache : null;
    neuralSynthGen(gen);
    neuralSpeedRev++;
    const { speed } = currentTimingParams();
    const map = new Map();
    if (old && old.map.has(cur.index)) map.set(cur.index, old.map.get(cur.index));
    if (old && neuralModelSpeed(old.speed) === neuralModelSpeed(speed)) {
        // 1배속 이상끼리는 모델이 같은 빠르기로 말한다 → 이미 만들었거나 만드는 중인 소리를 새 배율로 빠르게만 한다
        // (모델을 다시 돌리면 긴 묶음은 남은 소리보다 오래 걸려 9초 가까이 끊겼다)
        const newGen = neuralSynthGen(gen);
        for (const [k, pr] of old.map) {
            if (k <= cur.index) continue;
            const re = pr.then(a => (a ? restretchNeural(a, speed, newGen) : null));
            re.catch(() => {});
            map.set(k, re);
        }
    } else {
        cancelNeuralBefore(neuralSynthGen(gen));   // 옛 속도로 줄 서 있던 문장은 만들지 않는다
    }
    neuralCache = { gen, voice: selectedVoiceValue(), speed, map };
    startNeuralLoop(cur.index + 1, gen, true);
}

/** 지금 읽는 문장의 처음부터 바뀐 설정으로 다시 읽는다 (일시정지 중이면 재개할 때 적용) */
function restartFromCurrentChunk() {
    let ci = Math.min(ttsChunkIndex, ttsChunks.length - 1);
    let part = readingAt.gen === ttsGen && readingAt.index === ci ? readingAt.part : 0;
    // 자연스러운 음성: 이미 다 읽은 묶음이면(다음 묶음을 기다리는 중) 다음 묶음부터 — 방금 들은 문장을 다시 읽지 않게
    const ent = usingNeural() ? neuralTimeline.find(t => t.index === ci) : null;
    if (ent && neuralClock() >= ent.endAt - 0.01 && ci + 1 < ttsChunks.length) { ci++; part = 0; }
    const cur = ttsChunks[ci];
    // 묶음을 읽던 중이면 지금 강조된 문장부터
    const at = (cur && cur.parts && cur.parts[part]) || cur;
    const pos = at && at.fullStart != null ? at.fullStart : 0;
    const src = getSpeechSource();
    if (!src.text) return;
    const { chunks, index: idx } = buildReadingChunks(src, pos);
    if (!isTTSPaused) { startPlaybackAt(chunks, idx); return; }
    ttsGen++;
    cancelSystemSpeech();
    stopNeuralAudio();
    stopNeuralTicker();
    neuralTimeline = [];
    neuralShown = { index: -1, part: -1 };
    cancelNeuralBefore(ttsGen);
    clearTimeout(ttsGapTimer);
    ttsGapTimer = null;
    const { speed, gap } = currentTimingParams();
    const timings = buildChunkTimings(chunks, speed, gap);
    ttsChunks = chunks;
    ttsChunkIndex = idx;
    ttsTimingParams = { speed, gap };
    ttsTotalSec = estimateTotalTime();
    ttsElapsedBeforePause = Math.round((timings[idx] ? timings[idx].startSec : 0) * 1000);
    ttsPlayStartMs = 0;
    ttsGapInterrupted = true;   // 살아 있는 발화가 없으므로 재개하면 이 문장부터 새로 읽는다
    updateTimeDisplay();
    syncUI();
}

export function initTTS() {
    const speed = localStorage.getItem('faith_tts_speed');
    const gap = localStorage.getItem('faith_tts_gap');
    const ss = document.getElementById('tts-speed-slider');
    const gs = document.getElementById('tts-gap-slider');
    if (speed && ss) { ss.value = String(Math.max(0.7, parseFloat(speed) || 1)); updateSpeedDisplay(); }
    localStorage.removeItem('faith_tts_pitch');   // 예전에 저장한 음높이는 더 쓰지 않는다
    localStorage.removeItem('faith_tts_tap_hint'); // 한 번 누르기 안내는 두 번 누르기 안내로 바뀌었다
    if (gap && gs) { gs.value = gap; updateGapDisplay(); }
    document.getElementById('tts-neural-btn')?.addEventListener('click', onNeuralButton);
    // 화면 아래의 다른 창(맞춤법 검사)이 열리면 음성 바를 닫는다
    window.addEventListener('bottom-panel-open', (e) => {
        if (e.detail !== 'tts' && !document.getElementById('tts-panel')?.classList.contains('hidden')) toggleTTSPanel();
    });
    const body = document.getElementById('editor-body');
    if (body) {
        body.addEventListener('mousedown', onEditorMouseDownForTTS);
        body.addEventListener('touchstart', onEditorTouchStartForTTS, { passive: false });
        body.addEventListener('touchend', onEditorTouchEndForTTS, { passive: false });
        body.addEventListener('touchcancel', () => { tapStart = null; lastTap = null; }, { passive: true });
    }
    document.addEventListener('selectionchange', onSelectionChangeForTTS);
    // 사용자가 직접 스크롤하는 동안에는 읽는 문장을 따라가지 않는다
    const markUserScroll = () => { lastUserScrollMs = Date.now(); };
    ['wheel', 'touchmove'].forEach(evt => document.addEventListener(evt, markUserScroll, { passive: true }));
    updateTimeDisplay();
}

