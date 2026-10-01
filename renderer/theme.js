/* Cursor Local - 主题系统（12 套渐变色卡 + 自定义取色器） */
const PRESETS = {
  aurora:   { name: 'Aurora',   color: '#7c3aed', gradient: 'linear-gradient(135deg, #7c3aed, #06b6d4)' },
  ocean:    { name: 'Ocean',    color: '#3b82f6', gradient: 'linear-gradient(135deg, #3b82f6, #22d3ee)' },
  blossom:  { name: 'Blossom',  color: '#f472b6', gradient: 'linear-gradient(135deg, #f9a8d4, #f472b6)' },
  cherry:   { name: 'Cherry',   color: '#e11d48', gradient: 'linear-gradient(135deg, #e11d48, #fb7185)' },
  coral:    { name: 'Coral',    color: '#fb7185', gradient: 'linear-gradient(135deg, #fb923c, #fb7185)' },
  emerald:  { name: 'Emerald',  color: '#10b981', gradient: 'linear-gradient(135deg, #059669, #34d399)' },
  mint:     { name: 'Mint',     color: '#2dd4bf', gradient: 'linear-gradient(135deg, #34d399, #22d3ee)' },
  sunset:   { name: 'Sunset',   color: '#f59e0b', gradient: 'linear-gradient(135deg, #f59e0b, #f43f5e)' },
  violet:   { name: 'Violet',   color: '#8b5cf6', gradient: 'linear-gradient(135deg, #8b5cf6, #d946ef)' },
  cyber:    { name: 'Cyber',    color: '#06b6d4', gradient: 'linear-gradient(135deg, #06b6d4, #a855f7)' },
  amber:    { name: 'Amber',    color: '#d97706', gradient: 'linear-gradient(135deg, #d97706, #fbbf24)' },
  horizon:  { name: 'Digital Horizon', color: '#6366f1', gradient: 'linear-gradient(135deg, #6366f1, #ec4899)' }
};

let currentTheme = { preset: 'aurora', custom: null, mode: 'dark' };

function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mix(hex, target, amount) {
  const { r, g, b } = hexToRgb(hex);
  const t = target === 'white' ? 255 : 0;
  return `rgb(${Math.round(r + (t - r) * amount)}, ${Math.round(g + (t - g) * amount)}, ${Math.round(b + (t - b) * amount)})`;
}

function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* Monaco defineTheme 专用：rgba() 字符串在该版本解析异常（会变纯红），必须用 #RRGGBBAA */
function hexa(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  const aa = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('') + aa;
}

/* 色相旋转（多彩渐变用）：hex → HSL 旋转 → hex */
function rotateHue(hex, deg) {
  let { r, g, b } = hexToRgb(hex);
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  h = (h + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rr = 0, gg = 0, bb = 0;
  if (h < 60) { rr = c; gg = x; }
  else if (h < 120) { rr = x; gg = c; }
  else if (h < 180) { gg = c; bb = x; }
  else if (h < 240) { gg = x; bb = c; }
  else if (h < 300) { rr = x; bb = c; }
  else { rr = c; bb = x; }
  const to = (v) => Math.round(Math.max(0, Math.min(1, v + m)) * 255).toString(16).padStart(2, '0');
  return '#' + to(rr) + to(gg) + to(bb);
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/* 亮/暗模式切换 */
function applyMode(mode) {
  document.documentElement.dataset.theme = mode === 'light' ? 'light' : 'dark';
  const color = currentTheme.custom || (PRESETS[currentTheme.preset] && PRESETS[currentTheme.preset].color) || PRESETS.aurora.color;
  updateMonacoTheme(color);
}

async function setMode(mode) {
  currentTheme.mode = mode === 'light' ? 'light' : 'dark';
  applyMode(currentTheme.mode);
  await window.api.setConfig({ theme: currentTheme });
}

window.setMode = setMode;

function applyTheme(accentHex) {
  const root = document.documentElement;
  const { r, g, b } = hexToRgb(accentHex);
  root.style.setProperty('--accent', accentHex);
  root.style.setProperty('--accent-hover', mix(accentHex, 'white', 0.16));
  root.style.setProperty('--accent-soft', rgba(accentHex, 0.16));
  root.style.setProperty('--accent-soft-2', rgba(accentHex, 0.28));
  root.style.setProperty('--glow', rgba(accentHex, 0.5));
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  root.style.setProperty('--accent-contrast', luminance(accentHex) > 155 ? '#111' : '#fff');
  // Aurora 光球跟随主题色
  root.style.setProperty('--orb-1', rgba(accentHex, 0.55));
  root.style.setProperty('--orb-2', rgba(mix(accentHex, 'white', 0.3), 0.4));
  root.style.setProperty('--orb-3', rgba(mix(accentHex, 'black', 0.3), 0.55));
  // 多彩漂移色（hero 渐变 / 3D 球 / 锁屏）
  root.style.setProperty('--accent-2', rotateHue(accentHex, 38));
  root.style.setProperty('--accent-3', rotateHue(accentHex, -46));
  updateMonacoTheme(accentHex);
}

/* Monaco 编辑器主题跟随主题色（光标/选区/高亮用 accent） */
function updateMonacoTheme(accentHex) {
  if (typeof monaco === 'undefined') return;
  const dark = document.documentElement.dataset.theme !== 'light';
  const { r, g, b } = hexToRgb(accentHex);
  monaco.editor.defineTheme('cursor-theme', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: dark ? '6a9955' : '008000' },
      { token: 'keyword', foreground: dark ? '569cd6' : '0000ff' },
      { token: 'string', foreground: dark ? 'ce9178' : 'a31515' },
      { token: 'number', foreground: dark ? 'b5cea8' : '098658' }
    ],
    colors: {
      'editor.background': dark ? '#1e1e1e' : '#ffffff',
      'editor.foreground': dark ? '#d4d4d4' : '#1f1f1f',
      'editorCursor.foreground': accentHex,
      // 兜底：异常行终止符标记整行鲜红，强制透明（unusualLineTerminator:'off' 之外的第二道保险）
      'editorUnusualLineTerminators': '#00000000',
      'editor.lineHighlightBackground': hexa(accentHex, dark ? 0.05 : 0.07),
      // 选区用中性蓝灰（不跟随主题色，避免红色主题下选区像错误标记）
      'editor.selectionBackground': dark ? '#264f78' : '#b3d4fc',
      'editor.selectionHighlightBackground': dark ? '#1f3d5c' : '#d0e5ff',
      'editor.wordHighlightBackground': hexa(accentHex, 0.10),
      'editor.findMatchBackground': hexa(accentHex, 0.35),
      'editor.findMatchHighlightBackground': hexa(accentHex, 0.18),
      'editorSuggestWidget.selectedBackground': hexa(accentHex, 0.30),
      'editor.inlineSuggest.foreground': hexa(accentHex, 0.62),
      'editor.inlineSuggest.background': hexa(accentHex, 0.08)
    }
  });
  if (typeof EditorState !== 'undefined' && EditorState.editor) {
    monaco.editor.setTheme('cursor-theme');
    window.__monacoThemeApplied = accentHex;
  }
}

async function setTheme(preset, custom) {
  const p = getPreset(preset);
  currentTheme = { preset: p, custom: custom || null, mode: currentTheme.mode };
  applyTheme(custom || PRESETS[p].color);
  markActiveCard();
  await window.api.setConfig({ theme: currentTheme });
}

/* 旧配置/无效名兼容：blue→ocean，未知→aurora */
function getPreset(name) {
  if (PRESETS[name]) return name;
  if (name === 'blue') return 'ocean';
  return 'aurora';
}

function markActiveCard() {
  document.querySelectorAll('.theme-card').forEach((el) => {
    el.classList.toggle('active', !currentTheme.custom && el.dataset.preset === currentTheme.preset);
  });
}

/* ---- 图标 helper（kebab 或 Pascal 均可） ---- */
window.lucideIcon = function (name) {
  if (!window.lucide) return '';
  let node = window.lucide.icons[name];
  if (!node) {
    const pascal = String(name).split('-').filter(Boolean)
      .map((s) => s[0].toUpperCase() + s.slice(1)).join('');
    node = window.lucide.icons[pascal];
  }
  return node ? window.lucide.createElement(node).outerHTML : '';
};

/* ---- 主题色卡网格（色块 + 名称，对标客户端色卡选择器） ---- */
function renderThemeCards() {
  document.querySelectorAll('.theme-cards').forEach((container) => {
    container.innerHTML = '';
    for (const [key, p] of Object.entries(PRESETS)) {
      const card = document.createElement('button');
      card.className = 'theme-card';
      card.dataset.preset = key;
      card.title = p.name;
      card.innerHTML =
        '<span class="swatch-block" style="background:' + p.gradient + '"></span>' +
        '<span class="swatch-name">' + p.name + '</span>';
      card.onclick = () => setTheme(key, null);
      container.appendChild(card);
    }
  });
}

/* ---- UI 绑定 ---- */
function bindThemeUI() {
  document.getElementById('theme-btn').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('theme-panel').classList.toggle('hidden');
    document.getElementById('user-menu').classList.add('hidden');
  };
  // 自定义取色器（popover + 主页 + 设置页），防抖避免拖动时高频 defineTheme
  const bindColor = (id) => {
    const input = document.getElementById(id);
    if (input) {
      let t;
      input.oninput = (e) => {
        clearTimeout(t);
        t = setTimeout(() => setTheme('custom', e.target.value), 120);
      };
    }
  };
  bindColor('theme-custom-color');
  bindColor('home-theme-color');
  // 点击外部关闭
  document.addEventListener('click', () => {
    document.getElementById('theme-panel').classList.add('hidden');
  });
  document.getElementById('theme-panel').addEventListener('click', (e) => e.stopPropagation());
}

async function initTheme() {
  try {
    const cfg = await window.api.getConfig();
    if (cfg.theme) currentTheme = { preset: getPreset(cfg.theme.preset), custom: cfg.theme.custom || null, mode: cfg.theme.mode || 'dark' };
  } catch { /* 使用默认 */ }
  const color = currentTheme.custom || PRESETS[currentTheme.preset].color;
  applyTheme(color);
  applyMode(currentTheme.mode);
  renderThemeCards();
  markActiveCard();
  if (currentTheme.custom) {
    ['theme-custom-color', 'home-theme-color'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = currentTheme.custom;
    });
  }
  bindThemeUI();
}
