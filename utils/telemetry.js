/* ============================================================
 * telemetry.js —— v21.0 全站轻量埋点与本地数据聚合层
 * ------------------------------------------------------------
 * 设计约束（严守 v16/v19 红线：零业务侵入、零网络请求、零第三方）：
 *   · classic IIFE，幂等挂载 window.SiteTelemetry；重复加载不重复记 PV。
 *   · 唯一落盘键 wb.telemetry.v1，全部读写 try/catch 包裹；隐私模式 /
 *     localStorage 被禁用 / 配额满 / 数据被投毒，一律静默降级为空视图，
 *     绝不抛异常、绝不白屏（混沌测试的降级基石）。
 *   · 工具使用频率靠 document 事件委托归因 [data-tool]，工具箱业务代码
 *     一个字都不改；节流 500ms 防止输入流把计数刷爆。
 *   · 网盘已用空间 = 扫描 LocalStorage 的 blogApiCache:* 文件清单 +
 *     IndexedDB drive_dl_parts/parts 分片 Blob + navigator.storage.estimate
 *     三段独立采集，任一段失败不影响其余，errors 逐项记录。
 *   · 严格 CSP：无 eval / 无内联脚本 / 无 fetch / 零 console 输出。
 *
 * 对外 API（window.SiteTelemetry，冻结）：
 *   trackPage(path)              记录一次 PV（按天 + 路径分桶）
 *   trackTool(toolId)            记录一次工具使用
 *   snapshot()                  同步返回净化后的统计视图模型
 *   readDriveUsage()            Promise<网盘空间视图模型>（含超时熔断）
 *   reset()                      清空统计（供大屏「清空」按钮 / 测试）
 *   debug()                      内部诊断（供 step31 断言）
 * ============================================================ */
(function () {
  "use strict";

  if (typeof window !== "undefined" && window.SiteTelemetry) return;

  var KEY = "wb.telemetry.v1";
  var MAX_DAYS = 30;
  var MAX_TOOLS = 40;
  var MAX_PATHS = 60;
  var MAX_PV = 1000000;
  var TOOL_RE = /^[a-z0-9_-]{1,32}$/i;
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var CACHE_PREFIX = "blogApiCache:";
  var IDB_NAME = "drive_dl_parts";
  var IDB_STORE = "parts";
  var ESTIMATE_TIMEOUT_MS = 1200;

  /* 安全存储：完全自包含，绝不读取 common.js 的 window.safeStorage。
   * arch-audit 会在 common.js（bootstrap 层）与 telemetry.js（shared 层）
   * 之间检测到双向全局引用；shared 是叶子层，不得反向依赖 bootstrap。
   * 这里内联等价实现，保持零业务侵入与依赖图 DAG。 */
  var SS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  var errors = [];
  function note(where, e) {
    if (errors.length < 24) errors.push(where + ":" + String((e && e.message) || e || "unknown").slice(0, 80));
  }

  /** @returns {string} 本地日期 YYYY-MM-DD（不用 UTC，贴合访客感知） */
  function today() {
    var d = new Date();
    function p(n) { return n < 10 ? "0" + n : String(n); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /** @returns {Object} 全新空状态 */
  function emptyState() {
    return { v: 1, pv: {}, tools: {}, updatedAt: 0 };
  }

  /* ---------- 净化：任何外来数据都要过这道闸，脏数据一律退化 ---------- */
  function sanitize(raw) {
    var out = emptyState();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

    // pv: { "YYYY-MM-DD": { "/path": count } }
    if (raw.pv && typeof raw.pv === "object" && !Array.isArray(raw.pv)) {
      var days = Object.keys(raw.pv).filter(function (k) { return DAY_RE.test(k); }).sort().slice(-MAX_DAYS);
      for (var i = 0; i < days.length; i++) {
        var day = days[i], bucket = raw.pv[day], clean = {};
        if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
          var paths = Object.keys(bucket).slice(0, MAX_PATHS);
          for (var j = 0; j < paths.length; j++) {
            var path = paths[j], n = bucket[path];
            if (typeof path !== "string" || path.charAt(0) !== "/" || path.length > 120) continue;
            if (typeof n === "number" && isFinite(n) && n > 0) clean[path] = Math.min(Math.floor(n), MAX_PV);
            else if (typeof n === "string" && /^\d+$/.test(n)) clean[path] = Math.min(Number(n), MAX_PV);
          }
        }
        out.pv[day] = clean;
      }
    }
    // tools: { toolId: count }
    if (raw.tools && typeof raw.tools === "object" && !Array.isArray(raw.tools)) {
      var ids = Object.keys(raw.tools).slice(0, MAX_TOOLS);
      for (var k = 0; k < ids.length; k++) {
        var id = ids[k], c = raw.tools[id];
        if (!TOOL_RE.test(id)) continue;
        if (typeof c === "number" && isFinite(c) && c > 0) out.tools[id] = Math.min(Math.floor(c), MAX_PV);
        else if (typeof c === "string" && /^\d+$/.test(c)) out.tools[id] = Math.min(Number(c), MAX_PV);
      }
    }
    if (typeof raw.updatedAt === "number" && isFinite(raw.updatedAt)) out.updatedAt = raw.updatedAt;
    return out;
  }

  /** @returns {Object} 读取并净化的状态（永不抛） */
  function load() {
    var raw = SS.get(KEY);
    if (!raw) return emptyState();
    try {
      return sanitize(JSON.parse(raw));
    } catch (e) {
      note("parse", e);
      // 数据被投毒：直接重写为空状态，让下一次写入恢复正常
      try { SS.set(KEY, JSON.stringify(emptyState())); } catch (e2) { note("selfheal", e2); }
      return emptyState();
    }
  }

  /** @param {Object} st @returns {boolean} 是否写盘成功 */
  function save(st) {
    try { SS.set(KEY, JSON.stringify(st)); return true; } catch (e) { note("save", e); return false; }
  }

  /* ---------- 写入 ---------- */
  function trackPage(path) {
    var st = load();
    var day = today();
    if (!st.pv[day]) st.pv[day] = {};
    var p = String(path || (typeof location !== "undefined" ? location.pathname : "/")).slice(0, 120);
    if (p.charAt(0) !== "/") p = "/" + p;
    st.pv[day][p] = Math.min((st.pv[day][p] || 0) + 1, MAX_PV);
    // 只保留最近 MAX_DAYS 天
    var days = Object.keys(st.pv).sort();
    while (days.length > MAX_DAYS) { delete st.pv[days.shift()]; }
    st.updatedAt = Date.now();
    return save(st);
  }

  function trackTool(toolId) {
    var id = String(toolId || "");
    if (!TOOL_RE.test(id)) return false;
    var st = load();
    if (Object.keys(st.tools).length >= MAX_TOOLS && !Object.prototype.hasOwnProperty.call(st.tools, id)) return false;
    st.tools[id] = Math.min((st.tools[id] || 0) + 1, MAX_PV);
    st.updatedAt = Date.now();
    return save(st);
  }

  /* ---------- 视图模型：大屏与测试共用同一份净化结果 ---------- */
  function snapshot() {
    var st = load();
    var total = 0, daily = [], byPath = {};
    var days = Object.keys(st.pv).sort();
    for (var i = 0; i < days.length; i++) {
      var bucket = st.pv[days[i]], sum = 0;
      var paths = Object.keys(bucket);
      for (var j = 0; j < paths.length; j++) {
        var n = bucket[paths[j]];
        sum += n;
        byPath[paths[j]] = (byPath[paths[j]] || 0) + n;
      }
      total += sum;
      daily.push({ day: days[i], count: sum });
    }
    // 补齐最近 14 天的空档，让趋势图不出现断崖
    var trend = [], base = new Date();
    for (var k = 13; k >= 0; k--) {
      var d = new Date(base.getTime() - k * 86400000);
      function p2(n) { return n < 10 ? "0" + n : String(n); }
      var key = d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
      var hit = null;
      for (var m = 0; m < daily.length; m++) if (daily[m].day === key) { hit = daily[m]; break; }
      trend.push({ day: key, count: hit ? hit.count : 0 });
    }
    var pathList = Object.keys(byPath).map(function (p) { return { path: p, count: byPath[p] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
    var toolList = Object.keys(st.tools).map(function (t) { return { tool: t, count: st.tools[t] }; })
      .sort(function (a, b) { return b.count - a.count; });
    var toolTotal = toolList.reduce(function (s, x) { return s + x.count; }, 0);
    return Object.freeze({
      ok: true,
      totalVisits: total,
      todayVisits: (trend[trend.length - 1] || {}).count || 0,
      trend: trend,
      topPaths: pathList,
      tools: toolList,
      toolTotal: toolTotal,
      trackedDays: days.length,
      updatedAt: st.updatedAt,
      errors: errors.slice(),
    });
  }

  /* ---------- 网盘已用空间：三段独立采集 ---------- */
  function scanLocalStorage() {
    var res = { apiBytes: 0, cacheBytes: 0, files: 0, entries: 0, ok: false };
    try {
      var i, keys = [];
      for (i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      for (i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!k || k.indexOf(CACHE_PREFIX) !== 0) continue;
        var raw = localStorage.getItem(k);
        if (typeof raw !== "string") continue;
        res.entries++;
        res.cacheBytes += raw.length * 2; // UTF-16 近似
        try {
          var parsed = JSON.parse(raw), data = parsed && parsed.data;
          var list = data && (Array.isArray(data) ? data : data.files);
          if (Array.isArray(list)) {
            for (var j = 0; j < list.length; j++) {
              var f = list[j], sz = f && f.size;
              if (typeof sz === "number" && isFinite(sz) && sz > 0) { res.apiBytes += sz; res.files++; }
            }
          }
        } catch (e) { note("cacheParse", e); }
      }
      res.ok = true;
    } catch (e) { note("scanLS", e); }
    return res;
  }

  function scanIndexedDB() {
    return new Promise(function (resolve) {
      var res = { bytes: 0, parts: 0, ok: false };
      if (typeof indexedDB === "undefined") { resolve(res); return; }
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(res); } }
      var guard = setTimeout(done, ESTIMATE_TIMEOUT_MS);
      var req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { note("idbOpen", e); clearTimeout(guard); done(); return; }
      req.onerror = function () { note("idbError", "open failed"); clearTimeout(guard); done(); };
      req.onupgradeneeded = function () {
        // 库不存在时创建一个空 store，随后 getAll 得到 0 条，属正常降级
        try { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE); } catch (e) { note("idbUpgrade", e); }
      };
      req.onsuccess = function () {
        var db = req.result;
        try {
          if (!db.objectStoreNames.contains(IDB_STORE)) { db.close(); clearTimeout(guard); done(); return; }
          var tx = db.transaction(IDB_STORE, "readonly");
          var all = tx.objectStore(IDB_STORE).getAll();
          all.onsuccess = function () {
            try {
              var arr = all.result || [];
              for (var i = 0; i < arr.length; i++) {
                var b = arr[i], sz = b && (b.size !== undefined ? b.size : (typeof b === "number" ? b : 0));
                if (typeof sz === "number" && isFinite(sz) && sz > 0) { res.bytes += sz; res.parts++; }
              }
              res.ok = true;
            } catch (e) { note("idbScan", e); }
            db.close(); clearTimeout(guard); done();
          };
          all.onerror = function () { note("idbGetAll", "failed"); db.close(); clearTimeout(guard); done(); };
        } catch (e) { note("idbTx", e); try { db.close(); } catch (e2) {} clearTimeout(guard); done(); }
      };
    });
  }

  function estimateSafe() {
    return new Promise(function (resolve) {
      var res = { usage: 0, quota: 0, ok: false };
      var settled = false;
      function done() { if (!settled) { settled = true; resolve(res); } }
      var guard = setTimeout(done, ESTIMATE_TIMEOUT_MS);
      try {
        if (!navigator.storage || typeof navigator.storage.estimate !== "function") { clearTimeout(guard); done(); return; }
        Promise.resolve(navigator.storage.estimate()).then(function (e) {
          if (e && typeof e.usage === "number" && isFinite(e.usage)) res.usage = e.usage;
          if (e && typeof e.quota === "number" && isFinite(e.quota)) res.quota = e.quota;
          res.ok = true;
          clearTimeout(guard); done();
        }, function () { clearTimeout(guard); done(); });
      } catch (e) { note("estimate", e); clearTimeout(guard); done(); }
    });
  }

  function readDriveUsage() {
    var ls = scanLocalStorage();
    return Promise.all([scanIndexedDB(), estimateSafe()]).then(function (pair) {
      var idb = pair[0], est = pair[1];
      var used = ls.apiBytes + idb.bytes;
      return Object.freeze({
        ok: true,
        apiBytes: ls.apiBytes,        // 云盘文件清单中的文件总大小
        cacheBytes: ls.cacheBytes,    // LocalStorage API 缓存自身占用
        idbBytes: idb.bytes,          // IndexedDB 下载分片占用
        files: ls.files,
        parts: idb.parts,
        entries: ls.entries,
        usedBytes: used,
        storageUsage: est.usage,
        storageQuota: est.quota,
        sources: Object.freeze({ localStorage: ls.ok, indexedDB: idb.ok, estimate: est.ok }),
        degraded: !(ls.ok && idb.ok && est.ok),
        errors: errors.slice(),
      });
    }, function () {
      return Object.freeze({
        ok: false, apiBytes: 0, cacheBytes: 0, idbBytes: 0, files: 0, parts: 0, entries: 0,
        usedBytes: 0, storageUsage: 0, storageQuota: 0,
        sources: Object.freeze({ localStorage: false, indexedDB: false, estimate: false }),
        degraded: true, errors: errors.slice(),
      });
    });
  }

  function reset() { try { SS.remove(KEY); return true; } catch (e) { note("reset", e); return false; } }

  /* ---------- 零侵入工具埋点：document 事件委托 + 节流 ---------- */
  var lastToolAt = Object.create(null);
  function onInteract(e) {
    var t = e && e.target;
    if (!t || typeof t.closest !== "function") return;
    var card = t.closest("[data-tool]");
    if (!card) return;
    var id = card.getAttribute("data-tool");
    if (!id || !TOOL_RE.test(id)) return;
    var now = Date.now();
    if (lastToolAt[id] && now - lastToolAt[id] < 500) return;
    lastToolAt[id] = now;
    trackTool(id);
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    ["input", "change", "click"].forEach(function (type) {
      try { document.addEventListener(type, onInteract, { passive: true, capture: true }); } catch (e) { note("bind:" + type, e); }
    });
  }

  var API = Object.freeze({
    version: "21.0.0",
    key: KEY,
    trackPage: trackPage,
    trackTool: trackTool,
    snapshot: snapshot,
    readDriveUsage: readDriveUsage,
    reset: reset,
    debug: function () { return Object.freeze({ errors: errors.slice(), sanitize: sanitize }); },
  });

  if (typeof window !== "undefined") window.SiteTelemetry = API;
  if (typeof self !== "undefined" && typeof window === "undefined") self.SiteTelemetry = API;

  // 首次加载记一次 PV（幂等：第二次加载因顶部 guard 直接返回，不会重复计数）
  trackPage(typeof location !== "undefined" ? location.pathname : "/");
})();
