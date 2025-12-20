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
    
    // [핵심 수정 1] innerText 대신 innerHTML을 사용해야 서식(태그)이 저장됨
    const body = bodyEl.innerHTML; 
    
    const subtitle = subtitleEl ? subtitleEl.value : '';
    
    // 제목과 본문이 모두 비어있으면 저장 안 함 (빈 글 방지)
    if(!title.trim() && !bodyEl.innerText.trim()) return;

    if(!state.editingId) {
        // --- 새 글 작성 ---
        const newId = Date.now().toString(); // ID 미리 생성
        const newEntry = {
            id: newId,
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
        
        // [핵심 수정 2] 저장 직후, 현재 에디터가 이 글을 보고 있다고 알려줌
        // 그래야 연속으로 저장해도 새 글이 또 생기지 않고 이 글을 수정함
        state.editingId = newId; 
        
    } else {
        // --- 기존 글 수정 ---
        const entry = state.entries.find(e => e.id === state.editingId);
        if(entry) {
            entry.title = title;
            entry.subtitle = subtitle;
            entry.body = body;
            entry.modifiedAt = new Date().toISOString(); // 수정 시간 갱신
        }
    }
    
    // 저장 후 즉시 목록 갱신 및 동기화
    renderEntries();
    saveData();
}

export function saveData() {
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    saveToDrive(); // 클라우드 동기화 트리거
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
    await updateEntryField(id, { isDeleted: true });
}

export async function restoreEntry(id) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        entry.isDeleted = false;
        entry.isPurged = false;
        entry.modifiedAt = new Date().toISOString();
        saveData();
        renderTrash();
        renderEntries();
    }
}

export async function permanentDelete(id) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        entry.isDeleted = true;
        entry.isPurged = true; 
        // 동기화 시 삭제 상태가 이기도록 미래 시간 설정
        entry.modifiedAt = new Date(Date.now() + 1000).toISOString();
        saveData();
        renderTrash();
    }
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
        isDeleted: false,
        isPurged: false
    };
    
    state.entries.unshift(newEntry); 
    saveData();
    renderEntries();
}