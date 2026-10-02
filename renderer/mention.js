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
      if (e.isDir) await collectFiles(p, depth + 1, out);
      else out.push({ name: e.name, path: p });
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

  function renderPanel(query) {
    const files = (fileCache || []).filter((f) =>
      !query || f.rel.toLowerCase().includes(query.toLowerCase()) || f.name.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 30);
    const box = panel.querySelector('.mention-list');
    if (!files.length) { box.innerHTML = '<div class="mention-empty">无匹配文件（输入 @ 后可继续输文件名过滤）</div>'; return; }
    box.innerHTML = files.map((f) =>
      '<div class="mention-item" data-rel="' + escapeHtml(f.rel) + '">' +
        '<span class="mi-ico">' + (window.lucideIcon ? window.lucideIcon(fileIconName(extOf(f.name))) : '') + '</span>' +
        '<span class="mi-name">' + escapeHtml(f.name) + '</span>' +
        '<span class="mi-path">' + escapeHtml(f.rel) + '</span>' +
      '</div>'
    ).join('');
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

  (function init() { bindInput('followup-input'); bindInput('home-task-input'); })();

  // 发送前提取 @filepath，转为上下文注入
  window.extractMentions = function (text) {
    const files = [];
    const cleaned = String(text || '').replace(/@([^\s@]+)/g, (m, rel) => {
      if (rel.includes('/') || rel.includes('.')) { files.push(rel); return ''; }
      return m;
    });
    const context = files.length ? '【参考文件】\n' + files.map((f) => '- ' + f).join('\n') + '\n\n' : '';
    return { task: cleaned.trim(), context };
  };
})();
