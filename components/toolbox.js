/* ============================================================
 * toolbox.js —— 极客工具箱（v13.0）7 个工具的浏览器端实现
 * ------------------------------------------------------------
 * 分层纪律：
 *   · 前 5 个工具是「前端极速版」：纯浏览器计算，绝不发起任何网络请求。
 *     全部边输入边出结果（BlogUtils.debounce 160ms 防抖）。
 *   · 后 2 个工具是「后端增强版」：一律走 window.BlogApi.get()，
 *     复用其超时熔断 / 指数退避 / 并发去重，绝不裸 fetch。
 *   · 所有用户输入渲染前一律 textContent 或 HTML 转义，杜绝 XSS。
 *   · 无内联脚本、无第三方 CDN、无 eval：严格 CSP 下同源外链即可运行。
 * ============================================================ */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var debounce = window.BlogUtils.debounce;
  var toast = window.UI.toast;
  var copyText = window.UI.copyText;
  var DEBOUNCE_MS = 160;
  var pad2 = function (n) { return String(n).padStart(2, "0"); };

  function text(el, v) { if (el) el.textContent = v == null ? "" : String(v); }
  function fmtLocal(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function fmtUtc(d) {
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + " " +
      pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + " UTC";
  }

  /* ---------- 通用：一键复制（事件委托，data-copy 指向目标元素 id） ---------- */
  document.addEventListener("click", async function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
    if (!btn) return;
    var src = $(btn.getAttribute("data-copy"));
    if (!src) return;
    var value = ("value" in src) ? src.value : src.textContent;
    if (!value) { toast("没有可复制的内容", "warn"); return; }
    var ok = await copyText(value);
    toast(ok ? "已复制到剪贴板" : "复制失败，请手动选中", ok ? "success" : "error");
    if (ok && !btn.dataset.copyBusy) {
      btn.dataset.copyBusy = "1";
      var old = btn.textContent;
      btn.textContent = "✓ 已复制";
      setTimeout(function () { btn.textContent = old; delete btn.dataset.copyBusy; }, 1200);
    }
  });

  /* ---------- 通用：卡片平滑展开 / 折叠 ---------- */
  function initCards() {
    document.querySelectorAll(".tb-card-head").forEach(function (head) {
      head.addEventListener("click", function () {
        var card = head.closest(".tb-card");
        if (!card) return;
        var collapsed = card.classList.toggle("is-collapsed");
        head.setAttribute("aria-expanded", String(!collapsed));
      });
    });
    function setAll(collapsed) {
      document.querySelectorAll(".tb-card").forEach(function (card) {
        card.classList.toggle("is-collapsed", collapsed);
        var head = card.querySelector(".tb-card-head");
        if (head) head.setAttribute("aria-expanded", String(!collapsed));
      });
    }
    var expand = $("tb-expand-all"), collapse = $("tb-collapse-all");
    if (expand) expand.addEventListener("click", function () { setAll(false); });
    if (collapse) collapse.addEventListener("click", function () { setAll(true); });
  }

  /* ============================================================
   * 工具 1：JSON 格式化 / 压缩 / 语法高亮
   * ============================================================ */
  var JSON_SAMPLE = '{"project":"toolbox","version":"13.0","stack":["Cloudflare Workers","PWA","TailwindCSS"],"features":{"frontend":5,"backend":2,"ssrfGuard":true,"latencyMs":null},"author":{"name":"Lei Yihan","site":"https://leiyihan.dpdns.org"}}';

  /** 先转义再着色：转义后的正文不含可执行的 <，插入的 span 才安全 */
  function highlightJson(raw) {
    var escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return escaped.replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      function (m) {
        var cls = "tb-tok-num";
        if (m.charAt(0) === '"') cls = /:\s*$/.test(m) ? "tb-tok-key" : "tb-tok-str";
        else if (m === "true" || m === "false") cls = "tb-tok-bool";
        else if (m === "null") cls = "tb-tok-null";
        return '<span class="' + cls + '">' + m + "</span>";
      }
    );
  }

  function setJsonStatus(ok, msg) {
    var el = $("json-status");
    if (!el) return;
    el.className = "tb-status " + (ok ? "tb-status-ok" : "tb-status-bad");
    text(el, (ok ? "● VALID  " : "● ERROR  ") + msg);
  }

  function runJson(mode) {
    var input = $("json-input"), out = $("json-output");
    if (!input || !out) return;
    var src = input.value.trim();
    if (!src) {
      out.innerHTML = '<span class="tb-dim">// 等待输入 JSON…</span>';
      setJsonStatus(true, "等待输入");
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(src);
    } catch (e) {
      out.textContent = "";
      setJsonStatus(false, e.message.replace(/^JSON\.parse:\s*/, "").slice(0, 160));
      return;
    }
    var json = mode === "minify" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
    out.innerHTML = highlightJson(json);
    var bytes = new TextEncoder().encode(json).length;
    setJsonStatus(true, (mode === "minify" ? "已压缩" : "已格式化") + " · " +
      json.length + " 字符 / " + bytes + " 字节 · " +
      (Array.isArray(parsed) ? "Array(" + parsed.length + ")" : typeof parsed));
  }

  function initJson() {
    var input = $("json-input");
    if (!input) return;
    input.value = JSON_SAMPLE;
    var auto = debounce(function () { runJson("format"); }, DEBOUNCE_MS);
    input.addEventListener("input", auto);
    var f = $("json-btn-format"), m = $("json-btn-minify"), c = $("json-btn-clear");
    if (f) f.addEventListener("click", function () { runJson("format"); });
    if (m) m.addEventListener("click", function () { runJson("minify"); });
    if (c) c.addEventListener("click", function () {
      input.value = ""; runJson("format"); input.focus();
    });
    runJson("format");
  }

  /* ============================================================
   * 工具 2：Base64 编解码（UTF-8 安全，分块避免展开栈溢出）
   * ============================================================ */
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var CHUNK = 0x8000, bin = "";
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var clean = b64.replace(/\s+/g, "");
    if (!clean) return "";
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  function setB64Status(ok, msg) {
    var el = $("b64-status");
    if (!el) return;
    el.className = "tb-status " + (ok ? "tb-status-ok" : "tb-status-bad");
    text(el, (ok ? "● OK  " : "● ERROR  ") + msg);
  }

  function runB64() {
    var input = $("b64-input"), out = $("b64-output"), mode = $("b64-mode");
    if (!input || !out || !mode) return;
    var src = input.value;
    if (!src) { out.value = ""; setB64Status(true, "等待输入"); return; }
    try {
      if (mode.value === "encode") {
        out.value = utf8ToB64(src);
        setB64Status(true, "UTF-8 → Base64 · " + new TextEncoder().encode(src).length +
          " 字节 → " + out.value.length + " 字符");
      } else {
        out.value = b64ToUtf8(src);
        setB64Status(true, "Base64 → UTF-8 · " + new TextEncoder().encode(out.value).length + " 字节");
      }
    } catch (e) {
      out.value = "";
      setB64Status(false, mode.value === "decode"
        ? "不是合法的 Base64，或解码结果不是有效 UTF-8 文本"
        : "编码失败：" + String(e && e.message).slice(0, 100));
    }
  }

  function initB64() {
    var input = $("b64-input");
    if (!input) return;
    input.value = "极客工具箱 · Toolbox v13.0 🚀";
    var auto = debounce(runB64, DEBOUNCE_MS);
    input.addEventListener("input", auto);
    if ($("b64-mode")) $("b64-mode").addEventListener("change", runB64);
    if ($("b64-btn-clear")) $("b64-btn-clear").addEventListener("click", function () {
      input.value = ""; runB64(); input.focus();
    });
    if ($("b64-btn-swap")) $("b64-btn-swap").addEventListener("click", function () {
      var out = $("b64-output");
      if (!out || !out.value) { toast("输出为空，无法交换", "warn"); return; }
      input.value = out.value;
      var mode = $("b64-mode");
      mode.value = mode.value === "encode" ? "decode" : "encode";
      runB64();
    });
    runB64();
  }

  /* ============================================================
   * 工具 3：时间戳 ⇄ 标准日期时间（双向，自动识别秒 / 毫秒）
   * ============================================================ */
  function relative(d) {
    var diff = Date.now() - d.getTime();
    var abs = Math.abs(diff);
    var unit = abs < 60000 ? Math.round(abs / 1000) + " 秒"
      : abs < 3600000 ? Math.round(abs / 60000) + " 分钟"
      : abs < 86400000 ? Math.round(abs / 3600000) + " 小时"
      : Math.round(abs / 86400000) + " 天";
    return diff >= 0 ? unit + "前" : unit + "后";
  }

  function tsFromInput(raw) {
    if (/^\d+$/.test(raw)) {
      var n = Number(raw);
      // 10 位按秒、13 位按毫秒；其余按数量级推断
      return raw.length <= 10 ? new Date(n * 1000) : new Date(n);
    }
    var normalized = raw.trim().replace(" ", "T");
    var d = new Date(normalized);
    if (!isNaN(d.getTime())) return d;
    // 兼容 "2026-11-06 16:08:17" 这类本地时间字符串（Safari 需显式补时区）
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return null;
  }

  function runTs() {
    var input = $("ts-input"), out = $("ts-output");
    if (!input || !out) return;
    var raw = input.value.trim();
    if (!raw) { text(out, "// 等待输入时间戳或日期时间…"); setTsStatus(true, "等待输入"); return; }
    var d = tsFromInput(raw);
    if (!d || isNaN(d.getTime())) {
      text(out, "");
      setTsStatus(false, "无法解析，请输入 10/13 位时间戳或 YYYY-MM-DD HH:mm:ss");
      return;
    }
    var ms = d.getTime();
    var lines = [
      "本地时间   " + fmtLocal(d),
      "UTC 时间   " + fmtUtc(d),
      "ISO 8601   " + d.toISOString(),
      "时间戳(s)  " + Math.floor(ms / 1000),
      "时间戳(ms) " + ms,
      "相对现在   " + relative(d),
      "星期       " + ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()],
    ];
    text(out, lines.join("\n"));
    setTsStatus(true, "解析成功 · 时区 " + (Intl.DateTimeFormat().resolvedOptions().timeZone || "本地"));
  }

  function setTsStatus(ok, msg) {
    var el = $("ts-status");
    if (!el) return;
    el.className = "tb-status " + (ok ? "tb-status-ok" : "tb-status-bad");
    text(el, (ok ? "● OK  " : "● ERROR  ") + msg);
  }

  function tickNow() {
    var now = Date.now();
    text($("ts-now-s"), Math.floor(now / 1000));
    text($("ts-now-ms"), now);
  }

  function initTs() {
    var input = $("ts-input");
    if (!input) return;
    input.value = String(Date.now());
    var auto = debounce(runTs, DEBOUNCE_MS);
    input.addEventListener("input", auto);
    if ($("ts-mode")) $("ts-mode").addEventListener("change", function () {
      var m = $("ts-mode").value;
      input.placeholder = m === "ts2date" ? "例如 1730889600 或 1730889600000" : "例如 2026-11-06 16:08:17";
      input.value = m === "ts2date" ? String(Date.now()) : fmtLocal(new Date());
      runTs();
    });
    if ($("ts-btn-now")) $("ts-btn-now").addEventListener("click", function () {
      input.value = String(Date.now());
      if ($("ts-mode")) $("ts-mode").value = "ts2date";
      runTs();
    });
    runTs();
    tickNow();
    setInterval(tickNow, 1000);
  }

  /* ============================================================
   * 工具 4：密码生成器（crypto.getRandomValues 无偏采样）
   * ============================================================ */
  var PW_SETS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    digit: "0123456789",
    symbol: "!@#$%^&*()-_=+[]{}<>?~",
  };

  /** [0, max) 无偏随机整数：拒绝采样消除取模偏置 */
  function secureInt(max) {
    if (max <= 0) return 0;
    var limit = Math.floor(4294967296 / max) * max;
    var buf = new Uint32Array(1), x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }
  function securePick(str) { return str.charAt(secureInt(str.length)); }

  function generatePassword() {
    var len = parseInt(($("pw-length") || {}).value || "16", 10);
    len = Math.max(8, Math.min(64, isNaN(len) ? 16 : len));
    var active = [];
    ["upper", "lower", "digit", "symbol"].forEach(function (k) {
      var cb = $("pw-" + k);
      if (cb && cb.checked) active.push(k);
    });
    var out = $("pw-output");
    if (!active.length) {
      if (out) out.value = "";
      text($("pw-strength-text"), "请至少勾选一种字符类型");
      var bar0 = $("pw-strength-bar");
      if (bar0) bar0.style.width = "0%";
      text($("pw-entropy"), "—");
      return;
    }
    var charset = active.map(function (k) { return PW_SETS[k]; }).join("");
    var chars = active.map(function (k) { return securePick(PW_SETS[k]); }); // 每类至少 1 个
    for (var i = chars.length; i < len; i++) chars.push(securePick(charset));
    // Fisher-Yates 洗牌，避免「前 N 位必然是各类首字母」的规律
    for (var j = chars.length - 1; j > 0; j--) {
      var k = secureInt(j + 1);
      var t = chars[j]; chars[j] = chars[k]; chars[k] = t;
    }
    var pw = chars.join("");
    if (out) out.value = pw;
    var bits = Math.round(len * Math.log2(charset.length));
    var level = bits < 50 ? ["弱", "tb-bad"] : bits < 80 ? ["中", "tb-warn"]
      : bits < 120 ? ["强", "tb-ok"] : ["极强", "tb-excellent"];
    var pct = Math.max(6, Math.min(100, Math.round(bits / 1.6)));
    var bar = $("pw-strength-bar");
    if (bar) { bar.style.width = pct + "%"; bar.className = "tb-bar-fill " + level[1]; }
    text($("pw-strength-text"), "强度：" + level[0]);
    text($("pw-entropy"), bits + " bits 熵 · " + len + " 位 · 字符集 " + charset.length);
  }

  function initPw() {
    if (!$("pw-length")) return;
    var range = $("pw-length"), num = $("pw-length-num");
    num.value = range.value;
    var auto = debounce(generatePassword, DEBOUNCE_MS);
    range.addEventListener("input", function () { num.value = range.value; auto(); });
    num.addEventListener("input", function () {
      var v = Math.max(8, Math.min(64, parseInt(num.value, 10) || 16));
      range.value = v; auto();
    });
    ["upper", "lower", "digit", "symbol"].forEach(function (k) {
      var cb = $("pw-" + k);
      if (cb) cb.addEventListener("change", auto);
    });
    if ($("pw-btn-gen")) $("pw-btn-gen").addEventListener("click", generatePassword);
    generatePassword();
  }

  /* ============================================================
   * 工具 5：文本哈希（Web Crypto + 纯 JS MD5）
   * ------------------------------------------------------------
   * 诚实性说明：Web Crypto API 不提供 MD5。SHA-1/256/512 走原生
   * crypto.subtle；MD5 由本文件内纯 JS 实现（RFC 1321），同样完全在
   * 浏览器本地计算、绝不请求后端。MD5 已不抗碰撞，仅用于校验/兼容。
   * ============================================================ */
  function md5Hex(bytes) {
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = new Uint32Array(64);
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

    var len = bytes.length;
    var padLen = (len % 64 < 56) ? (56 - len % 64) : (120 - len % 64);
    var total = len + padLen + 8;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    var bitLo = (len * 8) >>> 0;
    var bitHi = Math.floor(len / 0x20000000);
    for (var p = 0; p < 4; p++) {
      buf[total - 8 + p] = (bitLo >>> (8 * p)) & 0xff;
      buf[total - 4 + p] = (bitHi >>> (8 * p)) & 0xff;
    }
    function readLE(off) {
      return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
    }
    function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var M = new Uint32Array(16);
    for (var off = 0; off < total; off += 64) {
      for (var j = 0; j < 16; j++) M[j] = readLE(off + j * 4);
      var A = a0, B = b0, C = c0, D = d0;
      for (var q = 0; q < 64; q++) {
        var F, g;
        if (q < 16) { F = (B & C) | (~B & D); g = q; }
        else if (q < 32) { F = (D & B) | (~D & C); g = (5 * q + 1) % 16; }
        else if (q < 48) { F = B ^ C ^ D; g = (3 * q + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * q) % 16; }
        var sum = (A + F + K[q] + M[g]) >>> 0;
        var tmp = D;
        D = C;
        C = B;
        B = (B + rotl(sum, S[q])) >>> 0;
        A = tmp;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var hex = "";
    [a0, b0, c0, d0].forEach(function (w) {
      for (var k = 0; k < 4; k++) hex += pad2(((w >>> (8 * k)) & 0xff).toString(16));
    });
    return hex;
  }

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(function (b) { return pad2(b.toString(16)); }).join("");
  }
  async function webDigest(algo, bytes) {
    var buf = await crypto.subtle.digest(algo, bytes);
    return toHex(buf);
  }

  var hashSeq = 0;
  async function runHash() {
    var input = $("hash-input");
    if (!input) return;
    var seq = ++hashSeq;
    var bytes = new TextEncoder().encode(input.value);
    if (!bytes.length) {
      ["hash-md5", "hash-sha1", "hash-sha256", "hash-sha512"].forEach(function (id) { text($(id), "—"); });
      setHashStatus(true, "等待输入 · 0 字节");
      return;
    }
    try {
      var results = await Promise.all([
        Promise.resolve().then(function () { return md5Hex(bytes); }),
        webDigest("SHA-1", bytes),
        webDigest("SHA-256", bytes),
        webDigest("SHA-512", bytes),
      ]);
      if (seq !== hashSeq) return; // 丢弃过期结果，避免快速输入时乱序覆盖
      ["hash-md5", "hash-sha1", "hash-sha256", "hash-sha512"].forEach(function (id, i) {
        text($(id), results[i]);
      });
      setHashStatus(true, "本地计算完成 · " + bytes.length + " 字节 · 4 种摘要");
    } catch (e) {
      if (seq !== hashSeq) return;
      setHashStatus(false, "计算失败：" + String(e && e.message).slice(0, 100));
    }
  }

  function setHashStatus(ok, msg) {
    var el = $("hash-status");
    if (!el) return;
    el.className = "tb-status " + (ok ? "tb-status-ok" : "tb-status-bad");
    text(el, (ok ? "● OK  " : "● ERROR  ") + msg);
  }

  function initHash() {
    var input = $("hash-input");
    if (!input) return;
    input.value = "Hello, Toolbox v13.0 — 极客工具箱";
    input.addEventListener("input", debounce(runHash, DEBOUNCE_MS));
    if ($("hash-btn-clear")) $("hash-btn-clear").addEventListener("click", function () {
      input.value = ""; runHash(); input.focus();
    });
    runHash();
  }

  /* ============================================================
   * 工具 6：网页状态码探测器 —— 统一走 BlogApi（超时熔断 / 防重）
   * ============================================================ */
  var probeSeq = 0;
  function probeClass(code) {
    if (code >= 200 && code < 300) return "tb-ok";
    if (code >= 300 && code < 400) return "tb-redirect";
    if (code >= 400 && code < 500) return "tb-warn";
    if (code >= 500) return "tb-bad";
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
      var hs = (d && d.headers) || {};
      var keys = Object.keys(hs);
      if (!keys.length) {
        var tr0 = document.createElement("tr");
        var td0 = document.createElement("td");
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

  async function runProbe() {
    var input = $("probe-url"), btn = $("probe-btn");
    if (!input || !btn) return;
    var target = input.value.trim();
    if (!target) { toast("请先输入要探测的 URL", "warn"); input.focus(); return; }
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    var seq = ++probeSeq;
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "探测中…";
    text($("probe-latency"), "…");
    try {
      var data = await window.BlogApi.get(
        "/api/toolbox/probe?url=" + encodeURIComponent(target),
        { timeout: 12000, retry: 0 }  // 探测讲究实时，关闭重试；12s 超时熔断 + 并发去重由 BlogApi 提供
      );
      if (seq !== probeSeq) return;
      renderProbe(data);
    } catch (e) {
      if (seq !== probeSeq) return;
      renderProbe({ status: "error", httpStatus: 0, error: (e && e.message) || "请求失败", code: "CLIENT_ERROR", elapsed: 0, headers: {}, url: target });
      toast((e && e.message) || "探测失败", "error");
    } finally {
      if (seq === probeSeq) { btn.disabled = false; btn.textContent = old; }
    }
  }

  function initProbe() {
    var input = $("probe-url");
    if (!input) return;
    input.value = "https://www.baidu.com";
    if ($("probe-btn")) $("probe-btn").addEventListener("click", runProbe);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); runProbe(); }
    });
    document.querySelectorAll("[data-probe-preset]").forEach(function (b) {
      b.addEventListener("click", function () {
        input.value = b.getAttribute("data-probe-preset");
        runProbe();
      });
    });
    renderProbe({
      status: "idle", httpStatus: 0, statusText: "READY", elapsed: 0,
      headers: {}, note: "输入 URL 后点击「发起探测」，请求经 Cloudflare Worker 代理发出（HEAD 模式）。",
    });
  }

  /* ============================================================
   * 工具 7：IP 归属地 / 网络信息 —— 页面加载即自动查询
   * ============================================================ */
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
    text($("ip-source"), (d.provider || "—") + " / " + (d.source || "—") +
      (d.cached ? " / 缓存" : ""));
    text($("ip-elapsed"), typeof d.elapsed === "number" ? d.elapsed + " ms" : "—");
    var note = $("ip-note");
    if (!note) return;
    var msg = unavailable
      ? "✕ " + (d.error || "上游暂不可用") + (d.attempts && d.attempts.length ? "：" + d.attempts.join("；") : "")
      : (fallback ? "⚠ 网络不稳定，展示的是本地缓存数据。" : "") +
        (d.message || "") +
        (d.scope === "visitor" ? "  · 数据来自访客真实公网 IP" : "  · 出口视角");
    note.className = "tb-note " + (unavailable ? "tb-note-bad" : "");
    text(note, msg || "查询完成");
  }

  var ipSeq = 0;
  async function loadIpInfo() {
    var btn = $("ip-refresh");
    var seq = ++ipSeq;
    if (btn) { btn.disabled = true; btn.textContent = "查询中…"; }
    try {
      // 统一封装层：12s 超时熔断、1 次指数退避重试、并发去重；
      // 不设 cacheKey —— 访客 IP 属个人数据，不落 localStorage。
      var data = await window.BlogApi.get("/api/toolbox/ipinfo", {
        timeout: 12000, retry: 1,
      });
      if (seq !== ipSeq) return;
      renderIpInfo(data, false);
    } catch (e) {
      if (seq !== ipSeq) return;
      renderIpInfo({ status: "unavailable", query: "—", error: (e && e.message) || "请求失败" }, false);
    } finally {
      if (seq === ipSeq && btn) { btn.disabled = false; btn.textContent = "↻ 重新查询"; }
    }
  }

  function initIpInfo() {
    if (!$("ip-query")) return;
    if ($("ip-refresh")) $("ip-refresh").addEventListener("click", loadIpInfo);
    // 延后一个 tick，确保页面其余模块先完成初始化，不抢占首屏
    setTimeout(loadIpInfo, 60);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initCards();
    initJson();
    initB64();
    initTs();
    initPw();
    initHash();
    initProbe();
    initIpInfo();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
