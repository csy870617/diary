import { handleAuthClick, handleSignoutClick } from './drive.js';
import { openModal, closeAllModals } from './ui.js';

export function setupAuthListeners() {
    // 헤더의 '동기화' 버튼 → 바로 구글 계정 선택 화면 호출
    const loginTriggerBtn = document.getElementById('login-trigger-btn');
    if(loginTriggerBtn) {
        loginTriggerBtn.addEventListener('click', () => {
            handleAuthClick(); // 바로 구글 로그인 팝업 호출
        });
    }

    // 모달 내부의 '구글로 계속하기' 버튼 (모달에서도 동작하도록 유지)
    const googleLoginBtn = document.getElementById('google-login-btn');
    if(googleLoginBtn) {
        googleLoginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleAuthClick();
        });
    }

    // [추가] drive.js에서 인증이 성공했을 때 호출될 글로벌 함수
    // history.back() 대신 replaceState로 히스토리 정리 (모바일 popstate 루프 방지)
    window.onAuthSuccess = () => {
        closeAllModals(false);
        if (history.state && history.state.modal === 'open') {
            history.replaceState({ modal: 'main' }, null, '');
        }
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