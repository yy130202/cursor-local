/* Cursor Local - 统一命令系统：自定义快捷键 + 编辑器右键菜单 */
(function () {
  /* ---- 命令注册表（含默认快捷键 + 动作） ---- */
  const COMMANDS = [
    { id: 'command.palette', label: '命令面板', icon: 'command', key: 'Ctrl+Shift+P', action: () => window.openPalette && window.openPalette() },
    { id: 'search.global', label: '全局搜索', icon: 'search', key: 'Ctrl+Shift+F', action: () => window.openGlobalSearch && window.openGlobalSearch() },
    { id: 'file.save', label: '保存文件', icon: 'save', key: 'Ctrl+S', action: () => { if (typeof saveActive === 'function') saveActive(); } },
    { id: 'ai.explain', label: 'AI 解释代码', icon: 'message-square-text', key: 'Ctrl+Alt+E', action: () => window.applyAiEdit && window.applyAiEdit('explain') },
    { id: 'ai.comment', label: 'AI 添加注释', icon: 'message-square-plus', key: 'Ctrl+Alt+C', action: () => window.applyAiEdit && window.applyAiEdit('comment') },
    { id: 'ai.rewrite', label: 'AI 改写代码', icon: 'wand-sparkles', key: 'Ctrl+Alt+R', action: () => window.applyAiEdit && window.applyAiEdit('rewrite') },
    { id: 'ai.test', label: 'AI 编写测试', icon: 'test-tube', key: 'Ctrl+Alt+T', action: () => window.applyAiEdit && window.applyAiEdit('test') },
    { id: 'ai.complete', label: '触发 AI 补全', icon: 'sparkles', key: 'Alt+\\', action: () => window.triggerAiComplete && window.triggerAiComplete() }
  ];

  let customKeybindings = {}; // id -> combo（用户自定义覆盖默认）

  function currentKey(id) {
    if (customKeybindings[id]) return customKeybindings[id];
    const cmd = COMMANDS.find((c) => c.id === id);
    return cmd ? cmd.key : '';
  }

  /* ---- 按键序列化 ---- */
  function formatKeyEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Meta');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let k = e.key;
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(k)) return null;
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    else {
      const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Enter: 'Enter' };
      k = map[k] || k;
    }
    return parts.concat(k).join('+');
  }

  /* ---- 全局快捷键监听（capture 阶段，匹配才拦截，不干扰编辑） ---- */
  window.addEventListener('keydown', (e) => {
    const combo = formatKeyEvent(e);
    if (!combo) return;
    for (const c of COMMANDS) {
      if (currentKey(c.id) === combo) {
        e.preventDefault();
        e.stopPropagation();
        try { c.action(); } catch (err) { console.error('[keymap]', err); }
        return;
      }
    }
  }, true);

  /* ---- 编辑器右键菜单 ---- */
  let menuEl = null;
  const editActions = [
    { label: '剪切', icon: 'scissors', run: (ed) => ed.trigger('ctx', 'editor.action.clipboardCutAction', null) },
    { label: '复制', icon: 'copy', run: (ed) => ed.trigger('ctx', 'editor.action.clipboardCopyAction', null) },
    { label: '粘贴', icon: 'clipboard-paste', run: (ed) => ed.trigger('ctx', 'editor.action.clipboardPasteAction', null) },
    { label: '全选', icon: 'text-select', run: (ed) => ed.trigger('ctx', 'editor.action.selectAll', null) }
  ];

  function closeMenu() { if (menuEl) menuEl.classList.add('hidden'); }

  function showMenu(x, y, editor) {
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.className = 'ctx-menu';
      document.body.appendChild(menuEl);
    }
    const aiCmds = ['ai.explain', 'ai.comment', 'ai.rewrite', 'ai.test', 'ai.complete'];
    const navCmds = ['command.palette', 'search.global', 'file.save'];
    const itemHtml = (cmd) =>
      '<div class="ctx-item" data-id="' + cmd.id + '">' +
        '<span class="ctx-ico">' + (window.lucideIcon(cmd.icon) || '') + '</span>' +
        '<span class="ctx-label">' + cmd.label + '</span>' +
        '<span class="ctx-key">' + currentKey(cmd.id) + '</span></div>';
    const groupHtml = (ids) => ids.map((id) => itemHtml(COMMANDS.find((c) => c.id === id))).join('');
    const editHtml = editActions.map((a, i) =>
      '<div class="ctx-item" data-edit="' + i + '">' +
        '<span class="ctx-ico">' + (window.lucideIcon(a.icon) || '') + '</span>' +
        '<span class="ctx-label">' + a.label + '</span></div>'
    ).join('');
    menuEl.innerHTML = groupHtml(aiCmds) + '<div class="ctx-sep"></div>' + groupHtml(navCmds) + '<div class="ctx-sep"></div>' + editHtml;

    menuEl.querySelectorAll('.ctx-item[data-id]').forEach((el) => {
      el.onclick = () => {
        closeMenu();
        const cmd = COMMANDS.find((c) => c.id === el.dataset.id);
        if (cmd) cmd.action();
      };
    });
    menuEl.querySelectorAll('.ctx-item[data-edit]').forEach((el) => {
      el.onclick = () => { closeMenu(); editActions[parseInt(el.dataset.edit, 10)].run(editor); };
    });

    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';
    menuEl.classList.remove('hidden');
    // 边界修正
    const r = menuEl.getBoundingClientRect();
    if (r.right > window.innerWidth) menuEl.style.left = Math.max(4, x - r.width) + 'px';
    if (r.bottom > window.innerHeight) menuEl.style.top = Math.max(4, y - r.height) + 'px';

    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); }, { once: true });
  }

  window.setupEditorContextMenu = function (editor) {
    editor.onContextMenu((e) => showMenu(e.event.posx, e.event.posy, editor));
    window.__ctxMenuReady = true;
  };

  /* ---- 暴露给设置页 ---- */
  window.formatKeyEvent = formatKeyEvent;
  window.getCommandList = () => COMMANDS.map((c) => ({ id: c.id, label: c.label, icon: c.icon, key: currentKey(c.id) }));
  window.setKeybinding = async (id, key) => {
    customKeybindings[id] = key;
    try { await window.api.setConfig({ keybindings: { ...customKeybindings } }); } catch { /* 忽略 */ }
  };
  window.resetKeybinding = async (id) => {
    delete customKeybindings[id];
    try { await window.api.setConfig({ keybindings: { ...customKeybindings } }); } catch { /* 忽略 */ }
  };

  /* ---- 初始化：读自定义快捷键 ---- */
  (async () => {
    try {
      const cfg = await window.api.getConfig();
      customKeybindings = cfg.keybindings || {};
    } catch { /* 用默认 */ }
  })();
})();
