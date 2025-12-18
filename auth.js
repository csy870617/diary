import { auth } from './firebase.js';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { closeAllModals, openModal } from './ui.js';

export function setupAuthListeners() {
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    if(loginTriggerBtn) loginTriggerBtn.addEventListener('click', () => openModal(document.getElementById('login-modal')));

    const loginForm = document.getElementById('login-form');
    if(loginForm) loginForm.addEventListener('submit', async (e) => { 
        e.preventDefault(); 
        try { 
            const persistence = document.getElementById('save-id-check').checked ? browserLocalPersistence : browserSessionPersistence;
            await setPersistence(auth, persistence); 
            await signInWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-pw').value); 
            closeAllModals(true); 
        } catch (error) { alert("로그인 정보를 다시 확인해주세요."); } 
    });
    
    const signupBtn = document.getElementById('signup-btn');
    if(signupBtn) signupBtn.addEventListener('click', async (e) => { 
        e.preventDefault(); 
        try { 
            await createUserWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-pw').value); 
            alert('가입 완료되었습니다.'); 
        } catch (error) { alert("실패: " + error.message); } 
    });

    const logoutBtn = document.getElementById('logout-btn');
    if(logoutBtn) logoutBtn.addEventListener('click', () => { if(confirm("로그아웃 하시겠습니까?")) signOut(auth); });

    const forgotPwBtn = document.getElementById('forgot-pw-btn');
    if(forgotPwBtn) forgotPwBtn.addEventListener('click', (e) => { e.preventDefault(); openModal(document.getElementById('reset-pw-modal')); });
}