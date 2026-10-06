'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const projectRoot = path.resolve(__dirname, '../..');
const workspace = path.resolve(projectRoot, '.unit-workspace');
const userData = path.resolve(projectRoot, '.unit-user-data');

// Compile the unmodified CommonJS source with explicit host dependencies. Each
// test gets isolated globals without touching require.cache or process.env.
function loadModule(relativePath, options = {}, extraGlobals = {}) {
  const structured = Object.hasOwn(options, 'requires') || Object.hasOwn(options, 'globals');
  const requires = structured ? (options.requires || {}) : options;
  const globals = structured ? (options.globals || {}) : extraGlobals;
  const filename = path.join(projectRoot, relativePath);
  const module = { exports: {} };
  const actualRequire = createRequire(filename);
  const injected = {
    process: { env: {}, platform: process.platform },
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => { throw new Error('Unexpected network request'); },
    ...globals
  };
  const requireStub = (id) => {
    if (Object.hasOwn(requires, id)) return requires[id];
    if (['fs', 'node:fs', 'electron', 'child_process', 'node:child_process'].includes(id)) {
      throw new Error('Missing test double for ' + id);
    }
    return actualRequire(id);
  };
  const compiled = vm.compileFunction(
    fs.readFileSync(filename, 'utf8'),
    ['require', 'module', 'exports', '__filename', '__dirname', ...Object.keys(injected)],
    { filename }
  );
  compiled(requireStub, module, module.exports, filename, path.dirname(filename), ...Object.values(injected));
  return module.exports;
}

function fsError(code, pathname) {
  const error = new Error(code + ': ' + pathname);
  error.code = code;
  return error;
}

// All paths and contents below live in a Map. No test reads or writes app data.
function createMemoryFs(initial = {}) {
  const nodes = new Map();
  const calls = [];
  const normalize = (p) => path.resolve(String(p));
  const ensureDirectory = (p) => {
    p = normalize(p);
    if (nodes.has(p)) return;
    const parent = path.dirname(p);
    if (parent !== p) ensureDirectory(parent);
    nodes.set(p, { type: 'directory' });
  };
  const realpath = (input, seen = 0) => {
    if (seen > 40) throw fsError('ELOOP', input);
    const p = normalize(input);
    const root = path.parse(p).root;
    const parts = p.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    if (!nodes.has(root)) throw fsError('ENOENT', p);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const entry = nodes.get(current);
      if (!entry) throw fsError('ENOENT', current);
      if (entry.type === 'link') {
        return realpath(path.resolve(path.dirname(current), entry.target, ...parts.slice(i + 1)), seen + 1);
      }
      if (i < parts.length - 1 && entry.type !== 'directory') throw fsError('ENOTDIR', current);
    }
    return current;
  };
  const destination = (p) => {
    p = normalize(p);
    try { return realpath(p); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return path.join(realpath(path.dirname(p)), path.basename(p));
    }
  };
  const methods = {
    existsSync(p) {
      try { realpath(p); return true; } catch { return false; }
    },
    realpathSync(p) { return realpath(p); },
    mkdirSync(p, options = {}) {
      p = normalize(p);
      if (methods.existsSync(p)) return;
      if (options.recursive) methods.mkdirSync(path.dirname(p), options);
      const target = destination(p);
      nodes.set(target, { type: 'directory' });
    },
    readFileSync(p, encoding) {
      const entry = nodes.get(realpath(p));
      if (entry.type !== 'file') throw fsError('EISDIR', p);
      return encoding ? entry.content : Buffer.from(entry.content);
    },
    writeFileSync(p, content) {
      nodes.set(destination(p), { type: 'file', content: String(content), mtimeMs: 1700000000000 });
    },
    readdirSync(p, options = {}) {
      const dir = realpath(p);
      if (nodes.get(dir).type !== 'directory') throw fsError('ENOTDIR', p);
      const entries = [...nodes].filter(([name]) => name !== dir && path.dirname(name) === dir);
      return entries.map(([name, entry]) => options.withFileTypes ? {
        name: path.basename(name),
        isDirectory: () => entry.type === 'directory',
        isSymbolicLink: () => entry.type === 'link'
      } : path.basename(name));
    },
    statSync(p) {
      const entry = nodes.get(realpath(p));
      return {
        size: entry.type === 'file' ? Buffer.byteLength(entry.content) : 0,
        mtimeMs: entry.mtimeMs || 1700000000000,
        isDirectory: () => entry.type === 'directory'
      };
    },
    rmSync(p, options = {}) {
      const target = normalize(p);
      if (!nodes.has(target)) {
        if (options.force) return;
        throw fsError('ENOENT', p);
      }
      const descendants = [...nodes.keys()].filter((name) => name.startsWith(target + path.sep));
      if (descendants.length && !options.recursive) throw fsError('ENOTEMPTY', p);
      for (const name of descendants) nodes.delete(name);
      nodes.delete(target);
    },
    renameSync(from, to) {
      from = realpath(from);
      to = destination(to);
      const moved = [...nodes].filter(([name]) => name === from || name.startsWith(from + path.sep));
      for (const [name, entry] of moved) {
        nodes.set(to + name.slice(from.length), entry);
        nodes.delete(name);
      }
    }
  };
  ensureDirectory(workspace);
  ensureDirectory(userData);
  for (const [name, value] of Object.entries(initial)) {
    const p = normalize(name);
    ensureDirectory(path.dirname(p));
    if (value === null) ensureDirectory(p);
    else if (value && typeof value === 'object' && value.link) nodes.set(p, { type: 'link', target: value.link });
    else nodes.set(p, { type: 'file', content: String(value), mtimeMs: 1700000000000 });
  }
  const fakeFs = {};
  for (const [name, fn] of Object.entries(methods)) {
    fakeFs[name] = (...args) => { calls.push({ method: name, args }); return fn(...args); };
  }
  fakeFs.promises = {};
  for (const [asyncName, syncName] of Object.entries({
    realpath: 'realpathSync', mkdir: 'mkdirSync', readFile: 'readFileSync',
    writeFile: 'writeFileSync', readdir: 'readdirSync', stat: 'statSync',
    rm: 'rmSync', rename: 'renameSync'
  })) {
    fakeFs.promises[asyncName] = async (...args) => {
      calls.push({ method: asyncName, args });
      return methods[syncName](...args);
    };
  }
  const mem = {
    fs: fakeFs, calls, nodes,
    content: (p) => methods.readFileSync(p, 'utf8'),
    exists: (p) => methods.existsSync(p),
    set: (p, content) => {
      ensureDirectory(path.dirname(normalize(p)));
      methods.writeFileSync(p, content);
    }
  };
  Object.assign(fakeFs, {
    calls,
    count: (method) => calls.filter((call) => call.method === method).length,
    peek: mem.content,
    addFile: (p, content) => { mem.set(p, content); return fakeFs; },
    addDirectory: (p) => { ensureDirectory(p); return fakeFs; },
    addSymlink: (p, target) => {
      ensureDirectory(path.dirname(normalize(p)));
      nodes.set(normalize(p), { type: 'link', target });
      return fakeFs;
    }
  });
  return mem;
}

function createIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error('Duplicate IPC channel ' + channel);
      handlers.set(channel, fn);
    },
    invoke: (channel, ...args) => {
      if (!handlers.has(channel)) throw new Error('Unregistered IPC channel ' + channel);
      return handlers.get(channel)({}, ...args);
    }
  };
}

function createWindow() {
  const sent = [];
  const window = {
    sent, destroyed: false,
    destroy: () => { window.destroyed = true; },
    isDestroyed: () => window.destroyed,
    webContents: { send: (channel, payload) => { sent.push({ channel, payload }); } }
  };
  return window;
}

function createTimers() {
  const pending = new Map();
  let sequence = 0;
  return {
    pending,
    setTimeout(fn, ms) {
      const id = ++sequence;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    fire(ms) {
      for (const [id, timer] of [...pending]) {
        if (timer.ms !== ms || !pending.has(id)) continue;
        pending.delete(id);
        timer.fn();
      }
    },
    fireAll() {
      for (const [id, { fn }] of [...pending]) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        fn();
      }
    }
  };
}

function createChild(pid = 42) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); };
  return child;
}

function sseResponse(deltas, { chunks, trailingNewline = true } = {}) {
  const text = deltas.map((delta) => 'data: ' + JSON.stringify({ choices: [{ delta }] })).join('\n') + (trailingNewline ? '\ndata: [DONE]\n' : '');
  const buffers = chunks || [Buffer.from(text)];
  let index = 0;
  return {
    ok: true,
    body: { getReader: () => ({
      read: async () => index < buffers.length ? { done: false, value: buffers[index++] } : { done: true }
    }) }
  };
}

function createAgentHarness({ files = {}, config = {}, memory, capture = false, env = {}, platform = process.platform,
  handlers, loadConfig, addLog: addLogImpl, winRef, spawn: spawnImpl, fetch: fetchImpl } = {}) {
  const mem = createMemoryFs(files);
  const window = createWindow();
  const timers = createTimers();
  const ipc = createIpc();
  const agents = new Map();
  const saved = [];
  const logs = [];
  const requests = [];
  const replies = [];
  const spawns = [];
  const children = [];
  const cfg = { apiKey: 'unit-test-key', baseUrl: 'https://unit.invalid/v1/', model: 'test-model', permission: 'safe', ...config };
  let deps;
  const module = loadModule('modules/agent.js', {
    requires: {
      fs: mem.fs,
      child_process: { spawn: (...args) => {
        spawns.push(args);
        return spawnImpl ? spawnImpl(...args) : children.shift() || createChild(spawns.length);
      } },
      './agent/tools': { createToolHandlers: (injected) => {
        deps = injected;
        if (handlers) return handlers(injected);
        if (capture) return {};
        return require('../../modules/agent/tools').createToolHandlers(injected);
      } }
    },
    globals: {
      process: { env: { ...env }, platform },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      fetch: async (url, options) => {
        const request = [url, options];
        Object.assign(request, { url, options, body: JSON.parse(options.body) });
        requests.push(request);
        if (fetchImpl) return fetchImpl(url, options);
        const response = replies.length ? replies.shift() : sseResponse([{ content: '完成' }]);
        return typeof response === 'function' ? response() : response;
      }
    }
  }).createAgentModule({
    winRef: winRef || (() => window),
    addLog: (...args) => {
      logs.push(args);
      if (addLogImpl) return addLogImpl(...args);
    },
    loadConfig: loadConfig || (() => cfg),
    agents, saveSession: (agent) => saved.push(agent), rootDir: workspace, memory
  });
  module.register(ipc);
  const agent = {
    id: 'unit-agent', task: 'unit task', cwd: workspace, mode: 'craft',
    readonly: false, status: 'running', log: [], messages: [], children: new Set()
  };
  let agentSequence = 0;
  const makeAgent = (patch = {}) => {
    const created = {
      ...agent, id: 'test-agent-' + (++agentSequence), log: [], messages: [], children: new Set(), ...patch
    };
    agents.set(created.id, created);
    return created;
  };
  return {
    module, mem, window, timers, ipc, agents, saved, logs, requests, replies, spawns, children, config: cfg, deps, agent,
    api: module, fs: mem.fs, ui: { window, sent: window.sent }, cwd: workspace,
    cfg, spawned: spawns, makeAgent
  };
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected async condition was not reached');
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const sse = (delta) => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n';
const streamResponse = (chunks) => sseResponse([], {
  chunks: chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
});

module.exports = {
  projectRoot, workspace, userData, fixtureRoot: userData, loadModule, createMemoryFs, createIpc,
  createWindow, createTimers, createChild, sseResponse, createAgentHarness, until, fsError,
  deferred, sse, streamResponse
};
