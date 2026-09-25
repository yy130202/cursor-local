/* Cursor Local - Editor Window：文件树 + 多标签 + Monaco 编辑器 */

/* ---- Monaco 初始化 ---- */
const MONACO_BASE = new URL('../node_modules/monaco-editor/min/vs/', location.href).href;
window.MonacoEnvironment = {
  // 在 file:// 下无法加载后台 worker，返回空 worker 让 Monaco 回退到主线程语法高亮
  getWorker: function () {
    return new Worker(URL.createObjectURL(new Blob(
      ['self.onmessage = function(){};'], { type: 'text/javascript' }
    )));
  }
};

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
  sh: 'shell', bat: 'bat', ps1: 'powershell', java: 'java', go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
  ini: 'ini', toml: 'ini', dockerfile: 'dockerfile'
};

function extOf(p) {
  const base = p.split(/[\\/]/).pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1) : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 根据扩展名选择 lucide 图标 */
function fileIconName(ext) {
  if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'yml', 'yaml', 'toml', 'dockerfile'].includes(ext)) return 'file-code';
  if (ext === 'json') return 'file-json';
  if (ext === 'md') return 'file-text';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp'].includes(ext)) return 'file-image';
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'file-archive';
  return 'file';
}

/* ---- 状态 ---- */
const EditorState = {
  currentFolder: '',
  treeOpenDirs: new Set(),
  tabs: [],           // { path, name, model, dirty }
  activePath: null,
  editor: null
};

/* ---- 文件树 ---- */
let treeRenderSeq = 0;
async function renderTree() {
  const seq = ++treeRenderSeq;
  const tree = document.getElementById('filetree');
  if (!EditorState.currentFolder) return;
  tree.innerHTML = '';
  await renderDir(EditorState.currentFolder, tree, 0, seq);
}

async function renderDir(dirPath, container, depth, seq) {
  const entries = await window.api.readDir(dirPath);
  if (seq !== treeRenderSeq) return; // 已被更新的渲染取代，丢弃过期结果
  for (const ent of entries) {
    const row = document.createElement('div');
    row.className = 'tree-item';
    if (ent.path === EditorState.activePath) row.classList.add('active');
    row.style.paddingLeft = 10 + depth * 16 + 'px';
    if (ent.isDir) {
      const open = EditorState.treeOpenDirs.has(ent.path);
      row.innerHTML =
        '<span class="twist">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="icon icon-dir">' + (window.lucideIcon ? window.lucideIcon(open ? 'folder-open' : 'folder') : '') + '</span>' +
        '<span class="name">' + escapeHtml(ent.name) + '</span>';
      row.onclick = () => {
        if (EditorState.treeOpenDirs.has(ent.path)) EditorState.treeOpenDirs.delete(ent.path);
        else EditorState.treeOpenDirs.add(ent.path);
        renderTree();
      };
      container.appendChild(row);
      if (open) {
        const childBox = document.createElement('div');
        container.appendChild(childBox);
        await renderDir(ent.path, childBox, depth + 1, seq);
      }
    } else {
      const ext = extOf(ent.path);
      row.innerHTML =
        '<span class="twist"></span>' +
        '<span class="icon icon-file ' + ext + '">' + (window.lucideIcon ? window.lucideIcon(fileIconName(ext)) : '') + '</span>' +
        '<span class="name">' + escapeHtml(ent.name) + '</span>';
      row.onclick = () => openFile(ent.path);
      container.appendChild(row);
    }
  }
}

/* ---- 标签页 + Monaco ---- */
let monacoReady = false;
const pendingOpens = [];

require.config({ paths: { vs: MONACO_BASE } });
require(['vs/editor/editor.main'], function () {
  try {
    EditorState.editor = monaco.editor.create(document.getElementById('monaco-container'), {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: true },
      scrollBeyondLastLine: false
    });
    monacoReady = true;
    while (pendingOpens.length) openFile(pendingOpens.shift());
  } catch (err) {
    window.__monacoErr = String((err && err.stack) || err);
  }
}, function (err) {
  window.__monacoErr = 'require 加载失败: ' + String(err);
});

function getEditor() {
  return EditorState.editor;
}

async function openFile(filePath) {
  if (!monacoReady) { pendingOpens.push(filePath); return; }
  let tab = EditorState.tabs.find((t) => t.path === filePath);
  if (!tab) {
    const r = await window.api.readFile(filePath);
    const model = monaco.editor.createModel(
      r.content,
      LANG_BY_EXT[extOf(filePath)] || 'plaintext'
    );
    model.onDidChangeContent(() => {
      if (tab.__suppressDirty) return;
      tab.dirty = true;
      renderTabs();
    });
    tab = { path: filePath, name: filePath.split(/[\\/]/).pop(), model, dirty: false };
    EditorState.tabs.push(tab);
  }
  EditorState.activePath = filePath;
  const ed = getEditor();
  if (ed) {
    ed.setModel(tab.model);
    ed.focus();
  }
  document.getElementById('editor-empty').classList.add('hidden');
  renderTabs();
  renderTree();
}

function closeTab(path, ev) {
  ev.stopPropagation();
  const idx = EditorState.tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  const tab = EditorState.tabs[idx];
  tab.model.dispose();
  EditorState.tabs.splice(idx, 1);
  if (EditorState.activePath === path) {
    const next = EditorState.tabs[idx - 1] || EditorState.tabs[idx] || null;
    EditorState.activePath = next ? next.path : null;
    const ed = getEditor();
    if (ed) ed.setModel(next ? next.model : null);
    if (!next) document.getElementById('editor-empty').classList.remove('hidden');
  }
  renderTabs();
}

function renderTabs() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  for (const t of EditorState.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.path === EditorState.activePath ? ' active' : '');
    el.innerHTML =
      '<span>' + escapeHtml(t.name) + '</span>' +
      (t.dirty ? '<span class="dirty">●</span>' : '') +
      '<span class="close" title="关闭">×</span>';
    el.onclick = () => openFile(t.path);
    el.querySelector('.close').onclick = (ev) => closeTab(t.path, ev);
    bar.appendChild(el);
  }
}

async function saveActive() {
  const tab = EditorState.tabs.find((t) => t.path === EditorState.activePath);
  if (!tab) return;
  await window.api.writeFile(tab.path, tab.model.getValue());
  tab.dirty = false;
  renderTabs();
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveActive();
  }
});

/* ---- 打开文件夹 ---- */
async function openFolder() {
  const dir = await window.api.openFolder();
  if (dir) setWorkdir(dir);
}

function setWorkdir(dir) {
  EditorState.currentFolder = dir;
  EditorState.treeOpenDirs = new Set();
  document.getElementById('workdir-label').textContent = dir;
  document.getElementById('status-right').textContent = '工作目录: ' + dir;
  renderTree();
}

window.openFolder = openFolder;

/* 供截图脚本调用 */
window.__debugState = function () {
  const mc = document.getElementById('monaco-container');
  const ed = EditorState.editor;
  return {
    monaco: typeof window.monaco,
    monacoReady,
    monacoErr: window.__monacoErr || null,
    tabs: EditorState.tabs.length,
    activePath: EditorState.activePath,
    monacoContainerSize: mc ? (mc.clientWidth + 'x' + mc.clientHeight) : 'none',
    editorValueLen: ed && ed.getModel() ? ed.getModel().getValue().length : 0,
    editorLineCount: ed && ed.getModel() ? ed.getModel().getLineCount() : 0,
    tabbarItems: document.getElementById('tabbar').children.length,
    filetreeItems: document.getElementById('filetree').querySelectorAll('.tree-item').length
  };
};

window.__openFolderForDemo = async function (dir) {
  setWorkdir(dir);
  EditorState.treeOpenDirs.add(dir);
  await renderTree();
  // 同时打开一个文件，验证 Monaco 语法高亮
  await openFile(window.api.pathJoin(dir, 'main.js'));
};

/* ---- 文件变更通知（Agent 写文件后联动刷新） ---- */
let fsChangedTimer = null;
window.api.onFsChanged((data) => {
  // 防抖刷新文件树
  if (fsChangedTimer) clearTimeout(fsChangedTimer);
  fsChangedTimer = setTimeout(() => {
    if (EditorState.currentFolder) renderTree();
  }, 300);
  // 已打开的文件自动重载内容
  const tab = EditorState.tabs.find((t) => t.path === data.path);
  if (tab) reloadTabContent(tab);
});

async function reloadTabContent(tab) {
  try {
    const r = await window.api.readFile(tab.path);
    tab.__suppressDirty = true;
    tab.model.setValue(r.content);
    tab.__suppressDirty = false;
    tab.dirty = false;
    renderTabs();
  } catch { /* 文件可能已被删除 */ }
}
