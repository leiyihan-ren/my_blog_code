# 系统架构说明（v22.0）

> **唯一事实来源**：逻辑域以 `src/architecture.mjs` 为准，物理路由以 `scripts/route-map.mjs` 与 `_worker.js` 的**双表**为准，二者由 `tests/step10-routes-verify.mjs` 强制校验一致。
> 本文件由 v22.0 通宵工程补齐，含最新 Mermaid 架构图。架构红线见文末。

---

## 1. 整体分层

```mermaid
flowchart TB
  subgraph Client["浏览器 · 14 页 MPA"]
    PAGES["pages/*.html<br/>物理文件直出 · 零 bundle"]
    GLOBALS["classic IIFE 全局契约<br/>window.* / UMD"]
    SW["sw.js<br/>离线外壳 · Cache-First / SWR"]
    WORKERJS["/utils/toolbox-worker.js<br/>classic Worker · importScripts"]
  end
  subgraph Edge["Cloudflare Pages · Advanced Mode"]
    ROUTE["_worker.js<br/>PAGE_REWRITES + API 聚合"]
    KV[("KV · SITE_DATA")]
    GH["GitHub 内容仓库<br/>文章 / 相册 / 音乐 / 时间线"]
  end
  subgraph Local["浏览器本地存储"]
    LS[("LocalStorage<br/>wb.telemetry.v1")]
    IDB[("IndexedDB<br/>drive_dl_parts / parts")]
  end
  PAGES --> GLOBALS
  PAGES --> SW
  GLOBALS --> WORKERJS
  SW -->|"缓存未命中"| ROUTE
  ROUTE --> KV
  ROUTE -->|"ETag 条件请求 / 指数退避"| GH
  LS --> PAGES
  IDB --> PAGES
```

**要点**：站点是纯静态 MPA，页面与资源均为磁盘上的物理文件；`_worker.js` 只做 URL 重写与后端 API 聚合，不参与 HTML 构建；Service Worker 承担离线与缓存策略，二者职责不重叠。

---

## 2. 逻辑架构（Feature-Based，11 个 UNITS / 7 个 FEATURES）

```mermaid
flowchart LR
  subgraph L1["bootstrap 启动层"]
    COMMON["utils/common.js<br/>全站初始化"]
  end
  subgraph L2["features 功能域"]
    TOOLS["tools"]
    BLOG["blog"]
    ALBUM["album"]
    PLAYER["player"]
    DRIVE["drive"]
    GAMES["games"]
    DASH["dashboard"]
  end
  subgraph L3["services / core"]
    SVC["services<br/>request / upload / ToolboxCompute"]
    CORE["core 纯函数层<br/>toolbox-pure / business rules"]
  end
  subgraph L4["shared 公共层"]
    SHARED["utils/*<br/>event-bus / render-scheduler / telemetry"]
  end
  TOOLS --> SVC
  BLOG --> SVC
  ALBUM --> SVC
  PLAYER --> SVC
  DRIVE --> SVC
  GAMES --> SVC
  DASH --> SHARED
  SVC --> CORE
  SVC --> SHARED
  COMMON --> SHARED
  COMMON -.->|"空闲加载埋点"| DASH
```

分层规则由 `scripts/arch-audit.mjs` 强制：**依赖方向单向（features → services → core → shared）**、零双向循环依赖、前端脚本 100% 有域归属、零 `console.log/debug/info`、零裸 `fetch`。当前审计 **7/7 通过**（43 个前端脚本 / 31 个全局导出）。

---

## 3. 路由双表与 14 页

```mermaid
flowchart LR
  REQ["请求 /xxx.html"] --> W["_worker.js<br/>PAGE_REWRITES"]
  W --> FILE["pages/xxx.html"]
  REQ2["测试/本地静态服务器"] --> R["scripts/route-map.mjs<br/>PAGE_FILES"]
  R --> FILE
  W -.->|"step10 双表一致性断言"| R
```

| 分类 | 页面 |
|---|---|
| 内容 | `index` `blog` `post` `album` `links` `timeline` `guestbook` |
| 应用 | `games` `player` `drive` `mc` `tools` |
| 后台 | `admin` `dashboard`（`noindex, nofollow`） |

---

## 4. 工具箱：异步计算链与 DOM 渲染拦截

```mermaid
sequenceDiagram
  participant U as 用户输入
  participant UI as modules/toolbox/*
  participant TC as ToolboxCompute（主线程调度）
  participant W as classic Worker
  participant RS as RenderScheduler
  participant DOM as DOM
  U->>UI: 输入（连续）
  UI->>TC: exec(cmd, payload, slot)
  Note over TC: 同 slot 新任务<br/>supersede() 取消在途旧任务
  TC->>W: postMessage
  W->>W: P.runRegex / P.diffLines<br/>regexSegments / diffLines
  W-->>TC: 结果
  TC-->>UI: 仅最新 slot 结果回写
  UI->>RS: mount(host, items, makeNode, key)
  alt items ≤ 160
    RS->>DOM: DocumentFragment 一次挂载
  else items > 160
    loop 每帧 8ms 预算
      RS->>DOM: rAF 分片 appendChild
    end
  end
```

- Worker 复用：`importScripts("/utils/toolbox-constants.js", "/utils/toolbox-pure.js")`，三端（页面 / Worker / Node VM）同一份纯函数内核。
- 超时熔断 `C.WORKER_TIMEOUT_MS`，Worker 不可用时降级主线程 `fallback`。
- 调度器缺失或 Worker 缺失时，`diff.js` / `regex.js` 回退等价 `DocumentFragment` 一次性挂载（混沌测试 S5 覆盖）。

---

## 5. Dashboard 数据流（纯本地、零网络）

```mermaid
flowchart TB
  PV["PV 按本地日期分桶"] --> LS[("LocalStorage<br/>wb.telemetry.v1")]
  TOOLUSE["[data-tool] 事件委托<br/>工具使用频率"] --> LS
  APICACHE["blogApiCache:*<br/>文件清单大小"] --> LS
  PARTS["下载分片"] --> IDB[("IndexedDB<br/>drive_dl_parts / parts")]
  LS --> TEL["utils/telemetry.js<br/>净化 / 自愈 / 超时熔断"]
  IDB --> TEL
  QUOTA["navigator.storage.estimate()"] --> TEL
  TEL -->|"snapshot()"| DASH["components/dashboard.js"]
  DASH --> CANVAS["Canvas 折线图 / 环形图"]
  DASH --> FALLBACK["纯 CSS 表格兜底<br/>（Canvas 不可用）"]
```

埋点层完全自包含（不读取 `common.js` 的全局），零网络请求、零第三方库、零 `console` 输出；脏 JSON 自愈、非数字计数过滤、路径白名单、工具 id 正则校验。

---

## 6. 构建与质量门禁

```mermaid
flowchart LR
  SRC["源码"] --> BP["build-pages.mjs<br/>同步 dist/public/build 三副本<br/>排除工程治理资产"]
  BP --> OPT["build-optimize.mjs<br/>esbuild transform 原地压缩<br/>不 bundle / 不改路径"]
  OPT --> REPORT[".v19-size-report.json<br/>−44.8%"]
  SRC --> SUB["subset-assets.mjs<br/>fontTools + Pillow"]
  SUB --> ASSETS["WOFF2 / WebP / AVIF 资产"]
  SRC --> GATE["lint / lint:css / audit:arch<br/>37 套件 run-all.mjs"]
  GATE --> LH["Lighthouse 严格串行<br/>四场景 100 分"]
```

---

## 7. 红线契约（不可破坏）

| 红线 | 原因 |
|---|---|
| MPA 物理文件直出，**禁止 bundle / 禁止物理迁移 `src/pages`** | classic `window.*` 全局契约、CSP nonce、Worker `importScripts` 三端复用 |
| 路由双表同步 | `step10` 硬断言，不同步会 404 |
| `CACHE_VERSION` 与 `toolbox-constants.js VERSION` 同版本 | `step1` / `step27` 版本三方对齐断言 |
| `/og-image.png` 保持 200 + `image/png` | `step3-seo-csp` 硬断言；WebP/AVIF 只能作副本 |
| 所有页面 head 契约（Critical CSS / EventBus=1 / noscript 配对 / prefetch 数量） | `step29 A7` / `step30 A2` 遍历 14 页校验 |
| Lighthouse 与 Playwright 禁止并行 | 避免 CPU 争抢造成伪负优化 |
| 禁止 force push | 远程历史为共享分支 |

> 部署形态现状与收敛建议见《部署形态收敛方案.md》；最新交付数据见《网页线·通宵工程战报.md》。
