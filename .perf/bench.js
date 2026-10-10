'use strict';
/* A/B 基准：同一段 Agent 事件流分别驱动「改造前 / 改造后」两版 agents.js，
 * 统计 renderTranscript 的真实 DOM 重建次数与耗时。
 * 用法：node bench.js [entryCount] [rounds]
 */
const fs = require('fs');
const path = require('path');
const { newCounters, makeEnv } = require('./dom-harness');
const { instrument } = require('./instrument');

const ENTRY_COUNT = Number(process.argv[2] || 60);
const ROUNDS = Number(process.argv[3] || 5);

const FILES = {
  before: path.join(__dirname, 'baseline', 'agents-before.js'),
  after: path.join(__dirname, '..', 'renderer', 'agents.js')
};

/* ---- 构造可复现的事件流（贴近真实 Agent 会话） ---- */
function buildEvents(task) {
  const evs = [];
  const push = (e) => evs.push(Object.assign({ id: task.id }, e));
  push({ kind: 'meta', task: task.name, cwd: 'H:\\work\\proj', ts: Date.now() });
  const roles = ['user', 'agent-msg', 'tool', 'tool', 'agent-msg', 'change', 'tool'];
  const names = ['list_dir', 'read_file', 'search_files', 'run_command', 'write_file', 'grep'];
  let k = 0;
  for (let i = 1; i < ENTRY_COUNT; i++) {
    const role = roles[k % roles.length];
    if (role === 'user') push({ kind: 'text', text: '继续处理第 ' + i + ' 项：' + filler(i) });
    else if (role === 'agent-msg') push({ kind: 'text', text: '第 ' + i + ' 步完成，' + filler(i) });
    else if (role === 'change') {
      push({
        kind: 'change', path: 'src/f' + i + '.js', relPath: 'src/f' + i + '.js',
        before: i % 2 ? codeBlock(i, 12) : null, after: codeBlock(i, 12), existed: i % 2 === 0
      });
    } else {
      const name = names[k % names.length];
      push({ kind: 'tool_call', name, args: { path: 'src/f' + i + '.js', command: 'node --test src/f' + i } });
      push({ kind: 'tool_result', name, result: '退出码: 0\n' + lines(i) });
    }
    k++;
  }
  return evs;
}
function filler(i) {
  const base = '已定位到相关模块并完成校验；接下来同步更新依赖引用与单测，确保行为等价。';
  return base + ' '.repeat(i % 5) + '(#' + i + ')';
}
function codeBlock(i, n) {
  const out = [];
  for (let j = 0; j < n; j++) out.push('  const v' + j + ' = ' + (i * j) + ';');
  return out.join('\n') + '\n';
}
function lines(i) {
  const out = [];
  for (let j = 0; j < 8; j++) out.push('  ok ' + j + ' - ' + (i + j));
  return out.join('\n');
}

async function runOne(tag, file, evs, task) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = instrument(raw);
  const env = makeEnv(src, { filename: file });
  const ctx = env.ctx;
  const onEvent = env.events[0];
  if (!onEvent) throw new Error(tag + ': onAgentEvent 未注册');
  if (typeof ctx.selectAgent !== 'function') throw new Error(tag + ': selectAgent 未暴露');
  // 先选中目标 agent，否则事件流因 ev.id !== selectedId 被过滤，renderTranscript 不会触发
  ctx.selectAgent(task.id);
  const t0 = performance.now();
  if (process.env.PERF_TRACE) {
    evs.forEach((ev, i) => {
      const s = performance.now();
      onEvent(ev);
      const d = performance.now() - s;
      if (d > 50) console.log(`  [trace] #${i} ${ev.kind} ${ev.name || ''} ${d.toFixed(1)}ms`);
    });
  } else {
    for (const ev of evs) onEvent(ev);
  }
  const wall = performance.now() - t0;
  const P = ctx.__PERF__;
  const dbg = env.win.__debugAgents();
  return {
    tag, wall,
    perf: JSON.parse(JSON.stringify(P)),
    dom: {
      transcriptChildren: env.registry.get('transcript').children.length,
      listItems: env.registry.get('agent-list').children.length
    },
    dbg
  };
}

function med(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

(async () => {
  const task = { id: 'perf-task', name: '性能基准任务：批量重构并补齐单测' };
  const evs = buildEvents(task);
  console.log('事件流：' + evs.length + ' 个事件，约 ' + ENTRY_COUNT + ' 条 entry，重复 ' + ROUNDS + ' 轮\n');

  const acc = { before: [], after: [] };
  const detail = {};
  for (let r = 0; r < ROUNDS; r++) {
    for (const tag of ['before', 'after']) {
      const counters = newCounters();
      const res = await runOne(tag, FILES[tag], evs, task);
      acc[tag].push(res);
      if (r === 0) detail[tag] = res;
    }
  }

  const fmt = (n, d = 0) => Number(n).toFixed(d);
  const row = (label, pick, unit = '') => {
    const b = acc.before.map(pick), a = acc.after.map(pick);
    const mb = med(b), ma = med(a);
    const pct = mb === 0 ? (ma === 0 ? '—' : '↑') : ((ma - mb) / mb * 100);
    console.log(
      label.padEnd(26) +
      fmt(mb, 2).padStart(12) + unit.padStart(2) +
      fmt(ma, 2).padStart(12) + unit.padStart(2) +
      (typeof pct === 'string' ? pct.padStart(12) : (pct.toFixed(1) + '%').padStart(12))
    );
  };
  console.log('指标'.padEnd(24) + '改造前'.padStart(14) + '改造后'.padStart(14) + '变化'.padStart(14));
  console.log('-'.repeat(66));
  row('renderTranscript 调用', (r) => r.perf.tCalls);
  row('entry 遍历次数', (r) => r.perf.eTotal);
  row('entry DOM 重建次数', (r) => r.perf.eBuilt);
  row('全量 innerHTML 清空', (r) => r.perf.resets);
  row('renderAgentList 调用', (r) => r.perf.lCalls);
  row('列表行重建次数', (r) => r.perf.lRows);
  row('renderHistory 调用', (r) => r.perf.hCalls);
  row('miniMarkdown 调用', (r) => r.perf.md);
  row('lineDiff 调用', (r) => r.perf.dAll);
  row('lineDiff 缓存命中', (r) => r.perf.dHit);
  console.log('-'.repeat(66));
  row('renderTranscript 耗时ms', (r) => r.perf.tMs);
  row('renderAgentList 耗时ms', (r) => r.perf.lMs);
  row('renderHistory 耗时ms', (r) => r.perf.hMs);
  row('总墙钟ms', (r) => r.wall);

  console.log('\n渲染正确性比对（两版最终 DOM 应一致）：');
  for (const tag of ['before', 'after']) {
    const d = detail[tag];
    console.log(`  ${tag.padEnd(7)} transcript 子节点=${d.dom.transcriptChildren}  列表项=${d.dom.listItems}  entries遍历=${d.perf.eTotal}`);
  }
  const ok = detail.before.dom.transcriptChildren === detail.after.dom.transcriptChildren;
  console.log('  ' + (ok ? '一致 ✓' : '不一致 ✗（增量实现有偏差，需修正）'));

  const out = { entryCount: ENTRY_COUNT, rounds: ROUNDS, detail, median: {
    before: pick(acc.before), after: pick(acc.after)
  } };
  fs.writeFileSync(path.join(__dirname, 'bench-result.json'), JSON.stringify(out, null, 2));
  console.log('\n明细已写入 .perf/bench-result.json');
})();

function pick(arr) {
  const keys = ['tCalls', 'tMs', 'lCalls', 'lMs', 'hCalls', 'hMs', 'md', 'dAll', 'dHit', 'eTotal', 'eBuilt', 'resets', 'lRows', 'hRows'];
  const o = {};
  for (const k of keys) o[k] = med(arr.map((r) => r.perf[k]));
  o.wall = med(arr.map((r) => r.wall));
  return o;
}