/* ============================================================
 * toolbox.js —— 极客工具箱 v15.0 · UI 薄层控制器
 * ------------------------------------------------------------
 * 架构纪律（v14 模块一，v15 完整继承）：
 *   1) 纯函数彻底抽离：所有算法在 utils/toolbox-pure.js；本文件只做
 *      「读 DOM → 调 ToolboxPure / ToolboxCompute → 写 DOM」，不含任何
 *      正则解析 / Base64 / MD5 / Diff / 颜色换算的实现。
 *   2) 重计算异步化：正则 / Diff / 图片压缩经 ToolboxCompute 派发到
 *      utils/toolbox-worker.js，带超时熔断与主线程自动降级。
 *   3) 请求层净化：后端工具一律 window.BlogApi.get()，绝不裸 fetch。
 *   4) 魔法数字清零：防抖 / 超时 / 时钟 / 尺寸 / 熵阈值全部读
 *      ToolboxConstants，本文件不出现裸阈值字面量。
 *   5) 内存泄漏治理：所有 addEventListener / setInterval / setTimeout /
 *      Worker 调用经 ToolboxScope 登记；Tab 切换销毁在途作用域，
 *      pagehide 销毁根作用域并 terminate Worker。
 *
 * Tab 策略（v14 模块二，v15 扩充至 8 张）：
 *   默认 Tab A【常规工具】= 7 张卡（与 v13.0 完全兼容，step26 零改动）；
 *   Tab B【进阶工具】的 8 张卡放在 inert <template>，首次激活才克隆挂载，
 *   因此默认视图的 DOM 卡片数恒为 7。两个 Tab 共用折叠 / 复制事件委托。
 *
 * v15.0 新增（模块一 / 二 / 三）：
 *   13 Cron 生成器、14 URL 编解码器、15 文本大小写转换器，全部沿用
 *   「读 DOM → 调 ToolboxPure → 写 DOM」薄层纪律，零算法下沉到 UI。
 *   离线守卫：navigator.onLine === false 时跳过注定失败的 IP 查询，
 *   给出明确离线提示，保证断网页面零错误噪声（配合 SW 完全离线）。
 *   键盘守卫：仅在 visualViewport 被软键盘压缩时把聚焦输入框滚入可视区，
 *   桌面 / 无键盘环境零干预，所有监听都登记进 rootScope。
 *
 * 严格 CSP：无内联脚本、无 eval、无第三方运行时；用户输入一律
 * textContent 或经 ToolboxPure.escapeHtml 转义后再拼 HTML。
 * ============================================================ */
(function () {
  "use strict";

  var C = window.ToolboxConstants;
  var P = window.ToolboxPure;
  var S = window.ToolboxScope;
  var Compute = window.ToolboxCompute;
  var toast = window.UI.toast;
  var copyText = window.UI.copyText;

  /** @param {string} id 元素 id @returns {HTMLElement|null} */
  function $(id) { return document.getElementById(id); }
  /** 安全写入文本（绝不 innerHTML 用户输入） */
  function text(el, v) { if (el) el.textContent = v == null ? "" : String(v); }
  function noop() {}

  /**
   * 统一状态行渲染（状态前缀取自常量，杜绝散落字面量）。
   * @param {string} id 状态元素 id
   * @param {boolean} ok 是否成功
   * @param {string} msg 说明
   * @param {"OK"|"VALID"} [okWord] 成功前缀类型
   * @returns {void}
   */
  function setStatus(id, ok, msg, okWord) {
    var el = $(id);
    if (!el) return;
    el.className = "tb-status " + (ok ? "tb-status-ok" : "tb-status-bad");
    text(el, (ok ? (okWord === "VALID" ? C.STATUS_VALID : C.STATUS_OK) : C.STATUS_ERROR) + msg);
  }

  /**
   * 带作用域的防抖：定时器登记进 Scope，dispose 时立即 clearTimeout。
   * 相比 BlogUtils.debounce，额外保证「工具切走后不再有悬挂回调」。
   * @param {Object} scope 生命周期作用域
   * @param {function():void} fn 目标函数
   * @param {number} ms 防抖时长
   * @returns {function():void} 防抖包装
   */
  function scopedDebounce(scope, fn, ms) {
    var timer = null;
    var wrapped = function () {
      var args = arguments, self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!scope.disposed()) fn.apply(self, args);
      }, ms);
    };
    scope.add(function () { if (timer) { clearTimeout(timer); timer = null; } });
    return wrapped;
  }

  /** 让回调在作用域销毁后自动失效，防止异步结果写回已卸载的 DOM */
  function guarded(scope, fn) {
    return function () {
      if (scope.disposed()) return undefined;
      return fn.apply(this, arguments);
    };
  }

  /* ============================================================
   * 全局状态（仅 UI 编排，不含算法）
   * ============================================================ */
  var rootScope = S.create("root");
  var tabScope = null;
  var lastDisposedScope = null;
  var activeTab = "basic";
  var advancedMounted = false;
  var hashSeq = 0, probeSeq = 0, ipSeq = 0;
  var imgState = { buffer: null, type: "", name: "" };
  var lastQr = null;

  /* ---------- Tab A 默认值：仅首屏播种一次，Tab 往返不覆盖用户输入 ----------
   * Tab B 的默认值直接写在 <template> 的 DOM 属性 / textarea 正文里，
   * 克隆即带值，无需 JS 播种（template.content 不属于文档树，
   * getElementById 在克隆前取不到，这是不能用 JS 播种的根本原因）。 */
  var JSON_SAMPLE = '{"project":"toolbox","version":"15.0","stack":["Cloudflare Workers","PWA","TailwindCSS","Web Worker"],"features":{"frontend":7,"backend":2,"advanced":8,"total":15,"offline":true,"ssrfGuard":true,"latencyMs":null},"author":{"name":"Lei Yihan","site":"https://leiyihan.dpdns.org"}}';

  function seedDefaults() {
    if ($("json-input")) $("json-input").value = JSON_SAMPLE;
    if ($("b64-input")) $("b64-input").value = "极客工具箱 · Toolbox v15.0 🚀";
    if ($("ts-input")) $("ts-input").value = String(Date.now());
    if ($("hash-input")) $("hash-input").value = "Hello, Toolbox v15.0 — 极客工具箱";
    if ($("probe-url")) $("probe-url").value = "https://www.baidu.com";
    if ($("pw-length") && $("pw-length-num")) $("pw-length-num").value = $("pw-length").value;
  }

  /* ============================================================
   * 全局事件委托：一键复制 / 卡片折叠 / Tab（注册一次，永不重复绑定）
   * ============================================================ */
  function initGlobalDelegates(scope) {
    scope.on(document, "click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
      if (!btn) return;
      var src = $(btn.getAttribute("data-copy"));
      if (!src) return;
      var value = ("value" in src) ? src.value : src.textContent;
      if (!value) { toast("没有可复制的内容", "warn"); return; }
      Promise.resolve(copyText(value)).then(function (ok) {
        if (scope.disposed()) return;
        toast(ok ? "已复制到剪贴板" : "复制失败，请手动选中", ok ? "success" : "error");
        if (!ok || btn.dataset.copyBusy) return;
        btn.dataset.copyBusy = "1";
        var old = btn.textContent;
        btn.textContent = "✓ 已复制";
        scope.timeout(function () {
          btn.textContent = old;
          delete btn.dataset.copyBusy;
        }, C.COPY_FEEDBACK_MS);
      }, noop);
    });

    scope.on(document, "click", function (e) {
      var head = e.target && e.target.closest ? e.target.closest(".tb-card-head") : null;
      if (!head) return;
      var card = head.closest(".tb-card");
      if (!card) return;
      var collapsed = card.classList.toggle("is-collapsed");
      head.setAttribute("aria-expanded", String(!collapsed));
    });

    function setAll(collapsed) {
      document.querySelectorAll(".tb-card").forEach(function (card) {
        card.classList.toggle("is-collapsed", collapsed);
        var head = card.querySelector(".tb-card-head");
        if (head) head.setAttribute("aria-expanded", String(!collapsed));
      });
    }
    scope.on($("tb-expand-all"), "click", function () { setAll(false); });
    scope.on($("tb-collapse-all"), "click", function () { setAll(true); });

    ["basic", "advanced"].forEach(function (name) {
      var btn = $("tb-tab-" + name);
      scope.on(btn, "click", function () { activateTab(name); });
      scope.on(btn, "keydown", function (e) {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        var next = name === "basic" ? "advanced" : "basic";
        activateTab(next);
        var el = $("tb-tab-" + next);
        if (el) el.focus();
      });
    });
  }

  /* ============================================================
   * 01 JSON 格式化 —— 纯函数层：ToolboxPure.formatJson
   * ============================================================ */
  function runJson(mode) {
    var input = $("json-input"), out = $("json-output");
    if (!input || !out) return;
    var src = input.value.trim();
    if (!src) {
      out.innerHTML = '<span class="tb-dim">// 等待输入 JSON…</span>';
      setStatus("json-status", true, "等待输入", "VALID");
      return;
    }
    var r = P.formatJson(src, mode);
    if (!r.ok) {
      out.textContent = "";
      setStatus("json-status", false, r.error);
      return;
    }
    out.innerHTML = r.html; // r.html 已逐段 HTML 转义，安全
    setStatus("json-status", true, (mode === "minify" ? "已压缩" : "已格式化") +
      " · " + r.chars + " 字符 / " + r.bytes + " 字节 · " + r.kind, "VALID");
  }

  function initJson(scope) {
    var input = $("json-input");
    if (!input) return;
    var auto = scopedDebounce(scope, function () { runJson("format"); }, C.DEBOUNCE_MS);
    scope.on(input, "input", auto);
    scope.on($("json-btn-format"), "click", guarded(scope, function () { runJson("format"); }));
    scope.on($("json-btn-minify"), "click", guarded(scope, function () { runJson("minify"); }));
    scope.on($("json-btn-clear"), "click", guarded(scope, function () {
      input.value = ""; runJson("format"); input.focus();
    }));
    runJson("format");
  }

  /* ============================================================
   * 02 Base64 —— 纯函数层：ToolboxPure.base64Convert
   * ============================================================ */
  function runB64() {
    var input = $("b64-input"), out = $("b64-output"), mode = $("b64-mode");
    if (!input || !out || !mode) return;
    var src = input.value;
    if (!src) { out.value = ""; setStatus("b64-status", true, "等待输入"); return; }
    var r = P.base64Convert(src, mode.value);
    if (!r.ok) {
      out.value = "";
      setStatus("b64-status", false, mode.value === "decode"
        ? "不是合法的 Base64，或解码结果不是有效 UTF-8 文本"
        : "编码失败：" + r.error.slice(0, 100));
      return;
    }
    out.value = r.value;
    setStatus("b64-status", true, mode.value === "decode"
      ? "Base64 → UTF-8 · " + r.outBytes + " 字节"
      : "UTF-8 → Base64 · " + r.srcBytes + " 字节 → " + r.outBytes + " 字符");
  }

  function initB64(scope) {
    var input = $("b64-input"), mode = $("b64-mode");
    if (!input) return;
    var auto = scopedDebounce(scope, runB64, C.DEBOUNCE_MS);
    scope.on(input, "input", auto);
    scope.on(mode, "change", guarded(scope, runB64));
    scope.on($("b64-btn-clear"), "click", guarded(scope, function () {
      input.value = ""; runB64(); input.focus();
    }));
    scope.on($("b64-btn-swap"), "click", guarded(scope, function () {
      var out = $("b64-output");
      if (!out || !out.value) { toast("输出为空，无法交换", "warn"); return; }
      input.value = out.value;
      mode.value = mode.value === "encode" ? "decode" : "encode";
      runB64();
    }));
    runB64();
  }

  /* ============================================================
   * 03 时间戳 —— 纯函数层：parseTimestampInput / timestampLines
   * ============================================================ */
  function runTs() {
    var input = $("ts-input"), out = $("ts-output");
    if (!input || !out) return;
    var raw = input.value.trim();
    if (!raw) {
      text(out, "// 等待输入时间戳或日期时间…");
      setStatus("ts-status", true, "等待输入");
      return;
    }
    var d = P.parseTimestampInput(raw);
    if (!d || isNaN(d.getTime())) {
      text(out, "");
      setStatus("ts-status", false, "无法解析，请输入 10/13 位时间戳或 YYYY-MM-DD HH:mm:ss");
      return;
    }
    text(out, P.timestampLines(d, Date.now()).join("\n"));
    setStatus("ts-status", true, "解析成功 · 时区 " +
      (Intl.DateTimeFormat().resolvedOptions().timeZone || "本地"));
  }

  function tickNow() {
    var now = Date.now();
    text($("ts-now-s"), Math.floor(now / 1000));
    text($("ts-now-ms"), now);
  }

  function initTs(scope) {
    var input = $("ts-input"), mode = $("ts-mode");
    if (!input) return;
    var auto = scopedDebounce(scope, runTs, C.DEBOUNCE_MS);
    scope.on(input, "input", auto);
    scope.on(mode, "change", guarded(scope, function () {
      var m = mode.value;
      input.placeholder = m === "ts2date" ? "例如 1730889600 或 1730889600000" : "例如 2026-11-06 16:08:17";
      input.value = m === "ts2date" ? String(Date.now()) : P.formatLocal(new Date());
      runTs();
    }));
    scope.on($("ts-btn-now"), "click", guarded(scope, function () {
      input.value = String(Date.now());
      mode.value = "ts2date";
      runTs();
    }));
    runTs();
    tickNow();
    scope.interval(guarded(scope, tickNow), C.CLOCK_TICK_MS);
  }

  /* ============================================================
   * 04 密码生成器 —— 纯函数层：ToolboxPure.generatePassword
   * ============================================================ */
  function readPwOptions() {
    function checked(k) { var el = $("pw-" + k); return !!(el && el.checked); }
    return {
      length: parseInt(($("pw-length") || {}).value, 10),
      upper: checked("upper"), lower: checked("lower"),
      digit: checked("digit"), symbol: checked("symbol"),
    };
  }

  function runPw() {
    var r = P.generatePassword(readPwOptions());
    var out = $("pw-output"), bar = $("pw-strength-bar");
    if (!r.ok) {
      if (out) out.value = "";
      text($("pw-strength-text"), r.reason);
      if (bar) { bar.style.width = "0%"; bar.className = "tb-bar-fill"; }
      text($("pw-entropy"), "—");
      return;
    }
    if (out) out.value = r.password;
    if (bar) { bar.style.width = r.pct + "%"; bar.className = "tb-bar-fill " + r.levelClass; }
    text($("pw-strength-text"), "强度：" + r.level);
    text($("pw-entropy"), r.bits + " bits 熵 · " + r.length + " 位 · 字符集 " + r.charsetSize);
  }

  function initPw(scope) {
    if (!$("pw-length")) return;
    var range = $("pw-length"), num = $("pw-length-num");
    var auto = scopedDebounce(scope, runPw, C.DEBOUNCE_MS);
    scope.on(range, "input", guarded(scope, function () { num.value = range.value; auto(); }));
    scope.on(num, "input", guarded(scope, function () {
      var v = Math.max(C.PW_MIN_LEN, Math.min(C.PW_MAX_LEN, parseInt(num.value, 10) || C.PW_DEFAULT_LEN));
      range.value = v; auto();
    }));
    ["upper", "lower", "digit", "symbol"].forEach(function (k) {
      scope.on($("pw-" + k), "change", auto);
    });
    scope.on($("pw-btn-gen"), "click", guarded(scope, runPw));
    runPw();
  }

  /* ============================================================
   * 05 文本哈希 —— 纯函数层：ToolboxPure.hashAll
   * ============================================================ */
  function runHash() {
    var input = $("hash-input");
    if (!input) return Promise.resolve();
    var seq = ++hashSeq;
    var src = input.value;
    var ids = ["hash-md5", "hash-sha1", "hash-sha256", "hash-sha512"];
    if (!src) {
      ids.forEach(function (id) { text($(id), "—"); });
      setStatus("hash-status", true, "等待输入 · 0 字节");
      return Promise.resolve();
    }
    return P.hashAll(src).then(function (r) {
      if (seq !== hashSeq) return; // 快速输入乱序保护
      if (!r.ok) { setStatus("hash-status", false, "计算失败：" + r.error); return; }
      C.HASH_ALGOS.forEach(function (algo, i) { text($(ids[i]), r.hashes[algo] || "—"); });
      setStatus("hash-status", true, "本地计算完成 · " + r.bytes + " 字节 · " + C.HASH_ALGOS.length + " 种摘要");
    }, noop);
  }

  function initHash(scope) {
    var input = $("hash-input");
    if (!input) return;
    scope.on(input, "input", scopedDebounce(scope, function () { runHash(); }, C.DEBOUNCE_MS));
    scope.on($("hash-btn-clear"), "click", guarded(scope, function () {
      input.value = ""; runHash(); input.focus();
    }));
    runHash();
  }

  /* ============================================================
   * 06 状态码探测 / 07 IP 查询 —— 统一走 BlogApi
   * ============================================================ */
  function probeClass(code) {
    if (code >= C.HTTP_2XX && code < C.HTTP_3XX) return "tb-ok";
    if (code >= C.HTTP_3XX && code < C.HTTP_4XX) return "tb-redirect";
    if (code >= C.HTTP_4XX && code < C.HTTP_5XX) return "tb-warn";
    if (code >= C.HTTP_5XX) return "tb-bad";
    return "tb-dim";
  }

  function renderProbe(d) {
    var badge = $("probe-status"), label = $("probe-status-text");
    if (!badge || !label) return;
    var code = d && d.httpStatus ? d.httpStatus : 0;
    badge.className = "tb-code-badge " + probeClass(code);
    text(label, code ? String(code) : "ERR");
    text($("probe-status-desc"), d && d.statusText ? d.statusText : (d && d.error ? "探测失败" : "—"));
    text($("probe-latency"), d && typeof d.elapsed === "number" ? d.elapsed + " ms" : "—");
    text($("probe-method"), d && d.method ? d.method : "—");
    text($("probe-target"), d && d.url ? d.url : "—");
    var tbody = $("probe-headers");
    if (tbody) {
      tbody.textContent = "";
      var hs = (d && d.headers) || {}, keys = Object.keys(hs);
      if (!keys.length) {
        var tr0 = document.createElement("tr"), td0 = document.createElement("td");
        td0.colSpan = 2; td0.className = "tb-dim"; td0.textContent = "（无响应头）";
        tr0.appendChild(td0); tbody.appendChild(tr0);
      } else {
        keys.forEach(function (k) {
          var tr = document.createElement("tr");
          var a = document.createElement("td"), b = document.createElement("td");
          a.textContent = k; b.textContent = hs[k];
          tr.appendChild(a); tr.appendChild(b); tbody.appendChild(tr);
        });
      }
    }
    var note = $("probe-note");
    if (note) {
      note.className = "tb-note " + (d && d.status === "error" ? "tb-note-bad" : "");
      text(note, d && d.status === "error"
        ? "✕ " + (d.error || "目标不可达") + "（" + (d.code || "NETWORK_ERROR") + "）"
        : (d && d.note) || "—");
    }
  }

  function runProbe() {
    var input = $("probe-url"), btn = $("probe-btn");
    if (!input || !btn) return Promise.resolve();
    var target = input.value.trim();
    if (!target) { toast("请先输入要探测的 URL", "warn"); input.focus(); return Promise.resolve(); }
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    var seq = ++probeSeq;
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "探测中…";
    text($("probe-latency"), "…");
    return window.BlogApi.get("/api/toolbox/probe?url=" + encodeURIComponent(target), {
      timeout: C.PROBE_TIMEOUT_MS, retry: C.PROBE_RETRY,
    }).then(function (data) {
      if (seq !== probeSeq) return;
      renderProbe(data);
    }, function (e) {
      if (seq !== probeSeq) return;
      renderProbe({ status: "error", httpStatus: 0, error: (e && e.message) || "请求失败",
        code: "CLIENT_ERROR", elapsed: 0, headers: {}, url: target });
      toast((e && e.message) || "探测失败", "error");
    }).then(function () {
      if (seq === probeSeq) { btn.disabled = false; btn.textContent = old; }
    });
  }

  function initProbe(scope) {
    var input = $("probe-url");
    if (!input) return;
    scope.on($("probe-btn"), "click", guarded(scope, function () { runProbe(); }));
    scope.on(input, "keydown", guarded(scope, function (e) {
      if (e.key === "Enter") { e.preventDefault(); runProbe(); }
    }));
    document.querySelectorAll("[data-probe-preset]").forEach(function (b) {
      scope.on(b, "click", guarded(scope, function () {
        input.value = b.getAttribute("data-probe-preset");
        runProbe();
      }));
    });
    renderProbe({
      status: "idle", httpStatus: 0, statusText: "READY", elapsed: 0,
      headers: {}, note: "输入 URL 后点击「发起探测」，请求经 Cloudflare Worker 代理发出（HEAD 模式）。",
    });
  }

  function renderIpInfo(d, fallback) {
    if (!d) return;
    var unavailable = d.status === "unavailable";
    text($("ip-query"), d.query || "—");
    var loc = [d.country, d.region, d.city].filter(Boolean).join(" · ");
    text($("ip-location"), unavailable ? "—" : (loc || "—"));
    text($("ip-continent"), d.continent || "—");
    text($("ip-isp"), d.isp || "—");
    text($("ip-org"), d.org || "—");
    text($("ip-asn"), d.asn || "—");
    text($("ip-timezone"), d.timezone || "—");
    text($("ip-source"), (d.provider || "—") + " / " + (d.source || "—") + (d.cached ? " / 缓存" : ""));
    text($("ip-elapsed"), typeof d.elapsed === "number" ? d.elapsed + " ms" : "—");
    var note = $("ip-note");
    if (!note) return;
    var msg = unavailable
      ? "✕ " + (d.error || "上游暂不可用") + (d.attempts && d.attempts.length ? "：" + d.attempts.join("；") : "")
      : (fallback ? "⚠ 网络不稳定，展示的是本地缓存数据。" : "") + (d.message || "") +
        (d.scope === "visitor" ? "  · 数据来自访客真实公网 IP" : "  · 出口视角");
    note.className = "tb-note " + (unavailable ? "tb-note-bad" : "");
    text(note, msg || "查询完成");
  }

  function loadIpInfo() {
    var btn = $("ip-refresh"), seq = ++ipSeq;
    if (btn) { btn.disabled = true; btn.textContent = "查询中…"; }
    // 不设 cacheKey：访客 IP 属个人数据，绝不落 localStorage
    return window.BlogApi.get("/api/toolbox/ipinfo", {
      timeout: C.IPINFO_TIMEOUT_MS, retry: C.IPINFO_RETRY,
    }).then(function (data) {
      if (seq !== ipSeq) return;
      renderIpInfo(data, false);
    }, function (e) {
      if (seq !== ipSeq) return;
      renderIpInfo({ status: "unavailable", query: "—", error: (e && e.message) || "请求失败" }, false);
    }).then(function () {
      if (seq === ipSeq && btn) { btn.disabled = false; btn.textContent = "↻ 重新查询"; }
    });
  }

  function initIpInfo(scope) {
    if (!$("ip-query")) return;
    scope.on($("ip-refresh"), "click", guarded(scope, function () { loadIpInfo(); }));
    // v15 PWA：断网时不发起注定失败的实时查询，避免错误噪声与超时等待。
    // 前端 15 个计算工具全部离线可用，此处仅后端查询类工具给出明确提示。
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      renderIpInfo({ status: "unavailable", query: "—", error: "当前离线，联网后可查询" }, false);
      return;
    }
    scope.timeout(guarded(scope, function () { loadIpInfo(); }), C.IPINFO_AUTO_DELAY_MS);
  }

  /* ============================================================
   * 08 正则表达式测试器 —— Worker：ToolboxCompute("regex")
   * ============================================================ */
  var REGEX_FLAGS = ["g", "i", "m", "s", "u"];

  function readRegex() {
    var flags = REGEX_FLAGS.filter(function (f) {
      var el = $("regex-flag-" + f); return !!(el && el.checked);
    }).join("");
    return {
      pattern: ($("regex-pattern") || {}).value || "",
      flags: flags,
      text: ($("regex-input") || {}).value || "",
    };
  }

  function regexFallback(req) {
    var r = P.runRegex(req.pattern, req.flags, req.text);
    return {
      ok: r.ok, error: r.error || "", matches: r.matches, count: r.count,
      truncated: r.truncated, hasGroups: r.hasGroups,
      segments: r.ok ? P.regexSegments(req.text, r.matches) : [],
    };
  }

  function renderRegex(res) {
    var host = $("regex-output"), groups = $("regex-groups"), list = $("regex-match-list");
    if (!host) return;
    host.textContent = "";
    if (groups) groups.textContent = "";
    if (list) list.textContent = "";
    if (!res.ok) {
      var err = document.createElement("span");
      err.className = "tb-tok-err";
      err.textContent = "正则非法：" + (res.error || "未知错误");
      host.appendChild(err);
      setStatus("regex-status", false, "表达式无法解析（已局部隔离，未影响其他工具）");
      text($("regex-count"), "—");
      return;
    }
    var src = readRegex().text;
    (res.segments || []).forEach(function (seg) {
      var span = document.createElement("span");
      span.className = seg.kind === "group" ? "tb-rx-group tb-rx-group-" + (seg.groupIndex % 5 + 1)
        : seg.kind === "match" ? "tb-rx-match" : "";
      span.textContent = src.slice(seg.start, seg.end);
      host.appendChild(span);
    });
    text($("regex-count"), res.count + (res.truncated ? "（已截断）" : ""));
    setStatus("regex-status", true,
      (res.hasGroups ? "捕获组已高亮 · " : "") + res.count + " 处匹配 · " +
      (res.engine === "worker" ? "Web Worker 计算" : "主线程计算"));
    if (list) {
      var shown = (res.matches || []).slice(0, C.REGEX_LIST_LIMIT);
      shown.forEach(function (mt, i) {
        var li = document.createElement("div");
        li.className = "tb-rx-item";
        var no = document.createElement("span");
        no.className = "tb-rx-no"; no.textContent = "#" + (i + 1) + " @" + mt.index;
        var val = document.createElement("code");
        val.textContent = mt.text;
        li.appendChild(no); li.appendChild(val);
        list.appendChild(li);
      });
    }
    if (groups && res.hasGroups) {
      var first = (res.matches || [])[0];
      if (first) first.groups.forEach(function (g) {
        var row = document.createElement("div");
        row.className = "tb-rx-grow";
        var k = document.createElement("span"); k.className = "tb-rx-no"; k.textContent = "$" + g.index;
        var v = document.createElement("code"); v.textContent = g.text || "(未参与匹配)";
        row.appendChild(k); row.appendChild(v); groups.appendChild(row);
      });
    }
  }

  function runRegex(scope) {
    var req = readRegex();
    return Compute.exec("regex", req, function () { return regexFallback(req); })
      .then(function (res) { if (!scope.disposed() && !res.cancelled) renderRegex(res); }, noop);
  }

  function initRegex(scope) {
    if (!$("regex-pattern")) return;
    var auto = scopedDebounce(scope, function () { runRegex(scope); }, C.DEBOUNCE_MS);
    [ $("regex-pattern"), $("regex-input") ].forEach(function (el) {
      scope.on(el, "input", auto);
    });
    REGEX_FLAGS.forEach(function (f) {
      scope.on($("regex-flag-" + f), "change", guarded(scope, function () { runRegex(scope); }));
    });
    scope.on($("regex-btn-clear"), "click", guarded(scope, function () {
      var t = $("regex-input"); if (t) t.value = ""; runRegex(scope);
    }));
    runRegex(scope);
  }

  /* ============================================================
   * 09 二维码生成器 —— 纯函数层：ToolboxPure.qrMatrix + vendor/qrcode.js
   * ============================================================ */
  function drawQr(canvas, cells, size) {
    var px = C.QR_MODULE_PX, margin = C.QR_MARGIN_MODULES;
    var side = (size + margin * 2) * px;
    canvas.width = side; canvas.height = side;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = C.QR_BG;
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = C.QR_FG;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (cells[r][c]) ctx.fillRect((c + margin) * px, (r + margin) * px, px, px);
      }
    }
  }

  function runQr() {
    var input = $("qr-text"), ecc = $("qr-ecc"), canvas = $("qr-canvas");
    if (!input || !canvas) return;
    var res = P.qrMatrix(input.value, ecc ? ecc.value : C.QR_DEFAULT_ECC, window.qrcode);
    lastQr = res.ok ? res : null;
    if (!res.ok) {
      var ctx = canvas.getContext("2d");
      if (ctx) { canvas.width = 1; canvas.height = 1; ctx.clearRect(0, 0, 1, 1); }
      setStatus("qr-status", false, res.error);
      text($("qr-meta"), "—");
      return;
    }
    drawQr(canvas, res.cells, res.size);
    setStatus("qr-status", true, "生成成功 · " + res.size + " × " + res.size + " 模块");
    text($("qr-meta"), "版本自动选型 · " + res.size + "×" + res.size + " · 纠错 " + (ecc ? ecc.value : C.QR_DEFAULT_ECC));
  }

  function downloadQr() {
    var canvas = $("qr-canvas");
    if (!canvas || !lastQr) { toast("请先生成二维码", "warn"); return; }
    var a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "toolbox-qrcode.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast("二维码已开始下载", "success");
  }

  function initQr(scope) {
    if (!$("qr-text")) return;
    var auto = scopedDebounce(scope, runQr, C.DEBOUNCE_MS);
    scope.on($("qr-text"), "input", auto);
    scope.on($("qr-ecc"), "change", guarded(scope, runQr));
    scope.on($("qr-download"), "click", guarded(scope, downloadQr));
    runQr();
  }

  /* ============================================================
   * 10 图片转 Base64 —— Worker：ToolboxCompute("image") + 主线程降级
   * ============================================================ */
  function imageFallback() {
    // 主线程降级：FileReader（异步、不阻塞）+ <canvas> 等比压缩。
    // 不用 createObjectURL，避免 blob: URL 外泄与生命周期悬挂。
    return new Promise(function (resolve, reject) {
      if (!imgState.buffer) { reject(new Error("尚未选择图片")); return; }
      var blob = new Blob([imgState.buffer], { type: imgState.type || "image/png" });
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("文件读取失败")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("图片解码失败")); };
        img.onload = function () {
          var maxEdge = parseInt(($("img-max-edge") || {}).value, 10) || C.IMG_DEFAULT_MAX_EDGE;
          var quality = parseInt(($("img-quality") || {}).value, 10) / 100 || C.IMG_DEFAULT_QUALITY;
          var dim = P.fitDimensions(img.naturalWidth, img.naturalHeight, maxEdge);
          var canvas = document.createElement("canvas");
          canvas.width = dim.w; canvas.height = dim.h;
          var ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("无法创建 2D 上下文")); return; }
          ctx.drawImage(img, 0, 0, dim.w, dim.h);
          var mime = imgState.type === "image/png" ? "image/png"
            : imgState.type === "image/webp" ? "image/webp" : "image/jpeg";
          var dataUrl = canvas.toDataURL(mime, quality);
          resolve({
            dataUrl: dataUrl, base64: dataUrl.split(",")[1], mime: mime,
            width: dim.w, height: dim.h, bytes: Math.round(dataUrl.split(",")[1].length * 3 / 4),
            sourceWidth: img.naturalWidth, sourceHeight: img.naturalHeight,
          });
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(blob);
    });
  }

  function renderImage(res) {
    var out = $("img-output"), preview = $("img-preview");
    if (!out) return;
    out.value = res.dataUrl;
    if (preview) { preview.src = res.dataUrl; preview.hidden = false; }
    setStatus("img-status", true,
      "原图 " + res.sourceWidth + "×" + res.sourceHeight + " → 压缩 " + res.width + "×" + res.height +
      " · " + P.formatBytes(res.bytes) + " · " + (res.engine === "worker" ? "Web Worker" : "主线程"));
    text($("img-dims"), res.width + " × " + res.height);
  }

  function processImage(scope) {
    if (!imgState.buffer) return Promise.resolve();
    var payload = {
      buffer: imgState.buffer,
      type: imgState.type,
      maxEdge: parseInt(($("img-max-edge") || {}).value, 10) || C.IMG_DEFAULT_MAX_EDGE,
      quality: parseInt(($("img-quality") || {}).value, 10) / 100 || C.IMG_DEFAULT_QUALITY,
    };
    setStatus("img-status", true, "处理中…");
    return Compute.exec("image", payload, imageFallback)
      .then(function (res) {
        if (!scope.disposed() && !res.cancelled && res.ok !== false) renderImage(res);
      }, function (e) {
        if (!scope.disposed()) setStatus("img-status", false, (e && e.message) || "图片处理失败");
      });
  }

  function acceptFile(scope, file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast("请选择图片文件", "warn"); return; }
    if (file.size > C.IMG_MAX_FILE_BYTES) {
      toast("图片超过 " + P.formatBytes(C.IMG_MAX_FILE_BYTES) + " 上限", "warn");
      return;
    }
    file.arrayBuffer().then(function (buf) {
      if (scope.disposed()) return;
      imgState.buffer = buf; imgState.type = file.type; imgState.name = file.name;
      text($("img-name"), file.name + " · " + P.formatBytes(file.size));
      processImage(scope);
    }, function () { if (!scope.disposed()) setStatus("img-status", false, "文件读取失败"); });
  }

  function initImage(scope) {
    var drop = $("img-drop"), file = $("img-file");
    if (!drop || !file) return;
    scope.on(drop, "click", guarded(scope, function () { file.click(); }));
    scope.on(drop, "dragover", guarded(scope, function (e) { e.preventDefault(); drop.classList.add("is-drag"); }));
    scope.on(drop, "dragleave", guarded(scope, function () { drop.classList.remove("is-drag"); }));
    scope.on(drop, "drop", guarded(scope, function (e) {
      e.preventDefault(); drop.classList.remove("is-drag");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      acceptFile(scope, f);
    }));
    scope.on(file, "change", guarded(scope, function () { acceptFile(scope, file.files && file.files[0]); }));
    scope.on($("img-max-edge"), "input", scopedDebounce(scope, function () {
      var n = $("img-max-edge-num"); if (n) n.value = $("img-max-edge").value;
      processImage(scope);
    }, C.DEBOUNCE_MS));
    scope.on($("img-quality"), "input", scopedDebounce(scope, function () {
      var n = $("img-quality-num"); if (n) n.value = $("img-quality").value;
      processImage(scope);
    }, C.DEBOUNCE_MS));
    scope.on($("img-btn-clear"), "click", guarded(scope, function () {
      imgState.buffer = null; imgState.type = ""; imgState.name = "";
      file.value = "";
      var out = $("img-output"); if (out) out.value = "";
      var preview = $("img-preview"); if (preview) { preview.removeAttribute("src"); preview.hidden = true; }
      text($("img-name"), "未选择文件"); text($("img-dims"), "—");
      setStatus("img-status", true, "等待上传图片");
    }));
    setStatus("img-status", true, "等待上传图片");
  }

  /* ============================================================
   * 11 文本差异对比 —— Worker：ToolboxCompute("diff")
   * ============================================================ */
  function diffFallback(req) {
    var d = P.diffLines(req.a, req.b);
    return { ops: d.ops, stats: d.stats, truncated: d.truncated };
  }

  function renderDiff(res) {
    var host = $("diff-output");
    if (!host) return;
    host.textContent = "";
    var prefix = { add: "+", del: "-", eq: " " };
    (res.ops || []).forEach(function (op) {
      var line = document.createElement("div");
      line.className = "tb-diff-line tb-diff-" + op.type;
      var gutter = document.createElement("span");
      gutter.className = "tb-diff-gutter";
      gutter.textContent = (op.aLine || "") + (op.bLine ? "/" + op.bLine : "");
      var body = document.createElement("span");
      body.className = "tb-diff-text";
      body.textContent = prefix[op.type] + " " + op.text;
      line.appendChild(gutter); line.appendChild(body);
      host.appendChild(line);
    });
    var s = res.stats || { added: 0, removed: 0, equal: 0 };
    text($("diff-stats"), "+" + s.added + " 新增 / -" + s.removed + " 删除 / " + s.equal + " 未变" +
      (res.truncated ? " · 超大文本已降级为整块对比" : ""));
    setStatus("diff-status", true, "对比完成 · " + (res.engine === "worker" ? "Web Worker" : "主线程") + " LCS");
  }

  function runDiff(scope) {
    var req = {
      a: ($("diff-a") || {}).value || "",
      b: ($("diff-b") || {}).value || "",
    };
    return Compute.exec("diff", req, function () { return diffFallback(req); })
      .then(function (res) { if (!scope.disposed() && !res.cancelled) renderDiff(res); }, noop);
  }

  function initDiff(scope) {
    if (!$("diff-a")) return;
    var auto = scopedDebounce(scope, function () { runDiff(scope); }, C.DEBOUNCE_MS);
    [ $("diff-a"), $("diff-b") ].forEach(function (el) { scope.on(el, "input", auto); });
    scope.on($("diff-btn-swap"), "click", guarded(scope, function () {
      var a = $("diff-a"), b = $("diff-b");
      var t = a.value; a.value = b.value; b.value = t; runDiff(scope);
    }));
    scope.on($("diff-btn-clear"), "click", guarded(scope, function () {
      $("diff-a").value = ""; $("diff-b").value = ""; runDiff(scope);
    }));
    runDiff(scope);
  }

  /* ============================================================
   * 12 颜色与渐变生成器 —— 纯函数层：buildGradientCss / palette / contrast
   * ============================================================ */
  function runGradient() {
    var c1 = ($("grad-c1") || {}).value || "#39FF14";
    var c2 = ($("grad-c2") || {}).value || "#0EA5E9";
    var angle = parseInt(($("grad-angle") || {}).value, 10);
    var type = ($("grad-type") || {}).value || "linear";
    var css = P.buildGradientCss({
      type: type, angle: angle,
      stops: [{ color: c1, pos: 0 }, { color: c2, pos: 100 }],
    });
    var preview = $("grad-preview");
    if (preview) preview.style.background = css;
    var out = $("grad-css");
    if (out) out.value = "background: " + css + ";";
    var ratio = P.contrastRatio(c1, c2);
    var judge = ratio >= C.WCAG_AAA ? "AAA 级" : ratio >= C.WCAG_AA ? "AA 级" : "偏低";
    text($("grad-contrast"), ratio.toFixed(2) + ":1 · " + judge);
    text($("grad-hex"), c1.toUpperCase() + " → " + c2.toUpperCase());
    var rgb1 = P.hexToRgb(c1), rgb2 = P.hexToRgb(c2);
    text($("grad-rgb"), (rgb1 ? "rgb(" + rgb1.r + "," + rgb1.g + "," + rgb1.b + ")" : "—") +
      " → " + (rgb2 ? "rgb(" + rgb2.r + "," + rgb2.g + "," + rgb2.b + ")" : "—"));
    var hsl = rgb1 ? P.rgbToHsl(rgb1.r, rgb1.g, rgb1.b) : null;
    text($("grad-hsl"), hsl ? "hsl(" + hsl.h + ", " + hsl.s + "%, " + hsl.l + "%)" : "—");
    var host = $("grad-palette");
    if (host) {
      host.textContent = "";
      P.gradientPalette(c1, c2, C.GRADIENT_PALETTE_SIZE).forEach(function (hex) {
        var sw = document.createElement("span");
        sw.className = "tb-swatch";
        sw.style.background = hex;
        sw.title = hex;
        var code = document.createElement("code");
        code.textContent = hex;
        sw.appendChild(code);
        host.appendChild(sw);
      });
    }
    setStatus("grad-status", true, "CSS 已生成 · 可直接复制");
  }

  function initGradient(scope) {
    if (!$("grad-c1")) return;
    ["grad-c1", "grad-c2", "grad-angle", "grad-type"].forEach(function (id) {
      var el = $(id);
      scope.on(el, "input", guarded(scope, function () {
        if (id === "grad-angle") { var n = $("grad-angle-num"); if (n) n.value = el.value; }
        runGradient();
      }));
      scope.on(el, "change", guarded(scope, runGradient));
    });
    scope.on($("grad-random"), "click", guarded(scope, function () {
      $("grad-c1").value = P.randomHex();
      $("grad-c2").value = P.randomHex();
      runGradient();
    }));
    scope.on($("grad-swap"), "click", guarded(scope, function () {
      var a = $("grad-c1"), b = $("grad-c2");
      var t = a.value; a.value = b.value; b.value = t; runGradient();
    }));
    runGradient();
  }

  /* ============================================================
   * 13 Cron 表达式生成器 —— 纯函数层：buildCron / cronNext / cronDescribe
   * ============================================================ */
  var CASE_LABELS = {
    upper: "全大写 UPPER", lower: "全小写 lower", title: "首字母大写 Title Case",
    camel: "驼峰 camelCase", pascal: "帕斯卡 PascalCase",
    snake: "下划线 snake_case", kebab: "短横线 kebab-case",
  };

  /**
   * 读取五个 Cron 可视化控件的当前取值。
   * @returns {{minute: string, hour: string, dom: string, month: string, dow: string}} 字段对象
   */
  function readCronParts() {
    var parts = {};
    C.CRON_FIELDS.forEach(function (name) {
      parts[name] = ($("cron-" + name) || {}).value || "*";
    });
    return parts;
  }

  /**
   * 设置 select 的值；不存在对应 option 时动态补齐，避免「使用当前时间」出现空白。
   * @param {string} id select 元素 id
   * @param {string|number} value 目标值
   * @returns {void}
   */
  function setCronSelect(id, value) {
    var el = $(id);
    if (!el) return;
    var v = String(value);
    var exists = false;
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].value === v) { exists = true; break; }
    }
    if (!exists) {
      var opt = document.createElement("option");
      opt.value = v; opt.textContent = v;
      el.appendChild(opt);
    }
    el.value = v;
  }

  /**
   * 渲染 Cron 表达式、中文描述与接下来 N 次执行时间。
   * @returns {void}
   */
  function runCron() {
    var built = P.buildCron(readCronParts());
    var expr = $("cron-expression"), out = $("cron-next"), desc = $("cron-describe");
    if (!built.ok) {
      if (expr) expr.value = "";
      if (desc) text(desc, "表达式非法：" + built.error);
      if (out) out.textContent = "";
      text($("cron-count"), "—");
      setStatus("cron-status", false, built.error);
      return;
    }
    if (expr) expr.value = built.expression;
    var d = P.cronDescribe(built.expression);
    if (desc) text(desc, d.ok ? d.text : "—");
    var next = P.cronNext(built.expression, C.CRON_NEXT_COUNT, Date.now());
    if (out) {
      out.textContent = "";
      if (!next.ok) {
        var empty = document.createElement("span");
        empty.className = "tb-dim";
        empty.textContent = "扫描窗口内未找到下次执行时间";
        out.appendChild(empty);
      } else {
        var now = Date.now();
        next.times.forEach(function (ts, i) {
          var row = document.createElement("div");
          row.className = "tb-cron-slot";
          var no = document.createElement("span");
          no.className = "tb-cron-no"; no.textContent = "#" + (i + 1);
          var code = document.createElement("code");
          code.textContent = P.formatLocal(new Date(ts)) + " · " +
            ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(ts).getDay()];
          var rel = document.createElement("span");
          rel.className = "tb-cron-rel";
          rel.textContent = P.relativeTime(new Date(ts), now);
          row.appendChild(no); row.appendChild(code); row.appendChild(rel);
          out.appendChild(row);
        });
      }
    }
    text($("cron-count"), next.count + " 次预测");
    setStatus("cron-status", true, "表达式合法 · " + next.count + " 次预测" +
      (next.truncated ? "（扫描窗口内未凑满）" : ""), "VALID");
  }

  /**
   * 初始化 Cron 工具：五段 select 变更即时重算 + 两个快捷按钮。
   * @param {Object} scope 生命周期作用域
   * @returns {void}
   */
  function initCron(scope) {
    if (!$("cron-minute")) return;
    C.CRON_FIELDS.forEach(function (name) {
      scope.on($("cron-" + name), "change", guarded(scope, runCron));
    });
    scope.on($("cron-btn-reset"), "click", guarded(scope, function () {
      C.CRON_FIELDS.forEach(function (name) {
        var el = $("cron-" + name);
        if (el) el.value = "*";
      });
      runCron();
    }));
    scope.on($("cron-btn-now"), "click", guarded(scope, function () {
      var d = new Date();
      setCronSelect("cron-minute", d.getMinutes());
      setCronSelect("cron-hour", d.getHours());
      setCronSelect("cron-dom", "*");
      setCronSelect("cron-month", "*");
      setCronSelect("cron-dow", "*");
      runCron();
    }));
    runCron();
  }

  /* ============================================================
   * 14 URL 编解码器 —— 纯函数层：urlConvert / parseQuery
   * ============================================================ */

  /**
   * 渲染 Query 参数表（展示解码后的键与值，非法编码标红）。
   * @param {string} src 原始输入串
   * @returns {void}
   */
  function renderQuery(src) {
    var tbody = $("url-params");
    if (!tbody) return;
    tbody.textContent = "";
    var q = P.parseQuery(src);
    text($("url-param-count"), q.ok ? q.count + " 个参数" : "—");
    if (!q.ok || !q.params.length) {
      var tr0 = document.createElement("tr"), td0 = document.createElement("td");
      td0.colSpan = 2; td0.className = "tb-url-empty";
      td0.textContent = "（无 Query 参数，或输入为纯组件串）";
      tr0.appendChild(td0); tbody.appendChild(tr0);
      return;
    }
    q.params.forEach(function (p) {
      var tr = document.createElement("tr");
      var a = document.createElement("td"), b = document.createElement("td");
      a.textContent = p.key;
      b.textContent = p.value === "" ? "(空)" : p.value;
      if (p.invalid) b.className = "tb-tok-err";
      tr.appendChild(a); tr.appendChild(b); tbody.appendChild(tr);
    });
  }

  /**
   * 按当前方向 / 作用域执行 URL 转换并刷新参数表。
   * @returns {void}
   */
  function runUrl() {
    var input = $("url-input"), out = $("url-output");
    if (!input || !out) return;
    var mode = ($("url-mode") || {}).value || "encode";
    var scopeName = ($("url-scope") || {}).value || "query";
    var src = input.value;
    if (!src) {
      out.value = "";
      renderQuery("");
      setStatus("url-status", true, "等待输入");
      return;
    }
    var r = P.urlConvert(src, mode, scopeName);
    if (!r.ok) {
      out.value = "";
      setStatus("url-status", false, r.error);
      return;
    }
    out.value = r.value;
    var q = P.parseQuery(src);
    renderQuery(src);
    setStatus("url-status", true,
      (mode === "decode" ? "已解码 · " : "已编码 · ") + q.count + " 个参数 · " +
      (r.invalid || 0) + " 处非法编码已隔离", "VALID");
  }

  /**
   * 初始化 URL 工具：输入防抖转换 + 方向/作用域切换 + 两个快捷按钮。
   * @param {Object} scope 生命周期作用域
   * @returns {void}
   */
  function initUrl(scope) {
    var input = $("url-input"), mode = $("url-mode"), scopeSel = $("url-scope");
    if (!input) return;
    var auto = scopedDebounce(scope, runUrl, C.DEBOUNCE_MS);
    scope.on(input, "input", auto);
    scope.on(mode, "change", guarded(scope, runUrl));
    scope.on(scopeSel, "change", guarded(scope, runUrl));
    scope.on($("url-btn-encode"), "click", guarded(scope, function () {
      mode.value = "encode"; runUrl();
    }));
    scope.on($("url-btn-decode"), "click", guarded(scope, function () {
      mode.value = "decode"; runUrl();
    }));
    scope.on($("url-btn-clear"), "click", guarded(scope, function () {
      input.value = ""; runUrl(); input.focus();
    }));
    runUrl();
  }

  /* ============================================================
   * 15 文本大小写转换器 —— 纯函数层：convertCase / splitWords
   * ============================================================ */

  /**
   * 渲染词元切分结果。
   * @param {string[]} words 词元数组
   * @returns {void}
   */
  function renderTokens(words) {
    var host = $("case-tokens");
    if (!host) return;
    host.textContent = "";
    text($("case-words"), words.length + " 个");
    words.forEach(function (w) {
      var s = document.createElement("span");
      s.className = "tb-token"; s.textContent = w;
      host.appendChild(s);
    });
    if (!words.length) {
      var e = document.createElement("span");
      e.className = "tb-dim"; e.textContent = "—";
      host.appendChild(e);
    }
  }

  /**
   * 按指定模式转换文本并刷新输出 / 词元 / 激活态按钮。
   * @param {string} mode 目标形态
   * @returns {void}
   */
  function runCase(mode) {
    var input = $("case-input"), out = $("case-output");
    if (!input || !out) return;
    var r = P.convertCase(input.value, mode);
    if (!r.ok) {
      out.value = "";
      setStatus("case-status", false, r.error);
      return;
    }
    out.value = r.value;
    text($("case-mode-label"), CASE_LABELS[mode] || mode);
    document.querySelectorAll("#case-modes [data-case]").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-case") === mode);
    });
    renderTokens(r.words);
    setStatus("case-status", true, "已转换 · " + r.words.length + " 个词元 · " + r.value.length + " 字符", "VALID");
  }

  /**
   * 初始化大小写工具：模式按钮委托 + 输入防抖重算 + 清空。
   * @param {Object} scope 生命周期作用域
   * @returns {void}
   */
  function initCase(scope) {
    var input = $("case-input");
    if (!input) return;
    var currentMode = "camel";
    var rerun = function () { runCase(currentMode); };
    scope.on(input, "input", scopedDebounce(scope, rerun, C.DEBOUNCE_MS));
    scope.on($("case-modes"), "click", guarded(scope, function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-case]") : null;
      if (!b) return;
      currentMode = b.getAttribute("data-case");
      rerun();
    }));
    scope.on($("case-btn-clear"), "click", guarded(scope, function () {
      input.value = ""; rerun();
    }));
    rerun();
  }

  /* ============================================================
   * 移动端软键盘守卫（v15 模块三）
   * 只在 visualViewport 被明显压缩（键盘弹起）时介入，桌面零干预。
   * ============================================================ */

  /**
   * 键盘是否处于弹起状态（布局视口高度显著收缩）。
   * @returns {boolean} 是否弹起
   */
  function keyboardVisible() {
    var vv = window.visualViewport;
    return !!(vv && window.innerHeight > 0 && vv.height < window.innerHeight * 0.75);
  }

  /**
   * 把当前聚焦的输入控件滚入可视区中部，避免被软键盘遮挡。
   * 所有 timeout 与监听都登记进 rootScope，pagehide 一并销毁。
   * @param {Object} scope 生命周期作用域
   * @returns {void}
   */
  function initKeyboardGuard(scope) {
    function refocus() {
      if (!keyboardVisible()) return;
      var el = document.activeElement;
      if (!el || !el.tagName) return;
      var tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
      if (el.type === "range" || el.type === "checkbox" || el.type === "color" || el.readOnly) return;
      scope.timeout(guarded(scope, function () {
        try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
      }), C.KEYBOARD_GUARD_DELAY_MS);
    }
    var vv = window.visualViewport;
    if (vv && typeof vv.addEventListener === "function") scope.on(vv, "resize", refocus);
    scope.on(document, "focusin", refocus);
  }

  /* ============================================================
   * Tab 编排
   * ============================================================ */
  function initBasicTools(scope) {
    initJson(scope); initB64(scope); initTs(scope); initPw(scope);
    initHash(scope); initProbe(scope); initIpInfo(scope);
  }

  function initAdvancedTools(scope) {
    initRegex(scope); initQr(scope); initImage(scope);
    initDiff(scope); initGradient(scope);
    initCron(scope); initUrl(scope); initCase(scope);
  }

  function mountAdvanced() {
    var tpl = $("tb-advanced-tpl"), host = $("tb-panel-advanced");
    if (!tpl || !host) return;
    host.appendChild(tpl.content.cloneNode(true));
  }

  /**
   * 切换 Tab：销毁旧作用域 → 取消在途计算 → 挂载 / 显隐 → 初始化新作用域。
   * @param {"basic"|"advanced"} name 目标 Tab
   * @returns {void}
   */
  function activateTab(name) {
    if (name !== "basic" && name !== "advanced") return;
    if (tabScope) { lastDisposedScope = tabScope; tabScope.dispose(); tabScope = null; }
    Compute.cancelAll();
    var isAdv = name === "advanced";
    if (isAdv && !advancedMounted) { mountAdvanced(); advancedMounted = true; }
    var basicPanel = $("tb-panel-basic"), advPanel = $("tb-panel-advanced");
    if (basicPanel) basicPanel.hidden = isAdv;
    if (advPanel) advPanel.hidden = !isAdv;
    [["basic", !isAdv], ["advanced", isAdv]].forEach(function (pair) {
      var btn = $("tb-tab-" + pair[0]);
      if (!btn) return;
      btn.setAttribute("aria-selected", String(pair[1]));
      btn.classList.toggle("is-active", pair[1]);
      btn.tabIndex = pair[1] ? 0 : -1;
    });
    tabScope = S.create(isAdv ? "tab-advanced" : "tab-basic");
    if (isAdv) initAdvancedTools(tabScope); else initBasicTools(tabScope);
    activeTab = name;
  }

  /* ---------- 启动 / 卸载 ---------- */
  function boot() {
    initGlobalDelegates(rootScope);
    initKeyboardGuard(rootScope);
    seedDefaults();
    activateTab("basic");
    rootScope.on(window, "pagehide", function () {
      if (tabScope) { tabScope.dispose(); tabScope = null; }
      Compute.dispose();
      rootScope.dispose();
    });
  }

  /** 调试 / 测试只读接口（不参与业务逻辑） */
  window.ToolboxDebug = Object.freeze({
    version: C.VERSION,
    activeTab: function () { return activeTab; },
    advancedMounted: function () { return advancedMounted; },
    tabScopeSize: function () { return tabScope ? tabScope.size() : 0; },
    tabScopeDisposed: function () { return !tabScope || tabScope.disposed(); },
    lastDisposedScopeDisposed: function () { return !lastDisposedScope || lastDisposedScope.disposed(); },
    lastDisposedScopeSize: function () { return lastDisposedScope ? lastDisposedScope.size() : -1; },
    rootScopeSize: function () { return rootScope.size(); },
    compute: function () { return Compute.state(); },
    pure: function () { return P; },
    constants: function () { return C; },
    activate: activateTab,
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
