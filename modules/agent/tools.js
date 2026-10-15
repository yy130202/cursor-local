/* Cursor Local - Agent 工具集
 *
 * 【设计意图】
 * 把「工具行为」与「工具分发」彻底解耦：
 *   - 新增一个工具 = 在本表追加一个条目 + 在 AGENT_TOOLS 补 schema，
 *     分发器（agent.js 的 executeTool）永远不需要改动。
 *   - 每个工具是一个纯职责的小函数，签名统一为 async (ctx) => string，
 *     返回值即回传给模型的 tool 消息内容。
 *
 * 【依赖注入】
 * 全部宿主能力通过 createToolHandlers(deps) 显式注入，
 * 避免本模块反向依赖 agent.js 闭包，也便于单测/mock。
 *
 * 【ctx 结构】
 *   agent      当前 Agent 实例（读写 changes / children 等）
 *   args       模型传入的参数对象
 *   cwd        工作目录绝对路径
 *   full       是否「完全访问」权限档位
 *   resolve(p) 把相对路径解析为绝对路径（基于 cwd）
 *   guard(p)   工作区边界校验（非 full 档位下拦截越界路径）
 *   log(l, m)  写入应用日志
 *   notifyFs(p) 通知渲染进程刷新文件树
 */
function createToolHandlers(deps) {
  const { fsp, path, win, addLog, runCommand, searchInDir, spawnChild,
    resolveAgentPath, assertRealInsideWorkspace, emitAgent,
    checkDangerousCommand, checkCatastrophic } = deps;

  /* ==========================================================================
     unified diff 解析与应用（apply_patch 的支撑逻辑）
     --------------------------------------------------------------------------
     【为什么要有它】
     write_file 只能整文件覆盖：模型想改一个函数名，也得先 read_file 读全文、
     再回写整份内容 —— 既浪费 token，又会在「文件已被他人/上一轮改动」时
     静默覆盖掉那些它没看到的修改。unified diff 只描述「改哪几行」，
     未提及的部分原样保留，这才是重构场景该有的写入方式。
     ========================================================================== */

  /** 去掉 a/ b/ ./ 前缀（git diff 的惯用写法） */
  function stripDiffAbbrev(p) {
    return p.replace(/^[ab]\//, '').replace(/^\.\//, '');
  }

  /**
   * 解析 unified diff，返回 [{ path, hunks: [{ oldStart, oldCount, lines }] }]
   * lines 里每项保留原始前缀：' ' 上下文 / '-' 删除 / '+' 新增
   * 支持标准格式（--- / +++ / @@）与简写头（*** Update File:）
   */
  function parseUnifiedDiff(text) {
    const rows = String(text).split('\n');
    const files = [];
    let cur = null;
    let hunk = null;
    for (let i = 0; i < rows.length; i++) {
      const L = rows[i];
      if (L.startsWith('--- ') && (rows[i + 1] || '').startsWith('+++ ')) {
        const oldPath = L.slice(4).trim();
        const newPath = rows[i + 1].slice(4).trim();
        const raw = newPath === '/dev/null' ? oldPath : newPath;
        cur = { path: stripDiffAbbrev(raw), hunks: [] };
        files.push(cur);
        hunk = null;
        i++;
        continue;
      }
      const shortcut = L.match(/^\*\*\* Update File:\s*(.+)$/);
      if (shortcut) {
        cur = { path: shortcut[1].trim(), hunks: [] };
        files.push(cur);
        hunk = null;
        continue;
      }
      const hm = L.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hm && cur) {
        hunk = {
          oldStart: parseInt(hm[1], 10),
          oldCount: hm[2] === undefined ? 1 : parseInt(hm[2], 10),
          lines: [],
        };
        cur.hunks.push(hunk);
        continue;
      }
      if (hunk && (/^[ +\-]/.test(L) || L === '')) {
        // diff 里的空行等价于「空的上下文行」（有些工具会省略行首空格）
        hunk.lines.push(L === '' ? ' ' : L);
      }
    }
    return files.filter((f) => f.hunks.length > 0);
  }

  /** 在 lines 中从 from 开始查找与 pat 完全一致的连续块，返回起始下标或 -1 */
  function findLineBlock(lines, pat, from) {
    if (pat.length === 0) return Math.min(Math.max(0, from), lines.length);
    for (let i = Math.max(0, from); i + pat.length <= lines.length; i++) {
      let same = true;
      for (let j = 0; j < pat.length; j++) {
        if (lines[i + j] !== pat[j]) { same = false; break; }
      }
      if (same) return i;
    }
    return -1;
  }

  /**
   * 应用 hunks。
   * before 为 null 表示目标文件不存在（纯新增）。
   * 定位策略：先按 hunk 声明的行号猜一次，失败则全文件搜索 ——
   * 因为模型给的行号常常带偏移，硬按行号写会在「差一行」时整段失败。
   * 返回 { ok, content?, added, removed, reason? }
   */
  function applyHunks(before, hunks) {
    if (before === null) {
      const out = [];
      for (const h of hunks) {
        if (h.oldCount !== 0) {
          return { ok: false, reason: '文件不存在，但补丁含上下文/删除行（新增文件应使用 @@ -0,0 +1,N @@）' };
        }
        for (const l of h.lines) if (l[0] === '+') out.push(l.slice(1));
      }
      return { ok: true, content: out.join('\n') + '\n', added: out.length, removed: 0 };
    }

    const work = before.split('\n');
    let delta = 0;
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      const oldBlock = h.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1));
      const newBlock = h.lines.filter((l) => l[0] === ' ' || l[0] === '+').map((l) => l.slice(1));
      let at = findLineBlock(work, oldBlock, h.oldStart - 1 + delta);
      if (at < 0) at = findLineBlock(work, oldBlock, 0); // 行号偏移兜底：全文件搜一次
      if (at < 0) {
        const preview = oldBlock.slice(0, 2).join(' / ').slice(0, 60);
        return { ok: false, reason: `第 ${h.oldStart} 行附近的上下文未匹配，文件可能已被改动（期望：${preview}）` };
      }
      work.splice(at, oldBlock.length, ...newBlock);
      delta += newBlock.length - oldBlock.length;
      added += h.lines.filter((l) => l[0] === '+').length;
      removed += h.lines.filter((l) => l[0] === '-').length;
    }
    return { ok: true, content: work.join('\n'), added, removed };
  }


  /** 通知渲染进程：文件已变更 */
  function notify(pathname) {
    const w = win();
    if (w && !w.isDestroyed()) w.webContents.send('fs:changed', { path: pathname });
  }

  /** 记录一次文件变更（供 UI 展示 diff 与回滚） */
  function recordChange(agent, file, before, after, existed) {
    const change = { path: file, relPath: path.relative(agent.cwd, file), before, after, existed };
    agent.changes = agent.changes || [];
    agent.changes.push(change);
    emitAgent(agent, 'change', change);
  }

  return {
    /* ---------- 只读类 ---------- */

    async list_dir({ cwd, args, resolve, guard }) {
      const dir = resolve(args.path || '.');
      await guard(dir);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.slice(0, 300)
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n') || '[空目录]';
    },

    async list_tree({ args, resolve, guard }) {
      const dir = resolve(args.path || '.');
      await guard(dir);
      const depth = Math.min(parseInt(args.depth, 10) || 3, 6);
      const lines = [];
      const walk = async (d, prefix, level) => {
        if (level > depth) return;
        let entries;
        try { await guard(d); entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
        for (const ent of entries.slice(0, 60)) {
          if (ent.name === 'node_modules' || ent.name === '.git') continue;
          lines.push(prefix + ent.name + (ent.isDirectory() ? '/' : ''));
          if (ent.isDirectory()) await walk(path.join(d, ent.name), prefix + '  ', level + 1);
        }
      };
      await walk(dir, '', 0);
      return lines.join('\n') || '[空]';
    },

    async read_file({ args, resolve, guard }) {
      const file = resolve(args.path);
      await guard(file);
      let content = await fsp.readFile(file, 'utf8');
      if (content.length > 80000) content = content.slice(0, 80000) + '\n...[文件过长已截断]';
      return content || '[空文件]';
    },

    async search_files({ args, resolve, guard }) {
      const dir = resolve(args.path || '.');
      await guard(dir);
      const hits = await searchInDir(dir, args.pattern || '', 50, guard);
      return hits.join('\n') || '[无匹配]';
    },

    async get_file_info({ args, resolve, guard }) {
      const file = resolve(args.path);
      await guard(file);
      const st = await fsp.stat(file);
      const ext = path.extname(file).slice(1) || '无';
      return `大小: ${st.size} 字节\n修改时间: ${new Date(st.mtimeMs).toLocaleString('zh-CN')}\n类型: ${st.isDirectory() ? '目录' : (ext + ' 文件')}`;
    },

    /* ---------- 修改类（受审批流与 Ask 只读模式约束） ---------- */

    async write_file({ agent, args, resolve, guard, log }) {
      const file = resolve(args.path);
      await guard(file);
      const content = args.content ?? '';
      let before = null, existed = false;
      try { before = await fsp.readFile(file, 'utf8'); existed = true; } catch { /* 新建文件 */ }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, 'utf8');
      log('info', '写入文件 ' + file);
      if (before !== content) recordChange(agent, file, before, content, existed);
      notify(file);
      return `[OK] 已写入 ${file}（${content.length} 字符）`;
    },

    async delete_file({ args, resolve, guard, log }) {
      const file = resolve(args.path);
      await guard(file);
      await fsp.rm(file, { recursive: false, force: true });
      log('warning', '删除文件 ' + file);
      notify(file);
      return '[OK] 已删除 ' + file;
    },

    async move_file({ args, resolve, guard, log }) {
      const from = resolve(args.from);
      const to = resolve(args.to);
      await guard(from); await guard(to);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      log('info', '移动 ' + from + ' → ' + to);
      notify(from);
      return '[OK] 已移动 ' + from + ' → ' + to;
    },

    async apply_patch({ agent, args, resolve, guard, log }) {
      /*
       * 多文件补丁：一次调用精确改动若干处上下文，而不是整文件覆盖。
       * 与 write_file 的分工 —— 局部修改走 apply_patch（省 token、不动未提及的内容、
       * 上下文不匹配时明确报错而非硬写），整文件新建/替换才用 write_file。
       * 逐文件独立校验：某个文件失败不影响其余文件落盘，且失败原因会回到模型手里，
       * 由它决定是重新 read_file 再生成补丁，还是改用 write_file。
       */
      const text = String(args.patch || args.diff || '');
      if (!text.trim()) return 'ERROR: apply_patch 需要提供 patch（unified diff 文本）';
      const files = parseUnifiedDiff(text);
      if (!files.length) {
        return 'ERROR: 未能从 patch 解析出文件段。请使用 unified diff 格式：\n'
          + '--- a/路径\n+++ b/路径\n@@ -起始行,行数 +起始行,行数 @@\n 上下文行\n-被删除行\n+新增行';
      }
      const report = [];
      let applied = 0;
      let failed = 0;
      for (const f of files) {
        try {
          const target = resolve(f.path);
          await guard(target);
          let before = null;
          try { before = await fsp.readFile(target, 'utf8'); } catch { /* 新建文件 */ }
          const r = applyHunks(before, f.hunks);
          if (!r.ok) { failed++; report.push('✗ ' + f.path + '：' + r.reason); continue; }
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, r.content, 'utf8');
          recordChange(agent, target, before, r.content, before !== null);
          notify(target);
          applied++;
          report.push('✓ ' + f.path + '  +' + r.added + ' -' + r.removed);
        } catch (e) {
          failed++;
          report.push('✗ ' + f.path + '：' + (e && e.message ? e.message : String(e)));
        }
      }
      log(failed ? 'warning' : 'info', 'apply_patch: ' + applied + ' 个文件成功、' + failed + ' 个失败');
      return '[' + (failed ? '部分失败' : 'OK') + '] 补丁应用结果（' + applied + '/' + files.length + ' 个文件）：\n' + report.join('\n');
    },

    /* ---------- 子任务（并行/串行拆解，DSH 的子 Agent 思路） ---------- */

    async spawn_subagent({ agent, args, cwd, log }) {
      /*
       * 把一个独立子目标交给新的子 agent，并等待其完成。
       * 典型用途：把「读三个模块分别总结」拆成三个并行子任务；
       * 或把长任务的后半段拆出去，让父任务先返回中间结论。
       * 注意：子任务同样受父级的权限档位与沙箱约束（创建时继承 cwd/mode）。
       */
      const task = String(args.task || '').trim();
      if (!task) return 'ERROR: spawn_subagent 需要提供 task（子任务描述）';
      const parentId = agent && agent.id;
      if (!parentId) return 'ERROR: 当前没有父会话上下文';
      const r = await spawnChild({ parentId, task, cwd: args.cwd || cwd, mode: args.mode });
      if (!r.ok) return `[子任务未成功完成] ${r.reason || r.status || '未知原因'}`;
      const body = r.summary ? `\n\n子任务结论：\n${r.summary}` : '';
      return `[OK] 子任务 ${r.id} 已完成（${r.status}）${body}`;
    },

    /* ---------- 命令执行 ---------- */

    async run_command({ cwd, args, agent, full, log }) {
      const cmd = args.command || 'echo no-command';
      // 完全访问档位只拦「毁灭性」命令；受限档位额外拦「危险」命令
      const blocked = full ? checkCatastrophic(cmd) : checkDangerousCommand(cmd);
      if (blocked) {
        log('warning', '拦截命令: ' + cmd + '（' + blocked + '）');
        return `[已拦截危险命令] 检测到「${blocked}」，已拒绝执行。\n如需执行请手动在系统终端操作。`;
      }
      if (full) log('warning', '[完全控制] 执行: ' + cmd);
      const r = await runCommand(cwd, cmd, agent);
      if (r.code !== 0) log('warning', '命令退出码 ' + r.code + ': ' + cmd);
      else log('info', '命令成功: ' + cmd);
      return `退出码: ${r.code}\n${r.output}`;
    }
  };
}

module.exports = { createToolHandlers };
