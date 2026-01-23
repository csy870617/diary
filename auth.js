import { handleAuthClick, handleSignoutClick } from './drive.js';
import { openModal, closeAllModals } from './ui.js';

export function setupAuthListeners() {
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    if(loginTriggerBtn) {
        loginTriggerBtn.addEventListener('click', () => {
            openModal(document.getElementById('login-modal'));
        });
    }

    const googleLoginBtn = document.getElementById('google-login-btn');
    if(googleLoginBtn) {
        googleLoginBtn.addEventListener('click', () => {
            // [수정] 모달을 미리 닫지 않고, 인증이 성공하면 닫도록 핸들러 등록
            handleAuthClick(); 
        });
    }

    // drive.js에서 인증 성공 시 호출할 글로벌 콜백 정의
    window.onAuthSuccess = () => {
        closeAllModals(true);
    };

    const logoutBtn = document.getElementById('logout-btn');
    if(logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if(confirm("로그아웃 하시겠습니까?")) {
                handleSignoutClick(() => {
                    location.reload(); 
                });
            }
        });
    }
    
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) closeLoginBtn.addEventListener('click', () => closeAllModals(true));
}