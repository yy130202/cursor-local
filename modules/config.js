/* Cursor Local - 配置模块（持久化 + API Key 加密） */
const path = require('path');
const fs = require('fs');
const { app, safeStorage } = require('electron');

const configPath = () => process.env.CONFIG_PATH || path.join(app.getPath('userData'), 'config.json');

function decryptApiKey(raw) {
  // 旧版明文（迁移：下次保存会自动转加密）
  if (raw && raw.apiKey) return raw.apiKey;
  if (raw && raw.apiKeyEncrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(raw.apiKeyEncrypted, 'base64'));
      }
      return '';
    } catch {
      return '';
    }
  }
  return '';
}

function loadConfig() {
  const defaults = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    lastFolder: '',
    theme: { preset: 'aurora', custom: null },
    aiComplete: true,
    permission: 'safe',
    keybindings: {}
  };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { ...defaults, ...raw, apiKey: decryptApiKey(raw) };
  } catch {
    return defaults;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const out = { ...cfg };
  const key = out.apiKey || '';
  delete out.apiKey;
  delete out.apiKeyEncrypted;
  if (key) {
    if (safeStorage.isEncryptionAvailable()) {
      out.apiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
    } else {
      out.apiKey = key; // 降级明文存储
      console.warn('[config] safeStorage 不可用，API Key 将以明文存储（请勿在不受信任的环境使用）');
    }
  }
  fs.writeFileSync(configPath(), JSON.stringify(out, null, 2), 'utf8');
}

function registerConfig(ipcMain) {
  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:set', (_e, partial) => {
    const cfg = { ...loadConfig(), ...partial };
    saveConfig(cfg);
    return cfg;
  });
}

module.exports = { configPath, loadConfig, saveConfig, registerConfig };
