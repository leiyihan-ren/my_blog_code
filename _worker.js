// ============================================================
// my-blog · Cloudflare Pages Worker（统一 API 入口）
// ------------------------------------------------------------
// 分层结构（自上而下依赖，禁止反向引用）：
//   1.  CONFIG     全局配置常量
//   2.  UTILS      无副作用的纯工具函数
//   3.  VALIDATORS 入参校验
//   4.  SANITIZE   内容安全（XSS 净化）
//   5.  HTTP       响应构造
//   6.  KEYS       KV 键名统一管理
//   7.  Store      KV 数据访问层（请求级缓存 / 分页 / 兜底写入）
//   8.  GitHub     远程数据源
//   9.  Repo       领域数据仓储
//  10.  Services   登录、限流等公共业务
//  11.  Handlers   接口处理函数
//  12.  ROUTES     表驱动路由
//  13.  Entry      Worker 入口
// ============================================================

// ============================================================
// 1. CONFIG —— 全局配置常量
// ============================================================
const CONFIG = {
  // 安全通则：本仓库是公开仓库，任何凭据一律不得硬编码于此。
  // ADMIN_PASSWORD / DRIVE_PIN / GITHUB_TOKEN 必须经 Cloudflare Pages
  // 环境变量（Secret）注入；缺失即拒绝服务（500），绝不回退到默认值。
  admin: {
    maxAttempts: 5,
    lockSeconds: 900,
    maxTokenLength: 200,
  },
  drive: {
    // 云盘（文件管理器）写操作口令：前端 prompt 输入后经 x-drive-pin 请求头携带。
    // 生产环境必须在 CF Pages 配置 Secret DRIVE_PIN；未配置时云盘写操作一律 500。
    // 云盘文件存放的 GitHub 仓库与目录（与相册/文章同源的数据仓）
    repo: "leiyihan-ren/Blog",
    branch: "main",
    dir: "drive",
    // ===== v6.0 大文件架构（分片模式）=====
    // 小文件直传上限：≤ 此值走 Contents API 单次 PUT（Base64 膨胀 33% 后约
    // 10.7MB，远低于 GitHub 100MB 绝对上限与 CF body 限制）。超过此值进入
    // 分片模式：前端 File.slice(5MB) → Worker 透传 → GitHub Blobs/Contents
    // 逐片落库，浏览器端重组下载。GitHub 无「多 blob 拼接单文件」API，
    // 故分片在仓库里就是 N 个独立 part 文件 + 1 个 manifest，下载时前端重组。
    maxFileBytes: 8 * 1024 * 1024,
    // 小文件直传的 body 上限：8MB → 约 10.7MB Base64，留至 16MB
    maxBodyBytes: 16 * 1024 * 1024,
    // 分片大小（字节）：5MB。Base64 后 6.7MB body，任何网络/平台限制下都稳妥；
    // 分片数 = 文件大小 / 5MB，GitHub 配额 5000 次/小时下单文件可传约 24GB
    chunkSize: 5 * 1024 * 1024,
    // 分片模式的单文件产品级上限：2GB。
    // 约束来源：GitHub 仓库软限制（官方建议单仓 <5GB，超 50MB 单文件仅 git push
    // 会警告，Contents/Blobs API 不受此限）；Git Data API blob 上限 100MB
    // （分片 5MB 远低于）；GitHub API 配额 5000 次/小时（2GB=410 片，可控）。
    maxChunkedFileBytes: 2 * 1024 * 1024 * 1024,
    // 分片上传的 body 上限：5MB → 6.7MB Base64 + JSON 外壳，留至 8.5MB
    maxPartBodyBytes: 8.5 * 1024 * 1024,
    // 写操作超时（毫秒）：读路径的 8s 不够上传大文件，单独放宽
    writeTimeoutMs: 30000,
    // 目录列表的 isolate 内缓存（毫秒）：列表含每文件一次 commits 查询（N+1），
    // 30s 内的重复刷新直接复用，压低 GitHub 配额消耗
    listCacheMs: 30000,
  },
  request: {
    maxBodyBytes: 100 * 1024,
  },
  github: {
    // 内容新鲜期：超过后仍会返回旧缓存（stale），同时后台尝试刷新
    cacheTtlSeconds: 300,
    // 旧缓存兜底存活期：GitHub 长时间不可达时，凭过期缓存继续展示内容
    staleTtlSeconds: 7 * 86400,
    // 单个源请求超时（毫秒）
    // v8.1 性能攻坚：线上实测 Worker→GitHub 单请求偶发 1.4~1.8s、最坏拖到 8s
    // 才放弃，整页被一个上游拖死。锁死 3000ms + 重试 2 次 + 换源，最坏 9s 内
    // 必降级到 CDN 源；正常路径则是「3000ms 内拿不到就换源」，用户感知可控。
    timeoutMs: 3000,
    // 单个源内的重试次数（仅网络错误/超时/5xx 时重试）
    retriesPerSource: 2,
    userAgent: "blog-auto-mode",
    // 配额储备：X-RateLimit-Remaining 低于该值时暂停调用 api.github.com，
    // 降级到 CDN 源（jsDelivr/raw/statically 有独立配额），保住目录列表能力
    quotaReserve: 10,
    // 同源图片代理（/api/github/raw/*）的边缘缓存 TTL（秒）：图片不可变，缓存 1 天
    imageCacheTtlSeconds: 86400,
  },
  rate: {
    messageCooldownSeconds: 60,
    messagePerHour: 10,
    commentCooldownSeconds: 30,
    commentPerHour: 20,
    likeCooldownSeconds: 3,
    likeIpTtlSeconds: 86400 * 30,
    viewIpTtlSeconds: 86400,
  },
  // ===== P0 修复（2026-10）：文章发布/删除并发防护 =====
  // 背景：连点「发布」曾导致重复发文；快速连删曾因读-改-写竞态「删不掉」。
  // 前端发布锁（isPublishing）是第一道防线，以下为后端第二道防线。
  posts: {
    // 重复发布拦截窗口（秒）：同标题+同内容的「新建」请求在该窗口内直接 409 拦截，
    // 绝不盲目创建第二篇。KV expirationTtl 下限 60s，故窗口最小 60s。
    dedupeWindowSeconds: 60,
    // 删除写后校验重试次数：删除写入 KV 后直读校验，未生效则拉取最新数据重试。
    // KV 无 CAS，这是 GitHub Contents 409 自愈在 KV 层的对应实现。
    deleteVerifyRetries: 2,
  },
  limit: {
    id: 100,
    ip: 50,
    nickname: 20,
    text: 500,
    comment: 500,
    search: 100,
    postTitle: 200,
    postContent: 50000,
    postDesc: 500,
    timelineTitle: 100,
    timelineDesc: 500,
    musicTitle: 200,
    musicArtist: 100,
    maxConsecutiveNewlines: 5,
    kvListPageSize: 1000,
    popularMax: 20,
    linkName: 30,
    linkDesc: 100,
    gameName: 12,
    gameScore: 999999999,
    leaderboard: 20,
    scoreCooldownSeconds: 10,
    scorePerHour: 30,
  },
  defaults: {
    popularLimit: 5,
  },
  /** 允许上报成绩的游戏（防止脏数据写入） */
  games: ["snake", "breakout", "2048", "memory", "mines", "reaction", "hanoi"],
};

/**
 * 公共只读接口的边缘缓存 TTL（秒）。
 * 这些接口是 KV 读取的主要来源：命中 Cloudflare 边缘缓存时 Worker 根本不会
 * 被调用，KV 读取量随之下降一个数量级。
 *
 * 设计约束：
 *   - 只缓存 GET 且不需要管理权限的接口（写接口 Cloudflare 本就不会缓存）；
 *   - 携带 Authorization 的请求一律不缓存（cache.delete 由写操作负责，见 entry）；
 *   - like/view/comments 等涉及计数与 IP 去重的接口不在此列，避免计数失真；
 *   - 管理端写操作成功后会清空本表中的全部键，数据实时性不受影响。
 */
const API_CACHE_TTL = {
  "/api/site": 300,
  "/api/stats": 60,
  "/api/popular": 300,
  "/api/posts": 120,
  "/api/messages": 30,
  "/api/music": 300,
  "/api/timeline": 300,
  "/api/links": 300,
  "/api/game/scores": 60,
  "/api/album/photos": 300,
};

/** 合并视图在请求级 memo 中的键（与本地视图的 KEYS.posts 区分，避免互相覆盖） */
const VIEW_KEY = {
  posts: "view:posts",
  music: "view:music",
  timeline: "view:timeline",
};

// ============================================================
// 2. UTILS —— 通用工具函数
// ============================================================
function getIP(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Real-IP") ||
    "unknown"
  );
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback === undefined ? null : fallback;
  }
}

function safeParseInt(val, fallback) {
  const n = parseInt(val, 10);
  if (isNaN(n) || !isFinite(n)) return fallback === undefined ? 0 : fallback;
  return n;
}

function isValidUrl(url) {
  if (typeof url !== "string" || !url) return false;
  // 前缀粗筛 + URL 构造器强校验：拒绝 javascript: 等伪协议，
  // 以及含引号/空白的 URL（防止突破 HTML 属性上下文造成 XSS）
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  } catch (e) {
    return false;
  }
  return !/["'<>\s\\]/.test(url);
}

function truncate(str, maxLen) {
  if (!str) return str;
  return String(str).slice(0, maxLen);
}

/** 稳定字符串哈希，用于生成 ETag */
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/** 生成安全的唯一 ID：<前缀><时间戳36进制>_<随机串> */
function genId(prefix) {
  const safePrefix = String(prefix || "").replace(/[^a-zA-Z0-9_]/g, "");
  const timePart = Date.now().toString(36);
  let randPart = "";
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      for (const b of bytes) randPart += b.toString(36).padStart(2, "0");
    } else {
      randPart =
        Math.random().toString(36).slice(2, 8) +
        Math.random().toString(36).slice(2, 8) +
        (typeof performance !== "undefined"
          ? performance.now().toString(36).replace(/\./g, "")
          : "");
    }
  } catch (e) {
    randPart =
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 6);
  }
  randPart = randPart.replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (randPart.length < 6) {
    randPart += Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "");
  }
  return safePrefix + timePart + "_" + randPart;
}

/** 去除敏感字段（IP 不下发前端） */
function stripIp(list) {
  return list.map(({ ip, ...rest }) => rest);
}

/** 按日期倒序排序，非法日期排最后；返回新数组，不修改入参 */
function sortByDateDesc(list) {
  return [...list].sort((a, b) => {
    const da = new Date(a && a.date).getTime();
    const db = new Date(b && b.date).getTime();
    if (isNaN(da) && isNaN(db)) return 0;
    if (isNaN(da)) return 1;
    if (isNaN(db)) return -1;
    return db - da;
  });
}

/** 读取 JSON 请求体，带大小限制，防止超大请求体占用内存 */
async function readJson(request) {
  try {
    const contentLength = request.headers.get("Content-Length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > CONFIG.request.maxBodyBytes) return null;
    }
    const text = await request.text();
    if (text.length > CONFIG.request.maxBodyBytes) return null;
    return safeJsonParse(text);
  } catch (e) {
    return null;
  }
}

// ============================================================
// 3. VALIDATORS —— 入参校验
// ============================================================
function validateGithubRepo(repo) {
  if (!repo) return true;
  if (typeof repo !== "string") return false;
  if (repo.includes("..")) return false;
  if (/^\./.test(repo) || /\.$/.test(repo)) return false;
  if (/%[0-9a-fA-F]{2}/.test(repo)) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repo)) return false;
  if (repo.length > 200) return false;
  const parts = repo.split("/");
  if (parts[0].length > 39 || parts[1].length > 100) return false;
  return true;
}

function validateGithubBranch(branch) {
  if (!branch) return true;
  if (typeof branch !== "string") return false;
  if (branch.includes("..")) return false;
  if (/^\./.test(branch) || /\.$/.test(branch)) return false;
  if (/%[0-9a-fA-F]{2}/.test(branch)) return false;
  if (/[\s\x00-\x1f\x7f]/.test(branch)) return false;
  if (/^\//.test(branch) || /\/$/.test(branch) || /\/\//.test(branch)) return false;
  if (!/^[a-zA-Z0-9_./-]+$/.test(branch)) return false;
  if (branch.length > 100) return false;
  return true;
}

function validatePath(path) {
  if (!path) return true;
  if (typeof path !== "string") return false;
  if (/%[0-9a-fA-F]{2}/.test(path)) return false;
  if (path.includes("..")) return false;
  if (path.includes("\0")) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  if (/(^|\/)\./.test(path)) return false;
  if (/[\s\x00-\x1f\x7f]/.test(path)) return false;
  if (/\/\//.test(path)) return false;
  return /^[a-zA-Z0-9_./-]+$/.test(path) && path.length <= 200;
}

function validateFileName(name) {
  if (!name) return true;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  return /^[a-zA-Z0-9_.-]+$/.test(name) && name.length <= 100;
}

function validateId(id) {
  if (!id) return false;
  if (id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  return /^[a-zA-Z0-9_.-]+$/.test(id) && id.length <= CONFIG.limit.id;
}

function validateEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

function validateSearchQuery(q) {
  if (q == null) return true;
  if (typeof q !== "string") return false;
  if (q.length === 0) return true;
  if (q.length > CONFIG.limit.search) return false;
  if (/[\x00-\x1f\x7f]/.test(q)) return false;
  if (/<\s*[a-zA-Z]/.test(q)) return false;
  if (/javascript\s*:/i.test(q)) return false;
  return true;
}

function validateNickname(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.length > CONFIG.limit.nickname) return false;
  if (!/[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed)) return false;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  return true;
}

function validateRichText(content) {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.length > CONFIG.limit.text) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) return false;
  const maliciousPatterns = [
    /<\s*script[\s>]/i,
    /<\s*\/\s*script\s*>/i,
    /<\s*iframe[\s>]/i,
    /<\s*svg[\s>]/i,
    /<\s*img[^>]*on\w+\s*=/i,
    /javascript\s*:/i,
    /<[^>]*\son\w+\s*=/i,
    /<\s*a[^>]*href\s*=\s*["']?\s*javascript:/i,
    /<\s*form[\s>]/i,
    /<\s*embed[\s>]/i,
    /<\s*object[\s>]/i,
    /data\s*:\s*text\/html/i,
    /<\s*meta[\s>]/i,
    /<\s*link[\s>]/i,
    /<\s*style[\s>]/i,
  ];
  for (const pattern of maliciousPatterns) {
    if (pattern.test(trimmed)) return false;
  }
  const newlineRegex = new RegExp(
    `\\n{${CONFIG.limit.maxConsecutiveNewlines + 1},}`
  );
  if (newlineRegex.test(trimmed)) return false;
  return true;
}

// ============================================================
// 4. SANITIZE —— 内容安全
// ============================================================
/** KV Key 安全防护：仅保留安全字符并截断长度 */
function safeKvKey(key, maxLen) {
  if (key == null) return "";
  const max = maxLen || 500;
  return String(key)
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, max);
}

/**
 * 对用户提交的 Markdown 内容做深度 XSS 检测。
 * @returns {string|null} 安全内容；检测到危险内容时返回 null
 */
function sanitizeUserContent(content) {
  if (typeof content !== "string") return null;
  const text = content;

  // 第一轮：解码常见 HTML 实体后检测，防止编码绕过
  const decoded = text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/gi, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

  const dangerousTags = [
    /<\s*script[\s>\/]/i, /<\s*\/\s*script\s*>/i, /<\s*iframe[\s>\/]/i,
    /<\s*svg[\s>\/]/i, /<\s*img[\s>\/]/i, /<\s*video[\s>\/]/i,
    /<\s*audio[\s>\/]/i, /<\s*embed[\s>\/]/i, /<\s*object[\s>\/]/i,
    /<\s*applet[\s>\/]/i, /<\s*base[\s>\/]/i, /<\s*meta[\s>\/]/i,
    /<\s*link[\s>\/]/i, /<\s*style[\s>\/]/i, /<\s*form[\s>\/]/i,
    /<\s*input[\s>\/]/i, /<\s*button[\s>\/]/i, /<\s*textarea[\s>\/]/i,
    /<\s*select[\s>\/]/i, /<\s*option[\s>\/]/i, /<\s*body[\s>\/]/i,
    /<\s*html[\s>\/]/i, /<\s*frameset[\s>\/]/i, /<\s*frame[\s>\/]/i,
    /<\s*xss[\s>\/]/i, /<\s*details[\s>\/]/i, /<\s*marquee[\s>\/]/i,
    /<\s*isindex[\s>\/]/i,
  ];
  for (const tag of dangerousTags) {
    if (tag.test(decoded)) return null;
  }

  // <a> 标签中的危险 href
  if (/<\s*a[\s>]/i.test(decoded)) {
    if (/href\s*=\s*["']?\s*(javascript|vbscript|data):/i.test(decoded)) return null;
  }

  // 任意标签上的事件处理器
  if (/<[^>]*\son\w+\s*=/i.test(decoded)) return null;

  // 第二轮：危险协议（含混淆变体，如 jAvAsCrIpT:）
  const stripCtrl = (s) => s.replace(/[\x00-\x1f\x7f]/g, "");
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(stripCtrl(text))) return null;
  if (/v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(stripCtrl(text))) return null;
  if (/d\s*a\s*t\s*a\s*:\s*t\s*e\s*x\s*t\s*\/\s*h\s*t\s*m\s*l/i.test(stripCtrl(text))) return null;

  // 第三轮：CSS expression()
  if (/expression\s*\(/i.test(text)) return null;

  // 第四轮：Markdown 链接/图片语法中注入的危险协议
  const mdLinkPattern = /!?\[[^\]]*\]\(\s*([^)]+)\s*\)/g;
  let match;
  while ((match = mdLinkPattern.exec(text)) !== null) {
    const url = match[1].trim().toLowerCase();
    if (
      url.startsWith("http://") || url.startsWith("https://") ||
      url.startsWith("/") || url.startsWith("#") || url.startsWith("mailto:")
    ) continue;
    if (/^(javascript|vbscript|data):/i.test(url.replace(/\s/g, ""))) return null;
  }

  // 第五轮：HTML 实体编码的事件处理器绕过
  if (/&#(?:111|x6f|x4f|79|x4f)[\s;]*n\w+\s*=/i.test(text)) return null;

  // 第六轮：允许 Markdown 语法，但不允许裸 HTML 标签
  if (/<\s*\/\s*[a-zA-Z][a-zA-Z0-9-]*\s*>/.test(text)) return null;
  if (/<\s*[a-zA-Z][a-zA-Z0-9-]*(\s+[^>]*|\s*\/?\s*)>/.test(text)) return null;

  return text;
}

// ============================================================
// 5. HTTP —— 响应构造
// ============================================================
const CSP_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data: https:; media-src https: data:; " +
  "connect-src 'self' https://static.cloudflareinsights.com https://cloudflareinsights.com; " +
  // worker-src 必须放行 'self'：否则浏览器会以 CSP 为由拒绝注册 sw.js（PWA 直接失效）。
  // sw.js 为同源静态文件，不引入任何外部脚本，放行同源是安全的。
  "frame-src 'none'; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; worker-src 'self'; " +
  // frame-ancestors 'none'：禁止任何站点以 iframe 嵌入本站（防点击劫持），
  // 与 X-Frame-Options: DENY 形成新旧双保险（CSP 头途经才生效，静态直连走 XFO）。
  // manifest-src 'self'：PWA manifest 仅限同源。
  // upgrade-insecure-requests：http 子资源自动升级 https（本地 localhost 豁免，生产全站 https）。
  "frame-ancestors 'none'; manifest-src 'self'; upgrade-insecure-requests";

/** 业务异常：抛出后由入口统一转成错误响应 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** 抛出一个业务异常（默认 400） */
function fail(message, status) {
  throw new HttpError(status || 400, message);
}

function buildHeaders(extra) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CSP_POLICY,
  };
  if (extra) Object.assign(headers, extra);
  return headers;
}

function ok(data, extraHeaders) {
  return new Response(JSON.stringify(data), { headers: buildHeaders(extraHeaders) });
}

function err(message, status, extraHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status: status || 400,
    headers: buildHeaders(extraHeaders),
  });
}

/** 带 ETag 的 JSON 响应：内容未变化时返回 304 */
function jsonEtagResponse(request, data) {
  const body = JSON.stringify(data);
  const etag = '"' + simpleHash(body) + '"';
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: buildHeaders({ ETag: etag }) });
  }
  return new Response(body, { headers: buildHeaders({ ETag: etag }) });
}

/**
 * 静态资源缓存策略。
 * HTML 一律 `max-age=0, must-revalidate`：内容随时会变，靠 ETag 协商缓存，
 * 保证后台改完文章后刷新即可见，同时不丢 304 的带宽优势。
 * JS/CSS/图片等用 1 小时短缓存：本项目文件名无 hash 后缀，缓存窗口必须可控，
 * 否则手工上传新版本后浏览器会长期拿旧文件。
 */
function staticCacheControl(pathname) {
  const p = pathname || "/";
  // PWA 关键文件禁止任何缓存：
  // sw.js 被 HTTP 缓存旧版本 → 浏览器发现不了新 SW，用户永远看旧页面；
  // manifest.json 影响安装元数据（名称/图标/主题色），也保持实时。
  if (p === "/sw.js" || p === "/manifest.json") {
    return "public, max-age=0, must-revalidate";
  }
  // HTML：浏览器每次校验（保证发版即时可见），但**边缘缓存 5 分钟 + SWR**。
  // 实测线上 TTFB 500~800ms 全部耗在每次回源校验上，s-maxage 让边缘直接命中。
  if (p === "/" || p.endsWith("/") || p.endsWith(".html")) {
    return "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";
  }
  // CSS/JS：内容随版本变化但一小时内稳定；边缘 1 天 + SWR 7 天
  if (/\.(css|js|mjs)$/i.test(p)) {
    return "public, max-age=600, s-maxage=86400, stale-while-revalidate=604800";
  }
  // 图片/字体/媒体：内容基本不可变，可长缓存
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|mp4)$/i.test(p)) {
    return "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000";
  }
  return "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";
}

// ============================================================
// 静态页面重写层（v7.0 目录重构）
// ------------------------------------------------------------
// 源码下沉 pages/ 后，对外 URL 仍保持根级干净路径：
//   /drive.html → /pages/drive.html
// 旧书签、外链、SW 预缓存清单、SEO 收录全部零破坏。
// 查询串原样保留（post.html?id=xxx 正常可用）。
// ⚠️ 本表与 scripts/route-map.mjs 是同一份事实的两处拷贝，
//    tests/step10-routes-verify.mjs 有同步断言，改动必须两边同步。
// ============================================================
const PAGE_REWRITES = {
  "/": "/pages/index.html",
  "/index.html": "/pages/index.html",
  "/admin.html": "/pages/admin.html",
  "/album.html": "/pages/album.html",
  "/blog.html": "/pages/blog.html",
  "/drive.html": "/pages/drive.html",
  "/games.html": "/pages/games.html",
  "/guestbook.html": "/pages/guestbook.html",
  "/links.html": "/pages/links.html",
  "/post.html": "/pages/post.html",
  "/timeline.html": "/pages/timeline.html",
};

/** 为静态资源响应附加安全响应头 */
function addStaticSecurityHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // 仅 HTML 页面加 CSP（含 media-src 以支持外链音频）
  if ((headers.get("Content-Type") || "").includes("text/html")) {
    headers.set("Content-Security-Policy", CSP_POLICY);
  }
  // v8.1 性能攻坚（实测取证）：
  // Pages 上游默认给静态资源 `no-store` / `max-age=0, must-revalidate`，
  // 原逻辑「上游有缓存头就不覆盖」导致 11~12 个 CSS/JS/图片**每次全部回源**，
  // 浏览器侧实测边缘缓存命中 0/12，TTFB 长期 500~800ms。
  // 静态资源内容随版本变化、路径固定，一律强制覆盖为长缓存；发版即时性
  // 由 HTML（s-maxage=300）与 SW 版本号共同保证，不依赖资源文件本身。
  // 304 响应无 body 也无缓存语义，跳过。
  if (response.status !== 304) {
    headers.set("Cache-Control", staticCacheControl(pathname || "/"));
  }
  // 304 响应无 body，需传 null
  const body = response.status === 304 ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================
// 6. KEYS —— KV 键名统一管理
// ============================================================
const KEYS = {
  site: "site",
  posts: "posts",
  messages: "messages",
  timeline: "timeline",
  music: "music",
  likes: "likes", // 点赞总数索引：{ [postId]: number }
  views: "views", // 阅读量索引：{ [postId]: number }
  links: "links", // 友情链接：Link[]
  gameScores: "gameScores", // 游戏排行榜：{ [gameId]: Score[] }
  legacyLike: (id) => `like_${safeKvKey(id, CONFIG.limit.id)}`,
  // P0 防重指纹：文章「新建」时按 标题+内容 哈希写入（TTL 窗口），
  // 窗口期内同内容的重复发布直接被拦截（409），杜绝连点产生重复文章
  postDedupe: (fp) => `post_dedupe_${fp}`,
  likeIp: (postId, ip) =>
    `likeip_${safeKvKey(postId, CONFIG.limit.id)}_${safeKvKey(ip, CONFIG.limit.ip)}`,
  likeRate: (ip) => `likerate_${safeKvKey(ip, CONFIG.limit.ip)}`,
  viewIp: (postId, ip) =>
    `viewip_${safeKvKey(postId, CONFIG.limit.id)}_${safeKvKey(ip, CONFIG.limit.ip)}`,
  comments: (postId) => `comments_${safeKvKey(postId, CONFIG.limit.id)}`,
  lock: (ip) => `lock_${safeKvKey(ip, CONFIG.limit.ip)}`,
  msgCooldown: (ip) => `msg_rate_${safeKvKey(ip, CONFIG.limit.ip)}`,
  msgHour: (ip) => `msg_hour_${safeKvKey(ip, CONFIG.limit.ip)}`,
  commentCooldown: (ip, postId) =>
    `comment_rate_${safeKvKey(ip, CONFIG.limit.ip)}_${safeKvKey(postId, CONFIG.limit.id)}`,
  commentHour: (ip, postId) =>
    `comment_hour_${safeKvKey(ip, CONFIG.limit.ip)}_${safeKvKey(postId, CONFIG.limit.id)}`,
  ghCache: (type, repo, branch, path, useCdn) =>
    `gh_${safeKvKey(type, 20)}_${safeKvKey(repo, 200)}_${safeKvKey(branch, 100)}_${safeKvKey(path, 200)}_${useCdn ? "cdn" : "raw"}`,
  // 双来源合并时的「本地删除墓碑」：{ posts: [...], music: [...], timeline: [...] }
  // 后台删除了 GitHub 来源的条目时，把 id 记入这里，合并视图据此隐藏
  deletedIds: "deleted_ids",
  // GitHub 最近一次拉取状态（供管理后台排查连接问题）
  ghStatus: "gh_status",
  prefix: {
    github: "gh_",
    legacyLike: "like_",
    comments: "comments_",
  },
};

// ============================================================
// 7. Store —— KV 数据访问层
// ------------------------------------------------------------
// 职责：请求级缓存（读穿）、分页遍历、写入即更新缓存（读己所写）、
//       非关键写入通过 ctx.waitUntil 兜底，避免 Worker 提前结束导致丢失。
// ============================================================
class Store {
  constructor(env, ctx) {
    const kv = env && env.SITE_DATA;
    if (!kv) {
      throw new HttpError(500, "未绑定 KV 命名空间 SITE_DATA，请在 Pages 设置中配置");
    }
    this.kv = kv;
    this.ctx = ctx;
    this.rawMemo = new Map();
    this.jsonMemo = new Map();
  }

  async getRaw(key) {
    if (this.rawMemo.has(key)) return this.rawMemo.get(key);
    const value = await this.kv.get(key);
    this.rawMemo.set(key, value);
    return value;
  }

  /**
   * 直读 KV 最新值（绕过请求级 memo）。
   * 用途：写后校验——kv.put 后 memo 里存的是「我方写入值」，
   * 只有直读才能验证写入是否已被 KV 真正接受（最终一致性兜底）。
   * 读到的值会回填 memo，保持「读己所写」语义不变。
   */
  async getFreshRaw(key) {
    const value = await this.kv.get(key);
    this.rawMemo.set(key, value);
    return value;
  }

  async getJson(key, fallback) {
    if (this.jsonMemo.has(key)) {
      const cached = this.jsonMemo.get(key);
      return cached == null ? fallback : cached;
    }
    const raw = await this.kv.get(key);
    const parsed = raw == null ? null : safeJsonParse(raw, null);
    this.jsonMemo.set(key, parsed);
    return parsed == null ? fallback : parsed;
  }

  async putRaw(key, value, options) {
    this.rawMemo.set(key, value);
    await this.kv.put(key, value, options);
  }

  async putJson(key, value, options) {
    this.jsonMemo.set(key, value);
    await this.kv.put(key, JSON.stringify(value), options);
  }

  async delete(key) {
    this.rawMemo.delete(key);
    this.jsonMemo.delete(key);
    await this.kv.delete(key);
  }

  /** 分页遍历指定前缀的全部键（KV list 单页上限 1000） */
  async list(prefix) {
    const keys = [];
    let cursor;
    do {
      const page = await this.kv.list({
        prefix,
        limit: CONFIG.limit.kvListPageSize,
        ...(cursor ? { cursor } : {}),
      });
      keys.push(...((page && page.keys) || []));
      cursor = page && page.list_complete === false ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  async deletePrefix(prefix) {
    try {
      const keys = await this.list(prefix);
      if (keys.length === 0) return 0;
      await Promise.all(keys.map((k) => this.kv.delete(k.name)));
      return keys.length;
    } catch (e) {
      console.warn("删除 KV 前缀失败:", prefix, e);
      return 0;
    }
  }

  /** 非关键写入：交给 ctx.waitUntil 兜底，失败静默 */
  defer(promise) {
    const guarded = Promise.resolve(promise).catch(() => {});
    if (this.ctx && typeof this.ctx.waitUntil === "function") {
      this.ctx.waitUntil(guarded);
    }
    return guarded;
  }
}

// ============================================================
// 7.5 KV 写串行化锁（读-改-写竞态防护）
// ------------------------------------------------------------
// 背景：Cloudflare KV 没有 CAS/事务，且为最终一致性。对同一 key 并发执行
// 「读取→修改→整体写回」（如文章的增/删）会互相覆盖：丢更新、或让
// 已删除的条目因旧读回写而「复活」——线上表现为重复发文、删不干净。
// 思路与网盘分片 409 自愈一致：先把同一 isolate 内的写操作串成一条链，
// 彻底杜绝交错；跨 isolate 的残余窗口由调用方的「写后校验 + 有限重试」兜底。
// 单 isolate 内 Worker 运行时单线程，await 交错是唯一竞态来源，故进程内
// promise 链即可提供完整互斥，无需外部锁服务。
// ============================================================
const kvWriteChains = new Map();

/**
 * 把 fn 的串行执行链挂到 key 上：同一 key 的任务严格 FIFO，绝不交错。
 * 前一个任务失败不阻塞后一个（rejection 被吞掉继续传）。
 */
function withWriteLock(key, fn) {
  const prev = kvWriteChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  // 链上只保留「已settle」的占位，异常不外泄给下一个任务
  kvWriteChains.set(key, run.then(
    () => {},
    () => {}
  ));
  return run;
}

// ============================================================
// 8. GitHub —— 远程数据源
// ------------------------------------------------------------
// 针对国内访问 GitHub 不稳定的优化设计：
//   1. 多源故障转移：每次拉取按优先级尝试多个镜像源，全部失败才抛错。
//      注意：Worker 运行在 Cloudflare 边缘节点，用户本机配置的 DNS 加速
//      对 Worker 侧的 fetch 并不生效——真正有效的是多 CDN 镜像故障转移。
//   2. 超时 + 重试：每个源独立超时；网络错误/超时/5xx 会重试当前源，
//      403/429（限流）与 404 直接切换下一个源。
//   3. 过期缓存兜底（stale-while-revalidate）：缓存过期后仍先尝试刷新，
//      刷新失败则继续返回旧内容——GitHub 长时间不可达时站点内容不消失。
//   4. 并发去重：同一缓存键的并发请求只发一次网络请求。
// ============================================================

/** GitHub 不可达（所有源均失败且无缓存可用） */
class GitHubUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubUnavailableError";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时的 fetch（AbortError 按网络错误处理，进入重试/换源逻辑） */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 7.5 GitHub API 客户端 —— Token 注入 + ETag 条件请求 + 配额感知 + 401 自愈
// ------------------------------------------------------------
// 背景：api.github.com 匿名请求仅 60 次/小时（按出口 IP 计），
// 注入 GITHUB_TOKEN 后 5000 次/小时；ETag 条件请求命中 304 不消耗配额。
// 配额低于储备值时主动降级到 CDN 源；Token 失效（401）自动摘除并裸重试。
// 所有状态同时记录到 KV（gh_status），供管理后台「连接状态」面板排查。
// ============================================================

/** isolate 内配额状态（Worker 多 isolate 各自维护，KV 为准但读一次即可） */
const ghQuotaMem = { remaining: null, resetAt: 0 };
/** isolate 内 Token 健康状态：401 后本 isolate 不再发送，避免每次请求都撞一次 401 */
const ghTokenMem = { invalid: false };

function ghToken(env) {
  const t = env && env.GITHUB_TOKEN;
  return typeof t === "string" && t.trim() ? t.trim() : "";
}

/** 请求头：Token 有效时注入 Bearer（5000 次/时），否则匿名（60 次/时） */
function ghHeaders(env) {
  const h = {
    "User-Agent": CONFIG.github.userAgent,
    Accept: "application/vnd.github+json",
  };
  const token = ghToken(env);
  if (token && !ghTokenMem.invalid) h.Authorization = `Bearer ${token}`;
  return h;
}

/** 读取响应头中的配额信息，更新内存态 */
function ghTrackQuota(res) {
  try {
    const remaining = res.headers.get("X-RateLimit-Remaining");
    const reset = res.headers.get("X-RateLimit-Reset");
    if (remaining != null) {
      const v = parseInt(remaining, 10);
      if (!isNaN(v)) ghQuotaMem.remaining = v;
    }
    if (reset != null) {
      const v = parseInt(reset, 10);
      if (!isNaN(v)) ghQuotaMem.resetAt = v * 1000;
    }
  } catch (e) {
    /* 头解析失败不影响主流程 */
  }
}

/** 配额是否低于储备值（重置时间前持续降级） */
function ghQuotaLow() {
  if (ghQuotaMem.remaining == null) return false;
  if (ghQuotaMem.remaining >= CONFIG.github.quotaReserve) return false;
  return Date.now() < ghQuotaMem.resetAt;
}

/** Token 失效：内存标记 + KV 记录（读-改-写，保留其他状态字段） */
function ghMarkTokenInvalid(store) {
  ghTokenMem.invalid = true;
  if (store) {
    recordGhStatus(store, { tokenInvalid: true, tokenInvalidAt: Date.now() });
  }
}

/**
 * 带完整保护的 GitHub API 请求。
 * @param {string} url    上游 URL（https://api.github.com/...）
 * @param {Store|null} store  用于记录 Token 失效状态（可空）
 * @param {object} env    Worker 环境（读 GITHUB_TOKEN）
 * @param {string} etag  上次响应的 ETag（有则发 If-None-Match，304 不耗配额）
 * @returns {Promise<Response>} 上游响应（304 时 body 为空，由调用方用缓存兜底）
 */
async function ghApiRequest(url, store, env, etag) {
  const headers = ghHeaders(env);
  if (etag) headers["If-None-Match"] = etag;
  let res = await fetchWithTimeout(url, { headers }, CONFIG.github.timeoutMs);
  ghTrackQuota(res);
  // 401：Token 失效/过期/ revoked → 摘除 Token 裸重试一次，避免永久卡死
  if (res.status === 401 && headers.Authorization) {
    ghMarkTokenInvalid(store);
    const bare = {
      "User-Agent": CONFIG.github.userAgent,
      Accept: "application/vnd.github+json",
    };
    if (etag) bare["If-None-Match"] = etag;
    res = await fetchWithTimeout(url, { headers: bare }, CONFIG.github.timeoutMs);
    ghTrackQuota(res);
  }
  return res;
}

/**
 * GitHub API 写请求（PUT / POST / DELETE / PATCH）——云盘写入专用。
 * 与 ghApiRequest 的差异：携带 JSON body、30s 写超时、不做任何缓存。
 * Token 注入 / 配额跟踪 / 401 裸重试逻辑与读路径完全一致（Worker 内注入，前端无感知）。
 * @param {string} url     上游 URL（https://api.github.com/...）
 * @param {object} env     Worker 环境（读 GITHUB_TOKEN）
 * @param {string} method  HTTP 方法
 * @param {object} body    请求体（将 JSON.stringify）
 */
async function ghApiWrite(url, env, method, body) {
  const headers = ghHeaders(env);
  headers["Content-Type"] = "application/json";
  const payload = JSON.stringify(body || {});
  let res = await fetchWithTimeout(
    url,
    { method, headers, body: payload },
    CONFIG.drive.writeTimeoutMs
  );
  ghTrackQuota(res);
  if (res.status === 401 && headers.Authorization) {
    ghMarkTokenInvalid(null);
    const bare = {
      "User-Agent": CONFIG.github.userAgent,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    res = await fetchWithTimeout(
      url,
      { method, headers: bare, body: payload },
      CONFIG.drive.writeTimeoutMs
    );
    ghTrackQuota(res);
  }
  return res;
}

/**
 * Contents DELETE 的 409 自愈重试（有界，绝不死循环）。
 * GitHub 连续大量写入后，读副本可能短暂滞后（最终一致性），目录列表/元数据里
 * 拿到的 sha 会过期，导致 DELETE 返回 409（"... is at X but expected Y"）。
 * 处理：重新 GET 最新 sha 再删，最多重试 3 次；刷新不到新 sha（真冲突/已删除）
 * 或 3 次后仍 409，则原样返回错误，由前端提示「刷新列表后重试」。
 */
async function ghDeleteContents(url, env, message, branch, initialSha) {
  let sha = initialSha;
  let res = await ghApiWrite(url, env, "DELETE", { message, sha, branch });
  for (let retry = 0; res.status === 409 && retry < 3; retry += 1) {
    const meta = await ghApiRequest(url, null, env, null);
    const m = meta.ok ? await meta.json().catch(() => null) : null;
    if (!m || !m.sha || m.sha === sha) break; // 刷新不到新 sha：重试无意义，停止
    sha = m.sha;
    res = await ghApiWrite(url, env, "DELETE", { message, sha, branch });
  }
  return res;
}

/** 目录列表数据源（jsDelivr data API 只返回当前层级，需适配成统一结构） */
const GH_LIST_SOURCES = {
  github: {
    name: "github-api",
    url: (repo, path, branch) =>
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    headers: () => ({ "User-Agent": CONFIG.github.userAgent }),
    parse: async (res) => await res.json(),
  },
  jsdelivr: {
    name: "jsdelivr-data",
    url: (repo, path, branch) =>
      `https://data.jsdelivr.com/v1/packages/gh/${repo}@${branch}/${path}`,
    parse: async (res, { repo, path, branch }) => {
      const data = await res.json();
      return (data.files || [])
        .map((f) => {
          const name = f.name.split("/").pop();
          return {
            name,
            type: f.type === "dir" || f.type === "directory" ? "dir" : "file",
            download_url: `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}/${name}`,
            size: f.size || 0,
          };
        })
        .filter((f) => f.name);
    },
  },
};

/** 文件内容数据源 */
const GH_FILE_SOURCES = {
  github: {
    name: "raw-github",
    url: (repo, path, branch) => `https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
    parse: async (res) => await res.text(),
  },
  jsdelivr: {
    name: "jsdelivr-cdn",
    url: (repo, path, branch) => `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`,
    parse: async (res) => await res.text(),
  },
  statically: {
    name: "statically",
    url: (repo, path, branch) => `https://cdn.statically.io/gh/${repo}/${branch}/${path}`,
    parse: async (res) => await res.text(),
  },
};

/**
 * 多源故障转移拉取。
 * useCdn 开启时 CDN 优先，关闭时官方源优先；任一源失败都会尝试其余源。
 * @returns { content, source } 内容与命中的源名
 */
/**
 * 多源故障转移拉取。
 * useCdn 开启时 CDN 优先，关闭时官方源优先；任一源失败都会尝试其余源。
 * - github-api 源走 ghApiRequest：Token 注入 + If-None-Match（304 不耗配额）
 * - 配额低于储备值时跳过 github-api 源（把有限配额留给关键时刻）
 * - 304 时返回 { notModified: true }，由调用方用缓存内容兜底
 * @returns { content, source, etag } 或 { notModified: true }
 */
async function ghFetchWithFallback(kind, repo, path, branch, useCdn, opts) {
  opts = opts || {};
  const table = kind === "list" ? GH_LIST_SOURCES : GH_FILE_SOURCES;
  let order = useCdn
    ? ["jsdelivr", "github", "statically"]
    : ["github", "jsdelivr", "statically"];
  // 配额不足：api.github.com 直接降级，让 jsDelivr/raw/statically 顶上
  if (kind === "list" && ghQuotaLow()) order = order.filter((k) => k !== "github");
  const errors = [];

  for (const key of order) {
    const source = table[key];
    if (!source) continue; // 目录列表没有 statically 源
    for (let attempt = 1; attempt <= CONFIG.github.retriesPerSource; attempt++) {
      try {
        let res;
        if (key === "github") {
          // 官方 API：带 Token / ETag / 401 自愈的受保护请求
          res = await ghApiRequest(
            source.url(repo, path, branch),
            opts.store || null,
            opts.env,
            opts.etag
          );
          if (res.status === 304) return { notModified: true, source: source.name };
        } else {
          res = await fetchWithTimeout(
            source.url(repo, path, branch),
            source.headers ? { headers: source.headers() } : {},
            CONFIG.github.timeoutMs
          );
        }
        if (!res.ok) {
          errors.push(`${source.name}: HTTP ${res.status}`);
          // 404：该源上确实不存在；403/429：限流——换源即可，无需重试
          if (res.status === 404 || res.status === 403 || res.status === 429) break;
          continue; // 5xx/408：临时故障，重试当前源
        }
        const content = await source.parse(res, { repo, path, branch });
        const etag = (res.headers && res.headers.get("ETag")) || "";
        return { content, source: source.name, etag };
      } catch (e) {
        const reason = e && e.name === "AbortError" ? "超时" : String((e && e.message) || e);
        errors.push(`${source.name}: ${reason}`);
        if (attempt < CONFIG.github.retriesPerSource) await sleep(200 * attempt);
      }
    }
  }
  throw new GitHubUnavailableError(`GitHub 拉取失败（${path}）：${errors.join("；")}`);
}

/** 缓存读取：区分「新鲜」与「过期可用」，过期内容用于刷新失败时兜底；附带 ETag 供条件请求 */
async function ghCacheGet(store, cacheKey) {
  const raw = await store.getRaw(cacheKey);
  if (raw == null) return null;
  const data = safeJsonParse(raw);
  if (!data || typeof data !== "object") return null;
  const age = Date.now() - (data.time || 0);
  return {
    content: data.content,
    etag: data.etag || "",
    fresh: age < CONFIG.github.cacheTtlSeconds * 1000,
  };
}

function ghCacheSet(store, cacheKey, content, etag) {
  return store.defer(
    store.kv.put(
      cacheKey,
      JSON.stringify({ time: Date.now(), content, etag: etag || "" }),
      // TTL 拉长到 stale 存活期：GitHub 长时间不可达时仍有旧内容可展示
      { expirationTtl: CONFIG.github.staleTtlSeconds }
    )
  );
}

/** 同 isolate 内并发去重：cacheKey -> 进行中的拉取 Promise */
const ghInflight = new Map();
/** 代理路径（/api/github/*）并发去重：upstream URL -> 进行中的拉取 Promise */
const ghProxyInflight = new Map();

/** 记录最近一次拉取状态到 KV（供管理后台「GitHub 连接状态」排查问题） */
function recordGhStatus(store, patch) {
  return store.defer(
    (async () => {
      try {
        const raw = await store.kv.get(KEYS.ghStatus);
        const prev = safeJsonParse(raw, {}) || {};
        await store.kv.put(
          KEYS.ghStatus,
          JSON.stringify({ ...prev, ...patch, updatedAt: Date.now() })
        );
      } catch {
        /* 状态记录失败不影响主流程 */
      }
    })()
  );
}

/**
 * 带缓存与兜底的内容加载（Worker 侧唯一的 GitHub 出入口）。
 *  - 缓存新鲜 → 直接返回，不发网络请求
 *  - 缓存过期但有旧值 → SWR：立即返回旧内容 + 后台重验（用户永不等 GitHub）
 *  - 无缓存 → 多源拉取；带 ETag 条件请求（304 不耗配额）；成功则更新缓存
 *  - 拉取失败但有旧缓存 → 返回旧缓存（stale），站点内容不消失
 *  - 拉取失败且无缓存 → 抛 GitHubUnavailableError
 */
async function ghLoad(store, kind, repo, path, branch, useCdn) {
  // ctx 从 store 取（Store 构造时已持有），无需逐层透传
  const ctx = store.ctx;
  const env = ctx && ctx.env;
  const cacheKey = KEYS.ghCache(kind === "list" ? "cache" : "raw", repo, branch, path, useCdn);
  const cached = await ghCacheGet(store, cacheKey);
  if (cached && cached.fresh) return cached.content;

  // SWR：旧缓存立即可用 → 先返回旧内容，后台异步重验
  if (cached && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(ghRevalidate(store, kind, repo, path, branch, useCdn, cacheKey, cached, env));
    return cached.content;
  }

  const inflight = ghInflight.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const r = await ghFetchWithFallback(kind, repo, path, branch, useCdn, {
        store,
        env,
        etag: cached ? cached.etag : "",
      });
      if (r.notModified) {
        // 304：内容未变——只续期缓存时间戳，不重写内容、不消耗 GitHub 配额
        await ghCacheSet(store, cacheKey, cached.content, cached.etag);
        recordGhStatus(store, {
          lastOkAt: Date.now(),
          lastOkSource: `${r.source}(304)`,
          lastError: "",
          usingStale: false,
        });
        return cached.content;
      }
      await ghCacheSet(store, cacheKey, r.content, r.etag);
      recordGhStatus(store, {
        lastOkAt: Date.now(),
        lastOkSource: r.source,
        lastError: "",
        usingStale: false,
      });
      return r.content;
    } catch (e) {
      if (cached) {
        // 全部源失败：退回旧缓存（超过 TTL 也照常展示）。
        // 失败与 stale 标记必须合并为一次写入，避免并发读-改-写互相覆盖字段。
        recordGhStatus(store, {
          lastFailAt: Date.now(),
          lastError: String((e && e.message) || e).slice(0, 300),
          usingStale: true,
          staleSince: Date.now(),
        });
        return cached.content;
      }
      recordGhStatus(store, {
        lastFailAt: Date.now(),
        lastError: String((e && e.message) || e).slice(0, 300),
      });
      throw e;
    } finally {
      ghInflight.delete(cacheKey);
    }
  })();
  ghInflight.set(cacheKey, task);
  return task;
}

/**
 * SWR 后台重验：与前台路径共享并发去重表。
 * 失败只记录状态（前台已在用旧内容，无用户可感影响）；304 只续期不重写。
 */
function ghRevalidate(store, kind, repo, path, branch, useCdn, cacheKey, cached, env) {
  const existing = ghInflight.get(cacheKey);
  if (existing) return existing;
  const task = (async () => {
    try {
      const r = await ghFetchWithFallback(kind, repo, path, branch, useCdn, {
        store,
        env,
        etag: cached.etag,
      });
      if (r.notModified) {
        await ghCacheSet(store, cacheKey, cached.content, cached.etag);
      } else {
        await ghCacheSet(store, cacheKey, r.content, r.etag);
        recordGhStatus(store, {
          lastOkAt: Date.now(),
          lastOkSource: r.source,
          lastError: "",
          usingStale: false,
        });
      }
    } catch (e) {
      recordGhStatus(store, {
        lastFailAt: Date.now(),
        lastError: String((e && e.message) || e).slice(0, 300),
        usingStale: true,
        staleSince: Date.now(),
      });
    } finally {
      ghInflight.delete(cacheKey);
    }
  })();
  ghInflight.set(cacheKey, task);
  return task;
}

async function githubFetch(store, repo, path, branch, useCdn) {
  return ghLoad(store, "list", repo, path, branch, useCdn);
}

async function githubFetchRaw(store, repo, path, branch, useCdn) {
  return ghLoad(store, "file", repo, path, branch, useCdn);
}

// ============================================================
// 7.6 同源 GitHub 代理（/api/github/*）
// ------------------------------------------------------------
// 前端统一请求同源路径，由 Worker 转发到 GitHub：
//   /api/github/api/<rest>  → https://api.github.com/<rest>（含 query string）
//   /api/github/raw/<rest>  → https://raw.githubusercontent.com/<rest>（图片/文件）
// 特性：
//   - Token 注入 + 401 自愈 + 配额跟踪（api 代理复用 ghApiRequest）
//   - 配额降级：contents 目录列表在配额低于储备值时改走 jsDelivr data API（X-Cache: DEGRADED）
//   - Cache API 边缘缓存：命中带 X-Cache: HIT（生产环境另有 cf-cache-status: HIT）
//   - ETag 条件请求：If-None-Match 命中 304，不消耗 GitHub 配额
//   - SWR：缓存过期立即返回旧值 + 后台刷新（ctx.waitUntil 驱动）；上游故障/超时返回旧缓存，永不白屏
// 命名缓存与 purgeApiCache 的 caches.default 相互独立，互不干扰。
// ============================================================
const GH_PROXY_CACHE = "gh-proxy-v1";

async function ghProxyCacheOpen() {
  return caches.open(GH_PROXY_CACHE);
}

async function ghProxyCacheMatch(request) {
  try {
    return await (await ghProxyCacheOpen()).match(request);
  } catch (e) {
    return null;
  }
}

async function ghProxyCachePut(request, response) {
  try {
    await (await ghProxyCacheOpen()).put(request, response);
  } catch (e) {
    /* 缓存写失败不影响响应 */
  }
}

/** 清空代理边缘缓存（后台「刷新 GitHub 缓存」时与 KV 缓存同步清理） */
async function ghProxyCachePurge() {
  try {
    const cache = await ghProxyCacheOpen();
    const keys = await cache.keys();
    await Promise.all(keys.map((k) => cache.delete(k)));
    return keys.length;
  } catch (e) {
    return 0;
  }
}

/**
 * 给响应打上观测头（生产环境 Cloudflare 边缘会自动附加 cf-cache-status）。
 * ⚠️ cache.match() 返回的响应 headers 为 immutable guard（Fetch 规范，CF 强制执行），
 * 直接 headers.set() 会抛 TypeError 导致 500——必须先复制到新 Headers 再构造新响应。
 * 新构造响应的 body 直接透传原 body（保持流式，不落盘）。
 */
function withXCache(response, state) {
  const headers = new Headers(response.headers);
  headers.set("X-Cache", state);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * 读旧缓存并续期（SWR/304 路径共用）。
 * 缓存响应体只能消费一次：先读成 buffer，再分别构造「续期存入」与「返回」两份。
 */
async function refreshCacheEntry(cacheKey, cached) {
  const buf = await cached.arrayBuffer();
  const headers = new Headers(cached.headers);
  headers.set("X-Cache-Time", String(Date.now()));
  await ghProxyCachePut(cacheKey, new Response(buf, { status: 200, headers }));
  return new Response(buf, { status: 200, headers });
}

/**
 * 后台刷新（SWR）：失败/非 2xx 一律保留旧缓存，静默结束。
 * - api 分支（opts.store 存在）：走 ghApiRequest，重验同样享受 Token 注入/401 自愈/配额跟踪
 * - raw 分支：匿名直拉，带 If-None-Match；命中 304 只续期不重写内容（不耗配额）
 * @param {object} opts { store, env }——store 存在即按 api 分支处理
 */
async function ghProxyRevalidate(cacheKey, cached, upstream, headers, opts) {
  opts = opts || {};
  // 与前台拉取共享去重表：过期缓存 + 高并发时，N 个 STALE 响应只会触发 1 次真实重验，
  // 避免后台重验本身被打成上游风暴（数据路径 ghRevalidate 同理）。
  if (ghProxyInflight.has(cacheKey.url)) return;
  const task = (async () => {
    try {
      const etag = cached ? cached.headers.get("ETag") : null;
      let res;
      if (opts.store) {
        res = await ghApiRequest(upstream, opts.store, opts.env, etag);
      } else {
        const h = Object.assign({}, headers || {});
        if (etag) h["If-None-Match"] = etag;
        res = await fetchWithTimeout(upstream, { headers: h }, CONFIG.github.timeoutMs);
      }
      if (res.status === 304 && cached) {
        await refreshCacheEntry(cacheKey, cached);
        return;
      }
      if (!res.ok) return; // 上游故障：保留旧缓存
      const body = await res.arrayBuffer();
      const response = new Response(body, {
        status: 200,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
          "Cache-Control": `public, max-age=${CONFIG.github.cacheTtlSeconds}, s-maxage=3600, stale-while-revalidate=86400`,
          "X-Cache-Time": String(Date.now()),
        },
      });
      const newEtag = res.headers.get("ETag");
      if (newEtag) response.headers.set("ETag", newEtag);
      await ghProxyCachePut(cacheKey, response);
    } catch (e) {
      /* 保留旧缓存 */
    } finally {
      ghProxyInflight.delete(cacheKey.url);
    }
  })();
  ghProxyInflight.set(cacheKey.url, task);
  return task;
}

/**
 * 代理核心：Cache API SWR + ETag 条件请求 + 上游故障兜底。
 * @param {string} upstream  上游 URL
 * @param {object} opts      { ttl, headers, store(可空), env }
 * @param {object} ctx      执行上下文（ctx.waitUntil 驱动后台重验；可空）
 * @returns {Promise<Response>} 始终返回可渲染响应（有旧缓存时绝不 5xx）
 */
async function ghProxyFetch(cacheKey, upstream, opts, ctx) {
  const cached = await ghProxyCacheMatch(cacheKey);

  if (cached) {
    const cachedAt = parseInt(cached.headers.get("X-Cache-Time") || "0", 10) || 0;
    const age = Date.now() - cachedAt;
    if (age < opts.ttl * 1000) {
      return withXCache(cached, "HIT"); // 边缘缓存命中：不打上游、不耗配额
    }
    // 过期：SWR——先续期旧缓存并立即返回，再后台异步重验。
    // 先续期再排后台任务，避免重验抢在续期前写入导致旧内容覆盖新内容。
    const refreshed = await refreshCacheEntry(cacheKey, cached);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(
        ghProxyRevalidate(cacheKey, cached, upstream, opts.headers, {
          store: opts.store,
          env: opts.env,
        })
      );
    }
    return withXCache(refreshed, "STALE");
  }

  // 无缓存：同步拉取（带 If-None-Match 时由 ghApiRequest 处理 304）。
  // 并发去重：同一 URL 的并发请求（相册网格 + 灯箱 + 相邻预载常同时打到同一张图）
  // 共享一次上游拉取，避免缓存击穿瞬间 N 路重复请求打爆上游。
  let task = ghProxyInflight.get(cacheKey.url);
  if (!task) {
    task = (async () => {
      try {
        let res;
        try {
          res = opts.store
            ? await ghApiRequest(upstream, opts.store, opts.env)
            : await fetchWithTimeout(upstream, { headers: opts.headers }, CONFIG.github.timeoutMs);
        } catch (e) {
          return err("GitHub 代理不可用（网络错误）", 504);
        }
        if (!res.ok) {
          // 403/429：配额/限流；其余：上游故障。均无缓存可退，明确告知降级状态
          const status = res.status === 403 || res.status === 429 ? 503 : 502;
          return err(`GitHub 代理上游错误（HTTP ${res.status}）`, status);
        }
        const body = await res.arrayBuffer();
        const headers = new Headers({
          "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
          // s-maxage：Cloudflare 边缘共享缓存新鲜期（api 代理 1h；raw 图片路径 ttl 本身即 1 天，取更大值）
          // stale-while-revalidate=86400：边缘过期后仍可serve 旧值并后台刷新，与 Cache API SWR 语义一致
          "Cache-Control": `public, max-age=${opts.ttl}, s-maxage=${Math.max(3600, opts.ttl)}, stale-while-revalidate=86400`,
          "X-Cache-Time": String(Date.now()),
        });
        const etag = res.headers.get("ETag");
        if (etag) headers.set("ETag", etag);
        const response = new Response(body, { status: 200, headers });
        await ghProxyCachePut(cacheKey, response.clone());
        return response;
      } finally {
        ghProxyInflight.delete(cacheKey.url);
      }
    })();
    ghProxyInflight.set(cacheKey.url, task);
  }
  // 每个调用方拿独立 clone（Response 体只能读一次）；错误响同样共享clone
  return withXCache((await task).clone(), "MISS");
}

/** contents 列表请求识别：repos/:owner/:repo/contents/:path?ref=:branch */
const GH_CONTENTS_RE = /^repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)(?:\?.*)?$/;

/**
 * 配额降级服务：GitHub 配额低于储备值且请求是 contents 目录列表时，
 * 改走 jsDelivr data API（独立配额体系），保住目录列表能力。
 * 降级内容同样写入边缘缓存（同 key），避免每次降级都打 CDN。
 * @returns {Promise<Response>|null} 降级响应；不适用/失败时返回 null 交回正常路径
 */
async function ghProxyServeDegraded(cacheKey, apiPath, opts) {
  if (!ghQuotaLow()) return null;
  const m = GH_CONTENTS_RE.exec(apiPath);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  const dirPath = m[3];
  const refMatch = /[?&]ref=([^&]+)/.exec(apiPath);
  const branch = refMatch ? decodeURIComponent(refMatch[1]) : "HEAD";

  // 已有缓存（含正常路径写入的）：新鲜则直接复用；过期则尝试用降级源刷新
  const cached = await ghProxyCacheMatch(cacheKey);
  if (cached) {
    const cachedAt = parseInt(cached.headers.get("X-Cache-Time") || "0", 10) || 0;
    if (Date.now() - cachedAt < CONFIG.github.cacheTtlSeconds * 1000) {
      return withXCache(cached, "HIT");
    }
  }
  try {
    // useCdn=false：jsDelivr 优先；ghFetchWithFallback 内部还会在配额低时剔除 github 源
    const { content } = await ghFetchWithFallback("list", repo, dirPath, branch, false, {
      store: opts.store,
      env: opts.env,
    });
    const response = new Response(JSON.stringify(content), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CONFIG.github.cacheTtlSeconds}, s-maxage=3600, stale-while-revalidate=86400`,
        "X-Cache-Time": String(Date.now()),
      },
    });
    await ghProxyCachePut(cacheKey, response.clone());
    return withXCache(response, "DEGRADED");
  } catch (e) {
    // 降级源也失败：交回正常路径（由它负责 502/503/STALE 语义）
    return cached ? withXCache(await refreshCacheEntry(cacheKey, cached), "STALE") : null;
  }
}

/**
 * /api/github/* 统一入口。
 * api 子路径走 ghApiRequest（Token/401 自愈/配额跟踪）；raw 子路径匿名直拉（CDN 无配额问题）。
 */
async function handleGithubProxy(request, env, ctx, url, store) {
  const rest = url.pathname.replace(/^\/api\/github\//, "");
  if (!rest) return err("代理路径为空", 400);

  // 写方法（POST/PUT/DELETE/PATCH）透传：PIN 保护 + Token 注入直连 api.github.com，不走缓存。
  // 语义：前端 → 本代理 → GitHub Contents API，Token 全程不出 Worker。
  if (request.method !== "GET") {
    const pinGuard = drivePinGuard(request, env, "写操作需要有效的云盘口令（请求头 x-drive-pin）");
    if (pinGuard) return pinGuard;
    if (!rest.startsWith("api/")) {
      return err("写操作仅支持 api/ 子路径（raw/ 为只读镜像）", 400);
    }
    const upstream = "https://api.github.com/" + rest.slice(4) + url.search;
    const body = await readDriveJson(request);
    const res = await ghApiWrite(upstream, env, request.method, body || {});
    if (!res.ok) return githubWriteError(res);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: buildHeaders({
        "Content-Type": res.headers.get("Content-Type") || "application/json",
      }),
    });
  }

  if (rest.startsWith("api/")) {
    const apiPath = rest.slice(4) + url.search;
    const upstream = "https://api.github.com/" + apiPath;
    const cacheKey = new Request(upstream, { method: "GET" });
    const degraded = await ghProxyServeDegraded(cacheKey, apiPath, { store: store || null, env });
    if (degraded) return degraded;
    return ghProxyFetch(cacheKey, upstream, {
      ttl: CONFIG.github.cacheTtlSeconds,
      store: store || null,
      env,
    }, ctx);
  }
  if (rest.startsWith("raw/")) {
    const upstream = "https://raw.githubusercontent.com/" + rest.slice(4);
    return ghProxyFetch(new Request(upstream, { method: "GET" }), upstream, {
      ttl: CONFIG.github.imageCacheTtlSeconds,
      headers: { "User-Agent": CONFIG.github.userAgent },
    }, ctx);
  }
  return err("不支持的代理路径（仅 api/ 与 raw/）", 400);
}

// ============================================================
// 7.7 GitHub 云盘（文件管理器）—— PIN 保护的 Contents 读写代理
// ------------------------------------------------------------
// 前端 drive.html 专用入口。所有操作经本代理转发 GitHub Contents API，
// Token 只在 Worker 内注入，前端永不接触；写操作一律要求 x-drive-pin 口令。
//
//   GET    /api/drive/list?path=drive[/子目录]       目录列表（小文件 + 大文件清单 + 子目录名）
//   POST   /api/drive/upload  {path, content, message}  小文件新建/覆盖（≤8MB，path 可含子目录）
//   PUT    /api/drive/update  {path, content, message}  小文件更新（后端先 GET sha）
//   DELETE /api/drive/delete  {path, message}           删除（manifest 走批量删 parts）
//
//   ---- v6.0 大文件分片协议（>8MB）----
//   GET    /api/drive/upload/status?uploadId=xxx   断点查询：已落库分片序号
//   POST   /api/drive/upload/part                  分片上传（后端直存 part 文件）
//   POST   /api/drive/upload/finish                收尾：写 manifest 清单（可选 dir：子目录归属）
//
// 下载不经过本代理：小文件走 /api/github/raw/<repo>/<branch>/<path>；
// 大文件由前端读 manifest 后逐片拉 raw 并用 Blob 重组（GitHub 无多 blob
// 拼接单文件的 API，S3 式 multipart 在 GitHub 模型里不存在，故重组只能在
// 浏览器端完成——浏览器对 Blob 有磁盘优化，不炸 JS 堆）。
// SHA 逻辑（GitHub Contents API 硬性要求）：新建文件不传 sha；更新/删除必须先
// GET /contents/<path> 拿到当前 sha，否则 GitHub 返回 409/422。
// 大小上限：小文件直传 8MB；>8MB 必须走分片（单文件产品级上限 2GB）。
// ============================================================

/** isolate 内目录列表缓存（30s）：列表含 N+1 次 commits 查询，重复刷新直接复用 */
const driveListMemo = { at: 0, key: "", data: null };

/**
 * 云盘口令守卫（v8.0 安全止血）：
 * 返回 null = 校验通过放行；否则返回应直接下发的错误响应。
 *  1) env.DRIVE_PIN 未配置 → 500「服务端未配置密钥」，**绝不回退任何硬编码值**
 *     （历史教训：旧版用 CONFIG.drive.fallbackPin 兜底，而本仓库是公开仓库，
 *      口令等于公开；现改为缺失即拒绝服务，把风险前移到部署侧）
 *  2) 未提供或不匹配 → 401
 * @param {(msg:string,status:number,headers?:object)=>Response} errFn 错误响应构造器
 */
function drivePinGuard(request, env, message, errFn) {
  const expected = env && env.DRIVE_PIN;
  const fail = errFn || err;
  if (!expected) {
    return fail("服务端未配置密钥（DRIVE_PIN）：请在 Cloudflare Pages 环境变量中配置后重试", 500);
  }
  const given = (request.headers.get("x-drive-pin") || "").trim();
  if (!given || given !== String(expected)) {
    return fail(message || "云盘口令错误或未提供（请求头 x-drive-pin）", 401);
  }
  return null;
}

/**
 * 云盘响应助手：一律 no-store。
 * 管理面实时数据（列表/写结果）禁一切缓存层——SW 的 /api/* SWR、
 * 浏览器 HTTP 缓存、CF 边缘缓存都不该碰，否则写操作后前台不刷新。
 */
function driveOk(data) {
  return ok(data, { "Cache-Control": "no-store" });
}
function driveErr(message, status) {
  return err(message, status, { "Cache-Control": "no-store" });
}

/**
 * 云盘路径净化：必须位于云盘目录内，拒绝空段 / . / .. 穿越与超长路径。
 * @returns {string|null} 净化后的路径（如 drive/notes/a.txt），非法返回 null
 */
function sanitizeDrivePath(raw) {
  const p = String(raw || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return CONFIG.drive.dir;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  if (segs[0] !== CONFIG.drive.dir) return null;
  if (p.length > 300) return null;
  return p;
}

/** Base64 解码后的真实字节数（比前端估算更可信，用于后端大小兜底） */
function base64ByteLength(b64) {
  const clean = String(b64).replace(/\s+/g, "");
  try {
    return atob(clean).length;
  } catch (e) {
    return -1;
  }
}

/** 云盘大 body 读取：读路径的 readJson 有 100KB 上限，云盘需支持到 16MB */
async function readDriveJson(request) {
  try {
    const text = await request.text();
    if (text.length > CONFIG.drive.maxBodyBytes) return null;
    return safeJsonParse(text);
  } catch (e) {
    return null;
  }
}

/** GitHub 写操作错误 → 友好 JSON（403 配额/权限、409 SHA 冲突、404、422 分类提示） */
function githubWriteError(res) {
  const remaining = res.headers.get("X-RateLimit-Remaining");
  if (res.status === 403 && remaining === "0") {
    return driveErr("GitHub API 配额已用尽（每小时重置），请稍后再试", 429);
  }
  if (res.status === 403) {
    return driveErr("GitHub 拒绝写入：Token 权限不足（需要 Contents: Read and write）或触发安全策略", 403);
  }
  if (res.status === 409) {
    return driveErr("SHA 冲突：文件在你操作期间已被修改，请刷新列表后重试", 409);
  }
  if (res.status === 404) {
    return driveErr("目标文件或目录不存在", 404);
  }
  if (res.status === 422) {
    return driveErr("GitHub 校验失败：内容为空、Base64 不合法或参数有误", 422);
  }
  return driveErr(`GitHub 上游错误（HTTP ${res.status}）`, 502);
}

/** 云盘目录内容 URL（Contents API） */
function driveContentsUrl(repo, branch, path) {
  return `https://api.github.com/repos/${repo}/contents/${encodePathSegments(path)}?ref=${branch}`;
}

/**
 * 保存文件（upload / update 共用）。
 * @param {boolean} requireSha  true=更新（必须先拿到 sha，否则 404）；false=新建/覆盖（自动判别）
 */
async function driveSaveFile(env, path, content, message, requireSha) {
  const repo = CONFIG.drive.repo;
  const branch = CONFIG.drive.branch;

  // 先 GET 元数据拿 sha：requireSha 时必须存在；否则存在则带 sha（覆盖），不存在则新建
  const metaRes = await ghApiRequest(driveContentsUrl(repo, branch, path), null, env, null);
  let sha = null;
  if (metaRes.ok) {
    const meta = await metaRes.json();
    sha = meta && meta.sha ? meta.sha : null;
  } else if (requireSha && metaRes.status === 404) {
    return driveErr("文件不存在，无法更新（请先上传）", 404);
  } else if (!metaRes.ok && metaRes.status !== 404) {
    return githubWriteError(metaRes);
  }

  const body = {
    message: message || `drive: ${requireSha ? "update" : "upload"} ${path}`,
    content: String(content).replace(/\s+/g, ""),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await ghApiWrite(driveContentsUrl(repo, branch, path), env, "PUT", body);
  if (!res.ok) return githubWriteError(res);
  const data = await res.json();
  driveListMemo.data = null; // 写成功：立即使列表缓存失效，保证刷新拿到最新内容
  return driveOk({
    ok: true,
    path,
    sha: data && data.content ? data.content.sha : null,
    commit: data && data.commit ? data.commit.sha : null,
    updated: !!sha,
  });
}

// ------------------------------------------------------------
// v6.0 大文件分片协议（>8MB）
// ------------------------------------------------------------
// 仓库内布局：
//   drive/.m-<uploadId>.json               大文件清单（name/size/total/chunkBytes）
//   drive/.parts/<uploadId>/part-00001..N  分片文件（每片 ≤5MB，Contents API 直存）
// 上传 = 前端切片逐片 POST（每片独立 commit，天然断点）；收尾写 manifest。
// 删除 = 读 manifest → 列 parts 目录 → 逐片 DELETE → DELETE manifest。
// 下载 = 前端读 manifest 后逐片拉 raw，Blob 重组（见 drive.html）。

/** uploadId 净化：前端生成的短 id（时间戳 base36 + 随机），严防路径穿越 */
function sanitizeUploadId(raw) {
  const id = String(raw || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

/** 分片文件路径：drive/.parts/<uploadId>/part-00001 */
function drivePartPath(uploadId, index) {
  return `${CONFIG.drive.dir}/.parts/${uploadId}/part-${String(index).padStart(5, "0")}`;
}

/** manifest 路径：drive/.m-<uploadId>.json（顶层扁平文件，点前缀避开普通文件） */
function driveManifestPath(uploadId, dir) {
  // v8.0：dir 为「drive/ 之下」的相对子目录（如 "photos/2024"），为空即根目录（旧行为）
  const prefix = dir ? `${CONFIG.drive.dir}/${String(dir).replace(/^\/+/, "").replace(/\/+$/, "")}` : CONFIG.drive.dir;
  return `${prefix}/.m-${uploadId}.json`;
}

/** 校验「drive/ 之下」的相对子目录：不含 . .. 空段、不以点开头（隐藏目录保护） */
function sanitizeDriveSubdir(raw) {
  const p = String(raw || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return "";
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return null;
  if (p.length > 200) return null;
  return p;
}

/** 分片上传的 body 读取：5MB Base64 → 6.7MB，上限 8.5MB（含 JSON 外壳） */
async function readDrivePartJson(request) {
  try {
    const text = await request.text();
    if (text.length > CONFIG.drive.maxPartBodyBytes) return { __tooLarge: true };
    return safeJsonParse(text);
  } catch (e) {
    return null;
  }
}

/**
 * 断点查询：列出 uploadId 已落库的分片序号。
 * 前端「继续上传」时先问服务端，跳过已传分片，实现断点续传。
 */
async function driveChunkStatus(env, uploadId) {
  const res = await ghApiRequest(
    driveContentsUrl(CONFIG.drive.repo, CONFIG.drive.branch, `${CONFIG.drive.dir}/.parts/${uploadId}`),
    null,
    env,
    null
  );
  if (res.status === 404) return driveOk({ ok: true, uploadId, parts: [] });
  if (!res.ok) return githubWriteError(res);
  const items = await res.json();
  const parts = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.type === "file" && /^part-\d{5}$/.test(it.name || ""))
    .map((it) => parseInt(it.name.slice(5), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return driveOk({ ok: true, uploadId, parts });
}

/**
 * 分片上传：把一片 Base64 内容写入 drive/.parts/<uploadId>/part-NNNNN。
 * 已存在则带 sha 覆盖（重传同一片是幂等的），保证重试安全。
 */
async function driveChunkSave(env, uploadId, index, content) {
  const path = drivePartPath(uploadId, index);
  const metaRes = await ghApiRequest(driveContentsUrl(CONFIG.drive.repo, CONFIG.drive.branch, path), null, env, null);
  let sha = null;
  if (metaRes.ok) {
    const meta = await metaRes.json();
    sha = meta && meta.sha ? meta.sha : null;
  } else if (metaRes.status !== 404) {
    return githubWriteError(metaRes);
  }
  const body = {
    message: `drive: part ${uploadId}/${index}`,
    content: String(content).replace(/\s+/g, ""),
    branch: CONFIG.drive.branch,
  };
  if (sha) body.sha = sha;
  const res = await ghApiWrite(driveContentsUrl(CONFIG.drive.repo, CONFIG.drive.branch, path), env, "PUT", body);
  if (!res.ok) return githubWriteError(res);
  driveListMemo.data = null; // parts 目录变化不影响顶层列表，但保守失效
  return driveOk({ ok: true, uploadId, index, existed: !!sha });
}

/**
 * 收尾：校验分片数量后写 manifest（drive/.manifests/<uploadId>.json）。
 * parts 此时已全部落库（逐片 commit），此处只落一份清单文件。
 */
async function driveChunkFinish(env, uploadId, name, size, total, dir) {
  const nTotal = Number(total);
  if (!Number.isInteger(nTotal) || nTotal < 1 || nTotal > 100000) {
    return driveErr("分片总数不合法（1-100000）", 400);
  }
  const statusRes = await driveChunkStatus(env, uploadId);
  if (!(statusRes instanceof Response)) return statusRes;
  const status = await statusRes.json();
  if (!status || status.parts.length !== nTotal) {
    return driveErr(
      `分片不完整：已收 ${status ? status.parts.length : 0}/${nTotal} 片，请继续上传缺失分片`,
      409
    );
  }
  const manifest = {
    uploadId,
    name: String(name || "unnamed").slice(0, 200),
    size: Number(size) || 0,
    total: nTotal,
    chunkBytes: CONFIG.drive.chunkSize,
    createdAt: new Date().toISOString(),
  };
  const manifestContent = jsonToBase64(JSON.stringify(manifest));
  return driveSaveFile(env, driveManifestPath(uploadId, dir || ""), manifestContent, `drive: manifest ${manifest.name}`, false);
}

/** UTF-8 字符串 → Base64（manifest 落库用；TextEncoder 处理多字节安全） */
function jsonToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * /api/drive/* 统一入口。
 * 口令校验 → 路径净化 → 大小兜底 → 转发 GitHub Contents API。
 */
async function handleDrive(request, env, ctx, url) {
  const pinGuard = drivePinGuard(request, env, "云盘口令错误或未提供（请求头 x-drive-pin）", driveErr);
  if (pinGuard) return pinGuard;

  const sub = url.pathname.replace(/^\/api\/drive\/?/, "");
  const repo = CONFIG.drive.repo;
  const branch = CONFIG.drive.branch;

  // v8.0：任何写操作（upload/update/delete/finish）立即使目录列表的 isolate
  // 缓存失效——否则上传完成后的 onAllDone 刷新会在 30s 窗口内拿到旧快照，
  // 表现为「传成功了但列表里没有」。
  if (request.method !== "GET") { driveListMemo.at = 0; }

  // ---- 目录列表 ----
  if (request.method === "GET" && sub === "list") {
    const dir = sanitizeDrivePath(url.searchParams.get("path") || CONFIG.drive.dir);
    if (!dir) return driveErr("非法的目录路径", 400);

    // isolate 内 30s 缓存：重复刷新不重复消耗 GitHub 配额
    const now = Date.now();
    if (driveListMemo.data && driveListMemo.key === dir && now - driveListMemo.at < CONFIG.drive.listCacheMs) {
      return driveOk(driveListMemo.data);
    }

    const res = await ghApiRequest(driveContentsUrl(repo, branch, dir), null, env, null);
    if (res.status === 404) {
      // 目录不存在（从未上传过）→ 空列表，首次上传时 GitHub 会自动创建中间目录
      return driveOk({ ok: true, dir, files: [], empty: true, latestAt: null });
    }
    if (!res.ok) return githubWriteError(res);
    const items = await res.json();
    const all = Array.isArray(items) ? items : [];
    // 普通文件：排除分片协议内部条目——drive/ 之后任意一段以点开头（.m-*.json 清单、
    // .parts/ 分片目录、隐藏文件）；v8.0 修正：旧实现只挡根目录 drive/.，子目录里的
    // manifest 会同时命中普通文件与 manifest 两条路径，导致同一大文件出现两行。
    const topFiles = all.filter(
      (it) => it && it.type === "file" &&
        !String(it.path || "").split("/").slice(1).some((seg) => seg.startsWith("."))
    );
    // v8.0 子目录：type=dir 且非隐藏（点开头）→ 面包屑导航与「进入目录」的数据基础
    const dirs = all
      .filter((it) => it && it.type === "dir" && !String(it.name || "").startsWith("."))
      .map((it) => String(it.name || ""))
      .filter(Boolean)
      .slice(0, 100)
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    // manifest 文件（drive/[子目录/].m-<id>.json）→ 大文件条目（storage: "chunked"，前端重组下载）
    // v8.0：正则放开到任意深度子目录，与「上传到子目录」的 finish dir 能力对齐
    const manifestItems = all.filter(
      (it) => it && it.type === "file" && new RegExp(`^${CONFIG.drive.dir}/(?:[^/]+/)*\\.m-[A-Za-z0-9_-]{1,64}\\.json$`).test(String(it.path || ""))
    );
    const files = topFiles.slice(0, 50).map((it) => ({
      name: it.name,
      path: it.path,
      size: it.size || 0,
      sha: it.sha,
      storage: "contents",
      downloadUrl: `/api/github/raw/${repo}/${branch}/${encodePathSegments(it.path)}`,
    }));

    // 读 manifest 内容还原大文件条目（UTF-8 安全：atob 出字节流再 TextDecoder）
    const chunked = await Promise.all(
      manifestItems.slice(0, 50).map(async (it) => {
        try {
          const mRes = await ghApiRequest(driveContentsUrl(repo, branch, it.path), null, env, null);
          if (!mRes.ok) return null;
          const m = await mRes.json();
          const bytes = Uint8Array.from(atob(String(m.content || "").replace(/\s+/g, "")), (c) =>
            c.charCodeAt(0)
          );
          const manifest = JSON.parse(new TextDecoder().decode(bytes));
          return {
            name: String(manifest.name || it.name).slice(0, 200),
            path: it.path,
            size: Number(manifest.size) || 0,
            sha: it.sha,
            storage: "chunked",
            uploadId: String(manifest.uploadId || ""),
            downloadUrl: null, // 大文件：前端逐片拉取 Blob 重组，无单文件直链
          };
        } catch (e) {
          return null;
        }
      })
    );
    chunked.forEach((c) => {
      if (c) files.push(c);
    });

    // 每文件的上传时间：对每个文件查一次该路径的最近 commit（N+1 次请求，
    // 个人云盘文件量小可接受；由 30s isolate 缓存兜底，不会每次刷新都打）。
    // 超过 20 个文件时跳过时间查询（配额保护），前端显示「—」。
    let latestAt = null;
    if (files.length > 0 && files.length <= 20) {
      const times = await Promise.all(
        files.map(async (f) => {
          try {
            const cRes = await ghApiRequest(
              `https://api.github.com/repos/${repo}/commits?path=${encodePathSegments(f.path)}&per_page=1`,
              null,
              env,
              null
            );
            if (!cRes.ok) return null;
            const commits = await cRes.json();
            return commits && commits[0] && commits[0].commit
              ? commits[0].commit.committer.date
              : null;
          } catch (e) {
            return null;
          }
        })
      );
      files.forEach((f, i) => {
        f.uploadedAt = times[i] || null;
        if (f.uploadedAt && (!latestAt || f.uploadedAt > latestAt)) latestAt = f.uploadedAt;
      });
    }

    const payload = { ok: true, dir, files, dirs, empty: files.length === 0 && dirs.length === 0, latestAt };
    driveListMemo.at = now;
    driveListMemo.key = dir;
    driveListMemo.data = payload;
    return driveOk(payload);
  }

  // ---- v6.0 分片上传：断点查询（已落库分片序号，断点续传的依据）----
  if (request.method === "GET" && sub === "upload/status") {
    const uploadId = sanitizeUploadId(url.searchParams.get("uploadId"));
    if (!uploadId) return driveErr("uploadId 不合法", 400);
    return driveChunkStatus(env, uploadId);
  }

  // ---- v6.0 分片上传：单片上传（≤5MB Base64，Worker 零缓冲转发）----
  if (request.method === "POST" && sub === "upload/part") {
    const body = await readDrivePartJson(request);
    if (body && body.__tooLarge) {
      return driveErr(
        `分片请求体超过 ${(CONFIG.drive.maxPartBodyBytes / 1048576).toFixed(1)}MB 上限（分片应为 ${CONFIG.drive.chunkSize / 1048576}MB）`,
        413
      );
    }
    if (!body || typeof body.uploadId !== "string" || typeof body.content !== "string") {
      return driveErr("参数缺失：需要 uploadId 与 content（Base64 分片）", 400);
    }
    const uploadId = sanitizeUploadId(body.uploadId);
    if (!uploadId) return driveErr("uploadId 不合法", 400);
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index > 100000) {
      return driveErr("分片序号不合法（0-100000）", 400);
    }
    if (!/^[A-Za-z0-9+/\s]+=*$/.test(body.content)) {
      return driveErr("content 必须是 Base64 字符串", 400);
    }
    const bytes = base64ByteLength(body.content);
    if (bytes < 0) return driveErr("Base64 解码失败", 400);
    if (bytes > CONFIG.drive.chunkSize) {
      return driveErr(
        `分片大小 ${(bytes / 1048576).toFixed(1)}MB 超过 ${CONFIG.drive.chunkSize / 1048576}MB 分片上限`,
        413
      );
    }
    return driveChunkSave(env, uploadId, index, body.content);
  }

  // ---- v6.0 分片上传：收尾（校验分片齐全后写 manifest）----
  if (request.method === "POST" && sub === "upload/finish") {
    const body = await readDriveJson(request);
    if (!body || typeof body.uploadId !== "string") {
      return driveErr("参数缺失：需要 uploadId", 400);
    }
    const uploadId = sanitizeUploadId(body.uploadId);
    if (!uploadId) return driveErr("uploadId 不合法", 400);
    if (typeof body.name !== "string" || !body.name.trim()) {
      return driveErr("参数缺失：需要 name", 400);
    }
    // v8.0：可选 dir——大文件 manifest 写入指定子目录（与前端上传目标目录一致）
    const dir = body.dir === undefined || body.dir === null || body.dir === ""
      ? ""
      : sanitizeDriveSubdir(body.dir);
    if (dir === null) return driveErr("非法目录：不允许 . .. 与隐藏目录", 400);
    return driveChunkFinish(env, uploadId, body.name.trim(), Number(body.size) || 0, body.total, dir);
  }

  // ---- 上传（新建 / 覆盖）----
  if (request.method === "POST" && sub === "upload") {
    const body = await readDriveJson(request);
    if (!body || typeof body.path !== "string" || typeof body.content !== "string") {
      return driveErr("参数缺失：需要 path 与 content（Base64 字符串）", 400);
    }
    const path = sanitizeDrivePath(body.path);
    if (!path) return driveErr("非法路径：必须位于云盘目录内且不含 .. 穿越", 400);
    if (!/^[A-Za-z0-9+/\s]+=*$/.test(body.content)) {
      return driveErr("content 必须是 Base64 字符串", 400);
    }
    const bytes = base64ByteLength(body.content);
    if (bytes < 0) return driveErr("Base64 解码失败", 400);
    if (bytes > CONFIG.drive.maxFileBytes) {
      return driveErr(
        `文件大小 ${(bytes / 1048576).toFixed(1)}MB 超过 ${CONFIG.drive.maxFileBytes / 1048576}MB 直传上限，请使用分片上传（单文件最大 2GB）`,
        413
      );
    }
    return driveSaveFile(env, path, body.content, body.message, false);
  }

  // ---- 更新（必须先存在，后端自动 GET sha）----
  if (request.method === "PUT" && sub === "update") {
    const body = await readDriveJson(request);
    if (!body || typeof body.path !== "string" || typeof body.content !== "string") {
      return driveErr("参数缺失：需要 path 与 content（Base64 字符串）", 400);
    }
    const path = sanitizeDrivePath(body.path);
    if (!path) return driveErr("非法路径：必须位于云盘目录内且不含 .. 穿越", 400);
    if (!/^[A-Za-z0-9+/\s]+=*$/.test(body.content)) {
      return driveErr("content 必须是 Base64 字符串", 400);
    }
    const bytes = base64ByteLength(body.content);
    if (bytes < 0) return driveErr("Base64 解码失败", 400);
    if (bytes > CONFIG.drive.maxFileBytes) {
      return driveErr(
        `文件大小 ${(bytes / 1048576).toFixed(1)}MB 超过 ${CONFIG.drive.maxFileBytes / 1048576}MB 直传上限，请使用分片上传（单文件最大 2GB）`,
        413
      );
    }
    return driveSaveFile(env, path, body.content, body.message, true);
  }

  // ---- 删除（后端先 GET sha，再 DELETE）----
  if (request.method === "DELETE" && sub === "delete") {
    const body = await readDriveJson(request);
    if (!body || typeof body.path !== "string") {
      return driveErr("参数缺失：需要 path", 400);
    }
    const path = sanitizeDrivePath(body.path);
    if (!path) return driveErr("非法路径：必须位于云盘目录内且不含 .. 穿越", 400);

    // ---- v6.0：大文件（manifest）删除 = 删全部分片 + 删 manifest ----
    const mManifest = path.match(/^drive\/\.m-([A-Za-z0-9_-]{1,64})\.json$/);
    if (mManifest) {
      const uploadId = mManifest[1];
      const message = body.message || `drive: delete manifest ${uploadId}`;
      // 1) 列 parts 目录，逐片 Contents DELETE（每片独立 commit；中途失败可重试，幂等）
      let removed = 0;
      const listRes = await ghApiRequest(
        driveContentsUrl(repo, branch, `${CONFIG.drive.dir}/.parts/${uploadId}`),
        null,
        env,
        null
      );
      if (listRes.ok) {
        const parts = await listRes.json();
        const partItems = (Array.isArray(parts) ? parts : []).filter(
          (it) => it && it.type === "file" && it.sha
        );
        for (const it of partItems) {
          const dRes = await ghDeleteContents(driveContentsUrl(repo, branch, it.path), env, message, branch, it.sha);
          if (!dRes.ok && dRes.status !== 404) return githubWriteError(dRes);
          removed += 1;
        }
      } else if (listRes.status !== 404) {
        return githubWriteError(listRes);
      }
      // 2) 删 manifest 自身
      const metaRes = await ghApiRequest(driveContentsUrl(repo, branch, path), null, env, null);
      if (metaRes.status === 404) return driveErr("文件不存在或已被删除", 404);
      if (!metaRes.ok) return githubWriteError(metaRes);
      const meta = await metaRes.json();
      if (!meta || !meta.sha) return driveErr("无法获取文件 sha（GitHub 元数据异常）", 502);
      const res = await ghDeleteContents(driveContentsUrl(repo, branch, path), env, message, branch, meta.sha);
      if (!res.ok) return githubWriteError(res);
      driveListMemo.data = null;
      return driveOk({ ok: true, path, removedParts: removed });
    }

    const metaRes = await ghApiRequest(driveContentsUrl(repo, branch, path), null, env, null);
    if (metaRes.status === 404) return driveErr("文件不存在或已被删除", 404);
    if (!metaRes.ok) return githubWriteError(metaRes);
    const meta = await metaRes.json();
    if (!meta || !meta.sha) return driveErr("无法获取文件 sha（GitHub 元数据异常）", 502);

    const res = await ghDeleteContents(
      driveContentsUrl(repo, branch, path),
      env,
      body.message || `drive: delete ${path}`,
      branch,
      meta.sha
    );
    if (!res.ok) return githubWriteError(res);
    driveListMemo.data = null; // 写成功：立即使列表缓存失效，保证刷新拿到最新内容
    return driveOk({ ok: true, path });
  }

  return driveErr("不支持的云盘操作（list / upload / update / delete / upload:status|part|finish）", 404);
}

/** URL 路径分段编码，避免仓库名/文件名中的特殊字符破坏 URL */
function encodePathSegments(p) {
  return String(p)
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/**
 * 为相册图片生成多个镜像地址（前端加载失败时逐个切换）。
 * useCdn 开启时 jsDelivr 优先，关闭时 GitHub 官方优先，statically 兜底。
 */
/**
 * 为相册图片生成多个镜像地址（前端加载失败时逐个切换）。
 * 同源代理（/api/github/raw/*）置首：经 Cloudflare 边缘缓存，弱网/受限网络下
 * 不依赖浏览器直连 GitHub；CDN 镜像兜底保证代理故障时仍可加载。
 * useCdn 开启时 jsDelivr 次之，关闭时 GitHub 官方次之，statically 兜底。
 */
function buildImageMirrors(repo, branch, path, name) {
  const encoded = `${encodePathSegments(path)}/${encodePathSegments(name)}`;
  const proxy = `/api/github/raw/${repo}/${branch}/${encoded}`;
  const cdn = `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${encoded}`;
  const raw = `https://raw.githubusercontent.com/${repo}/${branch}/${encoded}`;
  const statically = `https://cdn.statically.io/gh/${repo}/${branch}/${encoded}`;
  return [proxy, cdn, raw, statically];
}

function parseFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { data: {}, content };
  const data = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      data[key] = val;
    }
  });
  return { data, content: match[2].trim() };
}

// ============================================================
// 9. Repo —— 领域数据仓储
// ============================================================
const DEFAULT_SITE = {
  title: "Lei Yihan 的个人博客",
  name: "Lei Yihan",
  avatar: "LY",
  avatarBg: "#4f46e5",
  bio: "欢迎来到我的个人主页！这里会记录我的学习与生活。",
  school: "松滋市金松初级中学",
  grade: "七年级",
  className: "6班",
  email: "3872011023@qq.com",
  footer: "© 2026 Lei Yihan",
  autoMode: false,
  useCdn: true,
  githubRepo: "",
  githubBranch: "main",
  githubPostsPath: "posts",
  githubMusicPath: "music",
  githubAlbumPath: "photos",
  githubAlbumConfigFile: "album.json",
  githubTimelineFile: "timeline.json",
  githubMusicListFile: "music.json",
};

const DEFAULT_POSTS = [
  {
    id: "welcome",
    title: "欢迎来到我的博客！",
    content:
      "这是我的第一篇文章。\n\n我是一名七年级的学生，喜欢编程和游戏。\n\n以后会在这里分享我的学习笔记和生活日常。",
    date: "2026-09-01",
  },
];

const DEFAULT_TIMELINE = [
  { id: "t1", date: "2026-09-01", title: "升入七年级", desc: "进入松滋市金松初级中学七年级6班" },
];

const DEFAULT_MUSIC = [{ id: "m1", title: "示例歌曲", artist: "歌手名", url: "", cover: "" }];

/**
 * 双来源合并：远程（GitHub）列表与本地（后台）列表按 id 合并。
 * 本地优先——同一 id 用本地版本，实现「后台发布/编辑覆盖 GitHub 版本」。
 * deletedIds 中的 id 被隐藏（后台删除 GitHub 条目的墓碑记录）。
 */
function mergeById(remoteList, localList, deletedIds) {
  const deleted = new Set(deletedIds || []);
  const map = new Map();
  for (const item of remoteList || []) {
    if (item && item.id && !deleted.has(item.id)) map.set(item.id, item);
  }
  for (const item of localList || []) {
    if (item && item.id) map.set(item.id, item);
  }
  return [...map.values()];
}

const Repo = {
  async getSite(store) {
    const raw = await store.getRaw(KEYS.site);
    if (raw == null) return { ...DEFAULT_SITE };
    const parsed = safeJsonParse(raw);
    return parsed ? { ...DEFAULT_SITE, ...parsed } : { ...DEFAULT_SITE };
  },

  async saveSite(store, site) {
    await store.putJson(KEYS.site, site);
  },

  // ---------- 本地视图（仅后台 KV 数据，供管理后台写操作使用） ----------

  async getLocalPosts(store) {
    const raw = await store.getRaw(KEYS.posts);
    if (raw == null) return [];
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  },

  /**
   * 直读 KV 最新文章列表（绕过请求级 memo）。
   * 用于删除的「获取最新数据→删→写后校验」重试循环：memo 里存的是我方
   * 刚写入的值，只有直读才能反映 KV 的真实最新状态。
   */
  async getLocalPostsFresh(store) {
    const raw = await store.getFreshRaw(KEYS.posts);
    if (raw == null) return [];
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  },

  async getLocalMusic(store) {
    const raw = await store.getRaw(KEYS.music);
    if (raw == null) return [];
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  },

  async getLocalTimeline(store) {
    const raw = await store.getRaw(KEYS.timeline);
    if (raw == null) return [];
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  },

  // ---------- 本地删除墓碑（后台删除 GitHub 来源条目时记录 id） ----------

  async getDeletedIds(store, kind) {
    const raw = await store.getRaw(KEYS.deletedIds);
    const parsed = safeJsonParse(raw, {}) || {};
    const list = parsed[kind];
    return Array.isArray(list) ? list : [];
  },

  async addDeletedId(store, kind, id) {
    const raw = await store.getRaw(KEYS.deletedIds);
    const parsed = safeJsonParse(raw, {}) || {};
    const list = Array.isArray(parsed[kind]) ? parsed[kind] : [];
    if (!list.includes(id)) list.push(id);
    parsed[kind] = list;
    await store.putJson(KEYS.deletedIds, parsed);
  },

  async removeDeletedId(store, kind, id) {
    const raw = await store.getRaw(KEYS.deletedIds);
    const parsed = safeJsonParse(raw, {}) || {};
    const list = Array.isArray(parsed[kind]) ? parsed[kind] : [];
    if (!list.includes(id)) return;
    parsed[kind] = list.filter((x) => x !== id);
    await store.putJson(KEYS.deletedIds, parsed);
  },

  // ---------- 合并视图（前台展示：GitHub + 后台，本地优先） ----------

  async getPosts(store) {
    const cached = store.jsonMemo.get(VIEW_KEY.posts);
    if (cached != null) return cached;

    const site = await Repo.getSite(store);
    const local = await Repo.getLocalPosts(store);
    const ghEnabled = !!(site.autoMode && site.githubRepo);

    let posts = local;
    let ghFailed = false;
    if (ghEnabled) {
      try {
        const [gh, deleted] = await Promise.all([
          loadPostsFromGithub(store, site),
          Repo.getDeletedIds(store, "posts"),
        ]);
        posts = mergeById(gh, local, deleted);
      } catch (e) {
        // GitHub 不可达：降级为仅后台文章（多数情况已被 stale 缓存兜底）
        console.warn("从 GitHub 加载文章失败，降级为后台文章:", e);
        ghFailed = true;
        posts = local;
      }
    }
    // 完全为空时展示默认欢迎文章（纯后台模式行为不变；
    // GitHub 正常但仓库无文章则是用户主动清空，展示空列表）
    if (posts.length === 0 && (!ghEnabled || ghFailed)) posts = DEFAULT_POSTS;

    store.jsonMemo.set(VIEW_KEY.posts, posts);
    return posts;
  },

  async savePosts(store, posts) {
    await store.putJson(KEYS.posts, posts);
  },

  async getMessages(store) {
    return await store.getJson(KEYS.messages, []);
  },

  async getComments(store, postId) {
    return await store.getJson(KEYS.comments(postId), []);
  },

  async saveComments(store, postId, comments) {
    await store.putJson(KEYS.comments(postId), comments);
  },

  async getMusic(store) {
    const cached = store.jsonMemo.get(VIEW_KEY.music);
    if (cached != null) return cached;

    const site = await Repo.getSite(store);
    const local = await Repo.getLocalMusic(store);
    const ghEnabled = !!(site.autoMode && site.githubRepo);

    let music = local;
    let ghFailed = false;
    if (ghEnabled) {
      try {
        const [gh, deleted] = await Promise.all([
          loadMusicFromGithub(store, site),
          Repo.getDeletedIds(store, "music"),
        ]);
        music = mergeById(gh, local, deleted);
      } catch (e) {
        console.warn("从 GitHub 加载音乐失败，降级为后台音乐:", e);
        ghFailed = true;
        music = local;
      }
    }
    if (music.length === 0 && (!ghEnabled || ghFailed)) music = DEFAULT_MUSIC;

    store.jsonMemo.set(VIEW_KEY.music, music);
    return music;
  },

  async getTimeline(store) {
    const cached = store.jsonMemo.get(VIEW_KEY.timeline);
    if (cached != null) return cached;

    const site = await Repo.getSite(store);
    const local = await Repo.getLocalTimeline(store);
    const ghEnabled = !!(site.autoMode && site.githubRepo);

    let timeline = local;
    let ghFailed = false;
    if (ghEnabled) {
      try {
        const [gh, deleted] = await Promise.all([
          loadTimelineFromGithub(store, site),
          Repo.getDeletedIds(store, "timeline"),
        ]);
        timeline = mergeById(gh, local, deleted);
      } catch (e) {
        console.warn("从 GitHub 加载时间线失败，降级为后台时间线:", e);
        ghFailed = true;
        timeline = local;
      }
    }
    if (timeline.length === 0 && (!ghEnabled || ghFailed)) timeline = DEFAULT_TIMELINE;

    store.jsonMemo.set(VIEW_KEY.timeline, timeline);
    return timeline;
  },

  /**
   * 点赞总数索引。
   * 旧版本按文章分散存储为 like_<id>，读取需 1 次 list + N 次 get（N+1 问题）。
   * 这里统一迁移到单个 likes 索引键，读取降为 1 次；历史键保留不删，可无损回退。
   */
  async getLikesMap(store) {
    const cached = store.jsonMemo.get(KEYS.likes);
    if (cached != null) return cached;

    const raw = await store.getRaw(KEYS.likes);
    const parsed = raw == null ? null : safeJsonParse(raw, null);
    if (parsed && typeof parsed === "object") {
      store.jsonMemo.set(KEYS.likes, parsed);
      return parsed;
    }

    // 首次访问：合并历史 like_<id> 键，写入统一索引。
    // 之后点赞会双写索引与遗留键（见 likePost），回退旧版 Worker 不会丢计数。
    const legacy = await store.list(KEYS.prefix.legacyLike);
    const merged = {};
    if (legacy.length > 0) {
      const values = await Promise.all(legacy.map((k) => store.getRaw(k.name)));
      legacy.forEach((k, i) => {
        const id = k.name.slice(KEYS.prefix.legacyLike.length);
        if (id) merged[id] = safeParseInt(values[i]);
      });
    }
    await store.putJson(KEYS.likes, merged);
    return merged;
  },

  async saveLikesMap(store, map) {
    await store.putJson(KEYS.likes, map);
  },

  async getViewsMap(store) {
    const cached = store.jsonMemo.get(KEYS.views);
    if (cached != null) return cached;
    return await store.getJson(KEYS.views, {});
  },

  async saveViewsMap(store, map) {
    await store.putJson(KEYS.views, map);
  },

  async getLinks(store) {
    const links = await store.getJson(KEYS.links, []);
    return Array.isArray(links) ? links : [];
  },

  async saveLinks(store, links) {
    await store.putJson(KEYS.links, links);
  },

  async getGameScores(store) {
    const scores = await store.getJson(KEYS.gameScores, {});
    return scores && typeof scores === "object" ? scores : {};
  },

  async saveGameScores(store, scores) {
    await store.putJson(KEYS.gameScores, scores);
  },

  /** 导出全部评论：{ [postId]: Comment[] } */
  async getAllComments(store) {
    const keys = await store.list(KEYS.prefix.comments);
    const entries = await Promise.all(
      keys.map(async (k) => {
        const postId = k.name.slice(KEYS.prefix.comments.length);
        const comments = safeJsonParse(await store.getRaw(k.name), []) || [];
        return [postId, comments];
      })
    );
    return Object.fromEntries(entries);
  },
};

async function loadPostsFromGithub(store, site) {
  const useCdn = site.useCdn !== false;
  const branch = site.githubBranch || "main";
  const postsPath = site.githubPostsPath || "posts";
  const files = await githubFetch(store, site.githubRepo, postsPath, branch, useCdn);
  const mdExts = [".md", ".markdown"];
  // v8.0：排除仓库自带的说明性文件（README/CHANGELOG/LICENSE 等）——
  // 这些是给仓库访客看的，不是文章；此前 posts/README.md 会被当成一篇名为
  // 「README」的文章渲染到博客列表与首页。
  const NON_POST_NAMES = /^(readme|changelog|license|contributing|authors)(\.[a-z]+)?$/i;
  const mdFiles = files.filter(
    (f) =>
      f.type === "file" &&
      mdExts.some((ext) => f.name.toLowerCase().endsWith(ext)) &&
      !NON_POST_NAMES.test(f.name)
  );
  const parsed = await Promise.all(
    mdFiles.map(async (f) => {
      try {
        const raw = await githubFetchRaw(store, site.githubRepo, `${postsPath}/${f.name}`, branch, useCdn);
        const { data, content } = parseFrontMatter(raw);
        const rawId = data.id || f.name.replace(/\.(md|markdown)$/i, "");
        return {
          id: rawId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, CONFIG.limit.id) || "post",
          title: data.title || rawId,
          content: content.trim(),
          date: data.date || new Date().toISOString().split("T")[0],
          desc: data.desc || "",
        };
      } catch (e) {
        console.warn("解析文章失败:", f.name, e);
        return null;
      }
    })
  );
  return sortByDateDesc(parsed.filter((p) => p !== null));
}

/** 仓库内文件 → 同源代理 URL：经 /api/github/raw/* 由 Worker 转发。
 *  同源的意义：Service Worker 只接管同源请求，SW 可缓存、断网可播、
 *  无跨域 CORS 问题（音乐播放器的 fetch→Blob 管道仅对同源资源生效）。 */
function githubProxyUrl(repo, branch, path) {
  return `/api/github/raw/${repo}/${branch}/${encodePathSegments(path)}`;
}

/** 歌曲/封面链接三通道解析：
 *  1) url 为 http(s) 绝对地址 → 原样保留（用户显式配置的外链）
 *  2) 提供 file 相对路径 → 拼成同源代理 URL（推荐：可缓存可离线）
 *  3) 都没有 → 返回空串（该条目被过滤） */
function resolveGithubAssetUrl(url, file, repo, branch, basePath) {
  if (url && isValidUrl(url)) return String(url).trim();
  if (file) return githubProxyUrl(repo, branch, `${basePath}/${String(file).replace(/^\/+/, "")}`);
  return "";
}

  /** 递归枚举仓库目录内文件（限深 2 层，防异常目录结构打爆配额）。
 *  返回 [{ name, path, size }]，path 为相对 dir 的路径（可含子目录）。 */
async function listRepoFilesRecursive(store, repo, dir, branch, useCdn, depth = 0) {
  const files = await githubFetch(store, repo, dir, branch, useCdn);
  const out = [];
  for (const f of files || []) {
    if (f.type === "file") {
      out.push({ name: f.name, path: f.name, size: f.size || 0 });
    } else if (f.type === "dir" && depth < 2) {
      const sub = await listRepoFilesRecursive(store, repo, `${dir}/${f.name}`, branch, useCdn, depth + 1);
      for (const s of sub) out.push({ ...s, path: `${f.name}/${s.path}` });
    }
  }
  return out;
}

  /**
   * 相册数据装配（v3.0 动态相册）：
   *  1. 递归枚举相册目录（子目录即分类）
   *  2. 若目录内存在 album.json（或自定义配置文件名），读取分类/标题/日期/排序配置
   *  3. 配置条目按作者顺序排列，目录中未配置的文件自动补录（子目录名作分类）
   *  返回 { photos: [{name,title,category,date,mirrors}], categories: [{id,name,count}] }
   *  无 album.json 时退化为纯目录模式（旧行为），零额外请求。
   */
async function loadAlbumFromGithub(store, site) {
  const useCdn = site.useCdn !== false;
  const branch = site.githubBranch || "main";
  const albumPath = site.githubAlbumPath || "photos";
  const configName = site.githubAlbumConfigFile || "album.json";
  const imgExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];

  const files = await listRepoFilesRecursive(store, site.githubRepo, albumPath, branch, useCdn);
  const images = files.filter((f) => imgExts.some((ext) => f.path.toLowerCase().endsWith(ext)));
  const byPath = new Map(images.map((f) => [f.path, f]));

  // 仅在目录中确实存在配置文件时才拉取内容（无配置时零额外请求）
  let config = null;
  if (files.some((f) => f.path === configName)) {
    try {
      const raw = await githubFetchRaw(store, site.githubRepo, `${albumPath}/${configName}`, branch, useCdn);
      config = safeJsonParse(raw, null);
    } catch (e) {
      config = null; // 配置损坏：退化为目录模式，不阻塞相册
    }
  }

  // 分类 id → 显示名（album.json 的 categories 可覆盖）
  const catNames = new Map();
  if (config && Array.isArray(config.categories)) {
    for (const c of config.categories) {
      if (c && c.id != null) catNames.set(String(c.id), String(c.name || c.id));
    }
  }

  const photos = [];
  const catCount = new Map();
  const bump = (id) => catCount.set(id, (catCount.get(id) || 0) + 1);

  // 1) album.json 显式配置条目（保留作者排序意图）
  if (config && Array.isArray(config.photos)) {
    for (const p of config.photos) {
      const rel = String((p && p.file) || "").replace(/^\/+/, "");
      if (!rel || !byPath.has(rel)) continue; // 配置了但仓库没有：跳过
      const cat = String((p && p.category) || "all");
      photos.push({
        name: rel,
        title: String((p && p.title) || "").slice(0, 200),
        category: cat,
        date: String((p && p.date) || "").slice(0, 20),
        mirrors: buildImageMirrors(site.githubRepo, branch, albumPath, rel),
      });
      byPath.delete(rel);
      bump(cat);
    }
  }
  // 2) 目录中未配置的文件：子目录名即分类，顶层文件归 all，按路径倒序追加
  const rest = [...byPath.values()].sort((a, b) => b.path.localeCompare(a.path));
  for (const f of rest) {
    const seg = f.path.split("/");
    const cat = seg.length > 1 ? seg[0] : "all";
    photos.push({
      name: f.path,
      title: "",
      category: cat,
      date: "",
      mirrors: buildImageMirrors(site.githubRepo, branch, albumPath, f.path),
    });
    bump(cat);
  }

  // 3) 分类列表：all 恒为首位
  const categories = [{ id: "all", name: "全部", count: photos.length }];
  for (const [id, count] of catCount) {
    if (id === "all") continue;
    categories.push({ id, name: catNames.get(id) || id, count });
  }
  return { photos, categories };
}

async function loadMusicFromGithub(store, site) {
  const useCdn = site.useCdn !== false;
  const branch = site.githubBranch || "main";
  const repo = site.githubRepo;
  const musicPath = site.githubMusicPath || "music";
  const musicListFile = site.githubMusicListFile || "music.json";
  try {
    const raw = await githubFetchRaw(store, repo, musicListFile, branch, useCdn);
    const list = safeJsonParse(raw, []);
    return (Array.isArray(list) ? list : [])
      .map((m, i) => ({
        id: (m.id ? String(m.id).replace(/[^a-zA-Z0-9_.-]/g, "_") : "gm" + i).slice(0, CONFIG.limit.id),
        title: m.title || "未知歌曲",
        artist: m.artist || "",
        // 支持两种配置写法：url 绝对外链，或 file 仓库内相对路径（自动走同源代理）
        url: resolveGithubAssetUrl(m.url, m.file, repo, branch, musicPath),
        cover: resolveGithubAssetUrl(m.cover, m.coverFile, repo, branch, musicPath),
        source: "github",
      }))
      .filter((m) => m.url && (isValidUrl(m.url) || m.url.startsWith("/")));
  } catch (e) {
    // music.json 不存在时，回退到扫描音频目录（URL 同源代理化：离线可播的关键）
    const files = await githubFetch(store, repo, musicPath, branch, useCdn);
    const audioExts = [".mp3", ".wav", ".ogg", ".m4a", ".flac"];
    return files
      .filter((f) => f.type === "file" && audioExts.some((ext) => f.name.toLowerCase().endsWith(ext)))
      .map((f, i) => ({
        id: "gm" + i,
        title: f.name.replace(/\.[^.]+$/, ""),
        artist: "",
        url: githubProxyUrl(repo, branch, `${musicPath}/${f.name}`),
        cover: "",
        source: "github",
      }));
  }
}

async function loadTimelineFromGithub(store, site) {
  const useCdn = site.useCdn !== false;
  const branch = site.githubBranch || "main";
  const timelineFile = site.githubTimelineFile || "timeline.json";
  const raw = await githubFetchRaw(store, site.githubRepo, timelineFile, branch, useCdn);
  const list = safeJsonParse(raw, []);
  return (Array.isArray(list) ? list : [])
    .map((t, i) => ({
      id: (t.id ? String(t.id).replace(/[^a-zA-Z0-9_.-]/g, "_") : "gt" + i).slice(0, CONFIG.limit.id),
      date: t.date || "",
      title: t.title || "",
      desc: t.desc || "",
    }))
    .filter((t) => t.date && t.title);
}

// ============================================================
// 10. Services —— 登录、限流等公共业务
// ============================================================
/**
 * 后台口令（v8.0 安全止血）：只取环境变量 ADMIN_PASSWORD，未配置返回 null。
 * 调用方必须对 null 返回 500「服务端未配置密钥」——**绝不回退任何硬编码值**。
 * 历史教训：旧版回退 CONFIG.admin.fallbackPassword，而本仓库是公开仓库，
 * 等于把后台密码公开发布；现改为缺失即拒绝服务，风险前移到部署配置。
 */
function getAdminPassword(env) {
  const pw = env && env.ADMIN_PASSWORD;
  return pw ? String(pw) : null;
}

/** 后台口令缺失时的统一提示（requireAuth / login 两个入口共用，措辞一致） */
const ADMIN_UNCONFIGURED_MSG =
  "服务端未配置密钥（ADMIN_PASSWORD）：请在 Cloudflare Pages 环境变量中配置后重试";

async function checkLock(store, ip) {
  const key = KEYS.lock(ip);
  const data = await store.getRaw(key);
  if (!data) return { locked: false };
  const lock = safeJsonParse(data);
  if (!lock) {
    await store.delete(key);
    return { locked: false };
  }
  if (lock.locked) {
    if (Date.now() - lock.lockTime < CONFIG.admin.lockSeconds * 1000) {
      const remaining = Math.ceil(
        (CONFIG.admin.lockSeconds * 1000 - (Date.now() - lock.lockTime)) / 60000
      );
      return { locked: true, remaining };
    }
    // 锁定已过期：重置计数，允许重新尝试
    await store.delete(key);
    return { locked: false };
  }
  // 有失败记录但尚未锁定：必须保留计数，
  // 否则每次登录前都会清零，防爆破（maxAttempts 次锁定）永远无法触发
  return { locked: false, attempts: lock.attempts || 0 };
}

async function recordFail(store, ip) {
  const key = KEYS.lock(ip);
  const data = await store.getRaw(key);
  let attempts = data ? safeJsonParse(data, { attempts: 0 }).attempts || 0 : 0;
  attempts++;
  const locked = attempts >= CONFIG.admin.maxAttempts;
  await store.putRaw(
    key,
    JSON.stringify({ attempts, locked, lockTime: locked ? Date.now() : 0 }),
    { expirationTtl: CONFIG.admin.lockSeconds + 60 }
  );
  return { locked, remaining: Math.max(0, CONFIG.admin.maxAttempts - attempts) };
}

/**
 * 通用频率限制：冷却时间 + 每小时次数。
 * 两次 KV 读取并行发起；计数写入为非关键路径，交给 waitUntil 兜底。
 */
async function checkRateLimit(store, cooldownKey, hourKey, cooldownSeconds, hourLimit, busyMessage) {
  const now = Date.now();
  const [lastRaw, hourRaw] = await Promise.all([
    store.getRaw(cooldownKey),
    store.getRaw(hourKey),
  ]);

  if (lastRaw) {
    const lastTime = safeParseInt(lastRaw, 0);
    if (lastTime > 0 && lastTime <= now && now - lastTime < cooldownSeconds * 1000) {
      const waitSec = Math.ceil((cooldownSeconds * 1000 - (now - lastTime)) / 1000);
      return { allowed: false, reason: `${busyMessage}（还需等待 ${waitSec} 秒）` };
    }
  }

  const currentHour = Math.floor(now / 3600000);
  let hourData = hourRaw ? safeJsonParse(hourRaw, null) : null;
  if (hourData && hourData.hour === currentHour) {
    if (hourData.count >= hourLimit) {
      return { allowed: false, reason: "本小时操作次数已达上限，请稍后再试" };
    }
    hourData.count++;
  } else {
    hourData = { hour: currentHour, count: 1 };
  }

  store.defer(store.kv.put(cooldownKey, now.toString(), { expirationTtl: cooldownSeconds * 2 }));
  store.defer(store.kv.put(hourKey, JSON.stringify(hourData), { expirationTtl: 3700 }));
  return { allowed: true };
}

async function requireAuth(ctx) {
  const { request, env, store, ip } = ctx;
  const lock = await checkLock(store, ip);
  if (lock.locked) fail(`账号已锁定，请 ${lock.remaining} 分钟后再试`, 429);

  const authHeader = request.headers.get("Authorization");
  // 未携带 Authorization：匿名访问（误触/扫描），不计入登录失败次数，
  // 避免共享网络（校园网/蜂窝网 NAT）下他人请求把博主本人误锁
  if (!authHeader) fail("未授权：请先登录管理后台", 401);
  if (authHeader.length > CONFIG.admin.maxTokenLength) {
    const result = await recordFail(store, ip);
    fail(
      result.locked
        ? `失败次数过多，账号已锁定 15 分钟`
        : `密码错误，还剩 ${result.remaining} 次尝试机会`,
      401
    );
  }

  const adminPw = getAdminPassword(env);
  // 服务端未配置 ADMIN_PASSWORD：直接 500，不做口令比对（也不能比对）
  if (!adminPw) fail(ADMIN_UNCONFIGURED_MSG, 500);

  if (authHeader !== `Bearer ${adminPw}`) {
    const result = await recordFail(store, ip);
    fail(
      result.locked
        ? `失败次数过多，账号已锁定 15 分钟`
        : `密码错误，还剩 ${result.remaining} 次尝试机会`,
      401
    );
  }

  await store.delete(KEYS.lock(ip));
}

// ============================================================
// 11. Handlers —— 接口处理函数
// ------------------------------------------------------------
// 约定：返回值会被自动序列化为 200 JSON；
//       需要 ETag / 自定义响应的直接返回 Response；
//       出错一律 throw HttpError（用 fail(...)）。
// ============================================================

/** 取出并校验路径参数 id */
function pathId(ctx, errorMessage) {
  const id = ctx.params.id;
  if (!validateId(id)) fail(errorMessage, 400);
  return id;
}

/** 校验文章存在并返回 */
async function findPostOrFail(store, id) {
  const posts = await Repo.getPosts(store);
  const post = posts.find((p) => p.id === id);
  if (!post) fail("文章不存在", 404);
  return post;
}

const handlers = {
  // ---------- 站点 ----------
  async getSite(ctx) {
    return await Repo.getSite(ctx.store);
  },

  async updateSite(ctx) {
    const body = ctx.body;
    const allowed = [
      "title", "name", "avatar", "avatarBg", "bio", "school", "grade", "className",
      "email", "footer", "autoMode", "useCdn", "githubRepo", "githubBranch",
      "githubPostsPath", "githubMusicPath", "githubAlbumPath",
      "githubTimelineFile", "githubMusicListFile",
    ];
    const existing = await Repo.getSite(ctx.store);
    const site = { ...existing };
    const updates = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        updates[key] =
          key === "autoMode" || key === "useCdn"
            ? body[key] === true || body[key] === "true"
            : body[key];
      }
    }

    if (updates.githubRepo !== undefined && !validateGithubRepo(updates.githubRepo))
      fail("GitHub 仓库格式不正确，应为：用户名/仓库名");
    if (updates.githubBranch !== undefined && !validateGithubBranch(updates.githubBranch))
      fail("分支名格式不正确");
    if (updates.githubPostsPath !== undefined && !validatePath(updates.githubPostsPath))
      fail("文章路径格式不正确");
    if (updates.githubMusicPath !== undefined && !validatePath(updates.githubMusicPath))
      fail("音乐路径格式不正确");
    if (updates.githubAlbumPath !== undefined && !validatePath(updates.githubAlbumPath))
      fail("相册路径格式不正确");
    if (updates.githubTimelineFile !== undefined && !validateFileName(updates.githubTimelineFile))
      fail("时间线文件名格式不正确");
    if (updates.githubMusicListFile !== undefined && !validateFileName(updates.githubMusicListFile))
      fail("音乐列表文件名格式不正确");
    if (updates.email !== undefined && !validateEmail(updates.email)) fail("邮箱格式不正确");

    const maxLenMap = {
      title: 100, name: 50, avatar: 10, bio: 500, school: 100,
      grade: 50, className: 50, footer: 200,
    };
    for (const key of Object.keys(maxLenMap)) {
      if (updates[key] !== undefined) updates[key] = truncate(updates[key], maxLenMap[key]);
    }

    Object.assign(site, updates);
    await Repo.saveSite(ctx.store, site);
    // GitHub 配置可能变化，清空其缓存
    await ctx.store.deletePrefix(KEYS.prefix.github);
    return { success: true };
  },

  async refreshGithub(ctx) {
    await ctx.store.deletePrefix(KEYS.prefix.github);
    const purged = await ghProxyCachePurge(); // 同步清理 /api/github/* 边缘缓存
    return { success: true, message: `GitHub 缓存已刷新${purged ? `（含 ${purged} 条代理缓存）` : ""}` };
  },

  /**
   * GitHub 连接状态（供管理后台排查「连接不稳定」问题）。
   * 返回仓库配置 + 最近一次拉取成功/失败记录 + 是否正在使用过期缓存。
   */
  async getGithubStatus(ctx) {
    const site = await Repo.getSite(ctx.store);
    const raw = await ctx.store.getRaw(KEYS.ghStatus);
    const status = safeJsonParse(raw, {}) || {};
    return {
      configured: !!(site.autoMode && site.githubRepo),
      autoMode: !!site.autoMode,
      repo: site.githubRepo || "",
      branch: site.githubBranch || "main",
      useCdn: site.useCdn !== false,
      // Token 配置态（不回传 Token 本体）：决定 5000/时 与 60/时 配额档位
      tokenConfigured: !!ghToken(ctx.env),
      // 同源代理端点说明（供后台排查「请求走哪条路」）
      proxy: "/api/github/api/* 与 /api/github/raw/*",
      ...status,
    };
  },

  /**
   * 相册照片列表（经 Worker 多源故障转移拉取，浏览器只同源通信）。
   * 每张照片返回多个镜像地址，前端逐个兜底——用户本机 DNS 加速失效时，
   * 图片加载会自动切换到下一个镜像。
   */
  async listAlbumPhotos(ctx) {
    const site = await Repo.getSite(ctx.store);
    if (!site.githubRepo) return { photos: [], categories: [], configured: false };

    const albumPath = site.githubAlbumPath || "photos";
    try {
      const album = await loadAlbumFromGithub(ctx.store, site);
      const category = ctx.url.searchParams.get("category");
      let photos = album.photos;
      if (category && category !== "all") {
        photos = photos.filter((p) => p.category === category);
      }

      // 分页模式（?offset=&limit=）：供前端无限滚动逐批拉取
      const limitParam = ctx.url.searchParams.get("limit");
      if (limitParam !== null) {
        const offset = Math.max(0, safeParseInt(ctx.url.searchParams.get("offset"), 0));
        const limit = Math.min(Math.max(safeParseInt(limitParam, 24), 1), 100);
        const slice = photos.slice(offset, offset + limit);
        const nextOffset = offset + slice.length;
        return {
          photos: slice,
          categories: album.categories,
          total: photos.length,
          hasMore: nextOffset < photos.length,
          nextOffset: nextOffset < photos.length ? nextOffset : null,
          configured: true,
        };
      }
      // 无分页参数：全量返回（兼容管理后台等既有调用方）
      return { photos, categories: album.categories, configured: true, total: photos.length };
    } catch (e) {
      throw new HttpError(502, `相册加载失败：${String((e && e.message) || e)}`);
    }
  },

  // ---------- 统计 ----------
  async getStats(ctx) {
    const [posts, messages, timeline, likesMap, viewsMap] = await Promise.all([
      Repo.getPosts(ctx.store),
      Repo.getMessages(ctx.store),
      Repo.getTimeline(ctx.store),
      Repo.getLikesMap(ctx.store),
      Repo.getViewsMap(ctx.store),
    ]);
    const totalLikes = posts.reduce((sum, p) => sum + (likesMap[p.id] || 0), 0);
    const totalViews = posts.reduce((sum, p) => sum + (viewsMap[p.id] || 0), 0);
    return {
      posts: posts.length,
      messages: messages.length,
      timeline: timeline.length,
      totalLikes,
      totalViews,
    };
  },

  // ---------- 文章 ----------
  async listPosts(ctx) {
    const [posts, likesMap, viewsMap] = await Promise.all([
      Repo.getPosts(ctx.store),
      Repo.getLikesMap(ctx.store),
      Repo.getViewsMap(ctx.store),
    ]);
    const enriched = posts.map((p) => ({
      ...p,
      likes: likesMap[p.id] || 0,
      views: viewsMap[p.id] || 0,
    }));

    const search = ctx.url.searchParams.get("q");
    if (search) {
      if (!validateSearchQuery(search)) fail("搜索关键词格式不正确", 400);
      const q = search.toLowerCase();
      const filtered = enriched.filter(
        (p) =>
          (p.title || "").toLowerCase().includes(q) ||
          (p.content || "").toLowerCase().includes(q)
      );
      return sortByDateDesc(filtered);
    }

    // withSource=1：附带每篇文章的来源标记（供管理后台展示「GitHub/后台」徽章）。
    // 不传该参数时响应结构与之前完全一致。
    if (ctx.url.searchParams.get("withSource") === "1") {
      const ghIds = [];
      const site = await Repo.getSite(ctx.store);
      if (site.autoMode && site.githubRepo) {
        try {
          const gh = await loadPostsFromGithub(ctx.store, site);
          gh.forEach((p) => ghIds.push(p.id));
        } catch {
          /* 来源标记失败不影响列表本身 */
        }
      }
      return jsonEtagResponse(ctx.request, { posts: sortByDateDesc(enriched), ghIds });
    }
    return jsonEtagResponse(ctx.request, sortByDateDesc(enriched));
  },

  async getPost(ctx) {
    const id = pathId(ctx, "无效的文章ID");
    const [post, likesMap, viewsMap] = await Promise.all([
      findPostOrFail(ctx.store, id),
      Repo.getLikesMap(ctx.store),
      Repo.getViewsMap(ctx.store),
    ]);
    return jsonEtagResponse(ctx.request, {
      ...post,
      likes: likesMap[id] || 0,
      views: viewsMap[id] || 0,
      liked: false,
    });
  },

  /** 热门文章排行：按阅读量优先、点赞次之 */
  async listPopular(ctx) {
    const requested = safeParseInt(ctx.url.searchParams.get("limit"), CONFIG.defaults.popularLimit);
    const limit = Math.min(Math.max(requested, 1), CONFIG.limit.popularMax);
    const [posts, likesMap, viewsMap] = await Promise.all([
      Repo.getPosts(ctx.store),
      Repo.getLikesMap(ctx.store),
      Repo.getViewsMap(ctx.store),
    ]);
    return posts
      .map((p) => ({
        id: p.id,
        title: p.title,
        date: p.date,
        desc: p.desc || "",
        likes: likesMap[p.id] || 0,
        views: viewsMap[p.id] || 0,
      }))
      .sort((a, b) => b.views - a.views || b.likes - a.likes)
      .slice(0, limit);
  },

  async savePost(ctx) {
    // 文章写操作串行化：同一 isolate 内多篇文章的增/改绝不交错
    // （KV 无 CAS，「读-改-写」交错会丢更新——连点发布曾因此产生重复文章）
    return withWriteLock(KEYS.posts, async () => {
      const body = ctx.body;
      // 后台写操作只针对本地文章；GitHub 文章被编辑时先落入本地（本地优先覆盖）
      const posts = await Repo.getLocalPosts(ctx.store);

      if (body.id) {
        if (!validateId(body.id)) fail("无效的文章ID", 400);
        let idx = posts.findIndex((p) => p.id === body.id);
        if (idx === -1) {
          // 本地没有：可能来自 GitHub 同步（含被墓碑隐藏的）。取仓库当前版本落入本地，
          // 此后本地版本覆盖 GitHub 版本（合并规则：本地优先）。
          const merged = await Repo.getPosts(ctx.store);
          let remote = merged.find((p) => p.id === body.id);
          if (!remote) {
            const site = await Repo.getSite(ctx.store);
            if (site.autoMode && site.githubRepo) {
              try {
                remote = (await loadPostsFromGithub(ctx.store, site)).find((p) => p.id === body.id);
              } catch {
                /* 仓库不可达时无法恢复，按不存在处理 */
              }
            }
          }
          if (!remote) fail("文章不存在", 404);
          posts.push({
            id: remote.id,
            title: remote.title,
            content: remote.content,
            date: remote.date,
            desc: remote.desc || "",
          });
          idx = posts.length - 1;
          // 若曾删除过同 id 的 GitHub 文章，重新编辑即恢复，清除墓碑
          await Repo.removeDeletedId(ctx.store, "posts", body.id);
        }

        // 先校验，再写入，避免校验失败时留下被污染的数据
        const patch = {};
        for (const k of ["title", "content", "date", "desc"]) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        // 标题/内容不允许置空（与新建分支保持一致的空值拒绝语义）
        if (patch.title !== undefined) {
          const t = String(patch.title).trim();
          if (!t) fail("标题不能为空");
          if (t.length > CONFIG.limit.postTitle) fail("标题不能超过200字");
        }
        if (patch.content !== undefined) {
          const c = String(patch.content).trim();
          if (!c) fail("内容不能为空");
          if (c.length > CONFIG.limit.postContent) fail("内容不能超过50000字");
        }
        if (patch.desc !== undefined && String(patch.desc).length > CONFIG.limit.postDesc) fail("摘要不能超过500字");
        if (patch.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) fail("日期格式不正确");
        if (patch.content !== undefined) {
          const sanitized = sanitizeUserContent(patch.content);
          if (sanitized === null) fail("文章内容包含不安全的 HTML 或脚本代码", 400);
          patch.content = sanitized;
        }
        if (patch.desc !== undefined) patch.desc = truncate(patch.desc, CONFIG.limit.postDesc);

        Object.assign(posts[idx], patch);
      } else {
        if (!body.title || !body.content) fail("标题和内容不能为空");
        const title = String(body.title).trim();
        const content = String(body.content).trim();
        if (!title) fail("标题不能为空");
        if (!content) fail("内容不能为空");
        if (title.length > CONFIG.limit.postTitle) fail("标题不能超过200字");
        if (content.length > CONFIG.limit.postContent) fail("内容不能超过50000字");
        if (body.desc && body.desc.length > CONFIG.limit.postDesc) fail("摘要不能超过500字");
        if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) fail("日期格式不正确");

        const sanitized = sanitizeUserContent(content);
        if (sanitized === null) fail("文章内容包含不安全的 HTML 或脚本代码", 400);

        // ---- P0 防重：同标题+同内容的「新建」在窗口期内直接 409 拦截 ----
        // 前端发布锁（按钮置灰）是第一道防线；这里是后端兜底：哪怕锁被绕过
        // （脚本连点/多标签/锁失效），也绝不允许同一篇文章被创建出第二篇。
        const fp = simpleHash(title) + "_" + simpleHash(content);
        const dedupeKey = KEYS.postDedupe(fp);
        const recentRaw = await ctx.store.kv.get(dedupeKey);
        if (recentRaw) {
          const recent = safeJsonParse(recentRaw, null);
          return new Response(
            JSON.stringify({
              success: false,
              error: "重复提交已拦截：相同文章刚刚已发布（如需再次发布请稍后重试）",
              duplicate: true,
              id: recent && recent.id ? recent.id : undefined,
            }),
            { status: 409, headers: buildHeaders() }
          );
        }

        const newId = genId("p");
        posts.push({
          id: newId,
          title,
          content: sanitized,
          date: body.date || new Date().toISOString().split("T")[0],
          desc: (body.desc || "").slice(0, CONFIG.limit.postDesc),
        });

        await Repo.savePosts(ctx.store, posts);
        // 落防重指纹（KV TTL 窗口）：写入成功后才记录，失败不留痕
        await ctx.store.kv.put(
          dedupeKey,
          JSON.stringify({ id: newId, at: Date.now() }),
          { expirationTtl: CONFIG.posts.dedupeWindowSeconds }
        );
        return { success: true, id: newId };
      }

      await Repo.savePosts(ctx.store, posts);
      return { success: true };
    });
  },

  async deletePost(ctx) {
    const id = pathId(ctx, "无效的文章ID");
    // 与 savePost 共用同一把写锁：增/删操作全程串行，彻底杜绝
    // 「读取→过滤→整体写回」交错导致的丢更新与已删条目复活
    // （线上「连点删除后文章又出现/删不干净」的根因）。
    return withWriteLock(KEYS.posts, async () => {
      // 直读 KV 最新列表——等价于 GitHub Contents 409 自愈里的「重新获取最新 SHA」：
      // 不用请求级 memo 里的旧值，始终以 KV 当前真实状态为基准。
      let local = await Repo.getLocalPostsFresh(ctx.store);
      const site = await Repo.getSite(ctx.store);
      const ghEnabled = !!(site.autoMode && site.githubRepo);
      const inLocal = local.some((p) => p.id === id);
      if (!inLocal) {
        // 本地没有：确认它确实存在于合并视图（可能来自 GitHub），否则 404
        const merged = await Repo.getPosts(ctx.store);
        if (!merged.some((p) => p.id === id)) fail("文章不存在", 404);
      }

      // 读-改-写 + 写后校验重试：KV 最终一致性下，删除写入后直读确认生效；
      // 未生效（读到旧值/被并发旧数据覆盖）则基于最新数据重试，次数有界。
      let unverified = false;
      if (inLocal) {
        for (let attempt = 1; attempt <= CONFIG.posts.deleteVerifyRetries; attempt++) {
          await Repo.savePosts(ctx.store, local.filter((p) => p.id !== id));
          local = await Repo.getLocalPostsFresh(ctx.store);
          if (!local.some((p) => p.id === id)) {
            unverified = false;
            break;
          }
          unverified = true; // 仍未生效：下一轮用刚拉到的最新数据重试
        }
      }

      // GitHub 同步开启时一律写入墓碑：该 id 若来自仓库，仅删本地会让仓库版本在合并视图重新出现。
      // 同步关闭时合并视图不存在，无需墓碑；重新保存同 id 内容会清除墓碑。
      if (ghEnabled) await Repo.addDeletedId(ctx.store, "posts", id);
      // 同步清理该文章的点赞 / 阅读量
      const [likesMap, viewsMap] = await Promise.all([
        Repo.getLikesMap(ctx.store),
        Repo.getViewsMap(ctx.store),
      ]);
      delete likesMap[id];
      delete viewsMap[id];
      await Promise.all([
        Repo.saveLikesMap(ctx.store, likesMap),
        Repo.saveViewsMap(ctx.store, viewsMap),
        ctx.store.delete(KEYS.legacyLike(id)),
      ]);
      // 重试后仍未验证到删除生效：不静默，明确告知前端（写入已发出，
      // 大概率只是 KV 同步延迟；前端据此提示用户稍后刷新确认）。
      return unverified
        ? { success: true, warning: "删除已提交，但数据同步略有延迟，请稍后刷新确认" }
        : { success: true };
    });
  },

  // ---------- 留言 ----------
  async listMessages(ctx) {
    const messages = await Repo.getMessages(ctx.store);
    return jsonEtagResponse(ctx.request, stripIp([...messages].reverse()));
  },

  async createMessage(ctx) {
    const { body, store, ip } = ctx;
    if (!validateNickname(body.name))
      fail("昵称格式不正确（不能全是空格或特殊字符，长度1-20字）");
    if (!validateRichText(body.content))
      fail("留言内容格式不正确（长度1-500字，不能包含恶意标签，连续换行不超过5次）");

    const name = body.name.trim();
    const content = sanitizeUserContent(body.content.trim());
    if (content === null) fail("留言内容包含不安全的代码", 400);

    const rate = await checkRateLimit(
      store,
      KEYS.msgCooldown(ip),
      KEYS.msgHour(ip),
      CONFIG.rate.messageCooldownSeconds,
      CONFIG.rate.messagePerHour,
      "留言太频繁了，休息一下再来吧~"
    );
    if (!rate.allowed) fail(rate.reason, 429);

    const messages = await Repo.getMessages(store);
    messages.push({ id: genId("m"), name, content, date: new Date().toISOString(), ip });
    await store.putJson(KEYS.messages, messages);
    return { success: true };
  },

  async deleteMessage(ctx) {
    const id = pathId(ctx, "无效的留言ID");
    const messages = await Repo.getMessages(ctx.store);
    const filtered = messages.filter((m) => m.id !== id);
    if (filtered.length === messages.length) fail("留言不存在", 404);
    await ctx.store.putJson(KEYS.messages, filtered);
    return { success: true };
  },

  // ---------- 评论 ----------
  async listComments(ctx) {
    const postId = pathId(ctx, "无效的文章ID");
    const comments = await Repo.getComments(ctx.store, postId);
    return jsonEtagResponse(ctx.request, stripIp([...comments].reverse()));
  },

  async createComment(ctx) {
    const { body, store, ip } = ctx;
    const postId = pathId(ctx, "无效的文章ID");
    await findPostOrFail(store, postId);

    if (!validateNickname(body.name))
      fail("昵称格式不正确（不能全是空格或特殊字符，长度1-20字）");
    if (!validateRichText(body.content))
      fail("评论内容格式不正确（长度1-500字，不能包含恶意标签，连续换行不超过5次）");

    const name = body.name.trim();
    const content = sanitizeUserContent(body.content.trim());
    if (content === null) fail("评论内容包含不安全的代码", 400);

    const rate = await checkRateLimit(
      store,
      KEYS.commentCooldown(ip, postId),
      KEYS.commentHour(ip, postId),
      CONFIG.rate.commentCooldownSeconds,
      CONFIG.rate.commentPerHour,
      "评论太频繁了，休息一下再来吧~"
    );
    if (!rate.allowed) fail(rate.reason, 429);

    const comments = await Repo.getComments(store, postId);
    comments.push({ id: genId("c"), name, content, date: new Date().toISOString(), ip });
    await Repo.saveComments(store, postId, comments);
    return { success: true };
  },

  async deleteComment(ctx) {
    const postId = ctx.params.postId;
    const commentId = ctx.params.commentId;
    if (!validateId(postId)) fail("无效的文章ID", 400);
    if (!validateId(commentId)) fail("无效的评论ID", 400);

    const comments = await Repo.getComments(ctx.store, postId);
    const filtered = comments.filter((c) => c.id !== commentId);
    if (filtered.length === comments.length) fail("评论不存在", 404);
    await Repo.saveComments(ctx.store, postId, filtered);
    return { success: true };
  },

  // ---------- 时间线 ----------
  async listTimeline(ctx) {
    const timeline = await Repo.getTimeline(ctx.store);
    if (ctx.url.searchParams.get("withSource") === "1") {
      const ghIds = [];
      const site = await Repo.getSite(ctx.store);
      if (site.autoMode && site.githubRepo) {
        try {
          (await loadTimelineFromGithub(ctx.store, site)).forEach((t) => ghIds.push(t.id));
        } catch {
          /* 来源标记失败不影响列表本身 */
        }
      }
      return jsonEtagResponse(ctx.request, { timeline, ghIds });
    }
    return jsonEtagResponse(ctx.request, sortByDateDesc(timeline));
  },

  async saveTimeline(ctx) {
    const body = ctx.body;
    // 与文章同构：本地视图 upsert，GitHub 条目编辑时先落入本地
    const timeline = await Repo.getLocalTimeline(ctx.store);

    if (body.id) {
      if (!validateId(body.id)) fail("无效的记录ID", 400);
      let idx = timeline.findIndex((t) => t.id === body.id);
      if (idx === -1) {
        const merged = await Repo.getTimeline(ctx.store);
        let remote = merged.find((t) => t.id === body.id);
        if (!remote) {
          const site = await Repo.getSite(ctx.store);
          if (site.autoMode && site.githubRepo) {
            try {
              remote = (await loadTimelineFromGithub(ctx.store, site)).find((t) => t.id === body.id);
            } catch {
              /* 仓库不可达时无法恢复 */
            }
          }
        }
        if (!remote) fail("记录不存在", 404);
        timeline.push({
          id: remote.id,
          date: remote.date,
          title: remote.title,
          desc: remote.desc || "",
        });
        idx = timeline.length - 1;
        await Repo.removeDeletedId(ctx.store, "timeline", body.id);
      }

      const patch = {};
      for (const k of ["date", "title", "desc"]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      // 标题/日期不允许置空（与新建分支一致）
      if (patch.title !== undefined) {
        const t = String(patch.title).trim();
        if (!t) fail("标题不能为空");
        if (t.length > CONFIG.limit.timelineTitle) fail("标题不能超过100字");
      }
      if (patch.date !== undefined) {
        const d = String(patch.date).trim();
        if (!d) fail("日期不能为空");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail("日期格式不正确");
      }
      if (patch.desc !== undefined && String(patch.desc).length > CONFIG.limit.timelineDesc) fail("描述不能超过500字");

      Object.assign(timeline[idx], patch);
    } else {
      if (!body.title || !body.date) fail("标题和日期不能为空");
      const title = String(body.title).trim();
      if (!title) fail("标题不能为空");
      if (title.length > CONFIG.limit.timelineTitle) fail("标题不能超过100字");
      if (body.desc && body.desc.length > CONFIG.limit.timelineDesc) fail("描述不能超过500字");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) fail("日期格式不正确");

      timeline.push({
        id: genId("t"),
        date: body.date,
        title,
        desc: (body.desc || "").slice(0, CONFIG.limit.timelineDesc),
      });
    }

    await ctx.store.putJson(KEYS.timeline, timeline);
    return { success: true };
  },

  async deleteTimeline(ctx) {
    const id = pathId(ctx, "无效的记录ID");
    const local = await Repo.getLocalTimeline(ctx.store);
    const site = await Repo.getSite(ctx.store);
    const ghEnabled = !!(site.autoMode && site.githubRepo);
    if (local.some((t) => t.id === id)) {
      const filtered = local.filter((t) => t.id !== id);
      await ctx.store.putJson(KEYS.timeline, filtered);
    } else {
      // 本地没有：确认它确实存在于合并视图（可能来自 GitHub），否则 404
      const merged = await Repo.getTimeline(ctx.store);
      if (!merged.some((t) => t.id === id)) fail("记录不存在", 404);
    }
    // 同文章删除语义：同步开启时一律写入墓碑，防止仓库版本复现
    if (ghEnabled) await Repo.addDeletedId(ctx.store, "timeline", id);
    return { success: true };
  },

  // ---------- 音乐 ----------
  async listMusic(ctx) {
    const music = await Repo.getMusic(ctx.store);
    if (ctx.url.searchParams.get("withSource") === "1") {
      const ghIds = [];
      const site = await Repo.getSite(ctx.store);
      if (site.autoMode && site.githubRepo) {
        try {
          (await loadMusicFromGithub(ctx.store, site)).forEach((m) => ghIds.push(m.id));
        } catch {
          /* 来源标记失败不影响列表本身 */
        }
      }
      return jsonEtagResponse(ctx.request, { music, ghIds });
    }
    // 来源标记（供前台播放列表展示「后台/仓库」徽章）：
    // 后台本地库命中的记 local，其余（autoMode 合并进来的）记 github
    let localIds = null;
    try {
      localIds = new Set((await Repo.getLocalMusic(ctx.store)).map((m) => m && m.id).filter(Boolean));
    } catch {
      /* 标记失败不阻断歌单返回 */
    }
    const marked = localIds
      ? music.map((m) => (m && m.source ? m : { ...m, source: localIds.has(m.id) ? "local" : "github" }))
      : music;
    return jsonEtagResponse(ctx.request, marked);
  },

  async saveMusic(ctx) {
    const body = ctx.body;
    // 与文章同构：本地视图 upsert，GitHub 条目编辑时先落入本地
    const music = await Repo.getLocalMusic(ctx.store);

    if (body.id) {
      if (!validateId(body.id)) fail("无效的歌曲ID", 400);
      let idx = music.findIndex((m) => m.id === body.id);
      if (idx === -1) {
        const merged = await Repo.getMusic(ctx.store);
        let remote = merged.find((m) => m.id === body.id);
        if (!remote) {
          const site = await Repo.getSite(ctx.store);
          if (site.autoMode && site.githubRepo) {
            try {
              remote = (await loadMusicFromGithub(ctx.store, site)).find((m) => m.id === body.id);
            } catch {
              /* 仓库不可达时无法恢复 */
            }
          }
        }
        if (!remote) fail("歌曲不存在", 404);
        music.push({
          id: remote.id,
          title: remote.title,
          artist: remote.artist || "",
          url: remote.url,
          cover: remote.cover || "",
        });
        idx = music.length - 1;
        await Repo.removeDeletedId(ctx.store, "music", body.id);
      }

      const patch = {};
      for (const k of ["title", "artist", "url", "cover"]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      // 链接不允许置空（空 url 会导致前端永久无法播放）
      if (patch.url !== undefined) {
        if (!String(patch.url).trim() || !isValidUrl(patch.url)) fail("歌曲链接必须是 http/https 协议");
      }
      if (patch.cover !== undefined && String(patch.cover).trim() && !isValidUrl(patch.cover)) fail("封面链接必须是 http/https 协议");
      if (patch.title !== undefined) {
        const t = String(patch.title).trim();
        if (!t) fail("歌曲名不能为空");
        if (t.length > CONFIG.limit.musicTitle) fail("歌名不能超过200字");
      }
      if (patch.artist !== undefined && String(patch.artist).length > CONFIG.limit.musicArtist) fail("歌手名不能超过100字");

      Object.assign(music[idx], patch);
    } else {
      if (!body.title || !body.url) fail("歌曲名和链接不能为空");
      if (!isValidUrl(body.url)) fail("歌曲链接必须是 http/https 协议");
      if (body.cover && !isValidUrl(body.cover)) fail("封面链接必须是 http/https 协议");
      const title = String(body.title).trim();
      if (!title) fail("歌曲名不能为空");
      if (title.length > CONFIG.limit.musicTitle) fail("歌名不能超过200字");
      if (body.artist && body.artist.length > CONFIG.limit.musicArtist) fail("歌手名不能超过100字");

      music.push({
        id: genId("m"),
        title,
        artist: (body.artist || "").slice(0, CONFIG.limit.musicArtist),
        url: body.url,
        cover: body.cover || "",
      });
    }

    await ctx.store.putJson(KEYS.music, music);
    return { success: true };
  },

  async deleteMusic(ctx) {
    const id = pathId(ctx, "无效的歌曲ID");
    const local = await Repo.getLocalMusic(ctx.store);
    const site = await Repo.getSite(ctx.store);
    const ghEnabled = !!(site.autoMode && site.githubRepo);
    if (local.some((m) => m.id === id)) {
      const filtered = local.filter((m) => m.id !== id);
      await ctx.store.putJson(KEYS.music, filtered);
    } else {
      // 本地没有：确认它确实存在于合并视图（可能来自 GitHub），否则 404
      const merged = await Repo.getMusic(ctx.store);
      if (!merged.some((m) => m.id === id)) fail("歌曲不存在", 404);
    }
    // 同文章删除语义：同步开启时一律写入墓碑，防止仓库版本复现
    if (ghEnabled) await Repo.addDeletedId(ctx.store, "music", id);
    return { success: true };
  },

  // ---------- 点赞 / 阅读量 ----------
  async likePost(ctx) {
    const { store, ip } = ctx;
    const id = pathId(ctx, "无效的文章ID");
    await findPostOrFail(store, id);

    const now = Date.now();
    const ipKey = KEYS.likeIp(id, ip);
    const rateKey = KEYS.likeRate(ip);

    // 两个键互不依赖，并行读取
    const [lastLike, alreadyLiked] = await Promise.all([
      store.getRaw(rateKey),
      store.getRaw(ipKey),
    ]);

    if (lastLike) {
      const lastTime = safeParseInt(lastLike, 0);
      if (
        lastTime > 0 &&
        lastTime <= now &&
        now - lastTime < CONFIG.rate.likeCooldownSeconds * 1000
      ) {
        fail("点赞太频繁了，休息一下再来吧~", 429);
      }
    }

    const likesMap = await Repo.getLikesMap(store);
    if (alreadyLiked) {
      return {
        success: true,
        liked: true,
        alreadyLiked: true,
        likes: likesMap[id] || 0,
        message: "你已经赞过了",
      };
    }

    likesMap[id] = (likesMap[id] || 0) + 1;
    await Promise.all([
      Repo.saveLikesMap(store, likesMap),
      store.putRaw(ipKey, "1", { expirationTtl: CONFIG.rate.likeIpTtlSeconds }),
      // 同步维护遗留 like_<id> 键：回退到旧版 Worker 时计数不丢失
      store.putRaw(KEYS.legacyLike(id), String(likesMap[id])),
    ]);
    store.defer(
      store.kv.put(rateKey, now.toString(), {
        expirationTtl: CONFIG.rate.likeCooldownSeconds * 2,
      })
    );
    return { success: true, liked: true, alreadyLiked: false, likes: likesMap[id] };
  },

  /** 记录一次阅读：同一 IP 对同一篇 24 小时内只计一次 */
  async viewPost(ctx) {
    const { store, ip } = ctx;
    const id = pathId(ctx, "无效的文章ID");
    await findPostOrFail(store, id);

    const dedupeKey = KEYS.viewIp(id, ip);
    const [seen, viewsMap] = await Promise.all([
      store.getRaw(dedupeKey),
      Repo.getViewsMap(store),
    ]);
    if (seen) return { success: true, views: viewsMap[id] || 0, counted: false };

    viewsMap[id] = (viewsMap[id] || 0) + 1;
    await Promise.all([
      Repo.saveViewsMap(store, viewsMap),
      store.putRaw(dedupeKey, String(Date.now()), {
        expirationTtl: CONFIG.rate.viewIpTtlSeconds,
      }),
    ]);
    return { success: true, views: viewsMap[id], counted: true };
  },

  // ---------- 登录 ----------
  async login(ctx) {
    const { body, env, store, ip } = ctx;
    if (!body || !body.password) fail("请输入密码");
    if (body.password.length > CONFIG.admin.maxTokenLength) fail("密码错误", 401);

    const lock = await checkLock(store, ip);
    if (lock.locked) fail("密码错误次数太多，15分钟后再试", 429);

    const adminPw = getAdminPassword(env);
    // 服务端未配置 ADMIN_PASSWORD：直接 500，绝不回退硬编码口令
    if (!adminPw) fail(ADMIN_UNCONFIGURED_MSG, 500);

    if (body.password !== adminPw) {
      const result = await recordFail(store, ip);
      if (result.locked) fail("密码错误次数太多，15分钟后再试", 429);
      fail(`密码错误，还剩 ${result.remaining} 次机会`, 401);
    }

    await store.delete(KEYS.lock(ip));
    return { success: true, message: "登录成功" };
  },

  // ---------- 友情链接 ----------
  async listLinks(ctx) {
    const links = await Repo.getLinks(ctx.store);
    const sorted = [...links].sort((a, b) => (a.order || 0) - (b.order || 0));
    return jsonEtagResponse(ctx.request, sorted.map(({ ip, ...rest }) => rest));
  },

  async saveLink(ctx) {
    const body = ctx.body;
    const links = await Repo.getLinks(ctx.store);
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const desc = typeof body.desc === "string" ? body.desc.trim() : "";

    if (!name) fail("站点名称不能为空");
    if (name.length > CONFIG.limit.linkName) fail(`站点名称不能超过${CONFIG.limit.linkName}字`);
    if (desc.length > CONFIG.limit.linkDesc) fail(`简介不能超过${CONFIG.limit.linkDesc}字`);
    if (!isValidUrl(url)) fail("站点链接必须是 http/https 协议");
    if (body.icon !== undefined && body.icon !== "" && !isValidUrl(body.icon))
      fail("头像链接必须是 http/https 协议");

    const order = safeParseInt(body.order, 0);
    const record = {
      id: body.id && validateId(body.id) ? body.id : genId("l"),
      name,
      url,
      desc,
      icon: body.icon || "",
      order: Math.min(Math.max(order, 0), 9999),
    };

    const idx = links.findIndex((l) => l.id === record.id);
    if (idx >= 0) links[idx] = record;
    else links.push(record);

    await Repo.saveLinks(ctx.store, links);
    return { success: true };
  },

  async deleteLink(ctx) {
    const id = pathId(ctx, "无效的链接ID");
    const links = await Repo.getLinks(ctx.store);
    const filtered = links.filter((l) => l.id !== id);
    if (filtered.length === links.length) fail("链接不存在", 404);
    await Repo.saveLinks(ctx.store, filtered);
    return { success: true };
  },

  // ---------- 游戏排行榜 ----------
  async listGameScores(ctx) {
    const all = await Repo.getGameScores(ctx.store);
    const result = {};
    for (const game of CONFIG.games) {
      const list = Array.isArray(all[game]) ? all[game] : [];
      result[game] = list
        .map(({ ip, ...rest }) => rest)
        .sort((a, b) => b.score - a.score || new Date(a.date) - new Date(b.date))
        .slice(0, CONFIG.limit.leaderboard);
    }
    return jsonEtagResponse(ctx.request, result);
  },

  async submitGameScore(ctx) {
    const { body, store, ip } = ctx;
    const gameId = ctx.params.gameId;
    if (!CONFIG.games.includes(gameId)) fail("未知的游戏", 400);
    if (!validateNickname(body.name)) fail("昵称格式不正确（长度1-20字）");

    const score = safeParseInt(body.score, -1);
    if (!Number.isInteger(score) || score < 0 || score > CONFIG.limit.gameScore)
      fail("成绩格式不正确");

    const rate = await checkRateLimit(
      store,
      `score_rate_${safeKvKey(ip, CONFIG.limit.ip)}_${gameId}`,
      `score_hour_${safeKvKey(ip, CONFIG.limit.ip)}_${gameId}`,
      CONFIG.limit.scoreCooldownSeconds,
      CONFIG.limit.scorePerHour,
      "提交太频繁了，休息一下再来吧~"
    );
    if (!rate.allowed) fail(rate.reason, 429);

    const all = await Repo.getGameScores(store);
    const list = Array.isArray(all[gameId]) ? all[gameId] : [];
    const storedName = body.name.trim().slice(0, CONFIG.limit.gameName);
    list.push({
      id: genId("s"),
      name: storedName,
      score,
      date: new Date().toISOString(),
      ip,
    });
    all[gameId] = list
      .sort((a, b) => b.score - a.score || new Date(a.date) - new Date(b.date))
      .slice(0, CONFIG.limit.leaderboard);

    await Repo.saveGameScores(store, all);
    // 用截断后的名字查找（与存储一致）；未进榜返回 null 而非 0
    const rank = all[gameId].findIndex((s) => s.name === storedName && s.score === score) + 1;
    return { success: true, rank: rank > 0 ? rank : null };
  },

  async clearGameScores(ctx) {
    const gameId = ctx.params.gameId;
    if (!CONFIG.games.includes(gameId)) fail("未知的游戏", 400);
    const all = await Repo.getGameScores(ctx.store);
    all[gameId] = [];
    await Repo.saveGameScores(ctx.store, all);
    return { success: true };
  },

  // ---------- 备份 / 恢复 ----------
  async exportBackup(ctx) {
    const [site, posts, messages, timeline, music, likes, views, links, gameScores, comments, deletedIds] =
      await Promise.all([
        Repo.getSite(ctx.store),
        Repo.getPosts(ctx.store),
        Repo.getMessages(ctx.store),
        Repo.getTimeline(ctx.store),
        Repo.getMusic(ctx.store),
        Repo.getLikesMap(ctx.store),
        Repo.getViewsMap(ctx.store),
        Repo.getLinks(ctx.store),
        Repo.getGameScores(ctx.store),
        Repo.getAllComments(ctx.store),
        ctx.store.getRaw(KEYS.deletedIds),
      ]);
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      data: {
        site,
        posts,
        messages,
        timeline,
        music,
        likes,
        views,
        links,
        gameScores,
        comments,
        // 双来源墓碑：恢复后「已删除的 GitHub 条目」保持隐藏
        deletedIds: safeJsonParse(deletedIds, { posts: [], music: [], timeline: [] }),
      },
    };
  },

  async importBackup(ctx) {
    const payload = ctx.body && ctx.body.data ? ctx.body.data : ctx.body;
    if (!payload || typeof payload !== "object") fail("备份文件格式不正确");

    const isArray = (v) => Array.isArray(v);
    const tasks = [];

    if (payload.site !== undefined) {
      if (!payload.site || typeof payload.site !== "object") fail("备份中的站点配置格式不正确");
      tasks.push(Repo.saveSite(ctx.store, { ...DEFAULT_SITE, ...payload.site }));
    }
    if (payload.posts !== undefined) {
      if (!isArray(payload.posts)) fail("备份中的文章格式不正确");
      for (const p of payload.posts) {
        if (!p || !validateId(p.id)) fail("备份中存在无效的文章ID");
        if (p.content !== undefined && sanitizeUserContent(p.content) === null)
          fail("备份中的文章内容包含不安全的代码");
      }
      tasks.push(Repo.savePosts(ctx.store, payload.posts));
    }
    if (payload.messages !== undefined) {
      if (!isArray(payload.messages)) fail("备份中的留言格式不正确");
      tasks.push(ctx.store.putJson(KEYS.messages, payload.messages));
    }
    if (payload.timeline !== undefined) {
      if (!isArray(payload.timeline)) fail("备份中的时间线格式不正确");
      tasks.push(ctx.store.putJson(KEYS.timeline, payload.timeline));
    }
    if (payload.music !== undefined) {
      if (!isArray(payload.music)) fail("备份中的音乐格式不正确");
      tasks.push(ctx.store.putJson(KEYS.music, payload.music));
    }
    if (payload.likes !== undefined) {
      if (!payload.likes || typeof payload.likes !== "object") fail("备份中的点赞数据格式不正确");
      tasks.push(Repo.saveLikesMap(ctx.store, payload.likes));
    }
    if (payload.views !== undefined) {
      if (!payload.views || typeof payload.views !== "object") fail("备份中的阅读量格式不正确");
      tasks.push(Repo.saveViewsMap(ctx.store, payload.views));
    }
    if (payload.links !== undefined) {
      if (!isArray(payload.links)) fail("备份中的友情链接格式不正确");
      for (const l of payload.links) {
        if (!l || !validateId(l.id)) fail("备份中存在无效的链接ID");
      }
      tasks.push(Repo.saveLinks(ctx.store, payload.links));
    }
    if (payload.gameScores !== undefined) {
      if (!payload.gameScores || typeof payload.gameScores !== "object")
        fail("备份中的游戏成绩格式不正确");
      tasks.push(Repo.saveGameScores(ctx.store, payload.gameScores));
    }
    if (payload.comments !== undefined) {
      if (!payload.comments || typeof payload.comments !== "object")
        fail("备份中的评论格式不正确");
      for (const [postId, list] of Object.entries(payload.comments)) {
        if (!validateId(postId)) fail("备份中存在无效的文章ID");
        if (!isArray(list)) fail("备份中的评论格式不正确");
        tasks.push(Repo.saveComments(ctx.store, postId, list));
      }
    }
    if (payload.deletedIds !== undefined) {
      const d = payload.deletedIds;
      if (!d || typeof d !== "object") fail("备份中的删除记录格式不正确");
      const clean = {};
      for (const kind of ["posts", "music", "timeline"]) {
        if (d[kind] !== undefined) {
          if (!isArray(d[kind]) || d[kind].some((x) => !validateId(x)))
            fail("备份中的删除记录格式不正确");
          clean[kind] = d[kind];
        }
      }
      tasks.push(ctx.store.putJson(KEYS.deletedIds, clean));
    }

    if (tasks.length === 0) fail("备份文件中没有可导入的数据");
    await Promise.all(tasks);
    return { success: true, message: "数据已恢复" };
  },
};

// ============================================================
// 12. ROUTES —— 表驱动路由
// ------------------------------------------------------------
// [方法, 路径模式, 处理器, 需要管理员, 需要请求体]
// 路径模式中的 :xxx 为路径参数，按注册顺序匹配。
// ============================================================
const ROUTES = [
  // GET
  ["GET", "/api/site", handlers.getSite, false, false],
  ["GET", "/api/stats", handlers.getStats, false, false],
  ["GET", "/api/popular", handlers.listPopular, false, false],
  ["GET", "/api/posts", handlers.listPosts, false, false],
  ["GET", "/api/post/:id", handlers.getPost, false, false],
  ["GET", "/api/messages", handlers.listMessages, false, false],
  ["GET", "/api/music", handlers.listMusic, false, false],
  ["GET", "/api/timeline", handlers.listTimeline, false, false],
  ["GET", "/api/comments/:id", handlers.listComments, false, false],
  ["GET", "/api/links", handlers.listLinks, false, false],
  ["GET", "/api/game/scores", handlers.listGameScores, false, false],
  ["GET", "/api/album/photos", handlers.listAlbumPhotos, false, false],
  ["GET", "/api/github-status", handlers.getGithubStatus, true, false],
  ["GET", "/api/backup/export", handlers.exportBackup, true, false],

  // POST —— 公开
  ["POST", "/api/login", handlers.login, false, true],
  ["POST", "/api/messages", handlers.createMessage, false, true],
  ["POST", "/api/like/:id", handlers.likePost, false, false],
  ["POST", "/api/view/:id", handlers.viewPost, false, false],
  ["POST", "/api/comments/:id", handlers.createComment, false, true],
  ["POST", "/api/game/score/:gameId", handlers.submitGameScore, false, true],

  // POST —— 管理员
  ["POST", "/api/site", handlers.updateSite, true, true],
  ["POST", "/api/posts", handlers.savePost, true, true],
  ["POST", "/api/post/delete/:id", handlers.deletePost, true, false],
  ["POST", "/api/message/delete/:id", handlers.deleteMessage, true, false],
  ["POST", "/api/comment/delete/:postId/:commentId", handlers.deleteComment, true, false],
  ["POST", "/api/timeline", handlers.saveTimeline, true, true],
  ["POST", "/api/timeline/delete/:id", handlers.deleteTimeline, true, false],
  ["POST", "/api/music", handlers.saveMusic, true, true],
  ["POST", "/api/music/delete/:id", handlers.deleteMusic, true, false],
  ["POST", "/api/links", handlers.saveLink, true, true],
  ["POST", "/api/link/delete/:id", handlers.deleteLink, true, false],
  ["POST", "/api/game/scores/:gameId", handlers.clearGameScores, true, false],
  ["POST", "/api/refresh-github", handlers.refreshGithub, true, false],
  ["POST", "/api/backup/import", handlers.importBackup, true, true],
];

/** 把路径模式编译成正则，并抽出参数名 */
const COMPILED_ROUTES = ROUTES.map(([method, pattern, handler, needAuth, needBody]) => {
  const names = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        names.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { method, handler, needAuth, needBody, names, regex: new RegExp(`^${source}$`) };
});

/** 匹配请求到路由；未命中返回 null */
function matchRoute(method, pathname) {
  for (const route of COMPILED_ROUTES) {
    if (route.method !== method) continue;
    const m = pathname.match(route.regex);
    if (!m) continue;
    const params = {};
    for (const [i, name] of route.names.entries()) {
      try {
        params[name] = decodeURIComponent(m[i + 1]);
      } catch (e) {
        // 畸形百分号编码（如 %ZZ）：作为无效 ID 交给下游校验返回 400，而不是 500
        params[name] = null;
      }
    }
    return { route, params };
  }
  return null;
}

/**
 * 未命中路由时的兜底。
 * 旧实现用字符串前缀 + replace 取参，畸形 ID（如含 / 或为空）会走校验返回 400；
 * 这里保留同样的语义，避免接口契约变化。按顺序匹配，前缀更具体的要写在前面。
 */
const INVALID_ID_FALLBACKS = [
  ["/api/post/delete/", "无效的文章ID"],
  ["/api/comment/delete/", "无效的路径"],
  ["/api/message/delete/", "无效的留言ID"],
  ["/api/timeline/delete/", "无效的记录ID"],
  ["/api/music/delete/", "无效的歌曲ID"],
  ["/api/link/delete/", "无效的链接ID"],
  ["/api/game/scores/", "未知的游戏"],
  ["/api/post/", "无效的文章ID"],
  ["/api/comments/", "无效的文章ID"],
  ["/api/like/", "无效的文章ID"],
  ["/api/view/", "无效的文章ID"],
];

/** 路由未命中时，返回与原实现一致的 400 或 404 */
function failNoRoute(pathname) {
  for (const [prefix, message] of INVALID_ID_FALLBACKS) {
    if (pathname.startsWith(prefix)) fail(message, 400);
  }
  fail("Not Found", 404);
}

// ============================================================
// 13. Entry —— Worker 入口
// ============================================================
async function dispatchApi(request, env, ctx, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: buildHeaders() });
  }

  // 同源 GitHub 代理：在路由表与方法检查之前拦截（/api/github/* 不依赖 KV，store 允许为null；
  // 写方法透传同样在此收口，DELETE 因此可达——原 405 检查只约束其余业务路由）
  if (url.pathname.startsWith("/api/github/")) {
    let proxyStore = null;
    try {
      proxyStore = new Store(env, ctx);
    } catch (e) {
      /* KV 未绑时代理仍可用（仅丢失 Token 失效记录） */
    }
    return handleGithubProxy(request, env, ctx, url, proxyStore);
  }

  // 云盘代理（文件管理器）：PIN 保护 + GitHub Contents 读写，同样不依赖 KV
  if (url.pathname.startsWith("/api/drive/")) {
    return handleDrive(request, env, ctx, url);
  }

  // 仅支持 GET / POST，其余方法一律 405（与原实现保持一致）
  if (request.method !== "GET" && request.method !== "POST") {
    fail("Method Not Allowed", 405);
  }

  const store = new Store(env, ctx);

  const matched = matchRoute(request.method, url.pathname);
  if (!matched) failNoRoute(url.pathname);

  const { route, params } = matched;
  const context = {
    request,
    env,
    store,
    url,
    params,
    ip: getIP(request),
    body: {},
  };

  if (route.needAuth) await requireAuth(context);
  if (route.needBody) {
    const body = await readJson(request);
    if (!body) fail("请求格式错误");
    context.body = body;
  }

  return await route.handler(context);
}

/**
 * 清空公共只读接口的边缘缓存。
 * 策略说明：任何成功的写操作（管理端写入 / 点赞 / 留言 / 评论 / 成绩提交）
 * 都全量清理，而不是按路径精确匹配。理由是个人博客的写频率极低，
 * 10 次 cache.delete 的成本可忽略；而精确映射一旦漏一个路径就会出现
 * "后台改完前台不更新"的难以排查问题——正确性优先于微优化。
 */
function purgeApiCache(request) {
  try {
    if (typeof caches === "undefined" || !caches.default) return Promise.resolve();
    const origin = new URL(request.url).origin;
    const tasks = Object.keys(API_CACHE_TTL).map((p) =>
      caches.default.delete(new Request(origin + p, { method: "GET" }))
    );
    return Promise.all(tasks).catch(() => {});
  } catch (e) {
    /* 缓存清理失败不影响主流程 */
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------
 * v8.1 性能攻坚：GET 只读接口的「边缘缓存 + 单飞锁」
 * ------------------------------------------------------------
 * 实测取证：线上 /api/posts、/api/music、/api/site 等每次耗时 200~650ms，
 * 响应虽带 `public, max-age=N`，但**从未命中边缘缓存**。根因是 Cloudflare
 * 默认只按扩展名缓存静态内容，/api/* 这类无扩展名路径不在默认缓存列表内——
 * 设 Cache-Control 头并不能让边缘缓存它，必须用 Cache API 显式写入。
 * （旁证：同为 /api/ 下的 .jpg raw 代理带 cf-cache-status: HIT，即扩展名生效）
 *
 * 单飞锁：同一 isolate 内并发的相同 GET 只放行一个真实回源，其余复用结果，
 * 避免「缓存刚过期 → N 个并发一起打 GitHub」的击穿。
 * 跨 isolate 由 Cache API 兜底（命中即零回源、零 KV 读）。
 * ------------------------------------------------------------ */
const apiInflight = new Map(); // url -> Promise<{status, headers, body}>

async function dispatchApiCached(request, env, ctx, url) {
  const ttl = API_CACHE_TTL[url.pathname] || 0;
  const canCache =
    request.method === "GET" &&
    ttl > 0 &&
    !request.headers.get("Authorization") &&
    typeof caches !== "undefined" &&
    caches.default;
  // 不可缓存（写操作 / 带鉴权 / 未登记 TTL）→ 原路径直连，零额外开销
  if (!canCache) return dispatchApi(request, env, ctx, url);

  const cache = caches.default;
  const key = new Request(url.toString(), { method: "GET" });

  // 1) 边缘缓存命中：直接返回，不进 KV、不碰 GitHub
  try {
    const hit = await cache.match(key);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set("X-Edge-Cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  } catch { /* 缓存不可用不影响可用性 */ }

  // 2) 单飞锁：并发同 URL 只回源一次（body 以文本形式共享，避免 Response 只能消费一次）
  const ck = url.toString();
  let p = apiInflight.get(ck);
  if (!p) {
    p = (async () => {
      const result = await dispatchApi(request, env, ctx, url);
      const r = result instanceof Response ? result : ok(result);
      return {
        status: r.status,
        headers: [...r.headers],
        body: r.status === 304 ? null : await r.text(),
      };
    })();
    apiInflight.set(ck, p);
    // 无论成功失败都要释放锁，否则该 URL 会被永久占用
    p.then(
      () => apiInflight.delete(ck),
      () => apiInflight.delete(ck)
    );
  }
  const entry = await p;

  // 3) 组装响应（每次新建，避免共享 Response 导致 body 已被消费）
  const headers = new Headers(entry.headers);
  headers.set("Cache-Control", `public, max-age=${ttl}, stale-while-revalidate=${ttl * 4}`);
  headers.set("X-Edge-Cache", "MISS");
  const res = new Response(entry.body, { status: entry.status, headers });

  // 4) 回写边缘缓存（异步，不阻塞本次响应）
  if (entry.status === 200 && entry.body !== null && ctx && typeof ctx.waitUntil === "function") {
    try {
      ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    } catch { /* 写缓存失败不影响可用性 */ }
  }
  return res;
}

/* ------------------------------------------------------------
 * v8.1：极简速率限制（防刷 + 防击穿）
 * ------------------------------------------------------------
 * 只在真实边缘来源生效：以 cf-connecting-ip 头存在与否判定。
 * 本地/测试环境（无该头）一律放行，避免测试套件被自己的限流打红。
 * 计数存放在 isolate 内存中（非 KV）：不产生任何存储读写成本，
 * 代价是跨 isolate 不共享——但这是有意的，本项目防的是单用户狂刷
 * 与脚本撞库，不是分布式 DDoS（后者由 Cloudflare 平台侧承担）。
 * ------------------------------------------------------------ */
const RATE_WINDOW = 60000;
const RATE_MAX = 120; // 60 秒内 120 次 API 调用：正常浏览远达不到
const rateBuckets = new Map();

function rateLimited(request) {
  try {
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip) return false; // 非边缘来源（本地/测试）不限流
    const now = Date.now();
    const bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.start > RATE_WINDOW) {
      rateBuckets.set(ip, { start: now, count: 1 });
      return false;
    }
    bucket.count += 1;
    // 定期清理过期桶，避免 Map 无上限增长
    if (rateBuckets.size > 2000) {
      for (const [k, v] of rateBuckets) {
        if (now - v.start > RATE_WINDOW) rateBuckets.delete(k);
      }
    }
    return bucket.count > RATE_MAX;
  } catch { return false; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const startTime = Date.now();

    // 速率限制：仅对 API 生效；静态资源本身由边缘缓存承载，无需限流
    if (url.pathname.startsWith("/api/") && rateLimited(request)) {
      return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试" }), {
        status: 429,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      let response;
      try {
        // v8.1：只读 GET 走「边缘缓存 + 单飞」，其余（写/鉴权/未登记）走原路径
        const result = await dispatchApiCached(request, env, ctx, url);
        response = result instanceof Response ? result : ok(result);
      } catch (e) {
        if (e instanceof HttpError) {
          response = err(e.message, e.status);
        } else {
          console.error(
            "API Error:",
            e && e.name ? e.name : "UnknownError",
            e && e.message ? e.message.substring(0, 200) : ""
          );
          response = err("服务器内部错误", 500);
        }
      }
      const headers = new Headers(response.headers);
      headers.set("X-Response-Time", Date.now() - startTime + "ms");

      // 公共只读 GET：允许边缘缓存。命中缓存时 Worker 根本不会被执行，
      // 因此这部分请求完全不产生 KV 读取——这是降低 KV 用量的主要手段。
      // 带 Authorization 的请求不缓存（管理端数据实时性优先）。
      if (
        request.method === "GET" &&
        response.status === 200 &&
        !request.headers.get("Authorization")
      ) {
        const ttl = API_CACHE_TTL[url.pathname] || 0;
        if (ttl > 0) {
          headers.set(
            "Cache-Control",
            `public, max-age=${ttl}, stale-while-revalidate=${ttl * 4}`
          );
        }
      } else if (request.method === "GET" && response.status === 200) {
        // P0 修复：带鉴权的管理面 GET 显式禁止任何层级缓存。
        // 根因：管理后台读取列表（如 /api/posts?withSource=1）曾按公开读处理，
        // 响应带 public, max-age=120——浏览器 HTTP 缓存 120 秒内直接返回旧列表，
        // 发布/删除成功后界面「不刷新」，用户看到「删了还在、发了没影」。
        // 仅跳过缓存头不够（浏览器仍可能启发式缓存），这里显式 no-store 焊死。
        headers.set("Cache-Control", "no-store");
      }

      const finalResponse = new Response(
        response.status === 304 ? null : response.body,
        { status: response.status, statusText: response.statusText, headers }
      );

      // 写操作成功：异步清理边缘缓存，保证前台立刻看到最新数据
      if (request.method === "POST" && response.status === 200) {
        const purge = purgeApiCache(request);
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(purge);
      }
      return finalResponse;
    }

    // 非 API 请求：交给静态资源处理器，并附加安全头与缓存策略
    if (env.ASSETS) {
      // v7.0 页面重写：对外根级 URL → pages/ 物理文件（查询串原样保留）。
      // 传原始 pathname 给安全头逻辑，缓存策略仍按对外 URL 判定
      //（.html/sw.js/manifest.json → max-age=0，其余 1 小时）。
      let target = request;
      const mapped = PAGE_REWRITES[url.pathname];
      if (mapped) {
        const rewritten = new URL(mapped + url.search, url.origin);
        target = new Request(rewritten, {
          method: request.method,
          headers: request.headers,
        });
      }
      /* v8.1：静态资源边缘缓存（Cache API 显式写入）
       * 与 /api/* 同理——**Worker 返回的响应 Cloudflare 不会自动缓存**，
       * 光设 Cache-Control 头没有用（实测：11~12 个 CSS/JS/图片每次全部回源，
       * 边缘命中 0/12，TTFB 长期 500~800ms）。必须显式 put 才能真正命中。
       * HTML 不入库：发版即时性优先（浏览器侧由 SW 兜底，边缘侧靠 s-maxage=300）。
       */
      const isCacheableStatic =
        request.method === "GET" &&
        !request.headers.get("Authorization") &&
        !url.pathname.endsWith(".html") &&
        url.pathname !== "/" &&
        url.pathname !== "/sw.js" &&
        url.pathname !== "/manifest.json";

      if (isCacheableStatic && typeof caches !== "undefined" && caches.default) {
        const cache = caches.default;
        try {
          const hit = await cache.match(request);
          if (hit) return hit; // 零回源，直接命中
        } catch { /* 缓存不可用则走回源 */ }
        const upstream = await env.ASSETS.fetch(target);
        const final = addStaticSecurityHeaders(upstream, url.pathname);
        if (final.status === 200 && ctx && typeof ctx.waitUntil === "function") {
          try { ctx.waitUntil(cache.put(request, final.clone()).catch(() => {})); } catch { /* 忽略 */ }
        }
        return final;
      }

      return addStaticSecurityHeaders(await env.ASSETS.fetch(target), url.pathname);
    }
    return new Response("Not Found", { status: 404 });
  },
};
