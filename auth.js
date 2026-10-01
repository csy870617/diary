import { handleAuthClick, handleSignoutClick } from './drive.js';
import { openModal, closeAllModals } from './ui.js';

let authListenersInitialized = false;

export function setupAuthListeners() {
    // 재호출 시 리스너/전역 콜백이 중복 등록되는 것을 방지
    if (authListenersInitialized) return;
    authListenersInitialized = true;

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
    // 로그인 창만 닫는다. 예전에는 열린 창을 모두 닫아서, 재접속 직후 백그라운드로
    // 토큰을 갱신·동기화하는 1~2초 사이에 열어 둔 글이 목록으로 튕겨 나갔다.
    window.onAuthSuccess = () => {
        const loginModal = document.getElementById('login-modal');
        if (!loginModal || loginModal.classList.contains('hidden')) return;
        loginModal.classList.add('hidden');
        // 글·휴지통 등 다른 창이 열려 있으면 그 창의 뒤로가기 기록은 그대로 둔다
        const otherOpen = ['write-modal', 'trash-modal', 'move-modal']
            .some(id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
        if (!otherOpen && history.state && history.state.modal === 'open') {
            history.replaceState({ modal: 'main' }, null, '');
        }
        console.log("구글 인증 성공: 로그인 창을 닫습니다.");
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