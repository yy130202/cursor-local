'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixtureRoot, createAgentHarness, createChild } = require('./helpers/agent-harness');

const modificationTools = ['write_file', 'create_file', 'create_dir', 'delete_file',
  'delete_path', 'move_file', 'move_path', 'apply_patch', 'run_command'];

for (const name of modificationTools) {
  test(`Ask mode rejects ${name} before invoking a handler`, async () => {
    let called = false;
    const h = createAgentHarness({ handlers: () => ({ [name]: async () => { called = true; return 'bad'; } }) });
    const result = await h.api.executeTool(h.makeAgent({ readonly: true, mode: 'ask' }), name, {});
    assert.match(result, /ERROR:.*只读/);
    assert.equal(called, false);
    assert.equal(h.spawned.length, 0);
  });
}

test('unknown tools return a diagnostic without filesystem access', async () => {
  const h = createAgentHarness();
  const result = await h.api.executeTool(h.makeAgent(), 'nonexistent', {});
  assert.match(result, /未知工具 nonexistent/);
  assert.equal(h.fs.calls.length, 0);
});

test('tool dispatch resolves paths and wraps IO errors with an error log', async () => {
  const h = createAgentHarness();
  const result = await h.api.executeTool(h.makeAgent(), 'read_file', { path: 'missing.txt' });
  assert.match(result, /^ERROR:.*ENOENT/);
  assert.ok(h.logs.some(([level, tag]) => level === 'error' && tag === 'tool'));
});

test('configuration failure defaults to restricted path access', async () => {
  const h = createAgentHarness({ loadConfig: () => { throw new Error('config unavailable'); } });
  const result = await h.api.executeTool(h.makeAgent(), 'read_file', { path: '../outside.txt' });
  assert.match(result, /沙箱拦截/);
  assert.equal(h.fs.count('readFile'), 0);
});

test('guard allows the workspace itself and rejects lexical escape and sibling prefixes', async () => {
  const h = createAgentHarness();
  await h.deps.assertRealInsideWorkspace(h.cwd, h.cwd);
  for (const target of [path.join(h.cwd, '..', 'outside.txt'), h.cwd + '-other' + path.sep + 'file.txt']) {
    await assert.rejects(h.deps.assertRealInsideWorkspace(h.cwd, target), /沙箱拦截/);
  }
});

test('guard resolves symlinks before allowing an existing file', async () => {
  const h = createAgentHarness();
  const outside = path.join(fixtureRoot, 'outside', 'secret.txt');
  h.fs.addFile(outside, 'outside-data');
  h.fs.addSymlink(path.join(h.cwd, 'linked.txt'), outside);
  const result = await h.api.executeTool(h.makeAgent(), 'read_file', { path: 'linked.txt' });
  assert.match(result, /沙箱拦截/);
  assert.equal(h.fs.count('readFile'), 0);
});

test('guard rejects creation through an external symlink even when several parents are missing', async () => {
  const h = createAgentHarness();
  const outside = path.join(fixtureRoot, 'outside');
  h.fs.addDirectory(outside);
  h.fs.addSymlink(path.join(h.cwd, 'link'), outside);
  const result = await h.api.executeTool(h.makeAgent(), 'write_file',
    { path: 'link/new/deeper/file.txt', content: 'must not be written' });
  assert.match(result, /沙箱拦截/);
  assert.equal(h.fs.count('writeFile'), 0);
  assert.equal(h.fs.count('mkdir'), 0);
});

test('guard permits creating nested paths inside the workspace', async () => {
  const h = createAgentHarness();
  const result = await h.api.executeTool(h.makeAgent(), 'write_file', { path: 'new/deeper/file.txt', content: 'ok' });
  assert.match(result, /^\[OK\]/);
  assert.equal(h.fs.peek(path.join(h.cwd, 'new/deeper/file.txt')), 'ok');
});

test('guard permits legitimate dot-prefixed child names and links inside the workspace', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, '..notes', 'a.txt'), 'dot-prefixed')
    .addFile(path.join(h.cwd, 'src', 'a.txt'), 'inside')
    .addSymlink(path.join(h.cwd, 'alias'), path.join(h.cwd, 'src'));
  const agent = h.makeAgent();
  assert.equal(await h.api.executeTool(agent, 'read_file', { path: '..notes/a.txt' }), 'dot-prefixed');
  assert.equal(await h.api.executeTool(agent, 'read_file', { path: 'alias/a.txt' }), 'inside');
});

test('guard uses lexical fallback if the workspace cannot be resolved', async () => {
  const h = createAgentHarness();
  h.fs.promises.realpath = async () => { throw new Error('realpath unavailable'); };
  await h.deps.assertRealInsideWorkspace(h.cwd, path.join(h.cwd, 'new.txt'));
  await assert.rejects(h.deps.assertRealInsideWorkspace(h.cwd, path.join(h.cwd, '..', 'outside.txt')), /沙箱拦截/);
});

test('full-control mode skips the path guard while restricted modes enforce it', async () => {
  const h = createAgentHarness({ config: { permission: 'full' } });
  const outside = path.join(fixtureRoot, 'outside.txt');
  h.fs.addFile(outside, 'allowed-with-full-permission');
  assert.equal(await h.api.executeTool(h.makeAgent(), 'read_file', { path: outside }), 'allowed-with-full-permission');
  assert.equal(h.fs.count('realpath'), 0);
  h.cfg.permission = 'manual';
  assert.match(await h.api.executeTool(h.makeAgent(), 'read_file', { path: outside }), /沙箱拦截/);
});

test('Plan mode blocks tool execution without touching the filesystem', async () => {
  const h = createAgentHarness();
  const agent = h.makeAgent({ mode: 'plan' });
  const result = await h.api.executeTool(agent, 'write_file', { path: 'plan.txt', content: 'bad' });
  assert.match(result, /ERROR:.*计划/);
  assert.equal(h.fs.count('writeFile'), 0);
  assert.equal(h.spawned.length, 0);
});

test('list_dir defaults to cwd, sorts directories first and names alphabetically', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'z.txt'), 'z').addFile(path.join(h.cwd, 'a.txt'), 'a')
    .addDirectory(path.join(h.cwd, 'zdir')).addDirectory(path.join(h.cwd, 'adir'));
  assert.equal(await h.api.executeTool(h.makeAgent(), 'list_dir', {}), 'adir/\nzdir/\na.txt\nz.txt');
});

test('list_dir handles an empty directory and limits output to 300 entries', async () => {
  const h = createAgentHarness();
  assert.equal(await h.api.executeTool(h.makeAgent(), 'list_dir', { path: '.' }), '[空目录]');
  for (let i = 0; i < 305; i++) h.fs.addFile(path.join(h.cwd, `file-${i}.txt`), 'x');
  const listed = await h.api.executeTool(h.makeAgent(), 'list_dir', { path: h.cwd });
  assert.equal(listed.split('\n').length, 300);
});

test('list_tree skips dependencies and git directories and respects the requested depth', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'src/sub/deep.txt'), 'x')
    .addFile(path.join(h.cwd, 'src/a.js'), 'x')
    .addFile(path.join(h.cwd, 'node_modules/hidden.js'), 'x')
    .addFile(path.join(h.cwd, '.git/hidden'), 'x');
  const listed = await h.api.executeTool(h.makeAgent(), 'list_tree', { depth: 1 });
  assert.equal(listed, 'src/\n  sub/\n  a.js');
  assert.doesNotMatch(listed, /node_modules|\.git|deep\.txt/);
});

test('list_tree uses a default depth, caps it at six and caps each directory at 60 entries', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'a/b/c/d/e/f/g/h.txt'), 'deep');
  const deep = await h.api.executeTool(h.makeAgent(), 'list_tree', { depth: 99 });
  assert.match(deep, /g\//);
  assert.doesNotMatch(deep, /h\.txt/);
  const usual = await h.api.executeTool(h.makeAgent(), 'list_tree', {});
  assert.match(usual, /d\//);
  assert.doesNotMatch(usual, /e\//);
  const empty = path.join(h.cwd, 'empty');
  h.fs.addDirectory(empty);
  assert.equal(await h.api.executeTool(h.makeAgent(), 'list_tree', { path: empty }), '[空]');
  for (let i = 0; i < 70; i++) h.fs.addFile(path.join(empty, `file-${i}`), 'x');
  assert.equal((await h.api.executeTool(h.makeAgent(), 'list_tree', { path: empty })).split('\n').length, 60);
});

test('list_tree tolerates an unreadable subtree', async () => {
  const h = createAgentHarness();
  h.fs.promises.readdir = async () => { throw new Error('unreadable'); };
  assert.equal(await h.api.executeTool(h.makeAgent(), 'list_tree', {}), '[空]');
});

test('read_file distinguishes empty content and truncates oversized content', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'empty.txt'), '').addFile(path.join(h.cwd, 'large.txt'), 'a'.repeat(80001));
  assert.equal(await h.api.executeTool(h.makeAgent(), 'read_file', { path: 'empty.txt' }), '[空文件]');
  const large = await h.api.executeTool(h.makeAgent(), 'read_file', { path: 'large.txt' });
  assert.equal(large, 'a'.repeat(80000) + '\n...[文件过长已截断]');
  h.fs.addFile(path.join(h.cwd, 'boundary.txt'), 'b'.repeat(80000));
  assert.equal((await h.api.executeTool(h.makeAgent(), 'read_file', { path: 'boundary.txt' })).length, 80000);
});

test('write_file records original content for rollback and notifies the renderer', async () => {
  const h = createAgentHarness();
  const agent = h.makeAgent();
  const file = path.join(h.cwd, 'a.txt');
  h.fs.addFile(file, 'before');
  const result = await h.api.executeTool(agent, 'write_file', { path: 'a.txt', content: 'after' });
  assert.match(result, /5 字符/);
  assert.equal(h.fs.peek(file), 'after');
  assert.deepEqual(agent.changes, [{ path: file, relPath: 'a.txt', before: 'before', after: 'after', existed: true }]);
  assert.equal(agent.log.filter((e) => e.kind === 'change').length, 1);
  assert.ok(h.ui.sent.some((e) => e.channel === 'fs:changed' && e.payload.path === file));
});

test('write_file records new-file provenance and skips redundant changes', async () => {
  const h = createAgentHarness();
  const agent = h.makeAgent();
  await h.api.executeTool(agent, 'write_file', { path: 'new.txt' });
  assert.equal(agent.changes[0].before, null);
  assert.equal(agent.changes[0].after, '');
  assert.equal(agent.changes[0].existed, false);
  await h.api.executeTool(agent, 'write_file', { path: 'new.txt', content: '' });
  assert.equal(agent.changes.length, 1);
  assert.equal(h.fs.count('writeFile'), 2);
});

test('file writes succeed without an available renderer window', async () => {
  for (const absent of [true, false]) {
    const h = createAgentHarness({ winRef: absent ? () => null : undefined });
    h.ui.window.destroyed = true;
    assert.match(await h.api.executeTool(h.makeAgent(), 'write_file', { path: 'a.txt', content: 'a' }), /\[OK\]/);
    assert.equal(h.ui.sent.length, 0);
  }
});

test('delete_file is forced and nonrecursive and refreshes the changed path', async () => {
  const h = createAgentHarness();
  const file = path.join(h.cwd, 'a.txt');
  h.fs.addFile(file, 'a');
  assert.match(await h.api.executeTool(h.makeAgent(), 'delete_file', { path: 'a.txt' }), /已删除/);
  assert.equal(h.fs.existsSync(file), false);
  assert.deepEqual(h.fs.calls.find((c) => c.method === 'rm').args, [file, { recursive: false, force: true }]);
  assert.deepEqual(h.ui.sent.find((e) => e.channel === 'fs:changed').payload, { path: file });
  h.fs.addFile(path.join(h.cwd, 'directory/keep.txt'), 'keep');
  assert.match(await h.api.executeTool(h.makeAgent(), 'delete_file', { path: 'directory' }), /ERROR:.*ENOTEMPTY/);
  assert.equal(h.fs.peek(path.join(h.cwd, 'directory/keep.txt')), 'keep');
});

test('move_file checks both endpoints and creates the destination parent', async () => {
  const h = createAgentHarness();
  const agent = h.makeAgent();
  h.fs.addFile(path.join(h.cwd, 'a.txt'), 'content');
  assert.match(await h.api.executeTool(agent, 'move_file', { from: 'a.txt', to: '../outside.txt' }), /沙箱拦截/);
  assert.equal(h.fs.count('rename'), 0);
  assert.match(await h.api.executeTool(agent, 'move_file', { from: 'a.txt', to: 'new/b.txt' }), /已移动/);
  assert.equal(h.fs.peek(path.join(h.cwd, 'new/b.txt')), 'content');
  assert.equal(h.fs.existsSync(path.join(h.cwd, 'a.txt')), false);
});

test('get_file_info describes files, directories and files without an extension', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'a.js'), 'abc').addFile(path.join(h.cwd, 'LICENSE'), 'x');
  assert.match(await h.api.executeTool(h.makeAgent(), 'get_file_info', { path: 'a.js' }), /大小: 3 字节[\s\S]*类型: js 文件/);
  assert.match(await h.api.executeTool(h.makeAgent(), 'get_file_info', { path: '.' }), /类型: 目录/);
  assert.match(await h.api.executeTool(h.makeAgent(), 'get_file_info', { path: 'LICENSE' }), /类型: 无 文件/);
});

test('search_files is case-insensitive, emits relative line numbers and excludes generated directories', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'src/a.js'), 'first\nNEEDLE match\nlast')
    .addFile(path.join(h.cwd, 'node_modules/hidden.js'), 'needle')
    .addFile(path.join(h.cwd, '.git/hidden'), 'needle')
    .addFile(path.join(h.cwd, 'dist/hidden.js'), 'needle')
    .addFile(path.join(h.cwd, 'large.txt'), 'needle' + 'x'.repeat(500000));
  const result = await h.api.executeTool(h.makeAgent(), 'search_files', { pattern: 'needle' });
  assert.equal(result, path.join('src', 'a.js') + ':2: NEEDLE match');
  assert.equal(await h.api.executeTool(h.makeAgent(), 'search_files', { pattern: 'absent' }), '[无匹配]');
});

test('search_files refuses to read an external symlink encountered below the root', async () => {
  const h = createAgentHarness();
  const outside = path.join(fixtureRoot, 'outside', 'secret.txt');
  h.fs.addFile(outside, 'sensitive needle');
  h.fs.addSymlink(path.join(h.cwd, 'linked.txt'), outside);
  assert.equal(await h.api.executeTool(h.makeAgent(), 'search_files', { pattern: 'needle' }), '[无匹配]');
  assert.equal(h.fs.count('readFile'), 0);
});

test('recursive search uses the agent workspace guard rather than restricting links to its starting folder', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'src', 'local.txt'), 'needle local')
    .addFile(path.join(h.cwd, 'shared', 'a.txt'), 'needle shared')
    .addSymlink(path.join(h.cwd, 'src', 'linked.txt'), path.join(h.cwd, 'shared', 'a.txt'));
  const result = await h.api.executeTool(h.makeAgent(), 'search_files', { path: 'src', pattern: 'needle' });
  assert.match(result, /local\.txt:1: needle local/);
  assert.match(result, /linked\.txt:1: needle shared/);
});

test('full-control recursive search permits external links while restricted search blocks them', async () => {
  const h = createAgentHarness({ config: { permission: 'full' } });
  const outside = path.join(fixtureRoot, 'outside', 'full.txt');
  h.fs.addFile(outside, 'needle full').addSymlink(path.join(h.cwd, 'linked.txt'), outside);
  assert.equal(await h.api.executeTool(h.makeAgent(), 'search_files', { pattern: 'needle' }), 'linked.txt:1: needle full');
  h.cfg.permission = 'safe';
  assert.equal(await h.api.executeTool(h.makeAgent(), 'search_files', { pattern: 'needle' }), '[无匹配]');
});

test('a failed write does not record a change or notify the renderer', async () => {
  const h = createAgentHarness();
  h.fs.promises.writeFile = async () => { throw new Error('disk full'); };
  const agent = h.makeAgent();
  assert.equal(await h.api.executeTool(agent, 'write_file', { path: 'denied.txt', content: 'data' }), 'ERROR: disk full');
  assert.equal(agent.changes, undefined);
  assert.equal(h.ui.sent.some((event) => event.channel === 'fs:changed'), false);
});

test('list_tree does not descend through directory entries resolving outside the workspace', async () => {
  const h = createAgentHarness();
  const outside = path.join(fixtureRoot, 'outside-tree');
  h.fs.addFile(path.join(outside, 'secret.txt'), 'outside');
  h.fs.addSymlink(path.join(h.cwd, 'linked-dir'), outside);
  // A junction/host filesystem may present an entry as a directory. The guard
  // must still verify its real path rather than trusting the directory bit.
  const readdir = h.fs.promises.readdir;
  h.fs.promises.readdir = async (...args) => {
    const entries = await readdir(...args);
    if (args[0] === h.cwd) for (const ent of entries) if (ent.name === 'linked-dir') ent.isDirectory = () => true;
    return entries;
  };
  const result = await h.api.executeTool(h.makeAgent(), 'list_tree', {});
  assert.doesNotMatch(result, /secret\.txt/);
  assert.equal(h.fs.calls.some((c) => c.method === 'readdir' && c.args[0] === path.join(h.cwd, 'linked-dir')), false);
});

test('searchInDir caps results, limits line length and stops at maximum depth', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'a.txt'), Array.from({ length: 60 }, () => 'needle' + 'x'.repeat(200)).join('\n'));
  const hits = await h.deps.searchInDir(h.cwd, 'needle');
  assert.equal(hits.length, 50);
  assert.equal(hits[0].split(': ')[1].length, 160);
  assert.equal((await h.deps.searchInDir(h.cwd, 'needle', 2)).length, 2);
  const deep = path.join(h.cwd, ...Array.from({ length: 11 }, (_, i) => 'd' + i), 'deep.txt');
  h.fs.addFile(deep, 'only-deep');
  assert.deepEqual(await h.deps.searchInDir(h.cwd, 'only-deep'), []);
});

test('searchInDir ignores unreadable directories and files without failing the search', async () => {
  const h = createAgentHarness();
  h.fs.addFile(path.join(h.cwd, 'a.txt'), 'needle');
  h.fs.promises.readFile = async () => { throw new Error('cannot read'); };
  assert.deepEqual(await h.deps.searchInDir(h.cwd, 'needle'), []);
  h.fs.promises.readdir = async () => { throw new Error('cannot list'); };
  assert.deepEqual(await h.deps.searchInDir(h.cwd, 'needle'), []);
});

const dangerousCommands = [
  'rm -rf folder', 'rm -fr folder', 'rm -r -f folder', 'rm -f -r folder',
  'rm --recursive folder', 'rm --force folder', 'rd /s folder', 'rd /q folder',
  'rmdir /s /q folder', 'del /f file', 'del /s /q file',
  'Remove-Item -r folder', 'Remove-Item -Recurse folder', 'Remove-Item -Force file',
  'format Z:', 'mkfs.ext4 virtual-device', 'dd if=input of=output', 'shutdown /s', 'reboot',
  'diskpart', 'chmod -R 777 folder', 'git push --force', 'npm publish', 'npm unpublish',
  'cipher /w:folder', 'takeown /r folder', 'reg delete test-key', 'find folder -delete',
  'mv file /dev/null', 'RM "-rf" folder', 'rm\t-r\n-f folder',
  '\u001b[31mshutdown\u001b[0m /s', 'sh\\utdown /s', ':(){ :|:& };:'
];

for (const command of dangerousCommands) {
  test(`restricted command filtering blocks ${JSON.stringify(command)} without spawning`, async () => {
    const h = createAgentHarness({ spawn: () => {
      const child = createChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    } });
    const result = await h.api.executeTool(h.makeAgent(), 'run_command', { command });
    assert.match(result, /已拦截危险命令/);
    assert.equal(h.spawned.length, 0);
  });
}

for (const command of ['format Z:', 'mkfs.ext4 disk', 'dd if=input of=output', 'shutdown /s',
  'reboot', 'diskpart', ':(){ :|:& };:']) {
  test(`full control still rejects catastrophic command ${JSON.stringify(command)}`, async () => {
    const h = createAgentHarness({ config: { permission: 'full' }, spawn: () => {
      const child = createChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    } });
    assert.match(await h.api.executeTool(h.makeAgent(), 'run_command', { command }), /已拦截危险命令/);
    assert.equal(h.spawned.length, 0);
  });
}

test('ordinary development commands pass both command filters', () => {
  const h = createAgentHarness();
  for (const command of ['git status', 'npm test', 'node --version']) {
    assert.equal(h.deps.checkDangerousCommand(command), null);
    assert.equal(h.deps.checkCatastrophic(command), null);
  }
});

test('run_command forwards cwd and exit output and reports nonzero exits', async () => {
  const child = createChild();
  const h = createAgentHarness({ spawn: () => child });
  const agent = h.makeAgent();
  const promise = h.api.executeTool(agent, 'run_command', { command: 'npm test' });
  await Promise.resolve();
  child.stdout.emit('data', Buffer.from('out'));
  child.stderr.emit('data', Buffer.from('warning'));
  child.emit('close', 7);
  assert.equal(await promise, '退出码: 7\nout\n[stderr]\nwarning');
  assert.equal(h.spawned[0][0], 'npm test');
  assert.equal(h.spawned[0][1].cwd, h.cwd);
  assert.equal(agent.children.size, 0);
  assert.equal(h.timers.pending.size, 0);
  assert.ok(h.logs.some(([level, , message]) => level === 'warning' && /退出码 7/.test(message)));
});

test('full-control command execution permits noncatastrophic commands and logs permission use', async () => {
  const child = createChild();
  const h = createAgentHarness({ config: { permission: 'full' }, spawn: () => child });
  const promise = h.api.executeTool(h.makeAgent(), 'run_command', { command: 'git push --force' });
  await Promise.resolve();
  child.emit('close', 0);
  assert.equal(await promise, '退出码: 0\n[无输出]');
  assert.ok(h.logs.some(([level, , message]) => level === 'warning' && /完全控制/.test(message)));
  assert.ok(h.logs.some(([level]) => level === 'info'));
});

test('run_command supplies its fallback command when no command argument is provided', async () => {
  const child = createChild();
  const h = createAgentHarness({ spawn: () => child });
  const promise = h.api.executeTool(h.makeAgent(), 'run_command', {});
  await Promise.resolve();
  child.emit('close', 0);
  assert.equal(h.spawned[0][0], 'echo no-command');
  assert.match(await promise, /退出码: 0/);
});
