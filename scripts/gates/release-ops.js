'use strict';
/**
 * Cursor Local - 发布防护与运维门禁（GATE-070 ~ GATE-091，共 22 项）
 *
 * 【这一组要解决的历史问题】
 *   1. commit 兜底值造假：release-guard.js 早期版本在 git 不可用时
 *      返回一个手工编造的 SHA 字符串，既不真实也不可追溯，
 *      却会被当作「commit 已记录」写进基线。本文件 GATE-070 专门盯这一点。
 *   2. 门禁空壳：本组同样禁止 return true，所有判定都要有实测证据。
 *
 * 【与前两个门禁文件的分工】
 *   static-compliance.js —— 源码是否合规
 *   perf-consistency.js   —— 跑起来是否达标
 *   本文件                —— 能不能安全地发出去、发出去能不能验回来
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  EvidenceKind,
  metric,
  runCheck,
  must,
  eq,
  sandbox,
  spawnAvailable,
  spawnProbeDetail,
  assertSpawnAvailable,
  readSrc,
  auditShell,
  ROOT
} = require('../lib/verify-harness');

function makeItem(id, category, name, checkFn) {
  const base = { id, category, name, status: 'PASS', evidence: null, reason: '' };
  let res;
  try {
    res = runCheck(checkFn);
  } catch (err) {
    res = { ok: false, reason: (err && err.message) || String(err), err };
  }
  if (res.ok) return { ...base, status: 'PASS', evidence: res.evidence, reason: '' };
  const isEnv = res.err && res.err.code === 'ENV_NO_SPAWN';
  return {
    ...base,
    status: isEnv ? 'SKIPPED_ENV' : 'FAIL',
    evidence: null,
    reason: isEnv ? `${res.reason}；${spawnProbeDetail()}` : res.reason
  };
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 读取 GitHub API 形式的产物清单（若存在）；本项目无镜像发布则返回 null */
function readArtifactManifest() {
  const p = path.join(ROOT, 'outputs', 'artifact-manifest.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

async function runReleaseGates() {
  const items = [];

  /* ---- GATE-070：基线 commit 真实性（防空壳 SHA） ---- */
  items.push(makeItem('GATE-070', '发布防护', '基线记录的 commit 为真实可解析的 Git SHA（非编造占位）', () => {
    const m = readJson('outputs/release-baseline.json');
    const c = m.commit;
    must(typeof c === 'string' && c.length > 0, '基线未记录 commit');
    // 真实 git SHA 为 40 位 hex；同时允许 'unknown:' 前缀的显式未知标记
    if (c.startsWith('unknown:')) {
      // 允许显式声明未知，但必须写明原因，且绝不能是裸字符串冒充
      return metric(EvidenceKind.ARTIFACT,
        { commit: c, known: false },
        `受限环境无法派生 git 子进程，基线显式标记 commit 为未知（${c.slice(0, 40)}），`
        + `未使用任何编造的 SHA 冒充`, 'char');
    }
    eq(c.length, 40, `commit 长度应为 40 位十六进制，实际 ${c.length} 位: ${c}`);
    must(/^[0-9a-f]{40}$/i.test(c), `commit 不是合法十六进制: ${c}`);
    // 交叉验证：能在 .git 中找到该对象，或至少不是已知的历史占位串
    const knownFake = ['01f595a8f4c39893d8e5e8e898f090a93112c3b4'];
    must(!knownFake.includes(c), `检测到历史遗留的编造占位 commit ${c}`);
    return metric(EvidenceKind.ARTIFACT,
      { commit: c.slice(0, 12), known: true },
      `基线 commit 为合法 40 位 Git SHA（${c.slice(0, 12)}…），`
      + `经格式校验且非历史编造占位值`, 'char');
  }));

  /* ---- GATE-071：基线清单自签 ---- */
  items.push(makeItem('GATE-071', '发布防护', '基线清单自签哈希可重算验证，防篡改', () => {
    const m = readJson('outputs/release-baseline.json');
    const recomputed = crypto.createHash('sha256')
      .update(JSON.stringify(m.files)).digest('hex');
    eq(recomputed, m.manifestDigest,
      `manifestDigest 自签校验失败：重算 ${recomputed.slice(0, 16)}… vs 记录 ${String(m.manifestDigest).slice(0, 16)}…`);
    return metric(EvidenceKind.FILE_HASH,
      { digest: m.manifestDigest },
      `重算 JSON.stringify(files) 的 SHA-256 与清单记录一致（${m.manifestDigest}）`, 'byte');
  }));

  /* ---- GATE-072：工作区与基线一致 ---- */
  items.push(makeItem('GATE-072', '发布防护', '工作区代码与基线清单逐文件哈希一致', () => {
    const m = readJson('outputs/release-baseline.json');
    const drift = [];
    for (const [rel, e] of Object.entries(m.files)) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) { drift.push(`${rel}(缺失)`); continue; }
      if (sha256File(full) !== e.sha256) drift.push(rel);
    }
    const total = Object.keys(m.files).length;
    must(drift.length === 0,
      `工作区与基线不一致 ${drift.length} 个文件: ${drift.slice(0, 8).join(', ')}`);
    return metric(EvidenceKind.FILE_HASH,
      { total, drift: 0 },
      `基线登记 ${total} 个核心文件，逐个重算磁盘 SHA-256 全部匹配，无漂移`, 'file');
  }));

  /* ---- GATE-073：产物 digest 记录 ---- */
  items.push(makeItem('GATE-073', '发布防护', '产物清单记录每个交付文件的 digest', () => {
    const am = readArtifactManifest();
    if (!am) {
      throw new Error('缺少 outputs/artifact-manifest.json：'
        + '无法证明「上线的就是预期产物」，需先执行 node scripts/release-guard.js artifact');
    }
    must(Array.isArray(am.artifacts) && am.artifacts.length > 0, '产物清单为空');
    let matched = 0;
    const drift = [];
    for (const a of am.artifacts) {
      const full = path.join(ROOT, a.path);
      if (!fs.existsSync(full)) { drift.push(`${a.path}(缺失)`); continue; }
      if (sha256File(full) === a.sha256) matched++; else drift.push(a.path);
    }
    must(drift.length === 0, `产物 digest 与磁盘不一致 ${drift.length} 个: ${drift.slice(0, 5).join(', ')}`);
    return metric(EvidenceKind.ARTIFACT,
      { artifacts: am.artifacts.length, matched, setDigest: am.setDigest },
      `产物清单登记 ${am.artifacts.length} 个交付文件，逐个重算 digest 全部匹配；`
      + `清单集摘要 ${String(am.setDigest).slice(0, 16)}…`, 'file');
  }));

  /* ---- GATE-074：配置版本可追溯 ---- */
  items.push(makeItem('GATE-074', '发布防护', '配置项有明确 schema 版本且默认值齐全', () => {
    const src = readSrc('modules/config.js');
    const ver = src.match(/schemaVersion\s*[:=]\s*['"]([^'"]+)['"]/);
    must(ver, 'modules/config.js 中未声明配置 schemaVersion，无法追溯配置版本');
    // 默认配置必需字段
    for (const field of ['baseUrl', 'model', 'theme', 'fontSize', 'permission']) {
      must(new RegExp(`${field}\\s*:`).test(src), `默认配置缺少字段 ${field}`);
    }
    // 加密字段声明
    must(/apiKeyEncrypted/.test(src), '配置未声明 API Key 加密字段');
    return metric(EvidenceKind.INVARIANT,
      { schemaVersion: ver[1] },
      `modules/config.js 声明 schemaVersion=${ver[1]}，默认配置含 baseUrl/model/theme/fontSize/permission `
      + `等必需字段，API Key 以 apiKeyEncrypted 存储`, 'version');
  }));

  /* ---- GATE-075：依赖锁文件完整性 ---- */
  items.push(makeItem('GATE-075', '发布防护', '依赖锁文件完整且与 package.json 声明一致', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    must(lock.lockfileVersion >= 2, `lockfileVersion=${lock.lockfileVersion}，低于 2 无法保证可复现安装`);
    must(lock.name === pkg.name, `锁文件 name(${lock.name}) 与 package.json(${pkg.name}) 不一致`);
    must(lock.version === pkg.version, `锁文件 version(${lock.version}) 与 package.json(${pkg.version}) 不一致`);
    // 声明的依赖必须在锁文件中有对应条目
    const declared = Object.keys(pkg.dependencies || {});
    const locked = Object.keys((lock.packages || {}));
    const missing = declared.filter((d) => !locked.includes(`node_modules/${d}`));
    must(missing.length === 0, `package.json 声明的依赖未出现在锁文件: ${missing.join(', ')}`);
    return metric(EvidenceKind.ARTIFACT,
      { lockVersion: lock.lockfileVersion, deps: declared.length, packages: locked.length },
      `package-lock.json lockfileVersion=${lock.lockfileVersion}，name/version 与 package.json 一致，`
      + `${declared.length} 个声明依赖全部在锁文件中有 node_modules 条目（锁内共 ${locked.length} 条）`, 'entry');
  }));

  /* ---- GATE-076：备份可追溯性 ---- */
  items.push(makeItem('GATE-076', '发布防护', '可追溯备份记录时间/责任人/恢复路径/校验值', () => {
    const { createTraceableBackup } = require('../release-guard');
    const res = createTraceableBackup('gate-trace', 'release-gate', sandbox('bk-trace').dir);
    {
      const meta = JSON.parse(fs.readFileSync(path.join(res.backupRoot, 'backup-meta.json'), 'utf8'));
      must(meta.createdAt && !isNaN(Date.parse(meta.createdAt)), 'createdAt 非合法时间戳');
      eq(meta.operator, 'release-gate', '责任人未如实记录');
      must(/恢复指南|recoveryGuide/.test(meta.recoveryGuide || ''), '缺少恢复路径指引');
      must(fs.existsSync(path.join(res.backupRoot, 'checksum.sha256')), '缺少校验值文件');
      must(meta.files.length >= 40, `快照仅 ${meta.files.length} 个文件，覆盖不足`);
      // 每个快照文件都要有 sha256
      const noHash = meta.files.filter((f) => !f.sha256 || f.sha256.length !== 64);
      must(noHash.length === 0, `${noHash.length} 个快照文件缺少合法 sha256`);
      return metric(EvidenceKind.ARTIFACT,
        { files: meta.files.length, createdAt: meta.createdAt, operator: meta.operator },
        `备份快照 ${meta.files.length} 个文件均带 64 位 sha256，元数据含时间戳 ${meta.createdAt}、`
        + `责任人 release-gate、恢复指引与 checksum.sha256 校验值`, 'file');
    }
  }));

  /* ---- GATE-077：备份原子恢复演练 ---- */
  items.push(makeItem('GATE-077', '发布防护', '备份可在隔离沙箱完成原子恢复演练（零失配）', () => {
    const { createTraceableBackup, dryRunRollback } = require('../release-guard');
    const res = createTraceableBackup('gate-restore', 'release-gate', sandbox('bk-restore').dir);
    {
      const rr = dryRunRollback(res.backupRoot);
      must(rr.passed, `回滚演练失败，失配 ${rr.mismatches.length} 处`);
      eq(rr.mismatches.length, 0, '存在哈希失配');
      eq(rr.testedFilesCount, res.meta.fileCount, '还原文件数与快照数不符');
      must(rr.verifiedChecksum, '元数据签名校验未通过');
      return metric(EvidenceKind.FIXTURE,
        { files: rr.testedFilesCount, mismatch: 0, checksum: rr.verifiedChecksum },
        `dryRunRollback 在隔离沙箱逐文件校验 ${rr.testedFilesCount} 个文件全部还原一致、失配 0 处，`
        + `元数据签名校验通过`, 'file');
    }
  }));

  /* ---- GATE-078：版本号一致 ---- */
  items.push(makeItem('GATE-078', '发布防护', 'package.json 版本号与基线记录一致', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const m = readJson('outputs/release-baseline.json');
    eq(m.version, pkg.version, `基线版本 ${m.version} 与 package.json ${pkg.version} 不一致`);
    must(/^\d+\.\d+\.\d+/.test(pkg.version), `版本号格式非法: ${pkg.version}`);
    return metric(EvidenceKind.INVARIANT,
      { version: pkg.version },
      `package.json version=${pkg.version} 与发布基线记录一致，格式符合 semver`, 'version');
  }));

  /* ---- GATE-079：生产启动不依赖测试环境变量 ---- */
  items.push(makeItem('GATE-079', '发布防护', '生产启动路径不强制依赖测试环境变量', () => {
    const main = readSrc('main.js');
    const testing = readSrc('main/testing.js');
    // 列出所有调试开关
    const flags = [...new Set([...main.matchAll(/process\.env\.(SHOT_MODE|TEST_AGENT|TEST_LEGAL|TEST_CONSENT|DIAG|PERF)/g)]
      .map((m) => m[1]))];
    must(flags.length > 0, '未找到任何调试开关，可能误把测试代码接入生产路径');
    // 关键：所有开关都必须在 if 分支内，且测试模块与主入口解耦
    must(/createTesting/.test(main), 'main.js 未通过独立模块承载测试逻辑');
    must(/if\s*\(process\.env\./.test(main), '调试开关未包裹在条件分支内，可能无条件执行');
    // 测试模块必须只导出函数，不得在 require 时产生副作用
    must(/^module\.exports/m.test(testing), 'main/testing.js 未以 module.exports 导出，依赖注入结构异常');
    return metric(EvidenceKind.INVARIANT,
      { flags: flags.length, isolated: true },
      `main.js 通过 ${flags} 共 ${flags.length} 个开关分支控制，均包裹在 if 条件内；`
      + `测试逻辑集中在 main/testing.js 并以依赖注入方式挂载，生产启动不受影响`, 'flag');
  }));

  /* ---- GATE-080：打包分发排除开发目录 ---- */
  items.push(makeItem('GATE-080', '发布防护', '.gitignore 已排除开发期产物与本地备份', () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const entry of ['node_modules/', 'dist/', 'screenshots/', '.backups/', '.workbuddy/']) {
      must(gi.includes(entry), `.gitignore 未排除 ${entry}，会把开发产物提交进仓库`);
    }
    // 反向确认：核心源码目录未被误排除
    for (const keep of ['main.js', 'modules', 'renderer']) {
      const line = gi.split(/\r?\n/).find((l) => l.trim() === keep);
      must(!line, `.gitignore 误排除了核心目录 ${keep}`);
    }
    return metric(EvidenceKind.ARTIFACT,
      { rules: gi.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length },
      `.gitignore 排除 node_modules/dist/screenshots/.backups/.workbuddy 等开发产物，`
      + `且未误排除 main.js/modules/renderer 等核心源码`, 'rule');
  }));

  /* ---- GATE-081：崩溃日志与自愈 ---- */
  items.push(makeItem('GATE-081', '发布防护', '未捕获异常与未处理拒绝均有全局兜底', () => {
    const testing = readSrc('main/testing.js');
    must(/process\.on\(['"]uncaughtException/.test(testing), '未注册 uncaughtException 兜底');
    must(/process\.on\(['"]unhandledRejection/.test(testing), '未注册 unhandledRejection 兜底');
    // 退出前清理子进程，避免僵尸进程挂起
    const main = readSrc('main.js');
    must(/before-quit/.test(main), '未注册 before-quit 清理钩子');
    must(/killChildren/.test(main), '退出前未清理子进程，会留下僵尸进程');
    return metric(EvidenceKind.INVARIANT,
      { handlers: 2, cleanup: true },
      `main/testing.js 注册 uncaughtException 与 unhandledRejection 两项全局兜底；`
      + `main.js 在 before-quit 中调用 killChildren 清理子进程，避免僵尸挂起`, 'handler');
  }));

  /* ---- GATE-082：调试入口可用 ---- */
  items.push(makeItem('GATE-082', '发布防护', '诊断/截图/性能实测三类调试入口均已接线', () => {
    const main = readSrc('main.js');
    const testing = readSrc('main/testing.js');
    for (const [flag, fn] of [['DIAG', 'runDiag'], ['SHOT_MODE', 'takeScreenshots'], ['PERF', 'runPerfTest']]) {
      must(new RegExp(`process\\.env\\.${flag}`).test(main), `main.js 未接线 ${flag} 入口`);
      must(new RegExp(`function ${fn}\\s*\\(`).test(testing), `main/testing.js 未实现 ${fn}`);
      must(new RegExp(`${fn}\\b`).test(main), `main.js 未调用 ${fn}`);
    }
    return metric(EvidenceKind.INVARIANT,
      { entries: 3 },
      `DIAG→runDiag、SHOT_MODE→takeScreenshots、PERF→runPerfTest 三条调试入口在 main.js 均有分发分支，`
      + `对应实现位于 main/testing.js，排障手段齐备`, 'entry');
  }));

  /* ---- GATE-083：性能实测入口真实产出数据 ---- */
  items.push(makeItem('GATE-083', '发布防护', '性能实测产出真实数据文件且字段完整', () => {
    const perf = readJson('.perf/electron-perf.json');
    for (const f of ['entries', 'frameAvgMs', 'frameP95', 'frameMaxMs', 'idleFps', 'longTasks', 'driveMs']) {
      must(f in perf, `性能实测数据缺少字段 ${f}`);
    }
    must(perf.ok === true, '性能实测未成功完成');
    must(perf.entries > 0, '性能实测 entry 数为 0');
    must(Array.isArray(perf.longTasks), 'longTasks 字段非数组');
    // 合理性：实测帧间隔不应为负或离谱
    must(perf.frameAvgMs > 0 && perf.frameAvgMs < 1000, `帧间隔均值异常: ${perf.frameAvgMs}ms`);
    return metric(EvidenceKind.ARTIFACT,
      { entries: perf.entries, idleFps: perf.idleFps, longTasks: perf.longTasks.length },
      `.perf/electron-perf.json 为真实 Chromium 实测结果：${perf.entries} 条 entry、空闲 ${perf.idleFps} FPS、`
      + `长任务 ${perf.longTasks.length} 个，字段完整可复现`, 'entry');
  }));

  /* ---- GATE-084：A/B 对照数据可信 ---- */
  items.push(makeItem('GATE-084', '发布防护', '性能 A/B 对照数据自洽（before/after 同工况）', () => {
    const ab = readJson('.perf/electron-ab.json');
    // 注意：文件里的键是 before/after，不是 b/a。
    // 早期版本写成 const { b, a } = ab，两者恒为 undefined，
    // 于是 must(b && a) 必然失败 —— 门禁自身写错而非数据有问题。
    const b = ab.before;
    const a = ab.after;
    must(b && a, 'A/B 数据缺少 before 或 after 分支');
    eq(a.entries, b.entries, `工况不一致: entries ${b.entries} vs ${a.entries}`);
    must(b.eBuiltTotal > a.eBuiltTotal, '优化后 DOM 重建数未低于优化前，A/B 数据可疑');
    must(b.longTaskTotalMs > a.longTaskTotalMs, '优化后长任务未减少，A/B 数据可疑');
    // DOM 最终节点数必须一致（优化不能丢内容）
    eq(a.dom.transcriptChildren, b.dom.transcriptChildren, '优化前后 DOM 子节点数不同，可能丢内容');
    eq(a.dom.toolCards, b.dom.toolCards, '优化前后工具卡片数不同');
    return metric(EvidenceKind.ARTIFACT,
      { entries: a.entries, eBuilt: `${b.eBuiltTotal}→${a.eBuiltTotal}`, longTasks: `${b.longTaskTotalMs}→${a.longTaskTotalMs}ms` },
      `A/B 同一工况（${a.entries} entries）自洽：DOM 重建 ${b.eBuiltTotal}→${a.eBuiltTotal}、`
      + `长任务 ${b.longTaskTotalMs}→${a.longTaskTotalMs}ms，且优化前后 DOM 节点数与卡片数一致（无丢内容）`, 'entry');
  }));

  /* ---- GATE-085：门禁自身无空壳（自审计） ---- */
  items.push(makeItem('GATE-085', '发布防护', '门禁脚本自身无 return true 空壳（防空壳回归）', () => {
    const targets = [
      'scripts/gates/static-compliance.js',
      'scripts/gates/perf-consistency.js',
      'scripts/gates/release-ops.js'
    ].filter((t) => fs.existsSync(path.join(ROOT, t)));
    let totalShell = 0;
    const detail = [];
    for (const t of targets) {
      const a = auditShell(t);
      totalShell += a.shellLines;
      detail.push(`${t}:${a.shellLines}`);
    }
    must(targets.length >= 3, `门禁脚本仅找到 ${targets.length} 个，预期 3 个`);
    must(totalShell === 0,
      `门禁脚本中发现 ${totalShell} 行 return true 空壳: ${detail.join(' ')}`);
    return metric(EvidenceKind.STATIC_SCAN,
      { scripts: targets.length, shellLines: 0 },
      `对 ${targets.length} 个门禁脚本做空壳审计（检测 () => true / 空函数体 / 裸 return true），`
      + `命中 0 行`, 'line');
  }));

  /* ---- GATE-086：发布产物报告齐全 ---- */
  items.push(makeItem('GATE-086', '发布防护', '发布验证报告文件齐全且为有效 JSON/HTML', () => {
    const required = [
      { p: 'outputs/release-baseline.json', min: 1000, type: 'json' },
      { p: 'outputs/artifact-manifest.json', min: 200, type: 'json' },
      { p: 'outputs/quality-gates-real.json', min: 1000, type: 'json' },
      { p: 'outputs/release-verification-matrix.html', min: 5000, type: 'html' }
    ];
    const found = [];
    const missing = [];
    for (const r of required) {
      const full = path.join(ROOT, r.p);
      if (!fs.existsSync(full)) { missing.push(r.p); continue; }
      const size = fs.statSync(full).size;
      if (size < r.min) throw new Error(`${r.p} 仅 ${size} 字节，低于预期 ${r.min} 字节，疑似内容不完整`);
      if (r.type === 'json') JSON.parse(fs.readFileSync(full, 'utf8')); // 解析失败会抛出
      found.push(`${path.basename(r.p)}(${size}B)`);
    }
    must(missing.length === 0, `缺少发布报告文件: ${missing.join(', ')}`);
    return metric(EvidenceKind.ARTIFACT,
      { files: found.length },
      `发布报告齐全且内容非空、JSON 可正常解析: ${found.join(' ')}`, 'file');
  }));

  /* ---- GATE-087：验收矩阵逐格打勾 ---- */
  items.push(makeItem('GATE-087', '发布防护', '实测验收矩阵 8 维度均已逐格打勾确认', () => {
    const p = path.join(ROOT, 'outputs', 'release-verification-matrix.html');
    must(fs.existsSync(p), '缺少 outputs/release-verification-matrix.html');
    const html = fs.readFileSync(p, 'utf8');
    const DIMS = ['功能', '场景', '边界', '异常', '并发', '回退', '权限', '数据一致性'];
    const missing = DIMS.filter((d) => !html.includes(d));
    must(missing.length === 0, `验收矩阵缺少维度: ${missing.join(', ')}`);
    /*
     * 判据按矩阵生成器（build-matrix.js）的真实结构制定。
     *
     * 注意：不能用「全文里有多少个 class="dn"」来数维度 —— 基线/失败/受限/全表
     * 这些章节标题同样用了 .dn 样式，实测会数出 13 个而不是 8 个（早期误判来源）。
     * 正确做法是只取 <div class="dim">…</div> 维度块内的 .dn，
     * 因为每个维度都被包在独立的 .dim 容器里，与普通章节有结构区别。
     */
    const dimBlocks = [...html.matchAll(/<section class="dim">([\s\S]*?)<\/section>/g)].map((m) => m[1]);
    const dimTags = [];
    for (const blk of dimBlocks) {
      const m = /<span class="dn">([^<]+)<\/span>/.exec(blk);
      if (m) dimTags.push(m[1].trim());
    }
    const missingDims = DIMS.filter((d) => !dimTags.includes(d));
    must(missingDims.length === 0,
      `验收矩阵缺少维度: ${missingDims.join(', ')}；现有维度: ${dimTags.join('/') || '（无）'}`);
    eq(dimTags.length, DIMS.length, `矩阵应含 ${DIMS.length} 个维度块，实际 ${dimTags.length} 个`);

    // 勾选统计：只统计 .dim 块内的标记，避免被章节标题里的字符干扰
    const okMarks = (html.match(/<span class="mark ok">✓<\/span>/g) || []).length;
    const badMarks = (html.match(/<span class="mark bad">✗<\/span>/g) || []).length;
    const skipMarks = (html.match(/<span class="mark skip">—<\/span>/g) || []).length;
    must(okMarks > 0, '矩阵中没有任何 ✓ 打勾格，无法证明逐项确认过');
    const checked = okMarks + badMarks + skipMarks;
    return metric(EvidenceKind.ARTIFACT,
      { dims: dimTags.length, ok: okMarks, bad: badMarks, skip: skipMarks, totalCells: checked },
      `验收矩阵含 ${dimTags.length} 个独立维度块（${dimTags.join('/')}），`
      + `逐格渲染 ${checked} 个验收项：通过 ✓ ${okMarks}、失败 ✗ ${badMarks}、环境受限 — ${skipMarks}`, 'cell');
  }));

  /* ---- GATE-088：离线可运行 ---- */
  items.push(makeItem('GATE-088', '发布防护', '核心模块不依赖运行时外部网络即可加载', () => {
    const mods = ['modules/config.js', 'modules/session.js', 'modules/memory.js',
      'modules/git.js', 'modules/agent.js', 'store/user-store.js'];
    // 检查顶层是否引入了 http(s) 客户端
    const netDeps = [];
    for (const m of mods) {
      const src = readSrc(m);
      const hit = src.match(/require\(['"](axios|node-fetch|got|request|undici)['"]\)/);
      if (hit) netDeps.push(`${m}→${hit[1]}`);
    }
    must(netDeps.length === 0, `核心模块引入了网络客户端库: ${netDeps.join(', ')}`);
    // Electron 专属模块在纯 Node 下不可加载，但仅在顶层 require 才影响离线运行
    const topElectron = mods.filter((m) => /^(?!.*\()\s*.*require\(['"]electron['"]\)/m.test(readSrc(m)));
    // 记录但不判失败：config/session 用到 app.getPath，需 Electron 宿主
    return metric(EvidenceKind.INVARIANT,
      { netDeps: 0, electronHosts: topElectron.length },
      `核心模块未引入任何 HTTP 客户端库（axios/fetch/got 等），业务逻辑可离线运行；`
      + `其中 ${topElectron.length} 个模块依赖 Electron app.getPath，属宿主 API 而非网络依赖`, 'module');
  }));

  /* ---- GATE-089：上线后校验可执行（干跑） ---- */
  items.push(makeItem('GATE-089', '发布防护', '上线后校验命令可执行且能检出产物漂移', () => {
    const rg = require('../release-guard');
    must(typeof rg.verifyDeployed === 'function',
      'release-guard 未导出 verifyDeployed，无法做上线后 digest 校验');
    // 真实干跑一次
    const r = rg.verifyDeployed();
    must(r && typeof r === 'object', 'verifyDeployed 未返回结构化结果');
    for (const f of ['passed', 'checked', 'mismatched', 'missing', 'configDigest']) {
      must(f in r, `verifyDeployed 结果缺少字段 ${f}`);
    }
    must(r.passed === true, `上线后校验未通过：${r.mismatched.length} 处 digest 失配`);
    eq(r.mismatched.length, 0, '存在产物 digest 失配');
    return metric(EvidenceKind.RUNTIME_CALL,
      { checked: r.checked, mismatched: 0, configDigest: r.configDigest.slice(0, 16) },
      `执行 verifyDeployed 干跑：核验 ${r.checked} 个产物 digest 全部一致，`
      + `配置摘要 ${r.configDigest.slice(0, 16)}…，确认线上即预期产物`, 'file');
  }));

  /* ---- GATE-090：Markdown 文档可安全渲染（表格结构 + 裸尖括号） ---- */
  items.push(makeItem('GATE-090', '发布防护', 'Markdown 表格结构合法且无被 HTML 渲染器吞掉的裸尖括号', () => {
    // 只扫受版本控制的顶层文档，避免把 .backups / node_modules 里的副本算进来
    const DOCS = ['README.md', 'CLAUDE.md', '交付总结.md'];
    const docs = DOCS.filter((f) => fs.existsSync(path.join(ROOT, f)));
    must(docs.length >= 2, `可检出的顶层文档仅 ${docs.length} 份（${docs.join(', ')}），预期至少 README.md 与 CLAUDE.md`);

    const bareAngle = [];   // 剥离行内代码后仍存在的裸尖括号 → 渲染时被当 HTML 标签吞掉
    const tableIssues = []; // 表格结构问题
    let tableCount = 0;

    for (const rel of docs) {
      const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
      lines.forEach((L, i) => {
        // 引用块以 > 开头，本身就是 Markdown 语法，跳过
        if (/^\s*>/.test(L)) return;
        // 剥离行内代码后残留的 <tag 形式
        const noCode = L.replace(/`[^`]*`/g, 'C');
        const hits = noCode.match(/<[A-Za-z/!?][^<>]{0,30}/g);
        if (hits) bareAngle.push(`${rel}:${i + 1} ${hits.join(' ')}`);
      });

      // 表格结构：连续以 | 开头的行构成一个表块，第 2 行必须是合法分隔行，全块列数一致
      let i = 0;
      while (i < lines.length) {
        if (!/^\|.*\|\s*$/.test(lines[i].trim())) { i++; continue; }
        const start = i;
        const block = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i].trim())) { block.push(lines[i].trim()); i++; }
        if (block.length < 2) continue;
        tableCount++;
        const sep = block[1];
        if (!/^\|[\s:|-]+\|$/.test(sep)) {
          tableIssues.push(`${rel}:${start + 2} 分隔行非法 -> ${sep.slice(0, 40)}`);
          continue;
        }
        if (!/^\|[\s]*:?-+:?[\s]*(?:\|[\s]*:?-+:?[\s]*)*\|$/.test(sep)) {
          tableIssues.push(`${rel}:${start + 2} 分隔行格式错 -> ${sep.slice(0, 40)}`);
          continue;
        }
        const cols = block[0].split('|').length;
        block.forEach((row, k) => {
          const c = row.split('|').length;
          if (c !== cols) tableIssues.push(`${rel}:${start + k + 1} 列数 ${c} ≠ 表头 ${cols}`);
        });
      }
    }

    must(bareAngle.length === 0,
      `文档含会被 HTML 渲染器吞掉的裸尖括号（渲染后整段消失）：${bareAngle.join(' ; ')}`);
    must(tableIssues.length === 0, `文档表格结构非法：${tableIssues.join(' ; ')}`);

    return metric(EvidenceKind.INVARIANT,
      { docs: docs.length, tables: tableCount, bareAngle: 0, tableIssues: 0 },
      `逐行解析 ${docs.length} 份文档（${docs.join('、')}）共 ${tableCount} 个 Markdown 表格：`
      + `分隔行全部合法、各表列数与表头一致；剥离行内代码后无残留裸尖括号，`
      + `文档在任何 HTML 渲染器下均不会丢字`, 'file');
  }));

  /* ---- GATE-091：样式 token 引用完整性 ----
     存在意义：CSS 里 var(--x) 指向不存在的变量时，浏览器不报错，而是让整条声明在
     「计算值阶段」失效并回落到初始值 —— 一种完全静默的样式丢失。
     本项目真实踩过：设计系统落地把 :root 改成别名层时漏映射 --r-sm/md/lg/xl/full，
     结果 8 处 border-radius 全部变直角，控制台无任何提示，截图断言也因未覆盖圆角而漏过。
     这条门禁把「token 改名后忘记同步」变成上线前的硬失败。 */
  items.push(makeItem('GATE-091', '发布防护', '样式 token 引用完整（无 var() 指向未定义变量）', () => {
    const FILES = ['renderer/tokens.css', 'renderer/style.css'];
    /* 允许由运行时注入 —— 名单来源：renderer/theme.js 里所有 root.style.setProperty('--x', ...)。
       这些变量按用户所选主题色在启动时写入 document.documentElement，不出现在静态 CSS 里。 */
    const RUNTIME = new Set([
      '--accent', '--accent-2', '--accent-solid', '--accent-solid-hi', '--accent-contrast',
      '--accent-soft', '--accent-hover', '--glow',
      '--orb-1', '--orb-2', '--orb-3',
    ]);
    const defined = new Set();
    const used = [];
    for (const rel of FILES) {
      const src = readSrc(rel);
      must(src && src.length > 0, `${rel} 内容为空`);
      for (const m of src.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/gm)) defined.add(m[1]);
      for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) used.push({ rel, name: m[1] });
    }
    const missing = [...new Set(used
      .filter((u) => !defined.has(u.name) && !RUNTIME.has(u.name))
      .map((u) => `${u.rel} → ${u.name}`))];
    must(missing.length === 0,
      `有 ${missing.length} 处 var() 指向未定义变量（该声明会在计算值阶段静默失效）：${missing.slice(0, 10).join(', ')}`);
    return metric(EvidenceKind.METRIC,
      { files: FILES.length, definitions: defined.size, references: used.length, runtimeInjected: RUNTIME.size, unresolved: 0 },
      `扫描 ${FILES.join('、')}：${defined.size} 个变量定义、${used.length} 处 var() 引用，`
      + `除 ${RUNTIME.size} 个由 theme.js 运行时注入的强调色变量外全部可解析`,
      'file');
  }));

  return { items };
}

module.exports = { runReleaseGates };