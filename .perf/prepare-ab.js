'use strict';
/* Electron 渲染层 A/B 实测 —— 单次运行版（沙箱禁止 Node spawn 子进程，故拆成两次调用）
 *
 * 用法：
 *   1) node prepare-ab.js before   # 把改造前版本装到 renderer/agents.js
 *   2) PERF=1 PERF_ENTRIES=120 ./node_modules/electron/dist/electron.exe .   # 跑实测
 *   3) node prepare-ab.js after    # 还原为改造后版本
 *   4) node prepare-ab.js collect  # 汇总两次结果并输出对比表
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, 'renderer', 'agents.js');
const BAK = path.join(__dirname, 'baseline', 'renderer-agents.original.js');
const BEFORE = path.join(__dirname, 'baseline', 'agents-before-hooked.js');
const RESULT = path.join(__dirname, 'electron-perf.json');

const mode = process.argv[2];
if (!mode) {
  console.log('用法: node prepare-ab.js <before|after|collect>');
  process.exit(1);
}

if (mode === 'before') {
  // 关键：每次装载前都刷新备份。若仅在备份不存在时备份，
  // 第二次运行会把「已被替换成基线版的 LIVE」当作原件存下，导致还原丢失改动。
  fs.copyFileSync(LIVE, BAK);
  fs.copyFileSync(BEFORE, LIVE);
  console.log('[ab] 已装载改造前版本（当前 renderer/agents.js 已备份至 .perf/baseline/renderer-agents.original.js）');
  console.log('[ab] 现在执行: PERF=1 PERF_ENTRIES=120 ./node_modules/electron/dist/electron.exe .');
} else if (mode === 'after') {
  fs.copyFileSync(BAK, LIVE);
  console.log('[ab] 已还原为改造后版本');
} else if (mode === 'restore') {
  if (fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, LIVE);
    console.log('[ab] 已从备份还原 renderer/agents.js');
  } else {
    console.log('[ab] 无备份文件，无需还原');
  }
} else if (mode === 'collect') {
  const which = process.argv[3] || 'after';
  const j = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  const store = path.join(__dirname, 'electron-ab-partial.json');
  let all = {};
  if (fs.existsSync(store)) all = JSON.parse(fs.readFileSync(store, 'utf8'));
  all[which] = j;
  fs.writeFileSync(store, JSON.stringify(all, null, 2));
  console.log('[ab] 已记录 ' + which + ' 版结果');
  if (all.before && all.after) {
    printTable(all.before, all.after);
    fs.writeFileSync(path.join(__dirname, 'electron-ab.json'), JSON.stringify(all, null, 2));
    console.log('\n完整数据: .perf/electron-ab.json');
  } else {
    console.log('[ab] 还需另一版本数据。已跑完 ' + Object.keys(all).join(', ') + '，请跑另一版本后 collect');
  }
} else {
  console.log('未知模式: ' + mode);
  process.exit(1);
}

function printTable(b, a) {
  const g = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const fmtNum = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
  const line = (label, k) => {
    const bv = g(b, k), av = g(a, k);
    const pct = bv === 0 ? (av === 0 ? '—' : '↑') : ((av - bv) / bv * 100).toFixed(1) + '%';
    console.log('  ' + label.padEnd(24) + fmtNum(bv).padStart(10) + fmtNum(av).padStart(12) + pct.padStart(11));
  };
  console.log('\n【Electron 渲染层实测 · 真实 Chromium 帧数据】');
  console.log('  ' + '指标'.padEnd(22) + '改造前'.padStart(10) + '改造后'.padStart(12) + '变化'.padStart(11));
  console.log('  ' + '-'.repeat(62));
  line('entry DOM 重建次数', 'eBuiltTotal');
  line('renderTranscript 调用', 'counters.tCalls');
  line('renderTranscript 累计ms', 'counters.tMs');
  line('renderAgentList 调用', 'counters.lCalls');
  line('renderHistory 调用', 'counters.hCalls');
  line('长任务总时长 ms', 'longTaskTotalMs');
  line('事件驱动总耗时 ms', 'driveMs');
  console.log('  ' + '-'.repeat(62));
  line('采集帧数', 'frames');
  line('平均帧间隔 ms', 'frameAvgMs');
  line('帧间隔 P50 ms', 'frameP50');
  line('帧间隔 P95 ms', 'frameP95');
  line('最长帧 ms', 'frameMaxMs');
  line('掉帧数(>32ms)', 'jankFrames');
  line('空闲帧率 fps', 'idleFps');
  line('空闲 P95 帧间隔', 'idleFrameP95Ms');
  console.log('  DOM 节点数: before=' + b.dom.transcriptChildren + '  after=' + a.dom.transcriptChildren +
    ' → ' + (b.dom.transcriptChildren === a.dom.transcriptChildren ? '一致 ✓' : '不一致 ✗'));
}