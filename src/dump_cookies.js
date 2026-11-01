// 从运行完的浏览器档案导出最新 Cookie（供回写 ND_COOKIES Secret，实现自续期）
const fs = require('fs');
const path = require('path');
const { ROOT, launch } = require('./lib');

(async () => {
  const ctx = await launch();
  const cookies = await ctx.cookies('https://www.nordstrom.com');
  await ctx.close();
  const out = path.join(ROOT, 'data', 'cookies.json');
  fs.writeFileSync(out, JSON.stringify(cookies, null, 1));
  console.log(`导出 ${cookies.length} 条 cookie -> ${out}`);
})();
