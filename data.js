import { state } from './state.js';
import { renderEntries, renderTrash } from './ui.js';
import { saveToDrive } from './drive.js';

function safeLocalSave() {
    try {
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        return true;
    } catch(e) {
        console.error("로컬 저장 실패:", e);
        if (e.name === 'QuotaExceededError') {
            alert("저장 공간이 부족합니다. 휴지통을 비우거나 오래된 항목을 삭제해주세요.");
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
    const body = bodyEl.innerHTML; 
    const subtitle = subtitleEl ? subtitleEl.value : '';
    const nowISO = new Date().toISOString(); 

    if(!title.trim() && !bodyEl.innerText.trim()) return;

    if (!state.editingId) state.editingId = Date.now().toString();
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
    renderEntries();
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
    const trashItems = state.entries.filter(e => e.isDeleted && !e.isPurged);
    if(trashItems.length === 0) return alert("휴지통이 이미 비어있습니다.");
    if(confirm(`휴지통의 ${trashItems.length}개 항목을 모두 영구 삭제하시겠습니까?`)) {
        const now = new Date().toISOString();
        trashItems.forEach(e => { e.isPurged = true; e.modifiedAt = now; });
        safeLocalSave();
        renderTrash();
        await saveToDrive();
    }
}

export async function checkOldTrash() {
    const now = new Date();
    let changed = false;
    state.entries.forEach(e => {
        if(e.isDeleted && !e.isPurged) {
            const trashDate = new Date(e.modifiedAt || e.timestamp);
            if((now - trashDate) / (1000 * 60 * 60 * 24) > 30) {
                e.isPurged = true; e.modifiedAt = now.toISOString(); changed = true;
            }
        }
    });
    if(changed) {
        safeLocalSave();
        await saveToDrive();
    }
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
        ...original, id: Date.now().toString(),
        title: original.title + " (복사본)",
        timestamp: nowISO, modifiedAt: nowISO, isDeleted: false, isPurged: false
    };
    state.entries.unshift(newEntry);
    safeLocalSave();
    renderEntries();
    await saveToDrive();
}