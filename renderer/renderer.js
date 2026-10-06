/* Cursor Local - 顶层渲染逻辑：窗口切换 + 主页 composer + 设置（导航式） + 状态栏 */

/* ---- 模式切换（Home / Editor / Agents）---- */
const btnHome = document.getElementById('mode-home');
const btnEditor = document.getElementById('mode-editor');
const btnAgents = document.getElementById('mode-agents');

function switchMode(mode) {
  btnHome.classList.toggle('active', mode === 'home');
  btnEditor.classList.toggle('active', mode === 'editor');
  btnAgents.classList.toggle('active', mode === 'agents');
  document.getElementById('home-view').classList.toggle('active', mode === 'home');
  document.getElementById('editor-view').classList.toggle('active', mode === 'editor');
  document.getElementById('agents-view').classList.toggle('active', mode === 'agents');
  if (mode === 'home' && typeof renderRecent === 'function') renderRecent();
}

btnHome.onclick = () => switchMode('home');
btnEditor.onclick = () => switchMode('editor');
btnAgents.onclick = () => switchMode('agents');

/* ---- 主页「最近会话」动态卡片 ---- */
async function renderRecent() {
  const list = document.getElementById('recent-list');
  const section = document.getElementById('recent-section');
  if (!list || !section) return;
  let sessions = [];
  try { sessions = await window.api.listSessions(); } catch { /* 忽略 */ }
  sessions.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const recent = sessions.slice(0, 3);
  if (!recent.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  list.innerHTML = '';
  recent.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'recent-card';
    const time = new Date(s.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    card.innerHTML =
      '<span class="dot ' + (s.status || 'done') + '"></span>' +
      '<div class="recent-body"><div class="recent-task">' + CL.util.escapeHtml(s.task || '（会话）') + '</div>' +
      '<div class="recent-meta">' + time + '</div></div>' +
      '<button class="recent-open">打开</button>';
    card.onclick = () => { switchMode('agents'); if (typeof openHistory === 'function') openHistory(s); };
    list.appendChild(card);
  });
}

/* 前端下载文本文件 */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
window.downloadText = downloadText;

/* ---- 主页：CTA / 特性卡片入口 ---- */
const ctaStart = document.getElementById('cta-start');
if (ctaStart) ctaStart.onclick = () => {
  const i = document.getElementById('home-task-input');
  if (i) i.focus();
};
const lmAgents = document.getElementById('lm-agents');
if (lmAgents) lmAgents.onclick = () => switchMode('agents');
const lmAgents2 = document.getElementById('lm-agents2');
if (lmAgents2) lmAgents2.onclick = () => switchMode('agents');
const lmEditor = document.getElementById('lm-editor');
if (lmEditor) lmEditor.onclick = () => switchMode('editor');

async function sendHomeTask() {
  const input = document.getElementById('home-task-input');
  const raw = input.value.trim();
  if (!raw) { input.focus(); return; }
  const { task, context } = window.extractMentions ? window.extractMentions(raw) : { task: raw, context: '' };
  const fullTask = (context + task).trim();
  const cwd = EditorState.currentFolder || '';
  const r = await window.api.createAgent({ task: fullTask, cwd, mode: window.__agentMode || 'craft' });
  input.value = '';
  switchMode('agents');
  if (typeof selectAgent === 'function') selectAgent(r.id);
}

const homeSend = document.getElementById('home-send');
if (homeSend) homeSend.onclick = sendHomeTask;
const homeTaskInput = document.getElementById('home-task-input');
if (homeTaskInput) {
  homeTaskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHomeTask(); }
  });
}

/* ---- 设置（导航式） ---- */
const modal = document.getElementById('settings-modal');

async function openSettings() {
  const cfg = await window.api.getConfig();
  document.getElementById('cfg-baseurl').value = cfg.baseUrl || '';
  document.getElementById('cfg-apikey').value = cfg.apiKey || '';
  document.getElementById('cfg-model').value = cfg.model || '';
  const aiToggle = document.getElementById('cfg-ai-complete');
  if (aiToggle) aiToggle.classList.toggle('on', cfg.aiComplete !== false);
  const permSeg = document.getElementById('cfg-permission-seg');
  if (permSeg) permSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === (cfg.permission || 'safe')));
  const lightToggle = document.getElementById('cfg-light-mode');
  if (lightToggle) lightToggle.classList.toggle('on', (cfg.theme && cfg.theme.mode) === 'light');
  const fsSel = document.getElementById('cfg-font-size');
  if (fsSel) fsSel.value = String(cfg.fontSize || 14);
  const tsSel = document.getElementById('cfg-tab-size');
  if (tsSel) tsSel.value = String(cfg.tabSize || 2);
  const asToggle = document.getElementById('cfg-auto-save');
  if (asToggle) asToggle.classList.toggle('on', !!cfg.autoSave);
  const wwToggle = document.getElementById('cfg-word-wrap');
  if (wwToggle) wwToggle.classList.toggle('on', cfg.wordWrap === 'on');
  const lsToggle = document.getElementById('cfg-lockscreen');
  if (lsToggle) lsToggle.classList.toggle('on', cfg.lockscreen !== false);
  renderKeybinds();
  modal.classList.remove('hidden');
}

/* ---- 快捷键列表 + 录制 ---- */
let recordingId = null;
function renderKeybinds() {
  const list = document.getElementById('keybind-list');
  if (!list || typeof window.getCommandList !== 'function') return;
  const cmds = window.getCommandList();
  list.innerHTML = '';
  cmds.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'srow';
    row.innerHTML =
      '<div class="srow-main"><div class="srow-label">' + CL.util.escapeHtml(c.label) + '</div></div>' +
      '<button class="keybind-btn" data-id="' + c.id + '">' + CL.util.escapeHtml(c.key) + '</button>';
    row.querySelector('.keybind-btn').onclick = () => startKeyRecord(c.id);
    list.appendChild(row);
  });
}

function startKeyRecord(id) {
  if (recordingId) return;
  recordingId = id;
  const btn = document.querySelector('.keybind-btn[data-id="' + id + '"]');
  if (btn) { btn.classList.add('recording'); btn.textContent = '按下组合键…'; }
  window.__keyRecordHandler = (e) => {
    if (e.key === 'Escape') { cancelKeyRecord(); return; }
    e.preventDefault(); e.stopPropagation();
    const combo = window.formatKeyEvent(e);
    if (!combo) return;
    finishKeyRecord(combo);
  };
  window.addEventListener('keydown', window.__keyRecordHandler, true);
}

function cancelKeyRecord() {
  if (window.__keyRecordHandler) window.removeEventListener('keydown', window.__keyRecordHandler, true);
  window.__keyRecordHandler = null;
  recordingId = null;
  renderKeybinds();
}

async function finishKeyRecord(combo) {
  const id = recordingId;
  recordingId = null;
  if (window.__keyRecordHandler) window.removeEventListener('keydown', window.__keyRecordHandler, true);
  window.__keyRecordHandler = null;
  if (id && combo) await window.setKeybinding(id, combo);
  renderKeybinds();
}

document.getElementById('settings-btn').onclick = openSettings;
document.getElementById('settings-close-btn').onclick = () => { cancelKeyRecord(); modal.classList.add('hidden'); };
document.getElementById('cfg-cancel').onclick = () => { cancelKeyRecord(); modal.classList.add('hidden'); };
document.getElementById('cfg-save').onclick = async () => {
  cancelKeyRecord();
  const aiToggle = document.getElementById('cfg-ai-complete');
  const permSeg = document.getElementById('cfg-permission-seg');
  const permActive = permSeg && permSeg.querySelector('button.active');
  const cfg = await window.api.setConfig({
    baseUrl: document.getElementById('cfg-baseurl').value.trim(),
    apiKey: document.getElementById('cfg-apikey').value.trim(),
    model: document.getElementById('cfg-model').value.trim(),
    aiComplete: aiToggle ? aiToggle.classList.contains('on') : true,
    permission: permActive ? permActive.dataset.v : 'safe'
  });
  window.__aiCompleteEnabled = cfg.aiComplete !== false;
  modal.classList.add('hidden');
  refreshStatusBar(cfg);
};

// 设置左侧导航切换
document.querySelectorAll('.snav-item').forEach((el) => {
  el.onclick = () => {
    document.querySelectorAll('.snav-item').forEach((x) => x.classList.toggle('active', x === el));
    document.querySelectorAll('.spage').forEach((p) =>
      p.classList.toggle('active', p.dataset.page === el.dataset.page)
    );
  };
});

// AI 补全开关
const aiToggleBtn = document.getElementById('cfg-ai-complete');
if (aiToggleBtn) aiToggleBtn.onclick = () => aiToggleBtn.classList.toggle('on');
// Agent 权限三档（自动审批/手动审批/完全访问）
const permSegEl = document.getElementById('cfg-permission-seg');
if (permSegEl) permSegEl.querySelectorAll('button').forEach((b) => {
  b.onclick = () => permSegEl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
});
// 亮色模式开关（即时切换）
const lightToggleBtn = document.getElementById('cfg-light-mode');
if (lightToggleBtn) lightToggleBtn.onclick = () => {
  const on = lightToggleBtn.classList.toggle('on');
  if (typeof window.setMode === 'function') window.setMode(on ? 'light' : 'dark');
};

// 编辑器字体大小 / Tab 宽度（即时应用）
const fsSelBtn = document.getElementById('cfg-font-size');
if (fsSelBtn) fsSelBtn.onchange = () => {
  const v = parseInt(fsSelBtn.value, 10);
  window.api.setConfig({ fontSize: v });
  if (typeof EditorState !== 'undefined' && EditorState.editor) EditorState.editor.updateOptions({ fontSize: v });
};
const tsSelBtn = document.getElementById('cfg-tab-size');
if (tsSelBtn) tsSelBtn.onchange = () => {
  const v = parseInt(tsSelBtn.value, 10);
  window.api.setConfig({ tabSize: v });
  if (typeof EditorState !== 'undefined' && EditorState.editor) EditorState.editor.updateOptions({ tabSize: v });
};
const asBtn = document.getElementById('cfg-auto-save');
if (asBtn) asBtn.onclick = () => {
  const on = asBtn.classList.toggle('on');
  window.api.setConfig({ autoSave: on });
  window.__autoSave = on;
};
const wwBtn = document.getElementById('cfg-word-wrap');
if (wwBtn) wwBtn.onclick = () => {
  const on = wwBtn.classList.toggle('on');
  window.api.setConfig({ wordWrap: on ? 'on' : 'off' });
  if (typeof EditorState !== 'undefined' && EditorState.editor) EditorState.editor.updateOptions({ wordWrap: on ? 'on' : 'off' });
};
const lsBtn = document.getElementById('cfg-lockscreen');
if (lsBtn) lsBtn.onclick = () => {
  const on = lsBtn.classList.toggle('on');
  window.api.setConfig({ lockscreen: on });
};

/* ---- 高级设置（JSON 编辑） ---- */
const jsonSettingsBtn = document.getElementById('json-settings-btn');
if (jsonSettingsBtn) jsonSettingsBtn.onclick = openJsonSettings;

function openJsonSettings() {
  let p = document.getElementById('json-panel');
  if (!p) {
    p = document.createElement('div');
    p.className = 'modal';
    p.innerHTML =
      '<div class="modal-box json-box">' +
        '<h3>编辑 settings.json</h3>' +
        '<textarea id="json-editor" spellcheck="false"></textarea>' +
        '<div class="json-hint">不含 API Key（已加密存储），保存时自动合并到现有配置</div>' +
        '<div class="modal-actions"><button id="json-cancel">取消</button><button id="json-save" class="primary">保存</button></div>' +
      '</div>';
    document.body.appendChild(p);
  }
  window.api.getConfig().then((cfg) => {
    const safe = {
      baseUrl: cfg.baseUrl, model: cfg.model, theme: cfg.theme,
      aiComplete: cfg.aiComplete, permission: cfg.permission, keybindings: cfg.keybindings || {}
    };
    p.querySelector('#json-editor').value = JSON.stringify(safe, null, 2);
  });
  p.classList.remove('hidden');
  p.querySelector('#json-cancel').onclick = () => p.classList.add('hidden');
  p.querySelector('#json-save').onclick = async () => {
    try {
      const parsed = JSON.parse(p.querySelector('#json-editor').value);
      const cfg = await window.api.setConfig(parsed);
      p.classList.add('hidden');
      refreshStatusBar(cfg);
      window.__aiCompleteEnabled = cfg.aiComplete !== false;
      flashStatus('配置已保存');
    } catch (e) {
      flashStatus('JSON 格式错误：' + e.message);
    }
  };
}

document.getElementById('open-folder-btn').onclick = () => openFolder();

function refreshStatusBar(cfg) {
  const mName = (typeof window.modelDisplayName === 'function') ? window.modelDisplayName(cfg.model) : (cfg.model || '-');
  document.getElementById('status-model').textContent =
    '模型: ' + mName + ' · ' + (cfg.baseUrl || '');
  const noKey = !cfg.apiKey;
  document.getElementById('status-warn').style.display = noKey ? '' : 'none';
  // 主页 / Agents 输入框的模型与目录 chip
  const mt = document.getElementById('home-model-text');
  if (mt) mt.textContent = mName;
  const at = document.getElementById('agents-model-text');
  if (at) at.textContent = mName;
  updateCwdChip();
}

function updateCwdChip() {
  const el = document.getElementById('home-cwd-text');
  if (el) {
    const c = EditorState.currentFolder;
    el.textContent = c ? c.split(/[\\/]/).pop() : '未选择文件夹';
    el.title = c || '';
  }
}

/* ---- 启动 ---- */
(async function boot() {
  // 初始化 lucide 图标（替换静态 data-lucide）
  try {
    if (window.lucide && window.lucide.createIcons) {
      const nBefore = document.querySelectorAll('[data-lucide]').length;
      window.lucide.createIcons({ icons: window.lucide.icons });
      const nAfter = document.querySelectorAll('svg.lucide').length;
      window.__bootDebug = { nBefore, nAfter, icons: Object.keys(window.lucide.icons || {}).length };
    } else {
      window.__bootError = 'lucide 未加载';
    }
  } catch (e) {
    window.__bootError = String(e && e.message || e);
  }
  const cfg = await window.api.getConfig();
  refreshStatusBar(cfg);
  window.__aiCompleteEnabled = cfg.aiComplete !== false;
  if (cfg.lastFolder) {
    EditorState.currentFolder = cfg.lastFolder;
    document.getElementById('workdir-label').textContent = cfg.lastFolder;
    document.getElementById('status-right').textContent = '工作目录: ' + cfg.lastFolder;
    updateCwdChip();
    renderTree();
  }
  // 主题 + 用户系统初始化
  if (typeof initTheme === 'function') initTheme();
  if (typeof initAuth === 'function') initAuth();
  // 编辑器选项（供 monaco 创建时读取）
  window.__editorFontSize = cfg.fontSize || 14;
  window.__editorTabSize = cfg.tabSize || 2;
  window.__editorWordWrap = cfg.wordWrap || 'off';
  window.__autoSave = !!cfg.autoSave;
  window.__largeFileThreshold = cfg.largeFileThreshold || 1048576;
  // 锁屏启动页（Windows 13 式）
  window.__lockscreenEnabled = cfg.lockscreen !== false;
  if (window.__lockscreenEnabled && typeof window.showLockscreen === 'function') {
    window.showLockscreen();
    const st = document.getElementById('ls-status');
    if (st) st.textContent = cfg.apiKey ? ('模型 ' + (cfg.model || '-')) : '未配置 API Key';
  }
  switchMode('home'); // 默认进主页
  if (typeof refreshStats === 'function') refreshStats();
})();

/* 输入聚焦环境光（Aura） */
(function bindAuraInput() {
  const el = document.getElementById('home-task-input');
  if (el) {
    el.addEventListener('focus', () => document.body.classList.add('aura-input'));
    el.addEventListener('blur', () => document.body.classList.remove('aura-input'));
  }
})();

/* 快捷操作卡片绑定 */
(function bindQuickCards() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bind('qc-folder', () => { if (typeof openFolder === 'function') openFolder(); });
  bind('qc-terminal', () => { if (typeof window.openTerminal === 'function') window.openTerminal(); });
  bind('qc-palette', () => { if (typeof window.openPalette === 'function') window.openPalette(); });
  bind('qc-file', () => {
    const cwd = (typeof EditorState !== 'undefined' && EditorState.currentFolder) || null;
    if (!cwd) { if (typeof openFolder === 'function') openFolder(); return; }
    if (typeof switchMode === 'function') switchMode('editor');
    if (typeof window.startInlineCreate === 'function') window.startInlineCreate(cwd, false);
  });
})();

/* 统计卡：模型 + 每日提示 */
const DAILY_TIPS = [
  '按 Ctrl+P 打开命令面板，快速执行任意功能',
  '按 Ctrl+I 内联改写选中的代码',
  'Agent 做的每一次改动都能一键回滚',
  '按 F11 全屏，专注编码',
  '光标停在代码上按 Ctrl+Alt+E，让 AI 解释它',
  '按 Alt+\\ 手动触发 AI 补全',
  '文件树顶部搜索框可快速定位文件',
  '危险命令会被自动拦截，放心让 Agent 干活'
];
async function refreshStats() {
  try {
    const cfg = await window.api.getConfig();
    const m = document.getElementById('stat-model');
    if (m) m.textContent = cfg.model || '未配置';
  } catch { /* ignore */ }
  const t = document.getElementById('stat-tip');
  if (t) t.textContent = DAILY_TIPS[new Date().getDate() % DAILY_TIPS.length];
}
window.refreshStats = refreshStats;

/* 自绘标题栏窗口控制 + 双击顶栏最大化 */
(function bindWinControls() {
  const min = document.getElementById('win-min');
  const max = document.getElementById('win-max');
  const close = document.getElementById('win-close');
  if (min) min.onclick = () => window.api.minimizeWindow();
  if (max) max.onclick = () => window.api.maximizeWindow();
  if (close) close.onclick = () => window.api.closeWindow();
  const topbar = document.getElementById('topbar');
  if (topbar) topbar.ondblclick = (e) => {
    if (e.target.closest('button, #user-area')) return;
    window.api.maximizeWindow();
  };
})();

/* 顶栏搜索框 + 打开 Agents + 新建任务（参考 CodeBuddy 顶栏布局） */
(function bindTopbarExtras() {
  const ts = document.getElementById('top-search');
  if (ts) ts.onclick = () => { if (typeof window.openGlobalSearch === 'function') window.openGlobalSearch(); };
  const oa = document.getElementById('open-agents-btn');
  if (oa) oa.onclick = () => { if (typeof switchMode === 'function') switchMode('agents'); };
  const nt = document.getElementById('new-task-btn');
  if (nt) nt.onclick = () => {
    if (typeof switchMode === 'function') switchMode('agents');
    const input = document.getElementById('followup-input');
    if (input) { input.focus(); input.placeholder = '描述新任务…（Enter 发送）'; }
  };
})();

/* ---- 记忆 / 规则页（参考 CodeBuddy，本地 JSON/Markdown 存储） ---- */
function currentCwd() { return (typeof EditorState !== 'undefined' && EditorState.currentFolder) || ''; }

async function renderMemory() {
  const cwd = currentCwd();
  const data = await window.api.memoryGet(cwd);
  const render = (list, box, scope) => {
    if (!list.length) { box.innerHTML = '<div class="mem-empty">暂无记忆，输入后点击「添加」</div>'; return; }
    box.innerHTML = list.map((m) =>
      '<div class="mem-item"><span class="mem-text">' + CL.util.escapeHtml(m.text) + '</span>' +
      '<button class="mem-del" data-scope="' + scope + '" data-id="' + m.id + '" title="删除">' + (window.lucideIcon('x') || '×') + '</button></div>'
    ).join('');
    box.querySelectorAll('.mem-del').forEach((b) => {
      b.onclick = async () => { await window.api.memoryRemove(cwd, b.dataset.scope, b.dataset.id); renderMemory(); };
    });
  };
  render(data.global, document.getElementById('mem-global-list'), 'global');
  render(data.project, document.getElementById('mem-project-list'), 'project');
}

async function renderRules() {
  const cwd = currentCwd();
  const data = await window.api.rulesGet(cwd);
  document.getElementById('rules-user').value = data.user || '';
  document.getElementById('rules-project').value = data.project || '';
}

(function bindMemoryRules() {
  document.getElementById('mem-add-btn').onclick = async () => {
    const input = document.getElementById('mem-add-input');
    const text = input.value.trim();
    if (!text) return;
    await window.api.memoryAdd(currentCwd(), 'global', text);
    input.value = '';
    renderMemory();
    flashStatus('已添加全局记忆');
  };
  document.getElementById('rules-save').onclick = async () => {
    const cwd = currentCwd();
    await window.api.rulesSet(cwd, 'user', document.getElementById('rules-user').value);
    await window.api.rulesSet(cwd, 'project', document.getElementById('rules-project').value);
    flashStatus('规则已保存');
  };
  // 打开设置时加载
  const origOpen = window.__origOpenSettings;
  const settingsBtn = document.getElementById('settings-btn');
  settingsBtn.addEventListener('click', () => { setTimeout(() => { renderMemory(); renderRules(); }, 100); });
})();

/* ---- 背景不透明度可调（毛玻璃透出程度） ---- */
function applyBgAlpha(v) {
  v = Math.max(0, Math.min(100, Number(v) || 0));
  const dark = document.documentElement.dataset.theme !== 'light';
  const rgb = dark ? '17,17,22' : '246,247,250';
  document.body.style.setProperty('--body-bg', 'rgba(' + rgb + ',' + (v / 100) + ')');
  const val = document.getElementById('cfg-bg-alpha-val');
  if (val) val.textContent = v + '%';
}
(function bindBgAlpha() {
  const range = document.getElementById('cfg-bg-alpha');
  if (!range) return;
  range.oninput = () => {
    applyBgAlpha(range.value);
    window.api.setConfig({ bgAlpha: Number(range.value) });
  };
  // 启动时恢复
  window.api.getConfig().then((cfg) => {
    if (cfg && typeof cfg.bgAlpha === 'number') { range.value = cfg.bgAlpha; applyBgAlpha(cfg.bgAlpha); }
  }).catch(() => {});
  // 打开设置时同步
  document.getElementById('settings-btn').addEventListener('click', () => {
    window.api.getConfig().then((cfg) => { if (cfg && typeof cfg.bgAlpha === 'number') { range.value = cfg.bgAlpha; applyBgAlpha(cfg.bgAlpha); } });
  });
})();

/* 关于页：打开法律条款（用户协议 / 隐私政策 / 免责声明） */
(function bindOpenLegal() {
  const btn = document.getElementById('open-legal-btn');
  if (btn) btn.onclick = () => { if (window.api && window.api.openLegal) window.api.openLegal(); };
})();
