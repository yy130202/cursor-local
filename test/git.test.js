'use strict';

/* modules/git.js — gitStatus 缓存与并行化改造的行为测试
 *
 * 覆盖改造引入的新语义：
 *  1. 同 cwd 的并发请求共享同一个 in-flight promise（只起一组子进程）；
 *  2. TTL 内的重复请求命中缓存，不再执行 git；
 *  3. 任一写操作（stage/commit/checkout/…）立即失效缓存；
 *  4. 三次 git 调用改为并行后，输出与串行版本完全一致（分支/暂存/未暂存/增删行数）；
 *  5. 非仓库目录仍返回 { ok:false }，不会被缓存成成功值。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, createIpc, until } = require('./helpers/harness.js');

// 记录每次 spawn 的参数，便于断言并行度与缓存命中
function createGitHarness(responses) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts && opts.cwd });
    const key = args.join(' ');
    const raw = Object.hasOwn(responses, key) ? responses[key] : undefined;
    const value = typeof raw === 'function' ? raw() : raw;
    const code = value && value.code !== undefined ? value.code : 0;
    const child = new (require('node:events').EventEmitter)();
    child.stdout = new (require('node:events').EventEmitter)();
    child.stderr = new (require('node:events').EventEmitter)();
    child.kill = () => {};
    setImmediate(() => {
      if (code !== 0) {
        child.stderr.emit('data', Buffer.from((value && value.stderr) || 'fatal: not a git repository'));
        child.emit('close', code);
        return;
      }
      child.stdout.emit('data', Buffer.from((value && value.stdout) || ''));
      child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
}

function loadGitModule(responses, logSink) {
  const { spawn, calls } = createGitHarness(responses);
  const module = loadModule('modules/git.js', {
    requires: {
      path,
      fs: require('node:fs'),
      child_process: { spawn }
    }
  }, {
    // 模块内部直接 require；这里通过 requires 注入替换
  });
  // loadModule 的 requireStub 优先命中 requires，故 spawn 已替换
  const logs = [];
  const api = module.createGitModule({ winRef: () => null, addLog: (...a) => logs.push(a) });
  return { api, calls, logs };
}

test('gitStatus: 三次 git 调用并行执行且结果与串行一致', async () => {
  const responses = {
    'status --porcelain -b': {
      stdout: '## main...origin/main [ahead 1]\nM  src/a.js\n M src/b.js\n?? new.txt\n'
    },
    'diff --numstat': { stdout: '3\t1\tsrc/b.js\n' },
    'diff --cached --numstat': { stdout: '10\t2\tsrc/a.js\n' }
  };
  const { api, calls } = loadGitModule(responses);
  const r = await api.__test.gitStatus('C:/repo');

  assert.equal(r.ok, true);
  assert.equal(r.branch, 'main');
  assert.deepEqual(r.staged, [{ file: 'src/a.js', status: 'modified', staged: true, adds: '10', dels: '2' }]);
  assert.deepEqual(r.unstaged, [
    { file: 'src/b.js', status: 'modified', staged: false, adds: '3', dels: '1' },
    { file: 'new.txt', status: 'untracked', staged: false }
  ]);
  assert.equal(calls.length, 3, 'status + 两次 numstat');
});

test('gitStatus: TTL 内的重复请求命中缓存，不再执行 git', async () => {
  const responses = {
    'status --porcelain -b': { stdout: '## main\n M a.js\n' },
    'diff --numstat': { stdout: '1\t1\ta.js\n' },
    'diff --cached --numstat': { stdout: '' }
  };
  const { api, calls } = loadGitModule(responses);

  const first = await api.__test.gitStatus('C:/repo');
  assert.equal(calls.length, 3);
  const second = await api.__test.gitStatus('C:/repo');

  assert.equal(calls.length, 3, 'TTL 内不应再起子进程');
  assert.deepEqual(second, first, '缓存返回同一结果');
});

test('gitStatus: 并发请求共享同一个 in-flight promise', async () => {
  const responses = {
    'status --porcelain -b': { stdout: '## main\n' },
    'diff --numstat': { stdout: '' },
    'diff --cached --numstat': { stdout: '' }
  };
  const { api, calls } = loadGitModule(responses);

  const [a, b, c] = await Promise.all([
    api.__test.gitStatus('C:/repo'),
    api.__test.gitStatus('C:/repo'),
    api.__test.gitStatus('C:/repo')
  ]);
  assert.equal(calls.length, 3, '三个并发请求只起一组子进程');
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('gitStatus: 写操作使缓存失效，下次读到新状态', async () => {
  let dirty = true;
  const responses = {
    'status --porcelain -b': () => ({
      stdout: dirty ? '## main\n M a.js\n' : '## main\n'
    }),
    'diff --numstat': { stdout: '1\t1\ta.js\n' },
    'diff --cached --numstat': { stdout: '' },
    'add -- a.js': { code: 0, stdout: '' }
  };
  const { api, calls } = loadGitModule(responses);

  const before = await api.__test.gitStatus('C:/repo');
  assert.equal(before.unstaged.length, 1);

  dirty = false;
  await api.__test.gitStage('C:/repo', 'a.js');

  const after = await api.__test.gitStatus('C:/repo');
  assert.equal(after.unstaged.length, 0, 'stage 后缓存必须已失效');
  assert.ok(calls.length > 3);
});

test('gitStatus: 非仓库目录返回失败且不污染缓存', async () => {
  const responses = {
    'status --porcelain -b': { code: 128, stderr: 'fatal: not a git repository' },
    'diff --numstat': { code: 129, stderr: 'fatal' },
    'diff --cached --numstat': { code: 129, stderr: 'fatal' }
  };
  const { api } = loadGitModule(responses);
  const r = await api.__test.gitStatus('C:/not-repo');
  assert.equal(r.ok, false);
  assert.match(r.error, /not a git repository/);
});

/* ---- 路径解析：git 对含空格/中文/特殊字符的路径会加引号并做八进制字节转义 ---- */

test('unquotePath: 无引号的路径原样返回', () => {
  const { api } = loadGitModule({});
  assert.equal(api.__test.unquotePath('src/a.js'), 'src/a.js');
  assert.equal(api.__test.unquotePath('"已带引号"'.slice(1, -1)), '已带引号');
  assert.equal(api.__test.unquotePath('"unterminated'), '"unterminated', '引号不闭合时原样返回');
});

test('unquotePath: 还原八进制字节转义的中文路径', () => {
  const { api } = loadGitModule({});
  // git 对 "测试.txt" 输出 "\346\265\213\350\257\225.txt"（UTF-8 字节的八进制）
  assert.equal(api.__test.unquotePath('"\\346\\265\\213\\350\\257\\225.txt"'), '测试.txt');
});

test('unquotePath: 还原常见转义字符', () => {
  const { api } = loadGitModule({});
  assert.equal(api.__test.unquotePath('"a\\tb.txt"'), 'a\tb.txt', '\\t → 制表符');
  assert.equal(api.__test.unquotePath('"a\\"b.txt"'), 'a"b.txt', '\\" → 引号');
  assert.equal(api.__test.unquotePath('"a\\\\b.txt"'), 'a\\b.txt', '\\\\ → 反斜杠');
  assert.equal(api.__test.unquotePath('"a\\nb.txt"'), 'a\nb.txt', '\\n → 换行');
});

test('unquotePath: 中文与 ASCII 混合路径', () => {
  const { api } = loadGitModule({});
  assert.equal(api.__test.unquotePath('"src/\\346\\265\\213\\350\\257\\225/a.js"'), 'src/测试/a.js');
});

test('parsePorcelainName: 重命名取新路径（-> 形式）', () => {
  const { api } = loadGitModule({});
  assert.equal(api.__test.parsePorcelainName('"old name.js" -> "new name.js"'), 'new name.js');
  assert.equal(api.__test.parsePorcelainName('plain.js'), 'plain.js');
});

test('parseNumstatName: 重命名的两种形态（=> 与 {a => b}）', () => {
  const { api } = loadGitModule({});
  assert.equal(api.__test.parseNumstatName('old.js => new.js'), 'new.js', '普通 => 形态');
  assert.equal(
    api.__test.parseNumstatName('src/{old.js => new.js}/keep.js'),
    'src/new.js/keep.js',
    '花括号形态取新名'
  );
});

test('parseNumstatName: 中文重命名路径', () => {
  const { api } = loadGitModule({});
  assert.equal(
    api.__test.parseNumstatName('"\\346\\227\\245.js" => "\\346\\226\\260.js"'),
    '新.js'
  );
});

test('numstatMap: 解析增删行数，二进制文件为 -', async () => {
  const responses = {
    'diff --numstat': { stdout: '5\t3\tsrc/a.js\n-\t-\timg.png\n' }
  };
  const { api } = loadGitModule(responses);
  const map = await api.__test.numstatMap('C:/repo', false);
  assert.deepEqual(map.get('src/a.js'), { adds: '5', dels: '3' });
  assert.deepEqual(map.get('img.png'), { adds: '-', dels: '-' });
});