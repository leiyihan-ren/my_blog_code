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

### Worker 分层结构（`_worker.js`，约 2650 行）

```
 1. CONFIG       —— 全部可调参数（限流、长度、默认数据、GitHub 拉取策略、边缘缓存 TTL）
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
13. Entry       —— fetch 入口：API 分发 + 静态资源 + 边缘缓存层 + 统一错误处理
```

> **边缘缓存层（v2 新增）**：10 个公共 GET 接口（site/stats/posts/messages/music/timeline/links/game-scores/album-photos）按各自 TTL 走 Cloudflare Cache API，命中时 Worker 根本不执行、**KV 零读取**；带 `Authorization` 的请求与 POST 不缓存。写操作成功后 `ctx.waitUntil(purgeApiCache())` 失效对应缓存，数据改完即刻可见。静态资源：HTML `max-age=0, must-revalidate`（保证部署后立即可见），其余 `max-age=3600`（文件名无 hash，不用 immutable 避免手工更新后长期取旧文件）。

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
├── _worker.js            # 唯一后端入口：全部 API + 数据访问 + 安全校验 + 页面重写层
├── wrangler.toml         # Cloudflare 部署配置（KV 绑定说明）
├── sw.js                 # Service Worker（PWA 离线/缓存/版本更新）
├── manifest.json         # PWA 清单
├── pages/                # 页面（v7.0 下沉目录；对外 URL 仍是根级，由 _worker.js 重写）
│   ├── index.html        #   首页：Hero、统计、关于我、热门文章
│   ├── blog.html         #   文章列表 + 搜索
│   ├── post.html         #   文章详情：阅读量、点赞、评论、上一篇/下一篇
│   ├── album.html        #   相册（GitHub 图片源，经 /api/album/photos 多镜像加载）
│   ├── timeline.html     #   时间线
│   ├── guestbook.html    #   留言板
│   ├── games.html        #   游戏大厅（7 款游戏 + 全站排行榜）
│   ├── links.html        #   友情链接 + 申请面板
│   ├── admin.html        #   管理后台（内容/友链/游戏/备份）
│   └── drive.html        #   GitHub 极客云盘（分片上传/断点续传/重组下载）
├── components/           # UI 组件
│   ├── music-player.js   #   全站底部音乐播放器组件
│   ├── game-core.js      #   游戏公共框架：基类/输入适配/舞台控制/排行榜/注册表
│   └── games/            #   每款游戏一个文件，自注册到框架
│       ├── snake.js      #     贪吃蛇（三档速度、转向缓冲、虚拟方向键）
│       ├── breakout.js   #     打砖块（拖尾、碎裂粒子、3 条命）
│       ├── g2048.js      #     2048（新块/合并动画、触屏滑动）
│       ├── memory.js     #     记忆翻牌（3D 翻转、步数计分）
│       ├── mines.js      #     扫雷（首击安全、原地更新、长按插旗）
│       ├── reaction.js   #     闪电靶场（反应力连击）
│       └── hanoi.js      #     汉诺塔大师（最优步数挑战）
├── services/             # 网络请求与业务引擎
│   ├── request.js        #   全站统一请求层 BlogApi（超时/重试/错误归一）
│   └── uploadService.js  #   云盘上传/下载引擎：分片切割/断点续传/重试退避/并发队列
├── styles/               # 样式
│   ├── common.css        #   全站公共样式 + 设计变量（主题色/暗色模式）
│   └── drive.css         #   云盘页专属样式
├── utils/                # 工具与公共行为
│   ├── common.js         #   安全存储/主题切换/移动端菜单/滚动效果/SW 注册
│   └── blog-utils.js     #   BlogUtils 纯函数（HTML 转义/日期格式化/toast）
├── icons/                # PWA 与 favicon 图标
├── scripts/              # 构建与路由工具（不部署）
│   ├── build-pages.mjs   #   整站同步到 Pages 候选输出目录（dist/public/build）
│   └── route-map.mjs     #   页面路由唯一事实来源（_worker.js 重写表与之同步，step10 守护）
├── tests/                # 14 套件自动化测试（不部署）
└── docs/                 # 技术文档
    ├── 核心组件依赖拓扑.md        # 页面/脚本/Worker/KV/外部依赖全景 + 关键不变量
    ├── 播放器与游戏接口文档.md    # 播放器状态机 + GameCore API + 子游戏注册契约
    ├── 开发与避坑指南.md          # 压测与重构中真实踩过的坑 + 提交前检查单
    └── UI与无障碍优化清单.md      # 第二阶段 UI/a11y 整改记录（2.1-2.4）
```

> **v7.0 架构说明**：页面物理上在 `pages/`，但对外 URL 全部保持根级（`/drive.html` 不变）。
> `_worker.js` 的重写层把根级 URL 映射到 `pages/` 物理文件，旧书签、外链、SEO 收录、
> Service Worker 预缓存清单零破坏。页面内所有引用均为根绝对路径，与物理目录解耦。

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

项目不依赖任何构建步骤，直接用任意静态服务器 + Node 即可测试。

### v7.0 测试体系（`tests/` 目录，14 套件）

```bash
npm install                       # 安装 playwright（devDependency）
npm test                          # 全量回归：14 套件顺序执行，任一失败退出码非 0
```

| 套件 | 断言 | 覆盖 |
|------|------|------|
| `step1-pwa-verify.mjs` | 33 | SW 注册/预缓存、离线首页/游戏/音乐、**SW 版本控制全链路**、HTML 新鲜度、响应头 |
| `step2-music-dynamic.mjs` | 17 | GitHub 目录扫描歌单、同源代理、断网续播 |
| `step2-album-dynamic.mjs` | 64 | album.json 配置、分页、分类、灯箱键盘、无限滚动、断网 SWR、localStorage 兜底、镜像四级降级 |
| `step3-seo-csp.mjs` | 52 | 8 页 meta 完整、动态 SEO、JSON-LD、CSP 响应头 |
| `step3-ui-stress.mjs` | 27 | 连点/切后台/灯箱高频/destroy/播放器 spam/老游戏回归 |
| `step4-a11y-audit.mjs` | 165 | 9 页面 × 3 视口 × 明暗主题：溢出/alt/可访问名称/Tab 可达 |
| `step4-lightbox-trap.mjs` | 7 | 灯箱焦点移入/陷阱/Esc/归还 |
| `step5-common-verify.mjs` | 102 | 9 页面主题/移动菜单/滚动效果/零 JS 错误 |
| `step6-edge-cache.mjs` | 8 | 边缘缓存 TTL/写后清理/带 Authorization 不缓存 |
| `step7-drive-api.mjs` | 33 | 云盘 API：PIN 校验/列目录/上传/删除/路径穿越防御/8MB 阈值 |
| `step7-drive-ui.mjs` | 14 | 云盘页面端到端：PIN 模态/上传/下载/删除确认/导航 active |
| `step8-drive-chunked.mjs` | 36 | 大文件分片协议：断点续传/失败收集/409 自愈有界重试 |
| `step9-drive-chunked-ui.mjs` | 28 | 大文件端到端：32MB 七片/进度条/弱网重试/重组下载/删除锁 |
| `step10-routes-verify.mjs` | 23 | v7.0 守护：路由表同步/Worker 重写行为/243 处链接完整性/SW 注册路径/无相对引用 |

测试零硬编码路径：`tests/_helpers.mjs` 从 `import.meta.url` 推导仓库根目录并动态导入
`_worker.js`，Chromium 经 `CHROMIUM_PATH` 环境变量指定（不设则用 Playwright 自带浏览器）。
所有 mock 上游均为测试内自建，不访问外网。

CI：`.github/workflows/test.yml`，push/PR 自动跑 `npm test`。

### 历史测试脚本（v2.x 存档）

早期回归脚本（Mock KV 双跑对比、游戏 76 项、播放器 12 项、XSS 7 项、GitHub 双源 35 项等）
已被上表 v3.0 套件全覆盖，方法结论存档于 `docs/开发与避坑指南.md` 第五节。

## 游戏大厅架构

游戏区采用「框架 + 注册表」模式，新增一款游戏只需在 `components/games/` 目录加一个自注册文件，并在 `games.html` 中引入：

```
games.html ──► game-core.js（框架）
                 ├─ BaseGame      基类：生命周期 + 统一计时器（after/every/raf 全登记，
                 │                 pause/destroy 一次清干净，杜绝野回调与内存泄漏）
                 ├─ 输入适配层     bindKeys（避开输入框/防滚动）/ bindSwipe（阈值 24px）/
                 │                 buildDpad（虚拟方向键，长按连续移动）/ bindTap
                 ├─ 舞台控制       openGame / 开始 / 暂停 / 恢复 / 重开 / 覆盖层 / 计分板
                 ├─ 排行榜         loadRanks / renderRankTabs / submitScore（个人最佳 localStorage）
                 └─ 注册表         Map 保序（避免 "2048" 这类数字键乱序）+ meta 拍平
              └─► components/games/*.js（各游戏自注册，core 不关心具体游戏）
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

## 更新日志（v2 修订）

**Worker / 性能 / KV**
- 新增边缘缓存层：10 个公共 GET 接口按 TTL 走 Cloudflare Cache API，命中时 Worker 不执行、KV 零读取；写操作后 `waitUntil` 失效缓存
- 静态资源缓存头：HTML `max-age=0, must-revalidate`，其余 `max-age=3600`（不用 immutable，文件名无 hash）
- 修复合并视图 memo 串键：posts/music/timeline 的请求级缓存改用独立 `VIEW_KEY`，后台数据与合并视图不再互相污染

**Bug 修复**
- 贪吃蛇：吃满全屏通关时不再 do…while 死循环（空格收集法）；尾格跟随判定修正（不增长时排除尾格，避免贴尾误判撞尾）
- 打砖块：球从侧向击中挡板时垂直速度可能趋近 0 导致横向死循环——加最小分速比保底（双向）
- 2048：合并动画改为按真实合并位置标记（`mergedCells`），滑入更高值格子不再误播脉冲
- 扫雷：秒表改首击才启动（reset 不再开表），符合扫雷惯例
- 记忆翻牌：新增键盘操作（方向键移动焦点 + roving tabindex + Enter/空格翻牌）
- 音乐播放器：`playing` 事件清零连续失败计数（修复手动切歌成功后计数叠加误判"全部失败"）；失败自动切歌定时器可被手动切歌取消（不再连跳两首）；同步 `mediaSession.playbackState`；进度条允许拖到 0 秒；相册灯箱打开时让位键盘快捷键
- 游戏框架：`escapeAttr` 属性上下文转义（data-id 等）；虚拟方向键长按计时器登记到框架（destroy 后无幽灵操作）；个人纪录刷新后当前游戏卡片保持高亮
- 管理后台：登录口令改存 sessionStorage（旧 localStorage 一次性迁移，关闭标签页即失效）；6 处 `data-id` 改 `escapeAttr`；站点设置加载失败且从未成功加载时禁用保存按钮（防空表单覆盖真实配置）
- 首页：5 项统计栏允许换行 + 小屏收紧间距，修复窄屏横向溢出
- 文章页：Markdown 表格支持 GFM 管道表格（`.table-wrap` 横向滚动）；评论提交先判 `res.ok` 与 content-type 再解析 JSON

**安全**
- 文章页 Markdown 渲染：`img`/`a` 的 `src`/`href` 等属性位置全部改 `escapeAttr`（`escapeHtml` 不转义引号，属性上下文可被注入闭合）

**UI / 可访问性 / SEO**
- 对比度：`--text-mute` 亮色 #999→#6b7280（白底 4.6:1 达 WCAG AA），暗色 #6b7280→#9ca3af
- 暗色模式 FOUC：`<body>` 首行同步主题脚本，预设暗色首屏不再白闪
- 语义化：页脚 `div`→`<footer>`，主体内容包 `<main>`
- SEO：8 个公开页补 meta description + og/twitter 卡片标签 + 静态默认 title；管理后台 noindex
- 可访问性：全局 `:focus-visible` 焦点环、全局 `prefers-reduced-motion` 遵循、留言/评论输入 aria-label、toast 与相册提示 `role="status"` + `aria-live`

**回滚方案**：全部改动按四步分批提交（审查 → KV/缓存重构 → Bug 修复 → UI 美化），每批一个 commit。需回滚到修订前版本：`git reset --hard 63ba61b`（基线 commit）；只回滚 UI 美化：`git reset --hard 7433d78`。
