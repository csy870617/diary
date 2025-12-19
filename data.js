import { state } from './state.js';
import { autoLink } from './utils.js';
import { saveToDrive } from './drive.js';
import { renderEntries, renderTrash } from './ui.js';

// 데이터를 로컬에서 불러오기 (초기 로딩용)
export function loadDataFromLocal() { 
    state.entries = JSON.parse(localStorage.getItem('faithLogDB')) || []; 
}

// 저장 로직 (로컬 저장 후 -> 구글 드라이브 동기화)
export async function saveEntry() { 
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const editBody = document.getElementById('editor-body');

    const title = editTitle.value.trim(); 
    const body = autoLink(editBody.innerHTML);
    
    if(!title || !body || body === '<br>') return; 
    
    const now = Date.now(); 
    const entryData = { 
        id: state.isEditMode ? state.editingId : 'note_' + now,
        category: state.currentCategory, 
        title, 
        subtitle: editSubtitle.value.trim(), 
        body, 
        fontFamily: state.currentFontFamily, 
        fontSize: state.currentFontSize, 
        date: new Date().toLocaleDateString('ko-KR'), 
        timestamp: now, 
        modifiedAt: now, 
        isDeleted: false 
    }; 
    
    // 배열 업데이트
    if (state.isEditMode) { 
        const index = state.entries.findIndex(e => e.id === state.editingId); 
        if (index !== -1) { 
            state.entries[index] = { ...state.entries[index], ...entryData, timestamp: state.entries[index].timestamp, modifiedAt: now }; 
        } 
    } else { 
        state.entries.unshift(entryData); 
        state.isEditMode = true;
        state.editingId = entryData.id;
    } 
    
    // 저장 실행
    persistData();
}

export async function updateEntryField(id, data) {
    const index = state.entries.findIndex(e => e.id === id);
    if (index !== -1) {
        state.entries[index] = { ...state.entries[index], ...data };
        persistData();
    }
}

export async function moveToTrash(id) { 
    if(!confirm('휴지통으로 이동하시겠습니까?')) return; 
    const now = Date.now();
    const index = state.entries.findIndex(e => e.id === id); 
    if(index !== -1) {
        state.entries[index].isDeleted = true;
        state.entries[index].deletedAt = now;
        persistData();
    }
    renderEntries(); 
}

export async function permanentDelete(id) { 
    if(!confirm('영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return; 
    state.entries = state.entries.filter(e => e.id !== id); 
    persistData();
    renderTrash(); 
    renderEntries(); 
}

export async function restoreEntry(id) { 
    if(!confirm('이 글을 복구하시겠습니까?')) return; 
    const index = state.entries.findIndex(e => e.id === id); 
    if(index !== -1) state.entries[index].isDeleted = false; 
    persistData();
    renderTrash(); 
    renderEntries(); 
}

export async function emptyTrash() {
    if(!confirm('휴지통을 비우시겠습니까? 모든 글이 영구 삭제됩니다.')) return;
    state.entries = state.entries.filter(e => !e.isDeleted);
    persistData();
    renderTrash();
    renderEntries();
}

export async function checkOldTrash() {
    const now = Date.now();
    const thirtyDays = 1000 * 60 * 60 * 24 * 30; 
    state.entries = state.entries.filter(e => !(e.isDeleted && e.deletedAt && (now - e.deletedAt > thirtyDays)));
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
}

// 공통 저장 함수: 로컬 저장 후 드라이브 업로드
function persistData() {
    localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
    // 백그라운드에서 구글 드라이브 업로드 (사용자 경험 저해 방지)
    saveToDrive();
}