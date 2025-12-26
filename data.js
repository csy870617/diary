import { state } from './state.js';
import { renderEntries, renderTrash } from './ui.js';
import { saveToDrive } from './drive.js';

export function loadDataFromLocal() {
    const localData = localStorage.getItem('faithLogDB');
    if(localData) state.entries = JSON.parse(localData);
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

    // 제목과 내용이 모두 비어있으면 저장하지 않음 (단, ID는 유지)
    if(!title.trim() && !bodyEl.innerText.trim()) return;

    if (!state.editingId) state.editingId = Date.now().toString();
    const index = state.entries.findIndex(e => e.id === state.editingId);

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
            fontFamily: state.currentFontFamily || 'Pretendard',
            fontSize: state.currentFontSize || 16
        };
        state.entries.unshift(newEntry);
    } else {
        // 기존 글 업데이트 (수정 시간 갱신)
        state.entries[index] = {
            ...state.entries[index],
            title, subtitle, body,
            modifiedAt: nowISO,
            fontFamily: state.currentFontFamily,
            fontSize: state.currentFontSize
        };
    }
    
    // 로컬 스토리지 저장
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    // 참고: 클라우드 동기화는 editor.js의 triggerAutoSave에서 별도로 호출함
}

export function saveData() {
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    saveToDrive(false); 
}

export async function updateEntryField(id, fields) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        Object.assign(entry, fields);
        entry.modifiedAt = new Date().toISOString();
        saveData();
    }
}

export async function moveToTrash(id) {
    if(confirm('휴지통으로 이동하시겠습니까?')) await updateEntryField(id, { isDeleted: true });
}

export async function restoreEntry(id) {
    await updateEntryField(id, { isDeleted: false });
    renderTrash();
}

export async function permanentDelete(id) {
    if(confirm('영구 삭제하시겠습니까? 되돌릴 수 없습니다.')) {
        const index = state.entries.findIndex(e => e.id === id);
        if(index !== -1) {
            state.entries[index].isPurged = true;
            state.entries[index].modifiedAt = new Date().toISOString();
            saveData();
        }
        renderTrash();
    }
}

export async function emptyTrash() {
    const trashItems = state.entries.filter(e => e.isDeleted && !e.isPurged);
    if(trashItems.length === 0) return alert("휴지통이 이미 비어있습니다.");
    
    if(confirm(`휴지통의 ${trashItems.length}개 항목을 모두 영구 삭제하시겠습니까?`)) {
        const now = new Date().toISOString();
        trashItems.forEach(e => { e.isPurged = true; e.modifiedAt = now; });
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
            if((now - trashDate) / (1000 * 60 * 60 * 24) > 30) {
                e.isPurged = true; e.modifiedAt = now.toISOString(); changed = true;
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
        ...original, id: Date.now().toString(),
        title: original.title + " (복사본)",
        timestamp: nowISO, modifiedAt: nowISO, isDeleted: false, isPurged: false
    };
    state.entries.unshift(newEntry);
    saveData();
}