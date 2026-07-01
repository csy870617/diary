// FAITHS(부모 앱 내부 브라우저)에서 구글 로그인이 되어 있으면 ID 토큰을 postMessage로 받아
// 이 앱의 로그인 모달을 자동으로 건너뛴다.
// 주의: idToken은 신원 확인용일 뿐 Drive 접근 권한(access token)이 아니므로,
// 실제 구글 드라이브 동기화는 기존 로그인 버튼을 통해 별도로 이루어진다.
const FAITHS_ORIGIN = 'https://csy870617.github.io';

function decodeIdTokenEmail(idToken) {
    try {
        const payload = idToken.split('.')[1];
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(decodeURIComponent(escape(json))).email || '';
    } catch (e) {
        return '';
    }
}

export function initFaithsSSO() {
    if (window.parent === window) return; // FAITHS iframe 안이 아니면 아무것도 하지 않음
    if (localStorage.getItem('is_faith_logged_in') === 'true') return; // 이미 로그인됨
    if (localStorage.getItem('faith_user_email')) return; // 이미 아는 사용자(로그인 모달 안 뜸)

    function onMsg(e) {
        if (e.origin !== FAITHS_ORIGIN) return;
        if (!e.data || e.data.type !== 'faiths-google-idtoken' || !e.data.idToken) return;
        window.removeEventListener('message', onMsg);
        const email = decodeIdTokenEmail(e.data.idToken);
        if (email) localStorage.setItem('faith_user_email', email);
        const loginModal = document.getElementById('login-modal');
        if (loginModal) loginModal.classList.add('hidden');
    }
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: 'faiths-request-idtoken' }, FAITHS_ORIGIN);
}
