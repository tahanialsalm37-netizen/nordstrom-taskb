// 任务B · 面板生成器 v2：库存总表 + 4小时/3天库存变动榜 + 新加入折扣榜
// 数据源: items_cur.json + stock_full.json + data/snapshots/*.json（sweep_full.js 每轮落快照）
// 库存口径（用户 2026-10-31）：整件真实总量 ≤20 显示真数；>20 一律按 100（充足）
// 时间一律显示北京时间（UTC+8）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SNAP = path.join(DATA, 'snapshots');
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };

const LOW_MAX = 5;          // 码级 ≤5 视为「few left」码（红标）
const LOW_TOTAL = 20;       // 整件总量 ≤20 → 真数；>20 → 100
const PLENTY = 100;

const items = (readJson(path.join(DATA, 'items_cur.json'), { items: [] }).items) || [];
const full = (readJson(path.join(DATA, 'stock_full.json'), { stock: {} }).stock) || {};
const latestTs = (readJson(path.join(DATA, 'stock_full.json'), {}).ts) || new Date().toISOString();

// ---------- 快照管理 ----------
const snaps = [];
if (fs.existsSync(SNAP)) {
  for (const f of fs.readdirSync(SNAP).filter(f => f.endsWith('.json'))) {
    const d = readJson(path.join(SNAP, f), null);
    if (d && d.ts && d.stock) snaps.push({ ts: d.ts, stock: d.stock });
  }
}
snaps.sort((a, b) => new Date(a.ts) - new Date(b.ts));

// 选「目标时刻」的快照：最接近且不晚于 目标+45min；没有就用最早的（注明兜底）
function pickSnap(hoursAgo) {
  if (!snaps.length) return { snap: null, fallback: false };
  const target = new Date(latestTs).getTime() - hoursAgo * 3600e3;
  const cand = snaps.filter(s => new Date(s.ts).getTime() <= target + 45 * 60e3);
  if (cand.length) return { snap: cand[cand.length - 1], fallback: false };
  return { snap: snaps[0], fallback: true };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function bj(ts) { const d = new Date(new Date(ts).getTime() + 8 * 3600e3); return d.toISOString().replace('T', ' ').slice(0, 16); }
function totOf(e) { return e && e.sizes ? Object.values(e.sizes).reduce((a, q) => a + (q > 0 ? q : 0), 0) : null; }

// ---------- 变动榜 ----------
function deltaBoard(hoursAgo) {
  const { snap, fallback } = pickSnap(hoursAgo);
  if (!snap) return { html: `<div class="empty">暂无历史快照，等下一轮扫描后自动出现。</div>`, note: '' };
  const note = fallback
    ? `（暂无 ${hoursAgo >= 72 ? '3 天' : hoursAgo + ' 小时'}前的快照，先用最早快照 ${bj(snap.ts)} 兜底，数据积累中）`
    : `对比快照 ${bj(snap.ts)}`;
  const rows = [];
  for (const it of items) {
    const cur = full[it.id], prev = snap.stock[it.id];
    if (!cur || !cur.sizes) continue;
    const curT = totOf(cur);
    if (!prev) { rows.push({ it, curT, kind: 'new' }); continue; }
    const prevT = totOf(prev);
    if (prevT == null) continue;
    const soldout = [], restock = [];
    for (const [sz, q] of Object.entries(cur.sizes)) {
      const o = prev.sizes ? prev.sizes[sz] : undefined;
      if (o === undefined) continue;
      if (o > 0 && q === 0) soldout.push(sz);
      if (o === 0 && q > 0) restock.push(sz);
    }
    const chg = curT - prevT;
    if (chg === 0 && !soldout.length && !restock.length) continue;
    rows.push({ it, curT, kind: chg < 0 ? 'down' : 'up', chg, soldout, restock });
  }
  rows.sort((a, b) => (a.kind === 'down' ? 0 : a.kind === 'up' ? 1 : 2) - (b.kind === 'down' ? 0 : b.kind === 'up' ? 1 : 2)
    || (a.chg || 0) - (b.chg || 0));
  if (!rows.length) return { html: `<div class="empty">该时段无变动。</div>`, note };
  const html = rows.map(r => {
    const left = r.kind === 'new' ? '新入榜' : `${r.curT} 件`;
    const mid = r.kind === 'down' ? `<b class="neg">↓${-r.chg}</b>`
      : r.kind === 'up' ? `<b class="pos">↑${r.chg}</b>` : `<b class="pos">新</b>`;
    const extra = [
      r.soldout && r.soldout.length ? `售罄码 ${r.soldout.map(esc).join('/')}` : '',
      r.restock && r.restock.length ? `回补 ${r.restock.map(esc).join('/')}` : '',
    ].filter(Boolean).join(' · ');
    return `<tr><td class="chg">${mid}</td><td><a href="${esc(r.it.url)}" target="_blank" rel="noopener"><b>${esc(r.it.brand)}</b> ${esc(r.it.name)}</a></td><td class="num">${left}</td><td class="dim">${extra || '—'}</td></tr>`;
  }).join('\n');
  return { html: `<table class="mini">${html}</table>`, note };
}

// ---------- 新加入折扣 ----------
function newMarkdownBoard() {
  const prevItems = readJson(path.join(DATA, 'items_prev.json'), { items: [] }).items || [];
  const prevIds = new Set(prevItems.map(x => x.id));
  const fresh = items.filter(x => x.newMarkdown || !prevIds.has(x.id));
  if (!fresh.length) return `<div class="empty">暂无新加入折扣的商品。</div>`;
  return `<table class="mini">` + fresh.map(x =>
    `<tr><td><a href="${esc(x.url)}" target="_blank" rel="noopener"><b>${esc(x.brand)}</b> ${esc(x.name)}</a></td><td class="num">$${x.price}${x.prevPrice ? ` <s>$${x.prevPrice}</s>` : ''}</td><td>${x.discount ? `<b class="disc">${x.discount}% off</b>` : ''}</td></tr>`
  ).join('\n') + `</table>`;
}

// ---------- 当前库存总表 ----------
function stockTable() {
  const rows = [];
  for (const it of items) {
    const st = full[it.id];
    const sizes = st && st.sizes ? st.sizes : null;
    let display, kind, total = 0;
    if (sizes) {
      const entries = Object.entries(sizes);
      total = entries.reduce((a, [, q]) => a + (q > 0 ? q : 0), 0);
      if (total === 0) { kind = 'out'; display = 0; }
      else if (total <= LOW_TOTAL) { kind = 'low'; display = total; }
      else { kind = 'plenty'; display = PLENTY; }
    } else { kind = 'none'; display = null; }
    rows.push({ it, st, display, kind });
  }
  rows.sort((a, b) => {
    const w = k => (k === 'out' ? 0 : k === 'low' ? 1 : k === 'plenty' ? 2 : 3);
    return w(a.kind) - w(b.kind) || (a.display || 999) - (b.display || 999);
  });
  const nLow = rows.filter(r => r.kind === 'low').length;
  const nOut = rows.filter(r => r.kind === 'out').length;
  const nPlenty = rows.filter(r => r.kind === 'plenty').length;
  const body = rows.map(r => {
    const it = r.it;
    const orig = it.prevPrice != null && it.prevPrice > it.price ? `<s>$${it.prevPrice}</s>` : '';
    const disc = it.discount != null ? `<b class="disc">${it.discount}% off</b>` : '';
    const img = it.img ? `<img src="${esc(it.img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
    const badge = r.kind === 'out' ? `<span class="badge out">售罄</span>`
      : r.kind === 'low' ? `<span class="badge low">仅 ${r.display} 件</span>`
      : r.kind === 'plenty' ? `<span class="badge plenty">${PLENTY}（充足）</span>`
      : `<span class="badge none">未建档</span>`;
    const chips = r.st && r.st.sizes
      ? Object.entries(r.st.sizes).map(([s, q]) => {
          const cls = q === 0 ? 'out' : (q <= LOW_MAX ? 'low' : 'ok');
          return `<span class="chip ${cls}">${esc(s)}${q > 0 && q <= LOW_MAX ? '·' + q : ''}</span>`;
        }).join('')
      : '<span class="dim">—</span>';
    return `<tr class="${r.kind}">
      <td class="img">${img}</td>
      <td><a href="${esc(it.url)}" target="_blank" rel="noopener"><b>${esc(it.brand)}</b><br>${esc(it.name)}</a></td>
      <td class="price">${it.price != null ? '$' + it.price : ''} ${orig}<br>${disc}</td>
      <td class="stock">${badge}<div class="chips">${chips}</div></td>
    </tr>`;
  }).join('\n');
  const stats = `
<div class="stats">
  <div class="stat low"><b>${nLow}</b>低库存（≤${LOW_TOTAL}件）</div>
  <div class="stat plenty"><b>${nPlenty}</b>库存充足</div>
  <div class="stat none"><b>${nOut}</b>售罄</div>
</div>
<div class="filters">
  <button class="on" data-f="all">全部</button>
  <button data-f="low">低库存</button>
  <button data-f="out">售罄</button>
  <button data-f="plenty">充足</button>
</div>`;
  return { stats, body };
}

const b4 = deltaBoard(4);
const b72 = deltaBoard(72);
const st = stockTable();

const html = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>任务B · Nordstrom 私促库存面板</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background:#111418; color:#e8eaed; margin:0; padding:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  h2 { font-size:15px; margin:28px 0 8px; padding-bottom:6px; border-bottom:1px solid #2b323b; }
  .meta { color:#9aa0a6; font-size:12px; margin-bottom:14px; }
  .note { color:#9aa0a6; font-size:12px; font-weight:400; margin-left:8px; }
  .empty { color:#9aa0a6; background:#1b2027; border-radius:8px; padding:10px 14px; font-size:13px; }
  .stats { display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
  .stat { background:#1b2027; border-radius:10px; padding:8px 14px; font-size:13px; }
  .stat b { font-size:18px; display:block; }
  .low b { color:#ff7a70; } .plenty b { color:#6fbf73; } .none b { color:#fdd663; }
  .filters { margin-bottom:10px; }
  .filters button { background:#1b2027; color:#e8eaed; border:1px solid #2b323b; border-radius:16px; padding:5px 14px; margin-right:6px; cursor:pointer; font-size:13px; }
  .filters button.on { background:#2f6fed; border-color:#2f6fed; }
  table { border-collapse:collapse; width:100%; }
  tr { border-bottom:1px solid #21262d; }
  tr.low { background:rgba(255,90,70,.07); }
  td { padding:8px 10px; vertical-align:top; }
  td.img img { width:64px; border-radius:6px; display:block; }
  a { color:#e8eaed; text-decoration:none; } a:hover { color:#8ab4f8; }
  .price s { color:#9aa0a6; font-size:12px; margin-left:4px; }
  .disc { color:#ff7a70; font-size:12px; }
  .num { white-space:nowrap; color:#bdc1c6; }
  .chg { width:64px; white-space:nowrap; }
  .neg { color:#ff7a70; } .pos { color:#6fbf73; }
  .dim { color:#9aa0a6; font-size:12px; }
  .badge { display:inline-block; border-radius:6px; padding:2px 8px; font-size:12px; font-weight:600; }
  .badge.low { background:#3a1712; color:#ff7a70; }
  .badge.plenty { background:#12261a; color:#6fbf73; }
  .badge.out { background:#2d2d2d; color:#9aa0a6; }
  .badge.none { background:#23272d; color:#9aa0a6; }
  .chips { margin-top:6px; display:flex; flex-wrap:wrap; gap:4px; max-width:420px; }
  .chip { font-size:11px; border-radius:4px; padding:1px 6px; background:#23272d; color:#bdc1c6; }
  .chip.low { background:#3a1712; color:#ff7a70; font-weight:700; }
  .chip.ok { background:#12261a; color:#6fbf73; }
  .chip.out { background:#17191c; color:#5f6368; text-decoration:line-through; }
  table.mini td { padding:6px 10px; }
  @media (max-width:640px){ td.price{display:none} }
</style></head><body>
<h1>任务B · Nordstrom 私促库存面板</h1>
<div class="meta">北京时间 ${esc(bj(latestTs))} · 共 ${items.length} 件 · 口径：整件真实库存 ≤20 件显示真数，>20 一律按 100 计</div>

<h2>⏱ 4 小时库存变动榜 <span class="note">${esc(b4.note)}</span></h2>
${b4.html}

<h2>📅 3 天库存变动榜 <span class="note">${esc(b72.note)}</span></h2>
${b72.html}

<h2>🆕 新加入折扣</h2>
${newMarkdownBoard()}

<h2>📦 当前库存总表</h2>
${st.stats}
<table>
${st.body}
</table>
<script>
document.querySelectorAll('.filters button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.filters button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  const f = b.dataset.f;
  document.querySelectorAll('table:not(.mini) tr').forEach(tr => {
    const c = tr.className;
    if (/^(low|plenty|out|none)$/.test(c)) tr.style.display = (f === 'all' || c === f) ? '' : 'none';
  });
});
</script>
</body></html>`;

const OUT = path.join(ROOT, 'reports');
fs.mkdirSync(OUT, { recursive: true });
const outPath = path.join(OUT, 'panel.html');
fs.writeFileSync(outPath, html);
console.log(`面板已生成：${outPath} · 快照 ${snaps.length} 份`);
