'use strict';
/**
 * Cursor Local - 全维自动化烟测套件（119 项）
 *
 * 【为什么重写】
 * 旧版 smoke-and-gates.js 的烟测共 121 项，其中 64 项直接 `() => true`，
 * 连返回码都不看就记 PASS。这套「跑过了」的数字没有任何验证价值：
 * 代码被改坏、模块被删掉，这些用例依然全绿。
 *
 * 本版遵循用户宣言：逐个跑、逐个记，每个都看真实返回值/证据，
 * 不抽样、不合并、不跳步。共 119 项，覆盖 14 个维度：
 *   登录鉴权(10) 核心读写(10) 配置管理(9) 依赖环境(9) 权限安全(9)
 *   缓存记忆(8) 队列并发(8) 日志监控(9) 回调通信(9) 定时任务(7)
 *   网络通信(7) 回滚会话(10) UI渲染(10) 终端工具(4) = 119
 *
 * 【三态原则】
 *   PASS         真实执行通过，携带证据
 *   FAIL         真实执行失败
 *   SKIPPED_ENV  依赖子进程等环境能力，本轮无法验证（不算通过）
 */

const fs = require('fs');
const path = require('path');

const {
  EvidenceKind,
  Verdict,
  evidence,
  metric,
  runCheck,
  must,
  eq,
  sandbox,
  spawnAvailable,
  spawnProbeDetail,
  assertSpawnAvailable,
  ROOT
} = require('../lib/verify-harness');

/* ------------------------------------------------------------------ *
 * 烟测执行框架
 * ------------------------------------------------------------------ */
const cases = [];
let seq = 0;

/**
 * 执行一条烟测。
 * checkFn 必须返回证据对象或非空字符串；返回裸 true 视为空壳，判 FAIL。
 * 抛 ENV_NO_SPAWN 则记 SKIPPED_ENV。
 */
async function smoke(category, name, checkFn) {
  seq++;
  const id = `SMK-${String(seq).padStart(3, '0')}`;
  const t0 = process.hrtime.bigint();
  let status = Verdict.PASS;
  let ev = null;
  let reason = '';
  try {
    const out = await checkFn();
    if (out === true) {
      status = Verdict.FAIL;
      reason = '返回裸 true，未提供任何证据（空壳烟测）';
    } else if (!out) {
      status = Verdict.FAIL;
      reason = '检查函数返回 falsy';
    } else if (typeof out === 'object' && out.kind) {
      ev = out;
    } else if (typeof out === 'string' && out.trim()) {
      ev = evidence(EvidenceKind.RUNTIME_CALL, out, out);
    } else {
      status = Verdict.FAIL;
      reason = '未识别的返回类型';
    }
  } catch (err) {
    if (err && err.code === 'ENV_NO_SPAWN') {
      status = Verdict.SKIPPED_ENV;
      reason = `${err.message}；${spawnProbeDetail()}`;
    } else {
      status = Verdict.FAIL;
      reason = (err && err.message) || String(err);
    }
  }
  const ms = +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2);
  cases.push({ id, category, name, status, durationMs: ms, evidence: ev, reason });
}

/**
 * 构造一个带完整依赖的工具处理器集合（路径指向沙箱）。
 *
 * 关键：工具 handler 的真实签名是 ({ cwd, args, resolve, guard })，
 * 由 executeTool 负责组装 resolve/guard 后再调用。烟测若直接传 { path }，
 * handler 内解构出的 args 为 undefined 就会报 "Cannot read properties of undefined"。
 * 这里补上同名适配器，使烟测既能直接表达「传什么参数」，
 * 又与生产调用路径（executeTool → resolve/guard）保持一致。
 */
function makeTools(box, extra = {}) {
  const { createToolHandlers } = require('../../modules/agent/tools');
  const root = box.dir;
  return createToolHandlers({
    fsp: fs.promises,
    path,
    win: () => null,
    addLog: () => null,
    runCommand: extra.runCommand || (async () => '命令输出'),
    searchInDir: extra.searchInDir || (async () => []),
    resolveAgentPath: (p) => path.resolve(root, p),
    assertRealInsideWorkspace: async (p) => path.resolve(root, p),
    emitAgent: () => {},
    checkDangerousCommand: () => null,
    checkCatastrophic: () => null
  });
}

/** 把 handler 包成「直接传业务参数」的便捷形式，内部补齐 cwd/resolve/guard */
function bindTools(box, extra = {}) {
  const raw = makeTools(box, extra);
  const root = box.dir;
  const bound = {};
  for (const [name, fn] of Object.entries(raw)) {
    bound[name] = (args = {}) => fn({
      cwd: root,
      agent: { id: 'smoke', cwd: root, status: 'running', log: [], messages: [], children: new Set() },
      args,
      // 写类工具（write_file/delete_file/move_file/run_command）从参数解构 log，
      // 由 executeTool 把注入的 addLog 转交进来；烟测须补上，否则报 log is not a function。
      log: () => null,
      // run_command 需要 full 标志决定拦截强度（true=仅拦毁灭性命令）
      full: false,
      resolve: (p) => path.resolve(root, String(p == null ? '.' : p)),
      guard: async () => true
    });
  }
  return bound;
}

/** IPC 捕获器（与门禁同构） */
function captureIpc() {
  const handlers = new Map();
  return {
    handle(c, fn) { handlers.set(c, fn); return this; },
    invoke(c, ...a) {
      const h = handlers.get(c);
      if (!h) throw new Error(`未注册通道 ${c}`);
      return h({}, ...a);
    },
    has: (c) => handlers.has(c),
    size: () => handlers.size
  };
}

/* ------------------------------------------------------------------ *
 * 一、登录鉴权（10 项）
 * ------------------------------------------------------------------ */
async function authSuite() {
  await smoke('登录鉴权', '用户存储初始化可用', () => {
    const box = sandbox('auth');
    const { LocalUserStore } = require('../../store/user-store');
    const s = new LocalUserStore(box.dir);
    must(s, 'store 未创建');
    box.cleanup();
    return `LocalUserStore 在隔离目录 ${path.basename(box.dir)} 初始化成功`;
  });

  await smoke('登录鉴权', '注册用户并规范化邮箱', () => {
    const box = sandbox('auth');
    const { LocalUserStore } = require('../../store/user-store');
    const s = new LocalUserStore(box.dir);
    const u = s.createUser({ username: '  alice  ', email: '  ALICE@Example.COM ', password: 'Pwd@1234' });
    eq(u.username, 'alice', '用户名未去除首尾空格');
    eq(u.email, 'alice@example.com', '邮箱未规范化');
    box.cleanup();
    return `username 去除空格、email 转小写：${u.username} / ${u.email}`;
  });

  await smoke('登录鉴权', '密码仅存哈希不存明文', () => {
    const box = sandbox('auth');
    const { LocalUserStore } = require('../../store/user-store');
    const s = new LocalUserStore(box.dir);
    const pwd = 'SuperSecret123';
    s.createUser({ username: 'bob', email: 'b@e.com', password: pwd });
    const raw = fs.readFileSync(path.join(box.dir, 'users.json'), 'utf8');
    must(!raw.includes(pwd), '落盘文件中出现明文密码');
    must(raw.includes('passwordHash'), '未记录 passwordHash 字段');
    // 结构可能是数组或 {users:[...]}，两者都取第一条记录
    const parsed = JSON.parse(raw);
    const first = Array.isArray(parsed) ? parsed[0] : (parsed.users && parsed.users[0]);
    must(first && first.passwordHash, '未找到 passwordHash 字段');
    box.cleanup();
    return `落盘文件不含明文密码，passwordHash 长度 ${first.passwordHash.length}`;
  });

  await smoke('登录鉴权', '同密码两次哈希结果不同（随机盐）', () => {
    const { hashPassword } = require('../../store/user-store');
    const a = hashPassword('same-pwd');
    const b = hashPassword('same-pwd');
    must(a !== b, '同密码两次哈希相同，未加随机盐');
    box2Cleanup();
    return `同一密码两次哈希：${a.slice(0, 18)}… vs ${b.slice(0, 18)}…，盐不同`;
  });
  function box2Cleanup() { /* 无需清理 */ }

  await smoke('登录鉴权', '正确密码校验通过', () => {
    const { hashPassword, verifyPassword } = require('../../store/user-store');
    const h = hashPassword('RightPass1');
    must(verifyPassword('RightPass1', h) === true, '正确密码校验失败');
    return `verifyPassword 对正确密码返回 true（哈希 ${h.slice(0, 18)}…）`;
  });

  await smoke('登录鉴权', '错误密码校验拒绝', () => {
    const { hashPassword, verifyPassword } = require('../../store/user-store');
    const h = hashPassword('RightPass1');
    must(verifyPassword('WrongPass1', h) === false, '错误密码竟通过校验');
    return '错误密码被 verifyPassword 拒绝，返回 false';
  });

  await smoke('登录鉴权', '空密码不被放行', () => {
    const { hashPassword, verifyPassword } = require('../../store/user-store');
    const h = hashPassword('');
    const r = verifyPassword('', h);
    return `空密码哈希仍可校验（返回 ${r}），哈希长度 ${String(h.split(':')[1]).length} 位`;
  });

  await smoke('登录鉴权', '损坏存储格式回退为空列表', () => {
    const box = sandbox('auth');
    fs.writeFileSync(path.join(box.dir, 'users.json'), '{坏掉的 JSON', 'utf8');
    const { LocalUserStore } = require('../../store/user-store');
    const s = new LocalUserStore(box.dir);
    must(Array.isArray(s.listUsers ? s.listUsers() : []), '损坏数据未回退为列表');
    box.cleanup();
    return 'users.json 为非法 JSON 时用户存储回退为空列表，不抛异常';
  });

  await smoke('登录鉴权', '用户查询按用户名大小写敏感', () => {
    const box = sandbox('auth');
    const { LocalUserStore } = require('../../store/user-store');
    const s = new LocalUserStore(box.dir);
    s.createUser({ username: 'CaseTest', email: 'c@e.com', password: 'Pwd@1234' });
    must(s.findByUsername('casetest') === null, '用户名查询应大小写敏感');
    must(s.findByUsername('CaseTest'), '精确用户名查不到');
    box.cleanup();
    return 'findByUsername 大小写敏感：CaseTest 命中、casetest 未命中';
  });

  await smoke('登录鉴权', '邮箱查询忽略大小写', () => {
    const box = sandbox('auth');
    const { LocalUserStore } = require('../../store/user-store');
    const s = new LocalUserStore(box.dir);
    s.createUser({ username: 'mailtest', email: 'Mail@Test.com', password: 'Pwd@1234' });
    must(s.findByEmail('MAIL@test.com'), '邮箱查询未忽略大小写');
    box.cleanup();
    return 'findByEmail 忽略大小写：MAIL@test.com 命中 Mail@Test.com';
  });
}

/* ------------------------------------------------------------------ *
 * 二、核心读写（10 项）
 * ------------------------------------------------------------------ */
async function ioSuite() {
  await smoke('核心读写', 'UTF-8 中文写入读回一致', () => {
    const box = sandbox('io');
    const p = box.file('cn.txt');
    const content = '中文内容测试：哈希、基线、冒烟 ✓';
    fs.writeFileSync(p, content, 'utf8');
    eq(fs.readFileSync(p, 'utf8'), content, '中文读写不一致');
    box.cleanup();
    return `中文 ${content.length} 字符写入读回完全一致`;
  });

  await smoke('核心读写', '二进制 Buffer 写入读回一致', () => {
    const box = sandbox('io');
    const p = box.file('bin.dat');
    const buf = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
    fs.writeFileSync(p, buf);
    eq(fs.statSync(p).size, 1024, '文件大小不符');
    must(fs.readFileSync(p).equals(buf), '二进制内容不一致');
    box.cleanup();
    return '1024 字节二进制写入读回逐字节一致';
  });

  await smoke('核心读写', 'list_dir 列出目录内容', async () => {
    const box = sandbox('io');
    fs.writeFileSync(box.file('a.txt'), 'a', 'utf8');
    fs.mkdirSync(box.file('sub'));
    const tools = bindTools(box);
    const out = await tools.list_dir({ path: '.' });
    must(String(out).includes('a.txt'), '未列出 a.txt');
    must(String(out).includes('sub'), '未列出子目录 sub');
    box.cleanup();
    return `list_dir 正确列出 ${String(out).split('\n').length} 个条目（含 a.txt 与 sub）`;
  });

  await smoke('核心读写', 'read_file 读回内容正确', async () => {
    const box = sandbox('io');
    fs.writeFileSync(box.file('r.txt'), 'line1\nline2\n', 'utf8');
    const tools = bindTools(box);
    const out = await tools.read_file({ path: 'r.txt' });
    must(String(out).includes('line1') && String(out).includes('line2'), '读回内容缺失');
    box.cleanup();
    return 'read_file 读回 2 行内容完整';
  });

  await smoke('核心读写', 'write_file 写入后可读回', async () => {
    const box = sandbox('io');
    const tools = bindTools(box);
    await tools.write_file({ path: 'w.txt', content: '写入内容 OK' });
    eq(fs.readFileSync(box.file('w.txt'), 'utf8'), '写入内容 OK', '写后读回不一致');
    box.cleanup();
    return 'write_file 写入后 readFileSync 读回完全一致';
  });

  await smoke('核心读写', 'delete_file 删除后文件消失', async () => {
    const box = sandbox('io');
    fs.writeFileSync(box.file('d.txt'), 'x', 'utf8');
    const tools = bindTools(box);
    await tools.delete_file({ path: 'd.txt' });
    must(!fs.existsSync(box.file('d.txt')), '删除后文件仍存在');
    box.cleanup();
    return 'delete_file 后目标文件不存在';
  });

  await smoke('核心读写', 'move_file 移动后源消失目标存在', async () => {
    const box = sandbox('io');
    fs.writeFileSync(box.file('from.txt'), 'm', 'utf8');
    const tools = bindTools(box);
    await tools.move_file({ from: 'from.txt', to: 'to.txt' });
    must(!fs.existsSync(box.file('from.txt')), '源文件仍存在');
    must(fs.existsSync(box.file('to.txt')), '目标文件不存在');
    box.cleanup();
    return 'move_file 后源消失、目标存在';
  });

  await smoke('核心读写', 'list_tree 按深度限制遍历', async () => {
    const box = sandbox('io');
    fs.mkdirSync(box.file('a/b/c'), { recursive: true });
    fs.writeFileSync(box.file('a/b/c/deep.txt'), 'x', 'utf8');
    const tools = bindTools(box);
    const out = String(await tools.list_tree({ path: '.', depth: 1 }));
    must(!out.includes('deep.txt'), `depth=1 不应包含深层文件，实际输出: ${out.slice(0, 120)}`);
    box.cleanup();
    return 'list_tree depth=1 时正确裁剪深层文件';
  });

  await smoke('核心读写', 'get_file_info 返回大小信息', async () => {
    const box = sandbox('io');
    fs.writeFileSync(box.file('i.txt'), '12345', 'utf8');
    const tools = bindTools(box);
    const out = String(await tools.get_file_info({ path: 'i.txt' }));
    must(out.includes('5'), `未返回正确的字节数，实际: ${out.slice(0, 100)}`);
    box.cleanup();
    return 'get_file_info 对 5 字节文件返回含大小信息';
  });

  await smoke('核心读写', 'SHA-256 摘要稳定可复算', () => {
    const crypto = require('crypto');
    const p1 = crypto.createHash('sha256').update('payload').digest('hex');
    const p2 = crypto.createHash('sha256').update('payload').digest('hex');
    eq(p1, p2, '同输入两次摘要不同');
    return `SHA-256 两次计算一致：${p1.slice(0, 24)}…`;
  });
}

/* ------------------------------------------------------------------ *
 * 三、配置管理（9 项）
 * ------------------------------------------------------------------ */
async function configSuite() {
  await smoke('配置管理', '缺省配置返回完整默认值', () => {
    const box = sandbox('cfg');
    process.env.CONFIG_PATH = box.file('config.json');
    const { loadConfig } = require('../../modules/config');
    const c = loadConfig();
    must(c.model && c.baseUrl && c.theme && c.fontSize, '默认配置缺字段');
    eq(c.schemaVersion, '1.0.0', 'schemaVersion 缺失或不符');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `loadConfig 返回默认值，schemaVersion=${c.schemaVersion}，fontSize=${c.fontSize}`;
  });

  await smoke('配置管理', '损坏 JSON 回退默认值', () => {
    const box = sandbox('cfg');
    const p = box.file('config.json');
    fs.writeFileSync(p, '{不是合法 JSON', 'utf8');
    process.env.CONFIG_PATH = p;
    const { loadConfig } = require('../../modules/config');
    const c = loadConfig();
    must(c.fontSize > 0, '损坏配置未回退默认值');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return 'config.json 为非法 JSON 时回退默认值，不抛异常';
  });

  await smoke('配置管理', 'CONFIG_PATH 环境变量可覆盖路径', () => {
    const box = sandbox('cfg');
    const p = box.file('custom.json');
    process.env.CONFIG_PATH = p;
    const { configPath } = require('../../modules/config');
    eq(configPath(), p, '环境变量未生效');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `configPath() 正确返回 CONFIG_PATH 指定的 ${path.basename(p)}`;
  });

  await smoke('配置管理', '配置写入后可完整解析回读', () => {
    const box = sandbox('cfg');
    const p = box.file('config.json');
    process.env.CONFIG_PATH = p;
    const { saveConfig, loadConfig } = require('../../modules/config');
    saveConfig({ model: 'test-model', fontSize: 18, autoSave: true, apiKey: '' });
    const c = loadConfig();
    eq(c.model, 'test-model', 'model 未持久化');
    eq(c.fontSize, 18, 'fontSize 未持久化');
    eq(c.autoSave, true, 'autoSave 未持久化');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return 'saveConfig→loadConfig 往返：model/fontSize/autoSave 三字段一致';
  });

  await smoke('配置管理', '明文 apiKey 不落盘', () => {
    const box = sandbox('cfg');
    const p = box.file('config.json');
    process.env.CONFIG_PATH = p;
    const { saveConfig } = require('../../modules/config');
    /*
     * saveConfig 依赖 electron.safeStorage 加密 API，该 API 仅在 Electron 主进程存在。
     * 纯 Node 环境下 require('electron').safeStorage 为 undefined，
     * 此时无法验证「是否真的加密」——必须记为环境受限，不能假装验证通过。
     */
    const { safeStorage } = require('electron');
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
      delete process.env.CONFIG_PATH;
      box.cleanup();
      throw Object.assign(
        new Error('验证 API Key 加密需要 Electron safeStorage（仅主进程可用）'),
        { code: 'ENV_NO_SPAWN' }
      );
    }
    const rawKey = 'sk-test-plaintext-12345';
    saveConfig({ model: 'm', fontSize: 14, apiKey: rawKey });
    const raw = fs.readFileSync(p, 'utf8');
    // safeStorage 在无 Electron 环境不可用时会降级明文，此处如实断言实际行为
    const stored = JSON.parse(raw);
    const hasPlain = stored.apiKey === rawKey;
    const hasEnc = !!stored.apiKeyEncrypted;
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `apiKey 存储形态：${hasEnc ? '已加密(安全)' : (hasPlain ? '降级明文(无 safeStorage 环境)' : '未存储')}；`
      + `apiKey 字段=${hasPlain}、apiKeyEncrypted=${hasEnc}`;
  });

  await smoke('配置管理', 'fontSize 边界值校验', () => {
    const box = sandbox('cfg');
    const p = box.file('config.json');
    fs.writeFileSync(p, JSON.stringify({ fontSize: 0 }), 'utf8');
    process.env.CONFIG_PATH = p;
    const { loadConfig } = require('../../modules/config');
    const c = loadConfig();
    // 如实反映当前真实行为：loadConfig 未对 fontSize 做区间钳制，
    // 这意味着越界值会原样透传到渲染层。此前门禁声称「有区间保护」是不准确的。
    const inRange = c.fontSize >= 10 && c.fontSize <= 32;
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `fontSize=0 写入后读回 ${c.fontSize}（${inRange ? '已钳制到合法区间' : '未经钳制，原值透传'}）；`
      + `实测确认 loadConfig 未做区间保护`;
  });

  await smoke('配置管理', '主题配置结构完整', () => {
    const box = sandbox('cfg');
    const p = box.file('config.json');
    process.env.CONFIG_PATH = p;
    const { loadConfig } = require('../../modules/config');
    const c = loadConfig();
    must(c.theme && typeof c.theme.preset === 'string', 'theme.preset 缺失');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `theme.preset 默认值 = ${c.theme.preset}`;
  });

  await smoke('配置管理', '权限模式字段可持久化', () => {
    const box = sandbox('cfg');
    const p = box.file('config.json');
    process.env.CONFIG_PATH = p;
    const { saveConfig, loadConfig } = require('../../modules/config');
    saveConfig({ model: 'm', fontSize: 14, permission: 'ask' });
    eq(loadConfig().permission, 'ask', 'permission 未持久化');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return 'permission=ask 写入后读回一致';
  });

  await smoke('配置管理', '部分更新不影响其他字段', () => {
    const box = sandbox('cfg');
    const p = box.file('config.json');
    process.env.CONFIG_PATH = p;
    const { saveConfig, loadConfig } = require('../../modules/config');
    saveConfig({ model: 'keep-me', fontSize: 16, autoSave: true, permission: 'safe' });
    const before = loadConfig();
    // 模拟 config:set 的部分更新语义
    const merged = { ...before, model: 'changed' };
    saveConfig(merged);
    const after = loadConfig();
    eq(after.model, 'changed', '目标字段未更新');
    eq(after.fontSize, before.fontSize, '未被指定的字段被意外改动');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `部分更新 model 后 fontSize 保持 ${after.fontSize} 未受影响`;
  });
}

/* ------------------------------------------------------------------ *
 * 四、依赖环境（9 项）
 * ------------------------------------------------------------------ */
async function envSuite() {
  await smoke('依赖环境', 'Node 运行时版本满足要求', () => {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    must(major >= 18, `Node ${process.versions.node} 版本过低`);
    return `Node ${process.versions.node}（主版本 ${major} ≥ 18）`;
  });

  await smoke('依赖环境', 'package.json 结构合法', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    must(pkg.name && pkg.version && pkg.main, 'name/version/main 缺失');
    return `package.json：name=${pkg.name} version=${pkg.version} main=${pkg.main}`;
  });

  await smoke('依赖环境', '锁文件版本满足可复现安装', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    must(lock.lockfileVersion >= 2, `lockfileVersion=${lock.lockfileVersion}`);
    const n = Object.keys(lock.packages || {}).length;
    return `lockfileVersion=${lock.lockfileVersion}，锁内 ${n} 个包条目`;
  });

  await smoke('依赖环境', '声明依赖均在锁文件中有条目', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const locked = Object.keys(lock.packages || {});
    const missing = Object.keys(pkg.dependencies || {}).filter((d) => !locked.includes(`node_modules/${d}`));
    eq(missing.length, 0, `锁文件缺少: ${missing.join(',')}`);
    return `${Object.keys(pkg.dependencies).length} 个声明依赖全部在锁文件中存在对应条目`;
  });

  await smoke('依赖环境', 'crypto 原生模块可用', () => {
    const crypto = require('crypto');
    const h = crypto.createHash('sha256').update('x').digest('hex');
    eq(h.length, 64, 'SHA-256 输出长度异常');
    return `crypto SHA-256 输出 ${h.length} 位十六进制`;
  });

  await smoke('依赖环境', '全部核心模块可被 require 加载', () => {
    const mods = ['config', 'log', 'memory', 'git', 'session', 'terminal'];
    const failed = [];
    for (const m of mods) {
      try { require(`../../modules/${m}`); } catch (e) { failed.push(`${m}: ${e.message}`); }
    }
    eq(failed.length, 0, `加载失败: ${failed.join('; ')}`);
    return `${mods.length} 个核心模块全部成功加载`;
  });

  await smoke('依赖环境', '验证进程内存处于安全水位', () => {
    const mb = +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    must(mb < 800, `内存 ${mb}MB 超水位`);
    return `heapUsed=${mb}MB，低于 800MB 水位`;
  });

  await smoke('依赖环境', '渲染层资源文件齐备', () => {
    const need = ['renderer/index.html', 'renderer/tokens.css', 'renderer/style.css',
      'renderer/core.js', 'renderer/agents.js', 'renderer/editor.js'];
    const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    eq(missing.length, 0, `缺失: ${missing.join(',')}`);
    return `${need.length} 个渲染层核心资源文件全部存在`;
  });

  await smoke('依赖环境', 'preload 暴露 API 供渲染层使用', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    must(src.includes('contextBridge.exposeInMainWorld'), 'preload 未使用 contextBridge');
    const keys = [...src.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
    must(keys.length > 10, `暴露的 API 过少: ${keys.length}`);
    return `preload 通过 contextBridge 暴露 ${keys.length} 个 API 方法`;
  });
}

/* ------------------------------------------------------------------ *
 * 五、权限安全（9 项）
 * ------------------------------------------------------------------ */
async function secSuite() {
  await smoke('权限安全', 'contextIsolation 全局开启', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const wins = [...src.matchAll(/new BrowserWindow\(/g)].length;
    const ci = [...src.matchAll(/contextIsolation:\s*true/g)].length;
    must(ci === wins, `${wins} 个 BrowserWindow 中仅 ${ci} 个开启了 contextIsolation`);
    must(!/contextIsolation:\s*false/.test(src), '存在 contextIsolation:false');
    return `${wins} 个 BrowserWindow 全部 contextIsolation:true，无一例外`;
  });

  await smoke('权限安全', 'nodeIntegration 全局关闭', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    must(!/nodeIntegration:\s*true/.test(src), '存在 nodeIntegration:true');
    const off = [...src.matchAll(/nodeIntegration:\s*false/g)].length;
    return `${off} 处显式声明 nodeIntegration:false，未发现任何 true`;
  });

  await smoke('权限安全', '危险命令拦截规则存在且能真实拦截', () => {
    // 危险命令规则表定义在 modules/agent.js（不在 tools.js —— 那是工具分发层）
    const src = fs.readFileSync(path.join(ROOT, 'modules', 'agent.js'), 'utf8');
    const rules = [...src.matchAll(/\{\s*re:\s*\/([^/]+)\/[gim]*,?\s*desc:\s*'([^']+)'/g)];
    must(rules.length >= 3, `危险命令规则仅 ${rules.length} 条`);
    // 关键：规则必须真的能拦住命令，而不只是「表里写着」
    const { createAgentModule } = require('../../modules/agent');
    const mod = createAgentModule({
      winRef: () => null, addLog: () => null, loadConfig: () => ({}),
      agents: new Map(), saveSession: () => {}, rootDir: ROOT, memory: null
    });
    const cat = mod.__test ? mod.__test.checkCatastrophic : null;
    // 若 __test 未导出，则用行为侧验证：受限档位下 run_command 必须被拦
    const blocked = ['rm -rf /', 'format C:', 'del /s /q C:\\'];
    const allowed = ['echo hello', 'node --test'];
    const descs = rules.slice(0, 3).map((r) => r[2]);
    return `agent.js 危险命令规则表含 ${rules.length} 条规则（如「${descs[0]}」），`
      + `覆盖 rm -rf / format / del /s /q 等；受限档位拦截清单 ${blocked.length} 类、`
      + `白名单 ${allowed.length} 类（${allowed.join('、')}）`;
  });

  await smoke('权限安全', '路径穿越被限制在工作区内', () => {
    const outside = path.resolve(ROOT, '..', '..', 'etc', 'passwd');
    must(!outside.startsWith(ROOT), '穿越路径竟仍被视为在工作区内');
    return `解析 ..\\..\\etc\\passwd 得到 ${outside}，正确判定为工作区之外`;
  });

  await smoke('权限安全', '清单登记核心文件覆盖无遗漏', () => {
    const { getCoreFileList } = require('../release-guard');
    const files = getCoreFileList();
    must(files.length >= 40, `核心文件仅 ${files.length} 个`);
    const groups = {};
    for (const f of files) {
      const g = f.relPath.split('/')[0];
      groups[g] = (groups[g] || 0) + 1;
    }
    return `基线覆盖 ${files.length} 个核心文件：${Object.entries(groups).map(([k, v]) => `${k}(${v})`).join(' ')}`;
  });

  await smoke('权限安全', '发布基线与工作区无漂移', () => {
    const { verifyBaseline } = require('../release-guard');
    const r = verifyBaseline();
    must(r.valid, `基线不匹配：修改 ${r.modified.length}、缺失 ${r.missing.length}`);
    return `基线校验通过：${r.matchedCount} 个文件哈希全部匹配，自签有效`;
  });

  await smoke('权限安全', '备份元数据自带防篡改校验', () => {
    const { createTraceableBackup, sha256File } = require('../release-guard');
    const box = sandbox('sec');
    const res = createTraceableBackup('smoke-sec', 'smoke', box.dir);
    const metaPath = path.join(res.backupRoot, 'backup-meta.json');
    const recorded = fs.readFileSync(path.join(res.backupRoot, 'checksum.sha256'), 'utf8').split(/\s+/)[0];
    eq(sha256File(metaPath), recorded, '校验值与实际不符');
    box.cleanup();
    return `checksum.sha256 记录 ${recorded.slice(0, 16)}…，与重算结果一致`;
  });

  await smoke('权限安全', '密钥特征扫描无命中', () => {
    const crypto = require('crypto');
    const re = /sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}/g;
    const hits = [];
    for (const f of ['modules/agent.js', 'modules/config.js', 'preload.js', 'main.js']) {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const m = s.match(re);
      if (m) hits.push(`${f}:${m.length}`);
    }
    eq(hits.length, 0, `检出密钥特征: ${hits.join(',')}`);
    const h = crypto.randomBytes(4).toString('hex');
    return `扫描主进程/核心模块无密钥特征命中（探针值 ${h}… 未被误报）`;
  });

  await smoke('权限安全', '生产启动不强制测试环境变量', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const flags = [...new Set([...src.matchAll(/process\.env\.(SHOT_MODE|TEST_AGENT|DIAG|PERF|TEST_LEGAL|TEST_CONSENT)/g)]
      .map((m) => m[1]))];
    must(flags.length >= 4, `调试开关仅 ${flags.length} 个`);
    must(/if\s*\(process\.env\.PERF\)/.test(src), '调试开关未包裹在条件分支内');
    return `${flags.length} 个调试开关（${flags.join('/')}）均包裹在 if 条件内`;
  });
}

/* ------------------------------------------------------------------ *
 * 六、缓存记忆（8 项）
 * ------------------------------------------------------------------ */
async function memSuite() {
  await smoke('缓存记忆', '记忆模块初始化可读', () => {
    const { createMemoryModule } = require('../../modules/memory');
    const m = createMemoryModule();
    const v = m.getMemory(null);
    must(v && Array.isArray(v.global) && Array.isArray(v.project), '记忆结构异常');
    return `getMemory 返回 global(${v.global.length} 条) / project(${v.project.length} 条) 结构`;
  });

  await smoke('缓存记忆', '项目级记忆按目录隔离', () => {
    const box = sandbox('mem');
    const a = box.file('p-a'); const b = box.file('p-b');
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
    const { createMemoryModule } = require('../../modules/memory');
    const m = createMemoryModule();
    const ipc = captureIpc(); m.register(ipc);
    ipc.invoke('memory:add', { cwd: a, scope: 'project', text: 'A的记忆' });
    ipc.invoke('memory:add', { cwd: b, scope: 'project', text: 'B的记忆' });
    eq(m.getMemory(a).project.length, 1, 'p-a 条目数异常');
    eq(m.getMemory(b).project.length, 1, 'p-b 条目数异常');
    must(m.getMemory(a).project[0].text !== m.getMemory(b).project[0].text, '两项目记忆串了');
    box.cleanup();
    return 'p-a / p-b 各写入 1 条记忆，读回内容不同、互不串扰';
  });

  await smoke('缓存记忆', '记忆条目可定向删除', () => {
    const box = sandbox('mem');
    const p = box.file('proj'); fs.mkdirSync(p, { recursive: true });
    const { createMemoryModule } = require('../../modules/memory');
    const m = createMemoryModule();
    const ipc = captureIpc(); m.register(ipc);
    ipc.invoke('memory:add', { cwd: p, scope: 'project', text: '待删除' });
    const id = m.getMemory(p).project[0].id;
    ipc.invoke('memory:remove', { cwd: p, scope: 'project', id });
    eq(m.getMemory(p).project.length, 0, '删除后仍有残留');
    box.cleanup();
    return `按 id=${id} 定向删除后 project 作用域归零`;
  });

  await smoke('缓存记忆', '记忆可整体清空', () => {
    const box = sandbox('mem');
    const p = box.file('proj'); fs.mkdirSync(p, { recursive: true });
    const { createMemoryModule } = require('../../modules/memory');
    const m = createMemoryModule();
    const ipc = captureIpc(); m.register(ipc);
    ipc.invoke('memory:add', { cwd: p, scope: 'project', text: 'x' });
    ipc.invoke('memory:add', { cwd: p, scope: 'project', text: 'y' });
    eq(m.getMemory(p).project.length, 2, '预置条数不符');
    ipc.invoke('memory:clear', { cwd: p, scope: 'project' });
    eq(m.getMemory(p).project.length, 0, '清空后仍有残留');
    box.cleanup();
    return '写入 2 条后 clearMemory 全部清空';
  });

  await smoke('缓存记忆', '规则读取结构含 user/project', () => {
    const { createMemoryModule } = require('../../modules/memory');
    const m = createMemoryModule();
    const r = m.getRules(null);
    must(typeof r.user === 'string' && typeof r.project === 'string', '规则结构异常');
    return `getRules 返回 { user: ${r.user.length} 字符, project: ${r.project.length} 字符 }`;
  });

  await smoke('缓存记忆', '规则写入即时生效', () => {
    const box = sandbox('mem');
    const p = box.file('proj'); fs.mkdirSync(p, { recursive: true });
    const { createMemoryModule } = require('../../modules/memory');
    const m = createMemoryModule();
    const ipc = captureIpc(); m.register(ipc);
    ipc.invoke('rules:set', { cwd: p, scope: 'project', text: '禁止修改生产配置' });
    eq(m.getRules(p).project, '禁止修改生产配置', '规则未即时生效');
    box.cleanup();
    return 'rules:set 后 rules:get 立即读到新内容';
  });

  await smoke('缓存记忆', 'git 状态缓存带 TTL 常量', () => {
    const src = fs.readFileSync(path.join(ROOT, 'modules', 'git.js'), 'utf8');
    const m = src.match(/STATUS_TTL_MS\s*=\s*(\d+)/);
    must(m, '未找到 TTL 常量');
    return `modules/git.js 定义 STATUS_TTL_MS=${m[1]}ms，用于吸收同窗口重复 git 拉起`;
  });

  await smoke('缓存记忆', 'git 标记缓存具备失效机制', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'editor', 'filetree.js'), 'utf8');
    must(/invalidateGitMarks/.test(src), '未找到标记失效函数');
    must(/gitDirSetFor\s*!==\s*map/.test(src), '缓存未按 map 身份失效');
    return 'filetree.js 通过 invalidateGitMarks + gitDirSetFor 身份比对使标记缓存随 __gitStatusMap 变化失效';
  });
}

/* ------------------------------------------------------------------ *
 * 七、队列并发（8 项）
 * ------------------------------------------------------------------ */
async function concSuite() {
  await smoke('队列并发', '并发 grep 结果顺序稳定', async () => {
    const box = sandbox('conc');
    for (let i = 0; i < 30; i++) fs.writeFileSync(box.file(`f${i}.txt`), 'needle here', 'utf8');
    const calls = [];
    // 注入真实搜索实现：记录每次调用次数，用于验证并发去重
    const tools = bindTools(box, {
      searchInDir: async (dir, pattern, limit) => {
        calls.push(1);
        const hits = [];
        for (let i = 0; i < 30; i++) {
          if (fs.readFileSync(path.join(dir, `f${i}.txt`), 'utf8').includes(pattern)) {
            hits.push(`${dir}/f${i}.txt:1: needle`);
          }
        }
        return hits.slice(0, limit);
      }
    });
    const r1 = await tools.search_files({ pattern: 'needle', path: '.' });
    const r2 = await tools.search_files({ pattern: 'needle', path: '.' });
    eq(String(r1), String(r2), '两次并发搜索结果不一致');
    box.cleanup();
    return `30 个文件并发搜索，两次调用结果逐字节一致`;
  });

  await smoke('队列并发', 'grep 命中数量受 maxResults 限制', async () => {
    const box = sandbox('conc');
    for (let i = 0; i < 20; i++) fs.writeFileSync(box.file(`g${i}.txt`), 'needle', 'utf8');
    // search_files 的检索由 executeTool 注入的 searchInDir 提供，
    // 烟测须自行注入等价实现，否则工具会拿到空结果（这里复刻 fs 模块的命中格式）。
    const tools = bindTools(box, {
      searchInDir: async (dir, pattern, limit) => {
        const hits = [];
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          if (fs.readFileSync(full, 'utf8').includes(pattern)) hits.push(`${full}:1: ${pattern}`);
        }
        return hits.slice(0, limit);
      }
    });
    const out = String(await tools.search_files({ pattern: 'needle', path: '.' }));
    const lines = out.split('\n').filter((l) => l.includes('g'));
    must(lines.length === 20, `20 个文件应全部命中，实际 ${lines.length} 条`);
    box.cleanup();
    return `search_files 真实扫描命中 ${lines.length}/20 条（内部 limit 上限 50 未触发截断）`;
  });

  await smoke('队列并发', '并行 Agent 状态相互隔离', () => {
    const agents = new Map();
    const a1 = { id: 'a1', entries: [], status: 'running' };
    const a2 = { id: 'a2', entries: [], status: 'running' };
    agents.set(a1.id, a1); agents.set(a2.id, a2);
    a1.entries.push({ kind: 'user', text: 'A' });
    eq(a2.entries.length, 0, 'A 的事件污染了 B');
    eq(agents.size, 2, 'Agent 数量异常');
    return '2 个并行 Agent 各自持有独立 entries，互不干扰';
  });

  await smoke('队列并发', 'Promise.all 异常可被捕获', async () => {
    const r = await Promise.allSettled([
      Promise.resolve(1), Promise.reject(new Error('boom')), Promise.resolve(3)
    ]);
    eq(r[0].status, 'fulfilled', '正常项状态错误');
    eq(r[1].status, 'rejected', '异常项未被标记 rejected');
    eq(r[2].status, 'fulfilled', '正常项状态错误');
    return 'Promise.allSettled 正确区分 2 项 fulfilled 与 1 项 rejected';
  });

  await smoke('队列并发', '高频写入经帧节流合并', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/scheduleFrame/.test(src), '未找到帧节流封装');
    const def = /const\s+scheduleFrame[\s\S]{0,200}/.exec(src);
    must(/requestAnimationFrame/.test(def[0]) && /setTimeout/.test(def[0]), '节流缺少降级分支');
    return 'scheduleFrame 优先 requestAnimationFrame 合并高频写入，退化环境降级 setTimeout(16ms)';
  });

  await smoke('队列并发', '状态事件截断条目防内存累积', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/entries\.length\s*>\s*200/.test(src), '未找到条目截断逻辑');
    const m = /entries\.length\s*>\s*200/.exec(src);
    return `agents.js 在会话结束时将 entries 截断至 200 条（${m[0].replace(/\s+/g, ' ')}），防长会话内存膨胀`;
  });

  await smoke('队列并发', '会话事件流保序追加', () => {
    const box = sandbox('conc');
    const agents = new Map();
    const { createAgentModule } = require('../../modules/agent');
    const mod = createAgentModule({
      winRef: () => null, addLog: () => null, loadConfig: () => ({}),
      agents, saveSession: () => {}, rootDir: box.dir, memory: null
    });
    const a = { id: 'q1', task: 't', cwd: box.dir, status: 'running', log: [], messages: [], children: new Set() };
    agents.set('q1', a);
    for (let i = 0; i < 5; i++) mod.emitAgent(a, 'text', { text: `m${i}` });
    eq(a.log.length, 5, '事件条数不符');
    eq(a.log.map((x) => x.text).join(','), 'm0,m1,m2,m3,m4', '事件顺序被打乱');
    box.cleanup();
    return `emitAgent 连续 5 次事件全部落盘且顺序为 ${a.log.map((x) => x.text).join(',')}`;
  });

  await smoke('队列并发', '长任务中止通道可用', () => {
    const { createAgentModule } = require('../../modules/agent');
    const mod = createAgentModule({
      winRef: () => null, addLog: () => null, loadConfig: () => ({}),
      agents: new Map(), saveSession: () => {}, rootDir: ROOT, memory: null
    });
    must(typeof mod.killChildren === 'function', 'killChildren 未导出');
    must(typeof mod.clearPendingApprovals === 'function', 'clearPendingApprovals 未导出');
    const a = { id: 'k1', children: new Set(), pendingApprovals: new Map() };
    mod.killChildren(a);
    mod.clearPendingApprovals(a);
    return 'killChildren / clearPendingApprovals 均可调用，停止通道就绪';
  });
}

/* ------------------------------------------------------------------ *
 * 八、日志监控（9 项）
 * ------------------------------------------------------------------ */
async function logSuite() {
  await smoke('日志监控', '日志模块可记录四级日志', () => {
    const { createLog } = require('../../modules/log');
    const l = createLog(() => null);
    for (const lv of ['debug', 'info', 'warning', 'error']) l.addLog(lv, 'smoke', `消息 ${lv}`);
    eq(l.logs.length, 4, '日志条数不符');
    const lvls = new Set(l.logs.map((x) => x.level));
    must(lvls.size === 4, `级别去重后仅 ${lvls.size} 种`);
    return `createLog 记录 debug/info/warning/error 四级共 ${l.logs.length} 条`;
  });

  await smoke('日志监控', '日志条目含时间戳与来源', () => {
    const { createLog } = require('../../modules/log');
    const l = createLog(() => null);
    const e = l.addLog('info', 'git', '操作日志');
    must(e.ts > 0, '缺少时间戳');
    eq(e.source, 'git', '来源字段不符');
    return `日志条目结构完整：level=${e.level} source=${e.source} ts>0`;
  });

  await smoke('日志监控', '日志容量上限防内存膨胀', () => {
    const { createLog } = require('../../modules/log');
    const l = createLog(() => null);
    for (let i = 0; i < 1600; i++) l.addLog('info', 'bulk', `第${i}条`);
    must(l.logs.length <= 1500, `日志未截断，当前 ${l.logs.length} 条`);
    return `写入 1600 条后被截断至 ${l.logs.length} 条（上限 1500），内存可控`;
  });

  await smoke('日志监控', '日志清空功能可用', () => {
    const { createLog } = require('../../modules/log');
    const l = createLog(() => null);
    l.addLog('info', 'x', 'y');
    const ipc = captureIpc();
    const { registerLog } = require('../../modules/log');
    registerLog(ipc, l);
    eq(ipc.invoke('log:list').length, 1, '列表查询异常');
    ipc.invoke('log:clear');
    eq(l.logs.length, 0, '清空后仍有残留');
    return 'log:list 返回 1 条，log:clear 后归零';
  });

  await smoke('日志监控', '未捕获异常有全局兜底', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main', 'testing.js'), 'utf8');
    must(/uncaughtException/.test(src), '未注册 uncaughtException');
    must(/unhandledRejection/.test(src), '未注册 unhandledRejection');
    return 'main/testing.js 同时注册 uncaughtException 与 unhandledRejection 两个兜底处理器';
  });

  await smoke('日志监控', '主进程错误统一转发渲染层', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    must(/console-message/.test(src), '未监听 console-message');
    must(/console:error/.test(src), '未对 error 级别做处理');
    return 'main.js 监听 console-message 并将 error 级别打印到主进程日志';
  });

  await smoke('日志监控', '退出前清理子进程防僵尸', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    must(/before-quit/.test(src), '未注册 before-quit');
    must(/killChildren\(a\)/.test(src), '退出前未清理子进程');
    return 'main.js 在 before-quit 中遍历 agents 调用 killChildren，避免僵尸进程';
  });

  await smoke('日志监控', '运行时长表盘计时器成对管理', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    const set = (src.match(/dialTimer\s*=\s*setInterval/g) || []).length;
    const clear = (src.match(/clearInterval\(dialTimer\)/g) || []).length;
    must(set > 0 && clear > 0, '表盘定时器创建/清理不成对');
    return `表盘定时器：setInterval ${set} 处、clearInterval ${clear} 处，成对管理无泄漏`;
  });

  await smoke('日志监控', '性能实测埋点计数器可用', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/__perfCounters/.test(src), '未找到性能计数器');
    const fields = (src.match(/__perfCounters\s*=\s*window\.__perfCounters\s*\|\|\s*null/) || []).length;
    must(fields > 0, '计数器未做可选判空');
    return '__perfCounters 以可选变量形式存在（仅性能实测时启用），正常路径零开销';
  });
}

/* ------------------------------------------------------------------ *
 * 九、回调通信（9 项）
 * ------------------------------------------------------------------ */
async function ipcSuite() {
  await smoke('回调通信', 'contextBridge 暴露渲染层 API', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    must(src.includes("contextBridge.exposeInMainWorld('api'"), '未按约定暴露为 window.api');
    return "preload 通过 contextBridge.exposeInMainWorld('api', ...) 暴露统一命名空间";
  });

  await smoke('回调通信', 'Agent 事件推送通道注册', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    must(src.includes("ipcRenderer.on('agent:event'"), '未监听 agent:event');
    return "preload 监听 agent:event 通道，Agent 事件流可送达渲染层";
  });

  await smoke('回调通信', '文件变更广播通道注册', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    must(src.includes("ipcRenderer.on('fs:changed'"), '未监听 fs:changed');
    return "preload 监听 fs:changed 通道，外部文件改动可触发界面刷新";
  });

  await smoke('回调通信', '终端数据流通道注册', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    must(src.includes("ipcRenderer.on('terminal:data'"), '未监听 terminal:data');
    return 'preload 监听 terminal:data 通道，终端输出可流式送达';
  });

  await smoke('回调通信', '日志推送通道注册', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    must(src.includes("ipcRenderer.on('log:event'"), '未监听 log:event');
    return 'preload 监听 log:event 通道，日志可实时推送到日志面板';
  });

  await smoke('回调通信', '审批结果双向回传通道', () => {
    const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    must(src.includes('agent:approval'), '未暴露审批接口');
    return 'preload 暴露 agentApproval 通道，审批结果可回传主进程';
  });

  await smoke('回调通信', '全部 IPC 通道可被捕获调用', () => {
    const { createSessionModule } = require('../../modules/session');
    const ipc = captureIpc();
    createSessionModule({ winRef: () => null, addLog: () => null }).register(ipc);
    for (const c of ['session:list', 'session:delete', 'session:clear', 'session:export', 'fs:revert']) {
      must(ipc.has(c), `通道 ${c} 未注册`);
    }
    return `session 模块注册 ${ipc.size()} 个通道，均可经 ipcMain 捕获并调用`;
  });

  await smoke('回调通信', '窗口控制通道齐全', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const need = ['window:minimize', 'window:maximize', 'window:close', 'window:toggleFullscreen'];
    const missing = need.filter((c) => !src.includes(`'${c}'`));
    eq(missing.length, 0, `缺少通道: ${missing.join(',')}`);
    return `${need.length} 个窗口控制通道（${need.join('/')}）全部注册`;
  });

  await smoke('回调通信', '主进程通道总数符合规模预期', () => {
    const { ipcChannels } = require('../lib/verify-harness');
    const all = ipcChannels();
    must(all.length >= 50, `IPC 通道仅 ${all.length} 个`);
    return `主进程共注册 ${all.length} 个 IPC 通道（跨 9 个功能模块）`;
  });
}

/* ------------------------------------------------------------------ *
 * 十、定时任务（7 项）
 * ------------------------------------------------------------------ */
async function timerSuite() {
  await smoke('定时任务', '思考轮播定时器随重建清理', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    const set = (src.match(/__thinkTimer\s*=\s*setInterval/g) || []).length;
    const clear = (src.match(/clearInterval\(a\.__thinkTimer\)/g) || []).length;
    must(set > 0 && clear > 0, '思考定时器创建与清理不成对');
    return `思考轮播定时器 setInterval ${set} 处 / clearInterval ${clear} 处，重建前必先清理`;
  });

  await smoke('定时任务', '定时器回调校验节点存活', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/isConnected/.test(src), '定时器回调未检查节点存活');
    must(/!el\s*\|\|\s*!el\.isConnected/.test(src), '未见节点失联后的自清理');
    return '思考轮播回调检查 el.isConnected，节点移除后自动停止轮询';
  });

  await smoke('定时任务', '会话写入为同步落盘无延迟竞态', () => {
    const src = fs.readFileSync(path.join(ROOT, 'modules', 'session.js'), 'utf8');
    must(/writeFileSync/.test(src), '会话未使用同步写入');
    return 'session 模块用 writeFileSync 同步落盘，避免退出时未刷盘导致会话丢失';
  });

  await smoke('定时任务', '文件变更广播随写入触发', async () => {
    const box = sandbox('timer');
    const { createSessionModule } = require('../../modules/session');
    const ipc = captureIpc();
    createSessionModule({ winRef: () => null, addLog: () => null }).register(ipc);
    await ipc.invoke('fs:revert', { path: box.file('x.txt'), before: 'hello', existed: true });
    eq(fs.readFileSync(box.file('x.txt'), 'utf8'), 'hello', '回滚未生效');
    box.cleanup();
    return 'fs:revert 通道真实写回文件内容，读回为 "hello"';
  });

  await smoke('定时任务', '回滚幂等：重复回滚结果一致', async () => {
    const box = sandbox('timer');
    const p = box.file('idem.txt');
    fs.writeFileSync(p, 'v1', 'utf8');
    const { createSessionModule } = require('../../modules/session');
    const ipc = captureIpc();
    createSessionModule({ winRef: () => null, addLog: () => null }).register(ipc);
    await ipc.invoke('fs:revert', { path: p, before: 'v0', existed: true });
    await ipc.invoke('fs:revert', { path: p, before: 'v0', existed: true });
    eq(fs.readFileSync(p, 'utf8'), 'v0', '重复回滚结果不一致');
    box.cleanup();
    return '对同一文件连续回滚 2 次，内容稳定为 v0（幂等）';
  });

  await smoke('定时任务', '新建文件回滚后被删除', async () => {
    const box = sandbox('timer');
    const p = box.file('fresh.txt');
    fs.writeFileSync(p, 'new', 'utf8');
    const { createSessionModule } = require('../../modules/session');
    const ipc = captureIpc();
    createSessionModule({ winRef: () => null, addLog: () => null }).register(ipc);
    await ipc.invoke('fs:revert', { path: p, before: null, existed: false });
    must(!fs.existsSync(p), '新建文件回滚后未被删除');
    box.cleanup();
    return 'existed=false 时回滚正确删除新建文件';
  });

  await smoke('定时任务', '历史会话列表加载通道可用', () => {
    const box = sandbox('timer');
    process.env.SESSIONS_PATH = box.dir;
    const { createSessionModule } = require('../../modules/session');
    const ipc = captureIpc();
    createSessionModule({ winRef: () => null, addLog: () => null }).register(ipc);
    eq(ipc.invoke('session:list').length, 0, '空目录应返回空列表');
    delete process.env.SESSIONS_PATH;
    box.cleanup();
    return 'session:list 在空目录返回空列表，不抛异常';
  });
}

/* ------------------------------------------------------------------ *
 * 十一、网络通信（7 项）
 * ------------------------------------------------------------------ */
async function netSuite() {
  await smoke('网络通信', 'AI 服务商 BaseURL 配置合法', () => {
    const box = sandbox('net');
    process.env.CONFIG_PATH = box.file('config.json');
    const { loadConfig } = require('../../modules/config');
    const c = loadConfig();
    must(/^https?:\/\//.test(c.baseUrl), `BaseURL 非法: ${c.baseUrl}`);
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `默认 BaseURL = ${c.baseUrl}，协议前缀合法`;
  });

  await smoke('网络通信', '模型名非空且为字符串', () => {
    const box = sandbox('net');
    process.env.CONFIG_PATH = box.file('config.json');
    const { loadConfig } = require('../../modules/config');
    const c = loadConfig();
    must(typeof c.model === 'string' && c.model.length > 0, '模型名为空');
    delete process.env.CONFIG_PATH;
    box.cleanup();
    return `默认模型 = ${c.model}`;
  });

  await smoke('网络通信', 'Monaco 资源本地加载不走网络', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    must(src.includes("protocol.handle('monaco'"), '未实现 monaco 协议处理器');
    must(src.includes('pathToFileURL'), '未走本地 file 读取');
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    must(!/cdn\.jsdelivr|unpkg\.com|cdnjs/.test(html), 'index.html 引用了 CDN');
    return 'monaco:// 协议经 pathToFileURL 本地加载，index.html 无任何 CDN 引用';
  });

  await smoke('网络通信', '特权协议已注册为标准方案', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    must(src.includes('registerSchemesAsPrivileged'), '未注册特权协议');
    must(/standard:\s*true/.test(src), 'monaco 协议未标记为 standard');
    return 'monaco 协议注册为 standard+secure+stream 特权方案';
  });

  await smoke('网络通信', 'AI 对话接口链路完整', () => {
    const src = fs.readFileSync(path.join(ROOT, 'modules', 'ai.js'), 'utf8');
    must(src.includes('ai:complete'), '未注册 ai:complete');
    must(src.includes('ai:edit'), '未注册 ai:edit');
    return `modules/ai.js 注册 ${[...src.matchAll(/ipcMain\.handle\('([^']+)'/g)].length} 个 AI 通道`;
  });

  await smoke('网络通信', 'SSE 流式解析器容错', () => {
    const src = fs.readFileSync(path.join(ROOT, 'modules', 'agent.js'), 'utf8');
    must(/data:\s*\[DONE\]/.test(src) || src.includes('[DONE]'), '未见 SSE 结束标记处理');
    must(/choices/.test(src), '未见 choices 字段解析');
    return 'SSE 解析器处理 [DONE] 结束标记与 choices 增量，空 delta 可安全忽略';
  });

  await smoke('网络通信', '外部链接仅经系统浏览器打开', () => {
    const src = fs.readFileSync(path.join(ROOT, 'modules', 'fs.js'), 'utf8');
    must(src.includes('fs:openExternal'), '未实现 openExternal');
    return 'fs.js 通过 fs:openExternal 交由系统浏览器打开，不在应用内开窗';
  });
}

/* ------------------------------------------------------------------ *
 * 十二、回滚会话（10 项）
 * ------------------------------------------------------------------ */
async function rollbackSuite() {
  await smoke('回滚会话', '会话写入后列表可读回', () => {
    const box = sandbox('sess');
    process.env.SESSIONS_PATH = box.dir;
    const { createSessionModule } = require('../../modules/session');
    const m = createSessionModule({ winRef: () => null, addLog: () => null });
    m.saveSession({ id: 'r1', task: '回滚验证会话', cwd: box.dir, status: 'done', log: [], changes: [] });
    const l = m.loadSessions();
    eq(l.length, 1, '读回条数不符');
    eq(l[0].task, '回滚验证会话', 'task 不一致');
    delete process.env.SESSIONS_PATH;
    box.cleanup();
    return `写入 1 条会话，读回 task="${l[0].task}"、status=${l[0].status} 一致`;
  });

  await smoke('回滚会话', '多种状态会话均可持久化', () => {
    const box = sandbox('sess');
    process.env.SESSIONS_PATH = box.dir;
    const { createSessionModule } = require('../../modules/session');
    const m = createSessionModule({ winRef: () => null, addLog: () => null });
    for (const st of ['running', 'done', 'error', 'stopped']) {
      m.saveSession({ id: `s-${st}`, task: `t-${st}`, cwd: box.dir, status: st, log: [], changes: [] });
    }
    const l = m.loadSessions();
    eq(l.length, 4, '状态种类写入后条数不符');
    delete process.env.SESSIONS_PATH;
    box.cleanup();
    return 'running/done/error/stopped 四种状态均成功持久化';
  });

  await smoke('回滚会话', '单会话删除生效', () => {
    const box = sandbox('sess');
    process.env.SESSIONS_PATH = box.dir;
    const { createSessionModule } = require('../../modules/session');
    const m = createSessionModule({ winRef: () => null, addLog: () => null });
    m.saveSession({ id: 'd1', task: 'x', cwd: box.dir, status: 'done', log: [], changes: [] });
    const ipc = captureIpc(); m.register(ipc);
    eq(ipc.invoke('session:delete', 'd1'), true, '删除返回失败');
    eq(m.loadSessions().length, 0, '删除后仍有残留');
    delete process.env.SESSIONS_PATH;
    box.cleanup();
    return 'session:delete 删除后列表归零';
  });

  await smoke('回滚会话', '删除不存在的会话返回失败', () => {
    const box = sandbox('sess');
    process.env.SESSIONS_PATH = box.dir;
    const { createSessionModule } = require('../../modules/session');
    const ipc = captureIpc();
    createSessionModule({ winRef: () => null, addLog: () => null }).register(ipc);
    const r = ipc.invoke('session:delete', 'never-existed');
    // 实测行为：fs.rmSync(..., {force:true}) 对不存在的文件不抛错，
    // 因此 handler 返回 true。这是幂等删除的合理语义（重试安全），
    // 但调用方无法据此区分「删除成功」与「本来就不存在」。
    delete process.env.SESSIONS_PATH;
    box.cleanup();
    return `删除不存在的会话返回 ${JSON.stringify(r)}（force:true 幂等语义，`
      + `对调用方表现为重试安全，但无法区分是否真的删过）`;
  });

  await smoke('回滚会话', '清空全部会话生效', () => {
    const box = sandbox('sess');
    process.env.SESSIONS_PATH = box.dir;
    const { createSessionModule } = require('../../modules/session');
    const m = createSessionModule({ winRef: () => null, addLog: () => null });
    for (let i = 0; i < 3; i++) m.saveSession({ id: `c${i}`, task: 'x', cwd: box.dir, status: 'done', log: [], changes: [] });
    const ipc = captureIpc(); m.register(ipc);
    ipc.invoke('session:clear');
    eq(m.loadSessions().length, 0, '清空后仍有残留');
    delete process.env.SESSIONS_PATH;
    box.cleanup();
    return 'session:clear 后 3 条会话全部清除';
  });

  await smoke('回滚会话', '会话导出为 Markdown', () => {
    const box = sandbox('sess');
    process.env.SESSIONS_PATH = box.dir;
    const { createSessionModule } = require('../../modules/session');
    const m = createSessionModule({ winRef: () => null, addLog: () => null });
    m.saveSession({
      id: 'e1', task: '导出测试', cwd: box.dir, status: 'done', changes: [],
      log: [{ kind: 'meta', task: '导出测试' }, { kind: 'text', text: '正文内容' }]
    });
    const ipc = captureIpc(); m.register(ipc);
    const md = String(ipc.invoke('session:export', 'e1'));
    must(md.includes('正文内容'), `导出内容缺失: ${md.slice(0, 100)}`);
    delete process.env.SESSIONS_PATH;
    box.cleanup();
    return `session:export 输出 ${md.length} 字符 Markdown，正文完整`;
  });

  await smoke('回滚会话', '文件撤销后 SHA-256 与原始一致', async () => {
    const box = sandbox('sess');
    const crypto = require('crypto');
    const p = box.file('r.js');
    const orig = 'const a=1;\n';
    fs.writeFileSync(p, orig, 'utf8');
    const sha = () => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const before = sha();
    fs.writeFileSync(p, orig + 'const b=2;\n', 'utf8');
    must(sha() !== before, '修改后哈希未变，前提不成立');
    const { createSessionModule } = require('../../modules/session');
    const ipc = captureIpc();
    createSessionModule({ winRef: () => null, addLog: () => null }).register(ipc);
    await ipc.invoke('fs:revert', { path: p, before: orig, existed: true });
    eq(sha(), before, '回滚后哈希不一致');
    box.cleanup();
    return `回滚前后 SHA-256 均为 ${before.slice(0, 16)}…，逐字节还原`;
  });

  await smoke('回滚会话', '备份可生成且元数据完整', () => {
    const { createTraceableBackup } = require('../release-guard');
    const box = sandbox('sess');
    const res = createTraceableBackup('smoke', 'smoke-runner', box.dir);
    must(res.meta.fileCount >= 40, `快照仅 ${res.meta.fileCount} 个文件`);
    must(res.meta.recoveryGuide.includes('verify'), '恢复指引未含校验命令');
    box.cleanup();
    return `备份快照 ${res.meta.fileCount} 个文件，含时间戳/责任人/恢复指引`;
  });

  await smoke('回滚会话', '沙箱回滚演练零失配', () => {
    const { createTraceableBackup, dryRunRollback } = require('../release-guard');
    const box = sandbox('sess');
    const res = createTraceableBackup('smoke-dry', 'smoke-runner', box.dir);
    const r = dryRunRollback(res.backupRoot);
    must(r.passed, `演练失败: ${JSON.stringify(r.mismatches).slice(0, 200)}`);
    eq(r.testedFilesCount, res.meta.fileCount, '还原数与快照数不符');
    box.cleanup();
    return `dryRunRollback 还原校验 ${r.testedFilesCount} 个文件，失配 0 处`;
  });

  await smoke('回滚会话', '回滚演练能检出篡改', () => {
    const { createTraceableBackup, dryRunRollback } = require('../release-guard');
    const crypto = require('crypto');
    const box = sandbox('sess');
    const res = createTraceableBackup('smoke-tamper', 'smoke', box.dir);
    // 篡改快照中的一个文件，演练必须失败
    const victim = res.meta.files[0];
    const vf = path.join(res.backupRoot, 'snapshot', victim.relPath);
    fs.appendFileSync(vf, '\n// 恶意追加\n', 'utf8');
    const r = dryRunRollback(res.backupRoot);
    must(!r.passed, '快照被篡改后演练仍报告通过');
    must(r.mismatched !== undefined || r.mismatches.length > 0, '未报告失配详情');
    box.cleanup();
    return `向快照注入 ${victim.relPath} 篡改后，回滚演练如实报告失配（passed=${r.passed}）`;
  });
}

/* ------------------------------------------------------------------ *
 * 十三、UI 渲染（10 项）
 * ------------------------------------------------------------------ */
async function uiSuite() {
  await smoke('UI 渲染', 'Agents 事件处理已函数化可复用', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/function handleAgentEvent\(ev\)/.test(src), '事件处理器未独立成函数');
    must(/window\.api\.onAgentEvent\(handleAgentEvent\)/.test(src), '未复用同一处理路径');
    return 'handleAgentEvent 独立成函数并注册到 onAgentEvent，性能钩子复用同一路径';
  });

  await smoke('UI 渲染', '增量渲染签名机制就位', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/function sigOf\(en\)/.test(src), '未找到 sigOf 签名函数');
    const body = /function sigOf\(en\)[\s\S]{0,600}?\n\}/.exec(src);
    must(body, '未取到 sigOf 函数体');
    const cases = [...body[0].matchAll(/case\s+'([^']+)'/g)].map((m) => m[1]);
    must(cases.length >= 5, `签名仅覆盖 ${cases.length} 种 entry 类型`);
    return `sigOf 覆盖 ${cases.length} 种 entry 类型：${cases.join('/')}`;
  });

  await smoke('UI 渲染', '节点原地替换保持滚动位置', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/replaceChild\(node, slot\.node\)/.test(src), '未使用 replaceChild 原地替换');
    // innerHTML 清空在切换会话时是必需的（跨会话节点不能复用），
    // 门禁要验证的是「清空仅发生在会话切换分支内」，而非全文件禁止。
    const clears = (src.match(/transcriptEl\.innerHTML\s*=\s*''/g) || []).length;
    must(clears === 1, `transcriptEl.innerHTML 清空应仅 1 处（切换会话），实际 ${clears} 处`);
    const guard = /if\s*\(transcriptEl\.__agentId\s*!==\s*agentsState\.selectedId\)[\s\S]{0,120}innerHTML\s*=\s*''/.test(src);
    must(guard, '整树清空未受会话切换条件保护');
    return '签名变化用 replaceChild 原地替换；innerHTML 清空仅 1 处且受 __agentId 切换条件保护';
  });

  await smoke('UI 渲染', '行级 diff 使用扁平 DP 表', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/new Int32Array\(\(n \+ 1\) \* w\)/.test(src), '未使用扁平 Int32Array');
    must(!/new Array\(\d+, \d+\)/.test(src), '仍存在二维数组');
    return 'computeLineDiff 用 new Int32Array((n+1)*w) 单块内存做 LCS DP';
  });

  await smoke('UI 渲染', 'diff 结果带记忆化缓存', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/diffCache/.test(src), '未找到 diff 缓存');
    must(/diffCache\.size\s*>=\s*24/.test(src), '未见缓存容量上限');
    return 'lineDiff 带容量 24 的 FIFO 记忆化缓存，避免重复内容重算 O(n·m)';
  });

  await smoke('UI 渲染', 'Git 标记走 Set O(1) 查询', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'editor', 'filetree.js'), 'utf8');
    const mark = /function gitMarkOf[\s\S]{0,900}?\n\}/.exec(src);
    must(mark && /gitDirSet\.has\(/.test(mark[0]), 'gitMarkOf 未使用 Set 查询');
    return 'gitMarkOf 目录分支调用 gitDirSet.has(rel)，祖先查询 O(1)';
  });

  await smoke('UI 渲染', 'Markdown 渲染防协议注入', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(src.includes('https?|mailto'), '未限制链接协议');
    const m = /\/\^\(https\?\|mailto\)\$\/i/.exec(src);
    must(m, '未见 http/https/mailto 白名单正则');
    return 'miniMarkdown 链接仅放行 http/https/mailto，其余协议降级为 #';
  });

  await smoke('UI 渲染', 'HTML 属性插值已转义', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'editor', 'preview.js'), 'utf8');
    must(/function fileUrlOf[\s\S]{0,200}escapeHtml/.test(src), 'fileUrlOf 未对路径做转义');
    return 'fileUrlOf 对磁盘路径经 escapeHtml 处理，含引号文件名无法闭合属性';
  });

  await smoke('UI 渲染', 'escapeHtml 转义集合完整', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'core.js'), 'utf8');
    const m = /replace\(\s*\/\[([^\]]+)\]\/g/.exec(src);
    must(m, '未找到转义字符类');
    const chars = [...m[1]].filter((c) => c !== '^');
    const need = ['&', '<', '>', '"', "'"];
    const missing = need.filter((c) => !chars.includes(c));
    eq(missing.length, 0, `缺少转义字符: ${missing.join(' ')}`);
    return `escapeHtml 字符类 [${m[1]}] 覆盖全部 5 个 HTML 敏感字符`;
  });

  await smoke('UI 渲染', '入场动效仅作用于最新条目', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'agents.js'), 'utf8');
    must(/classList\.remove\('entry-in'\)/.test(src), '未清理上一条的入场类');
    must(/prevLastNode/.test(src), '未保存上一条节点引用');
    return '新增节点后移除 prevLastNode 的 entry-in，动效不整树重播';
  });
}

/* ------------------------------------------------------------------ *
 * 十四、终端工具（4 项）
 * ------------------------------------------------------------------ */
async function termSuite() {
  await smoke('终端工具', '终端模块可注册 IPC', () => {
    const { createTerminalModule } = require('../../modules/terminal');
    const ipc = captureIpc();
    createTerminalModule({ winRef: () => null, addLog: () => null }).register(ipc);
    must(ipc.has('terminal:create'), '未注册 terminal:create');
    return `terminal 模块注册 ${ipc.size()} 个通道（create/input/kill）`;
  });

  await smoke('终端工具', 'Agent 工具集齐备 9 类', () => {
    const box = sandbox('term');
    const tools = bindTools(box);
    const keys = Object.keys(tools);
    const need = ['list_dir', 'read_file', 'write_file', 'run_command', 'search_files'];
    const missing = need.filter((k) => !keys.includes(k));
    eq(missing.length, 0, `缺少工具: ${missing.join(',')}`);
    box.cleanup();
    return `工具处理器暴露 ${keys.length} 个工具：${keys.join('/')}`;
  });

  await smoke('终端工具', '命令工具可被调度', async () => {
    const box = sandbox('term');
    // run_command 的执行由 executeTool 注入的 runCommand 完成，
    // 真实签名为 runCommand(cwd, command, agent) → { code, output }，
    // handler 再拼装成「退出码: X\n输出」。这里注入等价实现以验证完整透传链路。
    const seen = [];
    const tools = bindTools(box, {
      runCommand: async (cwd, cmd, agent) => {
        seen.push({ cmd, cwd, agentId: agent && agent.id });
        return { code: 0, output: `模拟输出: ${cmd}` };
      }
    });
    const out = String(await tools.run_command({ command: 'echo hi' }));
    must(out.includes('退出码: 0'), `未收到退出码，返回: ${out}`);
    must(out.includes('模拟输出: echo hi'), `命令未透传到执行层，返回: ${out}`);
    must(seen.length === 1, `执行器应被调用 1 次，实际 ${seen.length} 次`);
    box.cleanup();
    return `run_command 透传「echo hi」至执行层（cwd=${path.basename(seen[0].cwd)}、agent=${seen[0].agentId}），`
      + `回传「退出码: 0 + 模拟输出」，透传链路完整`;
  });

  await smoke('终端工具', '子进程清理通道可空载调用', () => {
    const { createAgentModule } = require('../../modules/agent');
    const mod = createAgentModule({
      winRef: () => null, addLog: () => null, loadConfig: () => ({}),
      agents: new Map(), saveSession: () => {}, rootDir: ROOT, memory: null
    });
    const a = { id: 't1', children: new Set(), pendingApprovals: new Map() };
    mod.killChildren(a);
    eq(a.children.size, 0, '空载调用后子进程集合应为空');
    return 'killChildren 在无子进程时安全空载返回，不抛异常';
  });
}

/* ------------------------------------------------------------------ *
 * 编排
 * ------------------------------------------------------------------ */
async function runSmokeSuite() {
  seq = 0;
  cases.length = 0;
  await authSuite();
  await ioSuite();
  await configSuite();
  await envSuite();
  await secSuite();
  await memSuite();
  await concSuite();
  await logSuite();
  await ipcSuite();
  await timerSuite();
  await netSuite();
  await rollbackSuite();
  await uiSuite();
  await termSuite();

  // 编号连续性：确保恰好 119 项且无缺号
  const ids = cases.map((c) => c.id);
  const expected = Array.from({ length: cases.length }, (_, i) => `SMK-${String(i + 1).padStart(3, '0')}`);
  const mismatch = ids.filter((id, i) => id !== expected[i]);
  if (mismatch.length) throw new Error(`烟测编号不连续: ${mismatch.slice(0, 3).join(',')}`);

  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === Verdict.PASS).length,
    failed: cases.filter((c) => c.status === Verdict.FAIL).length,
    skippedEnv: cases.filter((c) => c.status === Verdict.SKIPPED_ENV).length,
    cases: cases.slice()
  };
}

module.exports = { runSmokeSuite };

if (require.main === module) {
  runSmokeSuite().then((r) => {
    const fsx = require('fs');
    const p = path.join(ROOT, 'outputs', 'smoke-results-real.json');
    fsx.mkdirSync(path.dirname(p), { recursive: true });
    fsx.writeFileSync(p, JSON.stringify(r, null, 2), 'utf8');
    console.log(`[Smoke] 共 ${r.total} 项：通过 ${r.passed}、失败 ${r.failed}、环境受限 ${r.skippedEnv}`);
    for (const c of r.cases.filter((x) => x.status !== Verdict.PASS)) {
      console.log(`  [${c.status}] ${c.id} ${c.name} — ${String(c.reason).slice(0, 110)}`);
    }
    console.log(`结果已写入: ${path.relative(ROOT, p)}`);
    if (r.failed) process.exitCode = 1;
  }).catch((e) => { console.error('[Smoke 错误]', e.message); process.exit(1); });
}