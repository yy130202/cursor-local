/* Cursor Local - 命令面板（Ctrl+Shift+P）+ 全局搜索（Ctrl+Shift+F） */
(function () {
  /* ---- 命令注册表 ---- */
  const commands = [
    { id: 'home', title: '回到主页', icon: 'home', action: () => switchMode('home') },
    { id: 'editor', title: '切换到编辑器', icon: 'file-code-2', action: () => switchMode('editor') },
    { id: 'agents', title: '切换到 Agents 工作台', icon: 'bot', action: () => switchMode('agents') },
    { id: 'open-folder', title: '打开文件夹', icon: 'folder-open', action: () => openFolder() },
    { id: 'search', title: '全局搜索', icon: 'search', action: () => openGlobalSearch() },
    { id: 'new-agent', title: '新建 Agent 任务', icon: 'plus', action: () => { switchMode('agents'); const i = document.getElementById('followup-input'); if (i) i.focus(); } },
    { id: 'theme', title: '切换下一个主题', icon: 'palette', action: () => cycleTheme() },
    { id: 'settings', title: '打开设置', icon: 'settings', action: () => openSettings() },
    { id: 'save', title: '保存当前文件', icon: 'save', action: () => { if (typeof saveActive === 'function') saveActive(); } }
  ];

  function cycleTheme() {
    const keys = Object.keys(typeof PRESETS !== 'undefined' ? PRESETS : {});
    if (!keys.length) return;
    // 从 theme.js 暴露的 currentTheme 读取当前 preset
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
  function renderPalette(q) {
    const list = paletteEl.querySelector('.cp-list');
    const kw = (q || '').trim().toLowerCase();
    const matched = commands.filter((c) => !kw || c.title.toLowerCase().includes(kw) || c.id.includes(kw));
    list.innerHTML = '';
    matched.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'cp-item' + (i === 0 ? ' active' : '');
      item.innerHTML = '<span class="cp-ico">' + (window.lucideIcon(c.icon) || '') + '</span><span>' + escapeHtml(c.title) + '</span>';
      item.onclick = () => { closePalette(); c.action(); };
      list.appendChild(item);
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
