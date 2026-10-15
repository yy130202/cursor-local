/* Cursor Local - AI 搭子面板（右侧分栏）
 *
 * 【职责】编辑器右侧的 AI 搭子面板外壳：
 *   - 折叠 / 展开（顶栏「AI 搭子」按钮、Ctrl+Alt+B、面板头部折叠按钮）
 *   - 拖拽调宽（左侧 .ai-resizer）
 *   - 宽度与折叠态持久化到 config.aiPanel，跨重启保持
 *   - window.__focusAiPanel()：供外部（快捷键 / 命令面板 / 截图断言）展开并聚焦输入框
 *
 * 【为什么不用 display:none 折叠】
 * renderer/agents.js 在脚本加载期就 getElementById 抓取 #agent-list / #transcript 等容器，
 * 折叠只能用 width:0 改变外观，不能移除或隐藏容器本身。
 *
 * 【依赖】window.api（config:get/set）、#followup-input（agents.js）、CL.util（core.js）
 */
(function () {
  const CL = (window.CL = window.CL || {});
  CL.aiPanel = {};

  const PANEL = document.getElementById('ai-panel');
  const TOGGLE_BTN = document.getElementById('ai-toggle-btn');
  const COLLAPSE_BTN = document.getElementById('ai-collapse');
  const RESIZER = document.getElementById('ai-resizer');
  const NEW_TASK_BTN = document.getElementById('ai-new-task');
  const THEME_QUICK_BTN = document.getElementById('ai-theme-quick');
  if (!PANEL) return;

  const STORAGE_KEY = 'aiPanel';
  const MIN_W = 340;
  const MAX_W = 760;
  const DEFAULT_W = 460;
  /** 本会话已从 config 读过的持久化状态（避免每次读盘） */
  let persisted = { width: DEFAULT_W, collapsed: true };

  /* ---- 折叠 / 展开 ---- */
  function setCollapsed(collapsed, opts) {
    PANEL.classList.toggle('ai-collapsed', !!collapsed);
    PANEL.style.width = collapsed ? '' : (persisted.width || DEFAULT_W) + 'px';
    if (TOGGLE_BTN) TOGGLE_BTN.classList.toggle('active', !collapsed);
    if (!(opts && opts.skipPersist)) {
      persisted.collapsed = !!collapsed;
      savePersisted();
    }
  }

  function toggle() {
    setCollapsed(!PANEL.classList.contains('ai-collapsed'));
  }

  /* ---- 宽度 ---- */
  function setWidth(w) {
    const clamped = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
    persisted.width = clamped;
    if (!PANEL.classList.contains('ai-collapsed')) PANEL.style.width = clamped + 'px';
    return clamped;
  }

  /* ---- 持久化（防抖，避免拖动时高频写盘） ---- */
  let saveTimer = null;
  function savePersisted() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const cfg = (await window.api.getConfig()) || {};
        await window.api.setConfig({ ...cfg, [STORAGE_KEY]: { ...persisted } });
      } catch { /* 隐私模式等场景下失败可接受：不影响本会话使用 */ }
    }, 300);
  }

  async function loadPersisted() {
    try {
      const cfg = await window.api.getConfig();
      const saved = cfg && cfg[STORAGE_KEY];
      if (saved && typeof saved === 'object') {
        persisted = {
          width: Math.max(MIN_W, Math.min(MAX_W, saved.width || DEFAULT_W)),
          collapsed: saved.collapsed !== false // 缺省折叠（编辑器优先）
        };
      }
    } catch { /* 忽略：用默认值 */ }
    setCollapsed(persisted.collapsed, { skipPersist: true });
  }

  /* ---- 对外：展开并聚焦 composer ---- */
  function focusAiPanel() {
    if (PANEL.classList.contains('ai-collapsed')) setCollapsed(false);
    const input = document.getElementById('followup-input');
    if (input) setTimeout(() => input.focus(), 60);
  }
  window.__focusAiPanel = focusAiPanel;
  /*
   * 暴露 setCollapsed 作为折叠状态的「唯一写入点」。
   * 教训：switchMode('editor') 早期只 add('ai-collapsed') 类名，没有清掉
   * setCollapsed(false) 留在元素上的内联 width，于是类名变了、宽度仍是 460px，
   * 面板看似收起却仍占位。折叠必须同时改类名与内联宽度，故统一走这里。
   */
  window.__setAiPanelCollapsed = (v) => setCollapsed(!!v);
  CL.aiPanel.focus = focusAiPanel;
  CL.aiPanel.toggle = toggle;
  CL.aiPanel.setCollapsed = setCollapsed;
  CL.aiPanel.setWidth = setWidth;

  /* ---- 事件绑定 ---- */
  if (TOGGLE_BTN) TOGGLE_BTN.onclick = toggle;
  if (COLLAPSE_BTN) COLLAPSE_BTN.onclick = () => setCollapsed(true);
  if (NEW_TASK_BTN) NEW_TASK_BTN.onclick = focusAiPanel;
  /* 拆为子任务：把当前会话的一个子目标交给新的子 agent（UI 侧手动通道） */
  const SPLIT_BTN = document.getElementById('ai-split-task');
  if (SPLIT_BTN) SPLIT_BTN.onclick = async () => {
    const parentId = (typeof window.__currentAgentId === 'function' && window.__currentAgentId()) || null;
    if (!parentId) { if (window.flashStatus) window.flashStatus('请先选择或创建一个会话'); return; }
    const input = document.getElementById('followup-input');
    const task = input ? input.value.trim() : '';
    if (!task) {
      if (input) { input.focus(); input.placeholder = '先输入子任务描述，再点「拆为子任务」…（Enter 发送）'; }
      if (window.flashStatus) window.flashStatus('请在底部输入框填写子任务描述');
      return;
    }
    let r = null;
    try { r = await window.api.createChildAgent({ parentId, task }); } catch { /* ignore */ }
    if (r && r.ok) {
      if (input) input.value = '';
      if (window.flashStatus) window.flashStatus('已创建子任务 ' + r.id);
    } else {
      if (window.flashStatus) window.flashStatus((r && r.reason) || '创建子任务失败');
    }
  };

  /* Trajectory 导出（DSH 的可追溯性）：md 人类可读 / json 完整事件流 */
  const EXPORT_MD = document.getElementById('ai-export-md');
  const EXPORT_JSON = document.getElementById('ai-export-json');
  async function exportTrajectory(format) {
    const id = (typeof window.__currentAgentId === 'function' && window.__currentAgentId()) || null;
    if (!id) { if (window.flashStatus) window.flashStatus('请先选择或创建一个会话'); return; }
    let text = null;
    try { text = await window.api.exportTrajectory(id, format); } catch { /* ignore */ }
    if (!text) { if (window.flashStatus) window.flashStatus('导出失败：会话不存在'); return; }
    const ext = format === 'json' ? 'json' : 'md';
    const name = 'trajectory-' + id + '.' + ext;
    if (window.downloadText) window.downloadText(name, text);
    if (window.flashStatus) window.flashStatus('已导出轨迹 ' + name);
  }
  if (EXPORT_MD) EXPORT_MD.onclick = () => exportTrajectory('md');
  if (EXPORT_JSON) EXPORT_JSON.onclick = () => exportTrajectory('json');

  if (THEME_QUICK_BTN) THEME_QUICK_BTN.onclick = () => {
    const t = document.getElementById('theme-btn');
    if (t && t.click) t.click();
  };

  /* 拖拽调宽（面板在右侧，向左拖动变宽） */
  if (RESIZER) {
    RESIZER.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = PANEL.getBoundingClientRect().width || DEFAULT_W;
      const onMove = (ev) => { setWidth(startW - (ev.clientX - startX)); };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        savePersisted();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /* Ctrl+Alt+B 切换面板（与 keymap.js 的 ai.panel 命令互补，此处保证面板自身可用） */
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggle();
    }
  });

  /* ---- 启动：读持久化状态 ---- */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadPersisted);
  else loadPersisted();
})();
