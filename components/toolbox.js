/* ============================================================
 * toolbox.js —— 极客工具箱 v17.0 · Tab 编排 + 按需加载器
 * ------------------------------------------------------------
 * 架构纪律（v14 建立 / v16 强化 / v17 完整继承）：
 *   1) 纯函数彻底抽离：算法全在 utils/toolbox-pure.js（core 层，51 函数），
 *      被主线程 / classic Worker / Node VM 三端共享，故保持单一文件——
 *      拆成 15 份反而会多 15 个请求并破坏 importScripts 与三端断言。
 *   2) 重计算异步化：正则 / Diff / 图片压缩经 ToolboxCompute 派发 Worker。
 *   3) 请求层净化：后端工具一律 window.BlogApi.get()，绝不裸 fetch。
 *   4) 魔法数字清零：阈值全部读 ToolboxConstants。
 *   5) 内存泄漏治理：监听器 / 定时器 / Worker 全经 ToolboxScope 登记。
 *
 * v17.0 模块一「极致的按需加载」：
 *   · Tab A【常规工具】7 张卡保持完全同步、首屏秒开（step26 零改动）；
 *   · Tab B【进阶工具】8 张卡仍在 inert <template> 内，首次点击才克隆；
 *   · 8 个工具控制器已拆成原生 ESM 分片 modules/toolbox/*.js，只有用户
 *     点击 Tab B 时才经 import() 动态加载（与全站既有的 global-search.js
 *     动态导入同一模式），manifest.js 是 URL 清单的单一事实来源；
 *   · 加载间隙显示局部骨架屏，bootstrapAdvancedDefaults() 用纯函数内核
 *     即时填充三个 v15 工具的默认输出，绝不白屏；
 *   · 分片经 kit 注入依赖、共享同一个 tabScope，Tab 往返 / pagehide 销毁
 *     语义与 v15 逐字一致；加载失败有错误边界且可点击重试。
 *
 * v17.0 模块二「数据流解耦」：
 *   · toast 不再直接持有 window.UI.toast，改为向全局 EventBus 发布
 *     ui:toast，由通知中心（components/ui.js）订阅；
 *   · 骨架屏只订阅 toolbox:modules:loading / error 事件，不反向引用加载器。
 *
 * 严格 CSP：无内联脚本、无 eval、无第三方运行时；script-src-elem 'self'
 * 放行同源 ESM 分片。用户输入一律 textContent 或 escapeHtml 后拼 HTML。
 * ============================================================ */
(function () {
  "use strict";

  var C = window.ToolboxConstants;
  var P = window.ToolboxPure;
  var S = window.ToolboxScope;
  var Compute = window.ToolboxCompute;
  var copyText = window.UI.copyText;

  /**
   * 统一通知出口（v17.0 模块二）：业务模块不再直接持有 window.UI.toast，
   * 改为向全局事件总线发布 ui:toast，由通知中心 components/ui.js 订阅。
   * 未加载 EventBus 的环境静默降级到原调用，行为零变化。
   * @param {string} msg 提示文本
   * @param {string} [type] 提示类型（success / error / warn / info）
   * @returns {void}
   */
  function toast(msg, type) {
    var bus = window.EventBus;
    if (bus && typeof bus.emit === "function") {
      bus.emit("ui:toast", { message: msg, type: type || "info" });
      return;
    }
    if (window.UI && typeof window.UI.toast === "function") window.UI.toast(msg, type);
  }

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
  /**
   * 把探测视图模型写入 DOM。
   * v16.0：状态码分档 / 文案与空值规则已全部下沉至
   * ToolboxPure.probeViewModel，本函数只负责一次性 DOM 写入。
   * @param {Object} d Worker 代理返回的原始数据
   * @returns {void}
   */
  function renderProbe(d) {
    var badge = $("probe-status"), label = $("probe-status-text");
    if (!badge || !label) return;
    var vm = P.probeViewModel(d);
    badge.className = "tb-code-badge " + vm.badgeClass;
    text(label, vm.codeText);
    text($("probe-status-desc"), vm.desc);
    text($("probe-latency"), vm.latency);
    text($("probe-method"), vm.method);
    text($("probe-target"), vm.target);
    var tbody = $("probe-headers");
    if (tbody) {
      tbody.textContent = "";
      if (!vm.headers.length) {
        var tr0 = document.createElement("tr"), td0 = document.createElement("td");
        td0.colSpan = 2; td0.className = "tb-dim"; td0.textContent = "（无响应头）";
        tr0.appendChild(td0); tbody.appendChild(tr0);
      } else {
        vm.headers.forEach(function (h) {
          var tr = document.createElement("tr");
          var a = document.createElement("td"), b = document.createElement("td");
          a.textContent = h.key; b.textContent = h.value;
          tr.appendChild(a); tr.appendChild(b); tbody.appendChild(tr);
        });
      }
    }
    var note = $("probe-note");
    if (note) {
      note.className = "tb-note " + vm.noteClass;
      text(note, vm.note);
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

  /**
   * 把 IP 归属视图模型写入 DOM。
   * v16.0：字段映射、地区拼接、降级/错误提示规则已下沉至
   * ToolboxPure.ipViewModel，本函数只负责 DOM 写入。
   * @param {Object} d ipinfo 返回数据
   * @param {boolean} fallback 是否本地缓存降级
   * @returns {void}
   */
  function renderIpInfo(d, fallback) {
    if (!d) return;
    var vm = P.ipViewModel(d, fallback);
    text($("ip-query"), vm.query);
    text($("ip-location"), vm.location);
    text($("ip-continent"), vm.continent);
    text($("ip-isp"), vm.isp);
    text($("ip-org"), vm.org);
    text($("ip-asn"), vm.asn);
    text($("ip-timezone"), vm.timezone);
    text($("ip-source"), vm.source);
    text($("ip-elapsed"), vm.elapsed);
    var note = $("ip-note");
    if (!note) return;
    note.className = "tb-note " + vm.noteClass;
    text(note, vm.note);
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
   * v17.0 动态加载编排（模块一）
   * ============================================================ */
  /** 加载生命周期事件名：发布方与订阅方共享，消除魔法字符串 */
  var ADV_EVENTS = Object.freeze({
    loading: "toolbox:modules:loading",
    ready: "toolbox:modules:ready",
    error: "toolbox:modules:error",
  });
  var MANIFEST_URL = "/modules/toolbox/manifest.js";
  var advModules = null;      // 已加载的 ESM 分片 namespace 数组
  var advLoadPromise = null;  // 在途加载 Promise（并发去重）
  var tabGeneration = 0;      // 切换代号：异步结果只对最新一次负责
  var moduleError = "";       // 最近一次加载失败原因（诊断用）

  /**
   * v17.0 分片配置契约：高频阈值只在编排层读取常量层，分片通过 kit.cfg
   * 消费数值，不再直接认识 ToolboxConstants（依赖注入更彻底，未来可按
   * 工具独立调参而无需改动纯函数内核）。每项与一个 ESM 分片一一对应。
   */
  var ADV_MODULE_CFG = Object.freeze({
    regexDebounceMs: C.DEBOUNCE_MS,
    qrcodeDebounceMs: C.DEBOUNCE_MS,
    imageDebounceMs: C.DEBOUNCE_MS,
    diffDebounceMs: C.DEBOUNCE_MS,
    urlDebounceMs: C.DEBOUNCE_MS,
    caseDebounceMs: C.DEBOUNCE_MS,
    imgMaxFileBytes: C.IMG_MAX_FILE_BYTES,
    cronNextCount: C.CRON_NEXT_COUNT,
  });

  /** 依赖注入容器：分片的全部共享依赖经它注入，零全局耦合 */
  var kit = Object.freeze({
    $: $, text: text, setStatus: setStatus,
    scopedDebounce: scopedDebounce, guarded: guarded, noop: noop,
    P: P, C: C, Compute: Compute,
    toast: toast, copyText: copyText,
    cfg: ADV_MODULE_CFG,
  });

  /** @param {string} type @param {Object} [payload] @returns {void} */
  function emitBus(type, payload) {
    var bus = window.EventBus;
    if (bus && typeof bus.emit === "function") bus.emit(type, payload || {});
  }

  /** @param {boolean} show @returns {void} */
  function showSkeleton(show) {
    var el = $("tb-advanced-skeleton");
    if (el) el.hidden = !show;
    var host = $("tb-panel-advanced");
    if (host) host.classList.toggle("is-loading", !!show);
  }

  /**
   * 骨架屏期间的默认输出自举：用纯函数内核即时算出 13/14/15 三个工具的
   * 可见结果，避免动态分片加载的几十毫秒里输出区空白；分片就绪后会再
   * 绑定交互并完整重算。这也是 UI 薄层与纯函数内核的契约锚点。
   * @returns {void}
   */
  function bootstrapAdvancedDefaults() {
    var parts = {};
    C.CRON_FIELDS.forEach(function (n) { parts[n] = ($("cron-" + n) || {}).value || "*"; });
    var expr = P.buildCron(parts);
    if (expr.ok) { var e = $("cron-expression"); if (e) e.value = expr.expression; }
    var u = P.urlConvert(($("url-input") || {}).value || "", "encode", "query");
    if (u.ok) { var o = $("url-output"); if (o) o.value = u.value; }
    var c = P.convertCase(($("case-input") || {}).value || "", "camel");
    if (c.ok) { var co = $("case-output"); if (co) co.value = c.value; }
  }

  /**
   * 首次激活 Tab B 时动态加载 8 个 ESM 分片。
   * manifest.js 是 URL 清单的单一事实来源；Promise.all 并发加载，
   * advLoadPromise 去重；浏览器 module map 保证同一 URL 只 fetch 一次。
   * @returns {Promise<Array<Object>>} 分片 namespace 数组
   */
  function loadAdvancedModules() {
    if (advModules) return Promise.resolve(advModules);
    if (advLoadPromise) return advLoadPromise;
    emitBus(ADV_EVENTS.loading, { count: C.ADV_MODULE_COUNT });
    advLoadPromise = import(MANIFEST_URL).then(function (manifest) {
      return Promise.all(manifest.MODULES.map(function (url) { return import(url); }));
    }).then(function (mods) {
      mods.forEach(function (m, i) {
        if (!m || typeof m.init !== "function") {
          throw new Error("分片缺少 init 导出：#" + (i + 1));
        }
      });
      advModules = mods;
      return mods;
    });
    return advLoadPromise;
  }

  /** @param {*} err @returns {void} 加载失败的错误边界：不白屏、可重试 */
  function reportModuleError(err) {
    moduleError = (err && err.message) || String(err);
    var box = $("tb-advanced-load-error");
    if (box) { box.hidden = false; text(box, "进阶工具模块加载失败：" + moduleError + "（点击 Tab 可重试）"); }
    emitBus(ADV_EVENTS.error, { message: moduleError });
  }

  /* ============================================================
   * Tab 编排（v17.0：Tab A 完全同步，Tab B 异步按需加载）
   * ============================================================ */
  function initBasicTools(scope) {
    initJson(scope); initB64(scope); initTs(scope); initPw(scope);
    initHash(scope); initProbe(scope); initIpInfo(scope);
  }

  function mountAdvanced() {
    var tpl = $("tb-advanced-tpl"), host = $("tb-panel-advanced");
    if (!tpl || !host) return;
    host.appendChild(tpl.content.cloneNode(true));
  }

  /**
   * 切换 Tab：销毁旧作用域 → 取消在途计算 → 挂载 / 显隐 → 初始化。
   * Tab B 首次激活会显示骨架屏并 import() 8 个分片；异步回调用
   * tabGeneration 校验，切走则丢弃结果，绝不写入已销毁的 DOM。
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
    activeTab = name;
    var gen = ++tabGeneration;
    if (!isAdv) {
      showSkeleton(false);
      initBasicTools(tabScope);
      return;
    }
    var errBox = $("tb-advanced-load-error");
    if (errBox) errBox.hidden = true;
    showSkeleton(true);
    bootstrapAdvancedDefaults();
    if (advModules) {
      showSkeleton(false);
      advModules.forEach(function (m) { m.init(tabScope, kit); });
      return;
    }
    loadAdvancedModules().then(function (mods) {
      if (gen !== tabGeneration || !tabScope || tabScope.disposed()) return;
      showSkeleton(false);
      mods.forEach(function (m) { m.init(tabScope, kit); });
      emitBus(ADV_EVENTS.ready, { count: mods.length });
    }, function (err) {
      advLoadPromise = null; // 允许下次点击重试
      if (gen !== tabGeneration || !tabScope || tabScope.disposed()) return;
      showSkeleton(false);
      reportModuleError(err);
    });
  }

  /* ---------- 启动 / 卸载 ---------- */
  function boot() {
    initGlobalDelegates(rootScope);
    initKeyboardGuard(rootScope);
    // v17.0 模块二：骨架屏控制器只订阅事件，不持有加载器的函数引用。
    // 订阅句柄登记进 rootScope，pagehide 一并退订，杜绝监听器泄漏。
    var bus = window.EventBus;
    if (bus && typeof bus.on === "function") {
      rootScope.add(bus.on(ADV_EVENTS.loading, function (p) {
        var el = $("tb-skeleton-count");
        if (el) text(el, p && p.count ? p.count + " 个模块加载中" : "");
      }));
      rootScope.add(bus.on(ADV_EVENTS.error, function () {
        var badge = $("tb-load-badge");
        if (badge) { badge.hidden = false; text(badge, "MODULE ERROR"); }
      }));
    }
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
    /** v17.0：动态分片的加载状态，供按需加载测试与线上诊断 */
    moduleState: function () {
      return Object.freeze({
        loaded: !!advModules,
        loading: !!advLoadPromise && !advModules,
        error: moduleError,
        count: advModules ? advModules.length : 0,
      });
    },
    activate: activateTab,
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
