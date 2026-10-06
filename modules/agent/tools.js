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
  const { fsp, path, win, addLog, runCommand, searchInDir,
    resolveAgentPath, assertRealInsideWorkspace, emitAgent,
    checkDangerousCommand, checkCatastrophic } = deps;

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
