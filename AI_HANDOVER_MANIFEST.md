# AI_HANDOVER_MANIFEST —— 数字生命交接档案

> 给新环境的 AI：读完本文即可无缝接管本项目。本文由执行 AI 在交付前生成，
> 记录架构拓扑、历史排雷档案、开发避坑指南与零报错启动流程。
> 生成时间：2026-10-25 · 当前版本基线：v7.3（含 v8.0 网盘商业级强化阶段性改动）

---

## 1. 核心架构图（拓扑关系）

```
浏览器（10 个静态页 + PWA）
    │
    ├── /index.html /blog.html /post.html /album.html /games.html
    │   /links.html /guestbook.html /timeline.html /admin.html /drive.html
    │        ↓ 对外 URL 保持根级，物理文件在 pages/（由 Worker 重写层映射）
    │
    ├── Cloudflare Pages（静态托管）
    │        ↓
    └── Cloudflare Worker（_worker.js，约 4.1k 行，全站后端）
             ├── 表驱动路由：/api/* 统一 dispatch（matchRoute + needAuth/needBody）
             ├── Store 层：KV（SITE_DATA）+ 边缘缓存 caches.default
             ├── GitHub 代理层：ghApiRequest（超时/重试/多源/速率兜底）
             ├── 文章面：读（多来源合并）/ 写（后台写作 + GitHub 同步）
             ├── 云盘面：/api/drive/*（见下）
             ├── 图片代理：/api/github/raw/<repo>/<branch>/<path>（SWR 缓存）
             └── CSP 响应头下发（详见第 3 节）

前端资产分层（对外 URL = 物理路径）：
    components/   music-player.js（全站悬浮播放器，defer + requestIdleCallback）
                  game-core.js + games/*.js（7 款小游戏）
                  ui.js（v8.0 全局 UI 组件库：Toast/对话框/copyText/btnLoading）
    services/     request.js（fetch 封装）/ uploadService.js（上传/分片引擎）
    utils/        common.js（主题/菜单/滚动/PWA/离线横幅/错误边界/对话框桥接）
                  blog-utils.js（escapeHtml/toast/copyText/fmtBytes 等公共工具）
    styles/       common.css（设计令牌 + 交互基元 + 玻璃态）/ drive.css
    vendor/       jszip.min.js（v8.0 本地化的 JSZip 3.10.1，CSP 禁 CDN）
    sw.js         Service Worker v3.4.0（预缓存外壳 + 分类缓存策略）
    scripts/      route-map.mjs（URL 映射唯一事实源）/ build-pages.mjs（多输出目录加固）

云盘分片上传协议（大文件 >8MB）：
    前端 File.slice(5MB) → POST /api/drive/upload/part → Worker 直存 part 文件
    → POST /api/drive/upload/finish → 写 manifest（drive/[子目录/].m-<uploadId>.json）
    下载：读 manifest → 并发拉 parts raw → Blob 顺序重组（无单文件直链）
    断点续传：GET /api/drive/upload/status?uploadId → 已落库分片序号 → 跳过重传
    崩溃恢复：uploadId + 已传分片表存 localStorage → 重开页面恢复为「等待文件」态

文章发布链路：
    admin.html 编辑 → POST /api/posts（写锁 withWriteLock）→ KV 列表 + GitHub 同步
    → 前端 blog.html / post.html 读公共 JSON（NetworkFirst + 离线回退）
```

---

## 2. 历史排雷档案（终极解法，勿重复踩坑）

| # | 故障 | 根因 | 终极解法 |
|---|------|------|----------|
| P0 | 文章连点重复发布 + 删除失效 | KV 读-改-写竞态：并发写覆盖彼此，删除读到旧 sha 提交 409 | 引入 `withWriteLock` 写锁包裹全部写操作（提交 `26cac59`，step13 专项测试覆盖） |
| 2 | 大文件分片 409 冲突 | 分片已存在时 GitHub 返回 409，前端误判失败 | 409 视为「该片已传」纳入 done 表；删除遇 409 则刷新 sha 后自动重删一次（自愈） |
| 3 | 分片 SHA 冲突 | GitHub Contents API 的 PUT 必须带当前 sha，否则 409 | 写前 GET 取 sha；冲突一次刷新重试；worker 侧统一兜底 |
| 4 | 强关浏览器丢进度 | File 对象无法持久化，防抖窗口内强关丢状态 | uploadId + 分片表落 localStorage；`beforeunload`/`pagehide` 同步 `flushPersist`；重开恢复为 awaitingFile 态 |
| 5 | 排序不稳定 | tie-break 也乘了方向系数 | `if (r !== 0) return r * d;` 后固定按名称升序 tie-break |
| 6 | 上传后列表不刷新（本轮 B2 修复） | list 的 30s isolate 缓存 `driveListMemo` 未在写操作后失效 | 写操作入口统一 `driveListMemo.at = 0`（叠加原有写成功 `data = null`），DELETE/finish 一并覆盖 |
| 7 | 子目录大文件出现两行 | 旧过滤只挡根目录 `drive/.`，子目录 manifest 同时命中普通文件与 manifest 两条路径 | `path.split("/").slice(1)` 任一段以 `.` 开头即排除 |
| 8 | 拖拽文件夹上传全挂 | `FileSystemFileEntry.file` 是**方法** `file(cb, errCb)`，代码当 File 对象直接入队 | walk 区分：假 entry 用对象，真 FileEntry 调 `entry.file(cb, errCb)` 异步取 |
| 9 | zip 打包出现 `.m-xxx.json` 条目 | chunked 条目的 `path` 是 manifest 路径而非显示名 | `zipPathOf` 对 `storage === "chunked"` 直接用 `f.name` |
| 10 | 测试套件「假绿」 | `finally { process.exit(...) }` 吞掉 catch 的异常信息，失败用例以 exit 0 收场 | 异常计入 `failed` 再走 finally 清理，exit 放在 try/catch/finally 之后 |
| 11 | 硬编码口令裸奔（v8.0 安全止血） | `_worker.js` 内 `fallbackPassword` / `fallbackPin` 明文兜底，而代码仓是**公开**仓库 → 任何人 clone 即可登录后台、写云盘 | 删除全部明文兜底：`getAdminPassword(env)` 只取环境变量，缺失即 500「服务端未配置密钥」；`drivePinOk` → `drivePinGuard`，DRIVE_PIN 缺失即 500。**绝不再引入任何默认值** |
| 12 | Pages 环境变量写了却不生效 | 经 API 写入 `deployment_configs.*.env_vars` 后，Git 触发的新部署里 `env` 仍只有 `ASSETS / CF_PAGES_* / SITE_DATA` | ① 用 `type: "secret_text"` 写入；② 写入后对最新部署执行 **retry**（POST `/deployments/{id}/retry`）而非等下次 Git 推送。排查用临时端点返回 `Object.keys(env)`（只列键名、不列值），确认后立即删除 |

---

## 3. 开发避坑指南（含遗留问题）

### 已解决（v8.0，勿回退）
- ~~硬编码口令兜底~~：已清除，见排雷 #11。站点密钥清单（`ADMIN_PASSWORD` / `DRIVE_PIN` / `GITHUB_TOKEN`）必须全部配置在 CF Pages 环境变量；缺失的接口会主动 500 报错而不是静默放行
- ~~`fmtBytes is not a function`~~：`pages/drive.html` 改为「公共实现优先 + 本页等价兜底」，并配合 SW `CACHE_VERSION` +1 清理旧 `blog-utils.js` 缓存
- ~~内容仓文件名错误~~：`music.ison` / `timeline. json` 已通过 Git Data API 单次提交改为 `music.json` / `timeline.json`
- ~~posts/README.md 被当文章~~：文章列表新增 `README/CHANGELOG/LICENSE` 等非文章文件过滤

### 遗留问题 1：大文件不支持重命名
- 现状：`pages/drive.html` 中 `storage === "chunked"` 的行，重命名按钮 `disabled`（title 说明原因）
- 根因：改名需要改写 manifest 内 `name` 字段并同步列表条目，分片协议未提供原子改名能力
- 解法方向（v7.4）：新增 `/api/drive/rename-chunked`，只改 manifest 的 `name`（不动 parts），前端放开按钮

### 遗留问题 2：CSP 依赖 `'unsafe-inline'`
- 现状：`script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com`
- 根因：10 个页面大量内联 `<style>` 与 `<script>`（首屏零请求的关键设计）
- 影响：第三方 CDN 一律不可用（故 JSZip 必须 `vendor/` 本地化）
- 解法方向（v7.4）：内联样式/脚本做 hash 或 nonce 化；工作量集中在页面内联块，非紧急不动

### 绝对红线（任何时候不得违反）
1. **严禁重写网盘大文件分片与重试的底层逻辑**（`services/uploadService.js` 的 startTask/分片/重试/状态机内核）— 只允许外层 UI 与功能增强
2. **严禁触碰本地 `.env` / `.dev.vars` 密钥文件**（本仓库不提交密钥，变量清单见 `.env.example`）
3. **严禁破坏对外 URL 契约**（`scripts/route-map.mjs` 是唯一事实源；SW 预缓存、SEO 外链、20+ 测试套件全部依赖）
4. Bug 试错 5 次即记录绕过，绝不卡死（详见 `PROGRESS.md` 试错记录）

### 测试契约（改动前必读）
- `#fileTbody tr` 行数 = 文件行数（**目录条目渲染在 `#dirGrid`，绝不进 tbody**）
- `#cx-dialog` / `.cx-btn-primary` = 对话框 DOM 契约（step15 依赖）
- `.up-item[data-name]` / `.up-pause` / `.up-retry` / `.up-cancel` / `#upSummary`「共 N 个 · 完成 N」= 上传队列契约（step12/14 依赖）
- 打包/预览等新功能：见 `tests/step17-drive-pro.mjs`

---

## 4. 零报错启动流程（新环境第一步干什么）

```bash
# 第一步：检查环境
node -v          # 必须 >= 20（package.json engines 强制）
# 或用一键脚本：
./setup_env.sh   # Linux/macOS
setup_env.bat    # Windows 双击

# 第二步：拉齐依赖
npm install      # 仅 playwright（测试用）；config 已设 playwright_skip_browser_download
# 无预装浏览器时指定可执行文件：CHROMIUM_PATH=/usr/bin/chromium npm test

# 第三步：构建产物目录加固（可选，CI 已内置）
npm run build    # = node scripts/build-pages.mjs → 同步 dist/ public/ build/

# 第四步：跑全量回归（21 个套件，500+ 断言）
npm test         # = node tests/run-all.mjs
# 单套件：npm run test:drive / test:chunked / test:seo / test:a11y ...

# 第五步（部署前必做）：确认站点密钥已在 CF Pages 环境变量就位
#   ADMIN_PASSWORD（后台登录）、DRIVE_PIN（云盘口令）、GITHUB_TOKEN（内容同步）
#   三者任一缺失 → 对应接口返回 500「服务端未配置密钥」（设计如此，不是 Bug）
#   线上自检：node tests/_online-smoke.mjs（需 DRIVE_PIN / ADMIN_PASSWORD 环境变量）

# 第五步：看历史
git log --oneline -20
git show 26cac59   # P0 文章并发修复
```

### 部署到 Cloudflare Pages
1. Build command：`npm run build`；Build output directory：`/`（脚本已自动兼容 `/dist` `/public` `/build` 三种配置）
2. 环境变量/Secret：见 `.env.example`（`GITHUB_TOKEN`、`DRIVE_PIN` 等），**只填在 CF Dashboard，绝不写入仓库文件**
3. 发布后 SW 版本号（`sw.js` 的 `CACHE_VERSION`）**必须 +1**，否则用户停留在旧缓存

### 本地起静态服务器（手动验证）
仓库无内置 dev server（测试套件各自起临时 server）。可用：
`python3 -m http.server 8080` 即可静态预览（API 需部署环境或测试 mock）。

---

## 5. v7.4 待办清单（本轮未完成的战役 4 / 5）

**已完成（可交付）**：
- 战役 1（部分）：全局玻璃态设计令牌 + `.glass` 工具类 + navbar 毛玻璃 + 卡片悬停浮起
- 战役 2（部分）：`components/ui.js` 全局 UI 组件库收拢（Toast/对话框/copyText/btnLoading）+ SW 预缓存同步
- 战役 3（主体完成）：面包屑多级导航、目录 chips、上传到子目录、文件夹上传（input + 拖拽递归）、JSZip 多选打包下载（按需加载）、在线预览（图片/文本/音视频）、上传速度预估
- 本轮修复：list 缓存失效、子目录 manifest 双重计数、拖拽 FileEntry、zip 条目命名、测试假绿

**未完成（v7.4 计划）**：
| 项 | 说明 | 难度 |
|----|------|------|
| 文章沉浸式阅读模式 + TOC 滚动高亮增强 | TOC 与 scroll-spy 已存在，需新增阅读模式（宽度/字号/进度） | 中 |
| 相册高级瀑布流 + 灯箱手势滑动缩放 | masonry + lightbox 已存在，缺双指缩放/滑动切换 | 中 |
| 音乐全局悬浮播放器「切页不断播」 | 需 sessionStorage 状态持久化 + 新页首次交互续播 + 置顶悬浮窗逃生舱（浏览器自动播放策略限制） | 高 |
| 游戏本地最高分记录 | game-core 已有 safeStorage，缺统一 best-score API 与各游戏接入 | 低 |
| 性能极限压榨 | uploadService 按需加载、图片 WebP 化/边缘缓存、首屏指标 | 中 |
| 大文件重命名（遗留问题 1） | 只改 manifest name 字段 | 低 |
| CSP 收紧（遗留问题 2） | 内联脚本/样式 nonce 化 | 高 |

---

## 6. 文件速查

| 文件 | 作用 |
|------|------|
| `PROGRESS.md` | 防失忆档案：任务状态、红线判定、试错记录、变更日志（**每步必更新**） |
| `scripts/route-map.mjs` | URL → 物理文件映射唯一事实源（_worker.js 内联拷贝，step10 断言一致性） |
| `tests/run-all.mjs` | 全量回归入口（注册了 21 个套件） |
| `tests/step17-drive-pro.mjs` | v8.0 网盘商业级强化专项（A–G 组：目录/上传/文件夹/拖拽/打包/预览/worker） |
| `docs/` | 《开发与避坑指南》《架构说明书》《运维手册》等历史文档 |
| `README.md` | 部署指南 + 测试矩阵 |
