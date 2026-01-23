import { handleAuthClick, handleSignoutClick } from './drive.js';
import { openModal, closeAllModals } from './ui.js';

export function setupAuthListeners() {
    // 1. 헤더의 동기화 버튼 클릭 시 모달 열기
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    if(loginTriggerBtn) {
        loginTriggerBtn.addEventListener('click', () => {
            openModal(document.getElementById('login-modal'));
        });
    }

    // 2. 모달 내 구글 버튼 클릭 (팝업이 차단되지 않도록 로직 분리)
    const googleLoginBtn = document.getElementById('google-login-btn');
    if(googleLoginBtn) {
        googleLoginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            // handleAuthClick만 호출하고, UI 닫기는 drive.js에서 성공 후 수행
            handleAuthClick(); 
        });
    }

    /**
     * drive.js에서 인증이 성공했을 때 호출할 콜백
     */
    window.onAuthSuccess = () => {
        closeAllModals(true);
        alert("구글 동기화가 활성화되었습니다.");
    };

    // 3. 로그아웃 버튼
    const logoutBtn = document.getElementById('logout-btn');
    if(logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if(confirm("로그아웃 하시겠습니까? 클라우드 동기화가 중단됩니다.")) {
                handleSignoutClick(() => {
                    location.reload(); 
                });
            }
        });
    }
    
    // 4. 로그인 모달 닫기
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) closeLoginBtn.addEventListener('click', () => closeAllModals(true));
}