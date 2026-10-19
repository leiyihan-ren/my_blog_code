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
  admin: {
    fallbackPassword: "Ly!2026@Secure#8848",
    maxAttempts: 5,
    lockSeconds: 900,
    maxTokenLength: 200,
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
    timeoutMs: 8000,
    // 单个源内的重试次数（仅网络错误/超时/5xx 时重试）
    retriesPerSource: 2,
    userAgent: "blog-auto-mode",
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
  games: ["snake", "breakout", "2048", "memory", "mines"],
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
  "/api/site": 60,
  "/api/stats": 30,
  "/api/popular": 60,
  "/api/posts": 30,
  "/api/messages": 15,
  "/api/music": 60,
  "/api/timeline": 60,
  "/api/links": 60,
  "/api/game/scores": 30,
  "/api/album/photos": 60,
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
  "frame-src 'none'; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; worker-src 'none'";

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
  if (
    pathname === "/" ||
    pathname.endsWith("/") ||
    pathname.endsWith(".html")
  ) {
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=3600";
}

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
  // 不覆盖上游已设置的缓存头（如 Cloudflare 对带指纹资源的处理）
  if (!headers.has("Cache-Control") && response.status !== 304) {
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
async function ghFetchWithFallback(kind, repo, path, branch, useCdn) {
  const table = kind === "list" ? GH_LIST_SOURCES : GH_FILE_SOURCES;
  const order = useCdn
    ? ["jsdelivr", "github", "statically"]
    : ["github", "jsdelivr", "statically"];
  const errors = [];

  for (const key of order) {
    const source = table[key];
    if (!source) continue; // 目录列表没有 statically 源
    for (let attempt = 1; attempt <= CONFIG.github.retriesPerSource; attempt++) {
      try {
        const res = await fetchWithTimeout(
          source.url(repo, path, branch),
          source.headers ? { headers: source.headers() } : {},
          CONFIG.github.timeoutMs
        );
        if (!res.ok) {
          errors.push(`${source.name}: HTTP ${res.status}`);
          // 404：该源上确实不存在；403/429：限流——换源即可，无需重试
          if (res.status === 404 || res.status === 403 || res.status === 429) break;
          continue; // 5xx/408：临时故障，重试当前源
        }
        const content = await source.parse(res, { repo, path, branch });
        return { content, source: source.name };
      } catch (e) {
        const reason = e && e.name === "AbortError" ? "超时" : String((e && e.message) || e);
        errors.push(`${source.name}: ${reason}`);
        if (attempt < CONFIG.github.retriesPerSource) await sleep(200 * attempt);
      }
    }
  }
  throw new GitHubUnavailableError(`GitHub 拉取失败（${path}）：${errors.join("；")}`);
}

/** 缓存读取：区分「新鲜」与「过期可用」，过期内容用于刷新失败时兜底 */
async function ghCacheGet(store, cacheKey) {
  const raw = await store.getRaw(cacheKey);
  if (raw == null) return null;
  const data = safeJsonParse(raw);
  if (!data || typeof data !== "object") return null;
  const age = Date.now() - (data.time || 0);
  return { content: data.content, fresh: age < CONFIG.github.cacheTtlSeconds * 1000 };
}

function ghCacheSet(store, cacheKey, content) {
  return store.defer(
    store.kv.put(
      cacheKey,
      JSON.stringify({ time: Date.now(), content }),
      // TTL 拉长到 stale 存活期：GitHub 长时间不可达时仍有旧内容可展示
      { expirationTtl: CONFIG.github.staleTtlSeconds }
    )
  );
}

/** 同 isolate 内并发去重：cacheKey -> 进行中的拉取 Promise */
const ghInflight = new Map();

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
 *  - 缓存过期/不存在 → 多源拉取；成功则更新缓存
 *  - 拉取失败但有旧缓存 → 返回旧缓存（stale），站点内容不消失
 *  - 拉取失败且无缓存 → 抛 GitHubUnavailableError
 */
async function ghLoad(store, kind, repo, path, branch, useCdn) {
  const cacheKey = KEYS.ghCache(kind === "list" ? "cache" : "raw", repo, branch, path, useCdn);
  const cached = await ghCacheGet(store, cacheKey);
  if (cached && cached.fresh) return cached.content;

  const inflight = ghInflight.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const { content, source } = await ghFetchWithFallback(kind, repo, path, branch, useCdn);
      await ghCacheSet(store, cacheKey, content);
      recordGhStatus(store, {
        lastOkAt: Date.now(),
        lastOkSource: source,
        lastError: "",
        usingStale: false,
      });
      return content;
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

async function githubFetch(store, repo, path, branch, useCdn) {
  return ghLoad(store, "list", repo, path, branch, useCdn);
}

async function githubFetchRaw(store, repo, path, branch, useCdn) {
  return ghLoad(store, "file", repo, path, branch, useCdn);
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
function buildImageMirrors(repo, branch, path, name, useCdn) {
  const mirrors = [
    `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${encodePathSegments(path)}/${encodePathSegments(name)}`,
    `https://raw.githubusercontent.com/${repo}/${branch}/${encodePathSegments(path)}/${encodePathSegments(name)}`,
    `https://cdn.statically.io/gh/${repo}/${branch}/${encodePathSegments(path)}/${encodePathSegments(name)}`,
  ];
  return useCdn ? mirrors : [mirrors[1], mirrors[0], mirrors[2]];
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
  const mdFiles = files.filter(
    (f) => f.type === "file" && mdExts.some((ext) => f.name.toLowerCase().endsWith(ext))
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

async function loadMusicFromGithub(store, site) {
  const useCdn = site.useCdn !== false;
  const branch = site.githubBranch || "main";
  const musicListFile = site.githubMusicListFile || "music.json";
  try {
    const raw = await githubFetchRaw(store, site.githubRepo, musicListFile, branch, useCdn);
    const list = safeJsonParse(raw, []);
    return (Array.isArray(list) ? list : [])
      .map((m, i) => ({
        id: (m.id ? String(m.id).replace(/[^a-zA-Z0-9_.-]/g, "_") : "gm" + i).slice(0, CONFIG.limit.id),
        title: m.title || "未知歌曲",
        artist: m.artist || "",
        url: m.url || "",
        cover: m.cover || "",
      }))
      .filter((m) => m.url && isValidUrl(m.url));
  } catch (e) {
    // music.json 不存在时，回退到扫描音频目录
    const musicPath = site.githubMusicPath || "music";
    const files = await githubFetch(store, site.githubRepo, musicPath, branch, useCdn);
    const audioExts = [".mp3", ".wav", ".ogg", ".m4a", ".flac"];
    return files
      .filter((f) => f.type === "file" && audioExts.some((ext) => f.name.toLowerCase().endsWith(ext)))
      .map((f, i) => ({
        id: "gm" + i,
        title: f.name.replace(/\.[^.]+$/, ""),
        artist: "",
        url: f.download_url,
        cover: "",
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
function getAdminPassword(env) {
  return env.ADMIN_PASSWORD || CONFIG.admin.fallbackPassword;
}

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

  if (authHeader !== `Bearer ${getAdminPassword(env)}`) {
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
    return { success: true, message: "GitHub 缓存已刷新" };
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
    if (!site.githubRepo) return { photos: [], configured: false };

    const useCdn = site.useCdn !== false;
    const branch = site.githubBranch || "main";
    const albumPath = site.githubAlbumPath || "photos";
    try {
      const files = await githubFetch(ctx.store, site.githubRepo, albumPath, branch, useCdn);
      const imgExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
      const photos = files
        .filter(
          (f) => f.type === "file" && imgExts.some((ext) => f.name.toLowerCase().endsWith(ext))
        )
        .sort((a, b) => b.name.localeCompare(a.name))
        .map((f) => ({
          name: f.name,
          size: f.size || 0,
          mirrors: buildImageMirrors(site.githubRepo, branch, albumPath, f.name, useCdn),
        }));
      return { photos, configured: true };
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

      posts.push({
        id: genId("p"),
        title,
        content: sanitized,
        date: body.date || new Date().toISOString().split("T")[0],
        desc: (body.desc || "").slice(0, CONFIG.limit.postDesc),
      });
    }

    await Repo.savePosts(ctx.store, posts);
    return { success: true };
  },

  async deletePost(ctx) {
    const id = pathId(ctx, "无效的文章ID");
    const local = await Repo.getLocalPosts(ctx.store);
    const site = await Repo.getSite(ctx.store);
    const ghEnabled = !!(site.autoMode && site.githubRepo);
    if (local.some((p) => p.id === id)) {
      // 后台文章（含 GitHub 文章的本地覆盖版）：从本地删除
      const filtered = local.filter((p) => p.id !== id);
      await Repo.savePosts(ctx.store, filtered);
    } else {
      // 本地没有：确认它确实存在于合并视图（可能来自 GitHub），否则 404
      const merged = await Repo.getPosts(ctx.store);
      if (!merged.some((p) => p.id === id)) fail("文章不存在", 404);
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
    return { success: true };
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
    return jsonEtagResponse(ctx.request, music);
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

    if (body.password !== getAdminPassword(env)) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const startTime = Date.now();

    if (url.pathname.startsWith("/api/")) {
      let response;
      try {
        const result = await dispatchApi(request, env, ctx, url);
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
      return addStaticSecurityHeaders(await env.ASSETS.fetch(request), url.pathname);
    }
    return new Response("Not Found", { status: 404 });
  },
};
