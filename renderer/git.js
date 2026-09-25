/* Cursor Local - Git 面板（源代码管理：status / diff / commit / push） */
(function () {
  let panelEl = null;
  let currentCwd = null;
  let statusCache = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'git-panel hidden';
    panelEl.innerHTML =
      '<div class="git-head">' +
        '<span class="git-branch" id="git-branch">-</span>' +
        '<button class="git-action" id="git-refresh" title="刷新">' + (window.lucideIcon('refresh-cw') || '') + '</button>' +
        '<button class="git-action" id="git-close">×</button>' +
      '</div>' +
      '<div class="git-commit-row">' +
        '<textarea class="git-msg" id="git-msg" placeholder="提交信息（提交到本地仓库）"></textarea>' +
        '<div class="git-commit-btns">' +
          '<button class="git-commit-btn" id="git-commit" title="提交全部更改">提交</button>' +
          '<button class="git-push-btn" id="git-push" title="推送到远端">推送</button>' +
        '</div>' +
      '</div>' +
      '<div class="git-list" id="git-list"></div>' +
      '<div class="git-diff hidden" id="git-diff">' +
        '<div class="git-diff-head" id="git-diff-head"></div>' +
        '<div class="git-diff-body" id="git-diff-body"></div>' +
      '</div>';
    document.body.appendChild(panelEl);
    return panelEl;
  }

  function resolveCwd() {
    if (typeof EditorState !== 'undefined' && EditorState.currentFolder) return EditorState.currentFolder;
    return null;
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
    renderList(r);
  }

  function renderList(r) {
    const list = document.getElementById('git-list');
    const total = r.staged.length + r.unstaged.length;
    if (!total) { list.innerHTML = '<div class="git-empty">无更改，工作区干净 ✓</div>'; return; }
    let html = '';
    const fileIcon = (s) => {
      const map = { added: 'file-plus', modified: 'file', deleted: 'file-minus', untracked: 'file-plus', renamed: 'file', conflict: 'alert-triangle' };
      return window.lucideIcon(map[s] || 'file') || '';
    };
    const fileLabel = (s) => {
      const map = { added: 'A', modified: 'M', deleted: 'D', untracked: 'U', renamed: 'R', conflict: '!' };
      return map[s] || '?';
    };
    const group = (title, items) => {
      if (!items.length) return '';
      let g = '<div class="git-group-label">' + title + '（' + items.length + '）</div>';
      for (const it of items) {
        g += '<div class="git-item" data-file="' + escapeHtml(it.file) + '" data-staged="' + (it.staged ? '1' : '0') + '">' +
          '<span class="git-file-icon">' + fileIcon(it.status) + '</span>' +
          '<span class="git-file">' + escapeHtml(it.file) + '</span>' +
          '<span class="git-file-status">' + fileLabel(it.status) + '</span>' +
          (it.staged
            ? '<button class="git-stage-btn" title="取消暂存">' + (window.lucideIcon('minus') || '') + '</button>'
            : '<button class="git-stage-btn" title="暂存">' + (window.lucideIcon('plus') || '') + '</button>') +
        '</div>';
      }
      return g;
    };
    html = group('暂存的更改', r.staged) + group('更改', r.unstaged);
    list.innerHTML = html;

    list.querySelectorAll('.git-item').forEach((el) => {
      const file = el.dataset.file;
      const staged = el.dataset.staged === '1';
      el.onclick = () => showDiff(file, staged);
      const btn = el.querySelector('.git-stage-btn');
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (staged) await window.api.gitUnstage(currentCwd, file);
        else await window.api.gitStage(currentCwd, file);
        await refresh();
      };
    });
  }

  async function showDiff(file, staged) {
    const diff = await window.api.gitDiff(currentCwd, file, staged);
    document.getElementById('git-diff-head').textContent = file;
    document.getElementById('git-diff-body').innerHTML = renderDiff(diff);
    document.getElementById('git-diff').classList.remove('hidden');
  }

  function renderDiff(text) {
    return String(text).split('\n').map((line) => {
      let cls = 'ud-line';
      if (line.startsWith('@@')) cls += ' ud-hunk';
      else if (line.startsWith('+') && !line.startsWith('+++')) cls += ' ud-add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls += ' ud-del';
      else if (/^(diff |index |new file|deleted file|similarity|---|\+\+\+)/.test(line)) cls += ' ud-meta';
      return '<div class="' + cls + '">' + (escapeHtml(line) || '&nbsp;') + '</div>';
    }).join('');
  }

  function closePanel() { if (panelEl) panelEl.classList.add('hidden'); }

  (function bind() {
    const p = ensurePanel();
    document.getElementById('git-btn').onclick = openGitPanel;
    p.querySelector('#git-close').onclick = closePanel;
    p.querySelector('#git-refresh').onclick = refresh;
    p.querySelector('#git-commit').onclick = async () => {
      const msg = p.querySelector('#git-msg').value.trim();
      const r = await window.api.gitCommit(currentCwd, msg);
      if (r.ok) { p.querySelector('#git-msg').value = ''; flashStatus('已提交'); await refresh(); }
      else flashStatus(r.error || '提交失败');
    };
    p.querySelector('#git-push').onclick = async () => {
      const r = await window.api.gitPush(currentCwd);
      if (r.ok) flashStatus('已推送到远端');
      else flashStatus(r.error || '推送失败');
    };
  })();

  window.openGitPanel = openGitPanel;
})();
