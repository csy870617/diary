import { state, saveCategoriesToLocal } from './state.js';
import { renderEntries, renderTrash, renderFolders, renderTabs } from './ui.js';
import { saveToDrive } from './drive.js';
import { getCleanBodyHtml } from './editor.js';

// 같은 밀리초에 여러 번 호출돼도 충돌하지 않도록 임의 접미사를 붙인 ID 생성
// (drive.js의 동기화 충돌 사본 생성에서도 같은 규칙을 쓰도록 export)
export function genEntryId() {
    return Date.now().toString() + '_' + Math.random().toString(36).slice(2, 7);
}

// 같은 알림이 자동저장마다 반복해서 뜨지 않도록 한 번만 안내한다.
let quotaAlertShown = false;

function safeLocalSave() {
    try {
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        quotaAlertShown = false;
        return true;
    } catch(e) {
        console.error("로컬 저장 실패:", e);
        // 브라우저마다 이름이 달라(QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED, code 22)
        // 이름만 보면 용량 초과를 놓치는 경우가 있어 code까지 함께 확인한다.
        const isQuota = e.name === 'QuotaExceededError'
            || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
            || e.code === 22 || e.code === 1014;
        if (isQuota && !quotaAlertShown) {
            quotaAlertShown = true;
            alert("이 기기의 저장 공간이 가득 찼습니다.\n\n" +
                  "글은 구글 드라이브에 계속 저장되니 내용이 사라지지는 않습니다.\n" +
                  "공간을 늘리려면 휴지통을 비우거나, 사진이 많은 오래된 글을 정리해 주세요.\n" +
                  "(사진 한 장이 글 수백 개보다 많은 공간을 차지합니다)");
        }
        return false;
    }
}

export function loadDataFromLocal() {
    const localData = localStorage.getItem('faithLogDB');
    if(localData) {
        try {
            state.entries = JSON.parse(localData);
        } catch(e) {
            console.error("로컬 데이터 파싱 실패:", e);
            state.entries = [];
        }
    }
}

export async function saveEntry() {
    const titleEl = document.getElementById('edit-title');
    const bodyEl = document.getElementById('editor-body');
    const subtitleEl = document.getElementById('edit-subtitle');
    
    if(!titleEl || !bodyEl) return;
    
    const title = titleEl.value;
    // 책 모드에서 입혀진 임시 크기(data-book-*)가 원본을 덮어쓰지 않도록 정리 후 저장
    const body = getCleanBodyHtml(bodyEl);
    const subtitle = subtitleEl ? subtitleEl.value : '';
    const nowISO = new Date().toISOString(); 

    // 이미지·표·스티커만 있는 글도 저장되도록 텍스트 외 콘텐츠 존재 여부도 확인 (소제목만 있어도 저장)
    if(!(title || '').trim() && !(subtitle || '').trim() && !bodyEl.innerText.trim() && !bodyEl.querySelector('img, table')) return;

    if (!state.editingId) state.editingId = genEntryId();
    const index = state.entries.findIndex(e => e.id === state.editingId);

    // 핵심 수정: 현재 에디터에 적용된 폰트 정보를 metadata로 명확히 저장
    if(index === -1) {
        const newEntry = {
            id: state.editingId,
            title: title || '제목 없음',
            subtitle: subtitle,
            body: body,
            date: new Date().toLocaleDateString('ko-KR'),
            timestamp: nowISO,
            modifiedAt: nowISO,
            category: state.currentCategory,
            isDeleted: false,
            isPurged: false,
            fontFamily: state.currentFontFamily,
            fontSize: state.currentFontSize
        };
        state.entries.unshift(newEntry);
    } else {
        const old = state.entries[index];
        state.entries[index] = {
            ...old,
            title, subtitle, body,
            modifiedAt: nowISO, 
            fontFamily: state.currentFontFamily,
            fontSize: state.currentFontSize
        };
    }
    
    safeLocalSave();
    // 글쓰기 화면이 열려 있는 동안에는 뒤의 목록을 다시 그리지 않는다 (보이지 않으며, 매 자동저장마다
    // 전체 목록을 재생성하면 타이핑이 끊김 → 목록은 닫을 때 closeAllModals에서 갱신됨)
    const writeModal = document.getElementById('write-modal');
    if (!writeModal || writeModal.classList.contains('hidden')) renderEntries();
}

export async function saveData() {
    safeLocalSave();
    await saveToDrive();
}

export async function updateEntryField(id, fields) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        Object.assign(entry, fields);
        entry.modifiedAt = new Date().toISOString();
        safeLocalSave();
        renderEntries();
        renderTrash();
        await saveToDrive();
    }
}

export async function moveToTrash(id) {
    if(confirm('휴지통으로 이동하시겠습니까?')) {
        const entry = state.entries.find(e => e.id === id);
        if(entry) {
            entry.isDeleted = true;
            entry.modifiedAt = new Date().toISOString();
            safeLocalSave();
            renderEntries();
            await saveToDrive();
        }
    }
}

export async function restoreEntry(id) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        entry.isDeleted = false;
        entry.modifiedAt = new Date().toISOString();
        safeLocalSave();
        renderTrash();
        renderEntries();
        await saveToDrive();
    }
}

export async function permanentDelete(id) {
    if(confirm('영구 삭제하시겠습니까? 되돌릴 수 없습니다.')) {
        const index = state.entries.findIndex(e => e.id === id);
        if(index !== -1) {
            state.entries[index].isPurged = true;
            state.entries[index].modifiedAt = new Date().toISOString();
            safeLocalSave();
            renderTrash();
            await saveToDrive();
        }
    }
}

export async function emptyTrash() {
    const trashEntries = state.entries.filter(e => e.isDeleted && !e.isPurged);
    const trashFolders = state.allFolders.filter(f => f.isDeleted);
    const trashCats = state.allCategories.filter(c => c.isDeleted);
    const total = trashEntries.length + trashFolders.length + trashCats.length;
    if (total === 0) return alert("휴지통이 이미 비어있습니다.");
    if (!confirm(`휴지통의 ${total}개 항목을 모두 영구 삭제하시겠습니까?`)) return;

    const now = new Date().toISOString();
    trashEntries.forEach(e => { e.isPurged = true; e.modifiedAt = now; });

    const deletedFolderIds = new Set(trashFolders.map(f => f.id));
    if (deletedFolderIds.size > 0) {
        state.allFolders.forEach(f => { if (f.parentFolderId && deletedFolderIds.has(f.parentFolderId)) delete f.parentFolderId; });
        state.allCategories.forEach(c => { if (c.folderId && deletedFolderIds.has(c.folderId)) delete c.folderId; });
        state.allFolders = state.allFolders.filter(f => !f.isDeleted);
        state.folderOrder = state.folderOrder.filter(id => !deletedFolderIds.has(id));
        state.rootOrder = (state.rootOrder || []).filter(id => !deletedFolderIds.has(id));
    }

    const deletedCatIds = new Set(trashCats.map(c => c.id));
    if (deletedCatIds.size > 0) {
        const remaining = state.allCategories.find(c => !c.isDeleted && !deletedCatIds.has(c.id));
        if (remaining) state.entries.forEach(e => { if (deletedCatIds.has(e.category)) e.category = remaining.id; });
        state.allCategories = state.allCategories.filter(c => !c.isDeleted);
        state.categoryOrder = state.categoryOrder.filter(id => !deletedCatIds.has(id));
        state.rootOrder = (state.rootOrder || []).filter(id => !deletedCatIds.has(id));
    }

    if (deletedFolderIds.size > 0 || deletedCatIds.size > 0) {
        state.categoryUpdatedAt = now;
        saveCategoriesToLocal();
    }
    safeLocalSave();
    renderTrash(); renderFolders(); renderTabs(); renderEntries();
    await saveToDrive();
}

export async function checkOldTrash() {
    const now = new Date();
    const cutoff = (ts) => (now - new Date(ts)) / (1000 * 60 * 60 * 24) > 30;
    let entryChanged = false, metaChanged = false;

    state.entries.forEach(e => {
        if(e.isDeleted && !e.isPurged && cutoff(e.modifiedAt || e.timestamp)) {
            e.isPurged = true; e.modifiedAt = now.toISOString(); entryChanged = true;
        }
    });

    const oldFolderIds = new Set();
    state.allFolders.forEach(f => { if (f.isDeleted && f.deletedAt && cutoff(f.deletedAt)) oldFolderIds.add(f.id); });
    if (oldFolderIds.size > 0) {
        state.allFolders.forEach(f => { if (f.parentFolderId && oldFolderIds.has(f.parentFolderId)) delete f.parentFolderId; });
        state.allCategories.forEach(c => { if (c.folderId && oldFolderIds.has(c.folderId)) delete c.folderId; });
        state.allFolders = state.allFolders.filter(f => !oldFolderIds.has(f.id));
        state.folderOrder = state.folderOrder.filter(id => !oldFolderIds.has(id));
        state.rootOrder = (state.rootOrder || []).filter(id => !oldFolderIds.has(id));
        metaChanged = true;
    }

    const oldCatIds = new Set();
    state.allCategories.forEach(c => { if (c.isDeleted && c.deletedAt && cutoff(c.deletedAt)) oldCatIds.add(c.id); });
    if (oldCatIds.size > 0) {
        const remaining = state.allCategories.find(c => !c.isDeleted && !oldCatIds.has(c.id));
        if (remaining) state.entries.forEach(e => { if (oldCatIds.has(e.category)) { e.category = remaining.id; entryChanged = true; } });
        state.allCategories = state.allCategories.filter(c => !oldCatIds.has(c.id));
        state.categoryOrder = state.categoryOrder.filter(id => !oldCatIds.has(id));
        state.rootOrder = (state.rootOrder || []).filter(id => !oldCatIds.has(id));
        metaChanged = true;
    }

    if (metaChanged) { state.categoryUpdatedAt = now.toISOString(); saveCategoriesToLocal(); }
    if (entryChanged) safeLocalSave();
    if (entryChanged || metaChanged) await saveToDrive();
}

export async function bulkUpdateEntryField(ids, fields) {
    const now = new Date().toISOString();
    let changed = false;
    ids.forEach(id => {
        const entry = state.entries.find(e => e.id === id);
        if (entry) {
            Object.assign(entry, fields);
            entry.modifiedAt = now;
            changed = true;
        }
    });
    if (changed) {
        safeLocalSave();
        renderEntries();
        renderTrash();
        await saveToDrive();
    }
}

export async function duplicateEntry(id) {
    const original = state.entries.find(e => e.id === id);
    if (!original) return;
    const nowISO = new Date().toISOString();
    const newEntry = {
        ...original, id: genEntryId(),
        title: original.title + " (복사본)",
        timestamp: nowISO, modifiedAt: nowISO, isDeleted: false, isPurged: false
    };
    state.entries.unshift(newEntry);
    safeLocalSave();
    renderEntries();
    await saveToDrive();
}