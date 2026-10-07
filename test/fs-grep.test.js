'use strict';

/* modules/fs.js — search:grep 并发化改造的行为测试
 *
 * 改造点：串行 walk → 同目录文件并发读 + 信号量限流（CONC_GREP = 8）。
 * 这里验证三件事：
 *  1. 命中结果与改造前完全一致（文件、行号、列号、文本、相对路径）；
 *  2. 遍历顺序稳定（同目录文件按 readdir 返回序输出，不因并发而乱序）；
 *  3. 各类边界仍与原实现相同：跳过目录、超大文件、maxResults 截断、深度上限。
 * 并发实现最危险的失败模式是「结果丢失或顺序错乱」，故用乱序完成的 fs 替身专门压测。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('./helpers/harness.js');

// 构造一个内存目录树；files: 绝对路径 -> 内容
function createFsTree(files) {
  const dirs = new Set();
  for (const p of Object.keys(files)) {
    let cur = path.dirname(p);
    while (cur && cur !== path.dirname(cur)) { dirs.add(cur); cur = path.dirname(cur); }
  }
  return { files, dirs };
}

// fs.promises 替身：stat/readFile/readdir
function createFsPromises(tree, opts = {}) {
  const { failRead = new Set(), delayMs = () => 0 } = opts;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sizeOf = (content) => Buffer.byteLength(content);
  return {
    async stat(p) {
      if (tree.files.hasOwnProperty(p)) return { size: sizeOf(tree.files[p]), isFile: () => true };
      if (tree.dirs.has(p)) return { size: 0, isFile: () => false };
      const err = new Error('ENOENT: ' + p); err.code = 'ENOENT'; throw err;
    },
    async readFile(p) {
      await sleep(delayMs(p));
      if (failRead.has(p)) { const err = new Error('EACCES: ' + p); err.code = 'EACCES'; throw err; }
      if (!tree.files.hasOwnProperty(p)) { const err = new Error('ENOENT: ' + p); err.code = 'ENOENT'; throw err; }
      return tree.files[p];
    },
    async readdir(dir, options = {}) {
      await sleep(0);
      const names = new Set();
      const all = [...Object.keys(tree.files), ...tree.dirs];
      for (const p of all) {
        if (path.dirname(p) === dir) names.add(path.basename(p));
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => tree.dirs.has(path.join(dir, name))
      }));
    },
    mkdir: async () => {},
    writeFile: async () => {}
  };
}

function loadFsModule(tree, opts) {
  const fsp = createFsPromises(tree, opts);
  const module = loadModule('modules/fs.js', {
    requires: {
      path,
      'fs': { promises: fsp },
      electron: { dialog: {}, shell: {} },
      child_process: { spawn: () => { throw new Error('unexpected spawn'); } }
    }
  });
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const cfg = {};
  module.registerFs(ipcMain, {
    winRef: () => null,
    addLog: () => {},
    loadConfig: () => cfg,
    saveConfig: (c) => Object.assign(cfg, c)
  });
  return { grep: (folder, pattern) => handlers.get('search:grep')(null, { folder, pattern }) };
}

test('search:grep: 命中结果与串行实现一致', async () => {
  const root = path.resolve('/repo');
  const tree = createFsTree({
    [path.join(root, 'a.js')]: 'hello world\nfoo bar\nHELLO again\n',
    [path.join(root, 'b.txt')]: 'nothing here\n',
    [path.join(root, 'src', 'c.js')]: 'say hello from c\nhello again\n',
    [path.join(root, 'src', 'deep', 'd.js')]: 'hello deep\n'
  });
  const { grep } = loadFsModule(tree);
  const r = await grep(root, 'hello');

  // grep 返回的 file 已是相对 folder 的路径，直接规范化分隔符后比较
  const normalized = r.map((x) => ({ ...x, file: x.file.split(path.sep).join('/') }))
    .sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);

  assert.deepEqual(normalized, [
    { file: 'a.js', line: 1, col: 1, text: 'hello world' },
    { file: 'a.js', line: 3, col: 1, text: 'HELLO again' },
    { file: 'src/c.js', line: 1, col: 5, text: 'say hello from c' },
    { file: 'src/c.js', line: 2, col: 1, text: 'hello again' },
    { file: 'src/deep/d.js', line: 1, col: 1, text: 'hello deep' }
  ]);
});

test('search:grep: 结果按文件路径稳定排序，不受并发完成顺序影响', async () => {
  const root = path.resolve('/repo');
  const files = {};
  // 20 个文件，读延迟与文件名顺序相反 —— 若实现依赖完成顺序，结果就会乱
  for (let i = 0; i < 20; i++) {
    const name = 'f' + String(i).padStart(2, '0') + '.txt';
    files[path.join(root, name)] = 'needle here\n';
  }
  const tree = createFsTree(files);
  const { grep } = loadFsModule(tree, {
    delayMs: (p) => {
      const n = Number(path.basename(p).slice(1, 3));
      return (20 - n) * 3; // f00 最慢，f19 最快
    }
  });

  const r = await grep(root, 'needle');
  assert.equal(r.length, 20);
  const order = r.map((x) => path.basename(x.file));
  assert.deepEqual(order, [...order].sort(), '结果顺序必须与 readdir 序一致');
});

test('search:grep: 大小写不敏感匹配', async () => {
  const root = path.resolve('/repo');
  const tree = createFsTree({
    [path.join(root, 'x.js')]: 'Needle\nNEEDLE\nneedle\n'
  });
  const { grep } = loadFsModule(tree);
  const r = await grep(root, 'needle');
  assert.deepEqual(r.map((x) => x.line), [1, 2, 3]);
});

test('search:grep: 跳过 node_modules/.git/dist/.test-sessions', async () => {
  const root = path.resolve('/repo');
  const tree = createFsTree({
    [path.join(root, 'keep.js')]: 'needle\n',
    [path.join(root, 'node_modules', 'x.js')]: 'needle\n',
    [path.join(root, '.git', 'y.js')]: 'needle\n',
    [path.join(root, 'dist', 'z.js')]: 'needle\n',
    [path.join(root, '.test-sessions', 'w.js')]: 'needle\n'
  });
  const { grep } = loadFsModule(tree);
  const r = await grep(root, 'needle');
  assert.equal(r.length, 1);
  assert.equal(path.basename(r[0].file), 'keep.js');
});

test('search:grep: 超过 500000 字节的文件被跳过', async () => {
  const root = path.resolve('/repo');
  const big = 'needle\n' + 'a'.repeat(600000);
  const tree = createFsTree({
    [path.join(root, 'big.txt')]: big,
    [path.join(root, 'small.txt')]: 'needle\n'
  });
  const { grep } = loadFsModule(tree);
  const r = await grep(root, 'needle');
  assert.equal(r.length, 1);
  assert.equal(path.basename(r[0].file), 'small.txt');
});

test('search:grep: maxResults=500 截断', async () => {
  const root = path.resolve('/repo');
  const files = {};
  for (let i = 0; i < 30; i++) {
    files[path.join(root, 'f' + i + '.txt')] = Array.from({ length: 30 }, () => 'needle').join('\n');
  }
  const tree = createFsTree(files);
  const { grep } = loadFsModule(tree);
  const r = await grep(root, 'needle');
  assert.equal(r.length, 500);
});

test('search:grep: 单行多次命中只记录首个位置', async () => {
  const root = path.resolve('/repo');
  const tree = createFsTree({
    [path.join(root, 'multi.txt')]: 'needle and needle again\n'
  });
  const { grep } = loadFsModule(tree);
  const r = await grep(root, 'needle');
  assert.equal(r.length, 1);
  assert.equal(r[0].col, 1);
});

test('search:grep: 读取失败的文件被跳过，不影响其他结果', async () => {
  const root = path.resolve('/repo');
  const bad = path.join(root, 'locked.js');
  const tree = createFsTree({
    [bad]: 'needle\n',
    [path.join(root, 'ok.js')]: 'needle\n'
  });
  const { grep } = loadFsModule(tree, { failRead: new Set([bad]) });
  const r = await grep(root, 'needle');
  assert.equal(r.length, 1);
  assert.equal(path.basename(r[0].file), 'ok.js');
});

test('search:grep: 深度超过 10 层不再深入', async () => {
  const root = path.resolve('/repo');
  const deep = path.join(root, ...Array.from({ length: 12 }, (_, i) => 'd' + i));
  const tree = createFsTree({
    [path.join(deep, 'x.txt')]: 'needle\n'
  });
  const { grep } = loadFsModule(tree);
  const r = await grep(root, 'needle');
  assert.equal(r.length, 0);
});

test('search:grep: 空参数直接返回空数组', async () => {
  const root = path.resolve('/repo');
  const { grep } = loadFsModule(createFsTree({}));
  assert.deepEqual(await grep(root, ''), []);
  assert.deepEqual(await grep('', 'needle'), []);
});