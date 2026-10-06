/* Cursor Local - 用户系统 UI（登录/注册/用户信息） */
let currentUser = null;
let authMode = 'login';

/* escapeHtml 已上移至 core.js（CL.util.escapeHtml），避免重复定义。 */

async function initAuth() {
  try {
    currentUser = await window.api.auth.current();
  } catch { currentUser = null; }
  renderUserArea();
  bindAuthUI();
}

function refreshIcons() {
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons({ icons: window.lucide.icons });
}

function renderUserArea() {
  const area = document.getElementById('user-area');
  if (currentUser) {
    const initial = (currentUser.username || '?')[0].toUpperCase();
    area.innerHTML =
      '<button class="avatar-btn" id="user-btn" title="' + CL.util.escapeHtml(currentUser.username) + '">' +
        '<span class="avatar">' + CL.util.escapeHtml(initial) + '</span>' +
      '</button>';
    document.getElementById('user-btn').onclick = (e) => {
      e.stopPropagation();
      const menu = document.getElementById('user-menu');
      menu.classList.toggle('hidden');
      document.getElementById('theme-panel').classList.add('hidden');
    };
  } else {
    area.innerHTML =
      '<button class="action" id="login-btn"><i data-lucide="log-in"></i><span>登录</span></button>';
    document.getElementById('login-btn').onclick = () => showAuthModal('login');
    refreshIcons();
  }
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  menu.classList.toggle('hidden');
}

function showAuthModal(mode) {
  authMode = mode;
  document.getElementById('auth-title').textContent = mode === 'login' ? '登录' : '注册';
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('auth-email-field').classList.toggle('hidden', mode !== 'register');
  document.getElementById('auth-submit').textContent = mode === 'login' ? '登录' : '注册';
  document.getElementById('auth-account').placeholder = mode === 'login' ? '用户名或邮箱' : '用户名';
  document.getElementById('auth-error').classList.add('hidden');
  document.getElementById('auth-form').reset();
  document.getElementById('auth-modal').classList.remove('hidden');
  document.getElementById('auth-account').focus();
}

function hideAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
  document.getElementById('auth-error').classList.add('hidden');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function bindAuthUI() {
  document.getElementById('tab-login').onclick = () => showAuthModal('login');
  document.getElementById('tab-register').onclick = () => showAuthModal('register');

  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const account = document.getElementById('auth-account').value.trim();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!account || !password) { showAuthError('请填写用户名/邮箱和密码'); return; }
    let res;
    if (authMode === 'login') {
      res = await window.api.auth.login({ account, password });
    } else {
      res = await window.api.auth.register({ username: account, email, password });
    }
    if (res.ok) {
      currentUser = res.user;
      hideAuthModal();
      renderUserArea();
    } else {
      showAuthError(res.error || '操作失败');
    }
  };

  document.getElementById('auth-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('auth-modal')) hideAuthModal();
  });

  // 用户菜单
  document.getElementById('logout-btn').onclick = async () => {
    await window.api.auth.logout();
    currentUser = null;
    document.getElementById('user-menu').classList.add('hidden');
    renderUserArea();
  };
  document.addEventListener('click', () => document.getElementById('user-menu').classList.add('hidden'));
  document.getElementById('user-menu').addEventListener('click', (e) => e.stopPropagation());
}
