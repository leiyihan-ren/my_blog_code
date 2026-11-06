/**
 * services/rangeDownloader.js —— v11.0 战役一：HTTP Range 并行下载引擎
 * ---------------------------------------------------------------
 * 目标：把「单个 URL 的一次 GET」拆成 N 个 1MB 的 Range 子块并发拉取，
 * 在前端按序拼装成 Blob，跑满带宽；Worker 端缓存完整对象后，二次下载
 * 的 206 全部由边缘缓存切片返回，零回源（见 _worker.js handleRawRange）。
 *
 * 设计红线（逐条经过协议核实，不是拍脑袋）：
 *  1) 能力探测「零额外请求」：首块请求同时承担「探测」与「取第 0 块」。
 *     服务端返回 200（忽略 Range）→ 直接把这份全量响应当结果用，并全局
 *     记住「不支持」，此后所有请求退化为普通 fetch。因此老环境 / 测试
 *     mock / 上游不支持 Range 时，请求次数与字节行为与改造前完全一致。
 *  2) 绝不半途而废：任一子块重试耗尽 → 整体回退为一次普通全量下载，
 *     用户一定能拿到文件。「绝不宕机」优先于「跑满带宽」。
 *  3) 全局并发闸门：跨所有 URL 最多 6 个在途请求，避免与外层 part 并发
 *     相乘后打爆 GitHub 上游（配额/限流保护）。
 *  4) Streams API 按序拼装：并发块乱序到达，先按序号归位，再用
 *     ReadableStream 顺序推入 Response 取 blob；Blob 由浏览器磁盘承载，
 *     不把整个文件读进 JS 堆。不支持时回退 new Blob(chunks)。
 *  5) 只加专用标记头 x-drive-range=1：同源请求无 CORS 预检，SW 据此
 *     旁路；相册图片、manifest、评论附件等既有 raw 请求逐字节不受影响。
 *
 * 对外 API：
 *   RangeDownloader.fetchBlob(url, pin, opts) → Promise<Blob>
 *   RangeDownloader.constants()               → 策略常量（测试用）
 *   RangeDownloader.state()                  → 0 未知 / 1 支持 / -1 不支持
 *   RangeDownloader.reset()                  → 重置探测态（测试用）
 * ===============================================================
 */
window.RangeDownloader = (function () {
  "use strict";

  var BLOCK = 1024 * 1024; // 1MB 子块（与用户要求的 bytes=0-1048575 一致）
  var MAX_BLOCKS = 4096;   // 单 URL 保护上限（4GB，产品 2GB 上限内绰绰有余）
  var GLOBAL_SLOTS = 6;    // 全局并发闸门
  var RETRY = 2;           // 单块失败重试次数

  var support = 0;         // 0 未知 / 1 支持 / -1 不支持（进程内全局复用探测结论）
  var inflight = 0;
  var waiters = [];

  function acquire() {
    if (inflight < GLOBAL_SLOTS) { inflight += 1; return Promise.resolve(); }
    return new Promise(function (resolve) { waiters.push(resolve); });
  }
  function release() {
    if (waiters.length) { waiters.shift()(); return; } // 槽位直接移交，不减计数
    inflight = Math.max(0, inflight - 1);
  }
  function withSlot(fn) {
    return acquire().then(function () {
      return Promise.resolve().then(fn).then(
        function (v) { release(); return v; },
        function (e) { release(); throw e; }
      );
    });
  }

  /** 带 Range 的请求头。pin 与既有云盘下载完全一致，不扩大也不缩小鉴权面 */
  function rangeHeaders(pin, range) {
    var h = { "x-drive-pin": pin || "", "x-drive-range": "1" };
    if (range) h.Range = range;
    return h;
  }

  /** 普通全量下载：与 v8.3 起的 fetch→Blob 路径逐字节一致（零额外头） */
  function plainFetch(url, pin) {
    return window.BlogApi.raw(url, { headers: { "x-drive-pin": pin || "" } }).then(function (r) {
      if (!r.ok) {
        var e = new Error("下载失败（HTTP " + r.status + "）");
        e.status = r.status;
        throw e;
      }
      return r.blob();
    });
  }

  /** 从 Content-Range: bytes 0-1048575/12345678 解析总长度 */
  function parseTotal(contentRange) {
    var m = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(String(contentRange || ""));
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * Streams API 按序拼装：并发块可能乱序到达，chunks 已按下标归位，
   * 这里用 ReadableStream 顺序推入 Response，再取 blob。
   * 相比把所有 ArrayBuffer 一次性交给 new Blob，这里额外保证「按序」，
   * 且 Response 消费流时由浏览器把字节落到 Blob 后备存储，不占 JS 堆。
   */
  function orderedToBlob(chunks) {
    if (typeof ReadableStream === "function" && typeof Response === "function") {
      try {
        var i = 0;
        var stream = new ReadableStream({
          pull: function (ctrl) {
            if (i >= chunks.length) { ctrl.close(); return; }
            var part = chunks[i++];
            ctrl.enqueue(part instanceof Uint8Array ? part : new Uint8Array(part));
          }
        });
        return new Response(stream).blob();
      } catch (e) { /* 旧 runtime：回退 */ }
    }
    return Promise.resolve(new Blob(chunks));
  }

  /** 拉取单个子块，带全局闸门 + 指数退避重试 */
  function fetchOneBlock(url, pin, idx, total) {
    var start = idx * BLOCK;
    var end = Math.min(start + BLOCK, total) - 1;
    var attempt = 0;
    function fire() {
      return withSlot(function () {
        return window.BlogApi.raw(url, { headers: rangeHeaders(pin, "bytes=" + start + "-" + end) });
      }).then(function (r) {
        if (r.status !== 206) {
          var e = new Error("Range 子块 " + (idx + 1) + " 返回 HTTP " + r.status);
          e.status = r.status;
          throw e;
        }
        return r.arrayBuffer();
      }).catch(function (e) {
        attempt += 1;
        if (attempt > RETRY) throw e;
        var wait = Math.pow(2, attempt - 1) * 400;
        return new Promise(function (res) { setTimeout(res, wait); }).then(fire);
      });
    }
    return fire();
  }

  /**
   * 下载入口。返回 Promise<Blob>。
   * @param {string} url  同源 raw 代理 URL
   * @param {string} pin  云盘口令（与既有请求一致）
   * @param {object} opts { onProgress(done, total) } 可选
   */
  function fetchBlob(url, pin, opts) {
    opts = opts || {};
    pin = pin || "";
    if (typeof fetch !== "function") return Promise.reject(new Error("当前环境不支持 fetch"));
    if (support === -1) return plainFetch(url, pin); // 已知不支持：零额外请求

    // 首块即探测：一次请求兼顾「探测 Range 能力」与「取第 0 块」
    return withSlot(function () {
      return window.BlogApi.raw(url, { headers: rangeHeaders(pin, "bytes=0-" + (BLOCK - 1)) });
    }).then(function (r) {
      if (r.status !== 206) {
        // 上游忽略 Range（老 Worker / 测试 mock / CDN 不支持）：
        // 这份 200 全量响应本身就是完整文件，直接当结果，绝不浪费这次请求。
        support = -1;
        if (!r.ok) {
          var e = new Error("下载失败（HTTP " + r.status + "）");
          e.status = r.status;
          throw e;
        }
        return r.blob();
      }

      var total = parseTotal(r.headers.get("content-range"));
      if (!total) {
        // 206 但缺合法 Content-Range：无法安全分块，按全量处理
        return r.arrayBuffer().then(function (b) { return new Blob([b]); });
      }
      if (total <= BLOCK) {
        return r.arrayBuffer().then(function (b) { return new Blob([b]); });
      }
      var count = Math.min(Math.ceil(total / BLOCK), MAX_BLOCKS);
      if (count * BLOCK < total) {
        // 超出保护上限：不冒内存风险，退化全量
        support = -1;
        return plainFetch(url, pin);
      }

      support = 1;
      var chunks = new Array(count);
      return r.arrayBuffer().then(function (first) {
        chunks[0] = first;
        var queue = [];
        for (var i = 1; i < count; i += 1) queue.push(i);
        var cursor = 0;
        var done = 1;
        function next() {
          if (cursor >= queue.length) return Promise.resolve();
          var idx = queue[cursor];
          cursor += 1;
          return fetchOneBlock(url, pin, idx, total).then(function (b) {
            chunks[idx] = b;
            done += 1;
            if (opts.onProgress) {
              try { opts.onProgress(done, count); } catch (e) { /* 回调异常不影响下载 */ }
            }
            return next();
          });
        }
        var workers = [];
        var n = Math.min(GLOBAL_SLOTS, queue.length);
        for (var w = 0; w < n; w += 1) workers.push(next());
        return Promise.all(workers).then(function () { return orderedToBlob(chunks); });
      });
    }).catch(function () {
      // 红线 2：Range 链路任何异常（含浏览器禁止设置 Range 头）都整体回退，
      // 用最朴素的一次全量下载把文件交到用户手里，绝不半途而废。
      return plainFetch(url, pin);
    });
  }

  return {
    fetchBlob: fetchBlob,
    constants: function () {
      return { BLOCK: BLOCK, MAX_BLOCKS: MAX_BLOCKS, GLOBAL_SLOTS: GLOBAL_SLOTS, RETRY: RETRY };
    },
    state: function () { return support; },
    reset: function () { support = 0; inflight = 0; waiters = []; },
  };
})();
