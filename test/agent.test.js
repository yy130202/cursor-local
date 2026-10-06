'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAgentHarness, createChild, deferred, streamResponse, sse } = require('./helpers/agent-harness');

function watchEvent(h, predicate) {
  const event = deferred();
  const send = h.ui.window.webContents.send;
  h.ui.window.webContents.send = (channel, payload) => {
    send(channel, payload);
    if (channel === 'agent:event' && predicate(payload)) event.resolve(payload);
  };
  return event.promise;
}

function toolsDelta(calls) {
  return { tool_calls: calls.map(([name, args], index) => ({ index, id: 'call-' + index,
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })) };
}

function responses(...chunks) {
  let index = 0;
  return async () => {
    assert.ok(index < chunks.length, 'Unexpected extra completion request');
    return streamResponse(chunks[index++]);
  };
}

test('runAgent stops immediately when no API key is configured', async () => {
  const h = createAgentHarness({ config: { apiKey: '' } });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'error');
  assert.match(agent.log[0].text, /未配置 API Key/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.spawned.length, 0);
});

test('runAgent builds authenticated stream requests and completes a text-only response', async () => {
  const h = createAgentHarness();
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'done');
  assert.equal(h.saved.length, 1);
  const [url, request] = h.requests[0];
  assert.equal(url, 'https://unit.invalid/v1/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer unit-test-key');
  const body = JSON.parse(request.body);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'test-model');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools.length, 9);
  assert.equal(body.messages[1].content, agent.task);
  assert.equal(agent.messages[2].role, 'assistant');
  assert.equal(agent.messages[2].content, '完成');
  assert.deepEqual(agent.log.filter((e) => e.kind === 'status').map((e) => e.status), ['running', 'done']);
});

test('stream parser assembles split UTF-8, reasoning, repeated names and argument fragments', async () => {
  const first = sse({ reasoning_content: '先分析' }) + ': comment\r\n' + 'data: invalid-json\n' +
    'data: {}\n' + sse({ content: '中文' }) + sse({ tool_calls: [
      { index: 0, id: 'read-1', function: { name: 'read_file', arguments: '{"pa' } }
    ] }) + sse({ tool_calls: [
      { index: 0, function: { name: 'read_file', arguments: 'th":"a.txt"}' } }
    ] }) + 'data: [DONE]\n';
  const bytes = Buffer.from(first);
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  const h = createAgentHarness({ fetch: responses([bytes.subarray(0, split), bytes.subarray(split)],
    [sse({ reasoning: '继续' }), sse({ content: '结论' }).trim()]) });
  h.fs.addFile(path.join(h.cwd, 'a.txt'), 'source');
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'done');
  assert.deepEqual(agent.log.filter((e) => e.kind === 'reasoning_delta').map((e) => e.text), ['先分析', '继续']);
  assert.deepEqual(agent.log.filter((e) => e.kind === 'text_delta').map((e) => e.text), ['中文', '结论']);
  const tools = agent.log.filter((e) => e.kind === 'tool_call');
  assert.deepEqual(tools.map((e) => e.name), ['read_file']);
  assert.deepEqual(tools[0].args, { path: 'a.txt' });
  assert.equal(agent.messages.find((m) => m.role === 'tool').content, 'source');
  assert.equal(agent.messages.find((m) => m.role === 'tool').tool_call_id, 'read-1');
});

test('stream parser handles multiple tool indices, no index and a final unterminated line', async () => {
  const h = createAgentHarness({ fetch: responses([
    sse({ tool_calls: [{ id: 'zero', function: { name: 'get_file_info', arguments: '{"path":"a.txt"}' } },
      { index: 1, id: 'one', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }).trim()
  ], [sse({ content: 'done' }), 'data:\n\n']) });
  h.fs.addFile(path.join(h.cwd, 'a.txt'), 'a');
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.deepEqual(agent.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['zero', 'one']);
  assert.equal(agent.status, 'done');
});

test('invalid tool arguments become an empty object and handler failures are returned to the model', async () => {
  const h = createAgentHarness({ fetch: responses([sse(toolsDelta([
    ['read_file', '{invalid'], ['missing', '{}']
  ]))], [sse({ content: 'handled' })]) });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'done');
  assert.deepEqual(agent.log.find((e) => e.kind === 'tool_call').args, {});
  assert.match(agent.messages.find((m) => m.role === 'tool').content, /^ERROR:/);
  assert.match(agent.messages.filter((m) => m.role === 'tool')[1].content, /未知工具/);
});

test('tool output is limited separately for UI events and model history', async () => {
  const output = 'x'.repeat(13000);
  const h = createAgentHarness({ handlers: () => ({ read_file: async () => output }),
    fetch: responses([sse(toolsDelta([['read_file', {}]]))], [sse({ content: 'done' })]) });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.log.find((e) => e.kind === 'tool_result').result.length, 3000);
  assert.equal(agent.messages.find((m) => m.role === 'tool').content.length, 12000);
});

test('SSE parser ignores empty choices, null deltas and incomplete tool fragments', async () => {
  const h = createAgentHarness({ fetch: responses([
    'data: {"choices":[]}\n', 'data: {"choices":[{"delta":null}]}\n',
    sse({ tool_calls: [{ index: 0, id: 'incomplete' }] }),
    sse({ content: 'checking incomplete tool' })
  ], [sse({ content: 'done' })]) });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'done');
  assert.deepEqual(agent.log.find((event) => event.kind === 'tool_call').args, {});
  assert.equal(agent.messages.find((message) => message.role === 'tool').content, '[未知工具 unknown]');
});

test('an empty completion requests a summary only once', async () => {
  const h = createAgentHarness({ fetch: responses([], []) });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(h.requests.length, 2);
  assert.equal(agent.__askedSummary, true);
  assert.equal(agent.messages.filter((m) => m.role === 'user').length, 2);
  assert.match(agent.messages.filter((m) => m.role === 'user')[1].content, /总结/);
  assert.equal(agent.status, 'done');
});

test('the 30-round cap prevents endless tool-only responses and saves a bounded log', async () => {
  const h = createAgentHarness({ fetch: async () => streamResponse([sse(toolsDelta([['missing', {}]]))]) });
  const agent = h.makeAgent({ log: Array.from({ length: 250 }, (_, i) => ({ kind: 'old', i })) });
  await h.api.runAgent(agent);
  assert.equal(h.requests.length, 30);
  assert.equal(agent.status, 'done');
  assert.equal(agent.log.length, 200);
  assert.equal(h.saved.length, 1);
  assert.equal(agent.log.at(-1).status, 'done');
});

test('HTTP errors transition to error, truncate details and still save the session', async () => {
  const h = createAgentHarness({ fetch: async () => ({ ok: false, status: 429, text: async () => 'q'.repeat(500) }) });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'error');
  assert.equal(agent.log.find((e) => e.kind === 'error').text, 'API 429: ' + 'q'.repeat(400));
  assert.equal(h.saved.length, 1);
  assert.ok(h.logs.some(([level]) => level === 'error'));
});

test('network and stream failures are reported as agent errors without unhandled rejection', async () => {
  for (const fetch of [async () => { throw new Error('offline'); }, async () => ({ ok: true,
    body: { getReader: () => ({ read: async () => { throw new Error('stream failed'); } }) } })]) {
    const h = createAgentHarness({ fetch });
    const agent = h.makeAgent();
    await h.api.runAgent(agent);
    assert.equal(agent.status, 'error');
    assert.equal(h.saved.length, 1);
    assert.match(agent.log.find((e) => e.kind === 'error').text, /offline|stream failed/);
  }
});

test('memory and rule injection includes populated entries and tolerates missing or failed sources', async () => {
  const memory = { getMemory: () => ({ global: [{ text: 'global preference' }], project: [{ text: 'project preference' }] }),
    getRules: () => ({ user: ' user rule ', project: ' project rule ' }) };
  const h = createAgentHarness({ memory });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.match(agent.messages[0].content, /global preference/);
  assert.match(agent.messages[0].content, /project preference/);
  assert.match(agent.messages[0].content, /user rule/);
  assert.match(agent.messages[0].content, /project rule/);
  for (const source of [{ getMemory: () => null, getRules: () => null },
    { getMemory: () => ({}), getRules: () => ({ user: ' ', project: '' }) },
    { getMemory: () => { throw new Error('memory unavailable'); } }]) {
    const isolated = createAgentHarness({ memory: source });
    const a = isolated.makeAgent();
    await isolated.api.runAgent(a);
    assert.equal(a.status, 'done');
  }
});

test('permission and mode instructions reflect full, manual, Ask and Plan states', async () => {
  for (const [permission, mode, expected] of [['full', 'craft', /完全访问/], ['manual', 'craft', /手动审批/],
    ['', 'ask', /问答模式/], ['safe', 'plan', /计划模式/]]) {
    const h = createAgentHarness({ config: { permission } });
    const agent = h.makeAgent({ mode });
    await h.api.runAgent(agent);
    assert.match(agent.messages[0].content, expected);
  }
});

test('manual approval gates a write until explicitly allowed and clears its timeout', async () => {
  const h = createAgentHarness({ config: { permission: 'manual' },
    fetch: responses([sse(toolsDelta([['write_file', { path: 'a.txt', content: 'approved' }]]))], [sse({ content: 'done' })]) });
  const agent = h.makeAgent();
  const approval = watchEvent(h, (e) => e.kind === 'approval');
  const run = h.api.runAgent(agent);
  const event = await approval;
  assert.equal(h.fs.count('writeFile'), 0);
  assert.equal(h.timers.pending.size, 1);
  assert.equal(h.ipc.invoke('agent:approval', { callId: event.callId, allowed: true }), true);
  assert.equal(agent.__pending.size, 0);
  assert.equal(h.timers.pending.size, 0);
  await run;
  assert.equal(h.fs.peek(path.join(h.cwd, 'a.txt')), 'approved');
  assert.equal(agent.status, 'done');
});

test('manual denial returns a tool result without performing the rejected write', async () => {
  const h = createAgentHarness({ config: { permission: 'manual' },
    fetch: responses([sse(toolsDelta([['write_file', { path: 'a.txt', content: 'no' }]]))], [sse({ content: 'done' })]) });
  const agent = h.makeAgent();
  const approval = watchEvent(h, (e) => e.kind === 'approval');
  const run = h.api.runAgent(agent);
  const event = await approval;
  h.ipc.invoke('agent:approval', { callId: event.callId, allowed: false });
  await run;
  assert.equal(h.fs.count('writeFile'), 0);
  assert.match(agent.messages.find((m) => m.role === 'tool').content, /用户拒绝/);
  assert.equal(h.timers.pending.size, 0);
});

test('manual approval timeout rejects once and ignores late approval messages', async () => {
  const h = createAgentHarness({ config: { permission: 'manual' },
    fetch: responses([sse(toolsDelta([['write_file', { path: 'a.txt', content: 'late' }]]))], [sse({ content: 'done' })]) });
  const agent = h.makeAgent();
  const approval = watchEvent(h, (e) => e.kind === 'approval');
  const run = h.api.runAgent(agent);
  const event = await approval;
  h.timers.fire(120000);
  h.ipc.invoke('agent:approval', { callId: event.callId, allowed: true });
  await run;
  assert.equal(h.fs.count('writeFile'), 0);
  assert.equal(agent.__pending.size, 0);
  assert.equal(h.timers.pending.size, 0);
  assert.equal(h.ipc.invoke('agent:approval', { callId: 'nonexistent', allowed: true }), true);
});

test('read-only tools in manual mode and writes in Ask mode never request approval', async () => {
  for (const readonly of [false, true]) {
    const h = createAgentHarness({ config: { permission: 'manual' }, fetch: responses([
      sse(toolsDelta([[readonly ? 'write_file' : 'list_dir', readonly ? { path: 'a.txt', content: 'no' } : {}]]))
    ], [sse({ content: 'done' })]) });
    const agent = h.makeAgent({ readonly, mode: readonly ? 'ask' : 'craft' });
    await h.api.runAgent(agent);
    assert.equal(agent.log.some((e) => e.kind === 'approval'), false);
    assert.equal(h.fs.count('writeFile'), 0);
  }
});

test('stopping while approval is pending cancels all remaining tools in that response', async () => {
  const h = createAgentHarness({ config: { permission: 'manual' }, fetch: responses([
    sse(toolsDelta([['write_file', { path: 'a.txt', content: 'a' }], ['write_file', { path: 'b.txt', content: 'b' }]]))
  ]) });
  const agent = h.makeAgent();
  const approval = watchEvent(h, (e) => e.kind === 'approval');
  let approvalCount = 0;
  const send = h.ui.window.webContents.send;
  h.ui.window.webContents.send = (channel, event) => {
    send(channel, event);
    if (event.kind === 'approval' && ++approvalCount > 1) {
      // Avoid hanging against the unfixed implementation while proving that
      // a stop must not produce another approval or execute its tool.
      h.ipc.invoke('agent:approval', { callId: event.callId, allowed: true });
    }
  };
  const run = h.api.runAgent(agent);
  await approval;
  h.ipc.invoke('agent:stop', agent.id);
  await run;
  assert.equal(approvalCount, 1);
  assert.equal(h.fs.count('writeFile'), 0);
  assert.equal(agent.status, 'stopped');
  assert.equal(h.timers.pending.size, 0);
  assert.equal(h.saved.length, 1);
});

test('an error state set during a completion prevents its late tools from executing', async () => {
  const pending = deferred();
  const h = createAgentHarness({ fetch: () => pending.promise });
  const agent = h.makeAgent();
  const run = h.api.runAgent(agent);
  agent.status = 'error';
  pending.resolve(streamResponse([sse(toolsDelta([['write_file', { path: 'late.txt', content: 'bad' }]]))]));
  await run;
  assert.equal(agent.status, 'error');
  assert.equal(h.fs.count('writeFile'), 0);
  assert.equal(h.saved.length, 1);
});

test('stopping a completion suppresses late reasoning chunks as well as content', async () => {
  const pending = deferred();
  const h = createAgentHarness({ fetch: () => pending.promise });
  const agent = h.makeAgent();
  const run = h.api.runAgent(agent);
  h.ipc.invoke('agent:stop', agent.id);
  pending.resolve(streamResponse([sse({ reasoning_content: 'late reasoning' }), sse({ content: 'late answer' })]));
  await run;
  assert.equal(agent.status, 'stopped');
  assert.equal(agent.log.some((event) => ['text_delta', 'reasoning_delta'].includes(event.kind)), false);
});

test('an unexpected dispatcher failure becomes a model-visible tool result', async () => {
  const h = createAgentHarness({
    addLog: (level) => { if (level === 'debug') throw new Error('logger unavailable'); },
    fetch: responses([sse(toolsDelta([['list_dir', {}]]))], [sse({ content: 'handled' })])
  });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.messages.find((message) => message.role === 'tool').content, 'ERROR: logger unavailable');
  assert.equal(agent.status, 'done');
  assert.equal(h.saved.length, 1);
});

test('stopping an in-flight completion suppresses late tools, deltas and done status', async () => {
  for (const delta of [{ content: 'late text' }, toolsDelta([['write_file', { path: 'late.txt', content: 'bad' }]])]) {
    const response = deferred();
    const requested = deferred();
    const h = createAgentHarness({ fetch: () => { requested.resolve(); return response.promise; } });
    const agent = h.makeAgent();
    const run = h.api.runAgent(agent);
    await requested.promise;
    h.ipc.invoke('agent:stop', agent.id);
    const before = agent.log.length;
    response.resolve(streamResponse([sse(delta)]));
    await run;
    assert.equal(agent.status, 'stopped');
    assert.equal(h.fs.count('writeFile'), 0);
    assert.equal(agent.log.length, before);
    assert.equal(h.saved.length, 1);
  }
});

test('stopping during the first tool skips later tools from the same completion', async () => {
  const h = createAgentHarness({ handlers: () => ({
    read_file: async ({ agent }) => { h.ipc.invoke('agent:stop', agent.id); return 'stopped'; },
    write_file: async () => { throw new Error('must not execute'); }
  }), fetch: responses([sse(toolsDelta([['read_file', {}], ['write_file', {}]]))]) });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'stopped');
  assert.deepEqual(agent.log.filter((e) => e.kind === 'tool_call').map((e) => e.name), ['read_file']);
});

test('a network failure arriving after stop does not overwrite stopped with error', async () => {
  const response = deferred();
  const h = createAgentHarness({ fetch: () => response.promise });
  const agent = h.makeAgent();
  const run = h.api.runAgent(agent);
  h.ipc.invoke('agent:stop', agent.id);
  response.reject(new Error('late failure'));
  await run;
  assert.equal(agent.status, 'stopped');
  assert.equal(agent.log.some((e) => e.kind === 'error'), false);
});

test('Plan responses containing tool calls are rejected without execution or approval', async () => {
  const h = createAgentHarness({ config: { permission: 'manual' }, fetch: responses([
    sse(toolsDelta([['write_file', { path: 'plan.txt', content: 'bad' }]]))
  ], [sse({ content: '实施计划' })]) });
  const agent = h.makeAgent({ mode: 'plan' });
  const send = h.ui.window.webContents.send;
  h.ui.window.webContents.send = (channel, event) => {
    send(channel, event);
    if (event.kind === 'approval') {
      h.ipc.invoke('agent:approval', { callId: event.callId, allowed: true });
    }
  };
  await h.api.runAgent(agent);
  assert.equal(h.fs.count('writeFile'), 0);
  assert.equal(agent.log.some((e) => e.kind === 'approval'), false);
  assert.match(agent.messages.find((m) => m.role === 'tool').content, /计划/);
});

test('IPC create trims task, supplies defaults and assigns unique agent identifiers', async () => {
  const h = createAgentHarness({ config: { apiKey: '' } });
  const a = h.ipc.invoke('agent:create', { task: '  first  ' });
  const b = h.ipc.invoke('agent:create', { task: 'second', mode: 'ask' });
  const empty = h.ipc.invoke('agent:create', {});
  assert.notEqual(a.id, b.id);
  assert.equal(h.agents.get(a.id).task, 'first');
  assert.equal(h.agents.get(a.id).cwd, h.cwd);
  assert.equal(h.agents.get(a.id).mode, 'craft');
  assert.equal(h.agents.get(b.id).readonly, true);
  assert.equal(h.agents.get(empty.id).task, '');
  assert.equal(h.ipc.invoke('agent:list').length, 3);
  assert.equal(Object.hasOwn(h.ipc.invoke('agent:list')[0], 'messages'), false);
});

test('IPC stop handles unknown IDs and caps existing logs before publishing stopped', () => {
  const h = createAgentHarness();
  assert.equal(h.ipc.invoke('agent:stop', 'missing'), true);
  const agent = h.makeAgent({ log: Array.from({ length: 250 }, () => ({ kind: 'old' })) });
  h.ipc.invoke('agent:stop', agent.id);
  assert.equal(agent.status, 'stopped');
  assert.ok(agent.log.length <= 200);
  assert.equal(agent.log.at(-1).status, 'stopped');
  h.api.clearPendingApprovals(agent);
});

test('IPC followup rejects absent, running, empty-task and empty-history agents', () => {
  const h = createAgentHarness();
  assert.match(h.ipc.invoke('agent:followup', { id: 'missing', task: 't' }).error, /不存在/);
  const running = h.makeAgent();
  assert.match(h.ipc.invoke('agent:followup', { id: running.id, task: 't' }).error, /仍在运行/);
  const completed = h.makeAgent({ status: 'done' });
  assert.match(h.ipc.invoke('agent:followup', { id: completed.id, task: '  ' }).error, /不能为空/);
  assert.match(h.ipc.invoke('agent:followup', { id: completed.id, task: 't' }).error, /会话为空/);
});

test('IPC followup appends a trimmed user message and resumes the existing conversation', async () => {
  const h = createAgentHarness();
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  const done = watchEvent(h, (e) => e.kind === 'status' && e.status === 'done');
  assert.deepEqual(h.ipc.invoke('agent:followup', { id: agent.id, task: ' follow up ' }), { ok: true });
  await done;
  assert.equal(agent.status, 'done');
  assert.equal(agent.messages.filter((m) => m.role === 'user').at(-1).content, 'follow up');
  assert.equal(agent.log.find((e) => e.kind === 'user_msg').text, 'follow up');
});

test('mock LLM mode bypasses the network while exercising the tool loop', async () => {
  const h = createAgentHarness({ env: { MOCK_LLM: '1' }, config: { apiKey: '' }, spawn: () => {
    const child = createChild();
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('unit-node')); child.emit('close', 0); });
    return child;
  } });
  const agent = h.makeAgent();
  await h.api.runAgent(agent);
  assert.equal(agent.status, 'done');
  assert.equal(h.requests.length, 0);
  assert.equal(h.fs.peek(path.join(h.cwd, 'agent-demo/hello.txt')), 'hello from agent\n');
  const results = agent.log.filter((e) => e.kind === 'tool_result');
  assert.ok(results.some((e) => /沙箱拦截/.test(e.result)));
  assert.ok(results.some((e) => /已拦截危险命令/.test(e.result)));
  assert.equal(agent.children.size, 0);
});

test('emitAgent records timestamped events and only sends to a live renderer', () => {
  const h = createAgentHarness();
  const agent = h.makeAgent();
  h.api.emitAgent(agent, 'text', { text: 'event' });
  assert.equal(agent.log[0].kind, 'text');
  assert.equal(typeof agent.log[0].ts, 'number');
  assert.deepEqual(h.ui.sent[0], { channel: 'agent:event', payload: { id: agent.id, kind: 'text', text: 'event' } });
  h.ui.window.destroyed = true;
  h.api.emitAgent(agent, 'status');
  assert.equal(h.ui.sent.length, 1);
  const headless = createAgentHarness({ winRef: () => null });
  const a = headless.makeAgent();
  headless.api.emitAgent(a, 'text');
  assert.equal(a.log.length, 1);
});

test('runCommand streams stdout and stderr and clears its timer on normal exit', async () => {
  const child = createChild();
  const h = createAgentHarness({ spawn: () => child });
  const agent = h.makeAgent({ children: undefined });
  const promise = h.deps.runCommand(h.cwd, 'test-command', agent);
  assert.equal(agent.children.has(child), true);
  child.stdout.emit('data', Buffer.from('out'));
  child.stderr.emit('data', Buffer.from('err'));
  child.emit('close', 0);
  assert.deepEqual(await promise, { code: 0, output: 'out\n[stderr]\nerr' });
  assert.deepEqual(agent.log.map((e) => [e.chunk, !!e.stderr]), [['out', false], ['err', true]]);
  assert.equal(agent.children.size, 0);
  assert.equal(h.timers.pending.size, 0);
});

test('runCommand supplies empty-output text and supports execution without an agent', async () => {
  const child = createChild();
  const h = createAgentHarness({ spawn: () => child });
  const promise = h.deps.runCommand(h.cwd, 'test-command');
  child.emit('close', 0);
  assert.deepEqual(await promise, { code: 0, output: '[无输出]' });
});

test('runCommand reports startup errors and ignores duplicate terminal events', async () => {
  const child = createChild();
  const h = createAgentHarness({ spawn: () => child });
  const promise = h.deps.runCommand(h.cwd, 'test-command', h.makeAgent());
  child.emit('error', new Error('missing shell'));
  child.emit('error', new Error('duplicate'));
  child.emit('close', 99);
  assert.deepEqual(await promise, { code: -1, output: '启动失败: missing shell' });
  assert.equal(h.timers.pending.size, 0);
  const fail = createAgentHarness({ spawn: () => { throw new Error('spawn failed'); } });
  assert.match(await fail.api.executeTool(fail.makeAgent(), 'run_command', { command: 'node --version' }), /ERROR: spawn failed/);
});

test('runCommand truncates large buffered output and handles GBK output', async () => {
  const child = createChild();
  const h = createAgentHarness({ spawn: () => child });
  const promise = h.deps.runCommand(h.cwd, 'test-command');
  child.stdout.emit('data', Buffer.alloc(210000, 'a'));
  child.stderr.emit('data', Buffer.alloc(110000, 'b'));
  child.emit('close', 0);
  assert.equal((await promise).output, 'a'.repeat(12000));
  const gbk = createChild();
  const g = createAgentHarness({ spawn: () => gbk });
  const decoded = g.deps.runCommand(g.cwd, 'test-command');
  gbk.stdout.emit('data', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  gbk.emit('close', 0);
  assert.equal((await decoded).output, '中文');
});

for (const platform of ['win32', 'linux']) {
  test(`runCommand timeout terminates the child on ${platform} and settles once`, async () => {
    const child = createChild(456);
    const h = createAgentHarness({ platform, spawn: () => child });
    const promise = h.deps.runCommand(h.cwd, 'test-command', h.makeAgent(), 5);
    child.stdout.emit('data', Buffer.from('partial'));
    h.timers.fire(5);
    h.timers.fire(5);
    child.emit('close', 0);
    const result = await promise;
    assert.equal(result.code, -1);
    assert.match(result.output, /partial[\s\S]*命令超时已终止/);
    if (platform === 'win32') assert.deepEqual(h.spawned[1], ['taskkill', ['/pid', '456', '/T', '/F']]);
    else assert.deepEqual(child.killed, ['SIGKILL']);
  });

  test(`killChildren snapshots and clears tracked children on ${platform}`, () => {
    const children = [createChild(101), createChild(102)];
    const h = createAgentHarness({ platform });
    const agent = h.makeAgent({ children: new Set(children) });
    h.api.killChildren(agent);
    assert.equal(agent.children.size, 0);
    if (platform === 'win32') assert.deepEqual(h.spawned.map((args) => args[1][1]), ['101', '102']);
    else assert.deepEqual(children.map((c) => c.killed), [['SIGKILL'], ['SIGKILL']]);
    h.api.killChildren(agent);
    h.api.killChildren({});
  });
}

test('child cleanup tolerates individual kill failures and proceeds with remaining children', () => {
  const first = createChild(101), second = createChild(102);
  first.kill = () => { throw new Error('already gone'); };
  const h = createAgentHarness({ platform: 'linux' });
  const agent = h.makeAgent({ children: new Set([first, second]) });
  assert.doesNotThrow(() => h.api.killChildren(agent));
  assert.deepEqual(second.killed, ['SIGKILL']);
  assert.equal(agent.children.size, 0);
});
