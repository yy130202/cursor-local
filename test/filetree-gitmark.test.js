'use strict';

/* renderer/editor/filetree.js — git 标记 O(1) 化改造的回归测试
 *
 * 改造点：gitMarkOf 对目录的判断，原为遍历整个 __gitStatusMap.keys()
 * （key === rel || key.startsWith(rel + '/')），是 O(目录数 × 变更数)。
 * 现改为预计算「变更文件的祖先目录 Set」，查询 O(1)。
 *
 * 这里验证改造前后语义完全一致，重点覆盖边界：
 *  - 前缀相似的目录不能误判（a 与 a-b、src 与 src2）；
 *  - 深层路径的每一级祖先都应被标记；
 *  - 相对路径与绝对路径混用；
 *  - 缓存随 __gitStatusMap 更换而失效。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../renderer/editor/filetree.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces: ' + name);
}

/* 加载 git 标记相关的四个函数，注入可控的 EditorState / __gitStatusMap。
   注意：buildGitDirSet / invalidateGitMarks 都是零参数，直接读 window.__gitStatusMap。 */
function loadGitMark(currentFolder) {
  const names = ['relTreePath', 'buildGitDirSet', 'invalidateGitMarks', 'gitMarkOf'];
  const src = names.map((n) => extractFunction(source, n)).join('\n\n');
  const ctx = {
    console,
    window: {},
    EditorState: { currentFolder }
  };
  vm.createContext(ctx);
  // invalidateGitMarks 依赖模块级 let 变量 gitDirSet / gitDirSetFor，
  // 抽取函数体后需在同作用域内声明它们
  vm.runInContext('let gitDirSet = new Set(); let gitDirSetFor = null;\n' + src, ctx);
  const setMap = (map) => { ctx.window.__gitStatusMap = map; };
  return {
    relPath: vm.runInContext('relTreePath', ctx),
    // 先设 map 再调用零参数函数，返回宿主 realm 的 Set 副本
    buildGitDirSet: (map) => {
      ctx.window.__gitStatusMap = map;
      return new Set(vm.runInContext('buildGitDirSet', ctx)());
    },
    setMap,
    mark: (absPath, isDir) => {
      const fn = vm.runInContext('gitMarkOf', ctx);
      const r = fn(absPath, isDir);
      return r ? { ch: r.ch, cls: r.cls } : null;
    }
  };
}

const CWD = 'C:\\repo';
const abs = (...p) => path.join(CWD, ...p);

test('gitMarkOf: 无 git 状态时任何路径都无标记', () => {
  const g = loadGitMark(CWD);
  g.setMap(new Map());
  assert.equal(g.mark(abs('a.js'), false), null);
  assert.equal(g.mark(abs('src'), true), null);
  assert.equal(g.mark(abs('src', 'a.js'), false), null);
});

test('gitMarkOf: __gitStatusMap 为 undefined 时不抛错', () => {
  const g = loadGitMark(CWD);
  g.setMap(undefined);
  assert.equal(g.mark(abs('a.js'), false), null);
});

test('gitMarkOf: 文件按状态映射为标记字符', () => {
  const g = loadGitMark(CWD);
  g.setMap(new Map([
    ['new.txt', { status: 'untracked' }],
    ['mod.js', { status: 'modified' }],
    ['del.js', { status: 'deleted' }],
    ['ren.js', { status: 'renamed' }],
    ['add.js', { status: 'added' }],
    ['cft.js', { status: 'conflict' }],
    ['weird.js', { status: 'some-new-status' }]
  ]));

  assert.deepEqual(g.mark(abs('mod.js'), false), { ch: 'M', cls: 'm' });
  assert.deepEqual(g.mark(abs('del.js'), false), { ch: 'D', cls: 'd' });
  assert.deepEqual(g.mark(abs('new.txt'), false), { ch: 'U', cls: 'u' });
  assert.deepEqual(g.mark(abs('ren.js'), false), { ch: 'R', cls: 'm' });
  assert.deepEqual(g.mark(abs('add.js'), false), { ch: 'A', cls: 'a' });
  assert.deepEqual(g.mark(abs('cft.js'), false), { ch: '!', cls: 'd' });
  assert.deepEqual(g.mark(abs('weird.js'), false), { ch: 'M', cls: 'm' }, '未收录的状态回退到 M/m');
  assert.equal(g.mark(abs('nope.js'), false), null, '不在 map 中的文件无标记');
});

test('gitMarkOf: 含变更的目录被标记为圆点', () => {
  const g = loadGitMark(CWD);
  g.setMap(new Map([['src/deep/a.js', { status: 'modified' }]]));

  assert.deepEqual(g.mark(abs('src'), true), { ch: '●', cls: 'm' });
  assert.deepEqual(g.mark(abs('src', 'deep'), true), { ch: '●', cls: 'm' });
  assert.equal(g.mark(abs('other'), true), null, '无关目录不应被标记');
});

test('gitMarkOf: 祖先链每一级都被标记', () => {
  const g = loadGitMark(CWD);
  g.setMap(new Map([['a/b/c/d/e.js', { status: 'modified' }]]));
  for (const p of ['a', 'a/b', 'a/b/c', 'a/b/c/d']) {
    assert.deepEqual(g.mark(abs(...p.split('/')), true), { ch: '●', cls: 'm' }, p + ' 应被标记');
  }
  assert.equal(g.mark(abs('a', 'b', 'c', 'd', 'e.js'), false).ch, 'M');
});

test('gitMarkOf: 前缀相似的目录不误判（关键边界）', () => {
  const g = loadGitMark(CWD);
  // 只有 src/a.js 变更
  g.setMap(new Map([['src/a.js', { status: 'modified' }]]));

  // 这些目录名以 src 开头但不是其子目录，不应被标记
  assert.equal(g.mark(abs('srclib'), true), null, 'srclib 不是 src 的子目录');
  assert.equal(g.mark(abs('src2'), true), null, 'src2 不是 src 的子目录');
  assert.equal(g.mark(abs('s'), true), null);
  // 反向：src 下确有变更，应被标记
  assert.deepEqual(g.mark(abs('src'), true), { ch: '●', cls: 'm' });
});

test('gitMarkOf: 反向前缀也不误判（a/b 变更不影响 a/bc）', () => {
  const g = loadGitMark(CWD);
  g.setMap(new Map([['a/b/file.js', { status: 'modified' }]]));
  assert.equal(g.mark(abs('a', 'bc'), true), null, 'a/bc 不是 a/b 的子目录');
  assert.deepEqual(g.mark(abs('a', 'b'), true), { ch: '●', cls: 'm' });
});

test('gitMarkOf: 缓存随 __gitStatusMap 更换而失效', () => {
  const g = loadGitMark(CWD);
  g.setMap(new Map([['x.js', { status: 'modified' }]]));
  assert.deepEqual(g.mark(abs('x.js'), false), { ch: 'M', cls: 'm' });
  assert.equal(g.mark(abs('somewhere'), true), null);

  // 换成新的 map：新增深层变更后，祖先目录应立刻反映出来
  g.setMap(new Map([['p/q/r.js', { status: 'added' }]]));
  assert.deepEqual(g.mark(abs('p', 'q'), true), { ch: '●', cls: 'm' });
  assert.equal(g.mark(abs('x.js'), false), null, '旧 map 的条目不应残留');
});

test('gitMarkOf: 同名 Map 实例下缓存被复用（invalidateGitMarks 幂等）', () => {
  const g = loadGitMark(CWD);
  const map = new Map([['a/b.js', { status: 'modified' }]]);
  g.setMap(map);
  assert.deepEqual(g.mark(abs('a'), true), { ch: '●', cls: 'm' });
  // 同一实例重复查询结果稳定
  assert.deepEqual(g.mark(abs('a'), true), { ch: '●', cls: 'm' });
  assert.deepEqual(g.mark(abs('a'), true), { ch: '●', cls: 'm' });
});

test('buildGitDirSet: 收集全部祖先目录且不含文件自身', () => {
  const g = loadGitMark(CWD);
  const set = g.buildGitDirSet(new Map([
    ['a/b/c.js', { status: 'modified' }],
    ['top.js', { status: 'modified' }]
  ]));
  assert.equal(set.has('a'), true);
  assert.equal(set.has('a/b'), true);
  assert.equal(set.has('a/b/c.js'), false, '文件自身不作为目录加入');
  assert.equal(set.has('top.js'), false);
  assert.equal(set.size, 2, '只有 a、a/b 两个祖先目录');
});

test('buildGitDirSet: 空 map 返回空集合', () => {
  const g = loadGitMark(CWD);
  assert.equal(g.buildGitDirSet(new Map()).size, 0);
  assert.equal(g.buildGitDirSet(undefined).size, 0);
});

test('relPath: 工作区内的路径转为 posix 相对路径', () => {
  const g = loadGitMark(CWD);
  assert.equal(g.relPath(abs('src', 'a.js')), 'src/a.js');
  assert.equal(g.relPath(abs('a.js')), 'a.js');
});

test('relPath: 工作区外的路径原样返回并转 posix', () => {
  const g = loadGitMark(CWD);
  const outside = 'D:\\other\\b.js';
  assert.equal(g.relPath(outside), 'D:/other/b.js');
});