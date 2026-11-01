// 任务B 云端管线 v3（on-monitor 服务器入口）——server.js 定时/手动调用的入口
// 职责：写 last_run.txt → 调 scripts_v2/run.js（抓目录+全量库存+门槛+ Bark）→ 生成新面板
// 旧逻辑（nd_fetch/nd_stock/无条件推）已废弃但文件保留作回滚
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');          // nd/
const V2 = path.join(__dirname, '..', 'scripts_v2'); // 入口在 nd/scripts/，实现在 nd/scripts_v2/

try { fs.writeFileSync(path.join(ROOT, 'data', 'last_run.txt'), new Date().toISOString()); } catch (e) {}
// 强制无头：有头模式在沙箱里屡被 OOM 掐（exit 137），无头 + Cookie 注入实测可过 Akamai
process.env.ND_HEADLESS = '1';

const args = [];
if (process.env.REPORT_ONLY === '1' || process.argv.includes('--report-only')) args.push('--report-only');
if (process.argv.includes('--dry-run')) args.push('--dry-run');

const r = spawnSync(process.execPath, [path.join(V2, 'run.js'), ...args],
  { encoding: 'utf8', timeout: 40 * 60 * 1000, env: process.env });
console.log((r.stdout || '').trim());
if (r.stderr) console.log('[run stderr]', r.stderr.trim().slice(-600));

// 面板（panel.js 自带 DATA 路径解析，输出 nd/reports/panel.html），并同步为 dashboard.html 供总控卡片
const p = spawnSync(process.execPath, [path.join(V2, 'panel.js')], { encoding: 'utf8', timeout: 120000 });
console.log('[panel]', String(p.stdout || '').trim().split('\n').slice(-2).join(' | '));
if (p.stderr) console.log('[panel stderr]', p.stderr.trim().slice(-300));
try {
  const src = path.join(ROOT, 'reports', 'panel.html');
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ROOT, 'reports', 'dashboard.html'));
} catch (e) {}
