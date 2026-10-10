'use strict';
/* Electron 渲染层 A/B 实测：依次用「改造前 / 改造后」两版 renderer/agents.js
 * 启动应用，执行完全相同的 __perfDrive 脚本，采集真实帧间隔 / 长任务 / 重建次数。
 * 注意：会临时覆盖 renderer/agents.js，结束后务必还原。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, 'renderer', 'agents.js');
// 必须用项目本地的 electron 可执行文件：process.execPath 在 Node 上下文里是 node.exe
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const VARIANTS = [
  ['before', path.join(__dirname, 'baseline', 'agents-before-hooked.js')],
  ['after', LIVE]
];
const ENTRIES = Number(process.env.PERF_ENTRIES || 120);
const BAK = LIVE + '.perfbak';

function read(p) { return fs.readFileSync(p, 'utf8'); }

if (!fs.existsSync(BAK)) {
  fs.copyFileSync(LIVE, BAK);
  console.log('[ab] 已备份原文件');
}

const results = {};
let failed = false;
try {
  for (const [tag, file] of VARIANTS) {
    const src = read(file);
    fs.writeFileSync(LIVE, src);
    console.log('[ab] 启动 ' + tag + ' 版（' + path.relative(ROOT, file) + '）...');
    // 注意：ELECTRON_RUN_AS_NODE 必须"不存在"而非空串，否则 Electron 退化为纯 Node
    const env = Object.assign({}, process.env, { PERF: '1', PERF_ENTRIES: String(ENTRIES) });
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(ELECTRON, ['.'], {
      cwd: ROOT,
      env,
      timeout: 120000,
      encoding: 'utf8'
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = /\[perf-test\]\s*(\{.*\})/.exec(out);
    if (m) {
      try {
        results[tag] = JSON.parse(m[1]);
        console.log('[ab] ' + tag + ' 完成：帧P95=' + results[tag].frameP95 + 'ms  长任务=' + (results[tag].longTaskTotalMs) + 'ms');
      } catch (e) {
        console.log('[ab] ' + tag + ' JSON 解析失败');
        failed = true;
      }
    } else {
      console.log('[ab] ' + tag + ' 未拿到结果，输出尾部：');
      console.log(out.split('\n').filter((l) => l.includes('perf-test')).slice(0, 3).join('\n'));
      failed = true;
    }
  }
} finally {
  fs.copyFileSync(BAK, LIVE);
  fs.unlinkSync(BAK);
  console.log('[ab] 已还原 renderer/agents.js');
}

if (results.before && results.after) {
  const b = results.before, a = results.after;
  const line = (label, k, unit) => {
    const bv = b[k], av = a[k];
    const pct = bv === 0 ? (av === 0 ? '—' : '↑') : ((av - bv) / bv * 100).toFixed(1) + '%';
    console.log('  ' + label.padEnd(24) + String(bv).padStart(10) + String(av).padStart(12) + pct.padStart(11) + (unit || ''));
  };
  console.log('\n【Electron 渲染层实测 · ' + ENTRIES + ' entries】');
  console.log('  ' + '指标'.padEnd(22) + '改造前'.padStart(10) + '改造后'.padStart(12) + '变化'.padStart(11));
  console.log('  ' + '-'.repeat(60));
  line('entry DOM 重建', 'eBuiltTotal', '');
  line('renderTranscript 调用', 'counters.tCalls', '');
  line('renderTranscript ms', 'counters.tMs', '');
  line('帧数', 'frames', '');
  line('平均帧间隔 ms', 'frameAvgMs', '');
  line('帧间隔 P50 ms', 'frameP50', '');
  line('帧间隔 P95 ms', 'frameP95', '');
  line('最长帧 ms', 'frameMaxMs', '');
  line('掉帧数(>32ms)', 'jankFrames', '');
  line('长任务总时长 ms', 'longTaskTotalMs', '');
  line('事件驱动总耗时 ms', 'driveMs', '');
  console.log('  DOM 节点: before=' + b.dom.transcriptChildren + '  after=' + a.dom.transcriptChildren +
    ' → ' + (b.dom.transcriptChildren === a.dom.transcriptChildren ? '一致 ✓' : '不一致 ✗'));
  fs.writeFileSync(path.join(__dirname, 'electron-ab.json'), JSON.stringify(results, null, 2));
  console.log('\n完整数据已写入 .perf/electron-ab.json');
} else {
  console.log('[ab] 数据不完整，未生成对比表' + (failed ? '（有失败项）' : ''));
  process.exitCode = 1;
}