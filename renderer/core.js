/* Cursor Local - 核心工具层
 *
 * 【设计约定】
 * 1. 本文件必须最先加载（index.html 中位于所有业务脚本之前）。
 * 2. 跨文件共享的纯函数统一挂到 window.CL.util，不再散落为裸全局，
 *    避免「谁定义了什么」需要靠加载顺序推断的隐式依赖。
 * 3. 本文件不触碰 DOM、不读配置、不注册事件——保持零副作用，可安全被任何模块依赖。
 */
(function () {
  const CL = (window.CL = window.CL || {});

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /* 扩展名 → lucide 图标名（按类型分组的快速查表） */
  const ICON_BY_EXT = {
    'file-code': ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'yml', 'yaml', 'toml', 'dockerfile', 'gradle', 'properties'],
    'file-json': ['json', 'jsonc', 'json5'],
    'file-text': ['md', 'markdown', 'txt', 'log', 'csv'],
    'file-image': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'avif'],
    'file-archive': ['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'],
    'file-video': ['mp4', 'webm', 'mov', 'mkv', 'avi'],
    'file-audio': ['mp3', 'ogg', 'wav', 'flac', 'm4a']
  };

  /* Monaco 语言 id → 状态栏显示名 */
  const LANG_DISPLAY = {
    javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', html: 'HTML',
    css: 'CSS', markdown: 'Markdown', python: 'Python', shell: 'Shell', yaml: 'YAML',
    xml: 'XML', sql: 'SQL', plaintext: '纯文本'
  };

  CL.util = {
    /**
     * HTML 转义。null / undefined → 空字符串（不是 "null" 字面量）。
     * 历史上此函数在 auth.js 与 editor.js 各有一份且实现不同，
     * 靠 script 加载顺序决定生效版本——现已统一到此处。
     */
    escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
    },

    /** 取文件扩展名（小写；Dockerfile 等无扩展名文件特殊处理）。 */
    extOf(p) {
      const base = String(p || '').split(/[\\/]/).pop().toLowerCase();
      if (base === 'dockerfile') return 'dockerfile';
      const i = base.lastIndexOf('.');
      return i >= 0 ? base.slice(i + 1) : '';
    },

    /** 按扩展名选 lucide 图标名，未命中返回通用 file 图标。 */
    fileIconName(ext) {
      const e = String(ext || '').toLowerCase();
      for (const [icon, exts] of Object.entries(ICON_BY_EXT)) {
        if (exts.includes(e)) return icon;
      }
      return 'file';
    },

    /** Monaco 语言 id → 状态栏显示名。 */
    langDisplay(id) {
      return LANG_DISPLAY[id] || (id || '纯文本');
    },

    /** 去掉 ANSI 转义序列（终端输出流展示前需清理）。 */
    stripAnsi(s) {
      // eslint-disable-next-line no-control-regex
      return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '');
    },

    /** 路径分隔符统一为 /（用于展示与 key 构造）。 */
    toPosix(p) {
      return String(p || '').replace(/\\/g, '/');
    },

    /** 取路径最后一段（跨平台安全）。 */
    basename(p) {
      return String(p || '').split(/[\\/]/).pop();
    }
  };
})();
