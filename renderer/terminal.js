/* Cursor Local - 终端面板（xterm.js） */
(function () {
  let panelEl = null;
  let term = null;
  let fitAddon = null;
  let termId = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'term-panel hidden';
    panelEl.innerHTML =
      '<div class="term-head">' +
        '<span class="term-title">终端</span>' +
        '<span class="term-cwd" id="term-cwd"></span>' +
        '<button class="term-action" id="term-new" title="新终端">' + (window.lucideIcon('plus') || '') + '</button>' +
        '<button class="term-action" id="term-close">×</button>' +
      '</div>' +
      '<div class="term-body" id="term-container"></div>';
    document.body.appendChild(panelEl);
    return panelEl;
  }

  function resolveCwd() {
    return (typeof EditorState !== 'undefined' && EditorState.currentFolder) || null;
  }

  async function openTerminal() {
    ensurePanel();
    panelEl.classList.remove('hidden');
    if (!term) {
      await initTerminal();
    } else {
      try { fitAddon.fit(); } catch { /* ignore */ }
      term.focus();
    }
  }

  async function initTerminal() {
    const container = document.getElementById('term-container');
    if (typeof window.Terminal === 'undefined') {
      container.textContent = '终端组件加载失败（xterm.js 未就绪）';
      return;
    }
    const dark = document.documentElement.dataset.theme !== 'light';
    term = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Microsoft YaHei", "Courier New", monospace',
      theme: {
        background: dark ? '#1e1e1e' : '#ffffff',
        foreground: dark ? '#cccccc' : '#333333',
        cursor: '#3b82f6',
        selectionBackground: dark ? '#264f78' : '#b3d4fc'
      }
    });
    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    try { fitAddon.fit(); } catch { /* ignore */ }
    const cwd = resolveCwd();
    document.getElementById('term-cwd').textContent = cwd || '当前目录';
    // 行缓冲回显：管道模式 cmd 无控制台回显，由前端模拟（打字可见、退格、回车执行）
    let inputBuf = '';
    const handleKey = (c) => {
      if (c === '\r') {
        term.write('\r\n');
        window.api.terminalInput(termId, inputBuf + '\r\n');
        inputBuf = '';
        return;
      }
      if (c === '\x7f' || c === '\b') {
        const arr = Array.from(inputBuf);
        if (!arr.length) return;
        const removed = arr.pop();
        inputBuf = arr.join('');
        term.write('\b \b');
        if (removed.charCodeAt(0) > 0x2e80) term.write('\b'); // 全角字符占两列
        return;
      }
      if (c === '\x03') { // Ctrl+C
        term.write('^C\r\n');
        window.api.terminalInput(termId, '\r\n');
        inputBuf = '';
        return;
      }
      if (c < ' ') return; // 其余控制字符忽略
      inputBuf += c;
      term.write(c); // 回显
    };
    term.onData((data) => {
      if (!termId) return;
      if (data.startsWith('\x1b')) return; // 方向键等转义序列忽略
      for (const c of data) handleKey(c);
    });
    container.addEventListener('click', () => { if (term) term.focus(); });
    termId = await window.api.terminalCreate(cwd);
    term.write('\x1b[1;36mCursor Local 终端\x1b[0m（输入命令回车执行，exit 退出）\r\n');
    term.focus();
  }

  function newTerminal() {
    if (termId) { window.api.terminalKill(termId); }
    termId = null;
    if (term) { term.dispose(); term = null; }
    initTerminal();
  }

  function closePanel() { if (panelEl) panelEl.classList.add('hidden'); }

  window.api.onTerminalData(({ id, data }) => { if (term && id === termId) term.write(data); });
  window.api.onTerminalExit(({ id }) => { if (term && id === termId) term.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n'); });

  (function bind() {
    const p = ensurePanel();
    document.getElementById('term-btn').onclick = openTerminal;
    p.querySelector('#term-close').onclick = closePanel;
    p.querySelector('#term-new').onclick = newTerminal;
  })();

  window.openTerminal = openTerminal;
})();
