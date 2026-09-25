/* Cursor Local - 内联聊天（Ctrl+I）：按指令改写选中代码 */
(function () {
  let panelEl = null;
  let pendingRange = null;
  let pendingModel = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'inline-chat hidden';
    panelEl.innerHTML =
      '<div class="inline-head"><span class="inline-title">内联改写</span><button class="inline-close">×</button></div>' +
      '<textarea class="inline-input" placeholder="描述修改，如：改成 async/await、加错误处理…"></textarea>' +
      '<div class="inline-actions"><button class="inline-run">改写（Enter）</button></div>' +
      '<div class="inline-preview hidden">' +
        '<div class="side-label">修改后</div><pre class="inline-code"></pre>' +
        '<div class="inline-actions"><button class="inline-apply primary">应用</button><button class="inline-cancel">取消</button></div>' +
      '</div>';
    document.body.appendChild(panelEl);
    return panelEl;
  }

  window.openInlineChat = function () {
    if (typeof EditorState === 'undefined' || !EditorState.editor) return;
    const ed = EditorState.editor;
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) { flashStatus('请先选中代码'); return; }
    pendingRange = sel;
    pendingModel = ed.getModel();
    const p = ensurePanel();
    p.querySelector('.inline-input').value = '';
    p.querySelector('.inline-preview').classList.add('hidden');
    p.classList.remove('hidden');
    p.querySelector('.inline-input').focus();
  };

  async function run() {
    const p = ensurePanel();
    const instruction = p.querySelector('.inline-input').value.trim();
    if (!instruction) { p.querySelector('.inline-input').focus(); return; }
    const code = pendingModel.getValueInRange(pendingRange);
    const btn = p.querySelector('.inline-run');
    btn.textContent = '改写中…'; btn.disabled = true;
    let r;
    try { r = await window.api.aiInline(code, instruction); }
    catch { r = { ok: false, error: '调用失败' }; }
    btn.textContent = '改写（Enter）'; btn.disabled = false;
    if (!r.ok) { flashStatus(r.error || '改写失败'); return; }
    p.querySelector('.inline-code').textContent = r.code;
    p.querySelector('.inline-preview').classList.remove('hidden');
  }

  function apply() {
    const p = ensurePanel();
    const code = p.querySelector('.inline-code').textContent;
    if (typeof EditorState !== 'undefined' && EditorState.editor) {
      EditorState.editor.executeEdits('inline-chat', [{ range: pendingRange, text: code, forceMoveMarkers: true }]);
    }
    p.classList.add('hidden');
    flashStatus('已应用内联改写');
  }

  function close() { ensurePanel().classList.add('hidden'); }

  // 立即绑定（DOM 动态创建）
  (function bind() {
    const p = ensurePanel();
    p.querySelector('.inline-close').onclick = close;
    p.querySelector('.inline-run').onclick = run;
    p.querySelector('.inline-apply').onclick = apply;
    p.querySelector('.inline-cancel').onclick = close;
    p.querySelector('.inline-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
      else if (e.key === 'Escape') close();
    });
  })();
})();
