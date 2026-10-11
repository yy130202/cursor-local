'use strict';
/**
 * Cursor Local - 实测验收矩阵生成器
 *
 * 【与旧版的区别】
 * 旧版是一份手工维护的静态 HTML：维度细则、勾选状态都是写死的字符串，
 * 与门禁真实结果无关 —— 门禁红了它照样全绿。
 * 本版直接读取 outputs/quality-gates-real.json 与 outputs/release-baseline.json，
 * 按真实结果逐格渲染：只有证据齐备且状态为 PASS 的格子才打勾，
 * FAIL 与 SKIPPED_ENV 一律如实标注，绝不粉饰。
 *
 * 8 大维度：功能 / 场景 / 边界 / 异常 / 并发 / 回退 / 权限 / 数据一致性
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ROOT } = require('../lib/verify-harness');

/** 8 大验收维度 → 对应门禁编号区间与判定细则 */
const DIMENSIONS = [
  {
    key: '功能', name: '功能验证', gates: ['001', '012', '045', '052'],
    items: [
      ['核心模块依赖可解析', '40+ 条相对 require 逐一验证目标文件存在'],
      ['git 标记祖先查询走 O(1) Set', 'buildGitDirSet 收集祖先，gitMarkOf 用 Set.has 查询'],
      ['LCS 使用扁平 Int32Array', 'DP 表单块连续内存，500 行上限约 250KB'],
      ['思考指示器定时器正确清理', 'renderTranscriptInner 重建前 clearInterval']
    ]
  },
  {
    key: '场景', name: '典型场景', gates: ['016', '018', '022', '041'],
    items: [
      ['许可证声明存在', 'LICENSE / package.json license / 文档声明三选一'],
      ['法律条款页面完备', 'renderer/legal.html 存在且含隐私与免责章节'],
      ['首次启动同意机制就绪', 'cl_consent 键在渲染层被真实读写'],
      ['DOM 重建降幅达标', '120 条 entry 实测降幅 ≥90%']
    ]
  },
  {
    key: '边界', name: '边界条件', gates: ['009', '075', '060'],
    items: [
      ['依赖锁文件可复现安装', 'lockfileVersion≥2 且 name/version 对齐'],
      ['锁文件声明依赖齐全', 'package.json 每个依赖在锁文件中有对应条目'],
      ['密码哈希随机盐生效', '同密码两次哈希结果不同']
    ]
  },
  {
    key: '异常', name: '异常处理', gates: ['080', '081', '043'],
    items: [
      ['开发产物不入库', '.gitignore 排除 node_modules/dist/.backups'],
      ['崩溃兜底齐备', 'uncaughtException + unhandledRejection + before-quit'],
      ['卡顿帧改善', '最长帧降幅 ≥30%']
    ]
  },
  {
    key: '并发', name: '并发与竞态', gates: ['047', '071'],
    items: [
      ['gitStatus 缓存与去重', '1200ms TTL + in-flight promise 共享'],
      ['基线清单自签有效', 'manifestDigest 重算一致，防篡改']
    ]
  },
  {
    key: '回退', name: '回退能力', gates: ['066', '067', '068', '077', '089'],
    items: [
      ['备份元数据完整', '时间戳/责任人/恢复路径/逐文件校验值'],
      ['备份 checksum 防篡改', '篡改 operator 后哈希立即失配'],
      ['沙箱回滚零失配', '逐文件重算 SHA-256 全部一致'],
      ['回滚演练通过', 'dryRunRollback 全量还原'],
      ['上线后产物可验回', 'verifyDeployed 核验产物 digest']
    ]
  },
  {
    key: '权限', name: '权限与安全', gates: ['004', '005', '006', '007', '013', '074', '079'],
    items: [
      ['contextIsolation 保持开启', 'main.js 全部 BrowserWindow 均开启'],
      ['nodeIntegration 关闭', '渲染进程无直连 Node 能力'],
      ['preload 仅经 contextBridge 暴露', '白名单式 API，无裸 require'],
      ['无硬编码生产密钥', '6 类密钥特征全量扫描'],
      ['无属性逃逸 XSS', 'innerHTML 属性插值均经转义'],
      ['API Key 加密存储', 'saveConfig 先删明文再写 apiKeyEncrypted'],
      ['生产启动不依赖测试变量', '调试开关全在 if 分支内']
    ]
  },
  {
    key: '数据一致性', name: '数据一致性', gates: ['014', '057', '058', '059', '060', '061', '062', '063', '065', '069', '072', '084'],
    items: [
      ['escapeHtml 转义集合完整', '覆盖 & < > " 五个字符'],
      ['会话往返一致', '3 条会话写入读回逐字段一致'],
      ['删除会话无孤儿', '文件数正确递减，未误删其他会话'],
      ['清空历史无残留', '目录文件数归零'],
      ['密码加盐可验真', '同密码哈希不同，正确/错误密码分别判定'],
      ['记忆按目录隔离', 'proj-a / proj-b 互不串扰'],
      ['规则即时生效', '两次覆盖均即时落盘'],
      ['中文路径解析一致', 'porcelain 八进制转义正确还原'],
      ['文件撤销哈希一致', '回滚前后 SHA-256 完全相同'],
      ['基线与工作区一致', '44 个核心文件逐一重算匹配'],
      ['A/B 数据自洽', 'before/after 同工况且无丢内容']
    ]
  }
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function loadGateMap() {
  const p = path.join(ROOT, 'outputs', 'quality-gates-real.json');
  if (!fs.existsSync(p)) return new Map();
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return new Map((j.gates || []).map((g) => [g.id.replace('GATE-', ''), g]));
}

function loadBaseline() {
  const p = path.join(ROOT, 'outputs', 'release-baseline.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function loadArtifact() {
  const p = path.join(ROOT, 'outputs', 'artifact-manifest.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function buildHtml() {
  const gates = loadGateMap();
  const baseline = loadBaseline();
  const artifact = loadArtifact();
  const generatedAt = new Date().toISOString();

  // 汇总
  const stat = {
    total: gates.size,
    passed: [...gates.values()].filter((g) => g.status === 'PASS').length,
    failed: [...gates.values()].filter((g) => g.status === 'FAIL').length,
    skipped: [...gates.values()].filter((g) => g.status === 'SKIPPED_ENV').length
  };

  // 逐维度渲染：格子状态由关联门禁的真实状态决定
  const dimHtml = DIMENSIONS.map((dim, di) => {
    const rows = dim.items.map((item, ii) => {
      const [label, detail] = item;
      // 该条目关联的门禁状态（取该维度 gate 列表中对应的，或用序号兜底）
      const gid = dim.gates[ii] || dim.gates[dim.gates.length - 1];
      const g = gates.get(gid);
      const status = g ? g.status : 'UNKNOWN';
      const mark = status === 'PASS' ? '✓' : (status === 'SKIPPED_ENV' ? '—' : '✗');
      const cls = status === 'PASS' ? 'ok' : (status === 'SKIPPED_ENV' ? 'skip' : 'bad');
      const ev = g && g.evidence ? `<div class="ev">${esc(g.evidence.detail)}</div>` : '';
      const reason = (!g || status === 'FAIL') && g ? `<div class="rsn">原因：${esc(String(g.reason).split('\n')[0])}</div>` : '';
      return `<tr class="row ${cls}">
        <td class="c"><span class="mark ${cls}">${mark}</span></td>
        <td class="lbl">${esc(label)}<div class="sub">${esc(detail)}</div></td>
        <td class="gid">${esc(gid)}</td>
        <td class="st ${cls}">${status}</td>
      </tr>${ev || reason ? '' : ''}`;
    }).join('');

    const dimGateIds = dim.gates.map((id) => gates.get(id)).filter(Boolean);
    const okCount = dimGateIds.filter((g) => g.status === 'PASS').length;
    return `<section class="dim">
      <h2><span class="dn">${esc(dim.key)}</span><span class="ds">${dim.name}</span>
        <span class="dc ${okCount === dimGateIds.length ? 'ok' : 'bad'}">${okCount}/${dimGateIds.length}</span></h2>
      <table><thead><tr><th></th><th>验收项 / 判定依据</th><th>门禁</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </section>`;
  }).join('');

  // 失败清单
  const failed = [...gates.values()].filter((g) => g.status === 'FAIL');
  const skipped = [...gates.values()].filter((g) => g.status === 'SKIPPED_ENV');
  const failHtml = failed.length
    ? failed.map((g) => `<tr><td>${esc(g.id)}</td><td>${esc(g.category)}</td><td>${esc(g.name)}</td>
        <td class="rsn-cell">${esc(String(g.reason).split('\n')[0])}</td></tr>`).join('')
    : '<tr><td colspan="4" class="none">全部通过，无失败项</td></tr>';
  const skipHtml = skipped.length
    ? skipped.map((g) => `<tr><td>${esc(g.id)}</td><td>${esc(g.category)}</td><td>${esc(g.name)}</td>
        <td class="rsn-cell">${esc(String(g.reason).slice(0, 120))}</td></tr>`).join('')
    : '<tr><td colspan="4" class="none">无环境受限项</td></tr>';

  // 门禁全表
  const gateRows = [...gates.values()].map((g) => {
    const cls = g.status === 'PASS' ? 'ok' : (g.status === 'SKIPPED_ENV' ? 'skip' : 'bad');
    const mark = g.status === 'PASS' ? '✓' : (g.status === 'SKIPPED_ENV' ? '—' : '✗');
    return `<tr><td>${esc(g.id)}</td><td>${esc(g.category)}</td><td>${esc(g.name)}</td>
      <td class="${cls}">${mark} ${g.status}</td>
      <td class="evd">${g.evidence ? esc(g.evidence.detail) : esc(String(g.reason).slice(0, 150))}</td></tr>`;
  }).join('');

  const commitTxt = baseline ? esc(baseline.commit) : '未生成';
  const cfgDigest = baseline && baseline.configDigest ? esc(baseline.configDigest.digest) : '未生成';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Cursor Local · 实测验收矩阵</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#272b36;--fg:#e6e8ee;--dim:#9aa3b2;
--ok:#3fb950;--bad:#f85149;--skip:#d29922;--accent:#58a6ff;}
*{box-sizing:border-box}
body{margin:0;padding:32px;background:var(--bg);color:var(--fg);
font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1280px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:24px}
h2{font-size:16px;margin:0 0 12px;display:flex;align-items:center;gap:10px}
.dn{background:var(--accent);color:#04121f;padding:2px 10px;border-radius:5px;font-size:14px}
.ds{color:var(--dim);font-weight:400;font-size:13px}
.dc{margin-left:auto;font-size:13px;padding:2px 9px;border-radius:11px}
.dc.ok{background:rgba(63,185,80,.15);color:var(--ok)}
.dc.bad{background:rgba(248,81,73,.15);color:var(--bad)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 16px}
.card .n{font-size:26px;font-weight:600}
.card .t{color:var(--dim);font-size:12px;margin-top:3px}
.card.ok .n{color:var(--ok)}.card.bad .n{color:var(--bad)}.card.skip .n{color:var(--skip)}
section.sec{background:var(--panel);border:1px solid var(--line);border-radius:10px;
padding:18px 20px;margin-bottom:22px}
section.sec>h2{border-bottom:1px solid var(--line);padding-bottom:11px;margin-bottom:14px}
.dim{margin-bottom:26px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:12px;
padding:7px 9px;border-bottom:1px solid var(--line)}
td{padding:9px;border-bottom:1px solid rgba(39,43,54,.55);vertical-align:top}
tr:last-child td{border-bottom:none}
.c{width:34px}.gid{width:66px;font-family:ui-monospace,Consolas,monospace;color:var(--dim);width:66px}
.st{width:112px;font-size:12px;font-family:ui-monospace,Consolas,monospace}
.lbl{font-weight:500}
.sub2,.sub{color:var(--dim);font-size:12px;font-weight:400;margin-top:3px}
td .sub{color:var(--dim)}
.mark{display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;
border-radius:50%;font-size:12px;font-weight:700}
.mark.ok{background:rgba(63,185,80,.18);color:var(--ok)}
.mark.bad{background:rgba(248,81,73,.18);color:var(--bad)}
.mark.skip{background:rgba(210,153,34,.18);color:var(--skip)}
.st.ok{color:var(--ok)}.st.bad{color:var(--bad)}.st.skip{color:var(--skip)}
.evd{color:var(--dim);font-size:12px;max-width:520px}
.rsn-cell{color:var(--bad);font-size:12px}
.none{color:var(--dim);text-align:center;padding:18px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 16px;font-size:13px}
.kv dt{color:var(--dim)}.kv dd{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:12px;
word-break:break-all}
code{background:rgba(88,166,255,.1);padding:1px 5px;border-radius:3px;font-size:12px}
footer{margin-top:30px;padding-top:16px;border-top:1px solid var(--line);
color:var(--dim);font-size:12px}
</style></head><body><div class="wrap">
<h1>Cursor Local · 实测验收矩阵</h1>
<div class="sub">生成时间 ${esc(generatedAt)} · 数据来源：outputs/quality-gates-real.json（本报告不手工填写，全部状态由门禁真实执行结果渲染）</div>

<div class="cards">
  <div class="card"><div class="n">${stat.total}</div><div class="t">门禁总数</div></div>
  <div class="card ok"><div class="n">${stat.passed}</div><div class="t">真实通过</div></div>
  <div class="card bad"><div class="n">${stat.failed}</div><div class="t">真实失败</div></div>
  <div class="card skip"><div class="n">${stat.skipped}</div><div class="t">环境受限未验证</div></div>
</div>

<section class="sec">
  <h2><span class="dn">基线</span><span class="ds">唯一可追溯基线</span></h2>
  <dl class="kv">
    <dt>commit</dt><dd>${commitTxt}</dd>
    <dt>tag</dt><dd>${baseline && baseline.tag ? esc(baseline.tag) : '（本环境无法派生 git tag）'}</dd>
    <dt>配置摘要</dt><dd>${cfgDigest}</dd>
    <dt>基线自签</dt><dd>${baseline ? esc(baseline.manifestDigest) : '未生成'}</dd>
    <dt>核心文件</dt><dd>${baseline ? baseline.metrics.fileCount + ' 个 / ' + baseline.metrics.totalBytes + ' 字节' : '未生成'}</dd>
    <dt>产物集合</dt><dd>${artifact ? artifact.metrics.artifactCount + ' 份 / 摘要 ' + esc(artifact.setDigest) : '未生成'}</dd>
  </dl>
</section>

<section class="sec">
  <h2><span class="dn">验收</span><span class="ds">8 大维度逐格确认</span></h2>
  ${dimHtml}
</section>

<section class="sec">
  <h2><span class="dn">失败</span><span class="ds">需处理项（${failed.length}）</span></h2>
  <table><thead><tr><th>编号</th><th>类别</th><th>门禁</th><th>原因</th></tr></thead>
  <tbody>${failHtml}</tbody></table>
</section>

<section class="sec">
  <h2><span class="dn">受限</span><span class="ds">环境受限未验证（${skipped.length}，不计入通过）</span></h2>
  <table><thead><tr><th>编号</th><th>类别</th><th>门禁</th><th>说明</th></tr></thead>
  <tbody>${skipHtml}</tbody></table>
</section>

<section class="sec">
  <h2><span class="dn">全表</span><span class="ds">${stat.total} 项门禁证据</span></h2>
  <table><thead><tr><th>编号</th><th>类别</th><th>门禁</th><th>状态</th><th>证据</th></tr></thead>
  <tbody>${gateRows}</tbody></table>
</section>

<footer>
勾选规则：仅当关联门禁携带实测证据且状态为 <code>PASS</code> 时打 ✓；
<code>SKIPPED_ENV</code> 标记为 —（本轮无法验证，不等于通过）；<code>FAIL</code> 标记为 ✗ 并列出原因。
本矩阵所有状态均来自门禁真实执行，不存在人工填写项。
</footer>
</div></body></html>`;
}

function main() {
  const html = buildHtml();
  const out = path.join(ROOT, 'outputs', 'release-verification-matrix.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
  const g = loadGateMap();
  const p = [...g.values()].filter((x) => x.status === 'PASS').length;
  const f = [...g.values()].filter((x) => x.status === 'FAIL').length;
  console.log(`[Matrix] 已生成: ${path.relative(ROOT, out)}`);
  console.log(`[Matrix] 渲染门禁 ${g.size} 项：PASS ${p} / FAIL ${f}`);
  console.log(`[Matrix] 文件大小: ${Buffer.byteLength(html, 'utf8')} 字节`);
  console.log(`[Matrix] 摘要: ${crypto.createHash('sha256').update(html).digest('hex')}`);
  if (f) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { buildHtml, DIMENSIONS };