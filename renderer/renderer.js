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
}

btnHome.onclick = () => switchMode('home');
btnEditor.onclick = () => switchMode('editor');
btnAgents.onclick = () => switchMode('agents');

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
  modal.classList.remove('hidden');
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
  switchMode('home'); // 默认进主页
})();
