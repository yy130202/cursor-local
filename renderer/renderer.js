/* Cursor Local - 顶层渲染逻辑：窗口切换 + 设置 + 状态栏 */

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

/* ---- 主页快捷入口 ---- */
document.getElementById('quick-folder').onclick = () => openFolder();
document.getElementById('quick-editor').onclick = () => switchMode('editor');
document.getElementById('quick-agents').onclick = () => switchMode('agents');

/* ---- 设置 ---- */
const modal = document.getElementById('settings-modal');

async function openSettings() {
  const cfg = await window.api.getConfig();
  document.getElementById('cfg-baseurl').value = cfg.baseUrl || '';
  document.getElementById('cfg-apikey').value = cfg.apiKey || '';
  document.getElementById('cfg-model').value = cfg.model || '';
  modal.classList.remove('hidden');
}

document.getElementById('settings-btn').onclick = openSettings;
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

document.getElementById('open-folder-btn').onclick = () => openFolder();

function refreshStatusBar(cfg) {
  document.getElementById('status-model').textContent =
    '模型: ' + (cfg.model || '-') + ' · ' + (cfg.baseUrl || '');
  const noKey = !cfg.apiKey;
  document.getElementById('status-warn').style.display = noKey ? '' : 'none';
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
    renderTree();
  }
  // 主题 + 用户系统初始化
  if (typeof initTheme === 'function') initTheme();
  if (typeof initAuth === 'function') initAuth();
  if (!cfg.apiKey) openSettings(); // 首次启动引导配置
})();
