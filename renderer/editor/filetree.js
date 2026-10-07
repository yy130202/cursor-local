/* Cursor Local - 文件树模块
 *
 * 【职责】左侧资源管理器的全部行为：目录树渲染、过滤、Git 状态标记、
 *        右键菜单、内联新建与重命名。
 * 【依赖】EditorState / window.api（editor.js 门面）、CL.util（core.js）
 * 【导出】CL.editor.filetree
 */
(function () {
  const CL = (window.CL = window.CL || {});
  CL.editor = CL.editor || {};

/* ---- 文件树 ---- */
let treeRenderSeq = 0;
/* 每次 renderTree 的共享目录读取缓存：同一目录在过滤判定与实际渲染中
   往往被读两次（dirHasMatch 一次、renderDir 一次），缓存后省掉一半 IPC。
   生命周期仅限单次渲染，不做跨渲染缓存，避免文件变更后读到陈旧内容。 */
let treeDirCache = null;

function currentTreeFilter() {
  const el = document.getElementById('tree-filter');
  return el ? el.value.trim().toLowerCase() : '';
}
async function readDirCached(dirPath) {
  if (!treeDirCache) return window.api.readDir(dirPath);
  if (!treeDirCache.has(dirPath)) {
    treeDirCache.set(dirPath, await window.api.readDir(dirPath));
  }
  return treeDirCache.get(dirPath);
}
async function renderTree() {
  const seq = ++treeRenderSeq;
  const tree = document.getElementById('filetree');
  if (!EditorState.currentFolder) return;
  tree.innerHTML = '';
  treeDirCache = new Map();
  const filter = currentTreeFilter();
  try {
    await renderDir(EditorState.currentFolder, tree, 0, seq, filter);
  } finally {
    treeDirCache = null;
  }
}

/* 轻量更新选中高亮（点文件时用，避免整树重建导致滚动跳动） */
function updateTreeActive() {
  const rows = document.querySelectorAll('#filetree .tree-item');
  rows.forEach((r) => r.classList.toggle('active', r.dataset.path === EditorState.activePath));
}

/* 目录是否含匹配过滤词的文件（递归，限深）
   用 readDirCached 复用同一次渲染中已读过的目录，避免重复 IPC 往返。 */
async function dirHasMatch(dirPath, filter, depth = 0) {
  if (depth > 6) return false;
  let entries;
  try { entries = await readDirCached(dirPath); } catch { return false; }
  for (const ent of entries) {
    if (ent.isDir) { if (await dirHasMatch(ent.path, filter, depth + 1)) return true; }
    else if (ent.name.toLowerCase().includes(filter)) return true;
  }
  return false;
}

async function renderDir(dirPath, container, depth, seq, filter) {
  const entries = await readDirCached(dirPath);
  if (seq !== treeRenderSeq) return; // 已被更新的渲染取代，丢弃过期结果
  const BATCH = 50; // 每帧渲染条数，避免大目录一次性 append 卡顿
  for (let i = 0; i < entries.length; i++) {
    if (seq !== treeRenderSeq) return; // 渲染中被取代则中止
    if (i > 0 && i % BATCH === 0) {
      await new Promise((r) => requestAnimationFrame(r));
      if (seq !== treeRenderSeq) return;
    }
    const ent = entries[i];
    // 过滤模式：文件按名匹配，目录递归判断是否含匹配
    if (filter) {
      if (ent.isDir) { if (!(await dirHasMatch(ent.path, filter))) continue; }
      else if (!ent.name.toLowerCase().includes(filter)) continue;
    }
    const row = document.createElement('div');
    row.className = 'tree-item';
    row.dataset.path = ent.path;
    if (ent.path === EditorState.activePath) row.classList.add('active');
    row.style.paddingLeft = 10 + depth * 16 + 'px';
    // git 状态标记（VS Code 风：M蓝 / A/U 绿 / D 红，目录含变更显示圆点）
    const g = gitMarkOf(ent.path, ent.isDir);
    const gSuffix = g ? '<span class="tree-git">' + g.ch + '</span>' : '';
    if (ent.isDir) {
      const open = EditorState.treeOpenDirs.has(ent.path);
      row.innerHTML =
        '<span class="twist">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="icon icon-dir">' + (window.lucideIcon ? window.lucideIcon(open ? 'folder-open' : 'folder') : '') + '</span>' +
        '<span class="name' + (g ? ' git-name-' + g.cls : '') + '">' + CL.util.escapeHtml(ent.name) + '</span>' + gSuffix;
      row.onclick = () => {
        if (EditorState.treeOpenDirs.has(ent.path)) EditorState.treeOpenDirs.delete(ent.path);
        else EditorState.treeOpenDirs.add(ent.path);
        renderTree();
      };
      row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); showFileTreeMenu(ev.clientX, ev.clientY, ent, dirPath); };
      container.appendChild(row);
      if (open) {
        const childBox = document.createElement('div');
        container.appendChild(childBox);
        await renderDir(ent.path, childBox, depth + 1, seq, filter);
      }
    } else {
      const ext = CL.util.extOf(ent.path);
      row.innerHTML =
        '<span class="twist"></span>' +
        '<span class="icon icon-file ' + ext + '">' + (window.lucideIcon ? window.lucideIcon(CL.util.fileIconName(ext)) : '') + '</span>' +
        '<span class="name' + (g ? ' git-name-' + g.cls : '') + '">' + CL.util.escapeHtml(ent.name) + '</span>' + gSuffix;
      row.onclick = () => CL.editor.openFile(ent.path);
      row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); showFileTreeMenu(ev.clientX, ev.clientY, ent, dirPath); };
      container.appendChild(row);
    }
  }
}

/* git 状态缓存（由 git 面板刷新时更新）→ 文件树标记 */
function relTreePath(absPath) {
  const cwd = EditorState.currentFolder;
  if (!cwd || !absPath.startsWith(cwd)) return absPath.replace(/\\/g, '/');
  return absPath.slice(cwd.length + 1).replace(/\\/g, '/');
}

/* 目录 git 标记的祖先集合：gitStatusMap 每次刷新后调用一次，
   把所有变更文件的所有祖先目录收集成 Set，查询由 O(变更数) 降为 O(1)。
   原实现对每个目录 entry 遍历整个 map.keys()，大仓库下是 O(目录数 × 变更数)。 */
function buildGitDirSet() {
  const map = window.__gitStatusMap;
  const set = new Set();
  if (!map || !map.size) return set;
  for (const key of map.keys()) {
    // 逐级收集祖先：a/b/c.ts → a, a/b
    let i = key.indexOf('/');
    while (i >= 0) {
      set.add(key.slice(0, i));
      i = key.indexOf('/', i + 1);
    }
  }
  return set;
}

/* 供 git 面板在设置 __gitStatusMap 后调用，刷新派生缓存 */
function invalidateGitMarks() {
  gitDirSet = buildGitDirSet();
  gitDirSetFor = window.__gitStatusMap;
}
let gitDirSet = new Set();
let gitDirSetFor = null;

function gitMarkOf(absPath, isDir) {
  const map = window.__gitStatusMap;
  if (!map || !map.size) return null;
  const rel = relTreePath(absPath);
  if (isDir) {
    // 目录：任一子文件有变更 → 标记 modified 样式圆点（Set O(1) 查询）
    if (gitDirSetFor !== map) invalidateGitMarks();
    if (gitDirSet.has(rel) || map.has(rel)) return { ch: '●', cls: 'm' };
    return null;
  }
  const hit = map.get(rel);
  if (!hit) return null;
  const table = { added: ['A', 'a'], modified: ['M', 'm'], deleted: ['D', 'd'], untracked: ['U', 'u'], renamed: ['R', 'm'], conflict: ['!', 'd'] };
  const [ch, cls] = table[hit.status] || ['M', 'm'];
  return { ch, cls };
}

/* ---- 文件树右键菜单 + 内联新建/重命名 ---- */
function showFileTreeMenu(x, y, ent, parentDir) {
  let menu = document.getElementById('tree-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'tree-menu';
    menu.className = 'ctx-menu';
    document.body.appendChild(menu);
  }
  const mk = (label, icon, act) =>
    '<div class="ctx-item" data-act="' + label + '"><span class="ctx-ico">' + (window.lucideIcon(icon) || '') + '</span><span class="ctx-label">' + label + '</span></div>';
  menu.innerHTML =
    mk('新建文件', 'file-plus') +
    mk('新建文件夹', 'folder-plus') +
    '<div class="ctx-sep"></div>' +
    mk('重命名', 'pencil') +
    mk('删除', 'trash-2') +
    mk('复制路径', 'copy');
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.classList.remove('hidden');
  const actions = {
    '新建文件': () => startInlineCreate(parentDir, false),
    '新建文件夹': () => startInlineCreate(parentDir, true),
    '重命名': () => startInlineRename(ent),
    '删除': async () => { if (confirm('确定删除「' + ent.name + '」？')) { await window.api.deletePath(ent.path); renderTree(); } },
    '复制路径': () => { navigator.clipboard.writeText(ent.path); CL.editor.flashStatus('已复制路径'); }
  };
  menu.querySelectorAll('.ctx-item').forEach((it) => {
    it.onclick = () => { menu.classList.add('hidden'); (actions[it.dataset.act] || (() => {}))(); };
  });
  setTimeout(() => document.addEventListener('click', () => menu.classList.add('hidden'), { once: true }), 0);
}

function startInlineRename(ent) {
  const tree = document.getElementById('filetree');
  const box = document.createElement('div');
  box.className = 'tree-item';
  box.style.paddingLeft = '10px';
  box.innerHTML = '<span class="twist"></span><input class="tree-input" value="' + CL.util.escapeHtml(ent.name) + '">';
  tree.prepend(box);
  const input = box.querySelector('input');
  input.focus(); input.select();
  const finish = async (commit) => {
    box.remove();
    const name = input.value.trim();
    if (commit && name && name !== ent.name) {
      const to = window.api.pathJoin(window.api.pathDirname(ent.path), name);
      await window.api.rename(ent.path, to);
      renderTree();
    }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

function startInlineCreate(dirPath, isDir) {
  const tree = document.getElementById('filetree');
  const box = document.createElement('div');
  box.className = 'tree-item';
  box.style.paddingLeft = '10px';
  box.innerHTML = '<span class="twist"></span><input class="tree-input" placeholder="' + (isDir ? '文件夹名称' : '文件名称') + '">';
  tree.prepend(box);
  const input = box.querySelector('input');
  input.focus();
  const finish = async (commit) => {
    box.remove();
    const name = input.value.trim();
    if (commit && name) {
      const full = window.api.pathJoin(dirPath, name);
      if (isDir) await window.api.createDir(full);
      else { await window.api.createFile(full); CL.editor.openFile(full); }
      renderTree();
    }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}


  /* ---- 模块导出 ---- */
  CL.editor.filetree = {
    render: renderTree,
    updateActive: updateTreeActive,
    relPath: relTreePath,
    gitMark: gitMarkOf,
    invalidateGitMarks: invalidateGitMarks,
    startCreate: startInlineCreate,
    startRename: startInlineRename
  };
})();
