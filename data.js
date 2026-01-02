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
        const old = state.entries[index];
        if (old.title !== title || old.body !== body || old.subtitle !== subtitle) {
            state.entries[index] = {
                ...old,
                title, subtitle, body,
                modifiedAt: nowISO, 
                fontFamily: state.currentFontFamily,
                fontSize: state.currentFontSize
            };
        }
    }
    
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    renderEntries(); // [개선] UI 즉시 갱신
}

/**
 * 변경사항 저장 및 백그라운드 동기화
 * UI 렌더링을 방해하지 않도록 await 순서를 조정했습니다.
 */
export async function saveData() {
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    // 드라이브 저장은 백그라운드에서 진행되도록 await를 걸지 않거나 별도로 처리 가능합니다.
    saveToDrive(); 
}

export async function updateEntryField(id, fields) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        Object.assign(entry, fields);
        entry.modifiedAt = new Date().toISOString();
        
        // [개선] 로컬 저장과 UI 갱신을 먼저 수행하여 즉시 반영되게 함
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        renderEntries();
        renderTrash();
        
        // 동기화는 나중에 수행
        await saveToDrive();
    }
}

export async function moveToTrash(id) {
    if(confirm('휴지통으로 이동하시겠습니까?')) {
        const entry = state.entries.find(e => e.id === id);
        if(entry) {
            entry.isDeleted = true;
            entry.modifiedAt = new Date().toISOString();
            
            // [개선] 즉시 화면에서 제거
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
            renderEntries();
            
            // 백그라운드 동기화
            saveToDrive();
        }
    }
}

export async function restoreEntry(id) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        entry.isDeleted = false;
        entry.modifiedAt = new Date().toISOString();
        
        // [개선] 즉시 화면 갱신 (휴지통에서 제거, 목록에 추가)
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        renderTrash();
        renderEntries();
        
        saveToDrive();
    }
}

export async function permanentDelete(id) {
    if(confirm('영구 삭제하시겠습니까? 되돌릴 수 없습니다.')) {
        const index = state.entries.findIndex(e => e.id === id);
        if(index !== -1) {
            state.entries[index].isPurged = true;
            state.entries[index].modifiedAt = new Date().toISOString();
            
            // [개선] 즉시 휴지통 화면에서 제거
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
            renderTrash();
            
            saveToDrive();
        }
    }
}

export async function emptyTrash() {
    const trashItems = state.entries.filter(e => e.isDeleted && !e.isPurged);
    if(trashItems.length === 0) return alert("휴지통이 이미 비어있습니다.");
    
    if(confirm(`휴지통의 ${trashItems.length}개 항목을 모두 영구 삭제하시겠습니까?`)) {
        const now = new Date().toISOString();
        trashItems.forEach(e => { e.isPurged = true; e.modifiedAt = now; });
        
        // [개선] 즉시 휴지통 화면 비우기
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
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
            if((now - trashDate) / (1000 * 60 * 60 * 24) > 30) {
                e.isPurged = true; e.modifiedAt = now.toISOString(); changed = true;
            }
        }
    });
    if(changed) {
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        saveToDrive();
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
    
    // [개선] 즉시 목록 갱신
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    renderEntries();
    
    saveToDrive();
}