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
      '<div class="recent-body"><div class="recent-task">' + escapeHtml(s.task || '（会话）') + '</div>' +
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
  const task = input.value.trim();
  if (!task) { input.focus(); return; }
  const cwd = EditorState.currentFolder || '';
  const r = await window.api.createAgent({ task, cwd });
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
  const permToggle = document.getElementById('cfg-permission');
  if (permToggle) permToggle.classList.toggle('on', cfg.permission === 'full');
  const lightToggle = document.getElementById('cfg-light-mode');
  if (lightToggle) lightToggle.classList.toggle('on', (cfg.theme && cfg.theme.mode) === 'light');
  const fsSel = document.getElementById('cfg-font-size');
  if (fsSel) fsSel.value = String(cfg.fontSize || 14);
  const tsSel = document.getElementById('cfg-tab-size');
  if (tsSel) tsSel.value = String(cfg.tabSize || 2);
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
      '<div class="srow-main"><div class="srow-label">' + escapeHtml(c.label) + '</div></div>' +
      '<button class="keybind-btn" data-id="' + c.id + '">' + escapeHtml(c.key) + '</button>';
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
    e.preventDefault(); e.stopPropagation();
    const combo = window.formatKeyEvent(e);
    if (!combo) return;
    finishKeyRecord(combo);
  };
  window.addEventListener('keydown', window.__keyRecordHandler, true);
}

async function finishKeyRecord(combo) {
  const id = recordingId;
  recordingId = null;
  window.removeEventListener('keydown', window.__keyRecordHandler, true);
  if (id && combo) await window.setKeybinding(id, combo);
  renderKeybinds();
}

document.getElementById('settings-btn').onclick = openSettings;
document.getElementById('settings-close-btn').onclick = () => modal.classList.add('hidden');
document.getElementById('cfg-cancel').onclick = () => modal.classList.add('hidden');
document.getElementById('cfg-save').onclick = async () => {
  const aiToggle = document.getElementById('cfg-ai-complete');
  const permToggle = document.getElementById('cfg-permission');
  const cfg = await window.api.setConfig({
    baseUrl: document.getElementById('cfg-baseurl').value.trim(),
    apiKey: document.getElementById('cfg-apikey').value.trim(),
    model: document.getElementById('cfg-model').value.trim(),
    aiComplete: aiToggle ? aiToggle.classList.contains('on') : true,
    permission: permToggle && permToggle.classList.contains('on') ? 'full' : 'safe'
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
// 完全控制权限开关
const permToggleBtn = document.getElementById('cfg-permission');
if (permToggleBtn) permToggleBtn.onclick = () => permToggleBtn.classList.toggle('on');
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
  document.getElementById('status-model').textContent =
    '模型: ' + (cfg.model || '-') + ' · ' + (cfg.baseUrl || '');
  const noKey = !cfg.apiKey;
  document.getElementById('status-warn').style.display = noKey ? '' : 'none';
  // 主页 / Agents 输入框的模型与目录 chip
  const mt = document.getElementById('home-model-text');
  if (mt) mt.textContent = cfg.model || '-';
  const at = document.getElementById('agents-model-text');
  if (at) at.textContent = cfg.model || '-';
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
  switchMode('home'); // 默认进主页
})();
