/* Cursor Local - 主题系统（卡片式选择 + 自定义取色器） */
const PRESETS = {
  blue:    { name: '蓝色', color: '#3b82f6', gradient: 'linear-gradient(135deg, #3b82f6, #8b5cf6)' },
  violet:  { name: '紫色', color: '#8b5cf6', gradient: 'linear-gradient(135deg, #8b5cf6, #d946ef)' },
  emerald: { name: '绿色', color: '#10b981', gradient: 'linear-gradient(135deg, #10b981, #22d3ee)' },
  orange:  { name: '橙色', color: '#f59e0b', gradient: 'linear-gradient(135deg, #f59e0b, #f43f5e)' },
  rose:    { name: '粉色', color: '#f43f5e', gradient: 'linear-gradient(135deg, #f43f5e, #a855f7)' }
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
  // Aurora 光球跟随主题色
  root.style.setProperty('--orb-1', rgba(accentHex, 0.55));
  root.style.setProperty('--orb-2', rgba(mix(accentHex, 'white', 0.3), 0.4));
  root.style.setProperty('--orb-3', rgba(mix(accentHex, 'black', 0.3), 0.55));
}

async function setTheme(preset, custom) {
  currentTheme = { preset, custom: custom || null };
  applyTheme(custom || PRESETS[preset].color);
  markActiveCard();
  markActiveSwatch();
  await window.api.setConfig({ theme: currentTheme });
}

function markActiveCard() {
  document.querySelectorAll('.theme-card').forEach((el) => {
    el.classList.toggle('active', !currentTheme.custom && el.dataset.preset === currentTheme.preset);
  });
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

/* ---- 主题卡片渲染 ---- */
function renderThemeCards() {
  const container = document.getElementById('theme-cards');
  if (!container) return;
  container.innerHTML = '';
  for (const [key, p] of Object.entries(PRESETS)) {
    const card = document.createElement('button');
    card.className = 'theme-card';
    card.dataset.preset = key;
    card.innerHTML =
      '<span class="theme-preview" style="background:' + p.gradient + '"></span>' +
      '<span class="theme-meta"><span class="theme-name">' + p.name + '</span>' +
      '<span class="theme-check">' + (window.lucideIcon('check') || '') + '</span></span>';
    card.onclick = () => setTheme(key, null);
    container.appendChild(card);
  }
}

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
  // 两个自定义取色器（popover + 主页）
  const bindColor = (id) => {
    const input = document.getElementById(id);
    if (input) input.oninput = (e) => setTheme('custom', e.target.value);
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
    if (cfg.theme) currentTheme = { preset: cfg.theme.preset || 'blue', custom: cfg.theme.custom || null };
  } catch { /* 使用默认 */ }
  const color = currentTheme.custom || (PRESETS[currentTheme.preset] && PRESETS[currentTheme.preset].color) || PRESETS.blue.color;
  applyTheme(color);
  renderThemeCards();
  markActiveCard();
  markActiveSwatch();
  if (currentTheme.custom) {
    const el = document.getElementById('theme-custom-color');
    if (el) el.value = currentTheme.custom;
  }
  bindThemeUI();
}
