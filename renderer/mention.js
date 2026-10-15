/* Cursor Local - @ 提及上下文（参考 CodeBuddy：输入 @ 弹出文件引用，选中的文件注入 prompt） */
(function () {
  let panel = null;
  let activeInput = null;
  let triggerStart = -1;
  let fileCache = null;
  let cacheCwd = '';

  async function collectFiles(dir, depth, out) {
    if (depth > 6 || out.length > 600) return;
    let list;
    try { list = await window.api.readDir(dir); } catch { return; }
    for (const e of list) {
      if (out.length > 600) return;
      if (!e.name || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = dir + '/' + e.name;
      if (e.isDir) {
        out.push({ name: e.name, path: p, isDir: true }); // 目录也可选：注入目录结构
        await collectFiles(p, depth + 1, out);
      } else out.push({ name: e.name, path: p });
    }
  }

  async function ensureFiles() {
    const cwd = (typeof EditorState !== 'undefined' && EditorState.currentFolder) || '';
    if (!cwd) return [];
    if (fileCache && cacheCwd === cwd) return fileCache;
    const out = [];
    await collectFiles(cwd, 0, out);
    out.forEach((f) => { f.rel = f.path.slice(cwd.length).replace(/^[\\/]/, ''); });
    fileCache = out; cacheCwd = cwd;
    return out;
  }

  function currentQuery() {
    const v = activeInput.value.slice(triggerStart + 1);
    const m = v.match(/^([^\s@]*)/);
    return m ? m[1] : '';
  }

  /* 内置引用：不指向具体路径，而是在发送时动态取用实时状态 */
  const SPECIALS = [
    { token: 'diff', name: '@diff', desc: '当前未提交的改动（git）', icon: 'git-compare' },
    { token: 'selection', name: '@selection', desc: '编辑器里选中的代码', icon: 'text-cursor' },
    { token: 'current', name: '@current', desc: '当前打开的文件', icon: 'file-code' }
  ];

  function renderPanel(query) {
    const q = (query || '').toLowerCase();
    const box = panel.querySelector('.mention-list');
    const specials = SPECIALS.filter((s) => !q || s.token.includes(q) || s.name.toLowerCase().includes(q));
    const items = (fileCache || []).filter((f) =>
      !q || f.rel.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)
    ).slice(0, 30);
    if (!specials.length && !items.length) {
      box.innerHTML = '<div class="mention-empty">无匹配（内置引用：@diff / @selection / @current）</div>';
      return;
    }
    const group = (title) => '<div class="mention-group">' + title + '</div>';
    box.innerHTML =
      (specials.length ? group('内置引用') + specials.map((s) =>
        '<div class="mention-item" data-rel="' + s.token + '">' +
          '<span class="mi-ico">' + (window.lucideIcon ? window.lucideIcon(s.icon) : '') + '</span>' +
          '<span class="mi-name">' + s.name + '</span>' +
          '<span class="mi-path">' + s.desc + '</span>' +
        '</div>').join('') : '') +
      (items.length ? group('文件与目录') + items.map((f) =>
        '<div class="mention-item" data-rel="' + CL.util.escapeHtml(f.isDir ? f.rel + '/' : f.rel) + '">' +
          '<span class="mi-ico">' + (window.lucideIcon ? window.lucideIcon(f.isDir ? 'folder' : CL.util.fileIconName(CL.util.extOf(f.name))) : '') + '</span>' +
          '<span class="mi-name">' + CL.util.escapeHtml(f.name) + '</span>' +
          '<span class="mi-path">' + CL.util.escapeHtml(f.rel) + '</span>' +
        '</div>').join('') : '');
    box.querySelectorAll('.mention-item').forEach((n) => { n.onclick = () => pick(n.dataset.rel); });
  }

  function pick(rel) {
    const q = currentQuery();
    const before = activeInput.value.slice(0, triggerStart + 1); // 含 @
    const after = activeInput.value.slice(triggerStart + 1 + q.length);
    activeInput.value = before + rel + ' ' + after;
    close();
    activeInput.focus();
  }

  function open(input, pos) {
    activeInput = input;
    triggerStart = pos;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'mention-panel hidden';
      panel.innerHTML =
        '<input class="mention-search" placeholder="搜索文件…" spellcheck="false">' +
        '<div class="mention-list"></div>';
      document.body.appendChild(panel);
      panel.querySelector('.mention-search').oninput = (e) => renderPanel(e.target.value);
    }
    const r = input.getBoundingClientRect();
    panel.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    panel.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
    panel.classList.remove('hidden');
    const q = currentQuery();
    panel.querySelector('.mention-search').value = q;
    ensureFiles().then(() => renderPanel(q));
  }

  function close() {
    if (panel) panel.classList.add('hidden');
    activeInput = null; triggerStart = -1;
  }

  function onInput(e) {
    const input = e.target;
    const sel = input.selectionStart;
    const before = input.value.slice(0, sel);
    const atIdx = before.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || /[\s(（]/.test(input.value[atIdx - 1]))) {
      const afterAt = before.slice(atIdx + 1);
      if (!/\s/.test(afterAt)) { open(input, atIdx); return; }
    }
    close();
  }

  function bindInput(id) {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', onInput);
    input.addEventListener('blur', () => setTimeout(close, 200));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel && !panel.classList.contains('hidden')) { e.stopPropagation(); close(); }
    });
  }

  document.addEventListener('mousedown', (e) => {
    if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== activeInput) close();
  });

  (function init() { bindInput('followup-input'); })();

  /* ---- 内置引用的内容构造 ---- */

  async function injectGitDiff() {
    const cwd = (typeof EditorState !== 'undefined' && EditorState.currentFolder) || '';
    if (!cwd) return '';
    let st = null;
    try { st = await window.api.gitStatus(cwd); } catch { return ''; }
    if (!st || !st.ok) return '';
    const staged = (st.staged || []).map((f) => '  [已暂存] ' + f);
    const unstaged = (st.unstaged || []).map((f) => '  [未暂存] ' + f);
    if (!staged.length && !unstaged.length) {
      return '【当前改动】分支 ' + (st.branch || '?') + '：工作区干净，没有未提交的改动。';
    }
    /* 只给「改了哪些文件」，不给逐行 diff —— Agent 有 run_command 可以自己跑 git diff
       拿精确差异；把整份补丁塞进上下文既费 token，又会在几轮之后过期失真。 */
    return '【当前改动】分支 ' + (st.branch || '?') + '，共 ' + (staged.length + unstaged.length) + ' 个文件有未提交改动：\n'
      + staged.concat(unstaged).join('\n')
      + '\n（需要具体差异时用 run_command 跑 git diff，或直接 read_file 读取对应文件）';
  }

  async function injectSelection() {
    try {
      if (typeof EditorState === 'undefined' || !EditorState.editor) return '';
      const ed = EditorState.editor;
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (!sel || !model || sel.isEmpty()) return '【选中代码】（当前编辑器没有选中内容）';
      const text = model.getValueInRange(sel).slice(0, 8000);
      return '【选中代码】来自 ' + (EditorState.activePath || '当前文件')
        + ' 第 ' + sel.startLineNumber + '-' + sel.endLineNumber + ' 行：\n```\n' + text + '\n```';
    } catch { return ''; }
  }

  async function injectCurrentFile() {
    const p = (typeof EditorState !== 'undefined' && EditorState.activePath) || '';
    return p ? '【当前文件】' + p : '【当前文件】（没有打开的文件）';
  }

  async function injectFolder(rel) {
    const cwd = (typeof EditorState !== 'undefined' && EditorState.currentFolder) || '';
    if (!cwd || !rel) return '';
    const base = (cwd + '/' + rel).replace(/[/\\]+$/, '');
    const lines = [];
    const walk = async (d, prefix, depth) => {
      if (depth > 2 || lines.length > 80) return;
      let list;
      try { list = await window.api.readDir(d); } catch { return; }
      for (const e of list) {
        if (lines.length > 80) return;
        if (!e.name || e.name.startsWith('.') || e.name === 'node_modules') continue;
        lines.push(prefix + e.name + (e.isDir ? '/' : ''));
        if (e.isDir) await walk(d + '/' + e.name, prefix + '  ', depth + 1);
      }
    };
    await walk(base, '', 0);
    if (!lines.length) return '';
    return '【目录 ' + rel + '】' + lines.length + ' 项（深度 ≤2）：\n' + lines.join('\n');
  }

  /* 发送前提取 @引用，转为上下文注入。
     异步：@diff 要读 git 状态、@folder 要列目录 —— 调用方必须 await。 */
  window.extractMentions = async function (text) {
    const files = [];
    const dirs = [];
    const specials = [];
    const cleaned = String(text || '').replace(/@([^\s@]+)/g, (m, rel) => {
      const low = rel.toLowerCase();
      if (low === 'diff' || low === 'git-diff' || low === 'gitdiff') { specials.push('diff'); return ''; }
      if (low === 'selection' || low === 'sel' || low === 'selected') { specials.push('selection'); return ''; }
      if (low === 'current' || low === 'file') { specials.push('current'); return ''; }
      if (/[/\\]$/.test(rel)) { dirs.push(rel.replace(/[/\\]+$/, '')); return ''; }
      if (rel.includes('/') || rel.includes('.')) { files.push(rel); return ''; }
      return m;
    });
    const parts = [];
    if (files.length) parts.push('【参考文件】\n' + files.map((f) => '- ' + f).join('\n'));
    for (const d of dirs) { const b = await injectFolder(d); if (b) parts.push(b); }
    for (const s of specials) {
      const b = s === 'diff' ? await injectGitDiff() : (s === 'selection' ? await injectSelection() : await injectCurrentFile());
      if (b) parts.push(b);
    }
    const context = parts.length ? parts.join('\n\n') + '\n\n' : '';
    return { task: cleaned.trim(), context };
  };
})();
