import { handleAuthClick, handleSignoutClick } from './drive.js';
import { openModal, closeAllModals } from './ui.js';

export function setupAuthListeners() {
    // 1. 헤더 동기화 버튼
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    if(loginTriggerBtn) {
        loginTriggerBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openModal(document.getElementById('login-modal'));
        });
    }

    // 2. [웨일 최적화] 구글 로그인 버튼
    const googleLoginBtn = document.getElementById('google-login-btn');
    if(googleLoginBtn) {
        googleLoginBtn.addEventListener('click', (e) => {
            // 즉시 이벤트 전파를 중단하고 인증창을 호출하여 브라우저의 의심을 피합니다.
            e.preventDefault();
            e.stopImmediatePropagation();
            handleAuthClick(); 
        });
    }

    // 성공 시 실행될 콜백
    window.onAuthSuccess = () => {
        closeAllModals(true);
        console.log("동기화 로그인 성공");
    };

    // 3. 로그아웃
    const logoutBtn = document.getElementById('logout-btn');
    if(logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if(confirm("로그아웃 하시겠습니까? 세션이 종료됩니다.")) {
                handleSignoutClick(() => {
                    location.reload(); 
                });
            }
        });
    }
    
    // 4. 모달 닫기
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) {
        closeLoginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            closeAllModals(true);
        });
    }
}