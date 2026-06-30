# minigame-rank-daily

每日抓取 [引力引擎](https://rank.gravity-engine.com/) 的小游戏榜单（微信小游戏 + 抖音小游戏，共 6 个榜的日榜），把数据 commit 进仓库，并通过 GitHub Pages 展示一个仪表盘，重点突出**每日新进游戏 / 新进发行商**。

- 抓取：GitHub Actions 每日北京时间 13:33 触发（榜单 10:00 更新，留 3.5h 让后端稳定）
- 存储：每天一份 JSON 进 `data/daily/`，diff 进 `data/diff/`，cumulative base 进 `data/base/`，趋势进 `data/history.jsonl`
- 展示：纯静态页（`site/`）通过 GitHub Pages 发布

```
仓库结构
.
├── scripts/
│   ├── scrape_rank.py   核心抓取/解析（与桌面端共用）
│   ├── ci_scrape.py     CI 抓取入口，写 daily/<日期>.json 等
│   ├── base.py          累积 base 库（历史所有游戏 / 发行商）
│   └── ci_diff.py       基于 base 分类今日新进
├── data/
│   ├── daily/           历史快照（每天一份）
│   ├── diff/            每天的「新进」分类
│   ├── base/            累积 base：games.json + publishers.json
│   ├── latest.json      最新快照（前端默认加载）
│   ├── history.jsonl    每日条数趋势
│   └── index.json       由 Pages workflow 生成的可用日期列表
├── site/                Pages 站点
│   ├── index.html
│   ├── style.css
│   └── app.js
├── .github/workflows/
│   ├── daily.yml        定时抓取 + 写数据
│   └── pages.yml        发布站点
└── README.md
```

## 「新进游戏」是怎么算出来的

这个项目维护一个**累积 base 库**（`data/base/games.json` + `publishers.json`），记录历史上所有抓到过的游戏 / 发行商，包括它们各自出现过的榜单和首次/末次出现的日期。

每天抓取后，把当日榜单和 base 对比，每条数据被分到三类：

| 类别 | 定义 |
| --- | --- |
| **全新** (first_anywhere) | 这个游戏在 base 里**任何榜**都没出现过 |
| **首次入此榜** (first_on_board) | 在其他榜出现过，但**这个榜**从未出现过 |
| **回归** (returning) | 这个榜以前出现过、消失过、又回来（gap ≥ 2 天） |

发行商的"新进"独立计算：**首次出现在这个榜的发行商**。

base 库可以从 `data/daily/*.json` 完整重建（`base.py:rebuild_from_daily()`），所以即使 base 文件丢失也能恢复。每天 `ci_diff.py` 会先用历史 daily 重建一次 base 来保证准确性。


---

## 一、第一次部署

### 1. 把这个项目推到你自己的 GitHub

```bash
cd minigame-rank-daily
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<你的用户名>/minigame-rank-daily.git
git push -u origin main
```

仓库设为 **Public**（公开），否则 Pages 免费额度会受限、Actions 配额也会减半。

### 2. 准备登录态（可选但推荐 —— 否则只能 Top 20）

引力引擎站点要登录才能看 Top 100。我们的做法：

1. 在本机用桌面版（`引力榜抓取.exe`）走一次「登录…」流程
2. 流程结束后会生成 `rank_auth.json`（exe 同目录）
3. 用编辑器打开它，把整个 JSON 文本**复制**
4. 到 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret
5. Name 填 `GRAVITY_AUTH`，Value 粘贴第 3 步的 JSON 内容，保存

> **登录态有效期**：通常几天到几周。失效后 Action 会回落到匿名模式（Top 20）。重新走一次桌面版登录 → 更新 Secret 即可。

### 3. 启用 GitHub Pages

仓库 → Settings → Pages：
- Source 选 **GitHub Actions**

第一次推送后，`pages.yml` 会自动构建并发布。访问：

```
https://<你的用户名>.github.io/minigame-rank-daily/
```

### 4. 第一次试跑

仓库 → Actions → 「Daily Rank Snapshot」 → Run workflow（手动触发一次，不用等 03:33）。

跑完后：
- `data/daily/<日期>.json` 会被 commit
- `data/latest.json` 同步更新
- 几分钟后 Pages 会重新部署，刷新页面就能看到数据

---

## 二、每天发生什么

```
03:33 北京时间 (= UTC 19:33 前一日)
  ├─ daily.yml 触发
  │   ├─ pip install playwright openpyxl
  │   ├─ playwright install chromium
  │   ├─ python scripts/ci_scrape.py
  │   │     输出 data/daily/YYYY-MM-DD.json
  │   │     更新 data/latest.json
  │   │     追加 data/history.jsonl
  │   ├─ python scripts/ci_diff.py
  │   │     输出 data/diff/YYYY-MM-DD.json
  │   └─ git commit & push (作者: github-actions[bot])
  │
  └─ data/ 变化触发 pages.yml
      └─ 站点重新构建并发布
```

---

## 三、本地开发

```bash
# 装依赖
pip install playwright openpyxl
python -m playwright install chromium

# 跑一次抓取（匿名 Top 20）
python scripts/ci_scrape.py

# 计算 diff（需要至少两天数据）
python scripts/ci_diff.py

# 起一个本地静态服务器看页面
python -m http.server 8000 --directory _pages_preview
```

要在本地预览 Pages，需要把 `site/*` 和 `data/` 拼成 `_pages_preview/`。最简单做法是仿造 `pages.yml` 里的脚本片段：

```bash
mkdir -p _pages_preview/data
cp -r site/* _pages_preview/
cp -r data/daily _pages_preview/data/ 2>/dev/null
cp -r data/diff _pages_preview/data/ 2>/dev/null
cp data/latest.json _pages_preview/data/ 2>/dev/null
cp data/history.jsonl _pages_preview/data/ 2>/dev/null
python -m http.server 8000 --directory _pages_preview
```

打开 http://localhost:8000

---

## 四、改抓取频率

编辑 `.github/workflows/daily.yml` 里的 `cron`：

```yaml
schedule:
  - cron: "33 5 * * *"   # 北京时间 13:33（默认）
```

cron 是 UTC，加 8 小时是北京时间。常用：
- 每天早上 9:07 北京 = `7 1 * * *`
- 每天下午 13:33 北京 = `33 5 * * *`（默认，引力引擎榜 10:00 更新后留 3.5h 缓冲）
- 每 6 小时 = `0 */6 * * *`

---

## 五、用量与成本

| 资源 | 免费额度 | 实际用量 | 余量 |
| --- | --- | --- | --- |
| Actions | 2000 分钟/月（公开仓库无限制） | ~3 分钟/天 ≈ 90 分钟/月 | 充裕 |
| Pages | 公开仓库免费 | 无限制 | — |
| 仓库大小 | 软上限 1 GB | 每天 ~50 KB JSON ≈ 18 MB/年 | 50 年用不完 |

---

## 六、常见问题

**Q：Actions 跑失败说找不到登录态？**
A：检查 Secret `GRAVITY_AUTH` 是否填了完整 JSON，注意复制时不要丢了首尾的 `{` `}`。失败也不阻塞 —— Action 会回落到匿名模式，只是 Top 数变少。

**Q：Pages 一直显示「尚无 latest.json」？**
A：等第一次 `daily.yml` 跑完。或者手动触发一次。

**Q：站点访问空白 / 中文乱码？**
A：刷新一下（CDN 可能没即时刷新）。如果持续，看浏览器 Console 错误信息。

**Q：能不能多平台抓 Apple Store / TapTap？**
A：当前版本只覆盖引力引擎站点的微信 + 抖音两端。扩展需要改 `scrape_rank.py` 里的选择器和 `BOARD_LABELS`。
