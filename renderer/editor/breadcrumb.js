/* Cursor Local - 面包屑与符号导航模块
 *
 * 【职责】编辑器上方的路径面包屑（含函数/类等符号下钻）、大纲符号面板。
 * 【依赖】EditorState / openFile（editor.js 门面）
 * 【导出】CL.editor.breadcrumb
 */
(function () {
  const CL = (window.CL = window.CL || {});
  CL.editor = CL.editor || {};

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

  /* ---- 模块导出 ---- */
  CL.editor.breadcrumb = { update: updateBreadcrumb };
})();
