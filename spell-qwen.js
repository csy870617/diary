/**
 * AI 정밀 검사 — Qwen3.5-0.8B 언어 모델로 고칠 후보를 다시 견준다.
 *
 * Kiwi 정밀 검사(spell-lm.js)는 확신하지 못한 후보(pending)와 자기가 고친 것(win이 붙은 고침)을 넘긴다.
 * 여기서는 원래 문장과 후보 문장의 자연스러움(로그 확률 차이, q)을 보고
 *  - 후보가 원래보다 addMargin(철자 후보는 spellMargin) 이상 자연스러우면 고친다 (src: 'ai')
 *  - Kiwi가 고친 것인데 원래 문장이 vetoMargin 이상 자연스러우면 거둬들인다 (withdraw)
 * 점수 계산(모델 실행)은 spell-qwen-worker.js가, 고르는 일은 여기서 한다. DOM을 쓰지 않는다 (Node 시험에서도 같은 함수를 쓴다).
 */

function hasJong(ch) {
    const c = ch.charCodeAt(0) - 0xAC00;
    return c >= 0 && c < 11172 && c % 28 !== 0;
}
const objOf = (w) => `'${w}'${hasJong(w[w.length - 1]) ? '을' : '를'}`;
const subjOf = (w) => `'${w}'${hasJong(w[w.length - 1]) ? '이' : '가'}`;

/**
 * 견줄 문장 묶음 → [{ key, texts: [원래, 후보1, …] }]
 * pending: Kiwi가 넘긴 후보 [{ id, a, b, from, orig, options: [{ to, text }], why, type, word }]
 * lm: Kiwi 정밀 검사 결과 (win: { orig, text }가 붙은 것만 다시 본다)
 */
export function qwenRequests(pending, lm) {
    const reqs = [];
    pending.forEach((p, k) => reqs.push({ key: 'p' + k, texts: [p.orig, ...p.options.map(o => o.text)] }));
    lm.forEach((f, k) => { if (f.win && !f.withdraw) reqs.push({ key: 'v' + k, texts: [f.win.orig, f.win.text] }); });
    return reqs;
}

/**
 * 점수로 고르기 → AI 결과 [{ … src: 'ai' } | { withdraw: true, replaces }]
 * scores: { key: [원래 점수, 후보1 점수, …] } (로그 확률 합)
 * base: 기본 검사 결과 (그 자리에는 새로 고치지 않는다)
 * 기준값(로그 확률 차이)은 일부러 틀린 글과 바른 글로 맞췄다 (붙여 쓰기·헷갈리는 말은 3에서 틀린 것이 거의 없었다)
 */
export function qwenDecide(pending, lm, base, scores, { addMargin = 3, spellMargin = 7, vetoMargin = 5 } = {}) {
    const out = [];
    const vetoed = new Set();
    lm.forEach((f, k) => {
        const s = scores['v' + k];
        if (!s || f.withdraw) return;
        if (s[0] - s[1] >= vetoMargin) { vetoed.add(f); out.push({ id: f.id, a: f.a, b: f.b, from: f.from, withdraw: true, replaces: f, src: 'ai' }); }
    });
    const taken = [...base, ...lm.filter(f => !f.withdraw && !vetoed.has(f))];
    const added = [];
    pending.forEach((p, k) => {
        const s = scores['p' + k];
        if (!s) return;
        // 사전에 없는 말의 철자 후보는 흔한 말 쪽으로 기울기 쉬워 더 큰 차이를 바란다
        const need = p.type === '맞춤법' ? spellMargin : addMargin;
        let best = -1;
        p.options.forEach((o, i) => { if (s[i + 1] - s[0] >= need && (best < 0 || s[i + 1] > s[best + 1])) best = i; });
        if (best < 0) return;
        if ([...taken, ...added].some(f => f.id === p.id && !f.withdraw && f.a < p.b && p.a < f.b)) return;
        const to = p.options[best].to;
        const why = p.why || (p.type === '띄어쓰기' ? '한 낱말이라 붙여 씁니다' : p.type === '문맥' ? `문맥상 ${subjOf(to)} 맞습니다` : `${objOf(to)} 잘못 친 것으로 보입니다`);
        const fix = { id: p.id, a: p.a, b: p.b, from: p.from, to, type: p.type, why: why + ' (AI 판단)', src: 'ai', word: p.word || undefined,
            gain: +(s[best + 1] - s[0]).toFixed(2) };
        added.push(fix);
        out.push(fix);
    });
    return out;
}
