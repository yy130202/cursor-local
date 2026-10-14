'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, createMemoryFs, createIpc, createWindow, userData, workspace } = require('./helpers/harness');

function setup({ files = {}, env = {}, window = createWindow() } = {}) {
  const mem = createMemoryFs(files);
  const logs = [];
  const errors = [];
  const module = loadModule('modules/session.js', {
    requires: { fs: mem.fs, electron: { app: { getPath: () => userData } } },
    globals: { process: { env }, console: { error: (...args) => errors.push(args) } }
  }).createSessionModule({ winRef: () => window, addLog: (...args) => logs.push(args) });
  const ipc = createIpc();
  module.register(ipc);
  return { module, mem, ipc, logs, errors, window, dir: env.SESSIONS_PATH || path.join(userData, 'sessions') };
}

const sessionFile = (id) => path.join(userData, 'sessions', id + '.json');

test('session: save stores public transcript and omits live handles', () => {
  const { module, mem } = setup();
  const agent = {
    id: 'one', task: 'task', cwd: workspace, status: 'done', log: [{ kind: 'text', text: 'result' }],
    messages: [{ role: 'system', content: 'internal' }], children: new Set([{}])
  };
  const before = Date.now();
  module.saveSession(agent);
  const saved = JSON.parse(mem.content(sessionFile('one')));
  assert.equal(saved.id, 'one');
  assert.equal(saved.task, 'task');
  assert.equal(saved.cwd, workspace);
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.log, agent.log);
  assert.deepEqual(saved.changes, []);
  assert.equal(saved.messages, undefined);
  assert.equal(saved.children, undefined);
  assert.ok(saved.ts >= before && saved.ts <= Date.now());
});

test('session: environment override controls save and load location', () => {
  const dir = path.join(workspace, 'custom-sessions');
  const { module, mem } = setup({ env: { SESSIONS_PATH: dir } });
  module.saveSession({ id: 'custom', log: [], changes: [{ path: 'a' }] });
  assert.ok(mem.exists(path.join(dir, 'custom.json')));
  assert.equal(module.loadSessions()[0].id, 'custom');
  assert.deepEqual(module.loadSessions()[0].changes, [{ path: 'a' }]);
});

test('session: missing directory and read failures produce an empty list', () => {
  const { module, mem, dir } = setup();
  assert.deepEqual(module.loadSessions(), []);
  mem.fs.mkdirSync(dir, { recursive: true });
  mem.fs.readdirSync = () => { throw new Error('unreadable directory'); };
  assert.deepEqual(module.loadSessions(), []);
});

test('session: load skips corrupt/non-JSON files and orders newest first', () => {
  const { module, ipc } = setup({ files: {
    [sessionFile('old')]: JSON.stringify({ id: 'old', ts: 10 }),
    [sessionFile('new')]: JSON.stringify({ id: 'new', ts: 30 }),
    [sessionFile('untimed')]: JSON.stringify({ id: 'untimed' }),
    [sessionFile('bad')]: '{bad',
    [sessionFile('null')]: 'null',
    [path.join(userData, 'sessions', 'notes.txt')]: 'keep'
  } });
  assert.deepEqual(module.loadSessions().map((s) => s.id), ['new', 'old', 'untimed']);
  assert.deepEqual(ipc.invoke('session:list').map((s) => s.id), ['new', 'old', 'untimed']);
});

test('session: save failure is logged without crashing the Agent', () => {
  const { module, mem, errors } = setup();
  mem.fs.writeFileSync = () => { throw new Error('disk full'); };
  assert.doesNotThrow(() => module.saveSession({ id: 'one' }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], 'disk full');
});

test('session: deleting a session leaves unrelated sessions and logs success', () => {
  const { ipc, mem, logs } = setup({ files: {
    [sessionFile('one')]: '{}', [sessionFile('two')]: '{}'
  } });
  assert.equal(ipc.invoke('session:delete', 'one'), true);
  assert.equal(mem.exists(sessionFile('one')), false);
  assert.equal(mem.exists(sessionFile('two')), true);
  assert.equal(ipc.invoke('session:delete', 'missing'), true);
  assert.ok(logs.some((log) => log[1] === 'session'));
});

test('session: clear removes only session JSON files', () => {
  const notes = path.join(userData, 'sessions', 'notes.txt');
  const { ipc, mem } = setup({ files: { [sessionFile('one')]: '{}', [sessionFile('two')]: '{}', [notes]: 'keep' } });
  assert.equal(ipc.invoke('session:clear'), true);
  assert.equal(mem.exists(sessionFile('one')), false);
  assert.equal(mem.exists(sessionFile('two')), false);
  assert.equal(mem.content(notes), 'keep');
});

test('session: deletion and clear failures are returned as false', () => {
  const { ipc, mem } = setup({ files: { [sessionFile('one')]: '{}' } });
  mem.fs.rmSync = () => { throw new Error('access denied'); };
  assert.equal(ipc.invoke('session:delete', 'one'), false);
  assert.equal(ipc.invoke('session:clear'), false);
  assert.equal(setup().ipc.invoke('session:clear'), false);
});

test('session: export renders supported transcript entries and skips metadata', () => {
  const { ipc } = setup({ files: { [sessionFile('one')]: JSON.stringify({
    task: 'export task', ts: 1700000000000, status: 'stopped', log: [
      { kind: 'meta', text: 'omit metadata' }, { kind: 'user_msg', text: 'followup' },
      { kind: 'text', text: 'answer' }, { kind: 'tool_call', name: 'read_file' },
      { kind: 'change', relPath: 'a.txt', path: 'absolute-a' }, { kind: 'change', path: 'fallback.txt' },
      { kind: 'error', text: 'failure' }, { kind: 'tool_result', result: 'omit raw result' }
    ]
  }) } });
  const exported = ipc.invoke('session:export', 'one');
  for (const expected of ['# export task', '状态 stopped', '## 任务\nfollowup', '**Agent**：answer', '`read_file`', '`a.txt`', '`fallback.txt`', '**错误**：failure']) {
    assert.ok(exported.includes(expected), expected);
  }
  assert.equal(exported.includes('omit'), false);
});

test('session: export defaults and missing/corrupt export paths', () => {
  const { ipc } = setup({ files: {
    [sessionFile('empty')]: JSON.stringify({ ts: 1700000000000 }), [sessionFile('bad')]: '{bad'
  } });
  assert.match(ipc.invoke('session:export', 'empty'), /# Agent 会话/);
  assert.match(ipc.invoke('session:export', 'empty'), /状态 done/);
  assert.equal(ipc.invoke('session:export', 'missing'), null);
  assert.equal(ipc.invoke('session:export', 'bad'), null);
});

test('session: revert restores old text, including empty and null snapshots', async () => {
  const file = path.join(workspace, 'revert.txt');
  const { module, mem, ipc, window } = setup({ files: { [file]: 'new' } });
  for (const before of ['old', '', null]) {
    assert.equal(await module.revertFile({ path: file, before, existed: true }), true);
    assert.equal(mem.content(file), before ?? '');
  }
  assert.equal(await ipc.invoke('fs:revert', { path: file, before: 'ipc', existed: true }), true);
  assert.equal(mem.content(file), 'ipc');
  assert.deepEqual(window.sent.at(-1), { channel: 'fs:changed', payload: { path: file } });
});

test('session: reverting a new or already absent file is idempotent', async () => {
  const file = path.join(workspace, 'new.txt');
  const { module, mem } = setup({ files: { [file]: 'created' } });
  assert.equal(await module.revertFile({ path: file, existed: false }), true);
  assert.equal(mem.exists(file), false);
  assert.equal(await module.revertFile({ path: file, existed: false }), true);
});

test('session: revert works without a live window', async () => {
  for (const window of [null, Object.assign(createWindow(), {})]) {
    if (window) window.destroy();
    const file = path.join(workspace, 'file.txt');
    const { module, mem } = setup({ files: { [file]: 'new' }, window });
    assert.equal(await module.revertFile({ path: file, before: 'old', existed: true }), true);
    assert.equal(mem.content(file), 'old');
    if (window) assert.equal(window.sent.length, 0);
  }
});

test('session: failed revert propagates and does not notify the renderer', async () => {
  const { module, mem, window } = setup();
  mem.fs.promises.writeFile = async () => { throw new Error('write denied'); };
  await assert.rejects(module.revertFile({ path: 'file', existed: true, before: 'old' }), /write denied/);
  assert.equal(window.sent.length, 0);
});

/* ---- Trajectory 导出（阶段2新增） ---- */
test('session: exportTrajectory md 含工具调用/结果/耗时与变更汇总', () => {
  const { module, ipc } = setup();
  // 造一个含完整事件流的会话
  module.saveSession({
    id: 'traj-1', task: '重构工具函数', cwd: workspace, status: 'done',
    log: [
      { kind: 'user_msg', text: '把 utils 里的格式化抽成函数' },
      { kind: 'tool_call', name: 'read_file', args: { path: 'src/utils.js' } },
      { kind: 'tool_result', name: 'read_file', result: 'export function f() {}', ms: 42 },
      { kind: 'change', path: workspace + '/src/utils.js', relPath: 'src/utils.js', before: 'a\nb\n', after: 'a\nb\nc\n', existed: true },
      { kind: 'text', text: '已抽成 formatDate 函数。' }
    ],
    changes: [{ path: workspace + '/src/utils.js', relPath: 'src/utils.js', before: 'a\nb\n', after: 'a\nb\nc\n', existed: true }]
  });
  const md = ipc.invoke('session:exportTrajectory', { id: 'traj-1', format: 'md' });
  assert.match(md, /# 重构工具函数/);
  assert.match(md, /read_file/);
  assert.match(md, /42ms/, 'md 应包含工具耗时');
  assert.match(md, /变更汇总/);
  assert.match(md, /src\/utils\.js/);
});

test('session: exportTrajectory json 返回完整事件流', () => {
  const { module, ipc } = setup();
  module.saveSession({
    id: 'traj-2', task: 'json 导出', cwd: workspace, status: 'done',
    log: [{ kind: 'text', text: 'hi' }], changes: []
  });
  const json = ipc.invoke('session:exportTrajectory', { id: 'traj-2', format: 'json' });
  const parsed = JSON.parse(json);
  assert.equal(parsed.id, 'traj-2');
  assert.equal(parsed.task, 'json 导出');
  assert.ok(Array.isArray(parsed.log));
});

test('session: exportTrajectory 优先读内存 agents（未落盘的运行中会话）', () => {
  // 注入 agents Map：内存命中时不应依赖磁盘
  const mem = createMemoryFs({});
  const logs = [];
  const agents = new Map([['live-1', {
    id: 'live-1', task: '内存会话', cwd: workspace, status: 'running',
    log: [{ kind: 'text', text: '进行中' }], changes: []
  }]]);
  const module = loadModule('modules/session.js', {
    requires: { fs: mem.fs, electron: { app: { getPath: () => userData } } },
    globals: { process: { env: {} }, console: { error: () => undefined } }
  }).createSessionModule({ winRef: () => createWindow(), addLog: (...a) => logs.push(a), agents });
  const ipc = createIpc();
  module.register(ipc);
  // 磁盘上没有 live-1.json，只有内存有
  const md = ipc.invoke('session:exportTrajectory', { id: 'live-1', format: 'md' });
  assert.match(md, /# 内存会话/);
  assert.match(md, /进行中/);
});

test('session: exportTrajectory 对不存在的会话返回 null', () => {
  const { ipc } = setup();
  const out = ipc.invoke('session:exportTrajectory', { id: 'nope-404', format: 'md' });
  assert.equal(out, null);
});
