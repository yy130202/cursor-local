/* Cursor Local - AI 代码诊断（侧边列表 + 跳转 + 一键修复） */
(function () {
  let panelEl = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'diag-panel hidden';
    panelEl.innerHTML =
      '<div class="diag-head"><span class="diag-title">AI 诊断</span>' +
        '<button class="diag-refresh" title="重新检查">重新检查</button>' +
        '<button class="diag-close">×</button></div>' +
      '<div class="diag-list"></div>';
    document.body.appendChild(panelEl);
    return panelEl;
  }

  window.openDiagnose = async function () {
    if (typeof EditorState === 'undefined' || !EditorState.editor) return;
    const ed = EditorState.editor;
    const model = ed.getModel();
    const p = ensurePanel();
    p.classList.remove('hidden');
    const list = p.querySelector('.diag-list');
    list.innerHTML = '<div class="diag-loading">AI 检查中…</div>';
    let r;
    try { r = await window.api.aiDiagnose(model.getValue(), model.getLanguageId()); }
    catch { r = { ok: false, error: '调用失败' }; }
    if (!r.ok) { list.innerHTML = '<div class="diag-empty">' + CL.util.escapeHtml(r.error || '诊断失败') + '</div>'; return; }
    renderDiagnostics(r.diagnostics || [], list, ed, model);
  };

  function renderDiagnostics(diags, list, ed, model) {
    if (!diags.length) { list.innerHTML = '<div class="diag-empty">未发现问题</div>'; return; }
    list.innerHTML = '';
    diags.forEach((d) => {
      const item = document.createElement('div');
      item.className = 'diag-item ' + (d.severity || 'info');
      item.innerHTML =
        '<span class="diag-sev">' + CL.util.escapeHtml(String(d.severity || 'info').toUpperCase()) + '</span>' +
        '<div class="diag-body"><div class="diag-msg">L' + (d.line || '?') + ' · ' + CL.util.escapeHtml(d.message || '') + '</div>' +
        (d.suggestion ? '<div class="diag-sugg">' + CL.util.escapeHtml(d.suggestion) + '</div>' : '') + '</div>' +
        '<button class="diag-fix">修复</button>';
      item.addEventListener('click', () => {
        const ln = d.line || 1;
        ed.revealLineInCenter(ln);
        ed.setPosition({ lineNumber: ln, column: 1 });
        ed.focus();
      });
      const fixBtn = item.querySelector('.diag-fix');
      fixBtn.onclick = async (e) => {
        e.stopPropagation();
        fixBtn.textContent = '修复中…'; fixBtn.disabled = true;
        const ln = d.line || 1;
        const lineContent = model.getLineContent(ln);
        const r = await window.api.aiEdit(lineContent, '修复此问题：' + (d.message || '') + (d.suggestion ? '（建议：' + d.suggestion + '）' : ''));
        if (r.ok) {
          const range = new monaco.Range(ln, 1, ln, lineContent.length + 1);
          ed.executeEdits('diag-fix', [{ range, text: r.result, forceMoveMarkers: true }]);
          fixBtn.textContent = '已修复';
        } else { fixBtn.textContent = '修复'; fixBtn.disabled = false; }
      };
      list.appendChild(item);
    });
  }

  (function bind() {
    const p = ensurePanel();
    p.querySelector('.diag-close').onclick = () => p.classList.add('hidden');
    p.querySelector('.diag-refresh').onclick = () => window.openDiagnose();
  })();
})();
