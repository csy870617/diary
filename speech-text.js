/**
 * 소리 내어 읽기 전에 글을 '읽는 그대로'의 한국어로 바꾼다.
 *
 * 음성 엔진(기기 음성·자연음 모두)은 기호가 섞인 표기를 엉뚱하게 읽는다.
 * 받아쓰기로 확인한 예 (자연음, 고치기 전):
 *   요한복음 3:16      → "요한복음 3.6"            (시각처럼, 또는 숫자가 뭉개짐)
 *   고린도전서 13:4~7  → "고린도전서 1337"
 *   마 5:3 심령이      → "마 오 삼십령이"
 *   2026.10.9          → "2020 신 구"              (마침표마다 문장이 끊김)
 *   1,200,000원        → "2,200천원"
 *   1.5배              → "일 다섯 배"
 *   85%                → "85"                       (기호를 지워 '퍼센트'가 빠짐)
 * 반면 "8장 28절", "2026년 10월 9일", "오전 10시 30분"처럼 풀어 쓴 표기는 정확히 읽는다.
 * 그래서 기호 표기를 그 풀어 쓴 꼴로 바꿔 준다.
 *
 * 이 파일은 화면(DOM)과 상관없는 순수 함수만 둔다 (Node에서 그대로 시험할 수 있게).
 */

const DIGITS = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

/** 한자어 수: 1200000 → "백이십만", 2026 → "이천이십육", 0 → "영" */
export function sinoNumber(n) {
    if (typeof n === 'string') n = n.replace(/,/g, '');
    let v = Number(n);
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return String(n);
    if (v === 0) return '영';
    if (v >= 1e16) return String(n);              // 경(京) 이상은 쓰일 일이 없다 — 그대로 둔다
    const units = ['', '만', '억', '조'];
    const group = (g) => {                        // 0~9999
        const parts = [];
        const place = [['천', 1000], ['백', 100], ['십', 10]];
        for (const [name, p] of place) {
            const d = Math.floor(g / p) % 10;
            if (d) parts.push((d === 1 ? '' : DIGITS[d]) + name);   // 일천·일백·일십 → 천·백·십
        }
        const one = g % 10;
        if (one) parts.push(DIGITS[one]);
        return parts.join('');
    };
    const out = [];
    for (let u = 0; v > 0; u++, v = Math.floor(v / 10000)) {
        const g = v % 10000;
        if (!g) continue;
        // 만 앞의 '일'은 읽지 않는다 (10000 → "만"), 억·조 앞의 '일'은 읽는다 (일억)
        const word = (g === 1 && u === 1) ? '' : group(g);
        out.unshift(word + units[u]);
    }
    return out.join('');
}

/** 고유어 수(1~99): 세는 말 앞에서 쓰는 꼴(한·두·세·네·스무)로 */
export function nativeNumber(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 99) return null;
    const tens = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
    const ones = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
    if (v === 20) return '스무';
    return tens[Math.floor(v / 10)] + ones[v % 10];
}

/** 소수: 1.5 → "일 점 오", 3.14 → "삼 점 일사" (소수 아래는 한 자씩) */
export function sinoDecimal(intPart, fracPart) {
    return sinoNumber(intPart) + ' 점 ' + String(fracPart).split('').map(d => DIGITS[+d]).join('');
}

/** 달 이름: 6월 → 유월, 10월 → 시월 */
function monthName(m) {
    const v = Number(m);
    if (v === 6) return '유월';
    if (v === 10) return '시월';
    return sinoNumber(v) + '월';
}

// ─── 성경 ───────────────────────────────────────────────────────
// 줄임말(개역개정 표기) → 책 이름. 시편은 '장' 대신 '편'으로 센다.
const BOOK_ABBR = {
    창: '창세기', 출: '출애굽기', 레: '레위기', 민: '민수기', 신: '신명기', 수: '여호수아', 삿: '사사기', 룻: '룻기',
    삼상: '사무엘상', 삼하: '사무엘하', 왕상: '열왕기상', 왕하: '열왕기하', 대상: '역대상', 대하: '역대하',
    스: '에스라', 느: '느헤미야', 에: '에스더', 욥: '욥기', 시: '시편', 잠: '잠언', 전: '전도서', 아: '아가',
    사: '이사야', 렘: '예레미야', 애: '예레미야애가', 겔: '에스겔', 단: '다니엘', 호: '호세아', 욜: '요엘',
    암: '아모스', 옵: '오바댜', 욘: '요나', 미: '미가', 나: '나훔', 합: '하박국', 습: '스바냐', 학: '학개',
    슥: '스가랴', 말: '말라기',
    마: '마태복음', 막: '마가복음', 눅: '누가복음', 요: '요한복음', 행: '사도행전', 롬: '로마서',
    고전: '고린도전서', 고후: '고린도후서', 갈: '갈라디아서', 엡: '에베소서', 빌: '빌립보서', 골: '골로새서',
    살전: '데살로니가전서', 살후: '데살로니가후서', 딤전: '디모데전서', 딤후: '디모데후서', 딛: '디도서',
    몬: '빌레몬서', 히: '히브리서', 약: '야고보서', 벧전: '베드로전서', 벧후: '베드로후서',
    요일: '요한일서', 요이: '요한이서', 요삼: '요한삼서', 유: '유다서', 계: '요한계시록'
};
const BOOK_FULL = [...new Set(Object.values(BOOK_ABBR))];
// 긴 이름부터 맞춰야 '요한복음'이 '요'로, '사무엘상'이 '사'로 잘못 잡히지 않는다
const BOOK_ALT = [...BOOK_FULL, ...Object.keys(BOOK_ABBR)].sort((a, b) => b.length - a.length)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

// 책 이름 + 장:절 (+ 범위). 책 이름 앞은 글자가 아니어야 한다 ('필요 3:16'의 '요'를 잡지 않게)
const VERSE_RE = new RegExp(
    '(^|[^가-힣A-Za-z])(' + BOOK_ALT + ')\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3})' +
    '(?:\\s*[-~–—]\\s*(\\d{1,3})(?:\\s*[:：]\\s*(\\d{1,3}))?)?', 'g');

// 한 글자 줄임말 가운데 평소 낱말로도 흔해 바로 뒤에 시각이 올 수 있는 것
// ('약 3:00' 약 세 시, '수 7:30' 수요일, '나 7:00에', '전 7:00에', '막 7:00 넘어')
const TIME_WORDS = new Set(['약', '수', '나', '전', '막']);

function readVerse(m, pre, book, ch, v1, v2, v3) {
    // 이런 말 뒤의 'H:00'·'H:30'은 시각으로 본다 (절 번호가 0이거나 30인 경우보다 훨씬 흔하다)
    if (TIME_WORDS.has(book) && !v2 && /^(00|30)$/.test(v1) && +ch <= 24) return m;
    const name = BOOK_ABBR[book] || book;
    const chap = name === '시편' ? '편' : '장';
    let s = `${pre}${name} ${ch}${chap} ${v1}절`;
    if (v2 && v3) s += `에서 ${v2}${chap} ${v3}절`;     // 3:16-4:2
    else if (v2) s += `에서 ${v2}절`;                    // 3:16-18
    return s;
}

// ─── 바꾸기 ─────────────────────────────────────────────────────
/**
 * 기호 표기를 풀어 쓴다. 기호가 남지 않게 해야 뒤에서 문장부호 정리(cleanForSpeech)가
 * 뜻을 지우지 않는다 (예: % 를 지워 '퍼센트'가 빠지던 문제).
 */
export function normalizeForSpeech(input) {
    if (!input) return '';
    let t = String(input);

    // 1) 성경 구절: 요한복음 3:16 → 요한복음 3장 16절, 시 23:1 → 시편 23편 1절
    t = t.replace(VERSE_RE, readVerse);
    // 장·절 범위: 28-30절 → 28절에서 30절, 3~4장 → 3장에서 4장
    t = t.replace(/(\d{1,3})\s*[-~–—]\s*(\d{1,3})\s*(절|장|편)/g, '$1$3에서 $2$3');

    // 2) 날짜: 2026.10.9 / 2026-10-09 / 2026/10/9 (뒤 점 포함) → 2026년 시월 9일
    t = t.replace(/(^|[^\d])(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?:\s*\.)?(?!\d)/g, (m, pre, y, mo, d) => {
        if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return m;
        return `${pre}${sinoNumber(y)}년 ${monthName(mo)} ${sinoNumber(d)}일`;
    });
    // 해와 달만: 2026.10 → 2026년 시월 (소수로 읽지 않게)
    t = t.replace(/(^|[^\d.])((?:19|20)\d{2})\.(0?[1-9]|1[0-2])(?![\d]|\.\d)/g,
        (m, pre, y, mo) => `${pre}${sinoNumber(y)}년 ${monthName(mo)}`);
    // '6월'·'10월'은 유월·시월로 읽는다
    t = t.replace(/(^|[^\d])(6|06|10)\s*월/g, (m, pre, mo) => `${pre}${monthName(mo)}`);

    // 3) 시각: 10:30 → 10시 30분, 11:00 → 11시 (구절이 아닌 남은 'H:MM')
    t = t.replace(/(^|[^\d:])(\d{1,2}):(\d{2})(?![\d:])/g, (m, pre, h, mm) => {
        if (+h > 24 || +mm > 59) return m;
        return `${pre}${+h}시` + (+mm ? ` ${+mm}분` : '');
    });

    // 4) 백분율: 85% → 85퍼센트, 2.5% → 이 점 오 퍼센트
    t = t.replace(/(\d+(?:\.\d+)?)\s*[%％]/g, '$1퍼센트');

    // 5) 소수: 1.5 → 일 점 오 (날짜·시각을 바꾼 뒤라 남은 것은 소수다)
    t = t.replace(/(^|[^\d.])(\d+)\.(\d+)(?![\d.])/g, (m, pre, a, b) => `${pre}${sinoDecimal(a, b)}`);

    // 6) 자리 구분 쉼표가 있는 큰 수: 1,200,000원 → 백이십만원
    t = t.replace(/(^|[^\d,])(\d{1,3}(?:,\d{3})+)(?![\d,])/g, (m, pre, num) => `${pre}${sinoNumber(num)}`);
    // 쉼표 없이 쓴 큰 수(만 이상)도 단위가 붙어 있으면 한자어로: 1200000원 → 백이십만원
    // (0으로 시작하거나 단위 없이 홀로 있는 긴 숫자는 전화·계좌·번호일 수 있어 그대로 둔다)
    t = t.replace(/(^|[^\d])([1-9]\d{4,15})(?=[가-힣])/g, (m, pre, num) => `${pre}${sinoNumber(num)}`);

    // 7) 숫자 범위: 3~4명 → 세 명에서 네 명, 3~4 → 3에서 4 (구절·장절 범위는 위에서 처리됨)
    t = t.replace(NATIVE_RANGE_RE, (m, pre, a, b, unit) => {
        const x = nativeNumber(a), y = nativeNumber(b);
        return x && y ? `${pre}${x} ${unit}에서 ${y} ${unit}` : m;
    });
    t = t.replace(/(\d)\s*~\s*(\d)/g, '$1에서 $2');

    // 8) 고유어로 세는 말: 3명 → 세 명, 20살 → 스무 살, 7시 → 일곱 시, 1번째 → 첫 번째
    //    (모델이 숫자를 문맥에 따라 읽긴 하지만 '20명'을 '이십 명'으로 읽는 등 들쭉날쭉해서 풀어 준다)
    t = t.replace(NATIVE_COUNTER_RE, (m, pre, num, unit) => {
        const word = (+num === 1 && unit === '번째') ? '첫' : nativeNumber(num);
        return word ? `${pre}${word} ${unit}` : m;
    });

    return t;
}

// 고유어 수와 함께 쓰는 단위. 한자어로 읽는 꼴(3개월·3개국·3달러·3번지·시즌)은 뺀다.
// 숫자 앞이 '제'(제3장)이거나 소수·자리 구분·시각의 일부이면 건드리지 않는다.
const NATIVE_UNIT = '(명|사람|개(?![월국년소])|시간|시(?!즌|리즈)|살|번째|번(?!지)|마리|권|잔|곳|가지|달(?!러)|군데|송이|그릇|켤레|바퀴)';
const NATIVE_COUNTER_RE = new RegExp('(^|[^\\d.,:제])(\\d{1,2})\\s*' + NATIVE_UNIT, 'g');
const NATIVE_RANGE_RE = new RegExp('(^|[^\\d.,:제])(\\d{1,2})\\s*[~-]\\s*(\\d{1,2})\\s*' + NATIVE_UNIT, 'g');

/**
 * 문장을 나눌 때 끊으면 안 되는 자리 표시(1 = 이 자리의 . , : 에서 끊지 않는다).
 * 숫자 사이의 부호(1.5, 1,200, 3:16)와 날짜(2026. 10. 9.)의 안쪽 점이 그렇다.
 * 끊어 버리면 조각마다 따로 읽혀 '2026.' '10.' '9'처럼 뜻이 깨진다.
 * 줄 머리의 목록 번호(1. 감사)도 번호만 따로 떼어 읽지 않도록 뒤의 글과 함께 둔다.
 */
export function noBreakMask(text) {
    const mask = new Uint8Array(text.length);
    for (let i = 1; i < text.length - 1; i++) {
        if ('.,:：'.includes(text[i]) && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) mask[i] = 1;
    }
    for (const m of text.matchAll(/\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}/g)) {
        for (let k = m.index; k < m.index + m[0].length; k++) if (text[k] === '.') mask[k] = 1;
    }
    for (const m of text.matchAll(/(^|\n)[ \t]*\d{1,2}\.(?=[ \t]+\S)/g)) mask[m.index + m[0].length - 1] = 1;
    return mask;
}
