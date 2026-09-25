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
      row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); showFileTreeMenu(ev.clientX, ev.clientY, ent, dirPath); };
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
      row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); showFileTreeMenu(ev.clientX, ev.clientY, ent, dirPath); };
      container.appendChild(row);
    }
  }
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
    '复制路径': () => { navigator.clipboard.writeText(ent.path); flashStatus('已复制路径'); }
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
  box.innerHTML = '<span class="twist"></span><input class="tree-input" value="' + escapeHtml(ent.name) + '">';
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
      else { await window.api.createFile(full); openFile(full); }
      renderTree();
    }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
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
      scrollBeyondLastLine: false,
      tabCompletion: 'off',          // Tab 用于接受 AI 补全
      inlineSuggest: { enabled: true },
      quickSuggestions: { other: true, comments: true, strings: true }
    });
    setupInlineCompletion();  // AI 代码补全（Tab 接受）
    if (typeof window.setupEditorContextMenu === 'function') window.setupEditorContextMenu(EditorState.editor);
    monacoReady = true;
    while (pendingOpens.length) openFile(pendingOpens.shift());
  } catch (err) {
    window.__monacoErr = String((err && err.stack) || err);
  }
}, function (err) {
  window.__monacoErr = 'require 加载失败: ' + String(err);
});

/* ---- AI 代码补全（Copilot 式灰字，Tab 接受） ---- */
let lastInlineAt = 0;
function setupInlineCompletion() {
  const provider = {
    provideInlineCompletions: async (model, position, context, token) => {
      if (window.__aiCompleteEnabled === false) return { items: [] };
      const now = Date.now();
      if (now - lastInlineAt < 900) return { items: [] }; // 防抖
      lastInlineAt = now;
      const before = model.getValueInRange({
        startLineNumber: 1, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: position.column
      });
      if (before.trim().length < 4) return { items: [] };
      let r;
      try { r = await window.api.aiComplete(before, model.getLanguageId()); }
      catch { return { items: [] }; }
      if (!r || !r.ok || !r.completion) return { items: [] };
      const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
      return { items: [{ insertText: r.completion, range }] };
    },
    freeInlineCompletions: () => {}
  };
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, provider);
}

/* ---- 选区 AI 操作（解释 / 注释 / 改写 / 测试），暴露全局供右键菜单与快捷键共用 ---- */
window.applyAiEdit = async (instruction) => {
  const ed = EditorState.editor;
  if (!ed) return;
  const sel = ed.getSelection();
  if (!sel || sel.isEmpty()) { flashStatus('请先选中代码'); return; }
  const text = ed.getModel().getValueInRange(sel);
  flashStatus('AI 处理中…');
  let r;
  try { r = await window.api.aiEdit(text, instruction); }
  catch { flashStatus('AI 调用失败'); return; }
  if (!r.ok) { flashStatus(r.error || 'AI 处理失败'); return; }
  if (instruction === 'explain') {
    showAiPanel('解释', r.result, null);
  } else {
    ed.executeEdits('ai-edit', [{ range: sel, text: r.result, forceMoveMarkers: true }]);
    flashStatus('已应用「' + ({ comment: '注释', rewrite: '改写', test: '测试' }[instruction] || instruction) + '」');
  }
};

/* 手动触发 AI 补全 */
window.triggerAiComplete = () => {
  const ed = EditorState.editor;
  if (ed) ed.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
};

function flashStatus(msg) {
  document.getElementById('status-right').textContent = msg;
  setTimeout(() => {
    const c = EditorState.currentFolder;
    document.getElementById('status-right').textContent = c ? '工作目录: ' + c : '';
  }, 2500);
}

/* AI 结果浮窗（解释类） */
function showAiPanel(title, content, onReplace) {
  let p = document.getElementById('ai-panel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'ai-panel';
    p.className = 'ai-panel';
    document.body.appendChild(p);
  }
  p.innerHTML =
    '<div class="ai-panel-head"><span>' + escapeHtml(title) + '</span><button class="ai-panel-close">×</button></div>' +
    '<pre>' + escapeHtml(content) + '</pre>';
  p.classList.remove('hidden');
  p.querySelector('.ai-panel-close').onclick = () => p.classList.add('hidden');
}

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
  if (ev) ev.stopPropagation();
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

function closeOthers(path) {
  const keep = EditorState.tabs.find((t) => t.path === path);
  if (!keep) return;
  EditorState.tabs.forEach((t) => { if (t !== keep) t.model.dispose(); });
  EditorState.tabs = [keep];
  EditorState.activePath = path;
  const ed = getEditor();
  if (ed) ed.setModel(keep.model);
  renderTabs();
}

function closeAllTabs() {
  EditorState.tabs.forEach((t) => t.model.dispose());
  EditorState.tabs = [];
  EditorState.activePath = null;
  const ed = getEditor();
  if (ed) ed.setModel(null);
  document.getElementById('editor-empty').classList.remove('hidden');
  renderTabs();
}

function showTabMenu(x, y, path) {
  let menu = document.getElementById('tab-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'tab-menu';
    menu.className = 'ctx-menu';
    document.body.appendChild(menu);
  }
  menu.innerHTML =
    '<div class="ctx-item" data-act="close"><span class="ctx-label">关闭</span></div>' +
    '<div class="ctx-item" data-act="close-others"><span class="ctx-label">关闭其他</span></div>' +
    '<div class="ctx-item" data-act="close-all"><span class="ctx-label">关闭所有</span></div>' +
    '<div class="ctx-sep"></div>' +
    '<div class="ctx-item" data-act="copy-path"><span class="ctx-ico">' + (window.lucideIcon('copy') || '') + '</span><span class="ctx-label">复制路径</span></div>';
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.ctx-item').forEach((it) => {
    it.onclick = () => {
      menu.classList.add('hidden');
      const act = it.dataset.act;
      if (act === 'close') closeTab(path);
      else if (act === 'close-others') closeOthers(path);
      else if (act === 'close-all') closeAllTabs();
      else if (act === 'copy-path') { navigator.clipboard.writeText(path); flashStatus('已复制路径'); }
    };
  });
  setTimeout(() => document.addEventListener('click', () => menu.classList.add('hidden'), { once: true }), 0);
}

function renderTabs() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  EditorState.tabs.forEach((t, idx) => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.path === EditorState.activePath ? ' active' : '');
    el.draggable = true;
    el.innerHTML =
      '<span>' + escapeHtml(t.name) + '</span>' +
      (t.dirty ? '<span class="dirty">●</span>' : '') +
      '<span class="close" title="关闭">×</span>';
    el.onclick = () => openFile(t.path);
    el.querySelector('.close').onclick = (ev) => closeTab(t.path, ev);
    el.oncontextmenu = (ev) => { ev.preventDefault(); showTabMenu(ev.clientX, ev.clientY, t.path); };
    el.ondragstart = (ev) => { ev.dataTransfer.setData('text/plain', String(idx)); el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
    el.ondragover = (ev) => ev.preventDefault();
    el.ondrop = (ev) => {
      ev.preventDefault();
      const from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
      if (from === idx || Number.isNaN(from)) return;
      const [moved] = EditorState.tabs.splice(from, 1);
      EditorState.tabs.splice(idx, 0, moved);
      renderTabs();
    };
    bar.appendChild(el);
  });
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
