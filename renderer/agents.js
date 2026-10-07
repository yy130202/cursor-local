/* Cursor Local - Agents Window：并行 Agent 工作台 + 流式输出 + diff 审阅 + 历史会话 */
/* 思考框阶段文案（无 reasoning 流时轮播） */
const THINK_PHASES = ['正在分析', '正在查阅代码', '正在组织方案', '正在执行', '正在校验结果'];

const agentsState = {  agents: new Map(),   // id -> { id, task, cwd, status, entries: [], readonly? }
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
  const raw = input.value.trim();
  if (!raw) { input.focus(); return; }
  const { task, context } = window.extractMentions ? window.extractMentions(raw) : { task: raw, context: '' };
  const fullTask = (context + task).trim();
  const sel = agentsState.agents.get(agentsState.selectedId);
  const canFollow = sel && !sel.readonly && !sel.id.startsWith('hist-') && sel.status !== 'running';
  if (canFollow) {
    const r = await window.api.followAgent(sel.id, fullTask);
    if (!r.ok) { input.value = ''; flashComposer(r.error); return; }
    input.value = '';
  } else {
    const cwd = EditorState.currentFolder || '';
    const r = await window.api.createAgent({ task: fullTask, cwd, mode: window.__agentMode || 'craft' });
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
  a.__streamNode = null;
  a.__streamNodeEntry = null;
  a.__streamLen = 0;
  a.__liveEntry = null;
  a.__liveCard = null;
}

/* 帧节流：把高频 DOM 写入合并到下一帧（cmd_delta / 流式追加），
   避免每个 token 都触发一次布局。退化环境无 rAF 时退回 setTimeout。 */
const scheduleFrame = typeof requestAnimationFrame === 'function'
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);

/* ---- 运行时长表盘（UI 灵感风：SVG 圆环） ---- */
let dialTimer = null, dialAgentId = null;
function startDial(a) {
  const dial = document.getElementById('agent-run-dial');
  if (!dial) return;
  if (dialAgentId !== a.id && dialTimer) { clearInterval(dialTimer); dialTimer = null; }
  dial.style.display = '';
  dial.classList.remove('done');
  if (!a.__startTs) a.__startTs = a.ts || Date.now();
  if (dialTimer) return;
  dialAgentId = a.id;
  const ring = document.getElementById('agent-run-ring');
  const txt = document.getElementById('agent-run-time');
  const C = 2 * Math.PI * 15.5;
  if (ring) ring.style.strokeDasharray = C;
  const update = () => {
    const sec = Math.max(0, Math.floor((Date.now() - a.__startTs) / 1000));
    if (txt) txt.textContent = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0');
    if (ring) ring.style.strokeDashoffset = C * (1 - (sec % 60) / 60); // 60s 一圈循环
  };
  update();
  dialTimer = setInterval(update, 1000);
}
function stopDial(success) {
  if (dialTimer) { clearInterval(dialTimer); dialTimer = null; }
  const dial = document.getElementById('agent-run-dial');
  if (!dial) return;
  if (success) {
    dial.classList.add('done');
    const ring = document.getElementById('agent-run-ring');
    if (ring) ring.style.strokeDashoffset = 0;
    const txt = document.getElementById('agent-run-time');
    if (txt) txt.textContent = '✓';
  } else {
    dial.style.display = 'none';
  }
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
      a.__reasoning = ''; // 新任务：清空上一轮思考流
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
      a.__streamDelta = true; // 标记为流式增量，可跳过整树重建
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
    case 'approval':
      closeStreaming(a);
      a.entries.push({ kind: 'approval', callId: ev.callId, tool: ev.tool, args: ev.args });
      break;
    case 'reasoning_delta': {
      // 推理流：思考框内逐字追加（增量 DOM，不整树重绘）
      a.__reasoning = (a.__reasoning || '') + ev.text;
      let box = transcriptEl.querySelector('.th-reason');
      if (!box) { renderTranscript(); break; } // 首次：重建思考框
      box.textContent = a.__reasoning;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      return;
    }
    case 'cmd_delta': {
      // 命令输出实时流式：最近未完成的 run_command 卡片实时追加
      for (let i = a.entries.length - 1; i >= 0; i--) {
        if (a.entries[i].kind === 'tool' && a.entries[i].name === 'run_command' && !a.entries[i].result) {
          a.entries[i].live = (a.entries[i].live || '') + ev.chunk;
          const cards = transcriptEl.querySelectorAll('.tool-card');
          const lastCard = cards[cards.length - 1];
          if (lastCard) {
            let res = lastCard.querySelector('.tool-result');
            if (!res) {
              res = document.createElement('div');
              res.className = 'tool-result';
              lastCard.querySelector('.head').after(res);
            }
            res.textContent = a.entries[i].live;
            transcriptEl.scrollTop = transcriptEl.scrollHeight;
          }
          break;
        }
      }
      return; // 不触发 renderTranscript，避免高频重绘
    }
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
      // 环境光反馈：运行辉光呼吸 / 完成绿色脉冲
      if (ev.status === 'running') document.body.classList.add('aura-running');
      else {
        document.body.classList.remove('aura-running');
        if (ev.status === 'done') {
          document.body.classList.add('aura-done');
          setTimeout(() => document.body.classList.remove('aura-done'), 1200);
        }
      }
      if (ev.status !== 'running') {
        closeStreaming(a);
        // 完成后截断 entries，防超长会话内存累积
        if (a.entries.length > 200) a.entries.splice(0, a.entries.length - 200);
      }
      if (typeof window.updateIsland === 'function') {
        if (ev.status === 'done') window.updateIsland('done', 'Agent 任务完成');
        else if (ev.status === 'error') window.updateIsland('error', 'Agent 执行出错');
        else if (ev.status === 'stopped') window.updateIsland('idle');
      }
      break;
  }
  // 流式增量：只更新当前流式节点的文本，避免每个 delta 都整树重建
  if (a.__streamDelta) {
    a.__streamDelta = false;
    const node = a.__streamNode;
    if (node && ev.id === agentsState.selectedId) {
      const body = node.querySelector('.body');
      const last = a.entries[a.entries.length - 1];
      if (body && last && last.streaming) {
        body.innerHTML = CL.util.escapeHtml(last.text) + '<span class="caret">▍</span>';
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
        return;
      }
    }
  }
  renderAgentList();
  if (ev.id === agentsState.selectedId) renderTranscript();
});

/* ---- 渲染 ---- */
function statusLabel(s) {
  return { running: '运行中', done: '已完成', error: '出错', stopped: '已停止' }[s] || s;
}

/* Agent 列表：按签名增量更新（原先每个事件都全量重建 40 个节点，
   并级联 renderHistory —— 历史列表与 agent 事件无关，纯属浪费）。
   签名：task + cwd + status + 是否选中。任一变化才重建该行。 */
function agentItemSig(a) {
  return a.task + '' + a.cwd + '' + a.status + '' + (a.id === agentsState.selectedId ? '1' : '0');
}

function renderAgentList() {
  const list = [...agentsState.agents.values()].reverse();
  const items = agentsState.__listItems || (agentsState.__listItems = []);
  // 数量变化 → 增删尾部节点；数量不变 → 逐行按签名复用
  for (let i = list.length; i < items.length; i++) {
    if (items[i]) items[i].remove();
  }
  items.length = list.length;
  let structural = false;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const sig = agentItemSig(a);
    let el = items[i];
    if (el && el.__sig !== sig && el.isConnected) {
      el.innerHTML =
        '<div class="row1">' +
          '<span class="dot ' + a.status + '"></span>' +
          '<span class="title">' + CL.util.escapeHtml(a.task || '（未命名任务）') + '</span>' +
        '</div>' +
        '<div class="cwd">' + CL.util.escapeHtml(a.cwd) + '</div>';
      el.__sig = sig;
      if (el.__id !== a.id) { el.__id = a.id; el.onclick = () => selectAgent(el.__id); }
    } else if (!el) {
      el = document.createElement('div');
      el.className = 'agent-item';
      el.innerHTML =
        '<div class="row1">' +
          '<span class="dot ' + a.status + '"></span>' +
          '<span class="title">' + CL.util.escapeHtml(a.task || '（未命名任务）') + '</span>' +
        '</div>' +
        '<div class="cwd">' + CL.util.escapeHtml(a.cwd) + '</div>';
      el.__sig = sig;
      el.__id = a.id;
      el.onclick = () => selectAgent(el.__id);
      agentListEl.appendChild(el);
      items[i] = el;
      structural = true;
    }
    const wantCls = 'agent-item' + (a.id === agentsState.selectedId ? ' selected' : '');
    if (el.className !== wantCls) el.className = wantCls;
  }
  const emptyDisp = list.length ? 'none' : 'flex';
  if (agentsEmptyEl.style.display !== emptyDisp) agentsEmptyEl.style.display = emptyDisp;
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
/* 记忆化：同一份 before/after 反复重建卡片时避免重算 O(n·m) LCS。
   以内容本身为键（变更卡内容不会原地改写），容量上限 24 条，超出按插入顺序淘汰。 */
const diffCache = new Map();
function lineDiff(before, after) {
  const key = (before == null ? '' : before) + '\u0001' + (after == null ? '' : after);
  const hit = diffCache.get(key);
  if (hit) return hit;
  const r = computeLineDiff(before, after);
  if (diffCache.size >= 24) diffCache.delete(diffCache.keys().next().value);
  diffCache.set(key, r);
  return r;
}

function computeLineDiff(before, after) {
  const a = (before == null ? '' : before).split('\n');
  const b = (after == null ? '' : after).split('\n');
  if (a.length > 500 || b.length > 500) {
    // 过大文件退回并排展示
    return { tooBig: true, before: a, after: b };
  }
  const n = a.length, m = b.length;
  // 扁平 Int32Array 存 DP 表：与二维数组同算法同结果，但内存连续、分配更快
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w, next = row + w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'same', x: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ t: 'del', x: a[i] }); i++; }
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
      '<div class="diff-side"><div class="side-label">修改前</div><pre>' + CL.util.escapeHtml((en.before || '').slice(0, 4000)) + '</pre></div>' +
      '<div class="diff-side"><div class="side-label">修改后</div><pre>' + CL.util.escapeHtml((en.after || '').slice(0, 4000)) + '</pre></div>';
  } else {
    const rows = diff.lines.map((l) => {
      const cls = l.t === 'add' ? 'add' : (l.t === 'del' ? 'del' : 'same');
      const sign = l.t === 'add' ? '+' : (l.t === 'del' ? '-' : ' ');
      return '<div class="dl ' + cls + '"><span class="ln">' + sign + '</span><span class="dlx">' + CL.util.escapeHtml(l.x) + '</span></div>';
    }).join('');
    bodyHtml = '<div class="diff-body">' + rows + '</div>';
  }
  const reverted = en.reverted;
  const ro = en.readonly;
  card.innerHTML =
    '<div class="change-head">' +
      '<span class="change-icon">' + (window.lucideIcon(ro ? 'history' : (reverted ? 'undo-2' : 'pencil')) || '') + '</span>' +
      '<span class="change-file">' + CL.util.escapeHtml(en.relPath || en.path) + '</span>' +
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

/* ---- 渲染 ----
 *
 * 增量策略：每个 entry 用「渲染签名」判断是否需要重建 DOM。
 *  - sigOf(entry) 覆盖该类型 entry 的全部可见状态（result / live / reverted / resolved / 文本）；
 *  - 签名一致 → 直接复用已渲染节点，跳过 miniMarkdown、事件重绑与 diff 重算；
 *  - 签名变化 → 只重建这一个节点，并原地 replaceChild 保持位置（不产生滚动跳动）。
 * 对照原实现：原先每个非流式事件都会 innerHTML='' 重建整棵 transcript，
 * 现在 tool_result / change / approval 等事件只触碰受影响的那一个卡片。
 */
function sigOf(en) {
  switch (en.kind) {
    case 'user': return 'u:' + en.text;
    case 'agent-msg': return 'm:' + (en.streaming ? '1' : '0') + ':' + en.text;
    case 'tool': return 't:' + en.name + ':' + (en.result ? 1 : 0) + ':' + (en.live ? en.live.length : 0);
    case 'approval': return 'a:' + (en.resolved ? (en.allowed ? '1' : '0') : 'p');
    case 'change': return 'c:' + (en.reverted ? '1' : '0');
    case 'error': return 'e:' + en.text;
    default: return 'x:' + en.kind;
  }
}

/* 构造单个 entry 的 DOM 节点；needStreamNode 标记流式消息节点供增量追加复用 */
function buildEntryNode(en, isLast) {
  const inCls = isLast ? ' entry-in' : ''; // 仅最新消息播放入场动效，避免整树重播
  const d = document.createElement('div');
  if (en.kind === 'user') {
    // Cursor 式用户气泡
    d.className = 'entry user-row' + inCls;
    d.innerHTML = '<div class="user-bubble">' + CL.util.escapeHtml(en.text) + '</div>';
    return { node: d };
  }
  if (en.kind === 'agent-msg') {
    d.className = 'entry entry-text agent-msg' + (en.streaming ? ' streaming' : '') + inCls;
    const body = en.streaming ? CL.util.escapeHtml(en.text) : miniMarkdown(en.text);
    d.innerHTML = '<span class="who">Agent</span><span class="body">' + body + (en.streaming ? '<span class="caret">▍</span>' : '') + '</span>';
    // 代码块复制按钮
    d.querySelectorAll('.md-copy').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        try { navigator.clipboard.writeText(decodeURIComponent(b.dataset.code)); flashStatus('已复制代码'); }
        catch { /* ignore */ }
      };
    });
    return { node: d, needStreamNode: !!en.streaming };
  }
  if (en.kind === 'tool') {
    d.className = 'entry' + inCls;
    const card = document.createElement('div');
    card.className = 'tool-card';
    const summary = CL.util.escapeHtml(argsSummary(en.name, en.args));
    const rSummary = en.result ? toolResultSummary(en.name, en.result)
      : (en.live ? CL.util.escapeHtml(en.live.slice(-200)) : '');
    card.innerHTML =
      '<div class="head">' +
        '<span class="tag ' + en.name + '">' + (window.lucideIcon(toolIconName(en.name)) || '') + en.name + '</span>' +
        '<span class="args">' + summary + '</span>' +
        '<span class="tw ' + (en.result ? (en.result.startsWith('ERROR') || en.result.includes('拦截') ? 'err' : 'ok') : 'wait') + '">' +
          (en.result ? (en.result.startsWith('ERROR') || en.result.includes('拦截') ? (window.lucideIcon('circle-x') || '') : (window.lucideIcon('circle-check') || '')) : (window.lucideIcon('loader-circle') || '')) +
        '</span>' +
      '</div>' +
      (rSummary ? '<div class="tool-result">' + rSummary + '</div>' : '') +
      '<pre>' + CL.util.escapeHtml(
        '参数:\n' + JSON.stringify(en.args || {}, null, 2) +
        (en.result ? '\n\n结果:\n' + en.result : '')
      ) + '</pre>';
    card.querySelector('.head').onclick = () => card.classList.toggle('open');
    const trEl = card.querySelector('.tool-result');
    if (trEl) trEl.onclick = () => card.classList.toggle('open');
    d.appendChild(card);
    return { node: d };
  }
  if (en.kind === 'approval') {
    // 手动审批确认卡（参考 CodeBuddy 三档权限）
    d.className = 'entry approval-card' + (en.resolved ? ' resolved' : '') + inCls;
    d.innerHTML =
      '<div class="ap-head"><span class="ap-ico">⏳</span>待审批 · ' + CL.util.escapeHtml(en.tool) + '</div>' +
      '<pre class="ap-args">' + CL.util.escapeHtml(JSON.stringify(en.args || {}, null, 2).slice(0, 400)) + '</pre>' +
      (en.resolved
        ? '<div class="ap-state ' + (en.allowed ? 'ok' : 'deny') + '">' + (en.allowed ? '✓ 已允许执行' : '✖ 已拒绝') + '</div>'
        : '<div class="ap-actions"><button class="ap-allow">允许执行</button><button class="ap-deny">拒绝</button></div>');
    if (!en.resolved) {
      d.querySelector('.ap-allow').onclick = () => { en.resolved = true; en.allowed = true; window.api.agentApproval(en.callId, true); renderTranscript(); };
      d.querySelector('.ap-deny').onclick = () => { en.resolved = true; en.allowed = false; window.api.agentApproval(en.callId, false); renderTranscript(); };
    }
    return { node: d };
  }
  if (en.kind === 'change') {
    d.className = 'entry' + inCls;
    d.appendChild(buildChangeCard(en, null));
    return { node: d };
  }
  if (en.kind === 'error') {
    d.className = 'entry entry-error' + inCls;
    d.innerHTML = '<span class="err-ico">' + (window.lucideIcon('alert-triangle') || '') + '</span> ' + CL.util.escapeHtml(en.text);
    return { node: d };
  }
  d.className = 'entry' + inCls;
  return { node: d };
}

function renderTranscript() {
  const a = agentsState.agents.get(agentsState.selectedId);
  // 切换会话（或首次）→ 整体重建一次；同一会话内走增量路径
  if (transcriptEl.__agentId !== agentsState.selectedId) {
    transcriptEl.innerHTML = '';
    transcriptEl.__agentId = a ? agentsState.selectedId : null;
  }
  if (!a) return;

  mainHeadEl.classList.remove('hidden');
  const headTask = document.getElementById('agent-head-task');
  if (headTask.textContent !== a.task) headTask.textContent = a.task;
  const headDot = document.getElementById('agent-head-dot');
  const headDotCls = 'dot ' + a.status;
  if (headDot.className !== headDotCls) headDot.className = headDotCls;
  const badge = document.getElementById('agent-head-status');
  const badgeTxt = statusLabel(a.status);
  if (badge.textContent !== badgeTxt) badge.textContent = badgeTxt;
  // 运行时长表盘
  if (a.status === 'running') startDial(a); else stopDial(a.status === 'done');
  const stopBtn = document.getElementById('agent-stop-btn');
  const stopDisp = (a.status === 'running' && !a.readonly) ? '' : 'none';
  if (stopBtn.style.display !== stopDisp) stopBtn.style.display = stopDisp;

  // 思考指示器：先摘除（保证 entry 节点顺序稳定），条件成立时再挂回末尾
  const lastEntry = a.entries.length ? a.entries[a.entries.length - 1] : null;
  const wantThink = a.status === 'running' && !a.readonly && !(lastEntry && lastEntry.streaming);
  if (a.__thinkTimer) { clearInterval(a.__thinkTimer); a.__thinkTimer = null; }
  if (a.__thinkNode) {
    if (a.__thinkNode.isConnected) a.__thinkNode.remove();
    a.__thinkNode = null;
    a.__thinkKey = null;
  }

  const entries = a.entries;
  const nodes = a.__nodes || (a.__nodes = []);
  // 状态事件会截断 entries 头部（>200 保留尾部），节点数组同步丢弃对应前缀
  if (nodes.length > entries.length) {
    for (let i = entries.length; i < nodes.length; i++) {
      if (nodes[i] && nodes[i].node && nodes[i].node.parentNode) nodes[i].node.parentNode.removeChild(nodes[i].node);
    }
    nodes.length = entries.length;
    a.__nodes = null; // 前缀截断后下标已错位，强制下一帧整体重建
    return renderTranscript();
  }

  const prevLastNode = entries.length ? (nodes[entries.length - 1] && nodes[entries.length - 1].node) : null;
  let appended = 0;
  for (let i = 0; i < entries.length; i++) {
    const en = entries[i];
    const sig = sigOf(en);
    const slot = nodes[i];
    if (slot && slot.sig === sig && slot.node && slot.node.isConnected) {
      if (en.streaming) { a.__streamNode = slot.node; a.__streamNodeEntry = en; }
      continue;
    }
    const built = buildEntryNode(en, i === entries.length - 1);
    const node = built.node;
    if (slot && slot.node && slot.node.parentNode) {
      // 原地替换：保留位置，避免重新 append 造成的滚动跳动
      slot.node.parentNode.replaceChild(node, slot.node);
    } else {
      transcriptEl.appendChild(node);
    }
    nodes[i] = { sig, node };
    appended++;
    if (built.needStreamNode) { a.__streamNode = node; a.__streamNodeEntry = en; }
  }

  // 入场动效只给最新一条：新增节点后把上一条的 entry-in 摘掉
  if (appended > 0 && entries.length) {
    if (prevLastNode && prevLastNode !== nodes[entries.length - 1].node) prevLastNode.classList.remove('entry-in');
  }

  // 思考指示器：运行中且非流式打字时，显示三点跳动（AI 思考中）
  if (wantThink) {
    // 正在执行工具 → 显示工具名；否则轮播思考阶段文案
    const toolLabel = (lastEntry && lastEntry.kind === 'tool' && !lastEntry.result) ? lastEntry.name : '';
    const t = document.createElement('div');
    t.className = 'thinking entry-in';
    t.innerHTML =
      '<div class="th-orbit"><span class="th-core"></span></div>' +
      '<div class="th-main">' +
        '<div class="th-label">' +
          (toolLabel
            ? '<span class="th-tool">' + CL.util.escapeHtml(toolLabel) + '</span>'
            : '<span class="th-phase">正在分析</span><span class="th-shimmer">…</span>') +
        '</div>' +
        (a.__reasoning ? '<div class="th-reason streaming">' + CL.util.escapeHtml(a.__reasoning) + '</div>' : '') +
      '</div>';
    transcriptEl.appendChild(t);
    a.__thinkNode = t;
    if (!toolLabel) {
      let ti = 0;
      a.__thinkTimer = setInterval(() => {
        const el = t.querySelector('.th-phase');
        if (!el || !el.isConnected) { clearInterval(a.__thinkTimer); a.__thinkTimer = null; return; }
        ti = (ti + 1) % THINK_PHASES.length;
        el.textContent = THINK_PHASES[ti];
      }, 2600);
    }
  }

  if (appended > 0) transcriptEl.scrollTop = transcriptEl.scrollHeight;
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
  const kw = (document.getElementById('history-filter') && document.getElementById('history-filter').value || '').trim().toLowerCase();
  let lastGroup = null;
  for (const s of agentsState.history) {
    if (kw && !(s.task || '').toLowerCase().includes(kw)) continue;
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
      '<span class="ht">' + CL.util.escapeHtml(s.task || '（会话）') + '</span>' +
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
      case 'approval': entries.push({ kind: 'approval', callId: ev.callId, tool: ev.tool, args: ev.args }); break;
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
  const el = document.getElementById('stat-sessions');
  if (el) el.textContent = String(agentsState.history.length);
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

/* 历史会话搜索过滤 */
(function bindHistoryFilter() {
  const el = document.getElementById('history-filter');
  if (el) el.oninput = () => renderHistory();
  const clearBtn = document.getElementById('history-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!agentsState.history.length) return;
    if (!confirm('确定清空全部历史会话？此操作不可恢复。')) return;
    await window.api.clearSessions();
    await loadHistory();
    flashStatus('已清空全部会话');
  };
})();

/* ---- 轻量 Markdown 渲染（AI 回复的代码块/加粗/标题/列表） ---- */
function miniMarkdown(text) {
  let s = CL.util.escapeHtml(String(text == null ? '' : text));
  // 提取代码块（占位符保护，避免内部换行/标签被破坏）
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push({ lang: (lang || 'code').trim(), code });
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  // 行内代码 `...`
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');
  // 加粗 **...**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 链接 [text](url) —— 仅放行安全 URL 协议，防 javascript:/data:/vbscript: 注入
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (m, text, url) => {
    const raw = String(url).trim();
    const probe = raw.replace(/[\u0000- ]/g, ''); // 浏览器会忽略 URL 中的控制字符/空白
    // 含 scheme（形如 xxx:）时只放行 http/https/mailto；其余（相对路径/锚点/绝对路径）放行
    const scheme = (probe.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [])[1];
    const safe = !scheme || /^(https?|mailto)$/i.test(scheme) ? raw : '#';
    return '<a href="' + safe + '" class="md-link" target="_blank" rel="noopener noreferrer">' + text + '</a>';
  });
  // 引用 > ...（escape 后为 &gt;）
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');
  // 水平线 ---
  s = s.replace(/^(?:---+|\*\*\*+|___+)$/gm, '<hr class="md-hr">');
  // 标题 ### / ## / #
  s = s.replace(/^#{1,6} (.+)$/gm, '<div class="md-h">$1</div>');
  // 有序列表 1. / 无序列表 - *
  s = s.replace(/^(\d+)[.、] (.+)$/gm, '<div class="md-li"><span class="md-li-n">$1.</span>$2</div>');
  s = s.replace(/^[-*] (.+)$/gm, '<div class="md-li">• $1</div>');
  // 恢复代码块
  s = s.replace(/\u0000B(\d+)\u0000/g, (m, i) => {
    const b = blocks[+i];
    return '<div class="md-code"><div class="md-code-head"><span>' + CL.util.escapeHtml(b.lang) + '</span><button class="md-copy" data-code="' + encodeURIComponent(b.code) + '">' + (window.lucideIcon('copy') || '复制') + '</button></div><pre><code>' + b.code + '</code></pre></div>';
  });
  return s;
}

/* ---- 工具结果友好摘要（直接可见，不用展开就知道工具干了什么） ---- */
function toolResultSummary(name, result) {
  if (!result) return '';
  let r = String(result).replace(/\x1b\[[0-9;]*m/g, '').trim(); // 去 ANSI 颜色码
  if (r.startsWith('ERROR')) return '<span class="tr-err">' + CL.util.escapeHtml(r.slice(0, 200)) + '</span>';
  let short = r;
  if (name === 'write_file' || name === 'create_file') {
    short = r.replace(/^已写入\s*/, '').replace(/^已创建\s*/, '');
    if (short.length > 120) short = short.slice(0, 120) + '…';
  } else if (name === 'run_command' || name === 'search_files' || name === 'list_tree') {
    if (short.length > 200) short = short.slice(0, 200) + '…';
  } else {
    if (short.length > 160) short = short.slice(0, 160) + '…';
  }
  return CL.util.escapeHtml(short);
}
