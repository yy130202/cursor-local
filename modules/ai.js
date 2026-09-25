/* Cursor Local - AI 辅助模块（代码补全 / 选区编辑 / 内联改写 / 诊断） */
function registerAi(ipcMain, { loadConfig }) {
  async function aiChat(messages, opts = {}) {
    const cfg = loadConfig();
    if (!cfg.apiKey) throw new Error('未配置 API Key，请在设置中填写');
    const body = { model: cfg.model, messages, temperature: opts.temperature ?? 0.3 };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('API ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const j = await res.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  function stripFence(s) {
    return String(s || '').replace(/^```[\w]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }

  ipcMain.handle('ai:complete', async (_e, { code, lang }) => {
    try {
      const prompt = [
        '你是代码补全助手。严格根据上下文补全代码，只输出要补全的代码片段本身，不要解释、不要输出已有的上文、不要用代码块包裹。',
        '语言：' + (lang || '未知'),
        '上文：',
        '```',
        (code || '').slice(-4000),
        '```',
        '补全：'
      ].join('\n');
      const completion = await aiChat([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 220 });
      return { ok: true, completion: stripFence(completion) };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('ai:edit', async (_e, { text, instruction }) => {
    try {
      const mode = {
        explain: '解释这段代码的作用、思路和关键点，用简洁中文，不要改代码',
        comment: '为这段代码添加清晰的中文注释，保持代码逻辑不变',
        rewrite: '优化改写这段代码，保持功能一致，代码更清晰健壮',
        test: '为这段代码编写单元测试'
      }[instruction] || instruction;
      const prompt = '对以下代码执行操作：' + mode + '\n代码：\n```\n' + (text || '').slice(0, 12000) + '\n```';
      const result = await aiChat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 2000 });
      return { ok: true, result: stripFence(result), mode: instruction };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('ai:inline', async (_e, { code, instruction }) => {
    try {
      const prompt = [
        '你是代码编辑助手。用户对一段选中代码给出修改指令，请直接返回改写后的完整代码，不要解释、不要用代码块包裹、不要遗漏任何必要代码。',
        '用户指令：' + (instruction || '优化这段代码'),
        '原代码：',
        '```',
        (code || '').slice(0, 12000),
        '```',
        '改写后的完整代码：'
      ].join('\n');
      const result = await aiChat([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 2500 });
      return { ok: true, code: stripFence(result) };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('ai:diagnose', async (_e, { code, lang }) => {
    try {
      const prompt = [
        '你是代码审查助手。分析以下代码的潜在问题，返回 JSON 数组，每项含 line(行号), severity(取值 error/warning/info), message(简短中文问题描述), suggestion(修复建议)。',
        '只输出 JSON 数组，不要任何其他文字或代码块。示例：[{"line":3,"severity":"warning","message":"变量未使用","suggestion":"删除该变量"}]',
        '语言：' + (lang || '未知'),
        '代码：',
        '```',
        (code || '').slice(0, 12000),
        '```'
      ].join('\n');
      const result = await aiChat([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 1500 });
      const s = result.slice(result.indexOf('['), result.lastIndexOf(']') + 1);
      const arr = JSON.parse(s || '[]');
      return { ok: true, diagnostics: Array.isArray(arr) ? arr : [] };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
}

module.exports = { registerAi };
