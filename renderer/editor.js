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

/* 工具函数（escapeHtml / extOf / fileIconName / langDisplay）已上移至 core.js，
   统一挂在 CL.util 命名空间下，供所有模块共享。 */

/* ---- 状态 ---- */
const EditorState = {
  currentFolder: '',
  treeOpenDirs: new Set(),
  tabs: [],           // { path, name, model, dirty }
  activePath: null,
  editor: null
};

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
      inlineSuggest: { enabled: true, showToolbar: 'always' },
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
    // Markdown 预览实时更新（编辑时节流重渲染）
    EditorState.editor.onDidChangeModelContent(() => {
      clearTimeout(window.__mdPreviewTimer);
      window.__mdPreviewTimer = setTimeout(() => CL.editor.preview.updateMdPreview(), 300);
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
    '<div class="ai-panel-head"><span>' + CL.util.escapeHtml(title) + '</span><button class="ai-panel-close">×</button></div>' +
    '<pre>' + CL.util.escapeHtml(content) + '</pre>';
  p.classList.remove('hidden');
  p.querySelector('.ai-panel-close').onclick = () => p.classList.add('hidden');
}

function getEditor() {
  return EditorState.editor;
}

async function openFile(filePath) {
  if (!monacoReady) { pendingOpens.push(filePath); return; }
  let tab = EditorState.tabs.find((t) => t.path === filePath);
  // 非文本文件（图片 / 音频 / 视频 / 压缩包）→ 专用预览，不载入 Monaco
  const viewKind = CL.editor.preview.fileViewKind(filePath);
  if (viewKind) {
    if (!tab) {
      tab = { path: filePath, name: filePath.split(/[\\/]/).pop(), model: null, dirty: false, viewKind };
      EditorState.tabs.push(tab);
    }
    EditorState.activePath = filePath;
    document.getElementById('editor-empty').classList.add('hidden');
    renderTabs();
    CL.editor.filetree.updateActive(); // 只更新当前选中高亮，不重建文件树（避免滚动跳动）
    updateBreadcrumb();
    CL.editor.preview.updateMdPreview();
    CL.editor.preview.showFileViewer(filePath, viewKind);
    const langEl2 = document.getElementById('status-lang');
    if (langEl2) langEl2.textContent = VIEW_LABEL[viewKind];
    return;
  }
  if (!tab) {
    const r = await window.api.readFile(filePath);
    // 统一行尾为 \n：消除 CRLF 中孤立的 \r，避免 Monaco 整行红色「异常行终止符」标记
    const content = String(r.content).replace(/\r\n?/g, '\n');
    // 大文件降级：超过阈值用 plaintext（跳过 tokenization），并关闭 minimap
    const threshold = window.__largeFileThreshold ?? 1048576;
    const isLarge = (typeof r.size === 'number' ? r.size : content.length) > threshold;
    const lang = isLarge ? 'plaintext' : (LANG_BY_EXT[CL.util.extOf(filePath)] || 'plaintext');
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
  CL.editor.preview.hideFileViewer(); // 切回文本文件 → 收起文件预览
  const ed = getEditor();
  if (ed) {
    ed.setModel(tab.model);
    // 大文件关 minimap，小文件恢复
    ed.updateOptions({ minimap: { enabled: !tab.large } });
    ed.focus();
  }
  document.getElementById('editor-empty').classList.add('hidden');
  renderTabs();
  CL.editor.filetree.updateActive(); // 只更新当前选中高亮，不重建文件树（避免滚动跳动）
  updateBreadcrumb();
  CL.editor.preview.updateMdPreview();
  applyGitDecorations(tab); // gutter 变更行标记（异步）
  const langEl = document.getElementById('status-lang');
  if (langEl) langEl.textContent = CL.util.langDisplay(tab.large ? 'plaintext' : (LANG_BY_EXT[CL.util.extOf(filePath)] || 'plaintext'));
}

/* 语言显示名 → 已上移至 core.js（CL.util.langDisplay） */

/* 编辑器 gutter：git 变更行标记（绿条） */
async function applyGitDecorations(tab) {
  try {
    const cwd = EditorState.currentFolder;
    if (!cwd || !tab || !window.api.gitChangedLines) return;
    const rel = CL.editor.filetree.relPath(tab.path);
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
    CL.editor.preview.hideFileViewer(); // 关掉预览型文件时同步收起预览面板
    if (next && next.viewKind) {
      openFile(next.path); // 下一个是预览型 → 由 openFile 走预览分支
    } else {
      const ed = getEditor();
      if (ed) ed.setModel(next ? next.model : null);
      if (!next) document.getElementById('editor-empty').classList.remove('hidden');
    }
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
      '<span>' + CL.util.escapeHtml(t.name) + '</span>' +
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
  if (!tab || !tab.model) return; // 图片/音视频/压缩包等预览型文件不可保存
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
  CL.editor.filetree.render();
  // 统计项目文件数（顶层条目）
  window.api.readDir(dir).then((list) => {
    const el = document.getElementById('stat-files');
    if (el) el.textContent = list ? String(list.length) : '—';
  });
}

window.openFolder = openFolder;
window.startInlineCreate = function () { return CL.editor.filetree.startCreate.apply(null, arguments); };

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
  await CL.editor.filetree.render();
  // 同时打开一个文件，验证 Monaco 语法高亮
  await openFile(window.api.pathJoin(dir, 'main.js'));
};

/* ---- 文件变更通知（Agent 写文件后联动刷新） ---- */
let fsChangedTimer = null;
window.api.onFsChanged((data) => {
  // 防抖刷新文件树
  if (fsChangedTimer) clearTimeout(fsChangedTimer);
  fsChangedTimer = setTimeout(() => {
    if (EditorState.currentFolder) CL.editor.filetree.render();
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
  el.oninput = () => { clearTimeout(t); t = setTimeout(() => CL.editor.filetree.render(), 200); };
  el.onkeydown = (e) => { if (e.key === 'Escape') { el.value = ''; CL.editor.filetree.render(); } };
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
  let html = '<span class="bc-seg bc-file"><span class="bc-icon">' + (window.lucideIcon ? window.lucideIcon(CL.util.fileIconName(CL.util.extOf(tab.path))) : '') + '</span>' + CL.util.escapeHtml(parts[parts.length - 1] || rel) + '</span>';
  el.innerHTML = html;
  // 符号（异步）：光标所在作用域链
  const line = (ed.getPosition() || { lineNumber: 1 }).lineNumber;
  fetchSymbols(model).then((syms) => {
    const path = [];
    findSymbolPath(syms, line, path);
    let sh = '';
    for (const s of path) sh += '<span class="bc-sep">›</span><span class="bc-seg bc-symbol" data-line="' + s.range.startLineNumber + '">' + CL.util.escapeHtml(s.name) + '</span>';
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
        '<span class="sym-name" style="padding-left:' + (s.depth * 14) + 'px">' + CL.util.escapeHtml(s.name) + '</span>' +
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

/* ---- 编辑器门面导出（供 editor/* 子模块与跨模块调用） ---- */
(function () {
  const CL = (window.CL = window.CL || {});
  CL.editor = CL.editor || {};
  CL.editor.openFile = openFile;
  CL.editor.flashStatus = flashStatus;
  CL.editor.renderTabs = renderTabs;
  CL.editor.saveActive = saveActive;
  CL.editor.closeTab = closeTab;
  CL.editor.applyGitDecorations = applyGitDecorations;
})();
