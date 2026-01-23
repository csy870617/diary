import { handleAuthClick, handleSignoutClick } from './drive.js';
import { openModal, closeAllModals } from './ui.js';

export function setupAuthListeners() {
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    if(loginTriggerBtn) {
        loginTriggerBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openModal(document.getElementById('login-modal'));
        });
    }

    const googleLoginBtn = document.getElementById('google-login-btn');
    if(googleLoginBtn) {
        googleLoginBtn.addEventListener('click', (e) => {
            // [웨일 대응] 기본 동작과 전파를 확실히 차단하여 팝업이 잘 뜨게 함
            e.preventDefault();
            e.stopPropagation();
            console.log("구글 인증 팝업 요청...");
            handleAuthClick(); 
        });
    }

    // drive.js와 연동되는 성공 콜백
    window.onAuthSuccess = () => {
        closeAllModals(true);
        // 사용자에게 성공을 알림 (웨일 브라우저 확인용)
        console.log("구글 로그인 성공 및 UI 업데이트");
    };

    const logoutBtn = document.getElementById('logout-btn');
    if(logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if(confirm("로그아웃 하시겠습니까?")) {
                handleSignoutClick(() => {
                    location.reload(); 
                });
            }
        });
    }
    
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) {
        closeLoginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            closeAllModals(true);
        });
    }
}