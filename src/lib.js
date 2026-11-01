// 公共工具：路径、配置、Bark 推送、浏览器启动（云端版，直连无需代理）
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');

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

function bark(title, body) {
  return new Promise((resolve) => {
    const key = (process.env.BARK_KEY || '').trim();
    if (!key) { console.log('[bark] 无 BARK_KEY，跳过'); return resolve(); }
    const t = thresholds();
    const payload = JSON.stringify({
      device_key: key,
      title: String(title).slice(0, 200),
      body: String(body || '').slice(0, 3800),
      group: t.group,
      sound: 'minuet',
      level: 'active',
    });
    const req = https.request({
      hostname: 'api.day.app', path: '/push', method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { console.log('[bark]', b.slice(0, 100)); resolve(); });
    });
    req.on('error', e => { console.log('[bark] 失败', e.message); resolve(); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload); req.end();
  });
}

// 云端直连：默认不走代理；如有需要可用 ND_PROXY 指定（比如 VPS 在香港需挂美国出口）
async function launch() {
  const { chromium } = require('playwright');
  const proxy = process.env.ND_PROXY || '';
  const args = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'];
  if (!proxy) args.push('--no-proxy-server');
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'profile'), {
    headless: true,
    proxy: proxy ? { server: proxy } : undefined,
    args,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
    window.chrome = window.chrome || { runtime: {} };
  });
  // 注入本地导出的 Akamai 信任 Cookie（ND_COOKIES = JSON 数组）
  const ck = (process.env.ND_COOKIES || '').trim();
  if (ck) {
    try { await ctx.addCookies(JSON.parse(ck)); console.log('[cookies] 注入', JSON.parse(ck).length, '条'); }
    catch (e) { console.log('[cookies] 解析失败', e.message); }
  }
  return ctx;
}

const BLOCK_RE = /unusual activity/i;

module.exports = { ROOT, DATA, CONFIG, readJson, writeJson, sleep, thresholds, bark, launch, BLOCK_RE };
