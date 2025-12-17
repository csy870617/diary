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

// [수정] 모든 카테고리를 통합 관리
const initialCategories = [
    { id: 'sermon', name: '설교' },
    { id: 'meditation', name: '묵상' },
    { id: 'prayer', name: '기도' },
    { id: 'gratitude', name: '감사' }
];
let allCategories = JSON.parse(localStorage.getItem('faithCategories')) || [...initialCategories];
let categoryOrder = JSON.parse(localStorage.getItem('faithCatOrder')) || allCategories.map(c => c.id);

let isEditMode = false;
let editingId = null;
let currentFontSize = 16; 
let currentFontFamily = 'Pretendard';
let currentSortBy = 'created';
let currentSortOrder = 'desc';
let currentViewMode = 'default';

let touchStartX = 0;
let touchEndX = 0;
let contextTargetId = null; // 게시글 ID
let contextCatId = null;    // [추가] 카테고리 ID
let longPressTimer = null;

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

const floatingMenu = document.getElementById('floating-menu');
const floatColorBtn = document.getElementById('float-color-btn');
const colorPalettePopup = document.getElementById('color-palette-popup');
const customColorBtn = document.getElementById('custom-color-btn');
const colorPicker = document.getElementById('color-picker');

const modeBtnDefault = document.getElementById('mode-btn-default');
const modeBtnFocus = document.getElementById('mode-btn-focus');
const modeBtnBook = document.getElementById('mode-btn-book');

const exitFocusBtn = document.getElementById('exit-focus-btn');
const readContentArea = document.getElementById('read-content-area');
const bookNavLeft = document.getElementById('book-nav-left');
const bookNavRight = document.getElementById('book-nav-right');
const pageIndicator = document.getElementById('page-indicator');

const sortCriteria = document.getElementById('sort-criteria');
const sortOrderBtn = document.getElementById('sort-order-btn');
const sortIcon = document.getElementById('sort-icon');

const contextMenu = document.getElementById('context-menu');
const catContextMenu = document.getElementById('category-context-menu'); // [추가] 카테고리 메뉴
const moveModal = document.getElementById('move-modal');
const moveCategoryList = document.getElementById('move-category-list');
const lockModal = document.getElementById('lock-modal');
const lockPwInput = document.getElementById('lock-pw-input');
const lockModalTitle = document.getElementById('lock-modal-title');
const lockModalDesc = document.getElementById('lock-modal-desc');

const stickers = [ '✝️','🙏','📖','🕊️','🕯️','💒','🍞','🍷','🩸','🔥','☁️','☀️','🌙','⭐','✨','🌧️','🌈','❄️','🌿','🌷','🌻','🍂','🌱','🌲','🕊️','🦋','🐾','🧸','🎀','🎈','🎁','🔔','💡','🗝️','📝','📌','📎','✂️','🖍️','🖌️','💌','📅','☕','🍵','🥪','🍎','🤍','💛','🧡','❤️','💜','💙','💚','🤎','🖤','😊','😭','🥰','🤔','💪' ];

function init() {
    // 최초 실행 시 기본 카테고리 순서 보장
    if(categoryOrder.length === 0) categoryOrder = allCategories.map(c => c.id);

    new Sortable(tabContainer, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        direction: 'horizontal',
        filter: '.add-cat-btn',
        delay: 200, 
        delayOnTouchOnly: true,
        onMove: function(evt) { return evt.related.className.indexOf('add-cat-btn') === -1; },
        onEnd: function (evt) {
            const newOrder = [];
            tabContainer.querySelectorAll('.tab-btn').forEach(btn => { if(btn.dataset.id) newOrder.push(btn.dataset.id); });
            categoryOrder = newOrder;
            localStorage.setItem('faithCatOrder', JSON.stringify(categoryOrder));
        }
    });

    tabContainer.addEventListener('wheel', (evt) => {
        if (evt.deltaY !== 0) {
            evt.preventDefault();
            tabContainer.scrollLeft += evt.deltaY; 
        }
    });

    window.addEventListener('popstate', () => {
        writeModal.classList.add('hidden');
        readModal.classList.add('hidden');
        trashModal.classList.add('hidden');
        loginModal.classList.add('hidden');
        resetPwModal.classList.add('hidden');
        floatingMenu.classList.add('hidden');
        colorPalettePopup.classList.add('hidden'); 
        contextMenu.classList.add('hidden');
        catContextMenu.classList.add('hidden');
        moveModal.classList.add('hidden');
        lockModal.classList.add('hidden');
        setReadMode('default');
    });

    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden');
        if (!catContextMenu.contains(e.target)) catContextMenu.classList.add('hidden');
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

function openModal(modal) {
    history.pushState({ modal: true }, null, '');
    modal.classList.remove('hidden');
}

function setupEventListeners() {
    // ... (기존 이벤트 리스너들) ...
    loginTriggerBtn.addEventListener('click', () => openModal(loginModal));
    document.getElementById('close-login-btn').addEventListener('click', () => history.back());
    document.getElementById('login-form').addEventListener('submit', async (e) => { e.preventDefault(); try { await setPersistence(auth, browserLocalPersistence); await signInWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-pw').value); history.back(); } catch (error) { alert("로그인 정보를 다시 확인해주세요."); } });
    document.getElementById('signup-btn').addEventListener('click', async (e) => { e.preventDefault(); try { await createUserWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-pw').value); alert('가입 완료'); } catch (error) { alert("실패: " + error.message); } });
    logoutBtn.addEventListener('click', () => { if(confirm("로그아웃?")) signOut(auth); });
    document.getElementById('forgot-pw-btn').addEventListener('click', (e) => { e.preventDefault(); openModal(resetPwModal); });
    document.getElementById('close-reset-btn').addEventListener('click', () => history.back());
    sortCriteria.addEventListener('change', (e) => { currentSortBy = e.target.value; renderEntries(); });
    sortOrderBtn.addEventListener('click', () => { currentSortOrder = currentSortOrder === 'desc' ? 'asc' : 'desc'; sortIcon.classList.toggle('ph-sort-descending'); sortIcon.classList.toggle('ph-sort-ascending'); renderEntries(); });
    document.getElementById('search-input').addEventListener('input', (e) => renderEntries(e.target.value));
    fontSelector.addEventListener('change', (e) => applyFontStyle(e.target.value, currentFontSize));
    editBody.addEventListener('click', () => { stickerPalette.classList.add('hidden'); colorPalettePopup.classList.add('hidden'); });
    editBody.addEventListener('keydown', (e) => { if ((e.altKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && (e.key === 's' || e.key === 'S'))) { e.preventDefault(); saveEntry(); } /*...*/ });
    document.getElementById('trash-btn').addEventListener('click', openTrashModal);
    document.getElementById('close-trash-btn').addEventListener('click', () => history.back());
    document.getElementById('write-btn').addEventListener('click', () => openEditor(false));
    document.getElementById('close-write-btn').addEventListener('click', () => { if(editTitle.value || editBody.innerText.trim()) { if(confirm('취소?')) history.back(); } else { history.back(); } });
    document.getElementById('sticker-btn').addEventListener('mousedown', (e) => { e.preventDefault(); toggleStickerMenu(); });
    floatColorBtn.addEventListener('mousedown', (e) => { e.preventDefault(); const rect = floatingMenu.getBoundingClientRect(); colorPalettePopup.style.top = `${rect.bottom + 5}px`; colorPalettePopup.style.left = `${rect.left}px`; colorPalettePopup.classList.toggle('hidden'); });
    customColorBtn.addEventListener('click', () => colorPicker.click());
    colorPicker.addEventListener('change', (e) => { formatDoc('foreColor', e.target.value); colorPalettePopup.classList.add('hidden'); });
    document.querySelectorAll('.color-dot[data-color]').forEach(btn => { btn.addEventListener('mousedown', (e) => { e.preventDefault(); formatDoc('foreColor', btn.dataset.color); colorPalettePopup.classList.add('hidden'); }); });
    document.getElementById('btn-sel-size-up').addEventListener('mousedown', (e) => { e.preventDefault(); changeSelectionFontSize(1); });
    document.getElementById('btn-sel-size-down').addEventListener('mousedown', (e) => { e.preventDefault(); changeSelectionFontSize(-1); });
    floatingMenu.querySelectorAll('.float-btn[data-cmd]').forEach(btn => { btn.addEventListener('mousedown', (e) => { e.preventDefault(); formatDoc(btn.dataset.cmd); }); });
    document.getElementById('publish-btn').addEventListener('click', saveEntry);
    document.getElementById('close-read-btn').addEventListener('click', () => history.back());
    document.getElementById('delete-read-btn').addEventListener('click', () => moveToTrash(editingId));
    document.getElementById('edit-read-btn').addEventListener('click', () => { const entry = entries.find(e => e.id === editingId); if(entry) { history.back(); setTimeout(() => openEditor(true, entry), 50); } });
    document.getElementById('share-read-btn').addEventListener('click', async () => { /*...*/ });

    // 보기 모드
    modeBtnDefault.addEventListener('click', () => setReadMode('default'));
    modeBtnFocus.addEventListener('click', () => setReadMode('focus'));
    modeBtnBook.addEventListener('click', () => setReadMode('book'));
    exitFocusBtn.addEventListener('click', () => setReadMode('default'));
    bookNavLeft.addEventListener('click', () => turnPage(-1));
    bookNavRight.addEventListener('click', () => turnPage(1));
    document.addEventListener('keydown', (e) => { if(currentViewMode === 'book' && !readModal.classList.contains('hidden')) { if(e.key === 'ArrowLeft') turnPage(-1); if(e.key === 'ArrowRight') turnPage(1); } });
    readContentArea.addEventListener('touchstart', (e) => { if(currentViewMode !== 'book') return; touchStartX = e.changedTouches[0].screenX; }, {passive:true});
    readContentArea.addEventListener('touchend', (e) => { if(currentViewMode !== 'book') return; touchEndX = e.changedTouches[0].screenX; handleSwipe(); }, {passive:true});

    // 컨텍스트 메뉴 액션
    document.getElementById('ctx-move').addEventListener('click', () => openMoveModal());
    document.getElementById('ctx-lock').addEventListener('click', () => openLockModal());
    document.getElementById('ctx-copy').addEventListener('click', () => duplicateEntry());
    document.getElementById('ctx-delete').addEventListener('click', () => { moveToTrash(contextTargetId); contextMenu.classList.add('hidden'); });

    // [추가] 카테고리 컨텍스트 메뉴 액션
    document.getElementById('ctx-cat-rename').addEventListener('click', renameCategoryAction);
    document.getElementById('ctx-cat-delete').addEventListener('click', deleteCategoryAction);

    document.getElementById('close-move-btn').addEventListener('click', () => moveModal.classList.add('hidden'));
    document.getElementById('close-lock-btn').addEventListener('click', () => lockModal.classList.add('hidden'));
    document.getElementById('confirm-lock-btn').addEventListener('click', confirmLock);
}

// [추가] 카테고리 렌더링 (삭제 버튼 제거, 컨텍스트 이벤트 추가)
function renderTabs() {
    tabContainer.innerHTML = '';
    const sortedCats = [];
    categoryOrder.forEach(id => { const found = allCategories.find(c => c.id === id); if(found) sortedCats.push(found); });
    allCategories.forEach(c => { if(!categoryOrder.includes(c.id)) { sortedCats.push(c); categoryOrder.push(c.id); } });

    sortedCats.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `tab-btn ${currentCategory === cat.id ? 'active' : ''}`;
        btn.dataset.id = cat.id; 
        btn.innerHTML = `<span>${cat.name}</span>`;
        
        btn.onclick = () => { currentCategory = cat.id; renderTabs(); renderEntries(); };
        
        // [중요] 카테고리 우클릭/롱터치 연결
        attachCatContextMenu(btn, cat.id);
        
        tabContainer.appendChild(btn);
    });
    
    const addBtn = document.createElement('button');
    addBtn.className = 'add-cat-btn';
    addBtn.innerHTML = '<i class="ph ph-plus"></i>';
    addBtn.onclick = addNewCategory;
    tabContainer.appendChild(addBtn);
}

// [추가] 카테고리 컨텍스트 연결 함수
function attachCatContextMenu(element, catId) {
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCatContextMenu(e.clientX, e.clientY, catId);
    });
    element.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showCatContextMenu(touch.clientX, touch.clientY, catId);
        }, 600);
    }, { passive: true });
    element.addEventListener('touchend', () => clearTimeout(longPressTimer));
    element.addEventListener('touchmove', () => clearTimeout(longPressTimer));
}

function showCatContextMenu(x, y, id) {
    contextCatId = id;
    catContextMenu.style.top = `${y}px`;
    catContextMenu.style.left = `${x}px`;
    // 화면 밖 보정 로직 (생략 가능하지만 있으면 좋음)
    if (x + 160 > window.innerWidth) catContextMenu.style.left = `${x - 160}px`;
    catContextMenu.classList.remove('hidden');
}

// [추가] 카테고리 이름 변경
function renameCategoryAction() {
    catContextMenu.classList.add('hidden');
    const cat = allCategories.find(c => c.id === contextCatId);
    if (!cat) return;
    
    const newName = prompt(`'${cat.name}'의 새로운 이름:`, cat.name);
    if (newName && newName.trim() !== "") {
        cat.name = newName.trim();
        saveCategories();
        renderTabs();
    }
}

// [추가] 카테고리 삭제
function deleteCategoryAction() {
    catContextMenu.classList.add('hidden');
    const cat = allCategories.find(c => c.id === contextCatId);
    if (!cat) return;

    // 최소 1개는 남겨두기 (선택사항)
    if (allCategories.length <= 1) return alert("최소 하나의 주제는 있어야 합니다.");

    if (confirm(`'${cat.name}' 주제를 삭제하시겠습니까?\n(포함된 글은 유지되지만 주제 분류가 사라질 수 있습니다.)`)) {
        allCategories = allCategories.filter(c => c.id !== contextCatId);
        categoryOrder = categoryOrder.filter(id => id !== contextCatId);
        
        // 현재 보고 있던 카테고리라면 첫 번째로 이동
        if (currentCategory === contextCatId) {
            currentCategory = allCategories[0].id;
        }
        
        saveCategories();
        renderTabs();
        renderEntries();
    }
}

// [추가] 카테고리 저장 헬퍼
function saveCategories() {
    localStorage.setItem('faithCategories', JSON.stringify(allCategories));
    localStorage.setItem('faithCatOrder', JSON.stringify(categoryOrder));
}

// [수정] addNewCategory
window.addNewCategory = () => {
    const name = prompt("새 주제 이름");
    if (name) {
        const id = 'custom_' + Date.now();
        allCategories.push({id, name});
        categoryOrder.push(id);
        saveCategories();
        renderTabs();
    }
};

function attachContextMenu(element, entryId) {
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, entryId);
    });
    element.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showContextMenu(touch.clientX, touch.clientY, entryId);
        }, 600);
    }, { passive: true });
    element.addEventListener('touchend', () => clearTimeout(longPressTimer));
    element.addEventListener('touchmove', () => clearTimeout(longPressTimer));
}

function showContextMenu(x, y, id) {
    contextTargetId = id;
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    const lockBtn = document.getElementById('ctx-lock');
    lockBtn.innerHTML = entry.isLocked ? '<i class="ph ph-lock-open"></i> 잠금 해제' : '<i class="ph ph-lock"></i> 잠그기';
    contextMenu.style.top = `${y}px`;
    contextMenu.style.left = `${x}px`;
    if (x + 160 > window.innerWidth) contextMenu.style.left = `${x - 160}px`;
    if (y + 160 > window.innerHeight) contextMenu.style.top = `${y - 160}px`;
    contextMenu.classList.remove('hidden');
}

function openMoveModal() {
    contextMenu.classList.add('hidden');
    moveModal.classList.remove('hidden');
    moveCategoryList.innerHTML = '';
    allCategories.forEach(cat => {
        const div = document.createElement('div');
        div.className = `cat-select-item ${currentCategory === cat.id ? 'current' : ''}`;
        div.innerText = cat.name;
        if (currentCategory !== cat.id) {
            div.onclick = async () => {
                await updateEntryField(contextTargetId, { category: cat.id });
                moveModal.classList.add('hidden');
                renderEntries();
            };
        }
        moveCategoryList.appendChild(div);
    });
}

function openLockModal() {
    contextMenu.classList.add('hidden');
    const entry = entries.find(e => e.id === contextTargetId);
    if (!entry) return;
    if (entry.isLocked) {
        lockModalTitle.innerText = "잠금 해제";
        lockModalDesc.innerText = "비밀번호를 입력하여 잠금을 해제합니다.";
    } else {
        lockModalTitle.innerText = "비밀번호 설정";
        lockModalDesc.innerText = "이 글을 열 때 사용할 비밀번호를 입력하세요.";
    }
    lockPwInput.value = '';
    lockModal.classList.remove('hidden');
    lockPwInput.focus();
}

async function confirmLock() {
    const pw = lockPwInput.value;
    const entry = entries.find(e => e.id === contextTargetId);
    if (!entry || !pw) return alert("비밀번호를 입력해주세요.");
    if (entry.isLocked) {
        if (entry.lockPassword === pw) {
            await updateEntryField(contextTargetId, { isLocked: false, lockPassword: null });
            alert("잠금이 해제되었습니다.");
            lockModal.classList.add('hidden');
            renderEntries();
        } else {
            alert("비밀번호가 일치하지 않습니다.");
        }
    } else {
        await updateEntryField(contextTargetId, { isLocked: true, lockPassword: pw });
        alert("글이 잠겼습니다.");
        lockModal.classList.add('hidden');
        renderEntries();
    }
}

async function duplicateEntry() {
    contextMenu.classList.add('hidden');
    const entry = entries.find(e => e.id === contextTargetId);
    if (!entry) return;
    const newEntry = { ...entry };
    delete newEntry.id;
    newEntry.title = `${entry.title} (복사본)`;
    newEntry.timestamp = Date.now();
    newEntry.modifiedAt = Date.now();
    newEntry.date = new Date().toLocaleDateString('ko-KR');
    try {
        if (currentUser) {
            await addDoc(collection(db, "users", currentUser.uid, "entries"), newEntry);
            await loadDataFromFirestore();
        } else {
            newEntry.id = 'copy_' + Date.now();
            entries.unshift(newEntry);
            localStorage.setItem('faithLogDB', JSON.stringify(entries));
        }
        renderEntries();
    } catch(e) { console.error(e); alert("복사 실패"); }
}

async function updateEntryField(id, data) {
    if (currentUser) {
        await updateDoc(doc(db, "users", currentUser.uid, "entries", id), data);
        await loadDataFromFirestore();
    } else {
        const index = entries.findIndex(e => e.id === id);
        if (index !== -1) {
            entries[index] = { ...entries[index], ...data };
            localStorage.setItem('faithLogDB', JSON.stringify(entries));
        }
    }
}

// ... (기존 헬퍼 함수들: handleSwipe, setReadMode, turnPage, updateBookNav 등 유지) ...
function handleSwipe() { const swipeThreshold = 50; if (touchEndX < touchStartX - swipeThreshold) turnPage(1); else if (touchEndX > touchStartX + swipeThreshold) turnPage(-1); }
function setReadMode(mode) { currentViewMode = mode; readModal.classList.remove('mode-focus', 'mode-book'); exitFocusBtn.classList.add('hidden'); bookNavLeft.classList.add('hidden'); bookNavRight.classList.add('hidden'); pageIndicator.classList.add('hidden'); readContentArea.style.transform = 'none'; modeBtnDefault.classList.remove('active'); modeBtnFocus.classList.remove('active'); modeBtnBook.classList.remove('active'); if (mode === 'default') { modeBtnDefault.classList.add('active'); } else if (mode === 'focus') { modeBtnFocus.classList.add('active'); readModal.classList.add('mode-focus'); exitFocusBtn.classList.remove('hidden'); } else if (mode === 'book') { modeBtnBook.classList.add('active'); readModal.classList.add('mode-book'); exitFocusBtn.classList.remove('hidden'); readContentArea.scrollLeft = 0; updateBookNav(); } }
function turnPage(direction) { if (currentViewMode !== 'book') return; const pageWidth = window.innerWidth; const currentScroll = readContentArea.scrollLeft; const newScroll = currentScroll + (direction * pageWidth); readContentArea.scrollTo({ left: newScroll, behavior: 'smooth' }); setTimeout(updateBookNav, 400); }
function updateBookNav() { if (currentViewMode !== 'book') return; const scrollLeft = readContentArea.scrollLeft; const scrollWidth = readContentArea.scrollWidth; const clientWidth = readContentArea.clientWidth; if (scrollLeft > 10) bookNavLeft.classList.remove('hidden'); else bookNavLeft.classList.add('hidden'); if (scrollLeft + clientWidth < scrollWidth - 10) bookNavRight.classList.remove('hidden'); else bookNavRight.classList.add('hidden'); const currentPage = Math.round(scrollLeft / clientWidth) + 1; const totalPages = Math.ceil(scrollWidth / clientWidth); pageIndicator.innerText = `${currentPage} / ${totalPages}`; pageIndicator.classList.remove('hidden'); }

function renderEntries(keyword = '') {
    entryList.innerHTML = '';
    const filtered = entries.filter(entry => !entry.isDeleted && entry.category === currentCategory && (entry.title.includes(keyword) || entry.body.includes(keyword)));
    filtered.sort((a, b) => { let valA, valB; if (currentSortBy === 'title') { valA = a.title; valB = b.title; } else if (currentSortBy === 'modified') { valA = a.modifiedAt || a.timestamp; valB = b.modifiedAt || b.timestamp; } else { valA = a.timestamp; valB = b.timestamp; } if (valA < valB) return currentSortOrder === 'asc' ? -1 : 1; if (valA > valB) return currentSortOrder === 'asc' ? 1 : -1; return 0; });
    
    if (filtered.length === 0) { entryList.innerHTML = `<div style="text-align:center; margin-top:100px; color:#aaa; font-family:'Pretendard';">기록이 없습니다.</div>`; return; }
    
    filtered.forEach(entry => {
        const div = document.createElement('article');
        div.className = 'entry-card';
        if (entry.isLocked) {
            div.innerHTML = `<h3 class="card-title"><i class="ph ph-lock-key"></i> ${entry.title}</h3><p class="card-subtitle" style="color:#aaa;">비공개 글입니다.</p><div class="card-meta"><span>${entry.date}</span></div>`;
            div.onclick = () => { contextTargetId = entry.id; openLockModal(); };
        } else {
            const dateStr = currentSortBy === 'modified' ? `수정: ${new Date(entry.modifiedAt || entry.timestamp).toLocaleDateString()}` : entry.date;
            div.innerHTML = `<h3 class="card-title">${entry.title}</h3>${entry.subtitle ? `<p class="card-subtitle">${entry.subtitle}</p>` : ''}<div class="card-meta"><span>${dateStr}</span></div>`;
            div.onclick = () => openReadModal(entry.id);
        }
        attachContextMenu(div, entry.id);
        entryList.appendChild(div);
    });
}

function openReadModal(id) { 
    const e = entries.find(x => x.id === id); if(!e) return; editingId = id; document.getElementById('read-title').innerText = e.title; document.getElementById('read-subtitle').innerText = e.subtitle||''; document.getElementById('read-date').innerText = e.date; const b = document.getElementById('read-body'); b.innerHTML = e.body; b.style.fontFamily = e.fontFamily||'Pretendard'; b.style.fontSize = (e.fontFamily==='Nanum Pen Script' ? (e.fontSize||16)+4 : (e.fontSize||16)) + 'px'; 
    document.getElementById('read-category').innerText = allCategories.find(c=>c.id===e.category)?.name || '기록'; 
    openModal(readModal);
    setReadMode('default'); 
}

window.changeGlobalFontSize = (delta) => { let s = currentFontSize + delta; if(s < 12) s = 12; if(s > 40) s = 40; applyFontStyle(currentFontFamily, s); };
window.changeSelectionFontSize = (delta) => { document.execCommand('styleWithCSS', false, true); if (delta > 0) { document.execCommand('fontSize', false, '5'); } else { document.execCommand('fontSize', false, '2'); } };
window.insertSticker = (emoji) => { const activeEl = document.activeElement; if (activeEl === editTitle || activeEl === editSubtitle) { const start = activeEl.selectionStart; const end = activeEl.selectionEnd; const text = activeEl.value; activeEl.value = text.substring(0, start) + emoji + text.substring(end); activeEl.selectionStart = activeEl.selectionEnd = start + emoji.length; } else { if(activeEl !== editBody) editBody.focus(); document.execCommand('insertText', false, emoji); } };
function renderStickers() { stickerGrid.innerHTML = stickers.map(s => `<span class="sticker-item" onmousedown="event.preventDefault(); insertSticker('${s}')">${s}</span>`).join(''); }
function applyFontStyle(f, s) { currentFontFamily = f; currentFontSize = s; editBody.style.fontFamily = f; editBody.style.fontSize = (f==='Nanum Pen Script' ? s+4 : s) + 'px'; fontSelector.value = f; }
function openEditor(m, d) { isEditMode = m; openModal(writeModal); if(m&&d) { editingId=d.id; editTitle.value=d.title; editSubtitle.value=d.subtitle; editBody.innerHTML=d.body; applyFontStyle(d.fontFamily||'Pretendard', d.fontSize||16); } else { editingId=null; editTitle.value=''; editSubtitle.value=''; editBody.innerHTML=''; applyFontStyle('Pretendard', 16); } editBody.focus(); }
function loadDataFromLocal() { entries = JSON.parse(localStorage.getItem('faithLogDB')) || []; }
async function loadDataFromFirestore() { if(!currentUser) return; entries = []; const q = query(collection(db, "users", currentUser.uid, "entries")); try { const querySnapshot = await getDocs(q); querySnapshot.forEach((doc) => { entries.push({ id: doc.id, ...doc.data() }); }); } catch (e) { console.error(e); } }
async function saveEntry() { const title = editTitle.value.trim(); const body = editBody.innerHTML; if(!title || !body || body === '<br>') return alert('제목과 본문을 모두 입력해주세요.'); const now = Date.now(); const entryData = { category: currentCategory, title, subtitle: editSubtitle.value.trim(), body, fontFamily: currentFontFamily, fontSize: currentFontSize, date: new Date().toLocaleDateString('ko-KR'), timestamp: now, modifiedAt: now, isDeleted: false }; try { if(currentUser) { if(isEditMode && editingId) { const docRef = doc(db, "users", currentUser.uid, "entries", editingId); const updateData = { ...entryData }; delete updateData.timestamp; await updateDoc(docRef, updateData); } else { await addDoc(collection(db, "users", currentUser.uid, "entries"), entryData); } await loadDataFromFirestore(); } else { entryData.id = isEditMode ? editingId : now; if (isEditMode) { const index = entries.findIndex(e => e.id === editingId); if (index !== -1) { entries[index] = { ...entries[index], ...entryData, timestamp: entries[index].timestamp, modifiedAt: now }; } } else { entries.unshift(entryData); } localStorage.setItem('faithLogDB', JSON.stringify(entries)); } history.back(); renderEntries(); } catch(e) { console.error("Save Error:", e); alert("저장에 실패했습니다. 잠시 후 다시 시도해주세요."); } }
async function moveToTrash(id) { if(!confirm('휴지통으로 이동하시겠습니까?')) return; if(currentUser){ const docRef = doc(db, "users", currentUser.uid, "entries", id); await updateDoc(docRef, { isDeleted: true }); await loadDataFromFirestore(); } else { const index = entries.findIndex(e => e.id === id); if(index !== -1) entries[index].isDeleted = true; localStorage.setItem('faithLogDB', JSON.stringify(entries)); } history.back(); renderEntries(); } 
window.permanentDelete = async (id) => { if(!confirm('영구 삭제하시겠습니까? (복구 불가)')) return; if(currentUser){ await deleteDoc(doc(db, "users", currentUser.uid, "entries", id)); await loadDataFromFirestore(); } else { entries = entries.filter(e => e.id !== id); localStorage.setItem('faithLogDB', JSON.stringify(entries)); } renderTrash(); }
window.restoreEntry = async (id) => { if(!confirm('이 글을 복구하시겠습니까?')) return; if(currentUser){ const docRef = doc(db, "users", currentUser.uid, "entries", id); await updateDoc(docRef, { isDeleted: false }); await loadDataFromFirestore(); } else { const index = entries.findIndex(e => e.id === id); if(index !== -1) entries[index].isDeleted = false; localStorage.setItem('faithLogDB', JSON.stringify(entries)); } renderTrash(); renderEntries(); }
function renderTrash() { trashList.innerHTML = ''; const deleted = entries.filter(e => e.isDeleted); if(deleted.length === 0) { trashList.innerHTML = `<div style="text-align:center; margin-top:50px; color:#aaa;">비어있음</div>`; return; } deleted.forEach(entry => { const div = document.createElement('div'); div.className = 'entry-card'; div.innerHTML = `<h3 class="card-title" style="text-decoration:line-through; color:#aaa;">${entry.title}</h3><div class="trash-actions"><button class="restore-btn" onclick="restoreEntry('${entry.id}')">복구</button><button class="perm-del-btn" onclick="permanentDelete('${entry.id}')">삭제</button></div>`; trashList.appendChild(div); }); }
function openTrashModal() { renderTrash(); openModal(trashModal); }
window.formatDoc = (c, v) => { document.execCommand(c, false, v); editBody.focus(); };
window.toggleStickerMenu = () => stickerPalette.classList.toggle('hidden');

init();