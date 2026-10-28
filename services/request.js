/**
 * js/request.js —— 全站统一网络请求层（BlogApi）
 * ---------------------------------------------------------------
 * 重构背景：原先每个页面各自 fetch + try/catch + res.ok 判断，错误提示
 * 文案五花八门；相册页另有一套私有的图片多镜像兜底逻辑。现在收敛为：
 *
 *   BlogApi.get(url, opts) / post / put / del
 *     - 统一 JSON 解析（按 content-type 判定，避免非 JSON 响应炸 json()）
 *     - 统一错误对象：{ status, message, data }，message 优先取后端 error 字段
 *     - 超时控制：AbortController，默认 12s，可覆盖
 *     - 自动重试：仅 GET 默认关闭、按需开启；指数退避；不重试 4xx（客户端错误重试无意义）
 *     - Loading 状态：onLoading(true/false) 回调，调用方自行决定呈现
 *
 *   BlogApi.github.loadImage(img, mirrors)
 *     - 相册原 loadImgWithFallback 的公共化：多镜像依次尝试，
 *       全部失败派发 imgallfailed 事件由容器决定呈现
 *
 * 铁律（来自开发避坑指南）：前端绝不直连 GitHub 域名，一律走同源
 * /api/github/* 代理（CORS 免疫 + 边缘缓存 + 上游故障自动回退）。
 * ===============================================================
 */
window.BlogApi = (function () {
  "use strict";

  const { sleep, safeStorage } = window.BlogUtils;

  /* v8.1 性能攻坚：超时分层。
   * 线上实测：Worker→GitHub 正常 200~650ms，劣化时 1.4~1.8s，最坏拖到十几秒。
   * 首屏数据接口沿用 12s 等于把一个慢上游的延迟直接转嫁给用户（白屏等待），
   * 因此 **读接口默认 3s 熔断**（配合 Worker 侧 3s 熔断 + 换源，前端不必久等）；
   * 写接口（发布文章/上传等）要真正落库，放宽到 12s，避免误中断写操作。 */
  const DEFAULT_TIMEOUT_GET = 3000;
  const DEFAULT_TIMEOUT_WRITE = 12000;
  const CACHE_PREFIX = "blogApiCache:";

  /* GET 并发去重：同一 URL 的并发读只发一次，其余复用同一个 Promise。
   * 线上实测同一张 raw 图被请求 2 次、/api/drive/list 被请求 2 次，
   * 双倍回源直接翻倍首屏时间——去重是零成本收益。 */
  const inflight = new Map();

  /** 写入本地兜底缓存（失败静默：隐私模式/配额满不应影响主流程） */
  function writeLocalCache(key, data) {
    try {
      safeStorage.set(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), data }));
    } catch (e) { /* 忽略 */ }
  }

  /** 读取未过期的本地兜底缓存；过期或无记录返回 null */
  function readLocalCache(key, ttl) {
    try {
      const raw = safeStorage.get(CACHE_PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.ts !== "number") return null;
      if (Date.now() - parsed.ts > (ttl || 10 * 60 * 1000)) return null;
      return parsed.data;
    } catch (e) { return null; }
  }

  /** 把任意错误归一为带友好 message 的 Error */
  function normalizeError(e, url) {
    if (e && e.name === "AbortError") {
      return Object.assign(new Error("请求超时，请检查网络后重试"), { status: 0, url });
    }
    if (e instanceof TypeError) {
      // fetch 在网络层失败时抛 TypeError（DNS/断网/CORS）
      return Object.assign(new Error("网络异常，请检查连接"), { status: 0, url });
    }
    return e;
  }

  /**
   * 基础请求。
   * @param {string} url 同源路径（/api/... 或 /api/github/...）
   * @param {object} [opts]
   * @param {string} [opts.method="GET"]
   * @param {object} [opts.body] 自动 JSON 序列化并设 Content-Type
   * @param {number} [opts.timeout] 毫秒；默认读 3000 / 写 12000（v8.1 分层）
   * @param {number} [opts.retry=0] 额外重试次数（GET 才建议开启）
   * @param {function} [opts.onLoading] (boolean) => void
   * @param {string} [opts.cacheKey] 传则启用本地兜底缓存（成功写入/失败读取）
   * @param {number} [opts.cacheTtl=600000] 兜底缓存有效期（毫秒）
   * @param {function} [opts.onFallback] (cachedData, err) => void 降级命中时回调
   * @param {boolean} [opts.dedupe=true] 读请求并发去重（默认开启）
   * @returns {Promise<any>} 解析后的 JSON（或文本）
   */
  async function request(url, opts) {
    const options = opts || {};
    const method = options.method || "GET";
    const isRead = method === "GET";
    const retry = Math.max(0, options.retry || 0);
    const retryDelay = options.retryDelay || 600;
    const onLoading = options.onLoading;
    const timeout =
      options.timeout || (isRead ? DEFAULT_TIMEOUT_GET : DEFAULT_TIMEOUT_WRITE);

    /* ---- 读请求并发去重（写操作绝不去重，否则会吞掉真实提交） ---- */
    if (isRead && options.dedupe !== false) {
      const ck = url;
      let p = inflight.get(ck);
      if (!p) {
        p = doRequest();
        inflight.set(ck, p);
        p.then(() => inflight.delete(ck), () => inflight.delete(ck));
      }
      return p;
    }
    return doRequest();

    /** 真正的请求执行（含超时、重试、缓存兜底） */
    async function doRequest() {
    const headers = Object.assign({}, options.headers);
    let body;
    if (options.body !== undefined && options.body !== null) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    if (onLoading) onLoading(true);

    try {
      let lastErr = null;
      for (let attempt = 0; attempt <= retry; attempt++) {
        try {
          const res = await fetch(url, { method, headers, body, signal: controller.signal });
          const ct = res.headers.get("content-type") || "";
          const data = ct.includes("json") ? await res.json().catch(() => ({})) : await res.text();
          if (!res.ok) {
            const err = new Error((data && data.error) || "请求失败（" + res.status + "）");
            err.status = res.status;
            err.data = data;
            throw err;
          }
          // 成功：写入本地兜底缓存（下次断网/上游故障时可用）
          if (options.cacheKey) writeLocalCache(options.cacheKey, data);
          return data;
        } catch (e) {
          lastErr = normalizeError(e, url);
          // 4xx 是客户端错误（参数/权限/限流），重试无意义，直接抛出
          if (lastErr.status >= 400 && lastErr.status < 500) throw lastErr;
          if (attempt < retry) await sleep(retryDelay * (attempt + 1));
        }
      }
      // 全部尝试失败：有本地缓存就降级返回（页面据此提示「离线数据」，永不白屏）
      if (options.cacheKey) {
        const cached = readLocalCache(options.cacheKey, options.cacheTtl);
        if (cached !== null && cached !== undefined) {
          if (typeof options.onFallback === "function") options.onFallback(cached, lastErr);
          return cached;
        }
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
      if (onLoading) onLoading(false);
    }
    } /* doRequest 结束 */
  } /* request 结束 */

  /* ---- 便捷方法 ---- */
  const api = {
    request,
    get: (url, opts) => request(url, Object.assign({}, opts, { method: "GET" })),
    post: (url, body, opts) => request(url, Object.assign({}, opts, { method: "POST", body })),
    put: (url, body, opts) => request(url, Object.assign({}, opts, { method: "PUT", body })),
    del: (url, opts) => request(url, Object.assign({}, opts, { method: "DELETE" })),
  };

  /* =========================================================
   * GitHub 同源代理助手
   * =======================================================*/

  const github = {
    /**
     * 构造仓库文件的同源代理 URL。
     * @param {string} repo  "owner/name"
     * @param {string} branch
     * @param {string} path   仓库内路径（按段编码，保留 /）
     */
    rawUrl(repo, branch, path) {
      const encoded = String(path).split("/").map(encodeURIComponent).join("/");
      return `/api/github/raw/${repo}/${branch}/${encoded}`;
    },

    /**
     * 图片多镜像兜底加载（相册页公共化实现）。
     * mirrors 依次尝试，当前失败自动切下一个；全部失败派发
     * imgallfailed 事件（bubbles），由网格/灯箱容器决定呈现。
     * @param {HTMLImageElement} img        带 data-mirrors(JSON 数组) 的图片
     * @param {function} [onSuccess] 加载成功回调（调用方管理自身 Loading 态）
     */
    loadImage(img, onSuccess) {
      let mirrors = [];
      try { mirrors = JSON.parse(img.dataset.mirrors || "[]"); } catch (e) { mirrors = []; }
      let idx = parseInt(img.dataset.idx || "0", 10);
      if (idx >= mirrors.length) {
        img.dispatchEvent(new CustomEvent("imgallfailed", { bubbles: true }));
        return;
      }
      img.dataset.idx = String(idx + 1);
      img.onload = () => {
        img.classList.add("loaded");
        const wrap = img.closest(".photo-img-wrap");
        if (wrap) wrap.classList.remove("loading");
        if (onSuccess) onSuccess();
      };
      img.onerror = () => github.loadImage(img, onSuccess);
      img.src = mirrors[idx];
    },
  };
  api.github = github;

  return api;
})();
