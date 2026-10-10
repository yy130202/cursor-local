'use strict';
/* 为「改造前」基线版 agents.js 注入与新版等价的性能实测钩子，
 * 使 Electron 侧 PERF=1 能在真实 Chromium 渲染层做同口径 A/B。
 * 只做三件事：
 *   1) 把 window.api.onAgentEvent 的匿名回调提取为 handleAgentEvent 并挂 __perfEmit
 *   2) 提供 __perfCounters（基线版无埋点，用 DOM 计数近似）
 *   3) 追加 __perfDrive（与新版同一份代码，保证驱动脚本完全一致）
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SRC = path.join(HERE, 'baseline', 'agents-before.js');
// 新版里的 __perfDrive 原文，直接复用以保证驱动脚本一致
const AFTER = path.join(HERE, '..', 'renderer', 'agents.js');

function extractPerfDrive(afterSrc) {
  const start = afterSrc.indexOf('window.__perfDrive = async function');
  if (start < 0) throw new Error('新版中未找到 __perfDrive');
  // 找到该函数结束（缩进为 0 的 "};" ）
  const end = afterSrc.indexOf('\n};\n', start);
  if (end < 0) throw new Error('未定位 __perfDrive 结尾');
  return afterSrc.slice(start, end + 3);
}

const src = fs.readFileSync(SRC, 'utf8');
let out = src;

// 1) 提取匿名事件回调 → 具名函数
const anchor = 'window.api.onAgentEvent((ev) => {';
if (!out.includes(anchor)) throw new Error('基线版事件注册锚点未找到');
out = out.replace(
  anchor,
  'function handleAgentEvent(ev) {\n  const __P0 = window.__perfCounters;\n  if (__P0) __P0.evCount = (__P0.evCount || 0) + 1;'
);
const closeAnchor = "  if (ev.id === agentsState.selectedId) renderTranscript();\n});";
if (!out.includes(closeAnchor)) throw new Error('基线版事件回调结尾锚点未找到');
out = out.replace(
  closeAnchor,
  '  if (ev.id === agentsState.selectedId) renderTranscript();\n}\nwindow.api.onAgentEvent(handleAgentEvent);\nwindow.__perfEmit = handleAgentEvent;'
);

// 2) renderTranscript 计时 + DOM 重建计数（基线无 buildEntryNode，按 innerHTML 清空与 entries 遍历近似）
out = out.replace(
  'function renderTranscript() {',
  'function renderTranscript() {\n' +
  '  const __P = window.__perfCounters;\n' +
  '  const __t0 = __P ? performance.now() : 0;\n' +
  '  if (__P) { __P.tCalls++; __P.eTotal += (agentsState.agents.get(agentsState.selectedId) || { entries: [] }).entries.length; }\n' +
  '  try { return renderTranscriptInner(); } finally { if (__P) __P.tMs += performance.now() - __t0; }\n' +
  '}\n' +
  'function renderTranscriptInner() {'
);

// renderAgentList / renderHistory 计时
out = out.replace(
  'function renderAgentList() {',
  'function renderAgentList() {\n' +
  '  const __P = window.__perfCounters;\n' +
  '  const __t0 = __P ? performance.now() : 0;\n' +
  '  if (__P) __P.lCalls++;\n' +
  '  try { return renderAgentListInner(); } finally { if (__P) __P.lMs += performance.now() - __t0; }\n' +
  '}\n' +
  'function renderAgentListInner() {'
);
out = out.replace(
  'function renderHistory() {',
  'function renderHistory() {\n' +
  '  const __P = window.__perfCounters;\n' +
  '  const __t0 = __P ? performance.now() : 0;\n' +
  '  if (__P) __P.hCalls++;\n' +
  '  try { return renderHistoryInner(); } finally { if (__P) __P.hMs += performance.now() - __t0; }\n' +
  '}\n' +
  'function renderHistoryInner() {'
);

// 3) 追加 __perfDrive（与新版完全相同的驱动脚本）
out += '\n/* ---- 性能实测钩子（由 make-baseline-hook.js 自动注入，与新版同一份代码） ---- */\n';
out = out.replace('window.__perfCounters = window.__perfCounters || null;', 'window.__perfCounters = window.__perfCounters || null;');

const perfDrive = extractPerfDrive(fs.readFileSync(AFTER, 'utf8'));
// 基线版的 __perfDrive 需要 eBuilt 语义（真实重建数 = 遍历数），在 innerHTML 清空处统计
out += '\n' + perfDrive + '\n';

// eBuilt 在基线版语义为"每次都重建"，直接等于 eTotal
out = out.replace('const P = (window.__perfCounters = {', 'const P = (window.__perfCounters = {');
out += '\n' +
  '/* 基线版 eBuilt 语义：每次 renderTranscript 都全量重建 DOM */\n' +
  'const __origRenderTranscriptInner = renderTranscriptInner;\n' +
  'renderTranscriptInner = function () { const __P = window.__perfCounters; if (__P) __P.eBuilt += (agentsState.agents.get(agentsState.selectedId) || { entries: [] }).entries.length; return __origRenderTranscriptInner.apply(this, arguments); };\n';

const dst = path.join(HERE, 'baseline', 'agents-before-hooked.js');
fs.writeFileSync(dst, out);
console.log('已生成对照版：' + path.relative(path.join(HERE, '..'), dst));
console.log('大小：' + out.length + ' 字节');
for (const probe of ['function handleAgentEvent', 'window.__perfEmit', '__perfDrive', 'renderTranscriptInner', 'renderAgentListInner', 'renderHistoryInner']) {
  console.log('  ' + probe + ': ' + (out.includes(probe) ? 'HIT' : 'MISS'));
}