/* Cursor Local - 顶层渲染逻辑：窗口切换 + 主页 composer + 设置（导航式） + 状态栏 */

/* ---- 视图（单一编辑器视图；AI 搭子面板显隐由 ai-panel.js 管理）----
 * switchMode 保留以兼容既有调用点：home/agents 归一为展开 AI 面板，
 * editor 折叠 AI 面板让编辑器全宽。 */
function switchMode(mode) {
  // 折叠必须走 ai-panel 的 setCollapsed（它同时管类名与内联宽度）；
  // 只改类名会留下 setCollapsed(false) 写入的内联 width，面板收起后仍占位。
  const setCollapsed = window.__setAiPanelCollapsed;
  if (typeof setCollapsed === 'function') {
    setCollapsed(mode === 'editor');
  } else {
    const panel = document.getElementById('ai-panel');
    if (!panel) return;
    panel.classList.toggle('ai-collapsed', mode === 'editor');
  }
  if (mode === 'agents' && typeof window.__focusAiPanel === 'function') window.__focusAiPanel();
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
  const healSeg = document.getElementById('cfg-heal-seg');
  if (healSeg) healSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(cfg.healRetries == null ? 1 : cfg.healRetries)));
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
  const healSeg = document.getElementById('cfg-heal-seg');
  const healActive = healSeg && healSeg.querySelector('button.active');
  const cfg = await window.api.setConfig({
    baseUrl: document.getElementById('cfg-baseurl').value.trim(),
    apiKey: document.getElementById('cfg-apikey').value.trim(),
    model: document.getElementById('cfg-model').value.trim(),
    aiComplete: aiToggle ? aiToggle.classList.contains('on') : true,
    permission: permActive ? permActive.dataset.v : 'safe',
    healRetries: healActive ? Number(healActive.dataset.v) : 1
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
// 失败自愈重试档位（0/1/2 次）
const healSegEl = document.getElementById('cfg-heal-seg');
if (healSegEl) healSegEl.querySelectorAll('button').forEach((b) => {
  b.onclick = () => healSegEl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
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
  // Agents 输入框的模型 chip
  const at = document.getElementById('agents-model-text');
  if (at) at.textContent = mName;
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
    CL.editor.filetree.render();
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
})();

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
  const oa = document.getElementById('ai-toggle-btn');
  if (oa) oa.onclick = () => { if (typeof window.__focusAiPanel === 'function') window.__focusAiPanel(); };
  const nt = document.getElementById('new-task-btn');
  if (nt) nt.onclick = () => {
    if (typeof window.__focusAiPanel === 'function') window.__focusAiPanel();
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

/* 关于页：打开法律条款（用户协议 / 隐私政策 / 免责声明 / 法规索引）
 * 协议窗口关闭后可随时再次打开；带 data-legal-open 的按钮会直接定位到
 * 对应章节（主进程拼 URL 参数或改写 hash，legal.html 侧负责滚动）。 */
(function bindOpenLegal() {
  const btns = [].slice.call(document.querySelectorAll('[data-legal-open]'));
  btns.forEach((btn) => {
    btn.onclick = () => {
      if (window.api && window.api.openLegal) window.api.openLegal(btn.dataset.legalOpen || '');
    };
  });
  // 兼容旧入口（若仍有 #open-legal-btn 残留）
  const legacy = document.getElementById('open-legal-btn');
  if (legacy && !legacy.dataset.legalOpen) {
    legacy.onclick = () => { if (window.api && window.api.openLegal) window.api.openLegal(''); };
  }
})();
