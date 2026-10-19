# 我的个人博客（Cloudflare Pages + KV 单 Worker 版）

一个零依赖、全站运行在 Cloudflare Pages 上的个人博客：文章、相册、时间线、留言板、音乐播放器、网页小游戏、友情链接，全部数据存于 Cloudflare KV，无需任何服务器与数据库运维。

## 功能特性

| 模块 | 说明 |
|------|------|
| 📝 文章系统 | 发布/编辑/删除、全文搜索（关键词高亮）、阅读量与点赞统计、上一篇/下一篇导航 |
| 🖼️ 相册 | 关联 GitHub 仓库自动读取图片（经 Worker 多源拉取 + 多镜像兜底），灯箱预览、键盘导航、懒加载 |
| 🕐 时间线 | 生活/学习事件流，管理后台增删 |
| 💬 留言板 | 昵称 + 内容，服务端 XSS 净化、频率限制（60 秒冷却 + 每小时上限） |
| 🎵 音乐播放器 | 全站底部常驻播放器：四档播放模式（列表循环/单曲循环/随机/顺序）、进度条拖拽+缓冲指示、音量记忆+静音、播放列表（当前项均衡器动画+自动滚动）、系统媒体控制（锁屏/耳机按键）、键盘快捷键（空格播放/方向键快进/Shift切歌）、收起展开、游戏运行时自动让位 |
| 🎮 游戏大厅 | 5 款网页小游戏（贪吃蛇 / 打砖块 / 2048 / 记忆翻牌 / 扫雷），全站在线排行榜 + 个人最佳 |
| 🔗 友情链接 | 友链卡片展示、申请友链面板（一键复制站点信息 + 邮件申请） |
| ⚙️ 管理后台 | 登录鉴权、内容管理、友链/游戏管理、数据备份导出与导入、GitHub 连接状态面板 |
| 🔗 双内容源 | 管理后台手写内容与 GitHub 仓库内容**合并展示**：后台发布/编辑的内容优先，仓库新增内容自动补充（详见下文） |
| 🌗 体验细节 | 暗色模式（跟随系统 + 手动切换）、响应式布局、空态/加载态、ETag 缓存 |

## 技术架构

```
浏览器 ──HTTPS──> Cloudflare Pages
                     ├── 静态资源（*.html / *.js）  → env.ASSETS + 安全响应头
                     └── /api/*                     → _worker.js（单文件 Worker）
                                                      └── Cloudflare KV（SITE_DATA）
```

### Worker 分层结构（`_worker.js`，约 2000 行）

```
 1. CONFIG       —— 全部可调参数（限流、长度、默认数据、GitHub 拉取策略）
 2. UTILS        —— 安全 JSON 解析、ID 生成、时间格式化
 3. VALIDATORS  —— 昵称/富文本/URL/ID 格式校验
 4. SANITIZE    —— XSS 深度净化（6 轮检测）
 5. HTTP        —— ok/err/HttpError/JSON+ETag 响应助手
 6. KEYS        —— KV 键名统一管理（消除散落的字符串拼接）
 7. Store       —— 数据访问层：请求级缓存、分页遍历、waitUntil 兜底写入
 8. GitHub      —— 双内容源合并 + 多源故障转移拉取（详见下文）
 9. Repo        —— 业务实体存取（文章/留言/时间线/音乐/点赞/阅读/友链/游戏分）
10. Services    —— 限流、登录锁定、认证中间件
11. Handlers    —— 各接口处理函数
12. ROUTES      —— 表驱动路由（路径模式 → 正则 + :param 提取）
13. Entry       —— fetch 入口：API 分发 + 静态资源 + 统一错误处理
```

### 双内容源：后台手写 × GitHub 仓库

文章 / 音乐 / 时间线支持两个内容源**合并展示**（`site.autoMode` 开启且配置了仓库时生效）：

- **合并规则**：GitHub 仓库列表与后台数据按 `id` 合并，**后台优先**——同一篇文章在后台编辑保存后，后台版本覆盖仓库版本
- **删除墓碑**：在后台删除一条仓库来源的内容时，其 `id` 记入 `deleted_ids` 墓碑键，合并视图据此隐藏；重新保存同 `id` 内容可恢复显示
- **来源标识**：`GET /api/posts|music|timeline?withSource=1` 在响应中附加 `ghIds` 字段（来自仓库的 id 列表），后台列表据此显示「GitHub / 后台」徽章
- **优雅降级**：GitHub 拉取失败时自动降级为仅展示后台内容，接口始终返回 200

### GitHub 拉取鲁棒性（应对国内访问不稳定）

> ⚠️ 注意：Worker 运行在 Cloudflare 边缘节点，**用户本机配置的 DNS 加速对 Worker 侧的 fetch 并不生效**。真正有效的是以下服务端策略：

1. **多源故障转移**：目录列表（GitHub API ↔ jsDelivr data API）与文件内容（raw.githubusercontent → cdn.jsdelivr → cdn.statically.io）各有源链，`useCdn` 决定优先级；任一源失败（网络错误/超时/5xx）自动尝试其余源，404/403/429 直接换源
2. **超时 + 重试**：单源 8 秒超时（AbortController），网络错误/超时/5xx 按 200ms×attempt 退避重试当前源
3. **过期缓存兜底**（stale-while-revalidate）：缓存超过 5 分钟新鲜期后仍先尝试刷新，刷新失败则继续返回旧内容——GitHub 长时间不可达时站点内容不消失
4. **并发去重**：同缓存键的并发请求只发一次网络请求
5. **连接状态可视化**：`GET /api/github-status`（需登录）返回最近拉取成功/失败记录、命中源、是否正在使用过期缓存；管理后台「GitHub 同步」面板实时展示
6. **相册改走 Worker**：浏览器 CSP `connect-src 'self'` 会阻止页面直连外部 API，相册改为请求同源的 `GET /api/album/photos`，每张图片返回 3 个镜像地址，前端加载失败自动切换下一个

### 数据库调用优化（请求级缓存 + 索引合并）

以 200 篇文章的场景对比重构前后单次请求的 KV 读取次数：

| 接口 | 优化前 | 优化后 | 降幅 |
|------|-------|-------|------|
| `GET /api/posts` | 203 次 | 4 次 | ↓ 98% |
| `GET /api/stats` | 206 次 | 7 次 | ↓ 97% |
| `GET /api/post/:id` | 203 次 | 4 次 | ↓ 98% |

关键手段：分散的 `like_<id>` 点赞键合并为单个 `likes` 索引键（消除 N+1）；阅读量同理合并为 `views` 索引。

## 目录结构

```
my-blog/
├── _worker.js          # 唯一后端入口：全部 API + 数据访问 + 安全校验
├── wrangler.toml       # Cloudflare 部署配置（KV 绑定说明）
├── index.html          # 首页：Hero、统计、关于我、热门文章
├── blog.html           # 文章列表 + 搜索
├── post.html           # 文章详情：阅读量、点赞、评论、上一篇/下一篇
├── album.html          # 相册（GitHub 图片源，经 /api/album/photos 多镜像加载）
├── timeline.html       # 时间线
├── guestbook.html      # 留言板
├── games.html          # 游戏大厅（5 款游戏 + 全站排行榜）
├── game-core.js        # 游戏公共框架：基类/输入适配/舞台控制/排行榜/注册表
├── games/              # 每款游戏一个文件，自注册到框架
│   ├── snake.js        #   贪吃蛇（三档速度、转向缓冲、虚拟方向键）
│   ├── breakout.js     #   打砖块（拖尾、碎裂粒子、3 条命）
│   ├── g2048.js        #   2048（新块/合并动画、触屏滑动）
│   ├── memory.js       #   记忆翻牌（3D 翻转、步数计分）
│   └── mines.js        #   扫雷（首击安全、原地更新、长按插旗）
├── links.html          # 友情链接 + 申请面板
├── admin.html          # 管理后台（内容/友链/游戏/备份）
└── music-player.js     # 全站底部音乐播放器组件
```

## 各页面详解（小白必读）

下表说明每个页面对访客展示什么、数据从哪来。**新手只需记住一点：所有 `.html` + `.js` 文件都要上传到 Cloudflare Pages，不需要在 GitHub 内容仓库里放这些页面文件。**

| 页面文件 | 页面名称 | 给访客看什么 | 数据来源 |
|---|---|---|---|
| `index.html` | 首页 | 顶部 Hero（头像/昵称/简介打字机）、全站统计（文章数/留言数/阅读量）、最新 3 篇文章、热门文章 Top5 | `/api/site` + `/api/posts` + `/api/stats` + `/api/popular` |
| `blog.html` | 博客列表 | 全部文章卡片列表，带搜索框（实时过滤 + 关键词高亮）、阅读量/点赞数 | `/api/posts`（合并后台 + GitHub） |
| `post.html` | 文章详情 | 文章标题/正文/元信息、目录、点赞、评论、上一篇/下一篇导航、键盘快捷键（J/K 滚动、T 回顶） | `/api/post/:id` + `/api/posts`（用于上下篇）+ `/api/like/:id` + `/api/comments/:id` |
| `album.html` | 相册 | 瀑布林照片墙 + 灯箱预览（键盘 ←/→/ESC）、多镜像 CDN 兜底加载 | `/api/site`（读仓库配置）→ `/api/album/photos`（Worker 拉取 GitHub 图片） |
| `timeline.html` | 时间线 | 倒序时间轴卡片，滚动渐入动画 | `/api/timeline`（合并后台 + GitHub） |
| `guestbook.html` | 留言板 | 留言列表（30 秒自动刷新）、留言表单（昵称+内容，60 秒冷却） | `/api/messages` |
| `games.html` | 游戏大厅 | 5 款游戏卡片 + 全站排行榜（按游戏分 tab）+ 个人最佳 | `game-core.js` + `games/*.js`（本地运行）+ `/api/game/scores`（排行榜） |
| `links.html` | 友情链接 | 友链卡片墙 + 申请友链面板（一键复制站点信息 + 邮件申请） | `/api/links` + `/api/site` |
| `admin.html` | 管理后台 | 登录后管理：站点设置、文章/时间线/音乐/友链增删改、评论与留言审核、游戏分数清空、数据备份导出/导入、GitHub 同步状态 | 全部 `/api/*` 需鉴权接口 |

> 🎮 **游戏大厅**由 `games.html`（页面外壳 + 内联 CSS）+ `game-core.js`（公共框架：基类/输入适配/舞台/排行榜/注册表）+ `games/` 目录下 5 个独立文件组成。每款游戏自注册，互不干扰。
>
> 🎵 **音乐播放器**`music-player.js` 会被每个页面自动注入到页面底部，无需在每个 HTML 里手动引入（已在各页面用 `<script defer>` 引用）。

## GitHub 内容仓库该建什么（双内容源模式）

本站支持「**后台手写 + GitHub 仓库**」双内容源合并展示。如果你只想用后台手写内容，可以跳过本节；如果想让 GitHub 仓库自动同步文章/相册/音乐/时间线，按下面的结构建仓库。

### 一个还是两个仓库？

**只需要一个 GitHub 仓库**，专门放「内容文件」（文章 Markdown、相册图片、音乐列表、时间线 JSON）。前端的 `.html`/`.js` 文件**不放进这个仓库**，而是直接上传到 Cloudflare Pages（见下文部署）。

当然，如果你想顺便用 GitHub 托管前端代码做版本管理，可以再建一个仓库放前端文件——但**内容仓库和前端仓库要分开**，因为后台配置里填的是「内容仓库」地址。

### 内容仓库的文件夹结构

在你的 GitHub 仓库里按下面结构建文件夹和文件（文件夹名可在后台「站点设置」里自定义，下面是默认值）：

```
你的内容仓库/                     # 比如 my-blog-content
├── posts/                        # 文章文件夹（默认名 posts）
│   ├── welcome.md                #   每篇文章一个 .md 文件
│   ├── my-first-game.md          #   文件名即文章 id（建议英文+连字符）
│   └── ...
├── photos/                       # 相册文件夹（默认名 photos）
│   ├── 01-spring.jpg             #   直接放图片文件（jpg/png/webp/gif）
│   ├── 02-summer.png
│   └── ...                       #   子目录也会被递归读取
├── music.json                    # 音乐列表（默认文件名 music.json）
└── timeline.json                 # 时间线（默认文件名 timeline.json）
```

### 各内容文件的格式

**文章 `posts/xxx.md`**：标准 Markdown，支持标题/列表/引用/加粗/代码/链接/图片。文件名（去掉 `.md`）就是文章 id，文章标题取文件内第一个 `# 标题` 或文件名。

```markdown
# 我的第一篇博客

这是正文，支持 **加粗**、`代码`、[链接](https://example.com)。

- 列表项一
- 列表项二
```

**音乐 `music.json`**：数组，每项含 `title`/`artist`/`url`/`cover`。`url` 必须是 http/https 直链（推荐用 GitHub Raw、jsDelivr CDN 或对象存储直链）。

```json
[
  { "title": "晴天", "artist": "周杰伦", "url": "https://cdn.example.com/songs/qingtian.mp3", "cover": "https://cdn.example.com/covers/qingtian.jpg" },
  { "title": "稻香", "artist": "周杰伦", "url": "https://cdn.example.com/songs/daoxiang.mp3" }
]
```

**时间线 `timeline.json`**：数组，每项含 `date`（YYYY-MM-DD）/`title`/`desc`。按日期倒序展示。

```json
[
  { "date": "2026-09-01", "title": "升入七年级", "desc": "开学第一天" },
  { "date": "2026-10-01", "title": "国庆假期", "desc": "完成博客上线" }
]
```

**相册 `photos/`**：直接放图片文件，无需配置文件。Worker 会递归读取目录下所有图片，每张图自动生成 3 个镜像地址（GitHub Raw / jsDelivr / Statically CDN）用于国内兜底加载。

### 在后台关联仓库

建好仓库后，进入管理后台 →「站点设置」：
1. 开启「GitHub 自动同步」开关
2. 填写 GitHub 仓库地址（格式 `用户名/仓库名`，如 `leiyihan/my-blog-content`）
3. 分支名（默认 `main`，私有仓库需填 GitHub Token，见下文）
4. 文章/相册/音乐/时间线的路径按上面默认值填（或自定义）
5. 保存后立即生效，前台访问即可看到合并内容

> 🔒 **私有仓库**：公开仓库无需 Token；私有仓库需在后台「站点设置」填入 GitHub Personal Access Token（只需 `repo` 读权限），Token 存于 Cloudflare KV，不暴露给前端。
>
> ⚡ **CDN 加速**：默认开启 `useCdn`，优先用 jsDelivr CDN 拉取（国内更快）；关闭则走 GitHub Raw 官方源。后台「GitHub 同步」面板可实时查看命中源与失败重试记录。

## 部署（小白一步一步来）

整个部署**全程免费**，只需一个 Cloudflare 账号。预计 15 分钟完成。分两大步：① 把前端文件部署到 Cloudflare Pages ② 创建 KV 数据库并绑定。

### 第一步：注册 Cloudflare 账号

1. 打开 <https://dash.cloudflare.com/sign-up>
2. 用邮箱注册（无需信用卡，免费额度足够个人博客用）
3. 完成邮箱验证，登录进 Dashboard

### 第二步：创建 KV 数据库（存所有数据）

1. 左侧菜单 → **Workers & Pages** → 顶部 **KV** 标签页
2. 点 **Create a namespace**（创建命名空间）
3. 名称填 `SITE_DATA`，点 Add
4. 创建完成，记住这个名字（绑定时要填）

### 第三步：部署前端到 Cloudflare Pages

**方式 A：网页上传（最简单，推荐新手）**

1. 把本项目文件夹（`my-blog/` 整个目录）下载到本地
2. Dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
3. 项目名填 `my-blog`（任意，会决定你的免费域名 `my-blog.pages.dev`）
4. 把文件夹里**所有文件**拖进上传区（注意：是文件夹里的文件，不是文件夹本身）
5. 点 **Deploy**，等 1 分钟，部署完成会给你一个 `https://my-blog.pages.dev` 的地址

**方式 B：Wrangler 命令行（适合会用终端的同学）**

```bash
# 安装 wrangler（需要先装 Node.js）
npm install -g wrangler
wrangler login          # 浏览器里授权
wrangler kv namespace create SITE_DATA   # 创建 KV，把输出的 id 填到下一步
wrangler pages deploy .  # 部署当前目录
```

### 第四步：绑定 KV 数据库（关键！不绑定后台无法登录）

1. 进入刚创建的 Pages 项目 → **Settings** → **Functions**
2. 找到 **KV namespace bindings**，点 **Add binding**
3. 填写：
   - **Variable name**：`SITE_DATA`（必须叫这个名字，代码里写死的）
   - **KV namespace**：选第二步创建的 `SITE_DATA`
4. 点 **Save**，然后**重新部署一次**项目（部署列表里点 Retry，或重新上传文件）让绑定生效

### 第五步：设置管理员密码（强烈建议）

默认有一个内置密码，但**任何人下载源码都能看到**，极不安全。务必设置自己的密码：

1. Pages 项目 → **Settings** → **Functions** → **Variables**
2. 点 **Add variable**，Variable name 填 `ADMIN_PASSWORD`，Value 填你的强密码（至少 12 位，含字母数字符号）
3. 点 **Save**，重新部署生效
4. 访问 `https://你的域名/admin.html`，用刚设的密码登录

> ⚠️ **重要**：不设 `ADMIN_PASSWORD` 环境变量，后台用的是源码里的默认密码，等于不设防。务必按上一步设置。

### 第六步：开始添加内容

1. 登录后台 `/admin.html` →「站点设置」
2. 填写站点标题、昵称、简介、头像 emoji、页脚等，保存
3. 在「文章」tab 写第一篇文章，发布
4. 在「音乐」tab 添加歌曲直链
5. 在「时间线」tab 添加事件
6. 在「友链」tab 添加友情链接
7. 全部内容即时出现在前台对应页面

### 第七步（可选）：关联 GitHub 内容仓库

如果想让文章/相册/音乐/时间线**自动从 GitHub 仓库同步**（方便用 Git 管理内容、多人协作），按上文「GitHub 内容仓库该建什么」章节建好仓库，然后在后台「站点设置」开启自动同步并填入仓库地址。

### 部署后如何更新前端代码？

改了 `.html`/`.js` 文件后，**重新上传文件夹部署**即可（网页方式）或 `wrangler pages deploy .`（命令行）。Cloudflare Pages 会保留你的 KV 数据和环境变量，内容不会丢。

### 常见问题

| 问题 | 解决 |
|---|---|
| 后台登录提示密码错误，但我设了环境变量 | 检查 Variable name 是否正好是 `ADMIN_PASSWORD`；设置后必须**重新部署**才生效 |
| 后台能登录但保存数据后前台没变化 | 检查第四步的 KV 绑定 Variable name 是否为 `SITE_DATA`，且重新部署过 |
| 相册/文章不显示 GitHub 内容 | 检查后台仓库地址格式是 `用户名/仓库名`；公开仓库无需 Token；看「GitHub 同步」面板的错误提示 |
| 国内访问 GitHub 内容慢/失败 | 保持 `useCdn` 开启（默认）；Worker 侧有多源兜底，会自动切 jsDelivr/Statically |
| 访问页面白屏 | 打开浏览器控制台看报错；常见原因是文件没传全（确保 21 个文件都上传了） |

## 数据存储说明（KV 键）

| 键 | 内容 |
|----|------|
| `site` | 站点配置（标题、头像、简介、GitHub 仓库等） |
| `posts` | 文章数组 |
| `messages` | 留言数组 |
| `timeline` | 时间线记录 |
| `music` | 音乐播放列表 |
| `likes` | 点赞索引 `{ [postId]: number }`（首次访问自动合并历史 `like_<id>` 键） |
| `views` | 阅读量索引 `{ [postId]: number }` |
| `links` | 友情链接数组 |
| `gameScores` | 游戏排行榜 `{ [gameId]: Score[] }` |
| `comments_<postId>` | 文章评论 |
| `likeip_<postId>_<ip>` | 点赞去重（30 天） |
| `viewip_<postId>_<ip>` | 阅读去重（24 小时） |
| `*_rate_*` / `*_hour_*` | 频率限制计数 |
| `lock_<ip>` | 登录失败锁定记录 |
| `gh_*` | GitHub 内容缓存（目录列表 / 文件原文，TTL 7 天保证过期兜底存活） |
| `deleted_ids` | 删除墓碑 `{ posts: [...], music: [...], timeline: [...] }`——后台删除的仓库来源内容 id |
| `gh_status` | 最近一次 GitHub 拉取状态（成功/失败/命中源/是否在用过期缓存） |

**备份格式 v2**：`{ "version": 2, "exportedAt": "...", "data": { ...上述业务键, "deletedIds": {...} } }`，管理后台「数据备份」页可导出/导入，导入时会校验内容安全性（拒绝含恶意代码的数据）。`deletedIds`（删除墓碑）随备份一起导出/导入，恢复后「已删除的 GitHub 条目」保持隐藏。

## 本地开发与测试

项目不依赖任何构建步骤，直接用任意静态服务器 + Node 即可测试。测试套件（Mock KV + Playwright）位于项目外的测试目录，包含：

- **回归对比**：新旧 Worker 双跑 74 个用例，比对 HTTP 状态/响应体/KV 落库，确保重构零回归
- **端到端测试**：Playwright 31 项断言（页面渲染、交互、API 联动）
- **游戏测试**：76 项断言覆盖 5 款游戏（卡片/排行榜渲染回归、生命周期、键盘+触屏+虚拟方向键输入、画布绘制采样、计分与提交、重开不叠加计时器、切后台自动暂停、窄屏自适应、无 JS 错误）
- **音乐播放器测试**：12 项断言（播放器注入、坏链接过滤、XSS 转义、四档播放模式循环与持久化、静音切换、音量持久化、列表切歌、播放状态 aria、收起展开持久化、进度条拖动预览、键盘快捷键、游戏运行时键盘让位）
- **功能全流程**：排行榜提交、留言、后台登录、友链管理、备份导出
- **空态测试**：空数据库下各页面的空态/引导提示
- **CSP 合规**：全站 0 违规
- **XSS 防护**：7 项攻击断言全中和（留言/搜索/评论/游戏昵称路径 + 备份导入路径）
- **GitHub 双来源与鲁棒性**：35 项断言（合并展示、本地优先覆盖、删除墓碑与恢复、删除本地覆盖版后仓库版本不复现、多源故障转移、超时切换、过期缓存兜底、相册多镜像、音乐/时间线合并、备份含墓碑）
- **相册页多镜像兜底**：12 项断言（照片渲染、3 镜像 CDN 优先、jsDelivr 阻断后切换官方源、灯箱兜底、全失败占位、接口失败重试 UI）
- **限流与防爆破**：冷却、每小时上限、5 次失败锁定 15 分钟

## 游戏大厅架构

游戏区采用「框架 + 注册表」模式，新增一款游戏只需在 `games/` 目录加一个自注册文件，并在 `games.html` 中引入：

```
games.html ──► game-core.js（框架）
                 ├─ BaseGame      基类：生命周期 + 统一计时器（after/every/raf 全登记，
                 │                 pause/destroy 一次清干净，杜绝野回调与内存泄漏）
                 ├─ 输入适配层     bindKeys（避开输入框/防滚动）/ bindSwipe（阈值 24px）/
                 │                 buildDpad（虚拟方向键，长按连续移动）/ bindTap
                 ├─ 舞台控制       openGame / 开始 / 暂停 / 恢复 / 重开 / 覆盖层 / 计分板
                 ├─ 排行榜         loadRanks / renderRankTabs / submitScore（个人最佳 localStorage）
                 └─ 注册表         Map 保序（避免 "2048" 这类数字键乱序）+ meta 拍平
              └─► games/*.js（各游戏自注册，core 不关心具体游戏）
```

设计要点：

- **计时器统一登记**：所有 `setTimeout/setInterval/requestAnimationFrame` 都走框架方法，切游戏、暂停、重开时一次清干净——修复了原实现"重开后蛇速翻倍、扫雷秒表叠加"的计时器泄漏
- **输入缓冲**：贪吃蛇用转向缓冲队列，快速连按不掉头自杀、不丢输入
- **事件监听注册表**：`addEventListener` 统一登记，`destroy` 时全部解绑；不再劫持 `document.onkeydown`（原实现会被其他组件覆盖、且与音乐播放器快捷键冲突——播放器现通过 `GameCore.isGameRunning()` 避让）
- **高分屏适配**：`fitCanvas` 做 DPR 缩放，逻辑坐标仍是 CSS 像素；画布 `max-width:100%` 自适应窄屏
- **无 JS 错误**：所有游戏文件通过语法检查与 76 项浏览器断言

## 安全特性

- **XSS 防护**：服务端深度净化 + 前端转义（文本/属性双函数）+ Markdown URL 协议白名单（拒绝 `javascript:` 等伪协议，覆盖 GitHub 同步来的内容）+ CSP 四重防线；备份导入同样校验
- **URL 强校验**：后端用 `new URL()` 校验协议 + 拒绝含引号/空白/控制字符的 URL，杜绝属性突破型 XSS；友链/音乐/封面均生效
- **localStorage 安全化**：全站读写包 try/catch，隐私模式/存储被禁用的浏览器下不再中断页面脚本
- **认证**：Bearer 令牌 + 失败锁定（5 次失败锁 15 分钟，修复了原实现计数被清零导致锁定永不触发的缺陷）
- **限流**：留言 60 秒冷却/10 条每小时；评论 30 秒冷却/20 条每小时；点赞 3 秒冷却；游戏分数 10 秒冷却/30 次每小时
- **安全响应头**：CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy
- **边界校验**：所有输入的长度/格式/协议校验，先校验后写入；更新接口同样拒绝空值（与新建分支一致）

## 浏览器兼容

- Chrome / Edge / Firefox / Safari 近两年版本
- 响应式布局（手机 / 平板 / 桌面）
- 游戏支持键盘 + 触屏
