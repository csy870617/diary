/**
 * TTS (Text-to-Speech) 모듈 v2
 * Web Speech API 기반 - 미니 플레이어 UI
 * + 자연스러운 음성(Supertonic 3, 내려받아 기기에서 생성) — neural-tts.js
 */

import {
    NEURAL_PREFIX, NEURAL_VOICES, NEURAL_MAX_CHUNK, NEURAL_CHARS_PER_SEC,
    isNeuralVoice, isNeuralSupported, isNeuralReady, isNeuralLoaded, downloadNeuralVoice, cancelNeuralDownload,
    deleteNeuralVoice, synthesizeNeural, cancelNeuralBefore, unlockNeuralAudio, playNeuralAudio,
    stopNeuralAudio, pauseNeuralAudio, resumeNeuralAudio, lowerNeuralQuality, getNeuralInfo,
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
let ttsHeartbeatTimer = null;  // Chrome ~15초 침묵 중단 방지용 resume 하트비트
let ttsVoicesListener = null;

// 재생 시간 추적
let ttsTotalSec = 0;           // 예상 총 재생 시간
let ttsPlayStartMs = 0;        // 현재 재생 세션 시작 시각
let ttsElapsedBeforePause = 0; // 일시정지 전까지 누적된 경과(ms)
let ttsTimerInterval = null;
let ttsTimingParams = null;     // 지금 시간 계산에 쓴 속도·쉼 — 읽는 중에 바꾸면 이 값과 비교해 다시 계산

// 1x 속도에서 TTS가 읽는 평균 문자 수/초 (경험적 추정)
const CHARS_PER_SEC = 13;

function selectedVoiceValue() {
    return document.getElementById('tts-voice-select')?.value || '';
}
function usingNeural() {
    return isNeuralVoice(selectedVoiceValue());
}
// 자연스러운 음성은 기본 음성보다 천천히 읽는다 (재생 시간 예상·탐색 위치 계산용)
function charsPerSec() {
    return usingNeural() ? NEURAL_CHARS_PER_SEC : CHARS_PER_SEC;
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
 * 기록한 위치로 '지금 읽는 문장'을 화면에서 찾아 강조하고, 탭한 곳이 몇 번째 글자인지 계산한다.
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


// ─── 지금 읽는 문장 강조 · 문장을 눌러 거기서부터 읽기 ───
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

/** 음성 바가 열려 있으면 문장을 누른 곳부터 읽는다 (보기·편집 모두 — 편집 중에는 커서도 그대로 놓인다) */
function onEditorTapForTTS(e) {
    if (!ttsPanelOpen()) return;
    if (e.button !== 0 || e.detail > 1) return;                 // 두 번 눌러 단어 고르기는 그대로
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return; // 늘려 고르기 등 키를 함께 누른 경우는 그대로
    if (e.target.closest('a, img, button, input, select, textarea, .tts-panel')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;  // 끌어서 고른 경우는 그대로
    const pt = caretFromPoint(e.clientX, e.clientY);
    if (!pt) return;
    const index = getTextIndex();
    const pos = offsetAtPosition(index, pt.node, pt.offset);
    if (pos == null) return;
    playFromOffset(pos);
}

function playFromOffset(pos) {
    const neural = usingNeural();
    if (!neural && !('speechSynthesis' in window)) return;
    if (neural) unlockNeuralAudio();   // 누른 순간에 소리 장치를 깨워 둔다 (아이폰)
    const src = getSpeechSource();
    if (!src.text) return;
    const chunks = splitChunks(src.text, getMaxChunkLen(), src.map);
    let idx = chunks.findIndex(c => c.fullEnd != null && c.fullEnd > pos);
    if (idx < 0) idx = chunks.length - 1;
    startPlaybackAt(chunks, idx);
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
    startTTSHeartbeat();
    syncUI();
    setTimeout(speakNext, 0);
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
        panel.classList.remove('hidden');
        document.getElementById('write-modal')?.classList.add('tts-open');
        // 새 기능 안내: 처음 몇 번만 알려 준다
        try {
            const seen = Number(localStorage.getItem('faith_tts_tap_hint') || '0');
            if (seen < 3) {
                localStorage.setItem('faith_tts_tap_hint', String(seen + 1));
                setTimeout(() => showToast('문장을 누르면 그 문장부터 읽습니다.'), 300);
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
    const ready = await isNeuralReady();
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
    updatePitchAvailability();
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
    // onvoiceschanged 직접 할당은 다른 리스너를 덮어쓰고 이후에도 재실행되므로
    // addEventListener를 사용하고 음성 로드 성공 시 제거
    if (!ttsVoices.length) {
        if (ttsVoicesListener) speechSynthesis.removeEventListener('voiceschanged', ttsVoicesListener);
        ttsVoicesListener = () => {
            populate();
            if (ttsVoices.length) {
                speechSynthesis.removeEventListener('voiceschanged', ttsVoicesListener);
                ttsVoicesListener = null;
            }
        };
        speechSynthesis.addEventListener('voiceschanged', ttsVoicesListener);
    }
}

// 자연스러운 음성은 음높이를 바꿀 수 없다 → 슬라이더를 잠그고 이유를 알려 준다
function updatePitchAvailability() {
    const slider = document.getElementById('tts-pitch-slider');
    if (!slider) return;
    const neural = usingNeural();
    slider.disabled = neural;
    const row = slider.closest('.tts-row');
    if (row) {
        row.classList.toggle('tts-row-disabled', neural);
        row.title = neural ? '자연스러운 음성은 음높이를 바꿀 수 없습니다' : '';
    }
}

// ─── 자연스러운 음성 내려받기 ───
let neuralDownloading = false;

function setNeuralRow(statusText, btnText, progressPct) {
    const status = document.getElementById('tts-neural-status');
    const btn = document.getElementById('tts-neural-btn');
    const bar = document.getElementById('tts-neural-progress');
    const fill = document.getElementById('tts-neural-progress-fill');
    if (status) status.textContent = statusText;
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
    if (await isNeuralReady()) {
        const info = getNeuralInfo();
        const where = info.backend ? `${info.backend === 'webgpu' ? ' · GPU로 계산' : ' · CPU로 계산'} · 품질 ${info.steps}/8` : '';
        setNeuralRow('받아 둠 · 인터넷 없이 사용 가능' + where, '삭제', null);
        // 더 자연스럽거나 빠른 엔진 등 새 버전이 있으면 업데이트를 권한다 (확인은 인터넷이 될 때만)
        neuralUpdate = await checkNeuralUpdate();
        if (neuralUpdate && !neuralDownloading) {
            const mb = Math.max(1, Math.round(neuralUpdate.bytes / 1e6));
            setNeuralRow(`${neuralUpdateName()}이 있습니다 (약 ${mb}MB)`, '업데이트', null);
        }
    } else {
        // 받아 둔 파일을 브라우저가 지웠다면 이유를 알려 준다 (앱 안 브라우저·사생활 보호 모드·종료 시 데이터 삭제 설정 등)
        const app = inAppBrowserName();
        let msg = neuralWasEvicted()
            ? '브라우저가 받아 둔 음성을 지웠습니다 · 다시 받아 주세요'
            : '약 250~500MB · 와이파이에서 받기를 권장합니다';
        if (app) msg += ` · ${app} 안에서는 받은 음성이 지워질 수 있어 Chrome·Safari로 여는 것을 권장합니다`;
        setNeuralRow(msg, '내려받기', null);
    }
}

async function onNeuralButton() {
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
                setNeuralRow(`받는 중… ${pct}% (${Math.round(got / 1e6)} / ${Math.round(total / 1e6)}MB)`, '취소', pct);
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
            setNeuralRow(`받는 중… ${pct}% (${Math.round(got / 1e6)} / ${Math.round(total / 1e6)}MB)`, '취소', pct);
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

// 다른 글을 열 때 호출 — 이전 글의 강조 표시를 지운다
export function clearTTSRangeForNewEntry() {
    clearTTSHighlight();
}

function showToast(msg, ms = 1800) {
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

/** Chrome의 ~15초 발화 중단을 피하기 위해 속도에 비례해 청크 최대 길이 산정 */
function getMaxChunkLen() {
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    const len = Math.max(60, Math.min(300, Math.round(180 * speed)));
    // 자연스러운 음성은 한 번에 120자 안쪽으로 만들어야 안정적이다
    return usingNeural() ? Math.min(len, NEURAL_MAX_CHUNK) : len;
}

function estimateTotalTime() {
    const text = getTextToSpeak();
    if (!text) return 0;
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    const gap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') || 0;
    const chunks = splitChunks(text, getMaxChunkLen());
    const speakTime = text.length / charsPerSec() / speed;
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
        const speakSec = spokenLen / charsPerSec() / speed;
        timings.push({ index: i, startSec: elapsed, speakSec });
        elapsed += speakSec;
        if (i < chunks.length - 1) {
            elapsed += gapSec + extraPauseForDots(chunks[i].dots);
        }
    }
    return timings;
}

function getSeekState(src, percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const chunks = splitChunks(src.text, getMaxChunkLen(), src.map);
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

// Chrome은 ~15초 이상 이어지는 발화를 조용히 중단하므로 주기적 resume()으로 유지
function startTTSHeartbeat() {
    stopTTSHeartbeat();
    ttsHeartbeatTimer = setInterval(() => {
        if (isTTSSpeaking && !isTTSPaused && 'speechSynthesis' in window && !usingNeural()) speechSynthesis.resume();
    }, 10000);
}

function stopTTSHeartbeat() {
    if (ttsHeartbeatTimer) {
        clearInterval(ttsHeartbeatTimer);
        ttsHeartbeatTimer = null;
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
    const normalized = normalizeForSpeech(text).replace(/['’`´\-‐‑‒–—―]+/g, ' ');
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
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
        speechSynthesis.resume(); // paused 고착 방지 (발화 없을 땐 무해)
    }
}

export function playTTS() {
    const neural = usingNeural();
    if (!neural && !('speechSynthesis' in window)) {
        alert('이 브라우저는 TTS를 지원하지 않습니다.');
        return;
    }
    // 아이폰은 재생 버튼을 누른 순간에 소리 장치를 깨워 두어야 이후 생성된 음성이 재생된다
    if (neural) unlockNeuralAudio();

    // 일시정지 → 재개
    if (isTTSPaused) {
        isTTSPaused = false;
        isTTSSpeaking = true;
        ttsPlayStartMs = Date.now();
        startTimeTicker();
        startTTSHeartbeat();
        syncUI();
        if (ttsGapInterrupted) {
            // 청크 간 쉼 도중 일시정지된 경우 → 살아있는 발화가 없으므로 speakNext로 재진입
            ttsGapInterrupted = false;
            // 엔진이 paused로 남아 있으면 새 발화가 무음 대기하므로 먼저 해제 (발화 없을 땐 무해)
            if (!neural && 'speechSynthesis' in window) speechSynthesis.resume();
            speakNext();
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
    startTTSHeartbeat();
    // cancel() 직후 곧바로 speak()를 호출하면 일부 브라우저(Chrome)에서 새 발화가
    // 무시되거나 엔진이 꼬이는 경우가 있어, 한 틱 미뤄서 cancel()이 먼저 처리되게 한다.
    setTimeout(speakNext, 0);
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
        startTTSHeartbeat();
        // cancel() 직후 곧바로 speak()를 호출하면 일부 브라우저(Chrome)에서 새 발화가
        // 무시되거나 엔진이 꼬이는 경우가 있어, 한 틱 미뤄서 cancel()이 먼저 처리되게 한다.
        setTimeout(speakNext, 0);
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
    // [a, b) 구간을 앞뒤 공백을 걷어 한 조각으로
    const add = (a, b, dots) => {
        while (a < b && isWs(text[a])) a++;
        while (b > a && isWs(text[b - 1])) b--;
        if (a >= b) return;
        const c = { text: text.slice(a, b), dots };
        if (map) { c.fullStart = map[a]; c.fullEnd = map[b - 1] + 1; }
        chunks.push(c);
    };
    // 구두점으로도 나눌 수 없는 긴 조각은 max 길이로 강제 분할해 Chrome ~15초 컷오프 방지.
    // 낱말 한가운데서 자르면 그 낱말이 두 번에 나뉘어 어색하게 읽히므로 띄어쓰기에서 자르고,
    // 끝에 두어 글자만 따로 남지 않도록 조각 길이를 고르게 나눈다.
    const pushHardSliced = (a, b, dots) => {
        while (a < b && isWs(text[a])) a++;
        while (b > a && isWs(text[b - 1])) b--;
        while (b - a > max) {
            const target = a + Math.ceil((b - a) / Math.ceil((b - a) / max));
            let cut = a + max;
            for (let d = 0; d <= max / 2; d++) {
                if (target - d > a && isWs(text[target - d])) { cut = target - d; break; }
                if (target + d < a + max && isWs(text[target + d])) { cut = target + d; break; }
            }
            add(a, cut, 0);
            a = cut;
            while (a < b && isWs(text[a])) a++;
        }
        add(a, b, dots);
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
                    pushHardSliced(cs, ce, 0);
                    cs = pa; ce = pb;
                } else {
                    if (cs < 0) cs = pa;
                    ce = pb;
                }
            }
            if (cs >= 0) pushHardSliced(cs, ce, dots);
        } else {
            add(a, b, dots);
        }
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
        stopTTSHeartbeat();
        ttsElapsedBeforePause = (ttsTotalSec || 0) * 1000;
        ttsPlayStartMs = 0;
        updateTimeDisplay();
        syncUI();
        clearTTSHighlight();
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

    if (usingNeural()) { speakNextNeural(currentChunk); return; }

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

    const myGen = ttsGen; // 발화 세대 캡처 — 교체된 발화의 stale 이벤트 무시
    utt.onstart = () => {
        if (myGen !== ttsGen) return;
        isTTSSpeaking = true; isTTSPaused = false; syncUI();
        highlightChunk(currentChunk);
    };
    utt.onend = () => {
        if (myGen !== ttsGen) return;
        advanceAfterChunk(currentChunk, 0);
    };
    utt.onerror = (e) => {
        if (myGen !== ttsGen) return;
        // cancel()로 인해 발생하는 canceled/interrupted 에러는 탐색/정지/재시작 과정의 정상 동작
        if (e.error === 'canceled' || e.error === 'interrupted') return;
        console.error('TTS error:', e.error);
        isTTSSpeaking = false;
        isTTSPaused = false;
        stopTimeTicker();
        stopTTSHeartbeat();
        syncUI();
    };

    setProgress(Math.round((ttsChunkIndex / ttsChunks.length) * 100));
    speechSynthesis.speak(utt);
}

/** 한 문장을 다 읽은 뒤: 진행률을 올리고, 설정한 쉼만큼 기다렸다가 다음 문장으로 */
function advanceAfterChunk(currentChunk, minGapMs) {
    ttsChunkIndex++;
    setProgress(Math.round((ttsChunkIndex / ttsChunks.length) * 100));
    const baseGap = parseFloat(document.getElementById('tts-gap-slider')?.value || '0') * 1000;
    const dotGap = extraPauseForDots(currentChunk.dots) * 1000;
    const totalGap = Math.max(minGapMs || 0, baseGap + dotGap);
    if (totalGap > 0 && ttsChunkIndex < ttsChunks.length) {
        ttsGapTimer = setTimeout(() => { ttsGapTimer = null; speakNext(); }, totalGap);
    } else {
        speakNext();
    }
}

// ─── 자연스러운 음성 재생 ───
// 문장 하나를 만드는 데 몇 초 걸리므로, 읽는 동안 앞으로 읽을 문장들을 미리 만들어 둔다.
// 한 문장만 미리 만들면 그다음 문장은 지금 문장이 끝나야 만들기 시작해, 길이가 들쭉날쭉한
// 글에서 문장 사이가 자주 끊겼다. 작업자가 쉬지 않도록 몇 문장 앞까지 줄 세워 둔다.
// 미리 만들 분량: 문장 수가 아니라 '앞으로 읽을 시간'으로 정한다.
// 문장 수(3개)로 정하면 짧은 문장들 뒤에 오는 아주 긴 문장을 너무 늦게 만들기 시작해 그 앞에서 끊겼다.
const NEURAL_AHEAD_SEC = 40;
const NEURAL_AHEAD_MAX = 10;
let neuralCache = null;             // { gen, voice, map: Map<index, Promise> }
let neuralErrorShown = false;
let neuralPlayedGen = -1;           // 이 재생(세대)에서 이미 한 문장 이상 읽었는가
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

// 문장 끝의 쉼 — 모델이 문장 끝을 짧게 끊어 쉼 없이 이으면 숨 쉴 틈이 없다 (공식 예제 0.3초)
const NEURAL_SENTENCE_GAP_MS = 250;
// 긴 문장을 쉼표 등에서 나눈 자리 — 문장 끝처럼 쉬면 한 문장 안에서 툭툭 끊겨 들린다
const NEURAL_CLAUSE_GAP_MS = 60;

function neuralGapAfter(chunk) {
    return /[.!?。…"'」』)\]]\s*$/.test(chunk.text || '') ? NEURAL_SENTENCE_GAP_MS : NEURAL_CLAUSE_GAP_MS;
}

// 읽는 중에 속도를 바꾸면, 옛 속도로 미리 만들려고 줄 세워 둔 문장들만 버린다 (지금 읽는 문장은 그대로).
// 작업자는 '이 번호보다 작은 요청'을 건너뛰므로 같은 재생 안에서 번호를 조금씩 올려 구분한다.
let neuralSpeedRev = 0, neuralSpeedRevGen = -1;
function neuralSynthGen(gen) {
    if (neuralSpeedRevGen !== gen) { neuralSpeedRevGen = gen; neuralSpeedRev = 0; }
    return gen + Math.min(neuralSpeedRev, 999) / 1000;
}
let neuralNowPlaying = null;        // { gen, index } — 지금 소리가 나고 있는 문장

function requestNeural(index, gen) {
    const voice = selectedVoiceValue();
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    if (!neuralCache || neuralCache.gen !== gen || neuralCache.voice !== voice || neuralCache.speed !== speed) {
        neuralCache = { gen, voice, speed, map: new Map() };
    }
    const map = neuralCache.map;
    if (map.has(index)) return map.get(index);
    const text = cleanForSpeech(ttsChunks[index]?.text || '');
    const promise = text ? synthesizeNeural(text, voice, speed, neuralSynthGen(gen)) : Promise.resolve(null);
    promise.catch(() => {});   // 미리 만들다 실패해도 그 문장 차례에 다시 처리한다
    map.set(index, promise);
    return promise;
}

/** 지금 문장 뒤로 몇 문장을 미리 만들어 두고, 지나간 문장은 버린다 */
function fillNeuralAhead(index, gen) {
    if (!neuralCache || neuralCache.gen !== gen) return;
    for (const k of [...neuralCache.map.keys()]) if (k < index) neuralCache.map.delete(k);
    const speed = parseFloat(document.getElementById('tts-speed-slider')?.value || '1') || 1;
    let aheadSec = 0;
    for (let k = index + 1; k < ttsChunks.length && k <= index + NEURAL_AHEAD_MAX && aheadSec < NEURAL_AHEAD_SEC; k++) {
        requestNeural(k, gen);
        aheadSec += cleanForSpeech(ttsChunks[k].text).length / NEURAL_CHARS_PER_SEC / speed;
    }
}

async function speakNextNeural(currentChunk) {
    const myGen = ttsGen;
    const index = ttsChunkIndex;
    localStorage.setItem('faith_tts_voice', selectedVoiceValue());
    setProgress(Math.round((index / ttsChunks.length) * 100));
    if (!isNeuralLoaded()) showToast('자연스러운 음성을 준비하고 있습니다…');
    let audio;
    try {
        const pending = requestNeural(index, myGen);
        // 첫 문장이 아닌데 아직 덜 만들어졌다 = 재생이 기다리게 됐다(끊김) → 품질을 한 단계 낮춘다
        let ready = false;
        pending.then(() => { ready = true; }, () => { ready = true; });
        await Promise.resolve();
        // (재생·탭·탐색 직후의 첫 문장은 기다리는 게 당연하므로 따지지 않는다)
        const stalled = !ready && neuralPlayedGen === myGen;
        if (stalled) lowerNeuralQuality();
        fillNeuralAhead(index, myGen);
        const waitStart = performance.now();
        audio = await pending;
        if (stalled) {
            const ms = Math.round(performance.now() - waitStart);
            addNeuralDiag({ type: 'wait', ms, index });
            warnIfTooSlow();
        }
    } catch (err) {
        if (myGen !== ttsGen) return;
        console.error('자연스러운 음성 생성 실패:', err);
        neuralCache = null;
        isTTSSpeaking = false;
        isTTSPaused = false;
        stopTimeTicker();
        stopTTSHeartbeat();
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
        return;
    }
    if (myGen !== ttsGen) return;
    if (!audio) { advanceAfterChunk(currentChunk, 0); return; }
    // 재생을 막 시작했는데 첫 문장이 아주 짧으면(예: "감사합니다."), 그걸 읽는 동안 다음 문장을
    // 다 못 만들어 바로 끊긴다. 이때만 다음 문장까지 준비한 뒤 시작한다.
    if (neuralPlayedGen !== myGen && audio.wav.length / audio.sampleRate < 3 && index + 1 < ttsChunks.length) {
        try { await requestNeural(index + 1, myGen); } catch (e) { /* 다음 문장 실패는 그 차례에 처리 */ }
        if (myGen !== ttsGen) return;
    }
    // 만드는 동안 일시정지를 눌렀다면, 재개할 때 이 문장부터 읽는다 (만든 결과는 그대로 재사용)
    if (isTTSPaused) { ttsGapInterrupted = true; return; }

    // 앞으로 읽을 문장들을 미리 만들어 둔다
    fillNeuralAhead(index, myGen);

    isTTSSpeaking = true;
    syncUI();
    highlightChunk(currentChunk);
    neuralPlayedGen = myGen;
    neuralNowPlaying = { gen: myGen, index };
    const finished = await playNeuralAudio(audio.wav, audio.sampleRate);
    if (neuralNowPlaying && neuralNowPlaying.gen === myGen && neuralNowPlaying.index === index) neuralNowPlaying = null;
    if (myGen !== ttsGen || !finished) return;
    advanceAfterChunk(currentChunk, neuralGapAfter(currentChunk));
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
            pauseNeuralAudio();   // 만드는 중이었다면 끝난 뒤 speakNextNeural이 재개를 기다린다
        } else {
            speechSynthesis.pause();
        }
        isTTSPaused = true;
        if (ttsPlayStartMs) {
            ttsElapsedBeforePause += Date.now() - ttsPlayStartMs;
            ttsPlayStartMs = 0;
        }
        stopTimeTicker();
        stopTTSHeartbeat();
        updateTimeDisplay();
        syncUI();
    }
}

export function stopTTS() {
    ttsGen++; // 이전 발화의 stale 이벤트 무효화
    ttsGapInterrupted = false;
    // 음성 읽기를 지원하지 않는 브라우저(일부 앱 내 WebView)에서는 여기서 예외가 나
    // 편집기 닫기·저장까지 멈췄다. 엔진이 있을 때만 호출한다.
    // 일시정지 중 정지하면 Chrome이 paused 상태를 유지해 다음 재생이 무음이 되므로 해제
    cancelSystemSpeech();
    stopNeuralAudio();
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
    stopTTSHeartbeat();
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

export function updatePitchDisplay() {
    const s = document.getElementById('tts-pitch-slider');
    const d = document.getElementById('tts-pitch-value');
    if (s) {
        const v = parseFloat(s.value);
        if (d) {
            let label = v < 0.9 ? '낮음' : v > 1.1 ? '높음' : '보통';
            d.textContent = label;
        }
        localStorage.setItem('faith_tts_pitch', String(v));
    }
    // 높낮이는 기본 음성만 쓴다 — 읽는 중이면 지금 문장부터 새 높낮이로 다시 읽는다
    if (isTTSSpeaking && !usingNeural()) scheduleLiveApply('restart');
}

export function saveTTSVoice() {
    const sel = document.getElementById('tts-voice-select');
    if (sel && sel.value) localStorage.setItem('faith_tts_voice', sel.value);
    updatePitchAvailability();
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
    // 문장 사이 쉼은 다음 쉼부터 저절로 반영되므로 남은 시간만 다시 계산한다
    if (!isTTSSpeaking) refreshTTSTotalTime();
    else retimeFromCurrent();
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

/** 자연스러운 음성: 지금 문장은 끝까지 읽고, 뒤 문장들은 새 속도로 다시 만든다 */
function refreshNeuralAhead() {
    const gen = ttsGen;
    const playingNow = neuralNowPlaying && neuralNowPlaying.gen === gen && neuralNowPlaying.index === ttsChunkIndex && !ttsGapTimer;
    // 아직 소리가 나기 전(만드는 중·문장 사이 쉼)이면 지금 문장부터 새 속도로 다시 시작한다
    if (!playingNow) { restartFromCurrentChunk(); return; }
    const cur = neuralCache && neuralCache.gen === gen ? neuralCache.map.get(ttsChunkIndex) : null;
    neuralSynthGen(gen);
    neuralSpeedRev++;
    const { speed } = currentTimingParams();
    neuralCache = { gen, voice: selectedVoiceValue(), speed, map: new Map(cur ? [[ttsChunkIndex, cur]] : []) };
    cancelNeuralBefore(neuralSynthGen(gen));   // 옛 속도로 줄 서 있던 문장은 만들지 않는다
    fillNeuralAhead(ttsChunkIndex, gen);
}

/** 지금 읽는 문장의 처음부터 바뀐 설정으로 다시 읽는다 (일시정지 중이면 재개할 때 적용) */
function restartFromCurrentChunk() {
    const cur = ttsChunks[Math.min(ttsChunkIndex, ttsChunks.length - 1)];
    const pos = cur && cur.fullStart != null ? cur.fullStart : 0;
    const src = getSpeechSource();
    if (!src.text) return;
    const chunks = splitChunks(src.text, getMaxChunkLen(), src.map);
    let idx = chunks.findIndex(c => c.fullEnd != null && c.fullEnd > pos);
    if (idx < 0) idx = chunks.length - 1;
    if (!isTTSPaused) { startPlaybackAt(chunks, idx); return; }
    ttsGen++;
    cancelSystemSpeech();
    stopNeuralAudio();
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
    const pitch = localStorage.getItem('faith_tts_pitch');
    const gap = localStorage.getItem('faith_tts_gap');
    const ss = document.getElementById('tts-speed-slider');
    const ps = document.getElementById('tts-pitch-slider');
    const gs = document.getElementById('tts-gap-slider');
    if (speed && ss) { ss.value = speed; updateSpeedDisplay(); }
    if (pitch && ps) { ps.value = pitch; updatePitchDisplay(); }
    if (gap && gs) { gs.value = gap; updateGapDisplay(); }
    document.getElementById('tts-neural-btn')?.addEventListener('click', onNeuralButton);
    document.getElementById('editor-body')?.addEventListener('click', onEditorTapForTTS);
    // 사용자가 직접 스크롤하는 동안에는 읽는 문장을 따라가지 않는다
    const markUserScroll = () => { lastUserScrollMs = Date.now(); };
    ['wheel', 'touchmove'].forEach(evt => document.addEventListener(evt, markUserScroll, { passive: true }));
    updateTimeDisplay();
}

