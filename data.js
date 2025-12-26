import { state } from './state.js';
import { renderEntries, renderTrash } from './ui.js';
import { saveToDrive, syncFromDrive } from './drive.js';

export function loadDataFromLocal() {
    const localData = localStorage.getItem('faithLogDB');
    if(localData) {
        state.entries = JSON.parse(localData);
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
    
    const currentFont = state.currentFontFamily || 'Pretendard';
    const currentSize = state.currentFontSize || 16;
    
    if(!title.trim() && !bodyEl.innerText.trim()) return;

    if (!state.editingId) state.editingId = Date.now().toString();

    const index = state.entries.findIndex(e => e.id === state.editingId);
    const nowISO = new Date().toISOString();

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
            fontFamily: currentFont,
            fontSize: currentSize
        };
        state.entries.unshift(newEntry);
    } else {
        state.entries[index] = {
            ...state.entries[index],
            title: title,
            subtitle: subtitle,
            body: body,
            fontFamily: currentFont,
            fontSize: currentSize,
            modifiedAt: nowISO
        };
    }
    
    saveData();
    renderEntries();
}

export function saveData() {
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    saveToDrive(); 
}

export async function updateEntryField(id, fields) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        Object.assign(entry, fields);
        entry.modifiedAt = new Date().toISOString();
        saveData();
        renderEntries();
    }
}

export async function moveToTrash(id) {
    if(confirm('휴지통으로 이동하시겠습니까?')) {
        await updateEntryField(id, { isDeleted: true });
    }
}

export async function restoreEntry(id) {
    await updateEntryField(id, { isDeleted: false });
    renderTrash();
}

export async function permanentDelete(id) {
    if(confirm('영구 삭제하시겠습니까? 되돌릴 수 없습니다.')) {
        await updateEntryField(id, { isPurged: true });
        renderTrash();
    }
}

// [핵심] 휴지통 비우기 기능
export async function emptyTrash() {
    const trashItems = state.entries.filter(e => e.isDeleted && !e.isPurged);
    
    if(trashItems.length === 0) {
        alert("휴지통이 이미 비어있습니다.");
        return;
    }
    
    if(confirm(`휴지통에 있는 글 ${trashItems.length}개를 모두 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) {
        const now = new Date().toISOString();
        trashItems.forEach(e => {
            e.isPurged = true;
            e.modifiedAt = now;
        });
        saveData(); // 저장 및 동기화
        renderTrash(); // 화면 갱신
    }
}

export function checkOldTrash() {
    const now = new Date();
    let changed = false;
    state.entries.forEach(e => {
        if(e.isDeleted && !e.isPurged) {
            const trashDate = new Date(e.modifiedAt || e.timestamp);
            const diff = (now - trashDate) / (1000 * 60 * 60 * 24);
            if(diff > 30) {
                e.isPurged = true;
                e.modifiedAt = now.toISOString();
                changed = true;
            }
        }
    });
    if(changed) saveData();
}

export async function duplicateEntry(id) {
    const original = state.entries.find(e => e.id === id);
    if (!original) return;

    const nowISO = new Date().toISOString();
    const newEntry = {
        ...original, 
        id: Date.now().toString(),
        title: (original.title || '제목 없음') + " (복사본)",
        date: new Date().toLocaleDateString('ko-KR'),
        timestamp: nowISO,
        modifiedAt: nowISO,
        isDeleted: false,
        isPurged: false
    };
    
    state.entries.unshift(newEntry);
    saveData();
    renderEntries();
}