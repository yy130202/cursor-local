// 用户存储层：本地实现 + 预留云端接口
// 设计原则：UserStore 抽象出统一接口，未来无缝切换到云端（cloud-service）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------- 密码哈希（scrypt + 盐） ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}

function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

/* ---------------- 统一接口（UserStore 契约） ----------------
 * createUser({username,email,password}) -> user
 * findByUsername(username) -> user | null
 * findByEmail(email) -> user | null
 * verifyPassword(user, password) -> boolean
 * updateUser(id, patch) -> user
 * getUser(id) -> user | null
 */
class LocalUserStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this._load();
  }

  _load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(this.data.users)) this.data.users = [];
    } catch {
      this.data = { users: [] };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  createUser({ username, email, password }) {
    this._load();
    const user = {
      id: 'u_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
      username: String(username).trim(),
      email: String(email).trim().toLowerCase(),
      passwordHash: hashPassword(password),
      createdAt: Date.now()
    };
    this.data.users.push(user);
    this._save();
    return sanitizeUser(user);
  }

  findByUsername(username) {
    this._load();
    return this.data.users.find((u) => u.username === String(username).trim()) || null;
  }

  findByEmail(email) {
    this._load();
    return this.data.users.find((u) => u.email === String(email).trim().toLowerCase()) || null;
  }

  verifyPassword(user, password) {
    return verifyPassword(password, user.passwordHash);
  }

  updateUser(id, patch) {
    this._load();
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return null;
    if (patch.username !== undefined) u.username = String(patch.username).trim();
    if (patch.email !== undefined) u.email = String(patch.email).trim().toLowerCase();
    if (patch.avatarColor !== undefined) u.avatarColor = patch.avatarColor;
    this._save();
    return sanitizeUser(u);
  }

  getUser(id) {
    this._load();
    return sanitizeUser(this.data.users.find((x) => x.id === id) || null);
  }
}

/* ---------------- 云端实现占位（预留，暂不启用） ----------------
 * 未来接入 cloud-service / 自建后端时，实现同一套接口即可无缝替换。
 * 典型实现：POST /auth/register、/auth/login，返回 JWT；密码哈希在服务端完成。
 */
class CloudUserStore {
  constructor(config) {
    throw new Error('CloudUserStore 尚未启用，当前使用本地存储');
  }
}

module.exports = { LocalUserStore, CloudUserStore, hashPassword, verifyPassword, sanitizeUser };
