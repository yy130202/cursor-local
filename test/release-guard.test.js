'use strict';
/**
 * ReleaseGuard 发布防护引擎单元测试
 * 覆盖：
 *   1. createBaseline: 生成 44 个核心文件 SHA-256 清单及元数据
 *   2. verifyBaseline: 验证当前文件与清单的一致性比对能力
 *   3. createTraceableBackup: 生成可追溯代码快照与防篡改校验码
 *   4. dryRunRollback: 在隔离临时沙箱中演练无损回滚并逐字节比对
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createBaseline,
  verifyBaseline,
  createTraceableBackup,
  dryRunRollback
} = require('../scripts/release-guard');

test('release-guard: createBaseline 生成规范基线清单', async () => {
  const tmpOut = path.join(os.tmpdir(), `test-baseline-${Date.now()}.json`);
  try {
    const manifest = createBaseline(tmpOut);
    assert.ok(manifest, 'manifest 应成功生成');
    assert.equal(typeof manifest.version, 'string');
    assert.equal(typeof manifest.generatedAt, 'string');
    assert.equal(typeof manifest.manifestDigest, 'string');
    assert.equal(manifest.manifestDigest.length, 64, 'SHA-256 应为 64 位十六进制');
    assert.ok(manifest.metrics.fileCount >= 40, '核心文件数应不少于 40');
    assert.ok(manifest.metrics.totalBytes > 100000, '总字节数应大于 100KB');
    assert.ok(manifest.files['main.js'], '应包含 main.js');
    assert.ok(manifest.files['package.json'], '应包含 package.json');
    assert.equal(manifest.files['package.json'].sha256.length, 64);
  } finally {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
});

test('release-guard: verifyBaseline 正向匹配与篡改检出能力', async () => {
  const tmpOut = path.join(os.tmpdir(), `test-verify-${Date.now()}.json`);
  try {
    createBaseline(tmpOut);
    const verifyRes = verifyBaseline(tmpOut);
    assert.equal(verifyRes.valid, true, '原装清单比对必须 100% 通过');
    assert.equal(verifyRes.modified.length, 0);
    assert.equal(verifyRes.missing.length, 0);

    // 模拟篡改清单中的哈希
    const manifest = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
    manifest.files['package.json'].sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
    fs.writeFileSync(tmpOut, JSON.stringify(manifest));

    const tamperedRes = verifyBaseline(tmpOut);
    assert.equal(tamperedRes.valid, false, '检测到哈希不符必须判定失败');
    assert.ok(tamperedRes.modified.some(m => m.relPath === 'package.json'), '应明确指出 package.json 被修改');
  } finally {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
});

test('release-guard: createTraceableBackup 快照完整性与元数据防伪', async () => {
  const label = `unit-test-${Date.now()}`;
  const res = createTraceableBackup(label, 'unit-tester');
  const backupDir = res.backupRoot;
  try {
    assert.ok(fs.existsSync(backupDir), '备份目录应成功建立');
    const metaPath = path.join(backupDir, 'backup-meta.json');
    const chkPath = path.join(backupDir, 'checksum.sha256');
    assert.ok(fs.existsSync(metaPath), '应包含 backup-meta.json');
    assert.ok(fs.existsSync(chkPath), '应包含 checksum.sha256');

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.operator, 'unit-tester');
    assert.equal(meta.label, label);
    assert.ok(meta.fileCount >= 40);

    const chkContent = fs.readFileSync(chkPath, 'utf8');
    assert.ok(chkContent.includes('backup-meta.json'));
  } finally {
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }
});

test('release-guard: dryRunRollback 演练沙箱原子恢复验证', async () => {
  const label = `dryrun-test-${Date.now()}`;
  const backupInfo = createTraceableBackup(label, 'dryrun-tester');
  const backupDir = backupInfo.backupRoot;
  try {
    const res = dryRunRollback(backupDir);
    assert.equal(res.passed, true, '沙箱回滚校验应通过');
    assert.equal(res.mismatches.length, 0);
    assert.ok(res.testedFilesCount >= 40);
  } finally {
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }
});
