/* Cursor Local - 预览模块
 *
 * 【职责】编辑器右侧的「预览」能力：
 *   - Markdown 渲染预览（实时同步 / 全屏 / 收起）
 *   - 非文本文件查看器（图片 / 音频 / 视频 / 压缩包）
 *
 * 【依赖】EditorState（editor.js）、CL.util（core.js）、openFile（editor.js 门面）
 * 【导出】CL.editor.preview
 */
(function () {
  const CL = (window.CL = window.CL || {});
  CL.editor = CL.editor || {};


/* ---- Markdown 预览（右侧渲染 + 全屏） ---- */
function isMarkdownPath(p) { return /\.(md|markdown)$/i.test(p || ''); }
function updateMdPreview() {
  const panel = document.getElementById('md-preview');
  if (!panel) return;
  const tab = (typeof EditorState !== 'undefined' && EditorState.tabs)
    ? EditorState.tabs.find((t) => t.path === EditorState.activePath) : null;
  if (!tab || !isMarkdownPath(tab.path)) {
    panel.classList.add('hidden');
    const split = document.getElementById('editor-split');
    if (split) split.classList.remove('preview-full');
    return;
  }
  panel.classList.remove('hidden');
  const ed = EditorState.editor;
  const content = ed ? ed.getValue() : '';
  const body = document.getElementById('mdp-body');
  if (body) body.innerHTML = (typeof miniMarkdown === 'function') ? miniMarkdown(content) : CL.util.escapeHtml(content);
}
window.updateMdPreview = updateMdPreview;

(function bindMdPreview() {
  const split = document.getElementById('editor-split');
  const preview = document.getElementById('md-preview');
  const fsBtn = document.getElementById('mdp-fullscreen');
  const closeBtn = document.getElementById('mdp-close');
  if (!split || !preview) return;
  if (fsBtn) fsBtn.onclick = () => {
    const on = split.classList.toggle('preview-full');
    fsBtn.title = on ? '退出全屏' : '全屏预览';
    try { if (EditorState.editor) EditorState.editor.layout(); } catch { /* ignore */ }
  };
  if (closeBtn) closeBtn.onclick = () => {
    preview.classList.add('hidden');
    split.classList.remove('preview-full');
    try { if (EditorState.editor) EditorState.editor.layout(); } catch { /* ignore */ }
  };
})();

/* ---- 非文本文件预览（图片 / 音频 / 视频 / 压缩包） ---- */
const VIEW_EXTS = {
  image: /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i,
  audio: /\.(mp3|ogg|oga|wav|flac|m4a|aac|opus)$/i,
  video: /\.(mp4|webm|mov|m4v|ogv|mkv)$/i,
  archive: /\.(zip|7z|tar|gz|tgz|bz2|tbz|xz|txz|jar|war)$/i
};
const VIEW_LABEL = { image: '图片', audio: '音频', video: '视频', archive: '压缩包' };
function fileViewKind(p) {
  for (const k of Object.keys(VIEW_EXTS)) if (VIEW_EXTS[k].test(p || '')) return k;
  return null;
}
function fileUrlOf(p) { return 'file:///' + String(p).replace(/\\/g, '/'); }
function updateFileViewerState(on) {
  const split = document.getElementById('editor-split');
  if (!split) return;
  split.classList.toggle('viewer-on', !!on);
  try { if (EditorState.editor) EditorState.editor.layout(); } catch { /* ignore */ }
}
function hideFileViewer() {
  const panel = document.getElementById('file-viewer');
  if (panel && !panel.classList.contains('hidden')) { panel.classList.add('hidden'); updateFileViewerState(false); }
}
async function showFileViewer(filePath, kind) {
  const panel = document.getElementById('file-viewer');
  const body = document.getElementById('fv-body');
  const title = document.getElementById('fv-title');
  if (!panel || !body) return;
  panel.classList.remove('hidden');
  updateFileViewerState(true);
  body.className = 'fv-body' + (kind === 'archive' ? ' fv-list' : '');
  const name = filePath.split(/[\\/]/).pop();
  if (title) title.innerHTML = '<span class="fv-name">' + CL.util.escapeHtml(name) + '</span><span class="fv-kind">' + VIEW_LABEL[kind] + '</span>';
  const url = fileUrlOf(filePath);
  if (kind === 'image') {
    body.innerHTML = '<div class="fv-media"><img src="' + url + '" alt="' + CL.util.escapeHtml(name) + '"></div>';
  } else if (kind === 'audio') {
    body.innerHTML = '<div class="fv-media fv-audio"><div class="fv-audio-ico">' + (window.lucideIcon('music') || '') + '</div><audio controls src="' + url + '"></audio></div>';
  } else if (kind === 'video') {
    body.innerHTML = '<div class="fv-media"><video controls src="' + url + '"></video></div>';
  } else if (kind === 'archive') {
    body.innerHTML = '<div class="fv-loading">正在读取压缩包…</div>';
    try {
      const r = await window.api.listArchive(filePath);
      if (!r.ok) { body.innerHTML = '<div class="fv-error">' + CL.util.escapeHtml(r.error || '读取失败') + '</div>'; return; }
      if (!r.entries || !r.entries.length) { body.innerHTML = '<div class="fv-error">压缩包为空</div>'; return; }
      body.innerHTML = '<div class="fv-arch-head">' + r.entries.length + ' 个条目</div>' +
        r.entries.slice(0, 1000).map((e) =>
          '<div class="fv-arch-item"><span class="fai-ico">' + (window.lucideIcon(/\/$/.test(e) ? 'folder' : 'file') || '') + '</span><span class="fai-name">' + CL.util.escapeHtml(e) + '</span></div>'
        ).join('') + (r.entries.length > 1000 ? '<div class="fv-arch-more">…仅显示前 1000 条</div>' : '');
    } catch { body.innerHTML = '<div class="fv-error">读取失败</div>'; }
  }
}
(function bindFileViewer() {
  const closeBtn = document.getElementById('fv-close');
  const extBtn = document.getElementById('fv-open-ext');
  if (closeBtn) closeBtn.onclick = () => hideFileViewer();
  if (extBtn) extBtn.onclick = () => {
    if (window.api && window.api.openExternal && EditorState.activePath) window.api.openExternal(EditorState.activePath);
  };
})();

  /* ---- 模块导出 ---- */
  CL.editor.preview = { isMarkdownPath, updateMdPreview, fileViewKind, showFileViewer, hideFileViewer };
})();
