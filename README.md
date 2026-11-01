# 任务B · Nordstrom 私促监控（GitHub Actions 版）

每 4 小时自动：抓私促目录（120 件）→ 全量扫每件 PDP 的尺码库存 → 对比历史 → 达标 Bark 推送 → 生成面板发布到 GitHub Pages。电脑关机照跑。

## 一次性设置（2 步）

1. **加 Bark key**：仓库 Settings → Secrets and variables → Actions → New repository secret
   - Name: `BARK_KEY`，Value: 你的 Bark key
2. **开 Pages**：仓库 Settings → Pages → Source 选 `Deploy from a branch`，Branch 选 `gh-pages` / `(root)`（首次跑完出现 gh-pages 分支后再设）

面板地址：https://tahanialsalm37-netizen.github.io/nordstrom-taskb/

## 手动触发

Actions → taskb-monitor → Run workflow。首次建议手动跑一次验证。

## 结构

- `src/run.js` 一轮总控：目录抓取 → 全量库存扫描 → 门槛判定 → Bark
- `src/sweep.js` 全量 PDP 库存（写 stock_full + 快照，轮转 stock_cur/prev；被拦退出码 3）
- `src/panel.js` 生成面板（4h/3天变动榜 + 新加入折扣 + 库存总表，北京时间）
- `data/` 数据存档（每轮自动提交回仓库，快照只留最近 30 份）
- `reports/panel.html` 面板产物（发到 gh-pages）

## 库存口径

整件真实库存总量 ≤20 件显示真实数字；>20 一律按 100（充足）。
推送门槛（config/thresholds.json）：4h 内上新 ≥2 或动销 ≥2，未达标静默只更新面板。
