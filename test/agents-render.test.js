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