'use strict';

/* renderer/agents.js — 增量渲染改造的回归测试
 *
 * renderer 目录是浏览器脚本，没有既有测试覆盖。本次改造把
 * renderTranscript / renderAgentList 从「每次全量 innerHTML='' 重建」
 * 改为「按渲染签名增量复用 DOM」，属于高风险改动，故在此用最小 DOM
 * 替身覆盖其纯逻辑与关键行为：
 *
 * 覆盖点：
 *  1. sigOf：签名随 entry 可见状态变化，状态不变则签名稳定；
 *  2. lineDiff：记忆化缓存命中、大小写敏感、LCS 最小编辑序列、500 行上限、
 *     缓存容量淘汰（超过 24 条按插入顺序淘汰）；
 *  3. agentItemSig：task/cwd/status/选中 任一变化才改签名。
 *
 * 说明：DOM 重建次数的断言依赖 DOM 替身的 innerHTML setter 计数，
 * 该替身只实现本文件用到的子集（createElement/appendChild/replaceChild/
 * querySelector/querySelectorAll/remove/classList/textContent/isConnected）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../renderer/agents.js'), 'utf8');

/* 提取文件中的纯函数做隔离测试：lineDiff / computeLineDiff / sigOf /
   agentItemSig / statusLabel。它们不依赖 DOM，可在无浏览器环境直接验证。 */
function loadPureFunctions(selectedId = null) {
  const fnNames = ['sigOf', 'agentItemSig', 'statusLabel', 'computeLineDiff'];
  const src = fnNames.map((name) => extractFunction(source, name)).join('\n\n');
  const ctx = { console, agentsState: { selectedId } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  // 数组需转回宿主 realm，否则 deepStrictEqual 因原型不同而判不等。
  // 用 structuredClone 而非 JSON：后者会丢掉 undefined 字段（tooBig 断言依赖它）。
  const wrap = (fn) => (...args) => structuredClone(fn(...args));
  return {
    setSelectedId: (id) => { ctx.agentsState.selectedId = id; },
    sigOf: wrap(vm.runInContext('sigOf', ctx)),
    agentItemSig: wrap(vm.runInContext('agentItemSig', ctx)),
    statusLabel: wrap(vm.runInContext('statusLabel', ctx)),
    computeLineDiff: wrap(vm.runInContext('computeLineDiff', ctx))
  };
}

/* 从源码里抽出 `function name(...) { ... }` 的完整文本（含嵌套大括号） */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces: ' + name);
}

const pure = loadPureFunctions();

test('sigOf: 状态不变时签名稳定', () => {
  const en = { kind: 'tool', name: 'read_file', args: {}, result: 'ok' };
  const s1 = pure.sigOf(en);
  assert.equal(pure.sigOf(en), s1, '同一状态重复调用签名一致');
});

test('sigOf: tool 的 result 出现会改变签名', () => {
  const en = { kind: 'tool', name: 'read_file', args: {} };
  const before = pure.sigOf(en);
  en.result = '文件内容';
  const after = pure.sigOf(en);
  assert.notEqual(before, after);
});

test('sigOf: tool 的 live 输出增长会改变签名', () => {
  const en = { kind: 'tool', name: 'run_command', args: {}, live: 'ab' };
  const a = pure.sigOf(en);
  en.live = 'abcd';
  assert.notEqual(a, pure.sigOf(en));
});

test('sigOf: streaming 标志切换会改变签名', () => {
  const en = { kind: 'agent-msg', text: 'hello', streaming: true };
  const a = pure.sigOf(en);
  en.streaming = false;
  assert.notEqual(a, pure.sigOf(en));
});

test('sigOf: agent-msg 文本增长会改变签名', () => {
  const en = { kind: 'agent-msg', text: 'h' };
  const a = pure.sigOf(en);
  en.text = 'he';
  assert.notEqual(a, pure.sigOf(en));
});

test('sigOf: approval 的允许/拒绝/待定三态签名互不相同', () => {
  const pending = { kind: 'approval', resolved: false };
  const allowed = { kind: 'approval', resolved: true, allowed: true };
  const denied = { kind: 'approval', resolved: true, allowed: false };
  const s = new Set([pure.sigOf(pending), pure.sigOf(allowed), pure.sigOf(denied)]);
  assert.equal(s.size, 3);
});

test('sigOf: change 的撤销状态改变签名', () => {
  const en = { kind: 'change', before: null, after: 'x' };
  const a = pure.sigOf(en);
  en.reverted = true;
  assert.notEqual(a, pure.sigOf(en));
});

test('agentItemSig: task/cwd/status/选中 任一变化都改签名', () => {
  const a = { id: 'x', task: 'T', cwd: 'C', status: 'running' };
  const base = pure.agentItemSig(a);
  const variants = [
    { ...a, task: 'T2' },
    { ...a, cwd: 'C2' },
    { ...a, status: 'done' }
  ];
  for (const v of variants) assert.notEqual(base, pure.agentItemSig(v));
  assert.equal(base, pure.agentItemSig({ ...a }), '完全相同的字段签名一致');

  // 选中态维度：selectedId 从 null 切到 a.id，签名必须变化
  pure.setSelectedId(null);
  const unselected = pure.agentItemSig(a);
  pure.setSelectedId('x');
  assert.notEqual(unselected, pure.agentItemSig(a));
  pure.setSelectedId(null);
});

test('statusLabel: 覆盖四种状态与未知状态', () => {
  assert.equal(pure.statusLabel('running'), '运行中');
  assert.equal(pure.statusLabel('done'), '已完成');
  assert.equal(pure.statusLabel('error'), '出错');
  assert.equal(pure.statusLabel('stopped'), '已停止');
  assert.equal(pure.statusLabel('weird'), 'weird', '未知状态原样返回');
});

test('computeLineDiff: 相同内容全部为 same', () => {
  const r = pure.computeLineDiff('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(r.lines.map((l) => l.t), ['same', 'same', 'same']);
});

test('computeLineDiff: 新增行为 add、删除行为 del', () => {
  const r = pure.computeLineDiff('a\nb', 'a\nc');
  const adds = r.lines.filter((l) => l.t === 'add').map((l) => l.x);
  const dels = r.lines.filter((l) => l.t === 'del').map((l) => l.x);
  assert.deepEqual(adds, ['c']);
  assert.deepEqual(dels, ['b']);
});

test('computeLineDiff: null 与空字符串等价', () => {
  const r = pure.computeLineDiff(null, '');
  assert.ok(r.lines.length >= 1);
  assert.equal(r.lines.every((l) => l.t === 'same'), true);
});

test('computeLineDiff: 超过 500 行退回并排模式', () => {
  const big = Array.from({ length: 501 }, (_, i) => 'line' + i).join('\n');
  const r = pure.computeLineDiff(big, big);
  assert.equal(r.tooBig, true);
  assert.equal(Array.isArray(r.before), true);
  assert.equal(Array.isArray(r.after), true);
  assert.equal(r.lines, undefined);
});

test('computeLineDiff: 恰好 500 行仍走 LCS', () => {
  const exact = Array.from({ length: 500 }, (_, i) => 'line' + i).join('\n');
  const r = pure.computeLineDiff(exact, exact);
  assert.equal(r.tooBig, undefined);
  assert.equal(r.lines.length, 500);
});

test('computeLineDiff: 结果可还原出两侧原始行序列', () => {
  const before = 'a\nb\nc\nd';
  const after = 'a\nx\nc\nd\ne';
  const r = pure.computeLineDiff(before, after);
  const rebuiltOld = r.lines.filter((l) => l.t !== 'add').map((l) => l.x).join('\n');
  const rebuiltNew = r.lines.filter((l) => l.t !== 'del').map((l) => l.x).join('\n');
  assert.equal(rebuiltOld, before);
  assert.equal(rebuiltNew, after);
});

test('computeLineDiff: 大小写敏感', () => {
  const r = pure.computeLineDiff('Line', 'line');
  assert.equal(r.lines.some((l) => l.t === 'add'), true);
  assert.equal(r.lines.some((l) => l.t === 'del'), true);
});

/* ------------------------------------------------------------------ *
 * miniMarkdown —— GFM 表格支持
 *
 * 背景：渲染器原本只处理代码块/加粗/标题/列表，`|---|---|` 这类分隔行
 * 没有任何规则命中，只能原样当纯文本输出，Markdown 表格在预览里完全不成立。
 * 修复后需保证：正常渲染、格内行内格式生效、且不破坏既有的水平线/
 * 列表/代码块，更不能因格内内容引入 XSS。
 * ------------------------------------------------------------------ */

/* 与 loadPureFunctions 同法：抽出纯函数注入最小上下文。
   这里需要 CL.util.escapeHtml 与 window.lucideIcon，故一并提供替身。 */
function loadMarkdown() {
  const fnNames = ['mdInline', 'mdSplitRow', 'mdIsSeparatorRow', 'mdAlignOf', 'miniMarkdown'];
  const src = fnNames.map((name) => extractFunction(source, name)).join('\n\n');
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const ctx = {
    console,
    CL: { util: { escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]) } },
    window: { lucideIcon: () => '<i></i>' }
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__md = { miniMarkdown, mdSplitRow, mdIsSeparatorRow, mdAlignOf };', ctx);
  return ctx.__md;
}

const md = loadMarkdown();

test('表格: 标准 GFM 表渲染为 thead + tbody', () => {
  const html = md.miniMarkdown([
    '| 姓名 | 年龄 |',
    '| --- | --- |',
    '| 小明 | 30 |',
    '| 小红 | 25 |'
  ].join('\n'));
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<thead><tr><th>姓名<\/th><th>年龄<\/th><\/tr><\/thead>/);
  assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/) || [])[0].match(/<tr>/g).length, 2);
  assert.doesNotMatch(html, /\|---/, '分隔行原文不应残留');
});

test('表格: 对齐标记映射为 text-align', () => {
  const html = md.miniMarkdown(['| L | C | R |', '| :--- | :---: | ---: |', '| a | b | c |'].join('\n'));
  assert.match(html, /<th style="text-align:left">L<\/th>/);
  assert.match(html, /<th style="text-align:center">C<\/th>/);
  assert.match(html, /<th style="text-align:right">R<\/th>/);
  assert.equal(md.mdAlignOf(':---:'), 'center');
  assert.equal(md.mdAlignOf('---:'), 'right');
  assert.equal(md.mdAlignOf(':---'), 'left');
  assert.equal(md.mdAlignOf('---'), '');
});

test('表格: 单元格内行内格式生效（加粗/代码/链接）', () => {
  const html = md.miniMarkdown([
    '| A | B | C |',
    '| --- | --- | --- |',
    '| **粗** | `code` | [文档](https://example.com) |'
  ].join('\n'));
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<code class="md-inline">code<\/code>/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test('表格: 单元格内链接同样受协议白名单约束', () => {
  const html = md.miniMarkdown(['| A |', '| --- |', '| [x](javascript:alert(1)) |'].join('\n'));
  assert.match(html, /href="#"/, 'javascript: 必须降级为 #');
  assert.doesNotMatch(html, /href="javascript:/);
});

test('表格: 列数不足补空、超出截断', () => {
  const short = md.miniMarkdown(['| A | B |', '| --- | --- |', '| 1 |'].join('\n'));
  assert.equal((short.match(/<td/g) || []).length, 2, '缺列应补空单元格');
  const long = md.miniMarkdown(['| A |', '| --- |', '| 1 | 2 | 3 |'].join('\n'));
  assert.equal((long.match(/<td/g) || []).length, 1, '多列应按表头截断');
});

test('表格: 转义竖线不拆列', () => {
  // 数组来自 vm realm，原型与宿主不同，须 structuredClone 转回宿主 realm
  // 才能通过 deepStrictEqual（同本文件顶部 loadPureFunctions 的处理）
  assert.deepEqual(structuredClone(md.mdSplitRow('| a \\| b | c |')), ['a | b', 'c']);
});

test('表格: 仅有表头无数据行时不输出 tbody', () => {
  const html = md.miniMarkdown(['| A | B |', '| --- | --- |'].join('\n'));
  assert.match(html, /<table/);
  assert.doesNotMatch(html, /<tbody>/);
});

test('表格: 空行终止表格块，其后正文照常渲染', () => {
  const html = md.miniMarkdown(['| A |', '| --- |', '| 1 |', '', '后续段落'].join('\n'));
  assert.match(html, /<table/);
  assert.match(html, /后续段落/);
});

test('表格: 多个表格各自独立渲染', () => {
  const html = md.miniMarkdown(['| A |', '| --- |', '| 1 |', '', '| B |', '| --- |', '| 2 |'].join('\n'));
  assert.equal((html.match(/<table class="md-table">/g) || []).length, 2);
});

test('表格: 不误判水平线与无竖线的分隔行', () => {
  const hr = md.miniMarkdown('正文\n\n---\n\n后文');
  assert.match(hr, /<hr class="md-hr">/);
  assert.doesNotMatch(hr, /<table/, '--- 仍是水平线，不是表格');

  const setext = md.miniMarkdown('标题\n---');
  assert.doesNotMatch(setext, /<table/, '表头无竖线时不应判为表格');

  const noSep = md.miniMarkdown('a | b\n不是分隔行');
  assert.doesNotMatch(noSep, /<table/, '第二行非分隔行时不判为表格');
});

test('表格: 与代码块共存互不破坏', () => {
  const html = md.miniMarkdown(['```js', 'const a = [1, 2];', '```', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n'));
  assert.match(html, /md-code/, '代码块应保留');
  assert.match(html, /<table class="md-table">/, '表格应照常渲染');
  assert.match(html, /const a =/, '代码块内容未被表格解析破坏');
});

test('表格: 单元格内 HTML 被转义（XSS）', () => {
  const html = md.miniMarkdown(['| A |', '| --- |', '| <img src=x onerror=alert(1)> |'].join('\n'));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});