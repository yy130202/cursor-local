/* Cursor Local - 灵动岛（Agent 状态胶囊，spring 弹性展开） */
(function () {
  let el = null;
  let hideTimer = null;

  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'island hidden';
    el.innerHTML = '<span class="island-dot"></span><span class="island-text"></span>';
    document.body.appendChild(el);
    el.onclick = () => { if (typeof switchMode === 'function') switchMode('agents'); };
    return el;
  }

  window.updateIsland = function (state, text) {
    const e = ensure();
    clearTimeout(hideTimer);
    if (!state || state === 'idle') {
      e.classList.add('hidden');
      return;
    }
    e.className = 'island ' + state;
    e.querySelector('.island-text').textContent = text || '';
    void e.offsetWidth; // 强制 reflow，确保 transition 生效
    e.classList.remove('hidden');
    if (state === 'done' || state === 'error') {
      hideTimer = setTimeout(() => e.classList.add('hidden'), 2200);
    }
  };
})();
