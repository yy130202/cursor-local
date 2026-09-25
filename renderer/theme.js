/* Cursor Local - 主题系统（预设 + 自定义取色器） */
const PRESETS = {
  blue: '#3b82f6',
  violet: '#8b5cf6',
  emerald: '#10b981',
  orange: '#f59e0b',
  rose: '#f43f5e'
};

let currentTheme = { preset: 'blue', custom: null };

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

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

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
}

async function setTheme(preset, custom) {
  currentTheme = { preset, custom: custom || null };
  applyTheme(custom || PRESETS[preset] || PRESETS.blue);
  markActiveSwatch();
  await window.api.setConfig({ theme: currentTheme });
}

function markActiveSwatch() {
  document.querySelectorAll('.swatch').forEach((el) => {
    const active = !currentTheme.custom && el.dataset.preset === currentTheme.preset;
    el.classList.toggle('active', active);
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

/* ---- UI 绑定 ---- */
function bindThemeUI() {
  document.getElementById('theme-btn').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('theme-panel').classList.toggle('hidden');
    document.getElementById('user-menu').classList.add('hidden');
  };
  document.querySelectorAll('.swatch').forEach((el) => {
    el.onclick = () => setTheme(el.dataset.preset, null);
  });
  document.getElementById('theme-custom-color').oninput = (e) => {
    setTheme('custom', e.target.value);
  };
  // 点击外部关闭
  document.addEventListener('click', () => {
    document.getElementById('theme-panel').classList.add('hidden');
  });
  document.getElementById('theme-panel').addEventListener('click', (e) => e.stopPropagation());
}

async function initTheme() {
  try {
    const cfg = await window.api.getConfig();
    if (cfg.theme) currentTheme = { preset: cfg.theme.preset || 'blue', custom: cfg.theme.custom || null };
  } catch { /* 使用默认 */ }
  applyTheme(currentTheme.custom || PRESETS[currentTheme.preset] || PRESETS.blue);
  if (currentTheme.custom) document.getElementById('theme-custom-color').value = currentTheme.custom;
  markActiveSwatch();
  bindThemeUI();
}
