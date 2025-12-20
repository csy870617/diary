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
    saveToDrive(); // 저장 시 자동 동기화 트리거
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

// [수정] 복구 시 휴지통에서 즉시 사라지게 처리
export async function restoreEntry(id) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        entry.isDeleted = false;
        entry.isPurged = false;
        // 복구했다는 사실을 서버에 알리기 위해 시간 갱신
        entry.modifiedAt = new Date().toISOString();
        saveData();
        renderTrash();   // 휴지통 화면 갱신 (즉시 사라짐)
        renderEntries(); // 메인 목록 갱신
    }
}

// [핵심] 영구 삭제 시 '완전 삭제됨' 꼬리표를 확실하게 붙임
export async function permanentDelete(id) {
    const entry = state.entries.find(e => e.id === id);
    if(entry) {
        entry.isDeleted = true;
        entry.isPurged = true; 
        // [중요] 동기화 시 서버의 옛날 파일(삭제 안 된 버전)을 이기기 위해
        // 수정 시간을 현재보다 살짝 미래로 설정하여 '최신'임을 보장함
        entry.modifiedAt = new Date(Date.now() + 1000).toISOString();
        
        saveData();
        renderTrash(); // 휴지통 화면 갱신 (즉시 사라짐)
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
        // 잠금 속성 복사 제외 (잠금 기능 삭제됨)
    };
    
    state.entries.unshift(newEntry); 
    saveData();
    renderEntries();
}