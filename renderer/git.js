/* Cursor Local - Git 面板（IDEA/VS Code 式：清晰的「暂存→提交」流程 + 并排 diff + 历史） */
(function () {
  let panelEl = null;
  let diffEditor = null;
  let diffModels = [];
  let currentCwd = null;
  let statusCache = null;
  let viewMode = 'changes'; // 'changes' | 'history'

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'git-panel hidden';
    panelEl.innerHTML =
      '<div class="git-head">' +
        '<span class="git-branch-label">分支</span>' +
        '<span class="git-branch" id="git-branch" title="点击切换分支">-</span>' +
        '<div class="git-head-spacer"></div>' +
        '<button class="git-action" id="git-pull" title="从远端拉取">' + (window.lucideIcon('download') || '↓') + '<span>拉取</span></button>' +
        '<button class="git-action" id="git-push" title="推送到远端">' + (window.lucideIcon('arrow-up') || '↑') + '<span>推送</span></button>' +
        '<button class="git-action" id="git-refresh" title="刷新状态">' + (window.lucideIcon('refresh-cw') || '↻') + '<span>刷新</span></button>' +
        '<button class="git-action" id="git-history" title="查看提交历史">' + (window.lucideIcon('history') || '🕐') + '<span>历史</span></button>' +
        '<button class="git-action git-x" id="git-close" title="关闭">×</button>' +
      '</div>' +
      '<div class="git-commit-row">' +
        '<textarea class="git-msg" id="git-msg" placeholder="提交信息（先点 + 暂存更改，再提交）"></textarea>' +
        '<button class="git-commit-btn" id="git-commit" disabled>提交</button>' +
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
    viewMode = 'changes';
    await refresh();
  }

  async function refresh() {
    if (!currentCwd) return;
    const r = await window.api.gitStatus(currentCwd);
    if (!r.ok) {
      document.getElementById('git-branch').textContent = '-';
      document.getElementById('git-list').innerHTML =
        '<div class="git-empty">此文件夹不是 Git 仓库<br><br>' +
        '<button class="git-init-btn" id="git-init-btn">初始化仓库</button><br><br>' +
        '<button class="git-init-btn" id="git-clone-empty-btn">克隆仓库…</button></div>';
      const btn = document.getElementById('git-init-btn');
      if (btn) btn.onclick = async () => {
        const res = await window.api.gitInit(currentCwd);
        if (res.ok) { flashStatus('已初始化 Git 仓库'); await refresh(); }
        else flashStatus(res.error || '初始化失败');
      };
      const cb = document.getElementById('git-clone-empty-btn');
      if (cb) cb.onclick = () => cloneDialog();
      updateCommitBtn(0);
      return;
    }
    statusCache = r;
    document.getElementById('git-branch').textContent = r.branch || '-';
    // 同步 git 状态缓存 → 文件树着色
    window.__gitStatusMap = new Map();
    [...r.staged, ...r.unstaged].forEach((f) => window.__gitStatusMap.set(f.file, { status: f.status, staged: f.staged }));
    if (typeof renderTree === 'function') renderTree();
    if (viewMode === 'changes') renderList(r);
  }

  function updateCommitBtn(n) {
    const btn = document.getElementById('git-commit');
    if (btn) { btn.textContent = n ? ('提交（' + n + '）') : '提交'; btn.disabled = !n; }
  }

  function renderList(r) {
    const list = document.getElementById('git-list');
    const stagedCount = r.staged.length;
    const total = stagedCount + r.unstaged.length;
    updateCommitBtn(stagedCount);
    if (!total) {
      list.innerHTML = '<div class="git-empty">✓ 无更改，工作区干净<br><span class="git-empty-sub">点右上角「历史」查看提交记录</span></div>';
      return;
    }
    const statusMeta = { added: ['A', 'git-a'], modified: ['M', 'git-m'], deleted: ['D', 'git-d'], untracked: ['U', 'git-u'], renamed: ['R', 'git-m'], conflict: ['!', 'git-d'] };
    const numstat = (it) => {
      if (it.adds === undefined && it.dels === undefined) return '';
      const a = it.adds === '-' ? 'bin' : (it.adds || '0');
      const d = it.dels === '-' ? 'bin' : (it.dels || '0');
      return '<span class="git-numstat"><span class="add">+' + a + '</span><span class="del">−' + d + '</span></span>';
    };
    let html = '';
    const group = (title, items, staged) => {
      if (!items.length) return '';
      const allBtn = staged
        ? '<button class="git-all-btn" data-all="unstage" title="取消全部暂存">全部取消 −</button>'
        : '<button class="git-all-btn" data-all="stage" title="暂存全部更改">全部暂存 +</button>';
      let g = '<div class="git-group-label">' + title + '（' + items.length + '）<span class="git-group-actions">' + allBtn + '</span></div>';
      for (const it of items) {
        const [ch, cls] = statusMeta[it.status] || ['?', 'git-m'];
        g += '<div class="git-item" data-file="' + CL.util.escapeHtml(it.file) + '" data-staged="' + (staged ? '1' : '0') + '">' +
          '<button class="git-stage-btn" title="' + (staged ? '取消暂存' : '暂存') + '">' + (window.lucideIcon(staged ? 'minus' : 'plus') || (staged ? '−' : '+')) + '</button>' +
          '<span class="git-status ' + cls + '">' + ch + '</span>' +
          '<span class="git-file">' + CL.util.escapeHtml(it.file) + '</span>' +
          numstat(it) +
        '</div>';
      }
      return g;
    };
    html = group('更改（未暂存）', r.unstaged, false) + group('暂存的更改', r.staged, true);
    list.innerHTML = html;

    list.querySelectorAll('.git-item').forEach((el) => {
      const file = el.dataset.file;
      el.onclick = () => showDiff(file, el.dataset.staged === '1');
    });
    list.querySelectorAll('.git-stage-btn').forEach((btn) => {
      const item = btn.closest('.git-item');
      btn.onclick = async (e) => {
        e.stopPropagation();
        const staged = item.dataset.staged === '1';
        if (staged) await window.api.gitUnstage(currentCwd, item.dataset.file);
        else await window.api.gitStage(currentCwd, item.dataset.file);
        await refresh();
      };
    });
    list.querySelectorAll('.git-all-btn').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (btn.dataset.all === 'stage') await window.api.gitStageAll(currentCwd);
        else await window.api.gitUnstageAll(currentCwd);
        await refresh();
      };
    });
  }

  async function showHistory() {
    viewMode = 'history';
    const list = document.getElementById('git-list');
    const r = await window.api.gitLog(currentCwd);
    if (!r.ok) { list.innerHTML = '<div class="git-empty">' + CL.util.escapeHtml(r.error) + '</div>'; return; }
    if (!r.entries.length) { list.innerHTML = '<div class="git-empty">暂无提交记录</div>'; return; }
    list.innerHTML = '<div class="git-group-label">提交历史（' + r.entries.length + '）<span class="git-group-actions"><button class="git-all-btn" id="git-back-changes" title="返回更改视图">← 返回</button></span></div>' +
      r.entries.map((e) =>
        '<div class="git-log-item" title="' + CL.util.escapeHtml(e.message) + '">' +
          '<span class="git-log-hash">' + CL.util.escapeHtml(e.hash.slice(0, 8)) + '</span>' +
          '<span class="git-log-msg">' + CL.util.escapeHtml(e.message) + '</span>' +
        '</div>'
      ).join('');
    const back = document.getElementById('git-back-changes');
    if (back) back.onclick = async () => { viewMode = 'changes'; await refresh(); };
  }

  async function showDiff(file, staged) {
    const d = await window.api.gitSideBySide(currentCwd, file, staged);
    const lang = (typeof LANG_BY_EXT !== 'undefined' && LANG_BY_EXT[CL.util.extOf(file)]) || 'plaintext';
    document.getElementById('git-diff-head').textContent = (staged ? '已暂存 · ' : '未暂存 · ') + file;
    document.getElementById('git-diff').classList.remove('hidden');
    const body = document.getElementById('git-diff-body');
    if (!diffEditor && typeof monaco !== 'undefined') {
      diffEditor = monaco.editor.createDiffEditor(body, {
        theme: 'cursor-theme', readOnly: true, renderSideBySide: true,
        automaticLayout: true, enableSplitViewResizing: true, minimap: { enabled: false }
      });
    }
    if (!diffEditor) return;
    diffModels.forEach((m) => { try { m.dispose(); } catch { /* ignore */ } });
    diffModels = [];
    const original = monaco.editor.createModel(d.old || '', lang);
    const modified = monaco.editor.createModel(d.new || '', lang);
    diffModels = [original, modified];
    diffEditor.setModel({ original, modified });
  }

  async function commit() {
    const p = panelEl;
    const msg = p.querySelector('#git-msg').value.trim();
    if (!msg) { flashStatus('请输入提交信息'); return; }
    const files = (statusCache && statusCache.staged ? statusCache.staged : []).map((f) => f.file);
    if (!files.length) { flashStatus('请先暂存要提交的更改'); return; }
    const r = await window.api.gitCommitFiles(currentCwd, files, msg);
    if (r.ok) { p.querySelector('#git-msg').value = ''; flashStatus('已提交 ' + files.length + ' 个文件'); await refresh(); }
    else flashStatus(r.error || '提交失败');
  }

  async function toggleBranchMenu() {
    const existing = document.getElementById('git-branch-menu');
    if (existing) { existing.remove(); return; }
    const r = await window.api.gitBranch(currentCwd);
    if (!r.ok) { flashStatus(r.error || '获取分支失败'); return; }
    const menu = document.createElement('div');
    menu.id = 'git-branch-menu';
    menu.className = 'git-branch-menu';
    menu.innerHTML = (r.branches.length ? r.branches : ['（无分支）']).map((b) =>
      '<div class="gbm-item' + (b === r.current ? ' active' : '') + '" data-branch="' + CL.util.escapeHtml(b) + '">' +
        (b === r.current ? '<span class="gbm-cur">✓</span>' : '<span class="gbm-dot"></span>') +
        '<span>' + CL.util.escapeHtml(b) + '</span>' +
      '</div>'
    ).join('');
    document.body.appendChild(menu);
    const brect = document.getElementById('git-branch').getBoundingClientRect();
    menu.style.top = (brect.bottom + 4) + 'px';
    menu.style.left = Math.min(brect.left, window.innerWidth - 240) + 'px';
    menu.querySelectorAll('.gbm-item').forEach((n) => {
      n.onclick = async () => {
        const b = n.dataset.branch;
        menu.remove();
        if (b === r.current || b === '（无分支）') return;
        const res = await window.api.gitCheckout(currentCwd, b);
        if (res.ok) { flashStatus('已切换到 ' + b); await refresh(); }
        else flashStatus(res.error || '切换失败');
      };
    });
    setTimeout(() => document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) menu.remove(); }), 0);
  }

  function closePanel() { if (panelEl) panelEl.classList.add('hidden'); }

  /* 克隆仓库弹窗（参考 CodeBuddy 空状态引导） */
  function cloneDialog() {
    const mask = document.createElement('div');
    mask.className = 'modal';
    mask.innerHTML =
      '<div class="modal-box">' +
        '<h3>克隆仓库</h3>' +
        '<label>仓库 URL</label>' +
        '<input id="clone-url" placeholder="https://github.com/user/repo.git" spellcheck="false">' +
        '<label style="margin-top:12px">克隆到</label>' +
        '<div style="display:flex;gap:8px"><input id="clone-dest" readonly placeholder="选择目标文件夹" style="flex:1"><button class="action" id="clone-pick">选择…</button></div>' +
        '<div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="action" id="clone-cancel">取消</button>' +
          '<button class="git-commit-btn" id="clone-go">克隆</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);
    let dest = null;
    mask.querySelector('#clone-pick').onclick = async () => {
      const p = await window.api.pickFolder();
      if (p) { dest = p; mask.querySelector('#clone-dest').value = p; }
    };
    mask.querySelector('#clone-cancel').onclick = () => mask.remove();
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) mask.remove(); });
    mask.querySelector('#clone-go').onclick = async () => {
      const url = mask.querySelector('#clone-url').value.trim();
      if (!url) { flashStatus('请输入仓库 URL'); return; }
      if (!dest) { flashStatus('请选择克隆位置'); return; }
      flashStatus('克隆中，请稍候…');
      const r = await window.api.gitClone(url, dest);
      mask.remove();
      if (r.ok) {
        flashStatus('克隆完成');
        const name = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[\\/]/).pop();
        if (typeof setWorkdir === 'function' && name) setWorkdir(dest + '/' + name);
      } else flashStatus(r.error || '克隆失败');
    };
    mask.querySelector('#clone-url').focus();
  }
  window.cloneRepoFlow = cloneDialog;

  (function bind() {
    const p = ensurePanel();
    document.getElementById('git-btn').onclick = openGitPanel;
    const treeClone = document.getElementById('tree-clone-btn');
    if (treeClone) treeClone.onclick = () => cloneDialog();
    p.querySelector('#git-close').onclick = closePanel;
    p.querySelector('#git-refresh').onclick = () => { viewMode = 'changes'; refresh(); };
    p.querySelector('#git-branch').onclick = toggleBranchMenu;
    p.querySelector('#git-history').onclick = async () => {
      if (viewMode === 'history') { viewMode = 'changes'; await refresh(); }
      else await showHistory();
    };
    p.querySelector('#git-pull').onclick = async () => {
      const r = await window.api.gitPull(currentCwd);
      if (r.ok) { flashStatus('已拉取远端更新'); await refresh(); }
      else flashStatus(r.error || '拉取失败');
    };
    p.querySelector('#git-push').onclick = async () => {
      const r = await window.api.gitPush(currentCwd);
      if (r.ok) flashStatus('已推送到远端');
      else flashStatus(r.error || '推送失败');
    };
    p.querySelector('#git-commit').onclick = commit;
    p.querySelector('#git-msg').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    // Esc 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panelEl && !panelEl.classList.contains('hidden')) closePanel();
    });
  })();

  window.openGitPanel = openGitPanel;
})();
