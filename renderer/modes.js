/* Cursor Local - Agent 模式选择（参考 CodeBuddy：Craft / Ask / Plan） */
(function () {
  const MODES = [
    { id: 'craft', name: 'Craft', icon: 'hammer', desc: '完整执行：读写代码、跑命令' },
    { id: 'ask', name: 'Ask', icon: 'message-circle-question', desc: '只问答解释，不修改文件' },
    { id: 'plan', name: 'Plan', icon: 'list-checks', desc: '只输出实施计划' }
  ];
  window.__agentMode = 'craft';

  function updateTexts() {
    const m = MODES.find((x) => x.id === window.__agentMode) || MODES[0];
    ['home-mode-text', 'agents-mode-text'].forEach((sid) => {
      const el = document.getElementById(sid);
      if (el) el.textContent = m.name;
    });
  }

  function toggleMenu(anchor) {
    const existing = document.getElementById('mode-panel');
    if (existing) { existing.remove(); return; }
    const panel = document.createElement('div');
    panel.id = 'mode-panel';
    panel.className = 'mode-panel';
    panel.innerHTML = MODES.map((m) =>
      '<div class="mode-item' + (m.id === window.__agentMode ? ' active' : '') + '" data-id="' + m.id + '">' +
        '<span class="mi-ico">' + (window.lucideIcon(m.icon) || '') + '</span>' +
        '<span class="mi-body"><span class="mi-name">' + m.name + '</span><span class="mi-desc">' + m.desc + '</span></span>' +
        (m.id === window.__agentMode ? '<span class="mi-check">✓</span>' : '') +
      '</div>'
    ).join('');
    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    panel.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    panel.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
    panel.querySelectorAll('.mode-item').forEach((n) => {
      n.onclick = () => {
        window.__agentMode = n.dataset.id;
        panel.remove();
        updateTexts();
        flashStatus('已切换模式：' + MODES.find((x) => x.id === window.__agentMode).name);
      };
    });
    setTimeout(() => document.addEventListener('mousedown', (e) => { if (!panel.contains(e.target)) panel.remove(); }), 0);
  }

  (function bind() {
    ['home-mode-chip', 'agents-mode-chip'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.onclick = (e) => { e.stopPropagation(); toggleMenu(el); };
    });
    updateTexts();
  })();
})();
