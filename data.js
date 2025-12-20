import { state } from './state.js';
import { renderEntries, renderTrash } from './ui.js';
import { saveToDrive } from './drive.js';

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
    const body = bodyEl.innerText; 
    const subtitle = subtitleEl ? subtitleEl.value : '';
    
    if(!state.editingId) {
        if(!title.trim() && !body.trim()) return;
        const newEntry = {
            id: Date.now().toString(),
            title: title || '제목 없음',
            subtitle: subtitle,
            body: body,
            date: new Date().toLocaleDateString('ko-KR'),
            timestamp: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            category: state.currentCategory,
            isDeleted: false,
            isPurged: false
        };
        state.entries.unshift(newEntry);
    } else {
        const entry = state.entries.find(e => e.id === state.editingId);
        if(entry) {
            entry.title = title;
            entry.subtitle = subtitle;
            entry.body = body;
            entry.modifiedAt = new Date().toISOString();
        }
    }
    
    saveData();
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
        renderEntries(); // 메인 리스트 갱신
    }
}

export async function moveToTrash(id) {
    await updateEntryField(id, { isDeleted: true });
}

export async function restoreEntry(id) {
    // [핵심 수정] 복구 시 상태 변경 후, 즉시 휴지통 화면(renderTrash)을 갱신
    await updateEntryField(id, { isDeleted: false, isPurged: false });
    renderTrash(); // 이 한 줄이 있어야 휴지통에서 바로 사라짐
}

export async function permanentDelete(id) {
    await updateEntryField(id, { isDeleted: true, isPurged: true });
    renderTrash();
}

export async function emptyTrash() {
    const trashItems = state.entries.filter(e => e.isDeleted && !e.isPurged);
    if(trashItems.length === 0) return;
    
    if(confirm('휴지통을 비우시겠습니까? 복구할 수 없습니다.')) {
        trashItems.forEach(e => {
            e.isPurged = true;
            e.modifiedAt = new Date().toISOString();
        });
        saveData();
        renderTrash();
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

    const newEntry = {
        ...original, 
        id: Date.now().toString(), 
        title: (original.title || '제목 없음') + " (복사본)",
        date: new Date().toLocaleDateString('ko-KR'),
        timestamp: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        isLocked: false, 
        lockPassword: null
    };
    
    state.entries.unshift(newEntry); 
    saveData();
    renderEntries();
}