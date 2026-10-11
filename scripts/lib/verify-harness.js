'use strict';
/**
 * Cursor Local - 可断言测试地基 (Verifiable Test Harness)
 *
 * 【为什么需要这个文件】
 * 原 smoke-and-gates.js 中大量门禁写成 `checkGate(idx++, cat, name, () => true)`，
 * 用「函数返回 true」冒充「检查通过」。这在发布验证里是伪造证据：
 * 门禁数量达标（89/89）但实际什么都没检查，代码一旦被破坏也无法发现。
 *
 * 本模块提供三样东西，把「返回 true 就算过」变成「必须拿到真实证据才算过」：
 *   1. evidence()  —— 证据对象。要求每条 PASS 都携带 kind（证据类型）、
 *                     detail（可读证据）、metric（可选量化指标）。
 *                     缺失证据的断言无法被记为 PASS。
 *   2. claim()     —— 声明式断言封装。对 Node 内置 assert 的薄包装，
 *                     失败时抛出携带上下文的错误，成功时返回证据对象。
 *   3. auditShell()—— 空壳审计器。扫描门禁/烟测源码，找出 `() => true`、
 *                     `=> true`、`return true` 之类的无证据桩，
 *                     防止后续新增门禁时再次混入。
 *
 * 【约定】
 *   - 门禁的 testFn 必须返回 evidence 对象，或返回真值字符串（自动包装）。
 *   - 返回 undefined / false / 空串 一律判为 FAIL。
 *   - detail 必须是该检查实际观测到的内容，禁止写 'PASSED' / 'OK' 这类无信息量短语。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

/** 项目根目录：本文件位于 <root>/scripts/lib/，故上溯两级 */
const ROOT = path.resolve(__dirname, '..', '..');

/* ------------------------------------------------------------------ *
 * 1. 证据对象
 * ------------------------------------------------------------------ */

/** 证据类型枚举：说明这条检查到底测了什么，便于报告聚合与人工复核 */
const EvidenceKind = {
  FILE_HASH: 'file-hash',            // 文件 SHA-256 比对
  STATIC_SCAN: 'static-scan',        // 源码静态扫描
  RUNTIME_CALL: 'runtime-call',      // 真实函数调用
  RUNTIME_IPC: 'runtime-ipc',        // 真实 IPC handler 调用
  METRIC: 'metric',                  // 量化指标（耗时/体积/计数）
  ARTIFACT: 'artifact',              // 产物/清单文件校验
  INVARIANT: 'invariant',            // 不变量断言（如 contextIsolation）
  FIXTURE: 'fixture'                 // 夹具/沙箱内的一致性校验
};

/* ------------------------------------------------------------------ *
 * 0. 环境能力探测
 * ------------------------------------------------------------------ */

/**
 * 探测本进程能否派生子进程。
 *
 * 背景：部分受限执行环境（如无 PTY 的托管沙箱）会拦截 spawnSync，
 * 表现为 EBUSY / EPERM / ENOENT。此时所有依赖子进程的检查
 * （git 调用、命令执行、进程清理）都无法真实运行。
 *
 * 为什么要显式探测：
 *   不能因为跑不了就写 `return true` 假装通过（那是伪造证据），
 *   也不能直接判 FAIL（那是环境问题不是代码问题）。
 *   正确做法是标记为 SKIPPED_ENV，在报告中单列，
 *   让「未验证」与「已验证通过」在数字上严格区分开。
 */
let _spawnProbe = null;
function spawnAvailable() {
  if (_spawnProbe !== null) return _spawnProbe;
  try {
    require('child_process').execFileSync(process.execPath, ['-e', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
    });
    _spawnProbe = true;
  } catch (err) {
    _spawnProbe = false;
    _spawnProbeReason = err && err.code ? err.code : String(err && err.message);
  }
  return _spawnProbe;
}
let _spawnProbeReason = '';

function spawnProbeDetail() {
  const ok = spawnAvailable();
  return ok
    ? 'child_process 可用，子进程派生能力正常'
    : `child_process 不可用（${_spawnProbeReason}），依赖子进程的检查标记为 SKIPPED_ENV`;
}

/**
 * 三态结果构造器。
 *   pass(id, evidence)   → 真实通过
 *   fail(id, reason)     → 真实失败
 *   skipped(id, reason)  → 环境受限，本轮未验证（不等于通过）
 */
const Verdict = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  SKIPPED_ENV: 'SKIPPED_ENV'
};

/**
 * 包装一个依赖子进程的检查。
 * 若环境支持 → 真实执行并返回 pass/fail；
 * 若环境受限 → 返回 SKIPPED_ENV，并在 detail 中写明受限原因，绝不冒充 PASS。
 */
function requireSpawn(inner, unavailableDetail) {
  if (!spawnAvailable()) {
    return {
      ok: true,
      skipped: true,
      reason: unavailableDetail || spawnProbeDetail()
    };
  }
  return inner();
}


/**
 * 构造一条证据。
 * @param {string} kind   EvidenceKind 之一
 * @param {*}      value  实际观测值（会做真实性校验）
 * @param {string} detail 可读的证据描述，必须包含具体观测内容
 */
function evidence(kind, value, detail) {
  if (!Object.values(EvidenceKind).includes(kind)) {
    throw new Error(`未知的证据类型: ${kind}`);
  }
  const d = String(detail == null ? '' : detail).trim();
  if (!d) {
    throw new Error(`证据类型 ${kind} 缺少 detail 描述`);
  }
  // 真实性护栏：禁止用无信息量的固定短语冒充证据
  const FORBIDDEN = new Set([
    'PASSED', 'passed', 'OK', 'ok', 'PASS', 'pass', 'true', '1',
    '测试通过', '检查通过', '门禁通过', '烟测通过'
  ]);
  if (FORBIDDEN.has(d) || d.length < 4) {
    throw new Error(`证据描述无信息量（疑似空壳）: "${d}"`);
  }
  return { kind, value, detail: d, hash: shortHash(JSON.stringify(value)) };
}

/** 证据 + 数值指标的便捷封装 */
function metric(kind, value, detail, unit) {
  const e = evidence(kind, value, detail);
  e.metric = typeof value === 'number' ? value : null;
  e.unit = unit || '';
  return e;
}

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * 2. 声明式断言
 * ------------------------------------------------------------------ */

/**
 * 执行一条检查并归一化为「证据或失败」。
 * checkFn 返回：
 *   - evidence 对象            → 通过
 *   - 非空字符串               → 包装为 EVIDENCE(RUNTIME_CALL) 证据
 *   - true                     → 抛错（防止裸 true 蒙混）
 *   - 其他 falsy / undefined   → 抛错
 */
function runCheck(checkFn, ctx) {
  let out;
  try {
    out = checkFn();
  } catch (err) {
    // 必须把 err 一并带出：调用方靠 err.code === 'ENV_NO_SPAWN'
    // 把「环境受限」与「真实失败」区分开。早期版本只返回 reason，
    // 导致所有环境受限项都被误判为 FAIL，三态统计退化成两态。
    return { ok: false, reason: `${(err && err.message) || err}`, err };
  }
  if (out && typeof out === 'object' && out.kind) {
    return { ok: true, evidence: out };
  }
  if (out === true) {
    return { ok: false, reason: '检查函数返回裸 true，未提供任何证据（空壳门禁）' };
  }
  if (typeof out === 'string' && out.trim()) {
    return {
      ok: true,
      evidence: evidence(EvidenceKind.RUNTIME_CALL, out, out)
    };
  }
  return { ok: false, reason: `检查未通过，返回值: ${JSON.stringify(out)}` };
}

/** 断言前置条件，失败信息带上可读上下文 */
function must(cond, message) {
  assert.ok(cond, message);
}

/** 断言相等 */
function eq(actual, expected, message) {
  assert.strictEqual(actual, expected, message);
}

/* ------------------------------------------------------------------ *
 * 3. 隔离沙箱（真实落盘，禁止污染仓库）
 * ------------------------------------------------------------------ */

const SANDBOX_ROOT = path.join(os.tmpdir(), 'cursor-local-verify');

/** 沙箱登记表：统一在进程退出时回收，避免逐个注册 exit 监听器 */
const SANDBOX_CLEANUP = { registered: false, dirs: new Set() };

/**
 * 建立一次性隔离沙箱目录。返回一个对象：
 *   dir      沙箱根目录
 *   file(p)  沙箱内绝对路径
 *   cleanup  递归清理
 * 沙箱在进程退出时自动清理，异常中断也不会污染工作区。
 */
function sandbox(prefix = 'case') {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SANDBOX_ROOT, prefix + '-'));
  /*
   * 门禁一次运行会建几十个沙箱，每个都 process.once('exit') 会触发
   * MaxListenersExceededWarning 噪声，淹没真实告警。
   * 这里改为在模块加载时一次性提高监听上限，并在退出时统一清理所有沙箱。
   */
  if (!SANDBOX_CLEANUP.registered) {
    process.setMaxListeners(0);
    SANDBOX_CLEANUP.dirs = new Set();
    process.once('exit', () => {
      for (const d of SANDBOX_CLEANUP.dirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
      }
    });
    SANDBOX_CLEANUP.registered = true;
  }
  SANDBOX_CLEANUP.dirs.add(dir);
  return {
    dir,
    file: (...p) => path.join(dir, ...p),
    cleanup() {
      SANDBOX_CLEANUP.dirs.delete(dir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  };
}


/** 创建真实 git 仓库沙箱（用于 git 模块的真实调用断言） */
function gitSandbox(prefix = 'git') {
  const box = sandbox(prefix);
  const { execFileSync } = require('child_process');
  const run = (args) => execFileSync('git', args, {
    cwd: box.dir, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8'
  });
  run(['init', '-q']);
  run(['config', 'user.email', 'verify@example.com']);
  run(['config', 'user.name', 'Verify']);
  return { ...box, git: run };
}

/**
 * 当环境不支持子进程时，直接抛出带说明的错误。
 * 供门禁使用：明确区分「代码缺陷」与「环境受限」。
 */
function assertSpawnAvailable(contextLabel) {
  if (!spawnAvailable()) {
    const err = new Error(
      `${contextLabel} 需要子进程能力，但当前环境 ${_spawnProbeReason}`
    );
    err.code = 'ENV_NO_SPAWN';
    err.skippable = true;
    throw err;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 4. 源码扫描工具
 * ------------------------------------------------------------------ */

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 递归收集代码文件 */
function walkCode(dir, acc = []) {
  let out = acc;
  const full = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const name of fs.readdirSync(full)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(full, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out = walkCode(p, out);
    else if (/\.(js|json|html|css)$/.test(name)) out.push(p);
  }
  return out;
}

/** 统计源码中某个模式的命中数 */
function countMatches(rel, re) {
  const src = readSrc(rel);
  const m = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  return m ? m.length : 0;
}

/** 提取全部 ipcMain.handle 通道名 */
function ipcChannels() {
  const found = new Set();
  for (const f of walkCode('modules').concat([path.join(ROOT, 'main.js')])) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    const re = /ipcMain\.handle\('([^']+)'/g;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  return [...found].sort();
}

/** 提取 preload.js 暴露的全部 contextBridge 方法名 */
function preloadApiKeys() {
  const src = readSrc('preload.js');
  const keys = new Set();
  let m;
  const re = /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return [...keys].sort();
}

/* ------------------------------------------------------------------ *
 * 5. 空壳审计器
 * ------------------------------------------------------------------ */

/**
 * 扫描门禁/烟测脚本源码，找出无证据桩。
 * 检测模式：
 *   () => true                 匿名函数直接返回 true
 *   () => {}                   空函数体
 *   return true;               裸返回 true
 *
 * 关键：必须先剥离注释再扫描。
 * 门禁文件的头部注释里往往要引用旧写法（如「原来用 checkGate(..., () => true) 计数」）
 * 作为反例说明，这些文本不是可执行代码。若不剥离注释，
 * 真正的空壳会被这类文档文本淹没，审计器就会失去意义。
 * 因此这里逐行剔除 // 与块注释内容后再做模式匹配。
 */
function auditShell(rel) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  // 先剥离块注释（跨行），再逐行剥离行注释
  const noBlock = [];
  let inBlock = false;
  for (const line of raw) {
    let t = line;
    if (inBlock) {
      const end = t.indexOf('*/');
      if (end === -1) { noBlock.push(''); continue; }
      t = t.slice(end + 2);
      inBlock = false;
    }
    const start = t.indexOf('/*');
    if (start !== -1 && t.indexOf('*/', start) === -1) {
      t = t.slice(0, start);
      inBlock = true;
    } else if (start !== -1) {
      t = t.slice(0, start) + t.slice(t.indexOf('*/', start) + 2);
    }
    // 剥离行注释（注意不要误伤 URL 中的 //）
    const ci = t.indexOf('//');
    if (ci !== -1 && (ci === 0 || !/[:'"`]/.test(t[ci - 1]))) t = t.slice(0, ci);
    noBlock.push(t);
  }

  const samples = [];
  let count = 0;
  noBlock.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const isShell =
      /\(\s*\)\s*=>\s*true\s*[;,)]/.test(t) ||
      /\(\s*\)\s*=>\s*\{\s*\}/.test(t) ||
      /^return true;\s*$/.test(t);
    if (isShell) {
      count++;
      if (samples.length < 20) samples.push(`${i + 1}: ${t}`);
    }
  });
  return { shellLines: count, samples };
}

/**
 * 强制审计门禁结果：任何一条 PASS 但没有证据 kind 的，直接判失败。
 * 这是最后一道闸，防止有人手工拼装结果 JSON。
 * 同时统计 SKIPPED_ENV 条目——「未验证」必须在报告中单列，不可混入通过数。
 */
function assertAllHaveEvidence(result, label) {
  const items = result.items || [];
  const missing = items.filter(
    (x) => x.status === 'PASS' && !x.evidence
  );
  if (missing.length) {
    const ids = missing.map((x) => x.id).join(', ');
    throw new Error(
      `${label} 有 ${missing.length} 条 PASS 缺少证据（疑似伪造）: ${ids}`
    );
  }
  return true;
}

/**
 * 汇总三态结果。
 * 返回 { total, passed, failed, skippedEnv, effectiveRate }
 * effectiveRate = passed / (passed + failed)，分母不含 SKIPPED_ENV，
 * 即「在可验证范围内」的通过率，不拿环境受限项充数。
 */
function summarize(items) {
  const passed = items.filter((x) => x.status === 'PASS').length;
  const failed = items.filter((x) => x.status === 'FAIL').length;
  const skippedEnv = items.filter((x) => x.status === 'SKIPPED_ENV').length;
  const verifiable = passed + failed;
  return {
    total: items.length,
    passed,
    failed,
    skippedEnv,
    effectiveRate: verifiable ? +(passed / verifiable * 100).toFixed(2) : 0
  };
}

module.exports = {
  EvidenceKind,
  Verdict,
  evidence,
  metric,
  runCheck,
  must,
  eq,
  sandbox,
  gitSandbox,
  assertSpawnAvailable,
  spawnAvailable,
  spawnProbeDetail,
  requireSpawn,
  walkCode,
  readSrc,
  countMatches,
  ipcChannels,
  preloadApiKeys,
  auditShell,
  assertAllHaveEvidence,
  summarize,
  ROOT,
  SANDBOX_ROOT
};
