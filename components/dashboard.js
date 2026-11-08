/* ============================================================
 * dashboard.js —— v21.0 全站数据大屏渲染引擎（classic IIFE）
 * ------------------------------------------------------------
 * 纯前端：只读 utils/telemetry.js 聚合的 LocalStorage / IndexedDB 数据，
 * 用 Canvas（折线 / 环形）与纯 CSS（条形）绘图，零网络、零第三方库。
 *
 * 优雅降级（模块二-3 混沌测试的验收面）：
 *   · SiteTelemetry 缺失 / 抛错        → 同步降级为空视图 + 明确提示，不白屏
 *   · localStorage 被投毒 / 非法 JSON  → telemetry 自愈，这里照常渲染 0 值
 *   · IndexedDB / storage.estimate 超时 → 双层超时熔断，先画已有数据再补空间
 *   · Canvas 2D 不可用 / 尺寸为 0     → 自动切换纯 CSS 表格兜底
 *   · 断网                            → 数据源全在本地，行为完全不变
 *   · 任一渲染分支抛错                → 局部 try/catch 隔离，记录到 Debug.errors
 *
 * 性能纪律（呼应模块二-1）：DOM 更新统一走 DocumentFragment 批量挂载，
 * 连续刷新用 requestAnimationFrame 合并，避免强制同步布局。
 *
 * 严格 CSP：无 eval、无内联脚本、无 innerHTML 用户输入、零 console 输出。
 * ============================================================ */
(function () {
  "use strict";

  var TOOL_NAMES = {
    json: "JSON 格式化", base64: "Base64 编解码", timestamp: "时间戳转换",
    password: "密码生成器", hash: "文本哈希", probe: "状态码探测",
    ipinfo: "IP 归属查询", regex: "正则测试器", qrcode: "二维码生成",
    image: "图片压缩", diff: "文本 Diff", gradient: "渐变生成器",
    cron: "Cron 表达式", url: "URL 编解码", case: "命名法转换",
  };
  var PALETTE = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#ec4899", "#84cc16"];
  var state = { rendered: false, degraded: false, errors: [], drive: null, snapshot: null, canvasFallback: 0 };

  function $(id) { return document.getElementById(id); }
  function text(el, v) { if (el) el.textContent = v == null ? "" : String(v); }
  function note(where, e) {
    if (state.errors.length < 20) state.errors.push(where + ":" + String((e && e.message) || e || "?").slice(0, 80));
  }
  function num(n) { return (typeof n === "number" && isFinite(n) ? n : 0).toLocaleString("zh-CN"); }

  function fmtBytes(n) {
    var v = typeof n === "number" && isFinite(n) && n > 0 ? n : 0;
    if (v < 1024) return v + " B";
    var u = ["KB", "MB", "GB", "TB"], i = -1, x = v;
    do { x /= 1024; i++; } while (x >= 1024 && i < u.length - 1);
    return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + " " + u[i];
  }

  /* ---------- 数据读取：永不抛，任何异常都退化为空模型 ---------- */
  function emptySnapshot() {
    var trend = [];
    for (var i = 13; i >= 0; i--) trend.push({ day: "—", count: 0 });
    return { ok: false, totalVisits: 0, todayVisits: 0, trend: trend, topPaths: [], tools: [], toolTotal: 0, trackedDays: 0, updatedAt: 0, errors: [] };
  }

  function readSnapshot() {
    var T = window.SiteTelemetry;
    if (!T || typeof T.snapshot !== "function") { state.degraded = true; return emptySnapshot(); }
    try {
      var s = T.snapshot();
      if (!s || !Array.isArray(s.trend)) return emptySnapshot();
      return s;
    } catch (e) { note("snapshot", e); state.degraded = true; return emptySnapshot(); }
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      setTimeout(function () { fin(null); }, ms);
      try { Promise.resolve(p).then(function (v) { fin(v); }, function () { fin(null); }); }
      catch (e) { fin(null); }
    });
  }

  /* ---------- Canvas 基元 ---------- */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  /**
   * 准备高分屏画布；返回 null 表示 Canvas 不可用（调用方切 CSS 兜底）。
   * @param {HTMLCanvasElement} cv 画布
   * @returns {CanvasRenderingContext2D|null}
   */
  function prep(cv) {
    if (!cv || typeof cv.getContext !== "function") return null;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    var ctx;
    try { ctx = cv.getContext("2d"); } catch (e) { note("getContext", e); return null; }
    if (!ctx) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  /** 折线 + 面积趋势图；失败返回 false 触发表格兜底 */
  function drawTrend(cv, trend) {
    var ctx = prep(cv);
    if (!ctx) return false;
    try {
      var w = cv.clientWidth, h = cv.clientHeight;
      var padL = 38, padR = 10, padT = 12, padB = 26;
      var cw = w - padL - padR, ch = h - padT - padB;
      var vals = trend.map(function (d) { return Math.max(0, Number(d.count) || 0); });
      var max = Math.max.apply(null, vals.concat([1]));
      var grid = cssVar("--border", "#eaecef");
      var mute = cssVar("--text-mute", "#6b7280");
      var primary = cssVar("--primary", "#4f46e5");
      var i, gy;
      ctx.lineWidth = 1;
      ctx.font = "10px -apple-system, sans-serif";
      ctx.fillStyle = mute;
      ctx.textAlign = "right";
      for (i = 0; i <= 3; i++) {
        gy = padT + (ch * i) / 3;
        ctx.strokeStyle = grid;
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
        ctx.fillText(String(Math.round(max * (3 - i) / 3)), padL - 6, gy + 3);
      }
      var px = function (k) { return padL + (vals.length === 1 ? cw / 2 : (cw * k) / (vals.length - 1)); };
      var py = function (v) { return padT + ch - (ch * v) / max; };
      // 面积
      var grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
      grad.addColorStop(0, "rgba(99,102,241,0.30)");
      grad.addColorStop(1, "rgba(99,102,241,0.01)");
      ctx.beginPath();
      ctx.moveTo(px(0), py(vals[0]));
      for (i = 1; i < vals.length; i++) ctx.lineTo(px(i), py(vals[i]));
      ctx.lineTo(px(vals.length - 1), padT + ch);
      ctx.lineTo(px(0), padT + ch);
      ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      // 折线
      ctx.beginPath();
      ctx.moveTo(px(0), py(vals[0]));
      for (i = 1; i < vals.length; i++) ctx.lineTo(px(i), py(vals[i]));
      ctx.strokeStyle = primary; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      // 数据点 + 隔 3 天的日期标签
      ctx.fillStyle = primary;
      ctx.textAlign = "center";
      for (i = 0; i < vals.length; i++) {
        ctx.beginPath(); ctx.arc(px(i), py(vals[i]), 2.4, 0, Math.PI * 2); ctx.fill();
        var label = String(trend[i].day || "");
        if (i % 3 === 0 || i === vals.length - 1) ctx.fillText(label.slice(5), px(i), h - 8);
      }
      return true;
    } catch (e) { note("drawTrend", e); return false; }
  }

  /** 环形图；失败返回 false 触发表格兜底 */
  function drawRing(cv, segments) {
    var ctx = prep(cv);
    if (!ctx) return false;
    try {
      var w = cv.clientWidth, h = cv.clientHeight;
      var cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 12, inner = r * 0.62;
      var total = segments.reduce(function (s, x) { return s + Math.max(0, x.value || 0); }, 0);
      var start = -Math.PI / 2, i, seg, sweep;
      if (total <= 0) {
        ctx.beginPath(); ctx.arc(cx, cy, (r + inner) / 2, 0, Math.PI * 2);
        ctx.lineWidth = r - inner;
        ctx.strokeStyle = "rgba(99,102,241,0.14)";
        ctx.stroke();
      } else {
        for (i = 0; i < segments.length; i++) {
          seg = segments[i];
          if (!seg.value || seg.value <= 0) continue;
          sweep = (Math.PI * 2 * seg.value) / total;
          ctx.beginPath();
          ctx.arc(cx, cy, (r + inner) / 2, start, start + sweep);
          ctx.lineWidth = r - inner;
          ctx.strokeStyle = seg.color;
          ctx.stroke();
          start += sweep;
        }
      }
      ctx.textAlign = "center";
      ctx.fillStyle = cssVar("--text", "#333");
      ctx.font = "700 20px -apple-system, sans-serif";
      ctx.fillText(fmtBytes(total), cx, cy + 2);
      ctx.fillStyle = cssVar("--text-mute", "#6b7280");
      ctx.font = "11px -apple-system, sans-serif";
      ctx.fillText("本地缓存占用", cx, cy + 20);
      return true;
    } catch (e) { note("drawRing", e); return false; }
  }

  /* ---------- 纯 CSS 兜底表 ---------- */
  function fallbackTable(host, rows) {
    if (!host) return;
    state.canvasFallback++;
    var table = document.createElement("table");
    table.className = "db-fallback";
    var thead = document.createElement("thead");
    var trh = document.createElement("tr");
    ["项目", "数值"].forEach(function (t) { var th = document.createElement("th"); th.textContent = t; trh.appendChild(th); });
    thead.appendChild(trh); table.appendChild(thead);
    var tbody = document.createElement("tbody");
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var a = document.createElement("td"), b = document.createElement("td");
      a.textContent = r[0]; b.textContent = r[1];
      tr.appendChild(a); tr.appendChild(b); frag.appendChild(tr);
    });
    tbody.appendChild(frag); table.appendChild(tbody);
    host.textContent = "";
    host.appendChild(table);
  }

  /* ---------- 各区块渲染（全部局部隔离） ---------- */
  function renderKpis(s) {
    text($("db-kpi-visits"), num(s.totalVisits));
    text($("db-kpi-today"), num(s.todayVisits));
    text($("db-kpi-tools"), num(s.toolTotal));
    text($("db-kpi-days"), num(s.trackedDays));
    text($("db-kpi-meta"), s.ok ? "埋点数据 · 最近 " + s.trackedDays + " 天有记录" : "数据模块未就绪，已降级为空视图");
  }

  function renderTrend(s) {
    var cv = $("db-canvas-trend"), host = $("db-trend-host");
    if (cv && drawTrend(cv, s.trend)) { if (host) host.hidden = true; return; }
    if (cv) cv.hidden = true;
    fallbackTable(host || $("db-panel-trend"), s.trend.slice(-7).map(function (d) { return [d.day, num(d.count) + " 次"]; }));
    if (host) host.hidden = false;
  }

  function renderTools(s) {
    var host = $("db-bars"), empty = $("db-tools-empty"), meta = $("db-tools-meta");
    if (!host) return;
    var list = (s.tools || []).slice(0, 8);
    text(meta, "共 " + (s.tools || []).length + " 个工具 · 累计 " + num(s.toolTotal) + " 次");
    if (!list.length) { host.textContent = ""; if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    var max = Math.max.apply(null, list.map(function (x) { return x.count; }).concat([1]));
    var frag = document.createDocumentFragment();
    list.forEach(function (item, i) {
      var row = document.createElement("div");
      row.className = "db-bar";
      var name = document.createElement("span");
      name.className = "db-bar__name";
      name.textContent = TOOL_NAMES[item.tool] || item.tool;
      var track = document.createElement("span");
      track.className = "db-bar__track";
      var fill = document.createElement("span");
      fill.className = "db-bar__fill";
      fill.style.width = Math.max(2, (100 * item.count) / max).toFixed(1) + "%";
      fill.style.background = "linear-gradient(90deg," + PALETTE[i % PALETTE.length] + "," + PALETTE[(i + 1) % PALETTE.length] + ")";
      track.appendChild(fill);
      var n = document.createElement("span");
      n.className = "db-bar__num";
      n.textContent = num(item.count);
      row.appendChild(name); row.appendChild(track); row.appendChild(n);
      frag.appendChild(row);
    });
    host.textContent = "";
    host.appendChild(frag);
  }

  function renderPaths(s) {
    var host = $("db-paths");
    if (!host) return;
    var list = s.topPaths || [];
    if (!list.length) { text(host, "暂无页面级访问记录"); return; }
    var frag = document.createDocumentFragment();
    list.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "db-bar";
      var name = document.createElement("span");
      name.className = "db-bar__name";
      name.textContent = p.path;
      name.title = p.path;
      var track = document.createElement("span");
      track.className = "db-bar__track";
      var fill = document.createElement("span");
      fill.className = "db-bar__fill";
      var max = Math.max.apply(null, list.map(function (x) { return x.count; }).concat([1]));
      fill.style.width = Math.max(2, (100 * p.count) / max).toFixed(1) + "%";
      track.appendChild(fill);
      var n = document.createElement("span");
      n.className = "db-bar__num";
      n.textContent = num(p.count);
      row.appendChild(name); row.appendChild(track); row.appendChild(n);
      frag.appendChild(row);
    });
    host.textContent = "";
    host.appendChild(frag);
  }

  function renderDrive(d) {
    var ok = !!d && d.ok !== false;
    var api = ok ? d.apiBytes : 0, cache = ok ? d.cacheBytes : 0, idb = ok ? d.idbBytes : 0;
    text($("db-kpi-space"), fmtBytes(api + idb + cache));
    text($("db-space-meta"), ok
      ? (d.files + " 个云盘文件 · " + d.parts + " 个下载分片 · " + d.entries + " 条 API 缓存")
      : "空间统计暂不可用（已降级）");
    var segs = [
      { label: "云盘文件清单", value: api, color: PALETTE[0] },
      { label: "IndexedDB 分片", value: idb, color: PALETTE[1] },
      { label: "API 缓存", value: cache, color: PALETTE[2] },
    ];
    var cv = $("db-canvas-ring"), host = $("db-ring-fallback");
    if (cv && drawRing(cv, segs)) { if (host) host.hidden = true; }
    else {
      if (cv) cv.hidden = true;
      fallbackTable(host || $("db-panel-space"), segs.map(function (x) { return [x.label, fmtBytes(x.value)]; }));
      if (host) host.hidden = false;
    }
    var legend = $("db-legend");
    if (legend) {
      var frag = document.createDocumentFragment();
      segs.forEach(function (x) {
        var item = document.createElement("span");
        item.className = "db-legend__item";
        var dot = document.createElement("span");
        dot.className = "db-legend__dot";
        dot.style.background = x.color;
        var label = document.createElement("span");
        label.textContent = x.label + " " + fmtBytes(x.value);
        item.appendChild(dot); item.appendChild(label); frag.appendChild(item);
      });
      legend.textContent = "";
      legend.appendChild(frag);
    }
    var usage = ok ? d.storageUsage : 0, quota = ok ? d.storageQuota : 0;
    text($("db-quota-text"), quota > 0 ? fmtBytes(usage) + " / " + fmtBytes(quota) : "浏览器未提供配额信息");
    var fill = $("db-quota-fill");
    if (fill) fill.style.width = quota > 0 ? Math.min(100, (100 * usage) / quota).toFixed(1) + "%" : "0%";
    if (d && d.degraded) state.degraded = true;
  }

  function renderStatus(s, d) {
    var badges = $("db-badges");
    if (!badges) return;
    var frag = document.createDocumentFragment();
    function add(cls, label) {
      var el = document.createElement("span");
      el.className = "db-badge " + cls;
      el.textContent = label;
      frag.appendChild(el);
    }
    add("db-badge--ok", "数据源：LocalStorage + IndexedDB");
    add(state.degraded ? "db-badge--warn" : "db-badge--ok", state.degraded ? "部分数据源降级" : "全量数据正常");
    add("db-badge--ok", navigator.onLine ? "在线" : "离线（本地数据不受影响）");
    if (d && d.sources) {
      if (!d.sources.localStorage) add("db-badge--warn", "LocalStorage 不可读");
      if (!d.sources.indexedDB) add("db-badge--warn", "IndexedDB 不可用");
      if (!d.sources.estimate) add("db-badge--warn", "配额接口超时");
    }
    if (s.errors && s.errors.length) add("db-badge--warn", s.errors.length + " 条脏数据已自愈");
    badges.textContent = "";
    badges.appendChild(frag);
    text($("db-updated"), s.updatedAt ? "数据更新于 " + new Date(s.updatedAt).toLocaleString("zh-CN") : "尚无埋点记录，开始浏览站点后自动累计");
  }

  /* ---------- 主流程 ---------- */
  var pending = false;
  function render() {
    if (pending) return;
    pending = true;
    // rAF 合并连续刷新，避免同步布局抖动
    var run = function () {
      pending = false;
      state.degraded = false;
      var s = readSnapshot();
      state.snapshot = s;
      renderKpis(s);
      renderTrend(s);
      renderTools(s);
      renderPaths(s);
      renderStatus(s, null);
      var T = window.SiteTelemetry;
      var p = (T && typeof T.readDriveUsage === "function")
        ? withTimeout(T.readDriveUsage(), 2600)
        : Promise.resolve(null);
      p.then(function (d) {
        state.drive = d;
        renderDrive(d);
        renderStatus(s, d);
        state.rendered = true;
      }, function () {
        renderDrive(null);
        renderStatus(s, null);
        state.rendered = true;
      });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }

  function bindActions() {
    var refresh = $("db-refresh");
    if (refresh) refresh.addEventListener("click", render);
    var clear = $("db-clear");
    if (clear) clear.addEventListener("click", function () {
      var T = window.SiteTelemetry;
      if (T && typeof T.reset === "function") { try { T.reset(); } catch (e) { note("reset", e); } }
      render();
    });
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("resize", function () {
        if (state.rendered) render();
      }, { passive: true });
    }
  }

  /** 调试 / 混沌测试只读接口 + 主动刷新句柄 */
  window.DashboardDebug = Object.freeze({
    version: "21.0.0",
    render: render,
    state: function () {
      return Object.freeze({
        rendered: state.rendered, degraded: state.degraded,
        errors: state.errors.slice(), canvasFallback: state.canvasFallback,
        hasTelemetry: !!window.SiteTelemetry,
        totalVisits: state.snapshot ? state.snapshot.totalVisits : 0,
        driveOk: !!(state.drive && state.drive.ok !== false),
      });
    },
  });

  function boot() { bindActions(); render(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
