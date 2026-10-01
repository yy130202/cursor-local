/* Cursor Local - 记忆与规则模块（本地 JSON/Markdown，跨会话共享，参考 CodeBuddy 记忆/规则页） */
const fs = require('fs');
const path = require('path');
const os = require('os');

function createMemoryModule() {
  const baseDir = path.join(os.homedir(), '.cursor-local');
  const userMemFile = path.join(baseDir, 'memory.json');
  const userRulesFile = path.join(baseDir, 'rules.md');

  function ensureDir(f) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* ignore */ } }
  function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }
  function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
  function writeJson(f, v) { ensureDir(f); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8'); }
  function writeText(f, v) { ensureDir(f); fs.writeFileSync(f, v || '', 'utf8'); }

  const projectMemFile = (cwd) => path.join(cwd, '.cursor-local', 'memory.json');
  const projectRulesFile = (cwd) => path.join(cwd, '.cursor-local', 'rules.md');
  const fileFor = (cwd, scope, isRules) => {
    const project = scope === 'project' && cwd;
    return isRules
      ? (project ? projectRulesFile(cwd) : userRulesFile)
      : (project ? projectMemFile(cwd) : userMemFile);
  };

  function getMemory(cwd) {
    return { global: readJson(userMemFile, []), project: cwd ? readJson(projectMemFile(cwd), []) : [] };
  }
  function addMemory(cwd, scope, text) {
    const f = fileFor(cwd, scope, false);
    const list = readJson(f, []);
    list.push({ id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), text: String(text || '').trim(), ts: Date.now() });
    writeJson(f, list);
    return { ok: true };
  }
  function removeMemory(cwd, scope, id) {
    const f = fileFor(cwd, scope, false);
    writeJson(f, readJson(f, []).filter((m) => m.id !== id));
    return { ok: true };
  }
  function clearMemory(cwd, scope) {
    writeJson(fileFor(cwd, scope, false), []);
    return { ok: true };
  }

  function getRules(cwd) {
    return { user: readText(userRulesFile), project: cwd ? readText(projectRulesFile(cwd)) : '' };
  }
  function setRules(cwd, scope, text) {
    writeText(fileFor(cwd, scope, true), String(text || ''));
    return { ok: true };
  }

  function register(ipcMain) {
    ipcMain.handle('memory:get', (_e, cwd) => getMemory(cwd));
    ipcMain.handle('memory:add', (_e, { cwd, scope, text }) => addMemory(cwd, scope, text));
    ipcMain.handle('memory:remove', (_e, { cwd, scope, id }) => removeMemory(cwd, scope, id));
    ipcMain.handle('memory:clear', (_e, { cwd, scope }) => clearMemory(cwd, scope));
    ipcMain.handle('rules:get', (_e, cwd) => getRules(cwd));
    ipcMain.handle('rules:set', (_e, { cwd, scope, text }) => setRules(cwd, scope, text));
  }

  return { register, getMemory, getRules };
}

module.exports = { createMemoryModule };
