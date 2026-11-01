// 一轮完整流程：抓目录 → 抓一批库存 → 对比 → 门槛达标才推 Bark
// 用法: node src/run.js [--dry-run]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DATA, readJson, writeJson, thresholds, bark } = require('./lib');

const DRY = process.argv.includes('--dry-run');
const REPORT_ONLY = process.argv.includes('--report-only');

(async () => {
  const TH = thresholds();
  let blockedStock = false;

  if (!REPORT_ONLY) {
    const r1 = spawnSync(process.execPath, [path.join(__dirname, 'scrape.js')], { encoding: 'utf8' });
    console.log((r1.stdout || '').trim().split('\n').slice(-3).join('\n'));
    if (r1.stderr) console.log('[scrape stderr]', (r1.stderr || '').slice(-300));
  } else console.log('[report-only] 复用现有数据');

  const result = readJson(path.join(DATA, 'last_result.json'), {});
  if (result.blocked) {
    const body = '🚫 本轮被 Akamai 拦（unusual activity），未取到商品列表。基线未动，下轮重试。若连续多轮被拦，需要换 VPS 出口 IP。';
    if (!DRY) await bark('任务B·ND私促(被拦)', body);
    console.log(body);
    return;
  }
  if (result.count === 0) {
    const body = '⚠️ 本轮目录抓取为 0 件（页面异常），基线未受影响，下轮重试。';
    if (!DRY) await bark('任务B·ND私促(异常轮)', body);
    console.log(body);
    return;
  }

  if (!REPORT_ONLY) {
    const r2 = spawnSync(process.execPath, [path.join(__dirname, 'sweep.js')], { encoding: 'utf8' });
    blockedStock = /被拦/.test(r2.stdout || '');
    console.log((r2.stdout || '').trim().split('\n').slice(-2).join('\n'));
    if (r2.status === 3) { // 全量扫描中途被拦：按异常轮处理，基线未动
      const body = '🚫 库存扫描被 Akamai 拦，本轮库存数据不完整。目录数据正常，下轮重试。';
      if (!DRY) await bark('任务B·ND私促(库存被拦)', body);
      console.log(body);
    }
  }

  // 分类：新上架 / 补货
  const curItems = readJson(path.join(DATA, 'items_cur.json'), { items: [] }).items || [];
  const prevDoc = readJson(path.join(DATA, 'items_prev.json'), { items: [], ts: '' });
  const prevTs = prevDoc.ts || '';
  const hist = readJson(path.join(DATA, 'seen_history.json'), {});
  const knownBefore = new Set(Object.keys(hist));
  for (const it of curItems) if (!hist[it.id]) hist[it.id] = { brand: it.brand, name: it.name, firstSeen: result.ts };
  writeJson(path.join(DATA, 'seen_history.json'), hist);

  const newOnes = [], restocks = [];
  for (const it of (result.newItems || [])) {
    const h = hist[it.id] || {};
    const seenBefore = knownBefore.has(it.id) && h.firstSeen && prevTs && h.firstSeen <= prevTs;
    (seenBefore ? restocks : newOnes).push(it);
  }

  // 动销：本轮刷新商品的尺码库存净减少
  const curDoc = readJson(path.join(DATA, 'stock_cur.json'), { ts: '', stock: {} });
  const prevStock = readJson(path.join(DATA, 'stock_prev.json'), { stock: {} }).stock || {};
  const curStock = curDoc.stock || {};
  const runTs = curDoc.ts || '';
  let soldUnits = 0, refreshed = 0;
  const soldLines = [], restockedLines = [], lowStockNow = [];
  for (const [id, c] of Object.entries(curStock)) {
    if (runTs && c.ts !== runTs) continue;
    refreshed++;
    const label = `${c.brand} ${String(c.name).slice(0, 26)}`;
    for (const [sz, q] of Object.entries(c.sizes || {})) if (q === 1) lowStockNow.push(`${label} 码 ${sz} 仅剩1`);
    const p = prevStock[id];
    if (!p || !p.sizes) continue;
    for (const [sz, q] of Object.entries(c.sizes || {})) {
      const old = p.sizes[sz];
      if (old === undefined || old === q) continue;
      if (q < old) { soldUnits += old - q; soldLines.push(`${label} 码 ${sz}：${old}→${q}（卖出 ${old - q}）`); }
      if (old === 0 && q > 0) restockedLines.push(`${label} 码 ${sz}：0→${q}（回补）`);
    }
  }

  const newCount = newOnes.length, movement = soldUnits;
  const hitNew = newCount >= TH.newListings, hitMove = movement >= TH.movement;
  const hit = hitNew || hitMove;

  const evalDoc = {
    ts: result.ts, total: result.count, newCount, restockCount: restocks.length,
    movementCount: movement, refreshed, soldoutSizes: soldLines.length, restockSizes: restockedLines.length,
    dropCount: result.dropCount || 0, goneCount: result.goneCount || 0,
    thresholds: { newListings: TH.newListings, movement: TH.movement },
    hit, reasons: [hitNew ? `上新 ${newCount}` : null, hitMove ? `动销 ${movement}` : null].filter(Boolean),
  };
  writeJson(path.join(DATA, 'last_eval.json'), evalDoc);

  const group = (list) => {
    const m = {};
    for (const it of list) (m[it.brand] = m[it.brand] || []).push(it);
    return Object.entries(m).sort((a, b) => b[1].length - a[1].length);
  };

  const lines = [`全量 ${result.count} 件（页面 ${result.totalHint ?? '?'}）· 4h 上新 ${newCount} / 动销 ${movement}`];
  if (newOnes.length) {
    lines.push(`🆕 新上架 ${newOnes.length} 件：`);
    for (const [b, list] of group(newOnes)) {
      lines.push(`■ ${b}：${list.length} 件`);
      for (const it of list) lines.push(`   · ${it.name} — $${it.price}（-${it.discount}%）${it.lowStock ? '仅剩少量' : '有货'}`);
    }
  } else lines.push('新上架：无');
  if (restocks.length) {
    lines.push(`📦 补货 ${restocks.length} 件：`);
    for (const [b, list] of group(restocks)) {
      lines.push(`■ ${b}：${list.length} 件`);
      for (const it of list) lines.push(`   · ${it.name} — $${it.price}（-${it.discount}%）`);
    }
  }
  if (movement || restockedLines.length) {
    lines.push(`🔥 动销 ${movement} 件（本轮刷新 ${refreshed} 款）：`);
    for (const s of soldLines.slice(0, 12)) lines.push(`   · ${s}`);
    for (const s of restockedLines.slice(0, 6)) lines.push(`   · ${s}`);
  }
  if (lowStockNow.length) lines.push(`⚡ 仅剩 1 件 ${lowStockNow.length} 个码（首位：${lowStockNow[0]}）`);
  lines.push(`👟 库存：本轮刷新 ${refreshed} 款${blockedStock ? '（被拦未完成）' : ''}，累计 ${Object.keys(curStock).length} 款`);
  const body = lines.join('\n');

  if (!hit) {
    fs.writeFileSync(path.join(DATA, 'last_push.txt'), `[静默轮] 上新 ${newCount} / 动销 ${movement}\n` + body);
    console.log(`[静默轮] 上新 ${newCount}（≥${TH.newListings}）/ 动销 ${movement}（≥${TH.movement}），不推送`);
    return;
  }
  console.log(`\n=== 达标推送：${evalDoc.reasons.join(' + ')} ===\n${body}`);
  if (!DRY) await bark(`任务B·ND私促｜上新${newCount}/动销${movement}`, body + '\n\n看板：' + (process.env.DASH_URL || ''));
  fs.writeFileSync(path.join(DATA, 'last_push.txt'), `[推送] ${evalDoc.reasons.join(' + ')}\n` + body);
})();
