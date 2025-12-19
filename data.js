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
    const body = bodyEl.innerText; // or innerHTML depending on your usage
    const subtitle = subtitleEl ? subtitleEl.value : '';
    
    if(!state.editingId) {
        // 새 글 작성
        if(!title.trim() && !body.trim()) return;
        const newEntry = {
            id: Date.now().toString(),
            title: title || '제목 없음',
            subtitle: subtitle,
            body: body,
            date: new Date().toLocaleDateString('ko-KR'),
            timestamp: new Date().toISOString(),
            modifiedAt: new Date().toISOString(), // 수정 시간
            category: state.currentCategory,
            isDeleted: false,
            isPurged: false // [추가] 완전 삭제 여부
        };
        state.entries.unshift(newEntry);
    } else {
        // 글 수정
        const entry = state.entries.find(e => e.id === state.editingId);
        if(entry) {
            entry.title = title;
            entry.subtitle = subtitle;
            entry.body = body;
            entry.modifiedAt = new Date().toISOString(); // 수정 시간 갱신
        }
    }
    
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
        entry.modifiedAt = new Date().toISOString(); // 상태 변경 시 반드시 시간 갱신
        saveData();
        renderEntries();
    }
}

export async function moveToTrash(id) {
    await updateEntryField(id, { isDeleted: true });
}

export async function restoreEntry(id) {
    await updateEntryField(id, { isDeleted: false, isPurged: false });
}

export async function permanentDelete(id) {
    // [핵심 수정] 배열에서 제거(splice)하지 않고 '완전 삭제됨(isPurged)' 표시만 함
    await updateEntryField(id, { isDeleted: true, isPurged: true });
    renderTrash();
}

export async function emptyTrash() {
    const trashItems = state.entries.filter(e => e.isDeleted && !e.isPurged);
    if(trashItems.length === 0) return;
    
    if(confirm('휴지통을 비우시겠습니까? 복구할 수 없습니다.')) {
        trashItems.forEach(e => {
            e.isPurged = true; // 완전 삭제 표시
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