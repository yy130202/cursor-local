/* Cursor Local - Git 面板（IDEA 式版本控制：勾选文件 + 并排 diff + 选择性提交） */
(function () {
  let panelEl = null;
  let diffEditor = null;
  let diffModels = [];
  let currentCwd = null;
  let statusCache = null;
  const selected = new Set(); // 勾选的文件

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'git-panel hidden';
    panelEl.innerHTML =
      '<div class="git-head">' +
        '<span class="git-branch" id="git-branch">-</span>' +
        '<button class="git-action" id="git-refresh" title="刷新">' + (window.lucideIcon('refresh-cw') || '') + '</button>' +
        '<button class="git-action" id="git-push" title="推送到远端">' + (window.lucideIcon('arrow-up') || '') + '</button>' +
        '<button class="git-action" id="git-close">×</button>' +
      '</div>' +
      '<div class="git-commit-row">' +
        '<textarea class="git-msg" id="git-msg" placeholder="提交信息（仅提交勾选的文件）"></textarea>' +
        '<div class="git-commit-btns">' +
          '<span class="git-count" id="git-count">0 个文件</span>' +
          '<button class="git-commit-btn" id="git-commit" title="提交勾选的文件">提交</button>' +
        '</div>' +
      '</div>' +
      '<div class="git-body">' +
        '<div class="git-list" id="git-list"></div>' +
        '<div class="git-diff hidden" id="git-diff">' +
          '<div class="git-diff-head" id="git-diff-head"></div>' +
          '<div class="git-diff-body" id="git-diff-body"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panelEl);
    return panelEl;
  }

  function resolveCwd() {
    return (typeof EditorState !== 'undefined' && EditorState.currentFolder) || null;
  }

  async function openGitPanel() {
    const cwd = resolveCwd();
    if (!cwd) { flashStatus('请先打开文件夹'); return; }
    currentCwd = cwd;
    ensurePanel();
    panelEl.classList.remove('hidden');
    await refresh();
  }

  async function refresh() {
    if (!currentCwd) return;
    const r = await window.api.gitStatus(currentCwd);
    if (!r.ok) { document.getElementById('git-list').innerHTML = '<div class="git-empty">' + escapeHtml(r.error || '不是 git 仓库') + '</div>'; return; }
    statusCache = r;
    document.getElementById('git-branch').textContent = r.branch || '-';
    // 同步 git 状态缓存 → 文件树着色
    window.__gitStatusMap = new Map();
    [...r.staged, ...r.unstaged].forEach((f) => window.__gitStatusMap.set(f.file, { status: f.status, staged: f.staged }));
    if (typeof renderTree === 'function') renderTree();
    // 默认勾选所有变更
    selected.clear();
    [...r.staged, ...r.unstaged].forEach((f) => selected.add(f.file));
    renderList(r);
  }

  function renderList(r) {
    const list = document.getElementById('git-list');
    const total = r.staged.length + r.unstaged.length;
    document.getElementById('git-count').textContent = selected.size + ' 个文件';
    if (!total) { list.innerHTML = '<div class="git-empty">无更改，工作区干净 ✓</div>'; return; }
    const statusMeta = { added: ['A', 'git-a'], modified: ['M', 'git-m'], deleted: ['D', 'git-d'], untracked: ['U', 'git-u'], renamed: ['R', 'git-m'], conflict: ['!', 'git-d'] };
    let html = '';
    const group = (title, items) => {
      if (!items.length) return '';
      let g = '<div class="git-group-label">' + title + '（' + items.length + '）</div>';
      for (const it of items) {
        const [ch, cls] = statusMeta[it.status] || ['?', 'git-m'];
        g += '<div class="git-item" data-file="' + escapeHtml(it.file) + '" data-staged="' + (it.staged ? '1' : '0') + '">' +
          '<input type="checkbox" class="git-check" checked>' +
          '<span class="git-status ' + cls + '">' + ch + '</span>' +
          '<span class="git-file">' + escapeHtml(it.file) + '</span>' +
          '<button class="git-stage-btn" title="' + (it.staged ? '取消暂存' : '暂存') + '">' + (window.lucideIcon(it.staged ? 'minus' : 'plus') || '') + '</button>' +
        '</div>';
      }
      return g;
    };
    html = group('更改', r.unstaged) + group('暂存的更改', r.staged);
    list.innerHTML = html;

    list.querySelectorAll('.git-item').forEach((el) => {
      const file = el.dataset.file;
      const staged = el.dataset.staged === '1';
      const check = el.querySelector('.git-check');
      check.onchange = () => {
        if (check.checked) selected.add(file); else selected.delete(file);
        document.getElementById('git-count').textContent = selected.size + ' 个文件';
      };
      el.onclick = (e) => { if (e.target !== check) showDiff(file, staged); };
      el.querySelector('.git-stage-btn').onclick = async (e) => {
        e.stopPropagation();
        if (staged) await window.api.gitUnstage(currentCwd, file);
        else await window.api.gitStage(currentCwd, file);
        await refresh();
      };
    });
  }

  async function showDiff(file, staged) {
    const d = await window.api.gitSideBySide(currentCwd, file, staged);
    const lang = (typeof LANG_BY_EXT !== 'undefined' && LANG_BY_EXT[extOf(file)]) || 'plaintext';
    document.getElementById('git-diff-head').textContent = file;
    document.getElementById('git-diff').classList.remove('hidden');
    const body = document.getElementById('git-diff-body');
    if (!diffEditor && typeof monaco !== 'undefined') {
      diffEditor = monaco.editor.createDiffEditor(body, {
        theme: 'cursor-theme', readOnly: true, renderSideBySide: true,
        automaticLayout: true, enableSplitViewResizing: true, minimap: { enabled: false }
      });
    }
    if (!diffEditor) return;
    // 释放旧 model，避免泄漏
    diffModels.forEach((m) => { try { m.dispose(); } catch { /* ignore */ } });
    diffModels = [];
    const original = monaco.editor.createModel(d.old || '', lang);
    const modified = monaco.editor.createModel(d.new || '', lang);
    diffModels = [original, modified];
    diffEditor.setModel({ original, modified });
  }

  function closePanel() { if (panelEl) panelEl.classList.add('hidden'); }

  (function bind() {
    const p = ensurePanel();
    document.getElementById('git-btn').onclick = openGitPanel;
    p.querySelector('#git-close').onclick = closePanel;
    p.querySelector('#git-refresh').onclick = refresh;
    p.querySelector('#git-push').onclick = async () => {
      const r = await window.api.gitPush(currentCwd);
      if (r.ok) flashStatus('已推送到远端');
      else flashStatus(r.error || '推送失败');
    };
    p.querySelector('#git-commit').onclick = async () => {
      const msg = p.querySelector('#git-msg').value.trim();
      const files = [...selected];
      const r = await window.api.gitCommitFiles(currentCwd, files, msg);
      if (r.ok) { p.querySelector('#git-msg').value = ''; flashStatus('已提交 ' + files.length + ' 个文件'); await refresh(); }
      else flashStatus(r.error || '提交失败');
    };
  })();

  window.openGitPanel = openGitPanel;
})();
