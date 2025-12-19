import { handleAuthClick, handleSignoutClick } from './drive.js';
import { openModal, closeAllModals } from './ui.js';

export function setupAuthListeners() {
    // 헤더의 '구글 로그인' 버튼
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    if(loginTriggerBtn) {
        loginTriggerBtn.addEventListener('click', () => {
            openModal(document.getElementById('login-modal'));
        });
    }

    // 모달 내부의 '구글로 계속하기' 버튼
    const googleLoginBtn = document.getElementById('google-login-btn');
    if(googleLoginBtn) {
        googleLoginBtn.addEventListener('click', () => {
            handleAuthClick(); // drive.js의 로그인 트리거
            closeAllModals(true);
        });
    }

    // 로그아웃 버튼
    const logoutBtn = document.getElementById('logout-btn');
    if(logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if(confirm("로그아웃 하시겠습니까?")) {
                handleSignoutClick(() => {
                    alert("로그아웃 되었습니다.");
                    location.reload(); // 상태 초기화를 위해 새로고침
                });
            }
        });
    }
    
    // 모달 닫기
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) closeLoginBtn.addEventListener('click', () => closeAllModals(true));
}