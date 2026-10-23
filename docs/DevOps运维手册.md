# DevOps 运维手册

> **版本**：v3.3（2026-10-23 三次核验：GitHub PAT 权限扩容 / Actions 部署全链路验证通过 / 双通道并存确认）
> **适用范围**：`leiyihan-ren/my_blog_code` 仓库 + Cloudflare Pages 项目 `leiyihan`
> **生产地址**：
> - **自定义域名（正式站，当前服役）：https://leiyihan.dpdns.org**（dpdns.org 子域，CNAME → Cloudflare Pages，HTTPS/Brotli 正常）
> - 备用/应急入口：https://leiyihan.pages.dev
> - 说明：`leyi.my` 是**另一个与本博客无关的域名**（DNS 指向 `45.205.18.87` 的无关站点），并非本站，详见 [§11 域名与自定义域名](#11-域名与自定义域名已澄清)。

---

## 1. 架构总览

```
                     ┌─────────────────────────────────────────────┐
                     │              访问者（浏览器）                  │
                     └──────────────┬──────────────────────────────┘
                                    │ HTTPS
                     ┌──────────────▼──────────────────────────────┐
                     │        Cloudflare 全球边缘网络（300+ PoP）      │
                     │  ┌─────────────┐  ┌───────────────────────┐  │
                     │  │ 标准边缘缓存  │  │  Pages 高级模式 Worker  │  │
                     │  │ 静态资产/API │  │  _worker.js（路由/回退） │  │
                     │  └─────────────┘  └───────────┬───────────┘  │
                     └───────────────────────────────┼──────────────┘
                            │ 缓存 MISS 时            │
              ┌─────────────▼──────────┐   ┌──────────▼───────────┐
              │  Pages 静态资产（dist/） │   │  GitHub（Data API）  │
              │  HTML/JS/CSS/SW/图标    │   │  内容数据源 + 图片    │
              └────────────────────────┘   └──────────────────────┘
                            ▲
                            │ 推送触发
              ┌─────────────┴──────────┐
              │   GitHub 仓库（main）    │◄── 开发推送 / CI
              └────────────────────────┘
```

**三条内容通道**（全部经 Cloudflare 边缘缓存）：
1. **静态资产**：HTML/JS/CSS/`sw.js`/图标——Pages 资产，天然走边缘缓存；
2. **API 聚合**：`/api/album/photos`、`/api/game/scores` 等——Worker 处理，`s-maxage` 激活边缘缓存；
3. **GitHub 代理**：`/api/github/api/*`、`/api/github/raw/*`——Worker 转发 GitHub，`s-maxage=3600` + `stale-while-revalidate=86400`。

**Service Worker 双缓存**（`sw.js` v3.0.2）：
- `STATIC_CACHE`：install 期预缓存（含懒加载的游戏脚本 `games/*.js`）；
- `RUNTIME_CACHE`：SWR 运行时缓存，**查不到时回落 STATIC_CACHE**（保证断网可玩懒加载游戏）。

---

## 2. 凭证与权限矩阵

| 凭证 | 存放位置 | 用途 | 最小权限 |
|---|---|---|---|
| `GITHUB_TOKEN`（PAT） | Cloudflare Pages → Environment variables | Worker 拉取 GitHub 内容时提升配额（60→5000 次/小时） | 公开仓库只读 `public_repo`（如仓库私有则 `repo` 只读） |
| `CLOUDFLARE_API_TOKEN` | 用户自留（**已确认有效，当前不使用**） | 仅当改用 GitHub Actions 直传部署时才需要（见 §5） | Pages 项目的 `Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | 用户自留 | 同上 | — |
| CF 账户登录 | dash.cloudflare.com | 手动管理 Pages/KV/环境变量 | — |

> **当前状态**：生产部署由 **Cloudflare Git 集成**自动完成（推送 GitHub 即触发），Actions 不参与。
> `GITHUB_TOKEN` 已由用户在 CF Pages 配好并**验证生效**——经 `/api/github/api/user` 实测返回 `leiyihan-ren`，
> 配额已从 60/小时 提升到 5000/小时，配额隐患解除。
> 已确认（2026-10-23）：**保持 Git 集成开启，不关闭、不走 Actions 双通道**，故 CF 两个密钥当前无需配置（见 §5）。

---

## 3. 部署通道

### 3.1 主通道：Cloudflare Git 集成（当前服役）

```
git push origin main
  → Cloudflare 监测到 GitHub 推送
  → 拉取仓库 → 无需构建（纯静态，构建命令留空，输出目录 /）
  → 部署到生产（提交状态回写到 GitHub：pending → success）
```

**验证方法**：
```bash
# 1) GitHub 侧确认 CF 构建结果
gh api "repos/leiyihan-ren/my_blog_code/commits/<sha>/check-runs" \
  --jq '.check_runs[] | "\(.name): \(.status)/\(.conclusion)"'
# 期望：Cloudflare Pages: completed/success

# 2) 线上确认内容（Pages 域名，-L 必须加：.html 会 308 到 pretty URL）
curl -sL -o /dev/null -w "%{http_code}\n" https://leiyihan.pages.dev/
curl -sL https://leiyihan.pages.dev/games | grep -c "rank-body"
```

### 3.2 沙箱/受限网络特例：Git Data API 等价推送

部分执行环境（如 CI 沙箱）到 `github.com:443` 的 git 智能 HTTP 被阻断，
但 `api.github.com` 可用。此时用 Git Data API 完成等价推送
（工具：`api_push.py`，四步：blobs → tree → commit → PATCH ref）：

```
GET  /repos/:o/:r/git/ref/heads/main      # 远程基线 SHA
GET  /repos/:o/:r/compare/<base>...<head> # 差异文件清单
POST /repos/:o/:r/git/blobs               # 逐文件建 blob
POST /repos/:o/:r/git/trees               # 建树（base_tree 挂基线）
POST /repos/:o/:r/git/commits             # 建提交（父=基线）
PATCH /repos/:o/:r/git/refs/heads/main    # 推进引用
```

**已知坑（务必规避）**：
1. 该方法每次推送都会生成**新 SHA 的重复提交**（同样的内容不同的 commit 对象）。
   历史上因此产生了 4 个重复的「步骤2/3」提交。
   **推送前必须先 `git fetch && git reset --origin/main` 对齐本地与远端**，
   否则 `ahead` 状态会让每次推送再复制一遍全部提交。
2. 作者身份失败时回退用 PAT 身份（脚本已内置）。

### 3.3 GitHub Actions 双流水线

| 工作流 | 触发 | 作用 |
|---|---|---|
| `ci.yml` / `test.yml` | push / PR | 全链路回归（9 套件 / 467+ 断言），**红即禁止合并** |
| `deploy.yml` | push main / workflow_dispatch | 构建 `dist/` → wrangler 直传（**Secrets 已配，2026-10-23 全链路验证通过**，见 §5） |

---

## 4. 缓存策略全景

### 4.1 Worker 边缘 TTL（`_worker.js` `API_CACHE_TTL` + Cache-Control 公式）

```js
"Cache-Control": `public, max-age=${ttl}, s-maxage=${Math.max(3600, ttl)}, stale-while-revalidate=86400`
```

| 接口 | max-age（浏览器） | swr | s-maxage（边缘） | 说明 |
|---|---|---|---|---|
| `/api/site` | 300 | 1200 | — | 站点配置 |
| `/api/stats` | 60 | 240 | — | 统计数 |
| `/api/popular` | 300 | 1200 | — | 热门文章 |
| `/api/posts` | 120 | 480 | — | 文章列表 |
| `/api/messages` | 30 | 120 | — | 留言板（**刻意不边缘缓存**，保新鲜） |
| `/api/music`、`/api/timeline`、`/api/links`、`/api/album/photos` | 300 | 1200 | — | 内容型接口 |
| `/api/game/scores` | 60 | 240 | — | 排行榜（**刻意不边缘缓存**，保新鲜） |
| `/api/github/api/*` | 300 | 86400 | 3600 | GitHub API 代理 |
| `/api/github/raw/*`（图片） | 86400 | 86400 | 86400 | 图片不可变，缓存 1 天 |

> ⚠️ **2026-10-23 据实修正**：内容型路由（`/api/site` 等）实际只设 `max-age + stale-while-revalidate`，
> **并无 `s-maxage`**（此前表格误标为 3600）。只有 `/api/github/*` 代理路径带 `s-maxage`。
> 这是有意设计：留言板/排行榜等交互数据靠浏览器短 `max-age` + Worker 内部 Cache API 保新鲜，
> 不强上边缘长缓存。下文 §4.3 说明了自定义域上边缘缓存不生效的根因。

**语义要点**：
- `s-maxage` 是**激活 Cloudflare 标准边缘缓存**的开关——没有它响应一律 `cf-cache-status: DYNAMIC`；
- `stale-while-revalidate`：过期后仍可 Serve 陈旧响应，同时后台拉新；
- 边缘 **HIT 时 Worker 根本不执行**（无新增 `x-response-time`，这是判别方法）；
- Cache API 的缓存**不跨 colo 复制**，不同 PoP 首访必 MISS 属正常。

### 4.3 自定义域边缘缓存观测（2026-10-23 实测）

对同一接口 `/api/github/api/repos/leiyihan-ren/Blog` 连打，两个入口行为不同：

| 入口 | 第 1 次 | 第 2 次起 | 结论 |
|---|---|---|---|
| `leiyihan.pages.dev` | MISS（304ms） | **cf-cache-status: HIT**（~15ms） | 边缘缓存生效 |
| `leiyihan.dpdns.org` | DYNAMIC（29ms） | **DYNAMIC**（~25ms） | 边缘不缓存，Worker 每次执行 |

**根因**：`leiyihan.dpdns.org` 是 `dpdns.org`（免费动态 DNS）的子域，走的是 **dpdns.org 这个 zone 的边缘**。
该 zone 由服务商掌握、不在本人 CF 账户下，没有「Cache Everything」类规则，故动态响应不被边缘缓存；
而 `pages.dev` 由本人 CF 账户托管，走 Pages 优化的缓存层，`s-maxage` 直接生效。

**影响与缓解**：
- 自定义域上每个 `/api/*` 请求都会执行 Worker，但 **Worker 内部 Cache API 仍命中**（`x-cache: HIT`，22–29ms），功能与速度不受影响，只是没吃到边缘缓存的极致减免；
- 高并发下 Worker 逐次执行会放大尾延迟（20 并发压测 API p99≈10s）；
- **彻底解决需 zone 级权限**：把自定义域换到本人 CF 账户下的域名（NS 指向 Cloudflare），再加一条 `/api/*` 的「Cache Everything」Cache Rule。免费 `dpdns.org` 子域做不到（见 §10、§11）。

### 4.2 压测注意事项

- `/api/github/*` 的 cacheKey **含 query string**——必须用**完全相同的 URL** 重复打才能命中缓存；
- 带任意变化 query 会直穿 GitHub，烧 API 配额（60/小时无 PAT）；
- 压测脚本 `loadtest.mjs` 已内置「同 URL 重复打」策略。

---

## 5. GitHub Actions 部署通道（已验证可用，双通道并存）

**2026-10-23 19:45–19:52 全链路验证通过。** GitHub PAT（`github_pat_11CEB…`，仅覆盖
`leiyihan-ren/my_blog_code` 一个仓库）经用户直接补权限后具备：**Contents / Secrets / Workflows /
Actions 均 Read and write**。两个 Cloudflare 凭证已写入仓库 Secrets：

| Secret | 值 | 写入时间（UTC+8） |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `cfat_` 新格式令牌（权限 `Cloudflare Pages: Edit`） | 19:45:39 |
| `CLOUDFLARE_ACCOUNT_ID` | `5dca3f8d665e2b3d0180b82ead55c6c9` | 19:45:41 |

**验证记录**：`gh workflow run deploy.yml --ref main` 触发 run `39948948987`，21s 完成，
「检查部署凭据」与「部署到 Cloudflare Pages」两步全绿；CF 侧生成 `trigger=ad_hoc` 的生产部署记录
（区别于 Git 集成的 `github:push`），线上探针首页/API 均 200。

**当前格局：双通道并存（用户决定保持 Git 集成开启）**

- **Cloudflare Git 集成**：保持开启，push 即自动构建部署（`github:push`）；
- **GitHub Actions**：Secrets 就位后**下次 push 起自动真部署**（此前未配 Secrets 为空跑跳过，
  仅 9–11s），亦可随时 `gh workflow run deploy.yml --ref main` 手动触发；
- 两者构建同一份代码、部署同一项目，**内容一致不冲突**；`concurrency: deploy-production`
  防止 Actions 自身并发。代价是每次 push 多一次构建（约 20s）；
- 如需收回单通道：CF → Pages → Settings → Build & deploy → 暂停 Git 集成即可（用户暂不关闭）。

> 已核实：CF API Token（`cfat_` 新格式）有效、具备 `Cloudflare Pages: Edit` 权限。
> ⚠️ `/user/tokens/verify` 对该新格式令牌会**误报** "Invalid API Token"，判断有效性以实际 API 调用（如列账户/项目）为准。
>
> **PAT 权限备忘**（最易踩的坑）：管理 Actions Secrets 需 **Secrets: R/W**（曾缺，403）；
> 触发 `workflow_dispatch` 需独立的 **Actions: R/W**——**Workflows 权限只管改工作流文件，
> 不管运行**。用户已直接在原 token 上补权限，即时生效（fine-grained token 现支持创建后编辑权限，
> 无需换 token、不影响 gh 登录态）。

---

## 6. 日常运维 SOP

### 6.1 发布一次改动

```bash
cd my-blog
node tests/run-all.mjs          # 1. 本地全量回归（9 套件，必须全绿）
git add -A && git commit -m "..." # 2. 提交
git push origin main            # 3. 推送（沙箱环境用 api_push.py，见 §3.2）
# 4. 等 1-2 分钟，验证：
gh api "repos/leiyihan-ren/my_blog_code/commits/main/check-runs" --jq '.check_runs[] | "\(.name): \(.conclusion)"'
curl -sL https://leiyihan.dpdns.org/ | grep -c "<改动探针>"   # 正式域名（备用：https://leiyihan.pages.dev/）
```

### 6.2 强制刷新边缘缓存

对单个 URL：`curl -sI "https://leiyihan.dpdns.org/<路径>" -H "Cache-Control: no-cache"` 只影响浏览器；
边缘缓存刷新需 CF Dashboard → Caching → Configuration → **Purge Everything**（全站），
或在 API 用 `zone_purge_cache`（需要 zone 级权限——当前 Token 仅 Pages 权限，做不了）。

### 6.3 Lighthouse 性能巡检

```bash
# 本地起服务（含 API mock）后用 chromium 跑，沙箱里 google-chrome 会起不来，必须指定路径
npx lighthouse https://leiyihan.dpdns.org/ \
  --only-categories=performance \
  --chrome-path=/usr/bin/chromium \
  --chrome-flags="--no-sandbox --disable-dev-shm-usage --headless=new"
```

**当前基线**（2026-10-23 复测，移动端，本地 mock 服务 + chromium）：

| 页面 | Performance | CLS | LCP | TBT | 备注 |
|---|---|---|---|---|---|
| 首页 | **99** | 0 | 2.0s | 30ms | 原 89 |
| games | **99** | **0**（原 0.277） | 1.9s | 10ms | 排行榜预留修复 |
| album | **99** | **0.029**（原 0.119） | 2.0s | 0ms | footer 精确预留 |

> 注：以上为**本地 mock**（API 瞬时返回）结果，LCP 会低于线上真实 GitHub 拉取；
> 线上真实延迟受 GitHub 内容获取 + §4.3 自定义域边缘缓存现状影响。核心 Web 指标（CLS/TBT）已归零或近零。

---

## 7. 压测

```bash
node loadtest.mjs   # 20 并发 × 15s × 2 阶段（静态 + API 同 URL 缓存键）
```

**判定标准**：无 429、无持续性 5xx。
**2026-10-22 结果**：1312 请求，0 个 429，1 个瞬时 500（复打 23/23 全 200，判定为冷启动/网络抖动，非系统缺陷）。
**2026-10-23 复测**（目标 `leiyihan.dpdns.org`，20 并发 × 15s）：793 请求，**0 失败、0 个 429**。
静态资产 391 全 200（cf-cache-status 以 REVALIDATED 为主）；API 402 全 200，但 `cf-cache-status` 多为 DYNAMIC、
p99≈10s——根因是自定义域边缘不缓存（见 §4.3），Worker 逐次执行 + 冷缓存时的上游争抢。
**后续**：换成本人 CF 账户下的域名并加 `/api/*` Cache Everything 规则后，API 将走边缘 HIT，尾延迟可大幅收敛。

---

## 8. 故障案例库（避坑）

### 8.1 gh-proxy 缓存 HIT 路径 500（immutable headers）

- **现象**：`/api/github/*` 无 query 正常；带 query 第二次请求必 500；
- **根因**：CF Cache API 的 `cache.match()` 命中时返回的响应 headers 是 **immutable guard**
  （Fetch 规范），`withXCache()` 直接 `headers.set("X-Cache", ...)` 抛 TypeError，
  被入口 try/catch 兜底成 500。该缺陷自缓存上线即存在，被 CDN 兜底与边缘缓存掩盖；
- **修复**：复制 headers 构造新 Response 再改：
  ```js
  function withXCache(response, state) {
    const headers = new Headers(response.headers);
    headers.set("X-Cache", state);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  ```
- **回归**：`tests/step6-edge-cache.mjs` 用 `ImmutableHeaders extends Headers`（set/append/delete 抛错）
  模拟 CF 行为。此前 Node 无 `caches` 全局，HIT 路径**零覆盖**——这是最深的教训。

### 8.2 Pages `.html` 308 跳转误判

`/album.html` 会 308 到 pretty URL `/album`，curl 不加 `-L` 拿到空响应体，
曾误判「线上未更新」。**所有验证 curl 一律加 `-L`**。

### 8.3 无限滚动 + scrollRestoration

刷新后浏览器恢复滚动位置到底部 → 哨兵立即触发翻页 → SW 缓存被多余页污染。
修复：`history.scrollRestoration = "manual"`（album.html）。

### 8.4 SW 预缓存与懒加载的断层

懒加载的游戏脚本只在 install 期进 STATIC_CACHE，不经 RUNTIME_CACHE，
SWR 分支查不到即离线 503。修复：SWR 分支加 STATIC_CACHE 兜底 + SW 版本号 v3.0.2。

### 8.5 压测打错路径

`/api/github/site` 之类路径不存在（真实形态是 `/api/github/api/*` 与 `/api/github/raw/*`），
会 400。压测前先 `curl` 确认路径。

---

## 9. 回滚

| 场景 | 方法 |
|---|---|
| 代码级回滚 | CF Dashboard → Pages → Deployments → 选旧部署 → **Rollback**（秒级） |
| Git 级回滚 | `git revert <sha>` 推送（走正常 CI，约 2 分钟） |
| SW 版本回滚 | 修改 `sw.js` 顶部 `CACHE_VERSION` 并推送，旧 SW 自清理 |
| KV 数据 | 后台有导出功能；`/api/backup/export`（管理员） |

---

## 10. 已知限制与后续路线

| 事项 | 现状 | 解锁条件 |
|---|---|---|
| CF Image Polish（自动 WebP/AVIF） | **不可用**——需要 zone 级权限，当前 Token 仅 Pages 项目级 | 域名 NS 切到 Cloudflare 后开启 Polish |
| 自定义域名 HTTPS/边缘优化 | **已生效**——`leiyihan.dpdns.org` 走 CF，HTTPS/Brotli 正常（见 §11） | — |
| **自定义域 `/api/*` 边缘缓存** | **未生效**——`dpdns.org` zone 非本人账户、无 Cache Everything 规则，动态响应 DYNAMIC（Worker 内部缓存兜底，见 §4.3） | 换到本人 CF 账户下的域名 + 加 `/api/*` Cache Rule |
| Actions 直传部署 | **已验证可用**（2026-10-23 workflow_dispatch 全链路通过，run `39948948987`）；与 Git 集成双通道并存，内容一致不冲突 | 见 §5 |
| 边缘缓存手动 Purge | 不可用 | zone 级权限 Token |

---

## 11. 域名与自定义域名（已澄清）

**2026-10-23 核实**：本站的正式域名是 **`leiyihan.dpdns.org`**（dpdns.org 子域，CNAME → Cloudflare Pages）。
体检全绿：DNS 解析到 CF（`172.67.194.237 / 104.21.90.40`）、HTTPS 200 证书有效、Brotli 启用、
10 个内容接口全 200、`GITHUB_TOKEN` 认证生效（配额 5000/小时）、raw 图片代理 200。

**关于 `leyi.my`（澄清：非本站）**：
- 2026-10-22 曾发现 `www.leyi.my` / `leyi.my` 的 A 记录指向 `45.205.18.87`，返回的是**无关站点**
  （`<title>QiuTV</title>`，nginx/1.24.0，`/api/*` 返回 401/404）。经用户确认，**该域名与本博客无关**，不影响本站。
- 本站对外地址统一使用 `leiyihan.dpdns.org`；`leiyihan.pages.dev` 作备用/应急入口。

**后续可选**：
1. 如需更短域名，另行注册并绑定到 CF Pages（CF 侧 Add custom domain，按指引配 CNAME）；
2. 域名 NS 切到 Cloudflare 后可解锁 Image Polish（WebP/AVIF 自动优化）与边缘缓存手动 Purge（见 §10）。

---

## 12. 本轮 DevOps 五步执行记录（2026-10-22）

| 步骤 | 内容 | 结果 |
|---|---|---|
| 1 CI/CD | GitHub Actions（ci/test/deploy 三工作流）+ CF Pages Git 构建修复 | 9 套件全绿；CF 构建 success |
| 2 前端性能 | 图片 lazy/decoding + 首屏 fetchpriority、页邻接 prefetch、游戏懒加载、CLS 防护 | games CLS 0.277→0；album 0.119→0.029；perf 89→99 |
| 3 边缘计算 | TTL 上调 + s-maxage/swr 激活标准边缘缓存、Brotli 确认、HIT 500 修复 | 生产 MISS 352ms→HIT 32ms |
| 4 部署+验证 | Git Data API 推送 → CF 自动构建；Lighthouse 复测；20 并发压测 | 1312 请求 0×429；1×瞬时 500 复打不复现 |
| 5 文档 | 本手册 + 部署指引 + 避坑指南 | 已归档 |

**关键提交**：
- `72c2877` 前端性能与边缘缓存优化（步骤2/3）
- `7b048b0` 修复 gh-proxy 缓存 HIT 路径 500
- `72c5540` CLS 防护收尾（footer 102px 预留 / 排行榜骨架 / 首图提权）

### 12.1 二次核验与极限压榨记录（2026-10-23）

用户要求「主干直推 + 极限压榨 + 全栈上线」。经核验，五步主体在此前已落地，本轮做的是**据实核验 + 增量优化 + 数据刷新**，未重做、未破坏既有逻辑：

| 步骤 | 本轮动作 | 结论 |
|---|---|---|
| 1 CI/CD | 核验三工作流触发链 | 「push→构建检查(test.yml/deploy.yml)+CF 部署(Git 集成)」已达成；19:45 用户给原 PAT 补权限、写入 CF Secrets 后，Actions 直传**全链路验证通过**（run `39948948987`），与 Git 集成双通道并存（详见 §5） |
| 2 前端性能 | 核验 + 增量 | 2.1 本地仅 PWA 图标/og-image（按规范须 PNG，不转 WebP；照片在远端 Blog 仓为 JPEG）；2.2 prefetch/页邻接已在位，**新增 album.html 对 3 个图片 CDN 的 `dns-prefetch`**；2.3 游戏懒加载已在位 |
| 3 边缘计算 | 核验 + 据实修正 | s-maxage/swr 在 `/api/github/*` 已在位；**发现内容路由实际无 s-maxage（修正手册表格）**、**自定义域 `/api/*` 边缘 DYNAMIC（§4.3 根因：dpdns.org zone 非本人账户）**；worker 125KB/gzip≈35KB 已精简；Brotli 已启用 |
| 4 部署+验证 | 复测 | Lighthouse 三页 99/99/99、CLS≈0；压测 793 请求 0×429 0 失败（暴露 API 尾延迟，根因见 §4.3） |
| 5 文档 | 更新 | 修正 §4.1 表格、新增 §4.3、刷新 Lighthouse/压测数据、更新 §10/§12 |

**仍需用户配置（超出代码仓库、且当前凭证权限不足）**：
1. ~~`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` → GitHub Secrets~~ **✅ 已完成（2026-10-23 19:45，PAT 补权限后写入并全链路验证，见 §5）**；
2. **zone 级权限**（换到本人 CF 账户下的域名后）：开 Image Polish、加 `/api/*` Cache Everything 规则、手动 Purge——这是自定义域边缘缓存不生效的根治条件。

### 12.2 三次核验：PAT 权限扩容与 Actions 部署验证（2026-10-23 19:40–19:52）

| 时间 | 动作 | 结果 |
|---|---|---|
| 19:40–19:45 | 用户直接在原 fine-grained PAT 上补 **Secrets: R/W** | 读写 Secrets 403 解除；两个 CF 凭证写入并确认 |
| 19:47 | `gh workflow run` 触发手动部署 | 403——发现触发 dispatch 需独立的 **Actions: R/W**（Workflows 权限只管改工作流文件，不管运行） |
| 19:50 | 用户补 **Actions: R/W** 后重试 | run `39948948987` 21s 全绿；CF 侧 `ad_hoc` 生产部署记录生成；线上探针 200 |

**PAT 权限边界备忘**（供未来排障）：Contents: R/W → 推送提交；Secrets: R/W → 管理 Actions Secrets；
Workflows: R/W → 改工作流文件；**Actions: R/W → 触发/管理运行**（四个独立项，最易漏 Actions）。
Repository access 已收敛到仅 `my_blog_code` 一个仓库；Token 有效期至 2027-01-19。

**观察（判定为非回归）**：`/api/site` 复测 0.7–1.2s（冷启动首打 3s），`cf-cache-status: DYNAMIC`
属已知特性（§4.3）；pages.dev 对照同接口 1.6s，慢在源侧共性；本次部署代码与线上已运行内容
零差异，排除部署引入回归。
