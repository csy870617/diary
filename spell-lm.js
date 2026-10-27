/**
 * 정밀 검사 — 문맥 언어 모델(Kiwi)로 고칠 말을 고른다.
 *
 * 사전(Hunspell)은 낱말 하나가 맞는지만 안다. 그래서
 *  - 사전에 없는 말을 고칠 후보가 여럿이면(절하시만 → 절하지만? 절하시면?) 어느 것인지 몰라 그냥 두었고,
 *  - 사전에 있는 말을 잘못 쓴 것(동상이 새워져 → 세워져, 승려의 들고 → 승려가 들고)은 아예 알 수 없었다.
 * 언어 모델은 문장이 얼마나 자연스러운지 점수를 매긴다. 고칠 후보마다 문장을 바꿔 점수를 견주어,
 * 원래 문장보다 확실히 자연스러워지는 것만 고친다.
 *
 * DOM을 쓰지 않는다 (spell-worker.js가 쓰고, Node 시험에서도 같은 함수를 쓴다).
 */
// 이 파일은 작업자 안에서 열리는데, 작업자에는 import map이 없어 './spell-text.js'를 그냥 부르면
// 캐시에 남은 옛 판이 섞인다 (새로 넣은 함수가 없어 정밀 검사가 아예 열리지 않을 수 있다).
// 이 파일에 붙은 판(?v=)을 그대로 붙여 부른다.
const {
    wordsOf, koreanCandidates, knownKorean, partsOf, compose, hasJong, objectBeforeIn,
    CHO, JUNG, JONG, VOWEL_SETS, ARCHAIC, CONFUSABLES, ONE_NOUNS
} = await import(new URL('./spell-text.js' + new URL(import.meta.url).search, import.meta.url).href);

const CHOS = [...CHO], JUNGS = [...JUNG];

/** 낱자 하나를 바꾼 꼴들 (어둠고 → 어둡고, 절하시만 → 절하지만) */
export function jamoEdits(word) {
    const syl = [...word].map(partsOf);
    const out = new Set();
    syl.forEach((s, k) => {
        const put = (p, v) => {
            const t = syl.map(x => x.slice());
            t[k][p] = v;
            out.add(t.map(compose).join(''));
        };
        for (const c of CHOS) if (c !== s[0]) put(0, c);
        for (const v of JUNGS) if (v !== s[1]) put(1, v);
        for (const j of JONG) if (j !== s[2]) put(2, j);
    });
    out.delete(word);
    return out;
}

// 사전에 있는 말끼리 헷갈리는 짝 — 앞부분을 바꿔 본다 (어느 쪽이 맞는지는 언어 모델이 정한다)
const PAIRS = [
    ['새워', '세워', "'세우다'(일으켜 서게 하다)와 '새우다'(밤을 새우다)를 가려 씁니다"], ['새웠', '세웠'], ['새우', '세우'], ['새운', '세운'],
    ['들렸', '들렀'], ['들려', '들러'], ['낳았', '나았'], ['낳아', '나아'], ['맞췄', '맞혔'], ['맞춰', '맞혀'], ['맞추', '맞히'],
    ['붙였', '부쳤'], ['붙여', '부쳐'], ['붙이', '부치'], ['가르쳐', '가리켜'], ['가르치', '가리키'], ['가르쳤', '가리켰'],
    ['반듯이', '반드시'], ['일부로', '일부러'], ['결재', '결제'], ['다렸', '달였'], ['다려', '달여'], ['다리', '달이'],
    ['베었', '배었'], ['베어', '배어'], ['벴', '뱄'], ['빗었', '빚었'], ['빗어', '빚어'], ['빗고', '빚고'], ['빗는', '빚는'],
    ['젖혔', '제쳤'], ['젖혀', '제쳐'], ['젖히', '제치'], ['업고', '엎고'], ['업어', '엎어'], ['업었', '엎었'], ['업질', '엎질'],
    ['한참', '한창'], ['체', '채'], ['로써', '로서'], ['으로써', '으로서'],
];

/** (시험용) 헷갈리는 짝 후보들 */
export function confusionCandidates(word) {
    return new Set(confusionOptions(word, true).map(o => o.to));
}
// ─── Kiwi의 형태소 분석으로 낱말이 어떤 꼴인지 본다 ───
const STEM_TAG = /^(VV|VA|VX|VCP|VCN|XSV|XSA|EP)$/;
const CONTENT_TAG = /^(NNG|NNP|NR|NP|VV|VA|MM|MAG|MAJ|IC)$/;
const NOUN_TAG = /^(NNG|NNP|NR|NP)$/;

/** 이 낱말에 걸친 형태소들 */
function tokensIn(tokens, start, end) {
    return tokens.filter(t => t.position >= start && t.position < end);
}

/**
 * 형태소 짜임이 우리말 문법에 맞지 않는가 — 잘못 친 말의 표시.
 * (어둠고 = 어둠/명사 + 고/어미: 어미가 풀이말 뒤가 아닌 곳에 붙었다, 절하시만 = …시/높임 + 말/보조 용언)
 * 사전에 없어도 짜임이 바른 말(특송·엄마표·명철을)은 Kiwi가 아는 말이라 고치지 않는다.
 */
const tagOf = (t) => t.tag.replace(/-.*$/, '');   // 'VA-I'(불규칙 활용) → 'VA'

export function illFormed(toks) {
    if (!toks.length) return true;
    if (/^(E|J|XS|VX)/.test(tagOf(toks[0]))) return true;   // 어미·조사·뒷가지·보조 용언으로 시작
    for (let k = 0; k < toks.length; k++) {
        const t = tagOf(toks[k]), p = k ? tagOf(toks[k - 1]) : '';
        if (toks[k].morphId < 0 && t !== 'NNP') return true;   // 모르는 형태소
        if (!p) continue;
        if (t[0] === 'E' && !STEM_TAG.test(p) && p[0] !== 'E') return true;   // 풀이말 줄기 없이 어미
        if (p === 'EP' && /^(VV|VA|VX)$/.test(t)) return true;   // 선어말 어미 뒤에 풀이말
        if (p[0] === 'J' && t[0] === 'E') return true;            // 조사 뒤에 어미
    }
    return false;
}

/**
 * 형태소 사이에서 띄어 써야 할 곳 (붙여 쓴 말을 나눌 때)
 * 띄어쓰기 규정: 조사·어미·뒷가지는 붙이고, 그 뒤에 오는 새 낱말·꾸미는 말 뒤·의존 명사 앞은 띄운다.
 * 합성 명사(명사+명사)와 보조 용언은 붙여 써도 되므로 나누지 않는다.
 */
// 한 글자로 떨어져도 되는 말 (이름이 한 글자씩 갈라지지 않도록 이 밖의 한 글자 조각은 만들지 않는다)
const SAFE_MM = new Set(['별', '새', '헌', '옛', '각', '온', '첫', '딴', '웬', '몇', '두', '세', '네', '이런', '그런', '저런', '어떤', '무슨', '모든', '여러', '온갖', '다른']);
const SAFE_SINGLE = new Set(['별', '새', '헌', '옛', '각', '온', '첫', '딴', '웬', '몇', '두', '세', '네', '좀', '더', '잘', '못', '안', '꼭', '또', '다', '덜', '늘', '곧', '참', '막', '꽤', '왜', ...ONE_NOUNS]);
const DO_FORM = /^(하|되|돼|시키|당하|받|드리|해|했|됐)$/;   // '-하다·-되다'처럼 앞말에 붙는 풀이말 (스크롤하다·로그인되다)

export function spacingCuts(word, toks, start) {
    const cuts = [];
    // '-기·-음'으로 명사처럼 된 말(붙여넣기·줄바꿈·뒤로가기)은 한 덩어리로 둔다
    if (toks.some(t => t.tag === 'ETN')) return cuts;
    for (let k = 1; k < toks.length; k++) {
        const t = toks[k], p = toks[k - 1], tt = tagOf(t), pt = tagOf(p);
        const at = t.position - start;
        if (at <= 0 || at >= word.length || p.position === t.position) continue;
        if (cuts.length && cuts[cuts.length - 1] >= at) continue;
        if (DO_FORM.test(t.str)) continue;
        let cut = false;
        if (tt === 'NNB') cut = pt === 'ETM';                                   // '-ㄴ·-ㄹ' 뒤의 의존 명사 (할수 → 할 수)
        else if (CONTENT_TAG.test(tt) && pt !== 'XPN') {
            if (/^(JKS|JKO|JKB|JX|JC|EC|ETM)$/.test(pt)) cut = true;          // 조사·이어 주는 어미 뒤의 새 낱말 ('의' 뒤는 이름일 수 있어 빼다: 사랑의교회)
            else if (pt === 'MM') cut = SAFE_MM.has(p.str);                    // 관형사 뒤 (별상관 → 별 상관)
            else if (/^(MAG|MAJ)$/.test(pt)) cut = true;                       // 부사 뒤
            else if (NOUN_TAG.test(pt) && /^(VV|VA)$/.test(tt)) cut = true;    // 명사 + 풀이말 (밥먹다)
        }
        if (cut) cuts.push(at);
    }
    return cuts;
}

// 이름에 흔히 쓰는 글자 (성씨 포함). 사전에 없는 두세 글자 말이 이 글자들로만 되어 있으면 이름으로 보고 고치지 않는다
// (지민이랑 → 지문이랑, 정다은 → 정답은 처럼 바꾸지 않게). '녀무·저젹·오널'처럼 이름에 잘 안 쓰는 글자가 있으면 오타로 본다
const NAME_SYL = new Set(('가 갈 감 강 건 겸 경 고 곽 관 광 구 국 규 균 근 금 기 길 김 나 난 남 녕 노 다 단 담 대 덕 도 돈 동 두 라 란 래 려 련 렬 령 례 로 록 론 룡 루 류 률 륜 리 린 림 '
    + '마 만 맹 명 모 목 무 문 미 민 바 박 반 방 배 백 범 변 별 병 보 복 봉 부 분 빈 빛 사 산 삼 상 새 생 서 석 선 설 섭 성 세 소 손 솔 송 수 숙 순 술 슬 승 시 식 신 실 심 '
    + '아 안 애 양 어 언 엄 여 연 열 염 영 예 오 옥 온 완 왕 요 용 우 운 웅 원 월 위 유 육 윤 율 은 을 음 의 이 익 인 일 임 자 장 재 전 정 제 조 종 좌 주 준 중 지 진 '
    + '차 찬 창 채 천 철 청 초 최 추 춘 충 치 칠 탁 태 택 팽 편 표 피 하 학 한 함 해 행 향 허 혁 현 형 혜 호 홍 화 환 황 회 효 후 훈 휘 희 흥').split(' '));
const NAME_TAIL = /(이|이가|이는|이도|이를|이랑|이와|이의|이한테|이에게|가|는|도|를|랑|와|의|한테|에게|아|야|님|씨)$/;
function nameLike(word) {
    const stem = word.replace(NAME_TAIL, '') || word;
    return stem.length >= 2 && stem.length <= 3 && [...stem].every(ch => NAME_SYL.has(ch));
}
// 외래어에 흔한 글자 (히스토리·스킵·스킴) — 사전에 없는 외래어는 오타로 보지 않는다
const LOAN_SYL = /[스트크프즈츠쉬쥬퓨큐튜뷰퀴퀘펜텐센렌덴켄젠웨휴팁탭랩킵킴핑링킹톡앱폰캡챗봇핏룩샵숍몰칩컷펙텍렉섹벨셀델젤]/;

/**
 * 정밀 검사 → [{ id, a, b, from, to, type, why, src: 'lm' }]
 * lines: [{ id, text }]
 * dict: { spell(word) } (Hunspell, 동기)
 * kiwi: { analyze(text) → { tokens, score } }
 * taken(id, a, b) → 이미 다른 검사가 고친 자리인가
 * 기준값(…Gain·…Margin)은 바른 글과 일부러 틀린 글로 시험해 맞춘다.
 */
export function lmFixes(lines, dict, kiwi, {
    base = [], skip = () => false, window = 4, onLine = null,
    typoGain = 8, typoMargin = 1.4, pairGain = 5, vowelGain = 9, particleGain = 4, overrideMargin = 3, properGain = 8, properMargin = 2,
} = {}) {
    // 다른 검사가 이미 고친 자리 — 규칙(rule)으로 고친 것은 그대로 두고, 사전(dict)으로 고친 낱말은 언어 모델로 다시 견준다
    const covering = (id, a, b) => base.find(f => f.id === id && f.a < b && a < f.b);
    const cache = new Map();
    const analyze = (t) => { if (!cache.has(t)) cache.set(t, kiwi.analyze(t)); return cache.get(t); };
    const fixes = [];
    let done = 0;
    for (const line of lines) {
        if (onLine) onLine(done++, lines.length);
        const text = line.text;
        const words = wordsOf(text);
        if (!words.some(w => w.lang === 'ko')) continue;
        if (words.some(w => w.lang === 'ko' && ARCHAIC.test(w.core))) continue;   // 성경 구절은 본문 그대로
        const sid = [];
        let n = 0;
        words.forEach((w, i) => { sid[i] = n; if (/[.!?。…]["'”’)]*$/.test(text.slice(w.a, w.b))) n++; });
        const cores = words.map(w => w.core);
        // 이 낱말 둘레(같은 문장 안 앞뒤 몇 낱말)를 바꿔 넣은 글과, 그 글에서 이 낱말이 놓인 자리
        const around = (i, rep) => {
            let lo = i, hi = i;
            while (lo > 0 && sid[lo - 1] === sid[i] && i - lo < window) lo--;
            while (hi + 1 < words.length && sid[hi + 1] === sid[i] && hi - i < window) hi++;
            const w = words[i];
            const head = text.slice(words[lo].a, w.ca);
            return { text: head + rep + text.slice(w.cb, words[hi].b), start: head.length, end: head.length + rep.length, next: hi > i ? words[i + 1].ca - words[lo].a : -1 };
        };
        const scoreOf = (i, rep) => analyze(around(i, rep).text).score;
        // word: 사전에 없는 낱말을 고친 것이면 그 낱말 ('사전에 추가'로 다음부터 잡지 않게 할 수 있다)
        const push = (w, to, why, type, gain, margin, word) => fixes.push({ id: line.id, a: w.ca, b: w.cb, from: w.core, to, type, why, src: 'lm', word,
            gain: +gain.toFixed(2), margin: margin == null ? null : +margin.toFixed(2) });
        // 낱자를 고친 후보 중 문맥에 가장 자연스러운 것 → { c, gain, margin } (후보가 없으면 null)
        const bestEdit = (i, w, res, extra) => {
            const pool = new Set([...koreanCandidates(w.core).keys(), ...jamoEdits(w.core), ...(extra || [])]);
            const cands = [...pool].filter(c => /^[가-힣]+$/.test(c) && dict.spell(c));
            if (!cands.length) return null;
            const ranked = cands.map(c => ({ c, s: scoreOf(i, c) })).sort((x, y) => y.s - x.s);
            return { c: ranked[0].c, s: ranked[0].s, gain: ranked[0].s - res.score, margin: ranked[1] ? ranked[0].s - ranked[1].s : Infinity, ranked };
        };
        words.forEach((w, i) => {
            if (w.lang !== 'ko' || w.core.length < 2 || skip(w.core)) return;
            const prior = covering(line.id, w.ca, w.cb);
            if (prior && (prior.src !== 'dict' || prior.a !== w.ca || prior.b !== w.cb)) return;
            const ctx = around(i, w.core);
            const res = analyze(ctx.text);
            const toks = tokensIn(res.tokens, ctx.start, ctx.end);
            if (prior) {
                // 사전 단계가 고친 낱말: 다른 후보가 문맥에 훨씬 자연스러우면 그것으로 바꾼다
                // (주레 → 주례? 주에? · 세편 → 세 편? 시편?) — 띄어 쓴 후보는 점수가 원래 글과 거의 같다
                const spaced = /\s/.test(prior.to);
                const e = bestEdit(i, w, res, spaced ? [] : [prior.to]);
                if (!e || e.c === prior.to) return;
                const mineScore = spaced ? res.score : (e.ranked.find(r => r.c === prior.to) || {}).s;
                if (mineScore === undefined || e.s - mineScore < overrideMargin || e.gain < typoGain) return;
                push(w, e.c, `${objOf(e.c)} 잘못 친 것으로 보입니다 (문맥으로 판단)`, '맞춤법', e.gain, e.s - mineScore, w.core);
                fixes[fixes.length - 1].replaces = prior;
                return;
            }
            if (!knownKorean(dict, w.core)) {
                if (!toks.length || /^S/.test(toks[0].tag)) return;
                // 사전에 없는 말을 Kiwi가 고유 명사로 보면: 이름 같은 말은 그대로 두고, 아니면(녀무·오널) 더 엄격하게 오타를 찾는다
                const proper = tagOf(toks[0]) === 'NNP';
                if (proper && (nameLike(w.core) || LOAN_SYL.test(w.core))) return;
                // 1) 잘못 친 말이 분명하면 먼저 (누가복은 → 누가복음: '누가 복은'으로 나누지 않는다)
                //    짜임이 문법에 맞지 않거나, 띄어 쓸 곳이 보이거나, 고유 명사로 읽혔을 때 후보를 찾는다
                const bad = illFormed(toks);
                const cutsSeen = !proper && spacingCuts(w.core, toks, ctx.start).length > 0;
                const e = bad || cutsSeen || proper ? bestEdit(i, w, res) : null;
                const needGain = proper ? properGain : typoGain, needMargin = proper ? properMargin : typoMargin;
                if (proper && !(e && e.gain >= needGain && e.margin >= needMargin)) return;
                if (e && e.gain >= needGain && e.margin >= needMargin) {
                    const fixed = around(i, e.c);
                    if (!illFormed(tokensIn(analyze(fixed.text).tokens, fixed.start, fixed.end))) {
                        push(w, e.c, `${objOf(e.c)} 잘못 친 것으로 보입니다`, '맞춤법', e.gain, e.margin === Infinity ? null : e.margin, w.core);
                        return;
                    }
                }
                // 2) 붙여 쓴 말 — Kiwi가 나눈 형태소에 띄어쓰기 규정을 적용하고, 나눈 조각이 모두 사전에 있을 때만
                if (e && e.gain >= typoGain) return;   // 고칠 낱말 후보가 뚜렷하면 나누지 않는다
                const cuts = cutsSeen ? spacingCuts(w.core, toks, ctx.start) : [];
                if (cuts.length) {
                    const pieces = [];
                    let from = 0;
                    for (const c of [...cuts, w.core.length]) { pieces.push(w.core.slice(from, c)); from = c; }
                    const spans = [];
                    let s0 = 0;
                    for (const c of [...cuts, w.core.length]) { spans.push(tokensIn(toks, ctx.start + s0, ctx.start + c)); s0 = c; }
                    if (pieces.every(x => knownKorean(dict, x) && (x.length >= 2 || SAFE_SINGLE.has(x))) && !spans.some(illFormed)) {
                        push(w, pieces.join(' '), '낱말과 낱말 사이는 띄어 씁니다', '띄어쓰기', 0, null);
                        return;
                    }
                }
                return;
            }
            // 사전에 있는 말: 헷갈리는 짝으로 바꿔 보아 문맥에 훨씬 자연스러우면 고친다
            // 바로 뒤 낱말이 이어 주거나 끝맺는 풀이말인가 (승려의 '들고' — '-의' 뒤에 올 수 없다)
            let nextPredicate = false;
            if (words[i + 1] && sid[i + 1] === sid[i] && ctx.next >= 0) {
                const nx = tokensIn(res.tokens, ctx.next, ctx.next + words[i + 1].core.length + 1);
                nextPredicate = nx.length > 0 && /^(VV|VA)$/.test(tagOf(nx[0])) && /^(EC|EF)$/.test(tagOf(nx[nx.length - 1]))
                    && !/^(대해|대한|대하여|대해서|관해|관한|관하여|관해서|의해|의한|위해|위한|따라|따른|비해|비하면|맞서|못지)/.test(words[i + 1].core);
            }
            const options = confusionOptions(w.core, nextPredicate, objectBeforeIn(cores, i, k => sid[k] === sid[i]));
            let best = null;
            for (const o of options) {
                if (!/^[가-힣]+$/.test(o.to) || !dict.spell(o.to)) continue;
                const gain = scoreOf(i, o.to) - res.score;
                const need = o.kind === 'vowel' ? vowelGain : o.kind === 'particle' ? particleGain : pairGain;
                if (gain >= need && (!best || gain - need > best.gain - best.need)) best = { ...o, gain, need };
            }
            if (best) push(w, best.to, best.why || `문맥상 ${subjOf(best.to)} 맞습니다`, '문맥', best.gain, null);
        });
    }
    return fixes;
}

function subjOf(word) { return `'${word}'${hasJong(word[word.length - 1]) ? '이' : '가'}`; }
function objOf(word) { return `'${word}'${hasJong(word[word.length - 1]) ? '을' : '를'}`; }

/** 사전에 있는 말을 헷갈려 쓴 것인지 견주어 볼 후보들 → [{ to, kind, why? }] */
export function confusionOptions(word, nextPredicate, objectBefore = false) {
    const out = [];
    const add = (to, kind, why) => { if (to !== word && !out.some(o => o.to === to)) out.push({ to, kind, why }); };
    for (const c of CONFUSABLES) {
        if (!c.re.test(word)) continue;
        if (c.subj && objectBefore) continue;   // '-을/-를'을 받으면 본디 말이 맞다 (달이 호수를 비춘다)
        for (const [a, b] of c.swap) if (word.startsWith(a)) { add(b + word.slice(a.length), 'pair', c.why); break; }
    }
    for (const [a, b, why] of PAIRS) {
        if (word.startsWith(a)) add(b + word.slice(a.length), 'pair', why);
        if (word.startsWith(b)) add(a + word.slice(b.length), 'pair', why);
    }
    // 조사 '의' 뒤에 바로 풀이말이 오면 '-이/-가' (승려의 들고 있던 → 승려가 들고 있던)
    if (/[가-힣]의$/.test(word) && word.length >= 2 && nextPredicate) {
        const stem = word.slice(0, -1);
        add(stem + (hasJong(stem[stem.length - 1]) ? '이' : '가'), 'particle', "뒤에 오는 풀이말의 주어이므로 '-이/-가'를 씁니다");
    }
    // ㅐ·ㅔ(ㅒ·ㅖ, ㅙ·ㅚ·ㅞ) 한 글자 — 문맥이 아주 분명할 때만
    const syl = [...word].map(partsOf);
    syl.forEach((s, k) => {
        const set = VOWEL_SETS.find(g => g.includes(s[1]));
        if (!set) return;
        for (const v of set) {
            if (v === s[1]) continue;
            const t = syl.map(x => x.slice());
            t[k][1] = v;
            add(t.map(compose).join(''), 'vowel');
        }
    });
    return out;
}
