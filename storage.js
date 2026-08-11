// 글 목록 저장소.
//
// 예전에는 글 전체를 localStorage에 넣었는데, localStorage는 브라우저가 약 5MB로
// 제한한다. 본문에 사진(base64)이 들어가므로 사진 몇 장이면 한도를 넘겨
// "저장 공간이 부족합니다" 오류가 계속 났고, 압축만으로는 언젠가 다시 찬다.
//
// IndexedDB는 한도가 기기 여유 공간에 비례해(보통 수백 MB~수 GB) 훨씬 크므로
// 글 목록은 IndexedDB에 저장한다. IndexedDB를 못 쓰는 환경(사생활 보호 모드 등)에서는
// 예전처럼 localStorage로 자동 대체된다.

const DB_NAME = 'faithLogStorage';
const DB_VERSION = 1;
const STORE = 'kv';
const ENTRIES_KEY = 'entries';
const LEGACY_KEY = 'faithLogDB'; // 예전 localStorage 키 (마이그레이션 대상)

let dbPromise = null;
let idbUnavailable = false;

function openDB() {
    if (idbUnavailable) return Promise.reject(new Error('IndexedDB unavailable'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            idbUnavailable = true;
            reject(e);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { idbUnavailable = true; reject(req.error); };
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
    }).catch(err => {
        dbPromise = null; // 다음 시도에서 다시 열어볼 수 있도록
        idbUnavailable = true;
        throw err;
    });
    return dbPromise;
}

function idbGet(key) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }));
}

function idbSet(key, value) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

function idbDelete(key) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    }));
}

// 저장은 자동저장·동기화 등 여러 곳에서 자주 호출된다. 매번 쓰지 않고
// '마지막 내용'만 남겨 한 번에 쓰도록 묶는다(쓰기 순서 보장 + 불필요한 쓰기 제거).
let pendingEntries = null;
let writeInFlight = null;

function flushWrite() {
    if (writeInFlight || pendingEntries === null) return writeInFlight || Promise.resolve(true);
    const payload = pendingEntries;
    pendingEntries = null;
    writeInFlight = idbSet(ENTRIES_KEY, payload)
        .catch(err => {
            console.error('IndexedDB 저장 실패, localStorage로 대체 시도:', err);
            return legacySave(payload);
        })
        .then(ok => {
            writeInFlight = null;
            if (pendingEntries !== null) return flushWrite(); // 쓰는 동안 들어온 최신 내용 반영
            return ok;
        });
    return writeInFlight;
}

function legacySave(entries) {
    try {
        localStorage.setItem(LEGACY_KEY, JSON.stringify(entries));
        return true;
    } catch (e) {
        console.error('로컬 저장 실패:', e);
        return false;
    }
}

// 두 글 목록을 id 기준으로 합치되, 같은 id는 수정시각이 더 최신인 쪽을 남긴다.
// (IndexedDB 본과 localStorage 폴백본 중 어느 쪽이 최신인지 알 수 없을 때 사용)
function mergeByModifiedAt(primary, secondary) {
    const tOf = (e) => new Date((e && (e.modifiedAt || e.timestamp)) || 0).getTime() || 0;
    const byId = new Map();
    let changed = false;
    for (const e of primary) { if (e && e.id != null) byId.set(e.id, e); }
    for (const e of secondary) {
        if (!e || e.id == null) continue;
        const cur = byId.get(e.id);
        if (!cur) { byId.set(e.id, e); changed = true; }
        else if (tOf(e) > tOf(cur)) { byId.set(e.id, e); changed = true; }
    }
    return { list: Array.from(byId.values()), changed };
}

export function isQuotaError(e) {
    if (!e) return false;
    return e.name === 'QuotaExceededError'
        || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || e.code === 22 || e.code === 1014;
}

/**
 * 글 목록을 저장한다. 호출한 쪽이 기다리지 않아도 되도록 즉시 예약하고,
 * 실제 쓰기는 묶어서 처리한다. 반환된 Promise로 완료를 기다릴 수도 있다.
 */
export function saveEntries(entries) {
    // 저장 시점의 값을 그대로 보관 (이후 배열이 바뀌어도 저장 내용이 흔들리지 않도록 얕은 복사)
    pendingEntries = Array.isArray(entries) ? entries.slice() : [];
    if (idbUnavailable) {
        const ok = legacySave(pendingEntries);
        pendingEntries = null;
        return Promise.resolve(ok);
    }
    return flushWrite();
}

/** 대기 중인 저장을 즉시 마무리 (화면 이탈 직전 등) */
export function flushEntries() {
    return flushWrite();
}

/**
 * 글 목록을 불러온다.
 * 예전 localStorage에 남아 있던 데이터는 IndexedDB로 옮기고 localStorage에서 지운다
 * (이때 꽉 찼던 localStorage 공간도 함께 회수된다).
 */
export async function loadEntries() {
    let legacyRaw = null;
    try { legacyRaw = localStorage.getItem(LEGACY_KEY); } catch (e) { /* 접근 불가 시 무시 */ }

    // 예전 키를 안전하게 배열로 해석한다. 해석에 실패하면 null을 돌려
    // '데이터 없음'과 '해석 불가'를 구분한다(해석 불가일 때 원본을 지우면 복구가 불가능해진다).
    const parseLegacy = () => {
        if (legacyRaw === null) return null;
        try {
            const v = JSON.parse(legacyRaw);
            return Array.isArray(v) ? v : null;
        } catch (e) {
            console.error('기존 데이터 해석 실패(원본은 보존합니다):', e);
            return null;
        }
    };

    try {
        const stored = await idbGet(ENTRIES_KEY);
        if (Array.isArray(stored)) {
            // LEGACY_KEY는 마이그레이션 원본일 뿐 아니라, IndexedDB를 못 쓰던 세션의 '폴백 최신본'이기도 하다.
            // 비교 없이 지우면 그 세션에 쓴 글이 사라지므로, 항목별 수정시각으로 병합한 뒤에만 정리한다.
            const legacy = parseLegacy();
            if (legacy === null) {
                // 해석할 수 없는 값이면 건드리지 않고 남겨 둔다 (수동 복구 여지 보존)
                return stored;
            }
            const merged = mergeByModifiedAt(stored, legacy);
            if (merged.changed) {
                await idbSet(ENTRIES_KEY, merged.list);
                console.info(`폴백 저장본을 병합했습니다 (총 ${merged.list.length}건).`);
            }
            try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
            return merged.list;
        }
        // IndexedDB가 비어 있고 예전 데이터가 있으면 옮긴다 (최초 1회 마이그레이션)
        const legacy = parseLegacy();
        if (legacy !== null) {
            await idbSet(ENTRIES_KEY, legacy);
            // 옮기기에 성공한 뒤에만 지워서, 실패 시 원본이 사라지지 않게 한다.
            try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
            console.info(`저장소 이전 완료: 글 ${legacy.length}건을 IndexedDB로 옮겼습니다.`);
            return legacy;
        }
        return [];
    } catch (err) {
        // IndexedDB를 쓸 수 없는 환경: 예전 방식 그대로 동작
        console.error('IndexedDB 사용 불가, localStorage로 동작합니다:', err);
        idbUnavailable = true;
        if (legacyRaw !== null) {
            try { return JSON.parse(legacyRaw) || []; } catch (e) { return []; }
        }
        return [];
    }
}

/** 로그아웃/초기화 시 저장된 글을 지운다 */
export async function clearEntries() {
    pendingEntries = null;
    try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
    try { await idbDelete(ENTRIES_KEY); } catch (e) { console.error('저장소 초기화 실패:', e); }
}

/** 현재 사용량/한도 (설정 화면 등에서 안내용) */
export async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const { usage, quota } = await navigator.storage.estimate();
            return { usage: usage || 0, quota: quota || 0 };
        } catch (e) { /* 무시 */ }
    }
    return null;
}
