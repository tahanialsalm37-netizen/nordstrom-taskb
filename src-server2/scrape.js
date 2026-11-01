// 目录抓取：designer-private-sale 全量翻页，等网格水合，识别 Akamai 拦截
const fs = require('fs');
const path = require('path');
const { DATA, readJson, writeJson, sleep, launch, saveCookies, clashSwitch, BLOCK_RE } = require('./lib');

const BASE = 'https://www.nordstrom.com/browse/designer-private-sale';

async function waitForGrid(page, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const n = await page.evaluate(() => document.querySelectorAll('a[href*="/s/"]').length);
    if (n > 0) return n;
    await page.waitForTimeout(1500);
  }
  return 0;
}

async function scrollAndClickMore(page) {
  let prev = 0, stable = 0, rounds = 0;
  while (stable < 3 && rounds < 50) {
    rounds++;
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
        const t = (el.innerText || '').trim().toLowerCase();
        return /^(load more|show more|view more|more)$/.test(t) && el.offsetParent !== null;
      });
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.evaluate(() => window.scrollBy(0, 4000));
    await page.waitForTimeout(clicked ? 2500 : 1500);
    const n = await page.evaluate(() => new Set(Array.from(document.querySelectorAll('a[href*="/s/"]')).map(a => a.href.split('?')[0])).size);
    if (n > 0 && n === prev && !clicked) stable++; else stable = 0;
    prev = n;
  }
  return prev;
}

function parseItems(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/s/"]')) {
      const href = a.href.split('?')[0];
      if (seen.has(href)) continue;
      seen.add(href);
      const card = a.closest('article') || a.closest('div');
      if (!card) continue;
      const text = card.innerText || '';
      const h3 = card.querySelector('h3');
      const h3a = h3 ? h3.querySelector('a') : null;
      let brand = '', name = '';
      if (h3 && h3a) {
        const strong = h3a.querySelector('strong');
        brand = strong ? strong.innerText.trim() : '';
        let full = h3a.innerText.replace(/\s+/g, ' ').trim();
        if (brand && full.startsWith(brand)) full = full.slice(brand.length).trim();
        name = full;
      }
      const priceNodes = Array.from(card.querySelectorAll('span[class*="dls-ihm460"]'))
        .map(el => parseFloat(String(el.innerText).replace(/[$,]/g, '')))
        .filter(v => !isNaN(v));
      let cur, prevP;
      if (priceNodes.length >= 2) { cur = priceNodes[0]; prevP = priceNodes[priceNodes.length - 1]; }
      else {
        const prices = (text.match(/\$[\d,]+(?:\.\d+)?/g) || []).map(s => parseFloat(s.replace(/[$,]/g, '')));
        if (prices.length < 2) continue;
        cur = prices[0]; prevP = prices[prices.length - 1];
      }
      if (!name) {
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        brand = brand || (lines[0] || '');
        name = lines[0] || '';
      }
      let img = '';
      const im = card.querySelector('img');
      if (im) {
        const ss = (im.getAttribute('srcset') || '').split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
        img = ss.length ? ss[ss.length - 1] : (im.getAttribute('src') || '');
        if (img.startsWith('//')) img = 'https:' + img;
      }
      out.push({
        id: href.split('/').pop(), url: href, img, brand, name,
        price: cur, prevPrice: prevP,
        discount: prevP > 0 ? +((1 - cur / prevP) * 100).toFixed(1) : 0,
        newMarkdown: /new markdown/i.test(text),
        lowStock: /only a few left|low stock|almost gone/i.test(text),
      });
    }
    return out;
  });
}

(async () => {
  const t0 = Date.now();
  let all, totalHint = null, outcome = 'ok';

  // 最多 3 次：失败（连不上/被拦）就换 mihomo 出口节点重试
  for (let attempt = 1; attempt <= 3; attempt++) {
    all = new Map(); totalHint = null; outcome = 'ok';
    const ctx = await launch();
    const page = await ctx.newPage();
    let pageNo = 1;

    while (pageNo <= 10) {
      const url = pageNo === 1 ? BASE : `${BASE}?page=${pageNo}`;
      try {
        const resp = await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
        if (!resp || resp.status() !== 200) { console.log(`第${pageNo}页 HTTP ${resp && resp.status()}，停止`); if (pageNo === 1) outcome = 'conn'; break; }
      } catch (e) {
        console.log(`第${pageNo}页打开失败: ${String(e.message).slice(0, 90)}`);
        if (pageNo === 1) { outcome = 'conn'; break; }
        break;
      }

      const gridN = await waitForGrid(page, pageNo === 1 ? 50000 : 20000);
      if (pageNo === 1) console.log(`网格水合：${gridN} 个商品链接`);

      const blocked = await page.evaluate(() => /unusual activity/i.test(document.body.innerText));
      if (blocked) {
        console.log('⚠️ 被 Akamai 拦（unusual activity）');
        outcome = 'blocked';
        break;
      }

      if (pageNo === 1) {
        const m = await page.evaluate(() => {
          const mm = document.body.innerText.match(/([\d,]+)\s*(items|results|products)/i);
          return mm ? +mm[1].replace(/,/g, '') : null;
        });
        totalHint = m;
      }
      await page.waitForTimeout(2500);
      await scrollAndClickMore(page);
      const items = await parseItems(page);
      let fresh = 0;
      for (const it of items) { if (!all.has(it.id)) { all.set(it.id, it); fresh++; } }
      console.log(`第${pageNo}页：解析 ${items.length} 卡片，新增 ${fresh}（累计 ${all.size}）`);
      if (fresh === 0) break;
      const hasNext = await page.evaluate((n) => !!Array.from(document.querySelectorAll('a')).find(a => {
        const t = (a.innerText || '').trim();
        return t === String(n + 1) || a.href.includes(`page=${n + 1}`);
      }), pageNo);
      if (!hasNext) break;
      pageNo++;
    }
    await saveCookies(ctx);
    await ctx.close();

    if (all.size > 0 || attempt === 3) break;
    console.log(`[retry] 第${attempt}次未取到目录（${outcome}），换节点重试`);
    await clashSwitch();
    await sleep(4000);
  }

  const items = Array.from(all.values());
  const ts = new Date().toISOString();
  const missed = totalHint ? totalHint - items.length : null;
  const P = (n) => path.join(DATA, n);

  const prevCurCount = (readJson(P('items_cur.json'), { items: [] }).items || []).length;

  // 防污染：连不上 / 被拦 / 低产量 → 绝不覆盖好目录，只写 last_result
  if (items.length < 20 && prevCurCount >= 20) {
    console.log(`[guard] 本轮仅 ${items.length} 件（${outcome}），保留原目录 ${prevCurCount} 件不覆盖，下轮再试`);
    writeJson(P('last_result.json'), {
      ts, durationSec: Math.round((Date.now() - t0) / 1000), totalHint, count: items.length,
      outcome, guard: 'low-yield', note: '保留上一轮目录未覆盖',
      newCount: 0, dropCount: 0, lowStockCount: 0, goneCount: 0, newItems: [], drops: [], lowStockNew: [],
    });
    process.exit(0);
  }

  // 两槽轮换：prev(上一轮) ← cur，再写本轮（对比 4 小时前）
  if (prevCurCount >= 20) fs.copyFileSync(P('items_cur.json'), P('items_prev.json'));
  else console.log(`上一轮仅 ${prevCurCount} 件，跳过轮换，保留 prev`);

  const prevDoc = readJson(P('items_prev.json'), { items: [], ts: '' });
  const prevMap = new Map((prevDoc.items || []).map(x => [x.id, x]));
  const newItems = [], drops = [], lowStockNew = [], gone = [];
  for (const it of items) {
    const old = prevMap.get(it.id);
    if (!old) { if ((prevDoc.items || []).length) newItems.push(it); }
    else {
      if (it.price < old.price) drops.push({ ...it, from: old.price });
      if (it.lowStock && !old.lowStock) lowStockNew.push(it);
      prevMap.delete(it.id);
    }
  }
  for (const [id] of prevMap) gone.push(id);

  writeJson(P('items_cur.json'), { ts, totalHint, count: items.length, items });
  writeJson(P('last_result.json'), {
    ts, durationSec: Math.round((Date.now() - t0) / 1000), pages: 10,
    totalHint, count: items.length, missed, outcome,
    newCount: newItems.length, dropCount: drops.length, lowStockCount: lowStockNew.length, goneCount: gone.length,
    newItems: newItems.slice(0, 30), drops: drops.slice(0, 20), lowStockNew: lowStockNew.slice(0, 20),
  });
  console.log(`完成：${items.length} 件 / 页面标注 ${totalHint ?? '?'} / 新上架 ${newItems.length} / 降价 ${drops.length} / 下架 ${gone.length}`);
})();
