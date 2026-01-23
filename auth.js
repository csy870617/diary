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
        googleLoginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleAuthClick(); // drive.js의 로그인 트리거
            // 인증 팝업 호출 후 즉시 닫지 않고, 성공 콜백에서 처리하도록 수정
        });
    }

    // [추가] drive.js에서 인증이 성공했을 때 호출될 글로벌 함수
    window.onAuthSuccess = () => {
        closeAllModals(true);
        console.log("구글 인증 성공: 모달을 닫습니다.");
    };

    // 로그아웃 버튼
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
    
    // 모달 닫기
    const closeLoginBtn = document.getElementById('close-login-btn');
    if(closeLoginBtn) closeLoginBtn.addEventListener('click', () => closeAllModals(true));
}