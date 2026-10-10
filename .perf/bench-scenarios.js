'use strict';
/* 场景 B：真实 Agent 行为特征
 *  B1 流式打字：text_delta 高频追加，观察是否触发整树重建
 *  B2 同一文件反复修改：验证 lineDiff 记忆化命中率
 *  B3 多会话并行：验证列表签名复用
 */
const fs = require('fs');
const path = require('path');
const { newCounters, makeEnv } = require('./dom-harness');
const { instrument } = require('./instrument');

const FILES = {
  before: path.join(__dirname, 'baseline', 'agents-before.js'),
  after: path.join(__dirname, '..', 'renderer', 'agents.js')
};

function load(tag) {
  const src = instrument(fs.readFileSync(FILES[tag], 'utf8'));
  return makeEnv(src, { filename: FILES[tag] });
}

/* ---- B1：流式打字 ---- */
function scenarioStream(env, id, deltas) {
  const onEvent = env.events[0];
  env.ctx.selectAgent(id);
  onEvent({ id, kind: 'meta', task: '流式打字测试', cwd: 'C:\\p', ts: Date.now() });
  onEvent({ id, kind: 'text_delta', text: '开始分析代码结构，' });
  for (let i = 0; i < deltas; i++) onEvent({ id, kind: 'text_delta', text: '增量片段' + i + ' ' });
  onEvent({ id, kind: 'text', text: '完成。' });
}

/* ---- B2：同一文件反复修改 ---- */
function scenarioSameFile(env, id, edits) {
  const onEvent = env.events[0];
  env.ctx.selectAgent(id);
  onEvent({ id, kind: 'meta', task: '同一文件反复修改', cwd: 'C:\\p', ts: Date.now() });
  for (let i = 0; i < edits; i++) {
    const after = Array.from({ length: 14 }, (_, j) => '  line ' + j + ' = ' + (i * 100 + j) + ';').join('\n') + '\n';
    onEvent({ id, kind: 'change', path: 'src/same.js', relPath: 'src/same.js', before: i === 0 ? null : undefined, after, existed: i === 0 });
    // 同一批 entry 下再触发若干无关事件，迫使重绘
    for (let k = 0; k < 3; k++) onEvent({ id, kind: 'tool_call', name: 'read_file', args: { path: 'src/x' + k + '.js' } });
  }
}

/* ---- B3：多会话并行 ---- */
function scenarioMultiAgent(env, agents, eventsEach) {
  const onEvent = env.events[0];
  for (let g = 0; g < agents; g++) {
    const id = 'agent-' + g;
    onEvent({ id, kind: 'meta', task: '并行任务 ' + g, cwd: 'C:\\p' + g, ts: Date.now() });
    for (let i = 0; i < eventsEach; i++) onEvent({ id, kind: 'text', text: '消息 ' + g + '-' + i });
  }
  env.ctx.selectAgent('agent-0');
  for (let i = 0; i < eventsEach; i++) onEvent({ id: 'agent-0', kind: 'text', text: '收尾 ' + i });
}

function snap(env) {
  const P = env.ctx.__PERF__;
  return JSON.parse(JSON.stringify(P));
}
function med(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

const SCEN = {
  B1_流式打字: (env) => scenarioStream(env, 'perf-b1', 200),
  B2_同文件反复改: (env) => scenarioSameFile(env, 'perf-b2', 20),
  B3_多会话并行: (env) => scenarioMultiAgent(env, 12, 20)
};

(async () => {
  const ROUNDS = 5;
  for (const [name, fn] of Object.entries(SCEN)) {
    const acc = { before: [], after: [] };
    for (let r = 0; r < ROUNDS; r++) {
      for (const tag of ['before', 'after']) {
        const env = load(tag);
        const t0 = performance.now();
        fn(env);
        const wall = performance.now() - t0;
        const p = snap(env);
        p.__wall = wall;
        p.__dom = env.registry.get('transcript').children.length;
        acc[tag].push(p);
      }
    }
    const g = (tag, k) => med(acc[tag].map((p) => p[k]));
    const line = (label, k, d = 0) => {
      const b = g('before', k), a = g('after', k);
      const pct = b === 0 ? (a === 0 ? '—' : '↑') : ((a - b) / b * 100).toFixed(1) + '%';
      console.log('  ' + label.padEnd(24) + fmt(b, d).padStart(11) + fmt(a, d).padStart(11) + pct.padStart(11));
    };
    const fmt = (n, d) => Number(n).toFixed(d);
    console.log('\n【' + name + '】' + '(中位数，' + ROUNDS + ' 轮)');
    console.log('  ' + '指标'.padEnd(22) + '改造前'.padStart(11) + '改造后'.padStart(11) + '变化'.padStart(11));
    console.log('  ' + '-'.repeat(58));
    line('renderTranscript 调用', 'tCalls');
    line('entry DOM 重建', 'eBuilt');
    line('全量 innerHTML 清空', 'resets');
    line('列表行重建', 'lRows');
    line('renderHistory 调用', 'hCalls');
    line('miniMarkdown 调用', 'md');
    line('lineDiff 调用', 'dAll');
    line('lineDiff 缓存命中', 'dHit');
    line('renderTranscript ms', 'tMs', 2);
    line('总墙钟 ms', '__wall', 2);
    const db = g('before', '__dom'), da = g('after', '__dom');
    console.log('  DOM 一致性: ' + db + ' vs ' + da + ' → ' + (db === da ? '一致 ✓' : '不一致 ✗'));
  }
})();