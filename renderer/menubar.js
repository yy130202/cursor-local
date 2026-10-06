/* Cursor Local - 自绘菜单栏（参考 VS Code：文件/编辑/选择/查看/转到，动作映射现有功能） */
(function () {
  function ed() { return (typeof EditorState !== 'undefined') ? EditorState.editor : null; }
  function act(id) { const e = ed(); if (e) { const a = e.getAction(id); if (a) a.run(); } }
  function trig(fn) { const e = ed(); if (e) e.trigger('menu', fn); }
  function needCwd() { flashStatus('请先打开文件夹'); return null; }
  function cwd() { return (typeof EditorState !== 'undefined' && EditorState.currentFolder) || needCwd(); }

  const MENUS = [
    { label: '文件(F)', items: [
      { label: '新建文件', key: 'Ctrl+N', run: () => { const c = cwd(); if (!c) return; if (typeof switchMode === 'function') switchMode('editor'); if (CL.editor.filetree.startCreate) CL.editor.filetree.startCreate(c, false); } },
      { label: '打开文件夹…', key: 'Ctrl+K Ctrl+O', run: () => { if (typeof openFolder === 'function') openFolder(); } },
      { sep: true },
      { label: '保存', key: 'Ctrl+S', run: () => { if (typeof saveActive === 'function') saveActive(); } },
      { label: '全部保存', run: () => { if (typeof saveActive === 'function') saveActive(); } },
      { sep: true },
      { label: '关闭编辑器', key: 'Ctrl+F4', run: () => { const b = document.querySelector('.tab.active .close'); if (b) b.click(); } },
      { label: '退出', run: () => window.api && window.api.closeWindow() }
    ]},
    { label: '编辑(E)', items: [
      { label: '撤销', key: 'Ctrl+Z', run: () => trig('undo') },
      { label: '恢复', key: 'Ctrl+Y', run: () => trig('redo') },
      { sep: true },
      { label: '查找', key: 'Ctrl+F', run: () => act('actions.find') },
      { label: '替换', key: 'Ctrl+H', run: () => act('editor.action.startFindReplaceAction') },
      { sep: true },
      { label: '切换行注释', key: 'Ctrl+/', run: () => act('editor.action.commentLine') },
      { label: '格式化文档', key: 'Shift+Alt+F', run: () => act('editor.action.formatDocument') }
    ]},
    { label: '选择(S)', items: [
      { label: '全选', key: 'Ctrl+A', run: () => act('editor.action.selectAll') },
      { sep: true },
      { label: '向上复制一行', run: () => act('editor.action.copyLinesUpAction') },
      { label: '向下复制一行', run: () => act('editor.action.copyLinesDownAction') },
      { label: '向上移动一行', run: () => act('editor.action.moveLinesUpAction') },
      { label: '向下移动一行', run: () => act('editor.action.moveLinesDownAction') },
      { sep: true },
      { label: '添加下一个匹配项', key: 'Ctrl+D', run: () => act('editor.action.addSelectionToNextFindMatch') },
      { label: '选择所有匹配项', key: 'Ctrl+Shift+L', run: () => act('editor.action.selectHighlights') }
    ]},
    { label: '查看(V)', items: [
      { label: '命令面板…', key: 'Ctrl+Shift+P', run: () => window.openPalette && window.openPalette() },
      { sep: true },
      { label: '资源管理器', run: () => { if (typeof switchMode === 'function') switchMode('editor'); } },
      { label: '源代码管理', run: () => window.openGitPanel && window.openGitPanel() },
      { label: '终端', key: 'Ctrl+`', run: () => window.openTerminal && window.openTerminal() },
      { label: '问题', run: () => window.openProblems && window.openProblems() },
      { label: '输出', run: () => window.openOutput && window.openOutput() },
      { sep: true },
      { label: '主题设置…', run: () => { const b = document.getElementById('settings-btn'); if (b) b.click(); } }
    ]},
    { label: '转到(G)', items: [
      { label: '转到文件…', key: 'Ctrl+P', run: () => window.openPalette && window.openPalette() },
      { label: '转到文件中的符号…', key: 'Ctrl+Shift+O', run: () => window.openSymbols && window.openSymbols() },
      { label: '转到行/列…', key: 'Ctrl+G', run: () => act('editor.action.gotoLine') },
      { sep: true },
      { label: '转到定义', key: 'F12', run: () => act('editor.action.revealDefinition') }
    ]}
  ];

  let openIdx = -1;
  let openMenu = null;

  function closeMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; openIdx = -1; }
    document.querySelectorAll('.mb-top.open').forEach((n) => n.classList.remove('open'));
  }

  function showMenu(idx, btn) {
    closeMenu();
    openIdx = idx;
    btn.classList.add('open');
    const menu = document.createElement('div');
    menu.className = 'mb-dropdown';
    menu.innerHTML = MENUS[idx].items.map((it, i) =>
      it.sep ? '<div class="mb-sep"></div>' :
      '<div class="mb-item" data-i="' + i + '">' +
        '<span class="mb-label">' + it.label + '</span>' +
        (it.key ? '<span class="mb-key">' + it.key + '</span>' : '') +
      '</div>'
    ).join('');
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
    menu.querySelectorAll('.mb-item').forEach((n) => {
      n.onclick = () => {
        const item = MENUS[idx].items[+n.dataset.i];
        closeMenu();
        try { item.run(); } catch (e) { flashStatus('执行失败'); }
      };
    });
    openMenu = menu;
  }

  function init() {
    const topbar = document.getElementById('topbar');
    if (!topbar) return;
    const nav = document.createElement('nav');
    nav.id = 'menubar';
    nav.innerHTML = MENUS.map((m, i) => '<button class="mb-top" data-i="' + i + '">' + m.label + '</button>').join('');
    topbar.insertBefore(nav, topbar.firstChild);
    const tops = nav.querySelectorAll('.mb-top');
    tops.forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (openIdx === +btn.dataset.i) closeMenu();
        else showMenu(+btn.dataset.i, btn);
      };
      btn.onmouseenter = () => { if (openIdx >= 0 && openIdx !== +btn.dataset.i) showMenu(+btn.dataset.i, btn); };
    });
    document.addEventListener('mousedown', (e) => {
      if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.mb-top')) closeMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  }

  init();
})();
