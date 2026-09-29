/* Cursor Local - 锁屏启动页（Windows 13 式：全屏渐变 + 时钟 + 玻璃卡片，任意键进入） */
(function () {
  let shown = false;
  let timer = null;

  function pad(n) { return String(n).padStart(2, '0'); }

  function tick() {
    const el = document.getElementById('ls-clock');
    if (!el) return;
    const d = new Date();
    el.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const de = document.getElementById('ls-date');
    if (de) de.textContent = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }

  function leave() {
    const el = document.getElementById('lockscreen');
    if (!el || el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    window.removeEventListener('keydown', onKey, true);
    setTimeout(() => el.remove(), 650);
  }

  function onKey(e) { e.preventDefault(); e.stopPropagation(); leave(); }

  window.showLockscreen = function () {
    if (shown) return;
    shown = true;
    const el = document.createElement('div');
    el.id = 'lockscreen';
    el.innerHTML =
      '<div class="ls-center">' +
        '<div class="ls-clock" id="ls-clock">--:--</div>' +
        '<div class="ls-date" id="ls-date"></div>' +
        '<div class="ls-card"><span class="ls-ico">' + (window.lucideIcon ? window.lucideIcon('sparkles') : '') + '</span><span>按任意键进入 Cursor Local</span></div>' +
      '</div>' +
      '<div class="ls-footer"><span>Cursor Local</span><span id="ls-status"></span></div>';
    document.body.appendChild(el);
    tick();
    timer = setInterval(tick, 1000);
    el.addEventListener('click', leave);
    // 延迟 400ms 再监听按键，避免启动瞬间的按键立即关闭
    setTimeout(() => window.addEventListener('keydown', onKey, true), 400);
    // 退场后停止时钟
    setTimeout(() => { if (!document.getElementById('lockscreen')) clearInterval(timer); }, 1000);
  };
})();
