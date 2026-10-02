/* Cursor Local - 终端面板（xterm.js） */
(function () {
  const isWindows = navigator.userAgent.includes('Windows');
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
        '<div class="term-tabs">' +
          '<button class="term-tab active" data-tab="term">终端</button>' +
          '<button class="term-tab" data-tab="problems">问题</button>' +
          '<button class="term-tab" data-tab="logs">输出</button>' +
        '</div>' +
        '<span class="term-cwd" id="term-cwd"></span>' +
        '<button class="term-action" id="term-new" title="新终端">' + (window.lucideIcon('plus') || '') + '</button>' +
        '<button class="term-action" id="term-close">×</button>' +
      '</div>' +
      '<div class="term-body" id="term-container"></div>' +
      '<div class="problems-body hidden" id="problems-container"></div>' +
      '<div class="problems-body hidden" id="logs-container"></div>';
    document.body.appendChild(panelEl);
    // Tab 切换
    panelEl.querySelectorAll('.term-tab').forEach((tab) => {
      tab.onclick = () => switchTab(tab.dataset.tab);
    });
    return panelEl;
  }

  function switchTab(name) {
    panelEl.querySelectorAll('.term-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.getElementById('term-container').classList.toggle('hidden', name !== 'term');
    document.getElementById('problems-container').classList.toggle('hidden', name !== 'problems');
    document.getElementById('logs-container').classList.toggle('hidden', name !== 'logs');
    if (name === 'problems') renderProblems();
    if (name === 'logs') renderLogs();
  }

  /* 输出面板：应用运行日志（Debug/Info/Warning/Error） */
  async function renderLogs() {
    const box = document.getElementById('logs-container');
    if (!box) return;
    try {
      const logs = await window.api.getLogs();
      if (!logs || !logs.length) { box.innerHTML = '<div class="pb-empty">暂无日志</div>'; return; }
      box.innerHTML = logs.slice(-300).reverse().map((l) => {
        const lv = String(l.level || 'info').toLowerCase();
        const cls = lv === 'error' ? 'err' : (lv === 'warning' ? 'warn' : 'info');
        const ico = cls === 'err' ? '✖' : (cls === 'warn' ? '⚠' : 'ℹ');
        const t = l.ts ? new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        return '<div class="pb-item ' + cls + '">' +
          '<span class="pb-ico">' + ico + '</span>' +
          '<span class="pb-msg">[' + esc(l.source || lv) + '] ' + esc(l.message || '') + '</span>' +
          '<span class="pb-pos">' + t + '</span>' +
        '</div>';
      }).join('');
    } catch { box.innerHTML = '<div class="pb-empty">日志加载失败</div>'; }
  }
  window.openOutput = function () {
    openTerminal();
    switchTab('logs');
    renderLogs();
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function renderProblems() {
    const box = document.getElementById('problems-container');
    if (!box || typeof monaco === 'undefined') return;
    const e = (typeof EditorState !== 'undefined') ? EditorState.editor : null;
    const model = e && e.getModel();
    const tab = (typeof EditorState !== 'undefined' && EditorState.tabs) ? EditorState.tabs.find((t) => t.path === EditorState.activePath) : null;
    if (!model || !tab) { box.innerHTML = '<div class="pb-empty">无打开的文件</div>'; return; }
    const ms = monaco.editor.getModelMarkers({ resource: model.uri });
    if (!ms.length) { box.innerHTML = '<div class="pb-empty">未在当前文件检测到问题 ✓</div>'; return; }
    const fname = tab.path.split(/[\\/]/).pop();
    box.innerHTML = ms.map((m) => {
      const ico = m.severity === 8 ? '✖' : (m.severity === 4 ? '⚠' : 'ℹ');
      const cls = m.severity === 8 ? 'err' : (m.severity === 4 ? 'warn' : 'info');
      return '<div class="pb-item ' + cls + '" data-line="' + m.startLineNumber + '" data-col="' + m.startColumn + '">' +
        '<span class="pb-ico">' + ico + '</span>' +
        '<span class="pb-msg">' + esc(m.message) + '</span>' +
        '<span class="pb-pos">' + esc(fname) + ':' + m.startLineNumber + ':' + m.startColumn + '</span>' +
      '</div>';
    }).join('');
    box.querySelectorAll('.pb-item').forEach((n) => {
      n.onclick = () => {
        e.setPosition({ lineNumber: +n.dataset.line, column: +n.dataset.col });
        e.revealLineInCenter(+n.dataset.line);
        e.focus();
      };
    });
  }
  window.openProblems = function () {
    openTerminal();
    switchTab('problems');
    renderProblems();
  };

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
        let cmd = inputBuf;
        // Windows cmd 兼容：`./xxx` 是类 Unix 写法，cmd 下自动转 `.\xxx`
        if (isWindows && /^\.\//.test(cmd)) {
          const fixed = cmd.replace(/^\.\//, '.\\');
          term.write('\x1b[90m[已自动适配 Windows] ' + fixed + '\x1b[0m\r\n');
          cmd = fixed;
        }
        window.api.terminalInput(termId, cmd + '\r\n');
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
