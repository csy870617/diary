import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyA0DrHDHo9lI4hsTmaksc9_-QfyeXl1duA",
    authDomain: "faith-log.firebaseapp.com",
    projectId: "faith-log",
    storageBucket: "faith-log.firebasestorage.app",
    messagingSenderId: "702745292814",
    appId: "1:702745292814:web:877100e106c8696b5f8c5f",
    measurementId: "G-0Y5608Q4MT"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- 상태 ---
let currentUser = null;
let currentCategory = 'sermon';
let entries = [];
let customCategories = JSON.parse(localStorage.getItem('faithCustomCats')) || [];
const defaultCategories = [
    { id: 'sermon', name: '설교' },
    { id: 'meditation', name: '묵상' },
    { id: 'prayer', name: '기도' },
    { id: 'gratitude', name: '감사' }
];
let categoryOrder = JSON.parse(localStorage.getItem('faithCatOrder')) || [];
let isEditMode = false;
let editingId = null;
let currentFontSize = 16;
let currentFontFamily = 'Pretendard';
let currentSortBy = 'created';
let currentSortOrder = 'desc';

// DOM
const loginModal = document.getElementById('login-modal');
const loginTriggerBtn = document.getElementById('login-trigger-btn');
const logoutBtn = document.getElementById('logout-btn');
const resetPwModal = document.getElementById('reset-pw-modal');

const entryList = document.getElementById('entry-list');
const writeModal = document.getElementById('write-modal');
const readModal = document.getElementById('read-modal');
const trashModal = document.getElementById('trash-modal');
const trashList = document.getElementById('trash-list');
const tabContainer = document.getElementById('tab-container');

const editBody = document.getElementById('editor-body');
const editTitle = document.getElementById('edit-title');
const editSubtitle = document.getElementById('edit-subtitle');
const fontSelector = document.getElementById('font-selector');
const stickerPalette = document.getElementById('sticker-palette');
const stickerGrid = document.getElementById('sticker-grid');
const btnBold = document.getElementById('btn-bold');
const btnItalic = document.getElementById('btn-italic');

const sortCriteria = document.getElementById('sort-criteria');
const sortOrderBtn = document.getElementById('sort-order-btn');
const sortIcon = document.getElementById('sort-icon');

const stickers = [ '✝️','🙏','📖','🕊️','🕯️','💒','🍞','🍷','🩸','🔥','☁️','☀️','🌙','⭐','✨','🌧️','🌈','❄️','🌿','🌷','🌻','🍂','🌱','🌲','🕊️','🦋','🐾','🧸','🎀','🎈','🎁','🔔','💡','🗝️','📝','📌','📎','✂️','🖍️','🖌️','💌','📅','☕','🍵','🥪','🍎','🤍','💛','🧡','❤️','💜','💙','💚','🤎','🖤','😊','😭','🥰','🤔','💪' ];

function init() {
    if(categoryOrder.length === 0) categoryOrder = [...defaultCategories, ...customCategories].map(c => c.id);

    new Sortable(tabContainer, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        direction: 'horizontal',
        filter: '.add-cat-btn',
        onMove: function(evt) { return evt.related.className.indexOf('add-cat-btn') === -1; },
        onEnd: function (evt) {
            const newOrder = [];
            tabContainer.querySelectorAll('.tab-btn').forEach(btn => { if(btn.dataset.id) newOrder.push(btn.dataset.id); });
            categoryOrder = newOrder;
            localStorage.setItem('faithCatOrder', JSON.stringify(categoryOrder));
        }
    });

    const savedId = localStorage.getItem('savedEmail');
    if(savedId) {
        document.getElementById('login-email').value = savedId;
        document.getElementById('save-id-check').checked = true;
    }

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            logoutBtn.classList.remove('hidden');
            loginTriggerBtn.classList.add('hidden');
            loginModal.classList.add('hidden');
            await loadDataFromFirestore();
        } else {
            currentUser = null;
            logoutBtn.classList.add('hidden');
            loginTriggerBtn.classList.remove('hidden');
            loadDataFromLocal();
        }
        renderTabs();
        renderEntries();
    });

    setupEventListeners();
    renderStickers();
}

function setupEventListeners() {
    // ... 기존 로그인, 정렬, 툴바 등 이벤트 유지 ...
    loginTriggerBtn.addEventListener('click', () => loginModal.classList.remove('hidden'));
    document.getElementById('close-login-btn').addEventListener('click', () => loginModal.classList.add('hidden'));
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-pw').value;
        const autoLogin = document.getElementById('auto-login-check').checked;
        const saveId = document.getElementById('save-id-check').checked;
        if(saveId) localStorage.setItem('savedEmail', email); else localStorage.removeItem('savedEmail');
        const persistence = autoLogin ? browserLocalPersistence : browserSessionPersistence;
        try { await setPersistence(auth, persistence); await signInWithEmailAndPassword(auth, email, password); } catch (error) { alert("로그인 정보를 다시 확인해주세요."); }
    });
    
    document.getElementById('signup-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-pw').value;
        if(!email || !password) return alert('이메일과 비밀번호를 모두 입력해주세요.');
        try { await createUserWithEmailAndPassword(auth, email, password); alert('회원가입이 완료되었습니다. 환영합니다!'); } catch (error) { alert("회원가입 실패: " + error.message); }
    });

    logoutBtn.addEventListener('click', () => { if(confirm("로그아웃 하시겠습니까?")) signOut(auth); });
    document.getElementById('forgot-pw-btn').addEventListener('click', (e) => { e.preventDefault(); resetPwModal.classList.remove('hidden'); });
    document.getElementById('close-reset-btn').addEventListener('click', () => resetPwModal.classList.add('hidden'));
    document.getElementById('send-reset-btn').addEventListener('click', () => {
        const email = document.getElementById('reset-email').value;
        if(email) sendPasswordResetEmail(auth, email).then(() => { alert('재설정 메일을 발송했습니다.\n(스팸함을 꼭 확인해주세요!)'); resetPwModal.classList.add('hidden'); }).catch((e) => alert('이메일 전송에 실패했습니다.'));
    });

    sortCriteria.addEventListener('change', (e) => { currentSortBy = e.target.value; renderEntries(); });
    sortOrderBtn.addEventListener('click', () => {
        currentSortOrder = currentSortOrder === 'desc' ? 'asc' : 'desc';
        sortIcon.classList.toggle('ph-sort-descending');
        sortIcon.classList.toggle('ph-sort-ascending');
        renderEntries();
    });

    document.getElementById('search-input').addEventListener('input', (e) => renderEntries(e.target.value));
    fontSelector.addEventListener('change', (e) => applyFontStyle(e.target.value, currentFontSize));
    editBody.addEventListener('click', () => stickerPalette.classList.add('hidden'));
    document.getElementById('trash-btn').addEventListener('click', openTrashModal);
    document.getElementById('close-trash-btn').addEventListener('click', () => trashModal.classList.add('hidden'));
    document.getElementById('write-btn').addEventListener('click', () => openEditor(false));
    document.getElementById('close-write-btn').addEventListener('click', () => { if(confirm('작성 중인 내용을 취소하시겠습니까?')) writeModal.classList.add('hidden'); });
    editBody.addEventListener('keyup', checkToolbarState);
    editBody.addEventListener('mouseup', checkToolbarState);
    
    document.getElementById('btn-bold').addEventListener('mousedown', (e) => { e.preventDefault(); formatDoc('bold'); });
    document.getElementById('btn-italic').addEventListener('mousedown', (e) => { e.preventDefault(); formatDoc('italic'); });
    document.getElementById('sticker-btn').addEventListener('mousedown', (e) => { e.preventDefault(); toggleStickerMenu(); });
    document.getElementById('publish-btn').addEventListener('click', saveEntry);
    
    document.getElementById('close-read-btn').addEventListener('click', () => readModal.classList.add('hidden'));
    document.getElementById('delete-read-btn').addEventListener('click', () => moveToTrash(editingId));
    document.getElementById('edit-read-btn').addEventListener('click', () => {
        const entry = entries.find(e => e.id === editingId);
        if(entry) { openEditor(true, entry); readModal.classList.add('hidden'); }
    });

    // [NEW] 공유 기능
    document.getElementById('share-read-btn').addEventListener('click', async () => {
        const entry = entries.find(e => e.id === editingId);
        if(!entry) return;

        // HTML 태그 제거 및 텍스트 추출
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = entry.body;
        const bodyText = tempDiv.innerText;

        const shareText = `[Faith Log]\n\n${entry.title}\n(${entry.date})\n\n${bodyText}`;

        if(navigator.share) {
            try {
                await navigator.share({
                    title: entry.title,
                    text: shareText
                });
            } catch(e) { console.log('공유 취소'); }
        } else {
            try {
                await navigator.clipboard.writeText(shareText);
                alert('내용이 클립보드에 복사되었습니다.');
            } catch(e) {
                alert('이 브라우저에서는 공유 기능을 지원하지 않습니다.');
            }
        }
    });
}

// 스티커 입력 (제목/소제목 지원)
window.insertSticker = (emoji) => {
    const activeEl = document.activeElement;
    if (activeEl === editTitle || activeEl === editSubtitle) {
        const start = activeEl.selectionStart;
        const end = activeEl.selectionEnd;
        const text = activeEl.value;
        activeEl.value = text.substring(0, start) + emoji + text.substring(end);
        activeEl.selectionStart = activeEl.selectionEnd = start + emoji.length;
    } else {
        if(activeEl !== editBody) editBody.focus();
        document.execCommand('insertText', false, emoji);
    }
};

function renderStickers() { stickerGrid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); insertSticker('${s}')">${s}</span>`).join(''); }
function applyFontStyle(f, s) { currentFontFamily = f; currentFontSize = s; editBody.style.fontFamily = f; editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; fontSelector.value = f; }
function checkToolbarState() { if(document.queryCommandState('bold')) btnBold.classList.add('active'); else btnBold.classList.remove('active'); if(document.queryCommandState('italic')) btnItalic.classList.add('active'); else btnItalic.classList.remove('active'); }
function openEditor(m, d) { isEditMode = m; writeModal.classList.remove('hidden'); if(m&&d) { editingId=d.id; editTitle.value=d.title; editSubtitle.value=d.subtitle; editBody.innerHTML=d.body; applyFontStyle(d.fontFamily||'Pretendard', d.fontSize||16); } else { editingId=null; editTitle.value=''; editSubtitle.value=''; editBody.innerHTML=''; applyFontStyle('Pretendard', 16); } editBody.focus(); }
function openReadModal(id) { const e = entries.find(x => x.id === id); if(!e) return; editingId = id; document.getElementById('read-title').innerText = e.title; document.getElementById('read-subtitle').innerText = e.subtitle||''; document.getElementById('read-date').innerText = e.date; const b = document.getElementById('read-body'); b.innerHTML = e.body; b.style.fontFamily = e.fontFamily||'Pretendard'; b.style.fontSize = (e.fontFamily==='Nanum Pen Script' ? (e.fontSize||16)+4 : (e.fontSize||16)) + 'px'; document.getElementById('read-category').innerText = defaultCategories.find(c=>c.id===e.category)?.name || customCategories.find(c=>c.id===e.category)?.name || '기록'; readModal.classList.remove('hidden'); }

function loadDataFromLocal() { entries = JSON.parse(localStorage.getItem('faithLogDB')) || []; customCategories = JSON.parse(localStorage.getItem('faithCustomCats')) || []; }
async function loadDataFromFirestore() { if(!currentUser) return; entries = []; const q = query(collection(db, "users", currentUser.uid, "entries")); try { const querySnapshot = await getDocs(q); querySnapshot.forEach((doc) => { entries.push({ id: doc.id, ...doc.data() }); }); } catch (e) { console.error(e); } }

async function saveEntry() {
    const title = editTitle.value.trim();
    const body = editBody.innerHTML;
    if(!title || !body || body === '<br>') return alert('제목과 본문을 모두 입력해주세요.');
    const now = Date.now();

    const entryData = { 
        category: currentCategory, 
        title, 
        subtitle: editSubtitle.value.trim(), 
        body, 
        fontFamily: currentFontFamily, 
        fontSize: currentFontSize, 
        date: new Date().toLocaleDateString('ko-KR'), 
        timestamp: now, 
        modifiedAt: now, 
        isDeleted: false 
    };

    try { 
        if(currentUser) { 
            if(isEditMode && editingId) { 
                const docRef = doc(db, "users", currentUser.uid, "entries", editingId); 
                const updateData = { ...entryData };
                delete updateData.timestamp; 
                await updateDoc(docRef, updateData); 
            } else { 
                await addDoc(collection(db, "users", currentUser.uid, "entries"), entryData); 
            } 
            await loadDataFromFirestore(); 
        } else { 
            entryData.id = isEditMode ? editingId : now; 
            if (isEditMode) { 
                const index = entries.findIndex(e => e.id === editingId); 
                if (index !== -1) {
                    entries[index] = { ...entries[index], ...entryData, timestamp: entries[index].timestamp, modifiedAt: now };
                }
            } else { 
                entries.unshift(entryData); 
            } 
            localStorage.setItem('faithLogDB', JSON.stringify(entries)); 
        } 
        writeModal.classList.add('hidden'); 
        renderEntries(); 
    } catch(e) { 
        console.error("Save Error:", e);
        alert("저장에 실패했습니다. 잠시 후 다시 시도해주세요."); 
    }
}

async function moveToTrash(id) { if(!confirm('휴지통으로 이동하시겠습니까?')) return; if(currentUser){ const docRef = doc(db, "users", currentUser.uid, "entries", id); await updateDoc(docRef, { isDeleted: true }); await loadDataFromFirestore(); } else { const index = entries.findIndex(e => e.id === id); if(index !== -1) entries[index].isDeleted = true; localStorage.setItem('faithLogDB', JSON.stringify(entries)); } readModal.classList.add('hidden'); renderEntries(); }
window.permanentDelete = async (id) => { if(!confirm('영구 삭제하시겠습니까? (복구 불가)')) return; if(currentUser){ await deleteDoc(doc(db, "users", currentUser.uid, "entries", id)); await loadDataFromFirestore(); } else { entries = entries.filter(e => e.id !== id); localStorage.setItem('faithLogDB', JSON.stringify(entries)); } renderTrash(); }
window.restoreEntry = async (id) => { if(!confirm('이 글을 복구하시겠습니까?')) return; if(currentUser){ const docRef = doc(db, "users", currentUser.uid, "entries", id); await updateDoc(docRef, { isDeleted: false }); await loadDataFromFirestore(); } else { const index = entries.findIndex(e => e.id === id); if(index !== -1) entries[index].isDeleted = false; localStorage.setItem('faithLogDB', JSON.stringify(entries)); } renderTrash(); renderEntries(); }

function renderTabs() {
    tabContainer.innerHTML = '';
    const allCats = [...defaultCategories, ...customCategories];
    const sortedCats = [];
    categoryOrder.forEach(id => { const found = allCats.find(c => c.id === id); if(found) sortedCats.push(found); });
    allCats.forEach(c => { if(!categoryOrder.includes(c.id)) { sortedCats.push(c); categoryOrder.push(c.id); } });

    sortedCats.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `tab-btn ${currentCategory === cat.id ? 'active' : ''}`;
        btn.dataset.id = cat.id; 
        btn.innerHTML = `<span>${cat.name}</span>`;
        if (cat.id.startsWith('custom_')) {
            const delBtn = document.createElement('button');
            delBtn.className = 'del-cat-btn';
            delBtn.innerHTML = '<i class="ph ph-x"></i>';
            delBtn.onclick = (e) => { e.stopPropagation(); deleteCategory(cat.id, cat.name); };
            btn.appendChild(delBtn);
        }
        btn.onclick = () => { currentCategory = cat.id; renderTabs(); renderEntries(); };
        tabContainer.appendChild(btn);
    });
    
    const addBtn = document.createElement('button');
    addBtn.className = 'add-cat-btn';
    addBtn.innerHTML = '<i class="ph ph-plus"></i>';
    addBtn.onclick = addNewCategory;
    tabContainer.appendChild(addBtn);
}

function renderEntries(keyword = '') {
    entryList.innerHTML = '';
    const filtered = entries.filter(entry => !entry.isDeleted && entry.category === currentCategory && (entry.title.includes(keyword) || entry.body.includes(keyword)));
    
    filtered.sort((a, b) => {
        let valA, valB;
        if (currentSortBy === 'title') { valA = a.title; valB = b.title; }
        else if (currentSortBy === 'modified') { valA = a.modifiedAt || a.timestamp; valB = b.modifiedAt || b.timestamp; }
        else { valA = a.timestamp; valB = b.timestamp; }
        if (valA < valB) return currentSortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return currentSortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    if (filtered.length === 0) { entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">기록이 없습니다.</div>`; return; }
    filtered.forEach(entry => {
        const div = document.createElement('article');
        div.className = 'entry-card';
        div.onclick = () => openReadModal(entry.id);
        const dateStr = currentSortBy === 'modified' ? `수정: ${new Date(entry.modifiedAt || entry.timestamp).toLocaleDateString()}` : entry.date;
        div.innerHTML = `<h3 class="card-title">${entry.title}</h3>${entry.subtitle ? `<p class="card-subtitle">${entry.subtitle}</p>` : ''}<div class="card-meta"><span>${dateStr}</span></div>`;
        entryList.appendChild(div);
    });
}

function renderTrash() { trashList.innerHTML = ''; const deleted = entries.filter(e => e.isDeleted); if(deleted.length === 0) { trashList.innerHTML = `<div style="text-align:center; margin-top:50px; color:#aaa;">비어있음</div>`; return; } deleted.forEach(entry => { const div = document.createElement('div'); div.className = 'entry-card'; div.innerHTML = `<h3 class="card-title" style="text-decoration:line-through; color:#aaa;">${entry.title}</h3><div class="trash-actions"><button class="restore-btn" onclick="restoreEntry('${entry.id}')">복구</button><button class="perm-del-btn" onclick="permanentDelete('${entry.id}')">삭제</button></div>`; trashList.appendChild(div); }); }
function openTrashModal() { renderTrash(); trashModal.classList.remove('hidden'); }
window.addNewCategory = () => { const name = prompt("새 주제 이름"); if(name) { const id='custom_'+Date.now(); customCategories.push({id, name}); categoryOrder.push(id); localStorage.setItem('faithCustomCats', JSON.stringify(customCategories)); localStorage.setItem('faithCatOrder', JSON.stringify(categoryOrder)); renderTabs(); } };
window.deleteCategory = (id, name) => { if(confirm(`'${name}' 주제를 삭제하시겠습니까?`)) { customCategories = customCategories.filter(c => c.id !== id); categoryOrder = categoryOrder.filter(cid => cid !== id); localStorage.setItem('faithCustomCats', JSON.stringify(customCategories)); localStorage.setItem('faithCatOrder', JSON.stringify(categoryOrder)); if(currentCategory === id) currentCategory = 'sermon'; renderTabs(); renderEntries(); } };
window.changeFontSize = (a) => { let s = currentFontSize + a; if(s<12)s=12; if(s>40)s=40; applyFontStyle(currentFontFamily, s); };
window.formatDoc = (c, v) => { document.execCommand(c, false, v); editBody.focus(); checkToolbarState(); };
window.toggleStickerMenu = () => stickerPalette.classList.toggle('hidden');

init();