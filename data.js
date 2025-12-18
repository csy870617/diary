import { db } from './firebase.js';
import { collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { state } from './state.js';
import { autoLink } from './utils.js';
import { renderEntries, renderTrash } from './ui.js';

export async function loadDataFromFirestore() { 
    if(!state.currentUser) return; 
    const newEntries = []; 
    const q = query(collection(db, "users", state.currentUser.uid, "entries")); 
    try { 
        const querySnapshot = await getDocs(q); 
        querySnapshot.forEach((doc) => { newEntries.push({ id: doc.id, ...doc.data() }); }); 
        state.entries = newEntries; 
    } catch (e) { console.error(e); } 
}

export function loadDataFromLocal() { 
    state.entries = JSON.parse(localStorage.getItem('faithLogDB')) || []; 
}

export async function saveEntry() { 
    const editTitle = document.getElementById('edit-title');
    const editSubtitle = document.getElementById('edit-subtitle');
    const editBody = document.getElementById('editor-body');

    const title = editTitle.value.trim(); 
    const body = autoLink(editBody.innerHTML);
    
    if(!title || !body || body === '<br>') return; 
    
    const now = Date.now(); 
    const entryData = { 
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
    
    try { 
        if(state.currentUser) { 
            if(state.isEditMode && state.editingId) { 
                const docRef = doc(db, "users", state.currentUser.uid, "entries", state.editingId); 
                const updateData = { ...entryData }; 
                delete updateData.timestamp; 
                await updateDoc(docRef, updateData); 
            } else { 
                const docRef = await addDoc(collection(db, "users", state.currentUser.uid, "entries"), entryData); 
                state.isEditMode = true;
                state.editingId = docRef.id;
            } 
            await loadDataFromFirestore(); 
        } else { 
            entryData.id = state.isEditMode ? state.editingId : now; 
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
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries)); 
        } 
    } catch(e) { console.error("Save Error:", e); } 
}

export async function updateEntryField(id, data) {
    if (state.currentUser) {
        await updateDoc(doc(db, "users", state.currentUser.uid, "entries", id), data);
        await loadDataFromFirestore();
    } else {
        const index = state.entries.findIndex(e => e.id === id);
        if (index !== -1) {
            state.entries[index] = { ...state.entries[index], ...data };
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        }
    }
}

export async function moveToTrash(id) { 
    if(!confirm('휴지통으로 이동하시겠습니까?')) return; 
    const now = Date.now();
    if(state.currentUser){ 
        const docRef = doc(db, "users", state.currentUser.uid, "entries", id); 
        await updateDoc(docRef, { isDeleted: true, deletedAt: now }); 
        await loadDataFromFirestore(); 
    } else { 
        const index = state.entries.findIndex(e => e.id === id); 
        if(index !== -1) {
            state.entries[index].isDeleted = true;
            state.entries[index].deletedAt = now;
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries)); 
        }
    } 
    renderEntries(); 
}

export async function permanentDelete(id) { 
    if(!confirm('영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return; 
    if(state.currentUser){ 
        await deleteDoc(doc(db, "users", state.currentUser.uid, "entries", id)); 
        await loadDataFromFirestore(); 
    } else { 
        state.entries = state.entries.filter(e => e.id !== id); 
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries)); 
    } 
    renderTrash(); 
    renderEntries(); 
}

export async function restoreEntry(id) { 
    if(!confirm('이 글을 복구하시겠습니까?')) return; 
    if(state.currentUser){ 
        const docRef = doc(db, "users", state.currentUser.uid, "entries", id); 
        await updateDoc(docRef, { isDeleted: false }); 
        await loadDataFromFirestore(); 
    } else { 
        const index = state.entries.findIndex(e => e.id === id); 
        if(index !== -1) state.entries[index].isDeleted = false; 
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries)); 
    } 
    renderTrash(); 
    renderEntries(); 
}

export async function emptyTrash() {
    if(!confirm('휴지통을 비우시겠습니까? 모든 글이 영구 삭제됩니다.')) return;
    const deletedEntries = state.entries.filter(e => e.isDeleted);
    
    if (!state.currentUser) {
        state.entries = state.entries.filter(e => !e.isDeleted);
        localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        renderTrash();
        renderEntries();
        return;
    }
    
    for (const entry of deletedEntries) {
        await deleteDoc(doc(db, "users", state.currentUser.uid, "entries", entry.id));
    }
    await loadDataFromFirestore();
    renderTrash();
    renderEntries();
}

export async function checkOldTrash() {
    const now = Date.now();
    const thirtyDays = 1000 * 60 * 60 * 24 * 30; 
    const toDelete = state.entries.filter(e => e.isDeleted && e.deletedAt && (now - e.deletedAt > thirtyDays));

    if(toDelete.length > 0) {
        if(state.currentUser) {
            for (const entry of toDelete) {
                await deleteDoc(doc(db, "users", state.currentUser.uid, "entries", entry.id));
            }
            await loadDataFromFirestore();
        } else {
            state.entries = state.entries.filter(e => !(e.isDeleted && e.deletedAt && (now - e.deletedAt > thirtyDays)));
            localStorage.setItem('faithLogDB', JSON.stringify(state.entries));
        }
        renderEntries();
    }
}