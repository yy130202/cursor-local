/* 性能实测脚手架：极简 DOM 替身 + 埋点计数器
 * 目的：在 Node 里以真实代码路径加载 renderer/agents.js，统计 renderTranscript /
 *       renderAgentList 的 DOM 重建次数与耗时，用于改造前/后 A/B 对比。
 * 用法：const { loadAgents, makeEnv } = require('./dom-harness.js');
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- 埋点计数器 ---------- */
function newCounters() {
  return {
    transcriptCalls: 0,      // renderTranscript 调用次数
    transcriptMs: 0,         // renderTranscript 累计耗时
    entriesBuilt: 0,         // 实际构造 DOM 的 entry 数（重建次数）
    entriesTotal: 0,         // 遍历到的 entry 总数（应重建次数）
    listCalls: 0,            // renderAgentList 调用次数
    listRowsBuilt: 0,        // 实际构造 DOM 的列表行数
    historyCalls: 0,         // renderHistory 调用次数（级联浪费的度量）
    historyRowsBuilt: 0,
    miniMarkdownCalls: 0,
    lineDiffCalls: 0,        // lineDiff 调用（含缓存命中）
    lineDiffHits: 0,         // 记忆化命中次数
    lineDiffMiss: 0,
    nodesCreated: 0,         // document.createElement('div') 次数
    innerHTMLWrites: 0,      // el.innerHTML = ... 赋值次数
    appends: 0,              // appendChild 次数
    replaces: 0,             // replaceChild 次数
    removes: 0,              // removeChild / remove 次数
    fullResets: 0            // transcriptEl.innerHTML = '' 全量清空次数
  };
}

/* ---------- 极简 DOM 节点 ---------- */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._html = '';
    this.className = '';
    this._style = {};
    this.dataset = {};
    this.isConnected = false;
    this._text = '';
    this._id = '';
    this._scrollTop = 0;
  }
  get id() { return this._id; }
  set id(v) { this._id = v; }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
  get style() { return this._style; }
  set style(v) { this._style = v; }
  get scrollTop() { return this._scrollTop || 0; }
  set scrollTop(v) { this._scrollTop = v; }
  get scrollHeight() { return this.children.length * 40; }
  get offsetHeight() { return 400; }
  getContent() { return this; }
  focus() {}
  blur() {}
  click() { if (this.onclick) this.onclick({ stopPropagation() {}, preventDefault() {} }); }
  get classList() {
    const self = this;
    return {
      add(...c) { for (const x of c) if (!self._cls().includes(x)) self.className = (self.className + ' ' + x).trim(); },
      remove(...c) {
        const cur = self._cls();
        const next = cur.filter((x) => !c.includes(x));
        self.className = next.join(' ');
      },
      contains(c) { return self._cls().includes(c); },
      toggle(c, force) {
        const has = self._cls().includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) this.add(c);
        else if (!want && has) this.remove(c);
        return want;
      }
    };
  }
  _cls() { return String(this.className || '').split(/\s+/).filter(Boolean); }
  get className() { return this._clsValue || ''; }
  set className(v) { this._clsValue = String(v == null ? '' : v); }
  get textContent() {
    if (this._text !== '' && this.children.length === 0) return this._text;
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v == null ? '' : v);
    if (COUNTERS) COUNTERS.innerHTMLWrites++;
    // 简化的 innerHTML 解析：抽出常见标签以支持 querySelector 语义
    const kids = [];
    const re = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>|<(\w+)([^>]*)\/>/g;
    let m;
    while ((m = re.exec(this._html))) {
      if (m[4]) { kids.push(this._make(m[4], m[5])); continue; }
      const child = this._make(m[1], m[2]);
      const inner = m[3];
      // 递归处理一层嵌套
      const sub = new El('div');
      sub.innerHTML = inner;
      for (const g of sub.children) child.children.push(g);
      if (!/\n\s*$/.test(inner) && inner.trim()) child._text += '';
      kids.push(child);
    }
    this.children = kids;
    for (const k of kids) { k.parentNode = this; k.isConnected = this.isConnected; }
  }
  _make(tag, attrs) {
    const e = new El(tag);
    const cls = /class="([^"]*)"/.exec(attrs || '');
    if (cls) e.className = cls[1];
    const idm = /id="([^"]*)"/.exec(attrs || '');
    if (idm) e.id = idm[1];
    const dm = /data-code="([^"]*)"/.exec(attrs || '');
    if (dm) e.dataset.code = dm[1];
    return e;
  }
  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    child.isConnected = this.isConnected || this.tagName === 'BODY' || this._isRoot();
    if (COUNTERS) COUNTERS.appends++;
    return child;
  }
  _isRoot() { return this.tagName === 'HTML' || this.tagName === 'BODY'; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); if (COUNTERS) COUNTERS.removes++; }
    child.parentNode = null;
    child.isConnected = false;
    return child;
  }
  replaceChild(nw, old) {
    const i = this.children.indexOf(old);
    if (i >= 0) {
      this.children[i] = nw;
      nw.parentNode = this;
      nw.isConnected = this.isConnected;
      old.parentNode = null;
      old.isConnected = false;
      if (COUNTERS) COUNTERS.replaces++;
    }
    return old;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
    else { this.isConnected = false; }
  }
  after(node) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    node.parentNode = p;
    p.children.splice(i + 1, 0, node);
    node.isConnected = p.isConnected;
  }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.children[p.children.indexOf(this) + 1] || null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  /* 仅支持源码实际用到的选择器：单类名（.foo）、标签名，以及后代组合（'.a .b'） */
  querySelectorAll(sel) {
    const chain = String(sel).trim().split(/\s+/).filter(Boolean);
    const out = [];
    const matchFrom = (node, ci) => {
      if (matchSimple(node, chain[ci])) {
        if (ci === chain.length - 1) out.push(node);
        else for (const c of node.children) matchFrom(c, ci + 1);
      }
      for (const c of node.children) matchFrom(c, ci);
    };
    for (const c of this.children) matchFrom(c, 0);
    return out;
  }
}
function matchSimple(node, sel) {
  if (!sel) return false;
  if (sel.startsWith('.')) return node._cls().includes(sel.slice(1));
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  return node.tagName.toLowerCase() === sel.toLowerCase();
}

/* 供节点读取 classList 时用 */
let COUNTERS = null;

/* ---------- 文档 ---------- */
function makeDocument(ids, counters) {
  const registry = new Map();
  const mk = (id) => { const e = new El('div'); e.id = id; return e; };
  ids.forEach((id) => registry.set(id, mk(id)));
  const doc = {
    createElement(tag) {
      const e = new El(tag);
      if (COUNTERS) COUNTERS.nodesCreated++;
      return e;
    },
    createTextNode(t) { const e = new El('#text'); e._text = String(t); return e; },
    getElementById(id) { return registry.get(id) || null; },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    addEventListener() {},
    removeEventListener() {},
    body: new El('body')
  };
  doc.body.isConnected = true;
  // 收集所有需要可查询的元素挂到 body，模拟真实 DOM 树
  ids.forEach((id) => { const e = registry.get(id); e.isConnected = true; doc.body.children.push(e); });
  doc.documentElement = new El('html');
  doc.documentElement.isConnected = true;
  doc.documentElement.appendChild(doc.body);
  doc.head = new El('head');
  return { doc, registry };
}

/* ---------- 环境 ---------- */
function makeEnv(src, opts = {}) {
  COUNTERS = countersRef.current;
  const ids = opts.ids || DEFAULT_IDS;
  const { doc, registry } = makeDocument(ids, COUNTERS);
  const events = [];
  const win = {
    api: {
      onAgentEvent(cb) { events.push(cb); },
      listSessions: async () => (opts.sessions || []),
      clearSessions: async () => { opts.sessions = []; },
      deleteSession: async () => {},
      exportSession: async () => {},
      createAgent: async () => {},
      followAgent: async () => {},
      revertChange: async () => {},
      stopAgent: async () => {},
      agentApproval: async () => {}
    },
    lucideIcon: (n) => '<i data-lucide="' + n + '"></i>',
    updateIsland: () => {},
    extractMentions: () => [],
    _: (s) => String(s),
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error,
    console, structuredClone,
    navigator: { clipboard: { writeText: async () => {} } },
    document: doc,
    performance: globalThis.performance,
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { reload() {} }
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.document.defaultView = win;
  const ctx = vm.createContext(win);
  ctx.globalThis = ctx;
  const CL = {
    util: {
      escapeHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
    }
  };
  ctx.CL = CL;
  const module = { exports: {} };
  ctx.module = module;
  ctx.exports = module.exports;
  ctx.__COUNTERS = COUNTERS;
  vm.runInContext(src, ctx, { filename: opts.filename || 'agents.js', timeout: 30000 });
  countersRef.current = COUNTERS;
  return { ctx, win, doc, registry, events, module, CL, counters: () => COUNTERS };
}
const countersRef = { current: null };

const DEFAULT_IDS = [
  'agent-list', 'transcript', 'agents-empty', 'agents-main-head', 'new-agent-btn',
  'agent-stop-btn', 'followup-send', 'followup-input', 'agent-head-task',
  'agent-head-dot', 'agent-head-status', 'agent-run-dial', 'agent-run-ring',
  'agent-run-time', 'history-list', 'history-filter', 'history-clear',
  'history-section', 'mode-agents', 'stat-sessions'
];

module.exports = { newCounters, makeEnv, El, DEFAULT_IDS };