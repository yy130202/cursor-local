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
  // 主页胶囊分段选中态跟随视图
  const segEditor = document.getElementById('seg-editor');
  const segAgents = document.getElementById('seg-agents');
  if (segEditor && segAgents) {
    segEditor.classList.toggle('on', mode === 'editor');
    segAgents.classList.toggle('on', mode === 'agents');
  }
}

btnHome.onclick = () => switchMode('home');
btnEditor.onclick = () => switchMode('editor');
btnAgents.onclick = () => switchMode('agents');

/* ---- 主页：胶囊分段 + chips + 大输入框 ---- */
const segEditorBtn = document.getElementById('seg-editor');
const segAgentsBtn = document.getElementById('seg-agents');
if (segEditorBtn) segEditorBtn.onclick = () => switchMode('editor');
if (segAgentsBtn) segAgentsBtn.onclick = () => switchMode('agents');

const chipFolder = document.getElementById('chip-folder');
if (chipFolder) chipFolder.onclick = () => openFolder();
const chipHistory = document.getElementById('chip-history');
if (chipHistory) chipHistory.onclick = () => switchMode('agents');
const chipTheme = document.getElementById('chip-theme');
if (chipTheme) chipTheme.onclick = () => document.getElementById('theme-btn').click();
const chipSettings = document.getElementById('chip-settings');
if (chipSettings) chipSettings.onclick = openSettings;

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
  modal.classList.remove('hidden');
}

document.getElementById('settings-btn').onclick = openSettings;
document.getElementById('settings-close-btn').onclick = () => modal.classList.add('hidden');
document.getElementById('cfg-cancel').onclick = () => modal.classList.add('hidden');
document.getElementById('cfg-save').onclick = async () => {
  const cfg = await window.api.setConfig({
    baseUrl: document.getElementById('cfg-baseurl').value.trim(),
    apiKey: document.getElementById('cfg-apikey').value.trim(),
    model: document.getElementById('cfg-model').value.trim()
  });
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
  switchMode('home'); // 默认进主页
})();
