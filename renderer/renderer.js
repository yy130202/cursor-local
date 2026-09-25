/* Cursor Local - 顶层渲染逻辑：窗口切换 + 设置 + 状态栏 */

/* ---- 模式切换（Editor / Agents）---- */
const btnEditor = document.getElementById('mode-editor');
const btnAgents = document.getElementById('mode-agents');

function switchMode(mode) {
  const isEditor = mode === 'editor';
  btnEditor.classList.toggle('active', isEditor);
  btnAgents.classList.toggle('active', !isEditor);
  document.getElementById('editor-view').classList.toggle('active', isEditor);
  document.getElementById('agents-view').classList.toggle('active', !isEditor);
}

btnEditor.onclick = () => switchMode('editor');
btnAgents.onclick = () => switchMode('agents');

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
  const cfg = await window.api.getConfig();
  refreshStatusBar(cfg);
  if (cfg.lastFolder) {
    EditorState.currentFolder = cfg.lastFolder;
    document.getElementById('workdir-label').textContent = cfg.lastFolder;
    document.getElementById('status-right').textContent = '工作目录: ' + cfg.lastFolder;
    renderTree();
  }
  if (!cfg.apiKey) openSettings(); // 首次启动引导配置
})();
