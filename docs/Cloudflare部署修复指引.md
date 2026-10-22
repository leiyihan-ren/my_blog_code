# Cloudflare 部署修复指引

> **现状诊断**（2026-10-22）：代码仓库与 CI 全部正常（GitHub Actions 8/8 套件 467/467 全绿，
> 最新提交 `22faff3`），但 `leiyihan.dpdns.org` 与 `leiyihan.pages.dev` 仍服役最初旧版——
> Cloudflare Pages 的 **Git 自动构建失败**（部署列表显示「暂无可用部署」= 构建未产出可部署产物）。

仓库侧已做的两项修复（随 `1d6aba1` / `bd0693b` 推送）：
1. `package.json` 增加 `config.playwright_skip_browser_download = "1"`——
   部署平台执行 `npm ci` 时不再下载测试浏览器（原失败疑凶之一）；
2. 增加无操作 `build` 脚本——防止构建命令被设为 `npm run build` 时报 Missing script。

## 方案 A：直接上传部署（最快，推荐）

无需排查 Git 构建，5 分钟上线：

1. 登录 https://dash.cloudflare.com → **Workers & Pages** → 找到 `leiyihan` 项目；
2. 点 **Create deployment**（或 Deployment → Upload）；
3. 上传 `my-blog-v3.0-refactored.zip` **解压后的整个文件夹**（直接拖文件夹或解压后的全部文件，
   不要上传 zip 本身——CF 要求未压缩的目录）；
4. **关键步骤**：部署完成后进入项目 → **Settings → Functions → KV namespace bindings**，
   确认存在绑定：Variable name = `SITE_DATA`，选择你的 KV 命名空间
   （首次部署若未绑定，文章/留言/音乐/相册全部为空——这是旧版就有的配置，新部署不会丢）；
5. （可选）Settings → Functions → Environment variables 添加 `GITHUB_TOKEN`
   （值用你在 GitHub 建的 PAT），GitHub 内容拉取配额从 60 次/小时提升到 5000 次/小时；
6. 重新触发一次部署使绑定生效。

## 方案 B：修复 Git 自动部署

进入 `leiyihan` 项目 → **Settings → Build & deploy → Build configurations**：

| 配置项 | 应设为 |
|---|---|
| Framework preset | `None` |
| Build command | **留空**（本站是纯静态站点，无构建步骤） |
| Build output directory | **`/`**（站点文件就在仓库根目录） |
| Root directory | 留空 |

保存后点 **Deployments → Retry deployment** 重试失败的那次部署；
或推一个空提交触发新构建：

```bash
git commit --allow-empty -m "chore: 触发 Pages 重新构建" && git push
```

## 验证部署成功

```bash
curl -s -o /dev/null -w "%{content_type}\n" https://leiyihan.dpdns.org/js/utils.js
# 期望：application/javascript（旧版会返回 text/html）
```

其他特征：首页标题不再是「加载中...」、`/og-image.png` 返回真实 PNG、
页面底部出现带头像光环的 Hero 与滚动进度条。

## 备查：本地复现构建

```bash
npm ci                       # 因 package.json config，不会下载浏览器
npx playwright install chromium   # 仅本地/CI 测试需要
npm test                     # 467 断言全绿
```
