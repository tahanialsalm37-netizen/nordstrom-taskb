// 云端全量库存扫描：一次扫完全部商品 → stock_full.json + 快照存档 + 轮转 stock_cur/stock_prev
// 用法: node src/sweep.js [--skip-existing]（默认强制全刷，供变动对比）
const fs = require('fs');
const path = require('path');
const { ROOT, DATA, readJson, sleep, launch, saveCookies, BLOCK_RE } = require('./lib');

function extractInPage() {
  const cfg = window.__INITIAL_CONFIG__;
  if (!cfg) return { err: 'no-config' };
  const pid = location.pathname.split('/').pop();
  const ent = cfg.productDisplay && cfg.productDisplay.productDisplaysById && cfg.productDisplay.productDisplaysById.entities;
  let coreProds = null;
  if (ent && ent[pid] && ent[pid].coreProducts) coreProds = ent[pid].coreProducts;
  else if (ent) {
    const k = Object.keys(ent).find(k => ent[k] && ent[k].coreProducts);
    if (k) coreProds = ent[k].coreProducts;
  }
  if (!coreProds || !coreProds.length) return { err: 'no-coreProducts' };
  const items = [];
  let name = '', brand = '';
  for (const cp of coreProds) {
    if (!name) name = (cp.name || '');
    if (!brand) brand = (cp.brandName || (cp.brand && cp.brand.name) || '');
    for (const cc of (cp.coreChoices || [])) for (const it of (cc.items || [])) items.push(it);
  }
  const seen = new Set(), sizes = {};
  for (const it of items) {
    if (!it || seen.has(it.npin)) continue;
    seen.add(it.npin);
    const sz = (it.sizeDimension1 && (it.sizeDimension1.label || it.sizeDimension1.code)) || it.concatenatedDisplaySize || '';
    const prop = it.sku && it.sku.propositions && it.sku.propositions[0];
    const av = (prop && prop.availability) || {};
    const qty = Number.isFinite(av.shipQuantity) ? av.shipQuantity : (av.isShipAvailable || av.isAvailable ? -1 : 0);
    if (sz) sizes[sz] = qty;
  }
  return { ok: true, sizes, name, brand };
}

(async () => {
  const cat = readJson(path.join(DATA, 'items_cur.json'), { items: [] });
  const items = cat.items || [];
  if (!items.length) { console.log('目录为空，先跑 scrape'); process.exit(0); }

  const fullDoc = readJson(path.join(DATA, 'stock_full.json'), { stock: {} });
  const full = fullDoc.stock || {};

  const ctx = await launch();
  const page = await ctx.newPage();
  let blocked = false, done = 0, empty = 0;
  const tsRun = new Date().toISOString();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (full[it.id] && process.argv.includes('--skip-existing')) continue;
    try {
      const resp = await page.goto(it.url, { timeout: 45000, waitUntil: 'domcontentloaded' });
      if (!resp || resp.status() !== 200) { console.log(`[${i}] ${it.id} HTTP ${resp && resp.status()}`); continue; }
      const ready = await page.waitForFunction(() => {
        const c = window.__INITIAL_CONFIG__;
        const e = c && c.productDisplay && c.productDisplay.productDisplaysById && c.productDisplay.productDisplaysById.entities;
        return !!(e && Object.values(e).some(x => x && x.coreProducts));
      }, { timeout: 15000 }).then(() => true).catch(() => false);
      if (!ready) {
        const body = await page.evaluate(() => document.body.innerText.slice(0, 200));
        if (BLOCK_RE.test(body)) { console.log(`被拦于 [${i}] ${it.id}，中止`); blocked = true; break; }
        console.log(`[${i}] ${it.id} 无商品数据`); empty++; continue;
      }
      const r = await page.evaluate(extractInPage);
      if (!r || !r.ok) { console.log(`[${i}] ${it.id} 解析失败 ${r && r.err}`); empty++; continue; }
      full[it.id] = { ts: tsRun, sizes: r.sizes, name: r.name || it.name, brand: r.brand || it.brand };
      done++;
      if (done % 20 === 0) { fs.writeFileSync(path.join(DATA, 'stock_full.json'), JSON.stringify({ ts: tsRun, stock: full }, null, 1)); await saveCookies(ctx); }
      await sleep(1200 + Math.floor(Math.random() * 1200));
    } catch (e) {
      console.log(`[${i}] ${it.id} 失败: ${String(e.message).slice(0, 80)}`);
    }
  }
  await saveCookies(ctx);
  await ctx.close();

  if (done > 0) {
    // 轮转：旧 stock_full → stock_prev / stock_cur（供 run.js 算尺码级动销）
    if (Object.keys(fullDoc.stock || {}).length) {
      fs.writeFileSync(path.join(DATA, 'stock_prev.json'), JSON.stringify({ ts: fullDoc.ts || '', stock: fullDoc.stock }, null, 1));
    }
    fs.writeFileSync(path.join(DATA, 'stock_cur.json'), JSON.stringify({ ts: tsRun, stock: full }, null, 1));
    fs.writeFileSync(path.join(DATA, 'stock_full.json'), JSON.stringify({ ts: tsRun, stock: full }, null, 1));
    const SNAP = path.join(DATA, 'snapshots');
    fs.mkdirSync(SNAP, { recursive: true });
    fs.writeFileSync(path.join(SNAP, `stock_${tsRun.replace(/[-:T]/g, '').slice(0, 12)}.json`), JSON.stringify({ ts: tsRun, stock: full }, null, 1));
    // 快照只留最近 30 份，防仓库膨胀
    const snaps = fs.readdirSync(SNAP).filter(f => f.endsWith('.json')).sort();
    for (const f of snaps.slice(0, -30)) fs.unlinkSync(path.join(SNAP, f));
  }
  console.log(`全量扫描完成：${done}/${items.length}（空 ${empty}）${blocked ? ' · 中途被拦' : ''} · 档案 ${Object.keys(full).length} 件`);
  if (blocked) process.exit(3);
})();
