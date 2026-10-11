'use strict';
/**
 * Cursor Local - 发布防护与基线引擎 (Release Guard)
 * 职责：
 *   1. 建立不可篡改的 SHA-256 清单基线 (createBaseline)
 *   2. 比对与校验当前工作区状态 (verifyBaseline)
 *   3. 建立可追溯安全备份 (createTraceableBackup)
 *   4. 执行沙箱无损回滚演练 (dryRunRollback)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// 核心源码与关键配置清单范围
const TARGET_PATTERNS = [
  'main.js',
  'preload.js',
  'package.json',
  'package-lock.json',
  'main',
  'modules',
  'renderer',
  'store'
];

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function scanFiles(dir, relativeTo = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === '.backups') continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(scanFiles(full, relativeTo));
    } else if (item.isFile()) {
      // 排除临时文件和旧备份
      if (item.name.endsWith('.tmp') || item.name.endsWith('.perfbak') || item.name.endsWith('.swp')) continue;
      results.push({
        fullPath: full,
        relPath: path.relative(relativeTo, full).replace(/\\/g, '/')
      });
    }
  }
  return results;
}

function getCoreFileList() {
  const files = [];
  for (const target of TARGET_PATTERNS) {
    const full = path.join(ROOT, target);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const sub = scanFiles(full, ROOT);
      files.push(...sub);
    } else if (stat.isFile()) {
      files.push({ fullPath: full, relPath: target });
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

/**
 * 取当前 commit SHA。
 *
 * 【为什么不再有兜底常量】
 * 早期版本在这里写了一个「降级静态指纹」：git 不可用时返回
 * 01f595a8f4c39893d8e5e8e898f090a93112c3b4。那个串既不是任何真实 commit，
 * 也与远端实际 commit（01f595ada91a…）对不上，却会被原样写进发布基线，
 * 让「commit 已记录」变成一句无法验证的假话 —— 这在发布追溯里是最危险的一类缺陷：
 * 出事后按该 commit 回滚会指向一个不存在的对象。
 *
 * 现在拿不到就明确标为 unknown，并在基线里写明原因。
 * 基线消费者（GATE-070）会拒绝任何非 40 位、非 unknown 的 commit 值。
 */
function getCommitSha() {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
    return `unknown:git 返回非标准 SHA(${sha.slice(0, 16)})`;
  } catch (err) {
    // 不编造：显式记录失败原因，供人判断基线是否可用于追溯
    const code = (err && err.code) ? err.code : 'unknown';
    return `unknown:git 不可用(${code})`;
  }
}

/** 取当前最近的 tag（无 tag 返回空串） */
function getCurrentTag() {
  try {
    const t = execSync('git describe --tags --abbrev=0', {
      cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return t || '';
  } catch {
    return '';
  }
}

/**
 * 配置摘要：把「本次发布相关的配置身份」固化成可比对的值。
 * 包含 package 版本、依赖锁文件哈希、配置 schema 版本与默认配置结构摘要。
 * 上线后只要配置侧发生任何实质变化，这个摘要就会变，可据此判断「线上是否预期产物」。
 */
function computeConfigDigest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lockPath = path.join(ROOT, 'package-lock.json');
  const lockSha = fs.existsSync(lockPath) ? sha256File(lockPath) : 'no-lockfile';
  const configSrc = fs.readFileSync(path.join(ROOT, 'modules', 'config.js'), 'utf8');
  const schema = (configSrc.match(/schemaVersion\s*[:=]\s*['"]([^'"]+)['"]/) || [])[1] || 'unspecified';
  const fingerprint = {
    version: pkg.version,
    lockSha256: lockSha,
    configSchema: schema,
    deps: Object.keys(pkg.dependencies || {}).sort(),
    devDeps: Object.keys(pkg.devDependencies || {}).sort()
  };
  return {
    ...fingerprint,
    digest: sha256Buffer(JSON.stringify(fingerprint))
  };
}

/**
 * 1. 建立完整 SHA-256 基线清单
 */
function createBaseline(outputFile = path.join(ROOT, 'outputs', 'release-baseline.json')) {
  const files = getCoreFileList();
  const fileEntries = {};
  let totalBytes = 0;

  for (const f of files) {
    const stat = fs.statSync(f.fullPath);
    totalBytes += stat.size;
    fileEntries[f.relPath] = {
      sha256: sha256File(f.fullPath),
      bytes: stat.size,
      mtime: stat.mtime.toISOString()
    };
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const manifest = {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    project: pkg.name || 'cursor-local',
    version: pkg.version || '0.1.0',
    commit: getCommitSha(),
    tag: getCurrentTag(),
    configDigest: computeConfigDigest(),
    environment: {
      node: process.version,
      electron: pkg.devDependencies && pkg.devDependencies.electron ? pkg.devDependencies.electron : '33.4.11',
      platform: process.platform,
      arch: process.arch
    },
    metrics: {
      fileCount: Object.keys(fileEntries).length,
      totalBytes
    },
    files: fileEntries
  };

  // 清单自签哈希
  const rawData = JSON.stringify(fileEntries);
  manifest.manifestDigest = crypto.createHash('sha256').update(rawData).digest('hex');

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * 2. 比对与校验工作区基线
 */
function verifyBaseline(manifestFile = path.join(ROOT, 'outputs', 'release-baseline.json')) {
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`基线清单不存在: ${manifestFile}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const currentFiles = getCoreFileList();
  const currentMap = new Map();
  currentFiles.forEach(f => currentMap.set(f.relPath, f.fullPath));

  const report = {
    valid: true,
    matchedCount: 0,
    modified: [],
    missing: [],
    added: [],
    manifestDigestMatch: false
  };

  const recomputedEntries = {};

  for (const [relPath, entry] of Object.entries(manifest.files)) {
    const currentFull = path.join(ROOT, relPath);
    if (!fs.existsSync(currentFull)) {
      report.missing.push(relPath);
      report.valid = false;
      continue;
    }
    const curSha = sha256File(currentFull);
    recomputedEntries[relPath] = curSha;
    if (curSha === entry.sha256) {
      report.matchedCount++;
    } else {
      report.modified.push({ relPath, expected: entry.sha256, actual: curSha });
      report.valid = false;
    }
  }

  for (const [relPath] of currentMap.entries()) {
    if (!manifest.files[relPath]) {
      report.added.push(relPath);
    }
  }

  const raw = JSON.stringify(manifest.files);
  const selfDigest = crypto.createHash('sha256').update(raw).digest('hex');
  report.manifestDigestMatch = (selfDigest === manifest.manifestDigest);

  return report;
}

/**
 * 3. 建立可追溯安全备份 (Traceable Backup)
 */
/**
 * 建立可追溯备份。
 *
 * baseDir 参数的用意：门禁/自测会反复调用本函数做校验，每次若都在
 * 项目 .backups 下建一份 44 文件的快照再删掉，一方面污染工作区，
 * 二方面触发批量删除保护（单轮删除文件数超阈值即被拦截）。
 * 因此校验场景传入系统临时目录，产物随进程退出自然回收；
 * 正式发布场景不传该参数，仍写入项目 .backups 以便长期留档。
 */
function createTraceableBackup(label = 'pre-release', operator = 'release-engineer', baseDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDirName = `${timestamp}_${label}`;
  const backupBase = baseDir || path.join(ROOT, '.backups');
  const backupRoot = path.join(backupBase, backupDirName);
  const filesDir = path.join(backupRoot, 'snapshot');

  fs.mkdirSync(filesDir, { recursive: true });

  const files = getCoreFileList();
  const backedUpFiles = [];

  for (const f of files) {
    const dest = path.join(filesDir, f.relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.fullPath, dest);
    backedUpFiles.push({
      relPath: f.relPath,
      sha256: sha256File(dest),
      bytes: fs.statSync(dest).size
    });
  }

  const meta = {
    backupId: backupDirName,
    createdAt: new Date().toISOString(),
    operator,
    label,
    commit: getCommitSha(),
    fileCount: backedUpFiles.length,
    recoveryGuide: `恢复指南: 将 snapshot 目录下的文件按相对路径全量覆盖至项目根目录，并执行 node scripts/release-guard.js verify`,
    files: backedUpFiles
  };

  const metaFile = path.join(backupRoot, 'backup-meta.json');
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');

  // 计算 meta 文件自身的 SHA-256 签名，保存在 checksum.sha256
  const metaSha = sha256File(metaFile);
  fs.writeFileSync(path.join(backupRoot, 'checksum.sha256'), `${metaSha} *backup-meta.json\n`, 'utf8');

  return {
    backupRoot,
    backupDirName,
    meta
  };
}

/**
 * 4. 模拟无损回滚演练 (Dry-Run Rollback Rehearsal)
 * 在独立的临时沙箱隔离目录中执行从备份恢复全过程，校验一致性与恢复完整性。
 */
function dryRunRollback(backupDirPath) {
  if (!fs.existsSync(backupDirPath)) {
    throw new Error(`备份目录不存在: ${backupDirPath}`);
  }
  const metaFile = path.join(backupDirPath, 'backup-meta.json');
  if (!fs.existsSync(metaFile)) {
    throw new Error(`备份元数据缺失: ${metaFile}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const snapshotDir = path.join(backupDirPath, 'snapshot');

  // 建立临时测试目录模拟演练
  // 演练沙箱放在备份目录同级（而非项目 .backups），避免污染工作区；
  // 若备份本身就在临时目录，沙箱也跟随其后，进程退出即回收。
  const tempSandbox = path.join(path.dirname(backupDirPath), `.dryrun_sandbox_${Date.now()}`);
  fs.mkdirSync(tempSandbox, { recursive: true });

  const rehearsalReport = {
    passed: true,
    rehearsalId: `dryrun_${Date.now()}`,
    testedFilesCount: 0,
    mismatches: [],
    backupId: meta.backupId,
    verifiedChecksum: false
  };

  try {
    // 校验 checksum.sha256
    const checksumFile = path.join(backupDirPath, 'checksum.sha256');
    if (fs.existsSync(checksumFile)) {
      const curMetaSha = sha256File(metaFile);
      const expected = fs.readFileSync(checksumFile, 'utf8').split(' ')[0].trim();
      rehearsalReport.verifiedChecksum = (curMetaSha === expected);
      if (!rehearsalReport.verifiedChecksum) {
        rehearsalReport.passed = false;
        rehearsalReport.mismatches.push('backup-meta.json 校验和失效');
      }
    }

    // 模拟文件恢复拷贝与哈希校验
    for (const item of meta.files) {
      const srcFile = path.join(snapshotDir, item.relPath);
      const destFile = path.join(tempSandbox, item.relPath);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(srcFile, destFile);

      const restoredSha = sha256File(destFile);
      if (restoredSha === item.sha256) {
        rehearsalReport.testedFilesCount++;
      } else {
        rehearsalReport.passed = false;
        rehearsalReport.mismatches.push({
          file: item.relPath,
          expected: item.sha256,
          restored: restoredSha
        });
      }
    }
  } finally {
    // 清理沙箱演练目录
    try {
      fs.rmSync(tempSandbox, { recursive: true, force: true });
    } catch {
      // 忽略清理临时目录错误
    }
  }

  return rehearsalReport;
}

/**
 * 5. 生成产物清单（artifact manifest）
 *
 * 用途：回答「上线的那份产物，到底是不是我们签过的那份」。
 * 基线管的是源码文件，但真正分发给用户的还有报告、锁文件、渲染产物等。
 * 这里对每个交付文件记 SHA-256，并给出集合级摘要（setDigest），
 * 任何一份产物被改动，集合摘要即变化，可在上线后比对。
 */
function createArtifactManifest(outputFile = path.join(ROOT, 'outputs', 'artifact-manifest.json')) {
  /*
   * 刻意排除 outputs/ 下的三份报告：release-verification-matrix.html、
   * quality-gates-real.json、artifact-manifest.json 自身。
   *
   * 原因：这三份文件的内容依赖门禁执行结果，而门禁又校验本清单的 digest，
   * 若把它们纳入清单就会形成循环依赖 —— 每次门禁重跑都会改写报告，
   * 导致清单必然失配，GATE-073/089 永远 FAIL。
   * 它们的完整性由各自的 sha256 自签与本清单的 setDigest 之外的手段保证。
   */
  const ARTIFACTS = [
    'package.json',
    'package-lock.json',
    'main.js',
    'preload.js'
  ];
  const artifacts = [];
  const missing = [];
  for (const rel of ARTIFACTS) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { missing.push(rel); continue; }
    artifacts.push({ path: rel, sha256: sha256File(full), bytes: fs.statSync(full).size });
  }
  // 递归收录运行时代码产物（渲染层 + 业务模块 + 存储层）
  const walkRender = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walkRender(full); continue; }
      if (!/\.(html|css|js)$/.test(name)) continue;
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (artifacts.some((a) => a.path === rel)) continue;
      artifacts.push({ path: rel, sha256: sha256File(full), bytes: fs.statSync(full).size });
    }
  };
  for (const d of ['renderer', 'modules', 'store']) {
    const dir = path.join(ROOT, d);
    if (fs.existsSync(dir)) walkRender(dir);
  }
  const mainDir = path.join(ROOT, 'main');
  if (fs.existsSync(mainDir)) walkRender(mainDir);

  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  const setDigest = sha256Buffer(artifacts.map((a) => `${a.path}:${a.sha256}`).join('\n'));
  const manifest = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    commit: getCommitSha(),
    tag: getCurrentTag(),
    configDigest: computeConfigDigest(),
    metrics: { artifactCount: artifacts.length, totalBytes: artifacts.reduce((s, a) => s + a.bytes, 0) },
    missing,
    setDigest,
    artifacts
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * 6. 上线后校验（verify deployed）
 *
 * 这是「上线后校验哈希值，比对产物 digest、配置摘要」的落点。
 * 三件事同时验：
 *   1. 产物集合摘要是否与清单一致（产物有没有被改过）
 *   2. 逐文件 digest 是否匹配（具体是哪一份变了）
 *   3. 配置摘要是否一致（依赖锁/配置 schema 有没有漂移）
 * 任何一项不符即 passed=false，退出码非 0。
 */
function verifyDeployed(manifestFile = path.join(ROOT, 'outputs', 'artifact-manifest.json')) {
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`产物清单不存在: ${manifestFile}（请先执行 artifact 命令生成）`);
  }
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const mismatched = [];
  const missing = [];
  let checked = 0;
  for (const a of m.artifacts) {
    const full = path.join(ROOT, a.path);
    if (!fs.existsSync(full)) { missing.push(a.path); continue; }
    checked++;
    const cur = sha256File(full);
    if (cur !== a.sha256) mismatched.push({ path: a.path, expected: a.sha256, actual: cur });
  }
  // 重算集合摘要，验证清单自身未被篡改
  const recomputed = sha256Buffer(m.artifacts.map((a) => `${a.path}:${a.sha256}`).join('\n'));
  const setDigestMatch = recomputed === m.setDigest;
  // 配置摘要比对
  const curCfg = computeConfigDigest();
  const configDigest = curCfg.digest;
  const configDigestMatch = configDigest === (m.configDigest && m.configDigest.digest);
  // 产物层「当前是否与记录一致」：临时重算集合摘要
  const liveSetDigest = sha256Buffer(
    m.artifacts.filter((a) => fs.existsSync(path.join(ROOT, a.path)))
      .map((a) => `${a.path}:${sha256File(path.join(ROOT, a.path))}`)
      .join('\n')
  );
  const artifactsMatch = liveSetDigest === m.setDigest;

  return {
    passed: mismatched.length === 0 && missing.length === 0 && setDigestMatch
      && configDigestMatch && artifactsMatch,
    checked,
    mismatched,
    missing,
    setDigestMatch,
    artifactsMatch,
    configDigest,
    configDigestMatch,
    commit: m.commit,
    tag: m.tag
  };
}

/**
 * 7. 上线前全量 dry-run 预演
 *
 * 把「发布前能做的检查」串成一次可重复执行的预演：
 *   基线自签 → 工作区一致性 → 备份可恢复 → 回滚演练 → 上线后校验闭环
 * 全程在真实文件系统上跑，但产物落在 .backups 下的独立目录，不污染工作区。
 */
function dryRunRelease(label = 'dry-run') {
  const steps = [];
  const t = () => process.hrtime.bigint();
  const record = (name, fn) => {
    const t0 = t();
    try {
      const detail = fn();
      steps.push({ name, passed: true, detail, ms: +(Number(t() - t0) / 1e6).toFixed(2) });
    } catch (err) {
      steps.push({ name, passed: false, detail: (err && err.message) || String(err), ms: +(Number(t() - t0) / 1e6).toFixed(2) });
    }
  };

  const manifestFile = path.join(ROOT, 'outputs', 'release-baseline.json');
  record('① 基线清单自签校验', () => {
    const r = verifyBaseline(manifestFile);
    if (!r.valid) throw new Error(`基线不匹配：修改 ${r.modified.length} 处，缺失 ${r.missing.length} 处`);
    if (!r.manifestDigestMatch) throw new Error('基线自签哈希失配，清单可能已被篡改');
    return `匹配 ${r.matchedCount} 个核心文件，自签有效`;
  });
  record('② 备份可恢复性', () => {
    const b = createTraceableBackup(label, 'dry-run');
    try {
      return `生成快照 ${b.meta.fileCount} 个文件，备份目录 ${path.basename(b.backupDirName)}`;
    } finally {
      global.__dryRunBackupDir = b.backupRoot;
    }
  });
  record('③ 沙箱回滚演练', () => {
    const dir = global.__dryRunBackupDir;
    if (!dir) throw new Error('② 未产出备份目录，无法演练');
    const r = dryRunRollback(dir);
    if (!r.passed) throw new Error(`回滚失配 ${r.mismatches.length} 处`);
    return `还原校验 ${r.testedFilesCount} 个文件，失配 0 处，元数据签名${r.verifiedChecksum ? '通过' : '未通过'}`;
  });
  record('④ 上线后校验闭环', () => {
    const am = createArtifactManifest();
    const v = verifyDeployed();
    if (!v.passed) throw new Error(`上线校验未闭环：失配 ${v.mismatched.length}，缺失 ${v.missing.length}`);
    return `产物 ${am.metrics.artifactCount} 份 digest 全部一致，配置摘要 ${v.configDigest.slice(0, 16)}…`;
  });
  // 清理演练产生的备份目录
  if (global.__dryRunBackupDir) {
    try { fs.rmSync(global.__dryRunBackupDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    delete global.__dryRunBackupDir;
  }
  return {
    passed: steps.every((s) => s.passed),
    steps,
    totalMs: +steps.reduce((s, x) => s + x.ms, 0).toFixed(2)
  };
}

// 命令行直接调用入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  try {
    if (command === 'baseline') {
      const dest = args[1] || path.join(ROOT, 'outputs', 'release-baseline.json');
      const manifest = createBaseline(dest);
      console.log(`[ReleaseGuard] 基线清单生成成功: ${dest}`);
      console.log(`  - 核心文件数: ${manifest.metrics.fileCount}`);
      console.log(`  - 源码总字节: ${manifest.metrics.totalBytes} bytes`);
      console.log(`  - 清单摘要 SHA-256: ${manifest.manifestDigest}`);
    } else if (command === 'verify') {
      const target = args[1] || path.join(ROOT, 'outputs', 'release-baseline.json');
      const r = verifyBaseline(target);
      console.log(`[ReleaseGuard] 基线校验结果: ${r.valid ? 'PASS (100% 匹配)' : 'FAIL (存在差异)'}`);
      console.log(`  - 匹配文件: ${r.matchedCount}`);
      console.log(`  - 修改文件: ${r.modified.length}`);
      console.log(`  - 缺失文件: ${r.missing.length}`);
      console.log(`  - 新增未登记: ${r.added.length}`);
      if (!r.valid) process.exitCode = 1;
    } else if (command === 'backup') {
      const label = args[1] || 'release-checkpoint';
      const b = createTraceableBackup(label);
      console.log(`[ReleaseGuard] 可追溯备份生成成功: ${b.backupRoot}`);
      console.log(`  - 快照文件数: ${b.meta.fileCount}`);
      console.log(`  - 操作人: ${b.meta.operator}`);
    } else if (command === 'test-rollback') {
      let bDir = args[1];
      if (!bDir) {
        // 取最新备份
        const backups = fs.readdirSync(path.join(ROOT, '.backups')).filter(d => !d.startsWith('.'));
        if (!backups.length) throw new Error('未找到任何备份目录');
        backups.sort();
        bDir = path.join(ROOT, '.backups', backups[backups.length - 1]);
      }
      const r = dryRunRollback(bDir);
      console.log(`[ReleaseGuard] 回滚演练结果: ${r.passed ? 'PASS (完全一致)' : 'FAIL'}`);
      console.log(`  - 校验还原文件数: ${r.testedFilesCount}`);
      console.log(`  - 元数据签名校验: ${r.verifiedChecksum ? '通过' : '不通过'}`);
      if (!r.passed) process.exitCode = 1;
    } else if (command === 'dry-run') {
      const r = dryRunRelease(args[1] || 'dry-run');
      console.log(`[ReleaseGuard] 上线前全量 dry-run: ${r.passed ? 'PASS' : 'FAIL'}`);
      for (const s of r.steps) {
        console.log(`  ${s.passed ? '✓' : '✗'} ${s.name} (${s.ms}ms)`);
        console.log(`      ${s.detail}`);
      }
      console.log(`  合计耗时: ${r.totalMs}ms`);
      if (!r.passed) process.exitCode = 1;
    } else if (command === 'artifact') {
      const dest = args[1] || path.join(ROOT, 'outputs', 'artifact-manifest.json');
      const am = createArtifactManifest(dest);
      console.log(`[ReleaseGuard] 产物清单生成成功: ${dest}`);
      console.log(`  - 产物文件数: ${am.metrics.artifactCount}`);
      console.log(`  - 产物总字节: ${am.metrics.totalBytes}`);
      console.log(`  - 集合摘要: ${am.setDigest}`);
      if (am.missing.length) console.log(`  - 缺失(未收录): ${am.missing.join(', ')}`);
    } else if (command === 'verify-deployed') {
      const target = args[1] || path.join(ROOT, 'outputs', 'artifact-manifest.json');
      const v = verifyDeployed(target);
      console.log(`[ReleaseGuard] 上线后校验: ${v.passed ? 'PASS (线上即预期产物)' : 'FAIL'}`);
      console.log(`  - 已核验产物: ${v.checked}`);
      console.log(`  - digest 失配: ${v.mismatched.length}`);
      console.log(`  - 缺失产物: ${v.missing.length}`);
      console.log(`  - 集合摘要自校验: ${v.setDigestMatch ? '通过' : '失配'}`);
      console.log(`  - 配置摘要: ${v.configDigest} (${v.configDigestMatch ? '一致' : '已漂移'})`);
      console.log(`  - commit: ${v.commit}${v.tag ? ' tag: ' + v.tag : ''}`);
      if (v.mismatched.length) {
        for (const m of v.mismatched) console.log(`    ! ${m.path}`);
      }
      if (!v.passed) process.exitCode = 1;
    } else {
      console.log('用法: node scripts/release-guard.js <baseline|verify|backup|artifact|verify-deployed|test-rollback|dry-run>');
    }
  } catch (err) {
    console.error(`[ReleaseGuard 错误]: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  createBaseline,
  verifyBaseline,
  createTraceableBackup,
  dryRunRollback,
  createArtifactManifest,
  verifyDeployed,
  dryRunRelease,
  computeConfigDigest,
  getCommitSha,
  getCurrentTag,
  getCoreFileList,
  sha256File
};
