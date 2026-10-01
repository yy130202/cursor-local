/* Cursor Local - 模型选择下拉（参考 CodeBuddy：倍率标签 + 自定义入口） */
(function () {
  const MODEL_LIST = [
    { id: 'deepseek-chat', name: 'DeepSeek-V3', meta: '1.0x' },
    { id: 'deepseek-reasoner', name: 'DeepSeek-R1 推理', meta: '4.0x' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', meta: '1.0x' },
    { id: 'gpt-4o', name: 'GPT-4o', meta: '5.0x' },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', meta: '3.0x' },
    { id: 'qwen-plus', name: '通义千问 Plus', meta: '0.8x' },
    { id: 'glm-4-flash', name: 'GLM-4-Flash', meta: '限时免费' },
    { id: 'kimi-k2', name: 'Kimi K2', meta: '限时免费' }
  ];

  window.modelDisplayName = function (id) {
    if (!id) return '-';
    const m = MODEL_LIST.find((x) => x.id === id);
    return m ? m.name : id;
  };

  async function currentModel() {
    try { return (await window.api.getConfig()).model || ''; } catch { return ''; }
  }

  async function applyModelText() {
    const id = await currentModel();
    const name = window.modelDisplayName(id);
    ['home-model-text', 'agents-model-text'].forEach((sid) => {
      const el = document.getElementById(sid);
      if (el) el.textContent = name;
    });
    const sm = document.getElementById('stat-model');
    if (sm) sm.textContent = name;
  }

  async function toggleModelMenu(anchor) {
    const existing = document.getElementById('model-panel');
    if (existing) { existing.remove(); return; }
    const cur = await currentModel();
    const panel = document.createElement('div');
    panel.id = 'model-panel';
    panel.className = 'model-panel';
    const row = (id, name, meta, active) =>
      '<div class="model-item' + (active ? ' active' : '') + '" data-id="' + id + '">' +
        '<span class="model-name">' + name + '</span>' +
        (meta ? '<span class="model-tag' + (meta === '限时免费' ? ' free' : '') + '">' + meta + '</span>' : '') +
        (active ? '<span class="model-check">✓</span>' : '') +
      '</div>';
    let items = MODEL_LIST.map((m) => row(m.id, m.name, m.meta, m.id === cur)).join('');
    if (cur && !MODEL_LIST.some((m) => m.id === cur)) {
      items = row(cur, cur + '（自定义）', '', true) + items;
    }
    panel.innerHTML =
      '<div class="model-title">选择模型</div>' +
      '<div class="model-list">' + items + '</div>' +
      '<div class="model-footer"><button class="model-custom-btn">自定义模型…</button></div>';
    document.body.appendChild(panel);
    const r = anchor.getBoundingClientRect();
    panel.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    panel.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
    panel.querySelectorAll('.model-item').forEach((n) => {
      n.onclick = async () => {
        const id = n.dataset.id;
        panel.remove();
        await window.api.setConfig({ model: id });
        flashStatus('已切换模型：' + window.modelDisplayName(id));
        await applyModelText();
        if (typeof refreshStatusBar === 'function') refreshStatusBar(await window.api.getConfig());
      };
    });
    panel.querySelector('.model-custom-btn').onclick = () => {
      panel.remove();
      const b = document.getElementById('settings-btn');
      if (b) b.click();
    };
    setTimeout(() => document.addEventListener('mousedown', (e) => { if (!panel.contains(e.target)) panel.remove(); }), 0);
  }

  (function bind() {
    const hc = document.getElementById('home-model-chip');
    const ac = document.getElementById('agents-model-chip');
    if (hc) hc.onclick = (e) => { e.stopPropagation(); toggleModelMenu(hc); };
    if (ac) ac.onclick = (e) => { e.stopPropagation(); toggleModelMenu(ac); };
    applyModelText();
  })();
})();
