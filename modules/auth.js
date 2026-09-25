/* Cursor Local - 用户系统模块（本地存储 + 预留云接口） */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function registerAuth(ipcMain, { getUserStore }) {
  const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
  function getSession() {
    try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch { return null; }
  }
  function setSession(s) {
    if (s) {
      fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
      fs.writeFileSync(sessionFile(), JSON.stringify(s), 'utf8');
    } else {
      try { fs.rmSync(sessionFile(), { force: true }); } catch { /* 忽略 */ }
    }
  }

  ipcMain.handle('auth:register', (_e, { username, email, password }) => {
    const store = getUserStore();
    if (!username || !password) return { ok: false, error: '用户名和密码不能为空' };
    if (store.findByUsername(username)) return { ok: false, error: '用户名已存在' };
    if (email && store.findByEmail(email)) return { ok: false, error: '邮箱已被注册' };
    const user = store.createUser({ username, email, password });
    setSession({ userId: user.id });
    return { ok: true, user };
  });

  ipcMain.handle('auth:login', (_e, { account, password }) => {
    const store = getUserStore();
    const user = store.findByUsername(account) || store.findByEmail(account);
    if (!user || !store.verifyPassword(user, password)) {
      return { ok: false, error: '用户名/邮箱或密码错误' };
    }
    setSession({ userId: user.id });
    return { ok: true, user };
  });

  ipcMain.handle('auth:logout', () => { setSession(null); return { ok: true }; });
  ipcMain.handle('auth:current', () => {
    const s = getSession();
    return s ? getUserStore().getUser(s.userId) : null;
  });
  ipcMain.handle('auth:updateProfile', (_e, patch) => {
    const s = getSession();
    if (!s) return { ok: false, error: '未登录' };
    return { ok: true, user: getUserStore().updateUser(s.userId, patch) };
  });
}

module.exports = { registerAuth };
