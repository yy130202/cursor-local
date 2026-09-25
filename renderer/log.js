/* Cursor Local - 日志面板（Debug / Info / Warning / Error） */
let logFilter = 'all';
const logEntries = [];

function renderLogs() {
  const list = document.getElementById('log-list');
  const filtered = logEntries.filter((e) => logFilter === 'all' || e.level === logFilter);
  list.innerHTML = '';
  for (const e of filtered) {
    const d = document.createElement('div');
    d.className = 'log-item ' + e.level;
    const time = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
    d.innerHTML =
      '<span class="log-lv">' + e.level + '</span>' +
      '<span class="log-src">' + escapeHtml(e.source || '') + '</span>' +
      '<span class="log-msg">' + escapeHtml(e.message) + '</span>' +
      '<span class="log-time">' + time + '</span>';
    list.appendChild(d);
  }
  list.scrollTop = list.scrollHeight;
}

function initLog() {
  window.api.onLog((entry) => {
    logEntries.push(entry);
    if (logEntries.length > 800) logEntries.shift();
    const panel = document.getElementById('log-panel');
    if (panel && !panel.classList.contains('hidden')) renderLogs();
  });
  window.api.getLogs().then((logs) => { logEntries.push(...logs); });

  document.getElementById('log-btn').onclick = () => {
    const p = document.getElementById('log-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) renderLogs();
  };
  document.getElementById('log-close').onclick = () => document.getElementById('log-panel').classList.add('hidden');
  document.getElementById('log-clear').onclick = async () => {
    await window.api.clearLogs();
    logEntries.length = 0;
    renderLogs();
  };
  document.querySelectorAll('#log-filters button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#log-filters button').forEach((x) => x.classList.toggle('active', x === b));
      logFilter = b.dataset.lv;
      renderLogs();
    };
  });
}
initLog();
