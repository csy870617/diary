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

// 반환된 Promise는 SSO 응답을 받았거나(성공/무응답 판별 후) 타임아웃되면 resolve된다.
// 호출부(script.js)는 이 Promise를 기다린 뒤에 로그인 모달 표시 여부를 판단해,
// 부모 창의 응답이 늦게 도착해 모달이 잠깐 떴다가 닫히는 깜빡임을 방지한다.
export function initFaithsSSO() {
    if (window.parent === window) return Promise.resolve(); // FAITHS iframe 안이 아니면 아무것도 하지 않음
    if (localStorage.getItem('is_faith_logged_in') === 'true') return Promise.resolve(); // 이미 로그인됨
    if (localStorage.getItem('faith_user_email')) return Promise.resolve(); // 이미 아는 사용자(로그인 모달 안 뜸)

    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onMsg);
            clearTimeout(timer);
            resolve();
        };
        function onMsg(e) {
            if (e.origin !== FAITHS_ORIGIN) return;
            if (!e.data || e.data.type !== 'faiths-google-idtoken' || !e.data.idToken) return;
            const email = decodeIdTokenEmail(e.data.idToken);
            if (email) localStorage.setItem('faith_user_email', email);
            const loginModal = document.getElementById('login-modal');
            if (loginModal) loginModal.classList.add('hidden');
            finish();
        }
        window.addEventListener('message', onMsg);
        window.parent.postMessage({ type: 'faiths-request-idtoken' }, FAITHS_ORIGIN);
        // 부모 창이 응답하지 않는 경우 무한 대기하지 않도록 타임아웃 후 리스너 정리
        const timer = setTimeout(finish, 2000);
    });
}
