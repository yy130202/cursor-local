'use strict';
/* 给任一版 agents.js 注入性能埋点（幂等，不改变原有语义） */
/* vm.runInContext 中顶层 const/let 不挂到 context 对象，必须用 var 才能被外部读取 */
function instrument(src) {
  const P = '__PERF__';
  const DECL = `var ${P} = { tCalls: 0, tMs: 0, lCalls: 0, lMs: 0, hCalls: 0, hMs: 0, md: 0, dAll: 0, dHit: 0, dMiss: 0, eTotal: 0, eBuilt: 0, resets: 0, lRows: 0, hRows: 0 };`;
  let out = src;
  const wrap = (name, c, t) => `
const __orig_${name} = ${name};
${name} = function () {
  ${P}.${c}++;
  const __t0 = performance.now();
  try { return __orig_${name}.apply(this, arguments); }
  finally { ${P}.${t} += performance.now() - __t0; }
};`;
  for (const [fn, c, t] of [['renderTranscript', 'tCalls', 'tMs'], ['renderAgentList', 'lCalls', 'lMs'], ['renderHistory', 'hCalls', 'hMs']]) {
    const needle = `function ${fn}(`;
    if (out.includes(needle)) out = out.replace(needle, wrap(fn, c, t) + '\n' + needle);
  }
  // 全量清空计数
  out = out.split(`transcriptEl.innerHTML = '';`).join(`${P}.resets = (${P}.resets||0)+1; transcriptEl.innerHTML = '';`);
  out = out.split(`agentListEl.innerHTML = '';`).join(`${P}.resets = (${P}.resets||0)+1; agentListEl.innerHTML = '';`);
  // entries 遍历总数（新版用局部 entries，基线用 a.entries）
  out = out.split('for (let i = 0; i < a.entries.length; i++) {').join('for (let i = 0; i < a.entries.length; i++) { __PERF__.eTotal++;');
  out = out.split('for (let i = 0; i < entries.length; i++) {').join('for (let i = 0; i < entries.length; i++) { __PERF__.eTotal++;');
  // 实际重建：新版 buildEntryNode / 基线每轮 createElement+append
  if (out.includes('function buildEntryNode(')) {
    out = out.replace('function buildEntryNode(en, isLast) {', 'function buildEntryNode(en, isLast) {\n  __PERF__.eBuilt++;');
  } else {
    out = out.replace(/(function renderTranscript\(\)[\s\S]*?)(for \(let i = 0; i < a\.entries\.length; i\+\+\) \{ __PERF__\.eTotal\+\+;\n)([\s\S]*?)(\n  \}\n)/,
      (m, a, b, body, d) => a + b + body.replace(/const d = document\.createElement\('div'\);/g, "const d = document.createElement('div'); __PERF__.eBuilt++;") + d);
  }
  // miniMarkdown / lineDiff
  out = out.replace('function miniMarkdown(text) {', 'function miniMarkdown(text) { __PERF__.md++;');
  if (out.includes('const diffCache = new Map()')) {
    out = out.replace('const hit = diffCache.get(key);', 'const hit = diffCache.get(key); if (hit) __PERF__.dHit++; else __PERF__.dMiss++;');
    out = out.replace('function lineDiff(before, after) {', 'function lineDiff(before, after) { __PERF__.dAll++;');
  } else if (out.includes('function lineDiff(before, after) {')) {
    out = out.replace('function lineDiff(before, after) {', 'function lineDiff(before, after) { __PERF__.dAll++; __PERF__.dMiss++;');
  }
  // 列表行/历史行
  out = out.replace(/(function renderAgentList\(\)[\s\S]*?)(\n(\s*)el\.innerHTML =)/g, (m, a, b) => a + '\n__PERF__.lRows++;' + b);
  out = out.replace(/(function renderHistory\(\)[\s\S]*?)(\n(\s*)[\w$.\[\]]+\.innerHTML =)/g, (m, a, b) => a + '\n__PERF__.hRows++;' + b);
  // 兜底：确保最终只保留一份声明
  out = DECL + '\n' + out.slice(out.indexOf('\n') + 1);
  return out;
}
module.exports = { instrument };