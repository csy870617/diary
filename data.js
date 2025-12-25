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

    // [중요] 저장 버튼 누른 시점을 수정 시간으로 기록
    const nowISO = new Date().toISOString();

    if(!state.editingId) {
        // --- 새 글 ---
        const newId = Date.now().toString();
        const newEntry = {
            id: newId,
            title: title || '제목 없음',
            subtitle: subtitle,
            body: body,
            date: new Date().toLocaleDateString('ko-KR'),
            timestamp: nowISO,
            modifiedAt: nowISO, // 수정 시간
            category: state.currentCategory,
            isDeleted: false,
            isPurged: false,
            fontFamily: currentFont,
            fontSize: currentSize
        };
        state.entries.unshift(newEntry);
    } else {
        // --- 수정 ---
        const index = state.entries.findIndex(e => e.id === state.editingId);
        if(index > -1) {
            state.entries[index] = {
                ...state.entries[index],
                title: title,
                subtitle: subtitle,
                body: body,
                fontFamily: currentFont,
                fontSize: currentSize,
                modifiedAt: nowISO // 수정 시간 갱신
            };
        }
    }
    
    saveDataLocal();
    renderEntries();
    
    // [핵심] 저장 후 즉시 병합 동기화 시도
    await saveToDrive(); 
}

export function updateEntryField(id, fields) {
    const index = state.entries.findIndex(e => e.id === id);
    if(index > -1) {
        // 필드 업데이트 시에도 수정 시간 갱신
        state.entries[index] = { 
            ...state.entries[index], 
            ...fields, 
            modifiedAt: new Date().toISOString() 
        };
        saveDataLocal();
        return saveToDrive(); 
    }
}

export async function moveToTrash(id) {
    if(confirm('휴지통으로 이동하시겠습니까?')) {
        await updateEntryField(id, { isDeleted: true });
        renderEntries();
    }
}

export async function restoreEntry(id) {
    await updateEntryField(id, { isDeleted: false });
    renderTrash();
    renderEntries();
}

export async function permanentDelete(id) {
    if(confirm('영구 삭제하시겠습니까? 되돌릴 수 없습니다.')) {
        await updateEntryField(id, { isPurged: true });
        renderTrash();
    }
}

export async function emptyTrash() {
    const trashItems = state.entries.filter(e => e.isDeleted && !e.isPurged);
    if(trashItems.length === 0) return;
    
    if(confirm('휴지통을 비우시겠습니까? 복구할 수 없습니다.')) {
        const now = new Date().toISOString();
        trashItems.forEach(e => {
            e.isPurged = true;
            e.modifiedAt = now;
        });
        saveDataLocal();
        renderTrash();
        await saveToDrive();
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
    if(changed) {
        saveDataLocal();
        saveToDrive();
    }
}

export async function duplicateEntry(id) {
    const original = state.entries.find(e => e.id === id);
    if (!original) return;

    const nowISO = new Date().toISOString();
    const newEntry = {
        ...original, 
        id: Date.now().toString(),
        title: original.title + " (복사본)",
        date: new Date().toLocaleDateString('ko-KR'),
        timestamp: nowISO,
        modifiedAt: nowISO,
        isDeleted: false,
        isPurged: false
    };
    
    state.entries.unshift(newEntry);
    saveDataLocal();
    renderEntries();
    await saveToDrive();
}

// 로컬 스토리지 저장 (백업용)
function saveDataLocal() {
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
}