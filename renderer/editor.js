/* Cursor Local - Editor Window：文件树 + 多标签 + Monaco 编辑器 */

/* ---- Monaco 初始化 ---- */
const MONACO_BASE = new URL('../node_modules/monaco-editor/min/vs/', location.href).href;
const MONACO_SCHEME = 'monaco://vs/'; // 主进程 protocol.handle 服务 Monaco 文件（worker 同源加载）
window.MonacoEnvironment = {
  baseUrl: MONACO_SCHEME,
  // worker 直接以 monaco:// 协议创建（CSP 已放行 monaco:），worker origin = monaco://vs/
  // 语言服务 = IDEA/VS Code 式智能补全：符号图标 + 签名提示 + 诊断
  getWorkerUrl: function () {
    return MONACO_SCHEME + 'base/worker/workerMain.js';
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
function currentTreeFilter() {
  const el = document.getElementById('tree-filter');
  return el ? el.value.trim().toLowerCase() : '';
}
async function renderTree() {
  const seq = ++treeRenderSeq;
  const tree = document.getElementById('filetree');
  if (!EditorState.currentFolder) return;
  tree.innerHTML = '';
  const filter = currentTreeFilter();
  await renderDir(EditorState.currentFolder, tree, 0, seq, filter);
}

/* 轻量更新选中高亮（点文件时用，避免整树重建导致滚动跳动） */
function updateTreeActive() {
  const rows = document.querySelectorAll('#filetree .tree-item');
  rows.forEach((r) => r.classList.toggle('active', r.dataset.path === EditorState.activePath));
}

/* 目录是否含匹配过滤词的文件（递归，限深） */
async function dirHasMatch(dirPath, filter, depth = 0) {
  if (depth > 6) return false;
  let entries;
  try { entries = await window.api.readDir(dirPath); } catch { return false; }
  for (const ent of entries) {
    if (ent.isDir) { if (await dirHasMatch(ent.path, filter, depth + 1)) return true; }
    else if (ent.name.toLowerCase().includes(filter)) return true;
  }
  return false;
}

async function renderDir(dirPath, container, depth, seq, filter) {
  const entries = await window.api.readDir(dirPath);
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
        '<span class="name' + (g ? ' git-name-' + g.cls : '') + '">' + escapeHtml(ent.name) + '</span>' + gSuffix;
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
      const ext = extOf(ent.path);
      row.innerHTML =
        '<span class="twist"></span>' +
        '<span class="icon icon-file ' + ext + '">' + (window.lucideIcon ? window.lucideIcon(fileIconName(ext)) : '') + '</span>' +
        '<span class="name' + (g ? ' git-name-' + g.cls : '') + '">' + escapeHtml(ent.name) + '</span>' + gSuffix;
      row.onclick = () => openFile(ent.path);
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
function gitMarkOf(absPath, isDir) {
  const map = window.__gitStatusMap;
  if (!map || !map.size) return null;
  const rel = relTreePath(absPath);
  if (isDir) {
    // 目录：任一子文件有变更 → 标记 modified 样式圆点
    for (const key of map.keys()) {
      if (key === rel || key.startsWith(rel + '/')) return { ch: '●', cls: 'm' };
    }
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
      fontSize: window.__editorFontSize || 14,
      tabSize: window.__editorTabSize || 2,
      wordWrap: window.__editorWordWrap || 'off',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabCompletion: 'off',          // Tab 用于接受 AI 补全
      inlineSuggest: { enabled: true },
      unusualLineTerminator: 'off',  // 关闭孤立 \r 的整行红色警告（CRLF 文件常见误报）
      quickSuggestions: { other: true, comments: true, strings: true },
      // VS Code 式增强：括号对着色 / 缩进指南 / 粘滞滚动 / 折叠图标
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true },
      stickyScroll: { enabled: true },
      folding: true,
      showFoldingControls: 'always'
    });
    setupInlineCompletion();  // AI 代码补全（Tab 接受）
    if (typeof window.setupEditorContextMenu === 'function') window.setupEditorContextMenu(EditorState.editor);
    // 状态栏：光标行列号实时更新
    EditorState.editor.onDidChangeCursorPosition((e) => {
      const el = document.getElementById('status-cursor');
      if (el) el.textContent = '行 ' + e.position.lineNumber + ', 列 ' + e.position.column;
      // 面包屑符号节流更新
      clearTimeout(breadcrumbTimer);
      breadcrumbTimer = setTimeout(() => updateBreadcrumb(), 250);
    });
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
    // 统一行尾为 \n：消除 CRLF 中孤立的 \r，避免 Monaco 整行红色「异常行终止符」标记
    const content = String(r.content).replace(/\r\n?/g, '\n');
    // 大文件降级：超过阈值用 plaintext（跳过 tokenization），并关闭 minimap
    const threshold = window.__largeFileThreshold ?? 1048576;
    const isLarge = (typeof r.size === 'number' ? r.size : content.length) > threshold;
    const lang = isLarge ? 'plaintext' : (LANG_BY_EXT[extOf(filePath)] || 'plaintext');
    const model = monaco.editor.createModel(content, lang);
    model.onDidChangeContent(() => {
      if (tab.__suppressDirty) return;
      tab.dirty = true;
      renderTabs();
      // 自动保存（防抖）
      if (window.__autoSave) {
        clearTimeout(tab.__saveTimer);
        tab.__saveTimer = setTimeout(async () => {
          await window.api.writeFile(tab.path, tab.model.getValue());
          tab.dirty = false;
          renderTabs();
          flashStatus('已自动保存');
        }, 1200);
      }
    });
    tab = { path: filePath, name: filePath.split(/[\\/]/).pop(), model, dirty: false, large: isLarge };
    EditorState.tabs.push(tab);
  }
  EditorState.activePath = filePath;
  const ed = getEditor();
  if (ed) {
    ed.setModel(tab.model);
    // 大文件关 minimap，小文件恢复
    ed.updateOptions({ minimap: { enabled: !tab.large } });
    ed.focus();
  }
  document.getElementById('editor-empty').classList.add('hidden');
  renderTabs();
  updateTreeActive(); // 只更新当前选中高亮，不重建文件树（避免滚动跳动）
  updateBreadcrumb();
  applyGitDecorations(tab); // gutter 变更行标记（异步）
  const langEl = document.getElementById('status-lang');
  if (langEl) langEl.textContent = langDisplay(tab.large ? 'plaintext' : (LANG_BY_EXT[extOf(filePath)] || 'plaintext'));
}

/* 语言显示名 */
function langDisplay(id) {
  const map = { javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', html: 'HTML', css: 'CSS', markdown: 'Markdown', python: 'Python', shell: 'Shell', yaml: 'YAML', xml: 'XML', sql: 'SQL', plaintext: '纯文本' };
  return map[id] || (id ? id : '纯文本');
}

/* 编辑器 gutter：git 变更行标记（绿条） */
async function applyGitDecorations(tab) {
  try {
    const cwd = EditorState.currentFolder;
    if (!cwd || !tab || !window.api.gitChangedLines) return;
    const rel = relTreePath(tab.path);
    const r = await window.api.gitChangedLines(cwd, rel);
    if (!r.ok || !r.lines.length) return;
    const decos = r.lines.map((l) => ({
      range: new monaco.Range(l, 1, l, 1),
      options: { isWholeLine: true, linesDecorationsClassName: 'git-gutter-change' }
    }));
    if (tab.gitDecos && tab.gitDecos.clear) tab.gitDecos.clear();
    tab.gitDecos = EditorState.editor.createDecorationsCollection(decos);
  } catch { /* 忽略（非 git 目录等） */ }
}

/* 释放单个 tab 的全部资源（saveTimer + git decoration + model） */
function disposeTab(tab) {
  if (!tab) return;
  if (tab.__saveTimer) { clearTimeout(tab.__saveTimer); tab.__saveTimer = null; }
  if (tab.gitDecos && tab.gitDecos.clear) { try { tab.gitDecos.clear(); } catch { /* ignore */ } tab.gitDecos = null; }
  if (tab.model) { try { tab.model.dispose(); } catch { /* ignore */ } tab.model = null; }
}

function closeTab(path, ev) {
  if (ev) ev.stopPropagation();
  const idx = EditorState.tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  const tab = EditorState.tabs[idx];
  if (tab.dirty && !confirm('「' + tab.name + '」有未保存的更改，确定关闭吗？')) return;
  disposeTab(tab);
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
  const dirtyOthers = EditorState.tabs.filter((t) => t !== keep && t.dirty);
  if (dirtyOthers.length && !confirm('有 ' + dirtyOthers.length + ' 个标签存在未保存更改，确定关闭吗？')) return;
  EditorState.tabs.forEach((t) => { if (t !== keep) disposeTab(t); });
  EditorState.tabs = [keep];
  EditorState.activePath = path;
  const ed = getEditor();
  if (ed) ed.setModel(keep.model);
  renderTabs();
}

function closeAllTabs() {
  const dirtyCount = EditorState.tabs.filter((t) => t.dirty).length;
  if (dirtyCount && !confirm('有 ' + dirtyCount + ' 个标签存在未保存更改，确定全部关闭吗？')) return;
  EditorState.tabs.forEach((t) => disposeTab(t));
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
  // 切换文件夹：释放旧目录所有已打开标签的 model，避免内存常驻
  EditorState.tabs.forEach((t) => disposeTab(t));
  EditorState.tabs = [];
  EditorState.activePath = null;
  const ed = getEditor();
  if (ed) ed.setModel(null);
  document.getElementById('editor-empty').classList.remove('hidden');
  renderTabs();
  document.getElementById('workdir-label').textContent = dir;
  document.getElementById('status-right').textContent = '工作目录: ' + dir;
  renderTree();
  // 统计项目文件数（顶层条目）
  window.api.readDir(dir).then((list) => {
    const el = document.getElementById('stat-files');
    if (el) el.textContent = list ? String(list.length) : '—';
  });
}

window.openFolder = openFolder;
window.startInlineCreate = startInlineCreate;

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

/* 文件树过滤输入 */
(function bindTreeFilter() {
  const el = document.getElementById('tree-filter');
  if (!el) return;
  let t;
  el.oninput = () => { clearTimeout(t); t = setTimeout(() => renderTree(), 200); };
  el.onkeydown = (e) => { if (e.key === 'Escape') { el.value = ''; renderTree(); } };
})();

/* 文件树面板横向拖拽调整宽度 */
(function bindTreeResize() {
  const panel = document.getElementById('filetree-panel');
  const resizer = document.getElementById('tree-resizer');
  if (!panel || !resizer) return;
  let startX = 0, startW = 0;
  resizer.onmousedown = (e) => {
    e.preventDefault();
    startX = e.clientX; startW = panel.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  window.addEventListener('mousemove', (e) => {
    if (!resizer.classList.contains('dragging')) return;
    const w = Math.max(160, Math.min(560, startW + (e.clientX - startX)));
    panel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

/* ---- 面包屑导航 + 符号导航（VS Code 式） ---- */
const SYMBOL_KIND_LABEL = { 0:'文件',1:'模块',2:'命名空间',3:'包',4:'类',5:'方法',6:'属性',7:'字段',8:'构造',9:'枚举',10:'接口',11:'函数',12:'变量',13:'常量',14:'字符串',15:'数字',16:'布尔',17:'数组',18:'对象',19:'键',20:'空',21:'枚举成员',22:'结构',23:'事件',24:'操作符',25:'类型参数' };
function symbolKindLabel(k) { return SYMBOL_KIND_LABEL[k] || '符号'; }

async function fetchSymbols(model) {
  try {
    if (monaco.languages.DocumentSymbolProvider && monaco.languages.DocumentSymbolProvider.all) {
      const all = monaco.languages.DocumentSymbolProvider.all();
      for (const p of all) {
        const syms = await p.provideDocumentSymbols(model, new monaco.CancellationTokenSource().token);
        if (syms && syms.length) return syms;
      }
    }
  } catch (e) { /* ignore */ }
  return [];
}

function findSymbolPath(syms, line, path) {
  for (const s of syms || []) {
    if (line >= s.range.startLineNumber && line <= s.range.endLineNumber) {
      path.push(s);
      if (s.children && s.children.length) findSymbolPath(s.children, line, path);
      return;
    }
  }
}

function flattenSymbols(syms, depth, out) {
  for (const s of syms || []) {
    out.push({ name: s.name, kind: s.kind, line: s.range.startLineNumber, col: s.range.startColumn, depth });
    if (s.children && s.children.length) flattenSymbols(s.children, depth + 1, out);
  }
}

let breadcrumbTimer = null;
function updateBreadcrumb() {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  const ed = EditorState.editor;
  const model = ed && ed.getModel();
  const tab = EditorState.tabs.find((t) => t.path === EditorState.activePath);
  if (!model || !tab) { el.innerHTML = ''; return; }
  const cwd = EditorState.currentFolder || '';
  let rel = tab.path;
  if (cwd && tab.path.startsWith(cwd)) rel = tab.path.slice(cwd.length).replace(/^[\\/]/, '');
  const parts = rel.split(/[\\/]/);
  let html = '<span class="bc-seg bc-file"><span class="bc-icon">' + (window.lucideIcon ? window.lucideIcon(fileIconName(extOf(tab.path))) : '') + '</span>' + escapeHtml(parts[parts.length - 1] || rel) + '</span>';
  el.innerHTML = html;
  // 符号（异步）：光标所在作用域链
  const line = (ed.getPosition() || { lineNumber: 1 }).lineNumber;
  fetchSymbols(model).then((syms) => {
    const path = [];
    findSymbolPath(syms, line, path);
    let sh = '';
    for (const s of path) sh += '<span class="bc-sep">›</span><span class="bc-seg bc-symbol" data-line="' + s.range.startLineNumber + '">' + escapeHtml(s.name) + '</span>';
    const fileSeg = el.querySelector('.bc-file');
    if (fileSeg) fileSeg.insertAdjacentHTML('afterend', sh);
    el.querySelectorAll('.bc-symbol').forEach((n) => {
      n.onclick = () => { ed.setPosition({ lineNumber: +n.dataset.line, column: 1 }); ed.revealLineInCenter(+n.dataset.line); ed.focus(); };
    });
  });
}

/* 符号搜索（Ctrl+Shift+O）：下拉面板 */
window.openSymbols = function () {
  const ed = EditorState.editor;
  const model = ed && ed.getModel();
  if (!model) return;
  const existing = document.getElementById('symbols-panel');
  if (existing) { existing.remove(); return; }
  const panel = document.createElement('div');
  panel.id = 'symbols-panel';
  panel.innerHTML = '<input class="sym-search" id="sym-search" placeholder="搜索符号…" spellcheck="false"><div class="sym-list" id="sym-list"></div>';
  document.body.appendChild(panel);
  panel.style.top = '80px'; panel.style.right = '24px';
  let flat = [];
  fetchSymbols(model).then((syms) => { flattenSymbols(syms, 0, flat); renderSymList(flat); });
  function renderSymList(list) {
    const box = document.getElementById('sym-list');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="sym-empty">此文件无符号（或语言不支持）</div>'; return; }
    box.innerHTML = list.map((s) =>
      '<div class="sym-item" data-line="' + s.line + '">' +
        '<span class="sym-kind">' + symbolKindLabel(s.kind) + '</span>' +
        '<span class="sym-name" style="padding-left:' + (s.depth * 14) + 'px">' + escapeHtml(s.name) + '</span>' +
        '<span class="sym-line">' + s.line + '</span>' +
      '</div>'
    ).join('');
    box.querySelectorAll('.sym-item').forEach((n) => {
      n.onclick = () => { ed.setPosition({ lineNumber: +n.dataset.line, column: 1 }); ed.revealLineInCenter(+n.dataset.line); ed.focus(); panel.remove(); };
    });
  }
  const search = document.getElementById('sym-search');
  search.oninput = () => { const q = search.value.toLowerCase(); renderSymList(flat.filter((s) => s.name.toLowerCase().includes(q))); };
  search.focus();
  const close = (e) => { if (!panel.contains(e.target)) panel.remove(); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.remove(); });
};
