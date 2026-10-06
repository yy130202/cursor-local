'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const projectRoot = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(projectRoot, '.unit-fixture');

function loadModule(relativePath, dependencies, globals) {
  const filename = path.join(projectRoot, relativePath);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const evaluate = vm.compileFunction(fs.readFileSync(filename, 'utf8'),
    ['exports', 'require', 'module', '__filename', '__dirname', 'process', 'fetch', 'setTimeout', 'clearTimeout'],
    { filename });
  const localRequire = (id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (['fs', 'node:fs', 'electron', 'child_process', 'node:child_process'].includes(id)) {
      throw new Error('Missing test double for ' + id);
    }
    return realRequire(id);
  };
  evaluate(module.exports, localRequire, module, filename, path.dirname(filename),
    globals.process, globals.fetch, globals.setTimeout, globals.clearTimeout);
  return module.exports;
}

function fileError(code, filename) {
  const err = new Error(`${code}: ${filename}`);
  err.code = code;
  return err;
}

// The only real filesystem reads in this helper load the source under test.
// Fixture operations below use a Map, including symlinks and missing parents.
function createMemoryFs() {
  const nodes = new Map();
  const calls = [];
  const normalize = (p) => path.resolve(String(p));

  function ensureDirs(p) {
    const absolute = normalize(p);
    const parent = path.dirname(absolute);
    if (parent !== absolute) ensureDirs(parent);
    if (!nodes.has(absolute)) nodes.set(absolute, { type: 'directory' });
  }

  function resolveExisting(p, seen = new Set()) {
    const absolute = normalize(p);
    if (seen.has(absolute)) throw fileError('ELOOP', absolute);
    let current = path.parse(absolute).root;
    const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const node = nodes.get(current);
      if (!node) throw fileError('ENOENT', current);
      if (node.type === 'symlink') {
        seen.add(absolute);
        const target = path.resolve(path.dirname(current), node.target);
        return resolveExisting(path.join(target, ...parts.slice(i + 1)), seen);
      }
      if (i < parts.length - 1 && node.type !== 'directory') throw fileError('ENOTDIR', current);
    }
    if (!nodes.has(current)) throw fileError('ENOENT', current);
    return current;
  }

  function readFile(p, encoding) {
    const absolute = resolveExisting(p);
    const node = nodes.get(absolute);
    if (node.type !== 'file') throw fileError('EISDIR', absolute);
    return encoding ? node.content.toString(encoding) : Buffer.from(node.content);
  }

  function writeFile(p, content, encoding) {
    const absolute = normalize(p);
    const parent = resolveExisting(path.dirname(absolute));
    let target = path.join(parent, path.basename(absolute));
    if (nodes.get(target)?.type === 'symlink') target = resolveExisting(target);
    nodes.set(target, { type: 'file', content: Buffer.from(content, encoding), mtimeMs: 1700000000000 });
  }

  function readdir(p, options) {
    const absolute = resolveExisting(p);
    if (nodes.get(absolute).type !== 'directory') throw fileError('ENOTDIR', absolute);
    const entries = [...nodes].filter(([key]) => key !== absolute && path.dirname(key) === absolute);
    if (!options?.withFileTypes) return entries.map(([key]) => path.basename(key));
    return entries.map(([key, node]) => ({
      name: path.basename(key), isDirectory: () => node.type === 'directory',
      isFile: () => node.type === 'file', isSymbolicLink: () => node.type === 'symlink'
    }));
  }

  function rm(p, options = {}) {
    const absolute = normalize(p);
    let target;
    try { target = path.join(resolveExisting(path.dirname(absolute)), path.basename(absolute)); }
    catch (err) { if (options.force && err.code === 'ENOENT') return; throw err; }
    if (!nodes.has(target)) {
      if (options.force) return;
      throw fileError('ENOENT', target);
    }
    const children = [...nodes.keys()].filter((key) => key.startsWith(target + path.sep));
    if (children.length && !options.recursive) throw fileError('ENOTEMPTY', target);
    for (const key of children) nodes.delete(key);
    nodes.delete(target);
  }

  function mkdir(p, options = {}) {
    const absolute = normalize(p);
    if (options.recursive) {
      if (nodes.has(absolute)) { resolveExisting(absolute); return; }
      mkdir(path.dirname(absolute), options);
    }
    const parent = resolveExisting(path.dirname(absolute));
    nodes.set(path.join(parent, path.basename(absolute)), { type: 'directory' });
  }

  function stat(p) {
    const node = nodes.get(resolveExisting(p));
    return { size: node.content?.length || 0, mtimeMs: node.mtimeMs || 1700000000000,
      isDirectory: () => node.type === 'directory' };
  }

  function rename(from, to) {
    const source = path.join(resolveExisting(path.dirname(from)), path.basename(from));
    if (!nodes.has(source)) throw fileError('ENOENT', source);
    const dest = path.join(resolveExisting(path.dirname(to)), path.basename(to));
    for (const [key, node] of [...nodes]) {
      if (key === source || key.startsWith(source + path.sep)) {
        nodes.delete(key);
        nodes.set(dest + key.slice(source.length), node);
      }
    }
  }

  const implementation = { readFile, writeFile, readdir, rm, mkdir, stat, rename,
    realpath: resolveExisting,
    exists: (p) => { try { resolveExisting(p); return true; } catch { return false; } } };
  const fake = { calls, nodes, promises: {} };
  for (const [name, fn] of Object.entries(implementation)) {
    fake[name + 'Sync'] = (...args) => { calls.push({ method: name + 'Sync', args }); return fn(...args); };
    fake.promises[name] = async (...args) => { calls.push({ method: name, args }); return fn(...args); };
  }
  fake.addDirectory = (p) => { ensureDirs(p); return fake; };
  fake.addFile = (p, text) => { ensureDirs(path.dirname(normalize(p))); writeFile(p, text, 'utf8'); return fake; };
  fake.addSymlink = (p, target) => {
    ensureDirs(path.dirname(normalize(p)));
    nodes.set(normalize(p), { type: 'symlink', target: normalize(target) });
    return fake;
  };
  fake.count = (method) => calls.filter((call) => call.method === method).length;
  fake.peek = (p) => readFile(p, 'utf8');
  ensureDirs(fixtureRoot);
  return fake;
}

function createIpc() {
  const handlers = new Map();
  return { handlers,
    handle(name, handler) {
      if (handlers.has(name)) throw new Error('Duplicate IPC handler: ' + name);
      handlers.set(name, handler);
    },
    invoke(name, ...args) {
      if (!handlers.has(name)) throw new Error('Missing IPC handler: ' + name);
      return handlers.get(name)({}, ...args);
    }
  };
}

function createWindow() {
  const sent = [];
  const window = { destroyed: false, isDestroyed() { return this.destroyed; },
    webContents: { send(channel, payload) { sent.push({ channel, payload }); } } };
  return { window, sent, winRef: () => window };
}

function createTimers() {
  let nextId = 0;
  const pending = new Map();
  return { pending,
    setTimeout(fn, ms) { const id = ++nextId; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fire(ms) {
      for (const [id, timer] of [...pending]) {
        if (ms === undefined || timer.ms === ms) { pending.delete(id); timer.fn(); }
      }
    }
  };
}

function createChild(pid = 123) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => child.killed.push(signal);
  return child;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  const bytes = chunks.map((chunk) => typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  let index = 0;
  return { ok: true, body: { getReader: () => ({
    read: async () => index < bytes.length ? { done: false, value: bytes[index++] } : { done: true }
  }) } };
}

function sse(delta) { return 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n'; }

function createAgentHarness(options = {}) {
  const fakeFs = options.fs || createMemoryFs();
  const cwd = path.join(fixtureRoot, 'workspace');
  fakeFs.addDirectory(cwd);
  const ui = createWindow(), ipc = createIpc(), timers = createTimers();
  const logs = [], saved = [], spawned = [], requests = [];
  const agents = new Map();
  const cfg = { apiKey: 'unit-test-key', baseUrl: 'https://unit.invalid/v1///',
    model: 'test-model', permission: 'safe', ...options.config };
  let injected;
  const realCreate = require('../../modules/agent/tools').createToolHandlers;
  const createToolHandlers = (deps) => {
    injected = deps;
    return options.handlers ? options.handlers(deps) : realCreate(deps);
  };
  const fetch = async (...args) => {
    requests.push(args);
    return options.fetch ? options.fetch(...args) : streamResponse([sse({ content: '完成' })]);
  };
  const spawn = (...args) => {
    spawned.push(args);
    return options.spawn ? options.spawn(...args) : createChild();
  };
  const { createAgentModule } = loadModule('modules/agent.js', {
    fs: fakeFs, child_process: { spawn }, './agent/tools': { createToolHandlers }
  }, { process: { env: options.env || {}, platform: options.platform || process.platform },
    fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const api = createAgentModule({ winRef: options.winRef || ui.winRef,
    addLog: (...args) => {
      logs.push(args);
      if (options.addLog) return options.addLog(...args);
    }, loadConfig: options.loadConfig || (() => cfg),
    agents, saveSession: (agent) => saved.push(agent), rootDir: cwd, memory: options.memory });
  api.register(ipc);
  let agentSeq = 0;
  const makeAgent = (patch = {}) => {
    const agent = { id: 'unit-' + (++agentSeq), task: '核心逻辑测试', cwd, mode: 'craft',
      readonly: false, status: 'running', messages: [], log: [], children: new Set(), ...patch };
    agents.set(agent.id, agent);
    return agent;
  };
  return { api, deps: injected, fs: fakeFs, cwd, ui, ipc, timers, logs, saved,
    spawned, requests, agents, cfg, makeAgent };
}

module.exports = { fixtureRoot, createAgentHarness, createChild, deferred, streamResponse, sse };
