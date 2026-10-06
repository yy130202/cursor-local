/* Cursor Local - 首次运行协议同意
 *
 * 【职责】应用启动时，若本机尚未同意当前版本的条款，则弹出确认框；
 *        用户勾选后方可继续；条款标题可点开查看完整法律页面。
 * 【存储】localStorage（仅本机，不上传）：{ version, acceptedAt }
 * 【版本联动】条款版本号变更时重新征求同意，避免用户沿用旧版本的认知。
 */
(function () {
  const STORAGE_KEY = 'cl_consent';
  const TERMS_VERSION = '0.1.0';

  let modal, checkbox, acceptBtn;

  /** 读取本机的同意记录（版本不一致视为未同意） */
  function readConsent() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return rec && rec.version === TERMS_VERSION ? rec : null;
    } catch { return null; }
  }

  function writeConsent() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: TERMS_VERSION, acceptedAt: Date.now() }));
    } catch { /* 隐私模式下可能失败：不阻塞使用 */ }
  }

  function open() {
    if (!modal) return;
    modal.classList.remove('hidden');
    checkbox.checked = false;
    acceptBtn.disabled = true;
    // 聚焦到勾选框，键盘用户可直接操作
    setTimeout(() => checkbox.focus(), 60);
  }

  function close() {
    modal.classList.add('hidden');
  }

  function init() {
    modal = document.getElementById('consent-modal');
    checkbox = document.getElementById('consent-checkbox');
    acceptBtn = document.getElementById('consent-accept');
    const exitBtn = document.getElementById('consent-exit');
    const verEl = document.getElementById('consent-ver');
    if (!modal || !checkbox || !acceptBtn) return;

    if (verEl) verEl.textContent = '条款版本 v' + TERMS_VERSION;

    // 勾选 → 启用「同意」按钮
    checkbox.onchange = () => { acceptBtn.disabled = !checkbox.checked; };
    // 点击文字区域也能切换勾选（label 已包住整个区域，此处兜底键盘操作）
    checkbox.onkeydown = (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        checkbox.checked = !checkbox.checked;
        acceptBtn.disabled = !checkbox.checked;
      }
    };

    // 同意 → 记录并进入
    acceptBtn.onclick = () => {
      if (!checkbox.checked) return;
      writeConsent();
      close();
      window.flashStatus && window.flashStatus('已同意条款 v' + TERMS_VERSION);
    };

    // 不同意 → 退出应用
    if (exitBtn) exitBtn.onclick = () => window.api && window.api.quit && window.api.quit();

    // 三个条款卡片 → 打开法律页
    modal.querySelectorAll('[data-legal]').forEach((n) => {
      n.onclick = () => window.api && window.api.openLegal && window.api.openLegal();
    });

    // 自动化环境（截图 / 回归 / 诊断）不弹框，避免遮挡界面阻塞测试
    const env = window.__ENV__ || {};
    if ((env.shotMode || env.testMode) && !env.keepConsent) {
      writeConsent();
      close();
      return;
    }

    // 首次运行（无记录 / 版本变更）才拦截
    if (!readConsent()) open();
    else close();
  }

  // DOM 就绪后初始化（index.html 中 script 位于 body 末尾）
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.CL = window.CL || {};
  window.CL.consent = { TERMS_VERSION, open, reread: readConsent };
})();
