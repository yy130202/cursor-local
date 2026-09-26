/* Cursor Local - 命令面板（Ctrl+Shift+P）+ 全局搜索（Ctrl+Shift+F） */
(function () {
  /* ---- 命令注册表（分组 + 快捷键提示） ---- */
  const commands = [
    { id: 'home', title: '回到主页', icon: 'home', group: '导航', key: '', action: () => switchMode('home') },
    { id: 'editor', title: '切换到编辑器', icon: 'file-code-2', group: '导航', key: '', action: () => switchMode('editor') },
    { id: 'agents', title: '切换到 Agents 工作台', icon: 'bot', group: '导航', key: '', action: () => switchMode('agents') },
    { id: 'open-folder', title: '打开文件夹', icon: 'folder-open', group: '文件', key: '', action: () => openFolder() },
    { id: 'search', title: '全局搜索', icon: 'search', group: '文件', key: 'Ctrl+Shift+F', action: () => openGlobalSearch() },
    { id: 'save', title: '保存当前文件', icon: 'save', group: '文件', key: 'Ctrl+S', action: () => { if (typeof saveActive === 'function') saveActive(); } },
    { id: 'inline', title: '内联改写选中代码', icon: 'message-square', group: 'AI', key: 'Ctrl+I', action: () => window.openInlineChat && window.openInlineChat() },
    { id: 'diagnose', title: 'AI 代码诊断', icon: 'stethoscope', group: 'AI', key: 'Ctrl+Alt+D', action: () => window.openDiagnose && window.openDiagnose() },
    { id: 'new-agent', title: '新建 Agent 任务', icon: 'plus', group: 'Agent', key: '', action: () => { switchMode('agents'); const i = document.getElementById('followup-input'); if (i) i.focus(); } },
    { id: 'git', title: '打开 Git 面板', icon: 'git-branch', group: '视图', key: '', action: () => window.openGitPanel && window.openGitPanel() },
    { id: 'terminal', title: '打开终端', icon: 'terminal', group: '视图', key: '', action: () => window.openTerminal && window.openTerminal() },
    { id: 'theme', title: '切换下一个主题', icon: 'palette', group: '视图', key: '', action: () => cycleTheme() },
    { id: 'settings', title: '打开设置', icon: 'settings', group: '视图', key: '', action: () => openSettings() }
  ];

  function cycleTheme() {
    const keys = Object.keys(typeof PRESETS !== 'undefined' ? PRESETS : {});
    if (!keys.length) return;
    const cur = (typeof currentTheme !== 'undefined' && currentTheme) ? currentTheme.preset : null;
    const idx = keys.indexOf(cur);
    const next = keys[(idx + 1) % keys.length];
    if (typeof setTheme === 'function') setTheme(next, null);
  }

  /* ---- 命令面板 ---- */
  let paletteEl = null;
  function ensurePalette() {
    if (paletteEl) return paletteEl;
    paletteEl = document.createElement('div');
    paletteEl.className = 'cmd-palette';
    paletteEl.innerHTML = '<input class="cp-input" placeholder="输入命令…（↑↓ 选择，Enter 执行，Esc 关闭）"><div class="cp-list"></div>';
    document.body.appendChild(paletteEl);
    return paletteEl;
  }
  /* 模糊匹配评分：0 完全 / 1 前缀 / 2 包含 / 3 子序列 / -1 不匹配 */
  function fuzzyScore(text, kw) {
    if (!kw) return 0;
    const t = text.toLowerCase();
    if (t === kw) return 0;
    if (t.startsWith(kw)) return 1;
    if (t.includes(kw)) return 2;
    let i = 0;
    for (let j = 0; j < t.length && i < kw.length; j++) if (t[j] === kw[i]) i++;
    return i === kw.length ? 3 : -1;
  }
  function renderPalette(q) {
    const list = paletteEl.querySelector('.cp-list');
    const kw = (q || '').trim().toLowerCase();
    const matched = commands
      .map((c) => {
        const s1 = fuzzyScore(c.title, kw);
        const s2 = fuzzyScore(c.id, kw);
        const score = s1 === -1 ? s2 : (s2 === -1 ? s1 : Math.min(s1, s2));
        return { c, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.c);
    list.innerHTML = '';
    let lastGroup = null;
    let idx = 0;
    matched.forEach((c) => {
      if (c.group && c.group !== lastGroup) {
        lastGroup = c.group;
        const g = document.createElement('div');
        g.className = 'cp-group';
        g.textContent = c.group;
        list.appendChild(g);
      }
      const item = document.createElement('div');
      item.className = 'cp-item' + (idx === 0 ? ' active' : '');
      item.innerHTML =
        '<span class="cp-ico">' + (window.lucideIcon(c.icon) || '') + '</span>' +
        '<span class="cp-title">' + escapeHtml(c.title) + '</span>' +
        (c.key ? '<span class="cp-key">' + escapeHtml(c.key) + '</span>' : '');
      item.onclick = () => { closePalette(); c.action(); };
      list.appendChild(item);
      idx++;
    });
  }
  function openPalette() {
    ensurePalette();
    paletteEl.classList.remove('hidden');
    const input = paletteEl.querySelector('.cp-input');
    input.value = '';
    renderPalette('');
    input.focus();
    input.oninput = () => renderPalette(input.value);
    input.onkeydown = (e) => {
      const items = paletteEl.querySelectorAll('.cp-item');
      let idx = -1;
      items.forEach((it, i) => { if (it.classList.contains('active')) idx = i; });
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(items, (idx + 1) % items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(items, (idx - 1 + items.length) % items.length); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) items[idx].click(); }
      else if (e.key === 'Escape') { closePalette(); }
    };
  }
  function setActive(items, idx) {
    items.forEach((it, i) => it.classList.toggle('active', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  }
  function closePalette() { if (paletteEl) paletteEl.classList.add('hidden'); }

  /* ---- 全局搜索 ---- */
  let searchEl = null, searchTimer = null;
  function ensureSearch() {
    if (searchEl) return searchEl;
    searchEl = document.createElement('div');
    searchEl.className = 'cmd-palette search-panel';
    searchEl.innerHTML =
      '<input class="cp-input" placeholder="搜索当前文件夹…（Enter 触发，Esc 关闭）">' +
      '<div class="sr-summary"></div><div class="sr-list"></div>';
    document.body.appendChild(searchEl);
    return searchEl;
  }
  function openGlobalSearch() {
    ensureSearch();
    if (!EditorState.currentFolder) { flashStatus('请先打开文件夹'); return; }
    searchEl.classList.remove('hidden');
    const input = searchEl.querySelector('.cp-input');
    input.value = '';
    input.focus();
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(input.value); }
      else if (e.key === 'Escape') { searchEl.classList.add('hidden'); }
    };
    input.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(input.value), 400);
    };
  }
  async function runSearch(q) {
    const kw = (q || '').trim();
    const list = searchEl.querySelector('.sr-list');
    const summary = searchEl.querySelector('.sr-summary');
    if (!kw) { list.innerHTML = ''; summary.textContent = ''; return; }
    const results = await window.api.grep(EditorState.currentFolder, kw);
    summary.textContent = results.length ? '找到 ' + results.length + ' 处匹配' : '无匹配';
    list.innerHTML = '';
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'sr-item';
      item.innerHTML =
        '<span class="sr-file">' + escapeHtml(r.file) + ':' + r.line + '</span>' +
        '<span class="sr-text">' + escapeHtml(r.text) + '</span>';
      item.onclick = async () => {
        const full = window.api.pathJoin(EditorState.currentFolder, r.file);
        await openFile(full);
        const ed = getEditor();
        if (ed) { ed.revealLineInCenter(r.line); ed.setPosition({ lineNumber: r.line, column: r.col }); ed.focus(); }
        searchEl.classList.add('hidden');
      };
      list.appendChild(item);
    }
  }

  // 暴露给调试/外部调用
  window.openPalette = openPalette;
  window.openGlobalSearch = openGlobalSearch;
})();
