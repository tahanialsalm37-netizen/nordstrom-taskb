// 公共工具（on-monitor 服务器版）：路径、配置、Bark 推送、浏览器启动、Cookie 持久化
// 部署位置：on-monitor/nd/scripts_v2/，ROOT = nd/
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');
const COOKIE_FILE = path.join(DATA, 'nd_cookies.json');

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function thresholds() {
  const t = readJson(path.join(CONFIG, 'thresholds.json'), {});
  return {
    newListings: Number.isFinite(t.newListings) ? t.newListings : 2,
    movement: Number.isFinite(t.movement) ? t.movement : 2,
    group: t.group || '任务B',
    bark: (t.channels || {}).bark !== false,
  };
}

// Bark：优先 notify.js（服务器自带 key 管理），兜底 BARK_KEY 环境变量
function bark(title, body) {
  const TH = thresholds();
  if (!TH.bark) return Promise.resolve();
  try {
    const notify = require(path.join(ROOT, '..', 'notify.js'));
    return notify.bark(title, body, { group: TH.group });
  } catch (e) { /* fallthrough */ }
  return new Promise((resolve) => {
    const key = (process.env.BARK_KEY || '').trim();
    if (!key) { console.log('[bark] 无通道，跳过'); return resolve(); }
    const payload = JSON.stringify({
      device_key: key, title: String(title).slice(0, 200), body: String(body || '').slice(0, 3800),
      group: TH.group, sound: 'minuet', level: 'active',
    });
    const req = https.request({
      hostname: 'api.day.app', path: '/push', method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); res.on('end', () => resolve()); });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload); req.end();
  });
}

// 浏览器启动：走容器内 mihomo（127.0.0.1:7897），注入持久 Cookie（nd/data/nd_cookies.json）
async function launch() {
  const { chromium } = require('playwright');
  const proxy = process.env.ND_PROXY || 'http://127.0.0.1:7897';
  // 服务器默认 xvfb 有头（ND_HEADLESS=0）；设 1 强制无头
  const headless = process.env.ND_HEADLESS === '1';
  // 复用旧管线攒下信任的档案（nd/.pw-profile）；Cookie 另有 nd_cookies.json 注入层做自续期
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.pw-profile'), {
    headless,
    proxy: { server: proxy },
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });
  const doc = readJson(COOKIE_FILE, null);
  if (doc && Array.isArray(doc.cookies) && doc.cookies.length) {
    try {
      const now = Date.now() / 1000;
      // 原样注入（ctx.cookies() 导出的格式本就兼容 addCookies；url+domain 同时给会报错）
      const cks = doc.cookies.filter(c => !c.expires || c.expires > now);
      await ctx.addCookies(cks);
      console.log('[cookies] 注入', cks.length, '条（存档', new Date(doc.ts).toISOString().slice(0, 16), '）');
    } catch (e) { console.log('[cookies] 注入失败', e.message); }
  } else {
    console.log('[cookies] 无存档，全新访客');
  }
  return ctx;
}

// 跑完一轮后保存新鲜 Cookie（供下轮注入，自续期）
async function saveCookies(ctx) {
  try {
    const cks = await ctx.cookies('https://www.nordstrom.com');
    if (cks && cks.length) {
      writeJson(COOKIE_FILE, { ts: new Date().toISOString(), cookies: cks });
      console.log('[cookies] 已存档', cks.length, '条');
    }
  } catch (e) { console.log('[cookies] 存档失败', e.message); }
}

const BLOCK_RE = /unusual activity/i;

// ---- mihomo 出口切换（容器内 API）----
const CLASH_API = 'http://127.0.0.1:19090';
const CLASH_SECRET = 'nd-clash-9k2m';

async function clashNow() {
  try {
    const g = await (await fetch(CLASH_API + '/proxies/POOL', { headers: { Authorization: 'Bearer ' + CLASH_SECRET }, signal: AbortSignal.timeout(5000) })).json();
    return g.now || null;
  } catch (e) { return null; }
}

// 在 POOL 里切到下一个可用节点（优先美国节点循环）
async function clashSwitch() {
  try {
    const g = await (await fetch(CLASH_API + '/proxies/POOL', { headers: { Authorization: 'Bearer ' + CLASH_SECRET }, signal: AbortSignal.timeout(5000) })).json();
    const list = g.all || [];
    const us = list.filter(n => /美国/.test(n));
    const pool = us.length ? us : list;
    const i = pool.indexOf(g.now);
    const next = pool[(i + 1) % pool.length];
    if (next && next !== g.now) {
      await fetch(CLASH_API + '/proxies/POOL', { method: 'PUT', headers: { Authorization: 'Bearer ' + CLASH_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: next }), signal: AbortSignal.timeout(5000) });
      console.log('[clash] 出口切换', g.now, '->', next);
    }
    return next;
  } catch (e) { console.log('[clash] 切换失败', e.message); return null; }
}

module.exports = { ROOT, DATA, CONFIG, COOKIE_FILE, readJson, writeJson, sleep, thresholds, bark, launch, saveCookies, BLOCK_RE, clashNow, clashSwitch };
