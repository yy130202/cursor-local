'use strict';
/**
 * Cursor Local - 发布验证总编排器
 *
 * 【本文件取代 scripts/smoke-and-gates.js 的门禁部分】
 * 旧文件用 checkGate(idx, cat, name, () => true) 计数 89 个门禁，
 * 其中 87 个是空壳 —— 数量达标但什么都没检查。本编排器改为调用三个
 * 真实门禁模块，每条 PASS 都必须携带实测证据：
 *
 *   static-compliance.js  GATE-001~040  源码合规 / 合规法律 / 测试覆盖
 *   perf-consistency.js  GATE-041~069  性能实测 / 数据一致性
 *   release-ops.js       GATE-070~089  发布防护与运维
 *
 * 【三态统计原则】
 *   PASS          真实通过，且带证据
 *   FAIL          真实失败
 *   SKIPPED_ENV   环境受限本轮无法验证（依赖子进程等），不等于通过
 * 汇总时 SKIPPED_ENV 单列，不混入通过率 —— 宁可承认「没验」，不可冒充「验过」。
 */

const fs = require('fs');
const path = require('path');

const { assertAllHaveEvidence, summarize, auditShell, ROOT } = require('../lib/verify-harness');
const { runStaticComplianceGates } = require('./static-compliance');
const { runPerfConsistencyGates } = require('./perf-consistency');
const { runReleaseGates } = require('./release-ops');
const { buildHtml } = require('./build-matrix');

const START = Date.now();

/** 把门禁结果落盘，供矩阵生成器与外部工具消费 */
function writeGateOutput(items, elapsed) {
  const stat = {
    total: items.length,
    passed: items.filter((x) => x.status === 'PASS').length,
    failed: items.filter((x) => x.status === 'FAIL').length,
    skippedEnv: items.filter((x) => x.status === 'SKIPPED_ENV').length
  };
  const verifiable = stat.passed + stat.failed;
  stat.effectiveRate = verifiable ? +(stat.passed / verifiable * 100).toFixed(2) : 0;
  const outFile = path.join(ROOT, 'outputs', 'quality-gates-real.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    durationMs: elapsed,
    ...stat,
    gates: items
  }, null, 2), 'utf8');
  return stat;
}

/** 用刚落盘的门禁结果重建验收矩阵 */
function rebuildMatrix() {
  const out = path.join(ROOT, 'outputs', 'release-verification-matrix.html');
  fs.writeFileSync(out, buildHtml(), 'utf8');
  return out;
}

async function runAllGates() {
  /*
   * 顺序说明（踩过的坑）：
   *   产物清单必须在门禁执行「之前」刷新一次。
   *   因为 GATE-073/089 会读取清单里的 digest 并与磁盘比对，
   *   若先用旧清单跑门禁、跑完才刷新，中途任何代码改动都会让这两条误判失配。
   *   同理矩阵要先生成一次供 GATE-087 校验结构。
   */
  try {
    require('../release-guard').createArtifactManifest();
  } catch (err) {
    console.warn('[Gates] 产物清单预刷新失败:', err.message);
  }

  console.log('[Gates] 正在执行静态安全 / 合规 / 测试覆盖门禁（40 项）...');
  const a = await runStaticComplianceGates();
  console.log('[Gates] 正在执行性能指标 / 数据一致性门禁（29 项）...');
  const b = await runPerfConsistencyGates();
  /*
   * 顺序很关键：验收矩阵由门禁真实结果渲染，而 GATE-087 又要校验矩阵本身。
   * 若在发布防护门禁之前生成矩阵，矩阵里就缺少 GATE-070~089 的结论，
   * GATE-087 校验的是一份「不完整」的报告。
   *
   * 正确顺序：
   *   1) 跑前两组（69 项）
   *   2) 落盘 + 生成矩阵（供第 3 组校验结构）
   *   3) 跑发布防护（其中 GATE-087 校验矩阵结构是否合法）
   *   4) 全部完成后再次落盘 + 重建矩阵（让最终报告包含全部 89 项）
   */
  writeGateOutput([...a.items, ...b.items], Date.now() - START);
  rebuildMatrix();

  console.log('[Gates] 正在执行发布防护门禁（20 项）...');
  const c = await runReleaseGates();

  const items = [...a.items, ...b.items, ...c.items];
  // 编号连续性校验：门禁必须完整覆盖 GATE-001 ~ GATE-089，缺号即视为编排错误
  const ids = items.map((x) => x.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new Error(`门禁编号重复: ${[...new Set(dup)].join(', ')}`);
  const expected = Array.from({ length: 89 }, (_, i) => `GATE-${String(i + 1).padStart(3, '0')}`);
  const missing = expected.filter((id) => !ids.includes(id));
  if (missing.length) throw new Error(`门禁编号缺失 ${missing.length} 个: ${missing.join(', ')}`);

  // 证据审计：任何 PASS 必须带证据，否则视为伪造
  assertAllHaveEvidence({ items }, '质量门禁');

  const stat = summarize(items);
  return { ...stat, items };
}

async function main() {
  const result = await runAllGates();
  const elapsed = Date.now() - START;
  const stat = writeGateOutput(result.items, elapsed);
  // 矩阵需在全部门禁（含发布防护）完成后重建一次，保证报告反映最终状态
  rebuildMatrix();
  // 产物清单随门禁结果更新，避免 GATE-073 因报告变动而失配
  try {
    const rg = require('../release-guard');
    rg.createArtifactManifest();
  } catch (err) {
    console.warn('[Gates] 产物清单刷新失败（不影响门禁结论）:', err.message);
  }

  const byCat = {};
  for (const g of result.items) {
    byCat[g.category] = byCat[g.category] || { total: 0, PASS: 0, FAIL: 0, SKIPPED_ENV: 0 };
    byCat[g.category].total++;
    byCat[g.category][g.status]++;
  }

  console.log('');
  console.log('='.repeat(72));
  console.log(`质量门禁执行完成（耗时 ${elapsed}ms）`);
  console.log('='.repeat(72));
  for (const [cat, s] of Object.entries(byCat)) {
    console.log(`  ${cat.padEnd(12, '　')}  共 ${String(s.total).padStart(3)} 项   PASS ${String(s.PASS).padStart(3)}   FAIL ${String(s.FAIL).padStart(2)}   环境受限 ${s.SKIPPED_ENV}`);
  }
  console.log('-'.repeat(72));
  console.log(`  合计 ${result.total} 项 | 通过 ${result.passed} | 失败 ${result.failed} | 环境受限 ${result.skippedEnv}`);
  console.log(`  可验证范围内通过率: ${result.effectiveRate}%`);

  if (result.failed) {
    console.log('');
    console.log('失败明细：');
    for (const g of result.items.filter((x) => x.status === 'FAIL')) {
      console.log(`  [${g.id}] ${g.name}`);
      console.log(`      ${String(g.reason).split('\n')[0]}`);
    }
  }
  if (result.skippedEnv) {
    console.log('');
    console.log('环境受限（未验证，不计入通过）：');
    for (const g of result.items.filter((x) => x.status === 'SKIPPED_ENV')) {
      console.log(`  [${g.id}] ${g.name} — ${String(g.reason).slice(0, 100)}`);
    }
  }
  console.log('');
  console.log(`结果已写入: outputs/quality-gates-real.json`);
  if (result.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Gates 错误]', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { runAllGates };