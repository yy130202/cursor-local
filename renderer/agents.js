/* Cursor Local - Agents Window：并行 Agent 工作台 + 流式输出 + diff 审阅 + 历史会话 */
const agentsState = {
  agents: new Map(),   // id -> { id, task, cwd, status, entries: [], readonly? }
  selectedId: null,
  history: []          // 历史会话列表（session:list）
};

const agentListEl = document.getElementById('agent-list');
const transcriptEl = document.getElementById('transcript');
const agentsEmptyEl = document.getElementById('agents-empty');
const mainHeadEl = document.getElementById('agents-main-head');

/* ---- 新建 Agent / followup 输入 ---- */
document.getElementById('new-agent-btn').onclick = () => {
  document.getElementById('followup-input').focus();
};

document.getElementById('agent-stop-btn').onclick = () => {
  if (agentsState.selectedId) window.api.stopAgent(agentsState.selectedId);
};

/* 底部 follow-up 输入框：选中已结束的 Agent 则续跑，否则新建 */
async function sendFollowup() {
  const input = document.getElementById('followup-input');
  const task = input.value.trim();
  if (!task) { input.focus(); return; }
  const sel = agentsState.agents.get(agentsState.selectedId);
  const canFollow = sel && !sel.readonly && !sel.id.startsWith('hist-') && sel.status !== 'running';
  if (canFollow) {
    const r = await window.api.followAgent(sel.id, task);
    if (!r.ok) { input.value = ''; flashComposer(r.error); return; }
    input.value = '';
  } else {
    const cwd = EditorState.currentFolder || '';
    const r = await window.api.createAgent({ task, cwd });
    input.value = '';
    selectAgent(r.id);
  }
}

function flashComposer(msg) {
  const input = document.getElementById('followup-input');
  input.placeholder = msg || '出错了，请重试';
  setTimeout(() => { input.placeholder = '添加后续任务…（Enter 发送）'; }, 2500);
}

document.getElementById('followup-send').onclick = sendFollowup;
document.getElementById('followup-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
});

/* ---- 流式累积辅助 ---- */
function closeStreaming(a) {
  const last = a.entries[a.entries.length - 1];
  if (last && last.streaming) last.streaming = false;
}

/* ---- Agent 事件流 ---- */
window.api.onAgentEvent((ev) => {
  let a = agentsState.agents.get(ev.id);
  if (!a) {
    a = { id: ev.id, task: '', cwd: '', status: 'running', entries: [] };
    agentsState.agents.set(ev.id, a);
  }
  switch (ev.kind) {
    case 'meta':
      a.task = ev.task; a.cwd = ev.cwd; a.ts = ev.ts || Date.now();
      a.entries.push({ kind: 'user', text: ev.task });
      if (typeof window.updateIsland === 'function') window.updateIsland('running', 'Agent 运行中 · ' + (ev.task || '').slice(0, 24));
      break;
    case 'user_msg':
      closeStreaming(a);
      a.entries.push({ kind: 'user', text: ev.text });
      break;
    case 'text_delta': {
      const last = a.entries[a.entries.length - 1];
      if (last && last.kind === 'agent-msg' && last.streaming) {
        last.text += ev.text;
      } else {
        a.entries.push({ kind: 'agent-msg', text: ev.text, streaming: true });
      }
      break;
    }
    case 'text':
      closeStreaming(a);
      a.entries.push({ kind: 'agent-msg', text: ev.text });
      break;
    case 'tool_call':
      closeStreaming(a);
      a.entries.push({ kind: 'tool', name: ev.name, args: ev.args });
      break;
    case 'tool_result': {
      for (let i = a.entries.length - 1; i >= 0; i--) {
        if (a.entries[i].kind === 'tool' && a.entries[i].name === ev.name && !a.entries[i].result) {
          a.entries[i].result = ev.result;
          break;
        }
      }
      break;
    }
    case 'change':
      closeStreaming(a);
      a.entries.push({ kind: 'change', path: ev.path, relPath: ev.relPath, before: ev.before, after: ev.after, existed: ev.existed });
      break;
    case 'error':
      closeStreaming(a);
      a.entries.push({ kind: 'error', text: ev.text });
      break;
    case 'status':
      a.status = ev.status;
      if (ev.status !== 'running') closeStreaming(a);
      if (typeof window.updateIsland === 'function') {
        if (ev.status === 'done') window.updateIsland('done', 'Agent 任务完成');
        else if (ev.status === 'error') window.updateIsland('error', 'Agent 执行出错');
        else if (ev.status === 'stopped') window.updateIsland('idle');
      }
      break;
  }
  renderAgentList();
  if (ev.id === agentsState.selectedId) renderTranscript();
});

/* ---- 渲染 ---- */
function statusLabel(s) {
  return { running: '运行中', done: '已完成', error: '出错', stopped: '已停止' }[s] || s;
}

function renderAgentList() {
  const list = [...agentsState.agents.values()].reverse();
  agentListEl.innerHTML = '';
  for (const a of list) {
    const el = document.createElement('div');
    el.className = 'agent-item' + (a.id === agentsState.selectedId ? ' selected' : '');
    el.innerHTML =
      '<div class="row1">' +
        '<span class="dot ' + a.status + '"></span>' +
        '<span class="title">' + escapeHtml(a.task || '（未命名任务）') + '</span>' +
      '</div>' +
      '<div class="cwd">' + escapeHtml(a.cwd) + '</div>';
    el.onclick = () => selectAgent(a.id);
    agentListEl.appendChild(el);
  }
  agentsEmptyEl.style.display = list.length ? 'none' : 'flex';
  renderHistory();
}

function selectAgent(id) {
  agentsState.selectedId = id;
  renderAgentList();
  renderTranscript();
}

function argsSummary(name, args) {
  if (!args) return '';
  if (name === 'run_command') return args.command || '';
  if (name === 'write_file') return args.path || '';
  return JSON.stringify(args).slice(0, 120);
}

/* ---- 行级 diff（LCS）---- */
function lineDiff(before, after) {
  const a = (before == null ? '' : before).split('\n');
  const b = (after == null ? '' : after).split('\n');
  if (a.length > 2000 || b.length > 2000) {
    // 过大文件退回并排展示
    return { tooBig: true, before: a, after: b };
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'same', x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', x: a[i] }); i++; }
    else { out.push({ t: 'add', x: b[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', x: a[i++] });
  while (j < m) out.push({ t: 'add', x: b[j++] });
  return { lines: out };
}

function toolIconName(name) {
  return {
    list_dir: 'folder-search',
    read_file: 'file-search',
    write_file: 'file-pen',
    run_command: 'square-terminal'
  }[name] || 'wrench';
}

function buildChangeCard(en, a) {
  const card = document.createElement('div');
  card.className = 'change-card';
  const diff = lineDiff(en.before, en.after);
  let bodyHtml = '';
  if (diff.tooBig) {
    bodyHtml = '<div class="diff-note">文件过大，展示前/后并排对比</div>' +
      '<div class="diff-side"><div class="side-label">修改前</div><pre>' + escapeHtml((en.before || '').slice(0, 4000)) + '</pre></div>' +
      '<div class="diff-side"><div class="side-label">修改后</div><pre>' + escapeHtml((en.after || '').slice(0, 4000)) + '</pre></div>';
  } else {
    const rows = diff.lines.map((l) => {
      const cls = l.t === 'add' ? 'add' : (l.t === 'del' ? 'del' : 'same');
      const sign = l.t === 'add' ? '+' : (l.t === 'del' ? '-' : ' ');
      return '<div class="dl ' + cls + '"><span class="ln">' + sign + '</span><span class="dlx">' + escapeHtml(l.x) + '</span></div>';
    }).join('');
    bodyHtml = '<div class="diff-body">' + rows + '</div>';
  }
  const reverted = en.reverted;
  const ro = en.readonly;
  card.innerHTML =
    '<div class="change-head">' +
      '<span class="change-icon">' + (window.lucideIcon(ro ? 'history' : (reverted ? 'undo-2' : 'pencil')) || '') + '</span>' +
      '<span class="change-file">' + escapeHtml(en.relPath || en.path) + '</span>' +
      '<span class="change-state">' + (ro ? '历史变更' : (reverted ? '已撤销' : (en.existed ? '已修改' : '新建'))) + '</span>' +
      ((reverted || ro) ? '' : '<button class="revert-btn">' + (window.lucideIcon('undo-2') || '') + '<span>撤销改动</span></button>') +
    '</div>' + bodyHtml;
  if (!reverted && !ro) {
    card.querySelector('.revert-btn').onclick = async (e) => {
      e.stopPropagation();
      await window.api.revertChange({ path: en.path, before: en.before, existed: en.existed });
      en.reverted = true;
      renderTranscript();
    };
  }
  return card;
}

function renderTranscript() {
  const a = agentsState.agents.get(agentsState.selectedId);
  transcriptEl.innerHTML = '';
  if (!a) return;
  mainHeadEl.classList.remove('hidden');
  document.getElementById('agent-head-task').textContent = a.task;
  document.getElementById('agent-head-dot').className = 'dot ' + a.status;
  const badge = document.getElementById('agent-head-status');
  badge.textContent = statusLabel(a.status);
  document.getElementById('agent-stop-btn').style.display =
    (a.status === 'running' && !a.readonly) ? '' : 'none';

  for (const en of a.entries) {
    if (en.kind === 'user') {
      // Cursor 式用户气泡
      const d = document.createElement('div');
      d.className = 'entry user-row';
      d.innerHTML = '<div class="user-bubble">' + escapeHtml(en.text) + '</div>';
      transcriptEl.appendChild(d);
    } else if (en.kind === 'agent-msg') {
      const d = document.createElement('div');
      d.className = 'entry entry-text agent-msg' + (en.streaming ? ' streaming' : '');
      d.innerHTML = '<span class="who">Agent</span><span class="body">' + escapeHtml(en.text) + (en.streaming ? '<span class="caret">▍</span>' : '') + '</span>';
      transcriptEl.appendChild(d);
    } else if (en.kind === 'tool') {
      const d = document.createElement('div');
      d.className = 'entry';
      const card = document.createElement('div');
      card.className = 'tool-card';
      const summary = escapeHtml(argsSummary(en.name, en.args));
      card.innerHTML =
        '<div class="head">' +
          '<span class="tag ' + en.name + '">' + (window.lucideIcon(toolIconName(en.name)) || '') + en.name + '</span>' +
          '<span class="args">' + summary + '</span>' +
          '<span class="tw ' + (en.result ? (en.result.startsWith('ERROR') || en.result.includes('拦截') ? 'err' : 'ok') : 'wait') + '">' +
            (en.result ? (en.result.startsWith('ERROR') || en.result.includes('拦截') ? (window.lucideIcon('circle-x') || '') : (window.lucideIcon('circle-check') || '')) : (window.lucideIcon('loader-circle') || '')) +
          '</span>' +
        '</div>' +
        '<pre>' + escapeHtml(
          '参数:\n' + JSON.stringify(en.args || {}, null, 2) +
          (en.result ? '\n\n结果:\n' + en.result : '')
        ) + '</pre>';
      card.querySelector('.head').onclick = () => card.classList.toggle('open');
      d.appendChild(card);
      transcriptEl.appendChild(d);
    } else if (en.kind === 'change') {
      const d = document.createElement('div');
      d.className = 'entry';
      d.appendChild(buildChangeCard(en, a));
      transcriptEl.appendChild(d);
    } else if (en.kind === 'error') {
      const d = document.createElement('div');
      d.className = 'entry entry-error';
      d.innerHTML = '<span class="err-ico">' + (window.lucideIcon('alert-triangle') || '') + '</span> ' + escapeHtml(en.text);
      transcriptEl.appendChild(d);
    }
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/* ---- 历史会话（时间分组：今天 / 昨天 / 本周 / 更早） ---- */
function timeGroupOf(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const days = Math.floor((now - d) / 86400000);
  if (days < 2) return '昨天';
  if (days < 7) return '本周';
  return '更早';
}

function renderHistory() {
  const section = document.getElementById('history-section');
  const listEl = document.getElementById('history-list');
  if (!agentsState.history.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  listEl.innerHTML = '';
  let lastGroup = null;
  for (const s of agentsState.history) {
    const group = timeGroupOf(s.ts || Date.now());
    if (group !== lastGroup) {
      lastGroup = group;
      const g = document.createElement('div');
      g.className = 'list-group-label';
      g.textContent = group;
      listEl.appendChild(g);
    }
    const el = document.createElement('div');
    el.className = 'history-item';
    const time = new Date(s.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    el.innerHTML =
      '<span class="dot ' + (s.status || 'done') + '"></span>' +
      '<span class="ht">' + escapeHtml(s.task || '（会话）') + '</span>' +
      '<span class="htime">' + time + '</span>' +
      '<button class="hist-btn hist-exp" title="导出 Markdown">' + (window.lucideIcon('download') || '') + '</button>' +
      '<button class="hist-btn hist-del" title="删除会话">' + (window.lucideIcon('trash-2') || '') + '</button>';
    el.onclick = () => openHistory(s);
    el.querySelector('.hist-exp').onclick = async (e) => {
      e.stopPropagation();
      const md = await window.api.exportSession(s.id);
      if (md && typeof downloadText === 'function') downloadText('session-' + s.id + '.md', md);
      else flashStatus('导出失败');
    };
    el.querySelector('.hist-del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除该会话？')) return;
      await window.api.deleteSession(s.id);
      await loadHistory();
    };
    listEl.appendChild(el);
  }
}

function logToEntries(log) {
  const entries = [];
  for (const ev of log || []) {
    switch (ev.kind) {
      case 'meta': entries.push({ kind: 'user', text: ev.task }); break;
      case 'text': entries.push({ kind: 'agent-msg', text: ev.text }); break;
      case 'text_delta': {
        const last = entries[entries.length - 1];
        if (last && last.kind === 'agent-msg') last.text += ev.text;
        else entries.push({ kind: 'agent-msg', text: ev.text });
        break;
      }
      case 'tool_call': entries.push({ kind: 'tool', name: ev.name, args: ev.args }); break;
      case 'tool_result': {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].kind === 'tool' && entries[i].name === ev.name && !entries[i].result) { entries[i].result = ev.result; break; }
        }
        break;
      }
      case 'change': entries.push({ kind: 'change', path: ev.path, relPath: ev.relPath, before: ev.before, after: ev.after, existed: ev.existed, readonly: true }); break;
      case 'error': entries.push({ kind: 'error', text: ev.text }); break;
    }
  }
  return entries;
}

function openHistory(s) {
  const id = 'hist-' + s.id;
  agentsState.agents.set(id, {
    id, task: s.task, cwd: s.cwd, status: s.status || 'done',
    entries: logToEntries(s.log), readonly: true
  });
  selectAgent(id);
}

async function loadHistory() {
  agentsState.history = await window.api.listSessions();
  renderHistory();
}

/* ---- 截图演示 ---- */
window.__debugAgents = function () {
  return {
    agentCount: agentsState.agents.size,
    selectedId: agentsState.selectedId,
    listItems: document.getElementById('agent-list').children.length,
    transcriptEntries: document.getElementById('transcript').children.length,
    toolCards: document.getElementById('transcript').querySelectorAll('.tool-card').length,
    changeCards: document.getElementById('transcript').querySelectorAll('.change-card').length,
    historyCount: agentsState.history.length,
    emptyVisible: document.getElementById('agents-empty').style.display !== 'none',
    headTask: document.getElementById('agent-head-task').textContent,
    headStatus: document.getElementById('agent-head-status').textContent
  };
};

window.__switchToAgents = function () {
  document.getElementById('mode-agents').click();
};

window.__demoAgentEntry = function () {
  const id = 'demo-agent';
  agentsState.agents.set(id, {
    id,
    task: '阅读项目结构，为 src/utils 添加日期格式化工具函数并补全测试',
    cwd: 'H:\\workbubby\\2026-09-24-16-34-02\\cursor-clone',
    status: 'running',
    entries: [
      { kind: 'user', text: '阅读项目结构，为 src/utils 添加日期格式化工具函数并补全测试' },
      { kind: 'agent-msg', text: '好的，我先查看项目的目录结构，了解现有代码组织方式。' },
      { kind: 'tool', name: 'list_dir', args: { path: '.' }, result: 'main.js\npackage.json\nrenderer/\n  index.html\n  style.css\n  editor.js\n  agents.js\n  renderer.js' },
      { kind: 'tool', name: 'read_file', args: { path: 'package.json' }, result: '{\n  "name": "cursor-local",\n  "version": "0.1.0",\n  "main": "main.js"\n}' },
      { kind: 'change', relPath: 'src/utils/date.js', before: null, after: 'export function formatDate(d) {\n  return d.toISOString().slice(0, 10);\n}\n', existed: false },
      { kind: 'tool', name: 'run_command', args: { command: 'node --test src/utils' }, result: '退出码: 0\n✔ formatDate (2ms)\n\n1 pass, 0 fail' }
    ]
  });
  selectAgent(id);
};

/* ---- 启动时加载历史 ---- */
loadHistory();
