/* ============================================================
 * toolbox-pure.js —— 极客工具箱「纯函数内核」（v14.0）
 * ------------------------------------------------------------
 * 架构纪律（模块一 · 纯函数彻底抽离）：
 *   · 12 个工具的**全部核心算法**都在这里，不含任何 DOM、网络、
 *     UI 状态、全局单例。给定相同入参必得相同出参（随机/时间类
 *     通过注入 rng / now 保持可测）。
 *   · components/toolbox.js 只负责「读 DOM → 调本层 → 写 DOM」。
 *   · services/toolboxWorker.js 通过 importScripts 复用同一份内核，
 *     保证主线程与 Worker 的正则 / Diff / 哈希结果逐字一致。
 *   · 零 fetch、零 console、零 document/window 依赖（仅用 Web 标准
 *     TextEncoder/TextDecoder/btoa/atob/crypto，Node 22 同样具备）。
 *
 * 兼容三种环境：
 *   浏览器 <script> → globalThis === window → window.ToolboxPure
 *   Worker importScripts → globalThis === self → self.ToolboxPure
 *   Node ESM（step27 直测）→ globalThis.ToolboxPure
 * 本文件不含 import/export，三种环境均可直接执行。
 * ============================================================ */
(function (root) {
  "use strict";

  var C = root.ToolboxConstants || {};

  /* ============================================================
   * 通用小工具
   * ============================================================ */

  /**
   * HTML 转义，供必须拼接 HTML 串的场景（JSON 语法高亮）使用。
   * @param {string} s 原始文本
   * @returns {string} 转义后的文本
   */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /**
   * 两位补零。
   * @param {number} n 数字
   * @returns {string} 补零后的字符串
   */
  function pad2(n) { return String(n).padStart(2, "0"); }

  /**
   * 字节数组转十六进制字符串。
   * @param {ArrayBuffer|Uint8Array} buf 字节序列
   * @returns {string} 小写十六进制
   */
  function toHex(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += pad2(bytes[i].toString(16));
    return out;
  }

  /**
   * 人类可读字节数。
   * @param {number} n 字节数
   * @returns {string} 例如 "12.3 KB"
   */
  function formatBytes(n) {
    if (!isFinite(n) || n < 0) return "—";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  /* ============================================================
   * 工具 1：JSON 格式化 / 压缩 / 语法高亮
   * ============================================================ */

  /**
   * JSON 语法着色：先在**原始文本**上做 token 切分，再逐段 HTML 转义，
   * 最后拼接 span。这样既保证 key / string / number 的 token 正则在
   * 未转义的引号上正常命中，又保证拼进 DOM 的正文永不含可执行标签。
   * （v14.0 修复：早期版本先整体 escapeHtml 再匹配，引号被转成
   *  &quot; 后 token 正则失效，导致 tb-tok-key / tb-tok-str 不生成。）
   * @param {string} raw 已格式化的 JSON 文本
   * @returns {string} 带 tb-tok-* span 的安全 HTML
   */
  function highlightJson(raw) {
    var src = String(raw == null ? "" : raw);
    var re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    var out = "", last = 0, m;
    while ((m = re.exec(src)) !== null) {
      out += escapeHtml(src.slice(last, m.index));
      var cls = "tb-tok-num";
      if (m[0].charAt(0) === '"') cls = m[2] ? "tb-tok-key" : "tb-tok-str";
      else if (m[0] === "true" || m[0] === "false") cls = "tb-tok-bool";
      else if (m[0] === "null") cls = "tb-tok-null";
      out += '<span class="' + cls + '">' + escapeHtml(m[0]) + "</span>";
      last = m.index + m[0].length;
    }
    out += escapeHtml(src.slice(last));
    return out;
  }

  /**
   * 解析并格式化 / 压缩 JSON。
   * @param {string} src 原始输入
   * @param {"format"|"minify"} mode 目标形态
   * @returns {{ok: boolean, json?: string, html?: string, chars?: number,
   *            bytes?: number, kind?: string, error?: string}} 结构化结果
   */
  function formatJson(src, mode) {
    var parsed;
    try {
      parsed = JSON.parse(src);
    } catch (e) {
      return { ok: false, error: String(e && e.message || e).replace(/^JSON\.parse:\s*/, "").slice(0, 160) };
    }
    var json = mode === "minify" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
    return {
      ok: true,
      json: json,
      html: highlightJson(json),
      chars: json.length,
      bytes: new TextEncoder().encode(json).length,
      kind: Array.isArray(parsed) ? "Array(" + parsed.length + ")" : typeof parsed,
    };
  }

  /* ============================================================
   * 工具 2：Base64（UTF-8 安全，分块避免 apply 展开栈溢出）
   * ============================================================ */

  /**
   * UTF-8 文本 → Base64。
   * @param {string} str 输入文本
   * @returns {string} Base64 串
   */
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var chunk = C.B64_CHUNK || 0x8000, bin = "";
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /**
   * Base64 → UTF-8 文本（非法输入或非 UTF-8 字节会抛错，由调用方隔离）。
   * @param {string} b64 Base64 串
   * @returns {string} 解码文本
   */
  function b64ToUtf8(b64) {
    var clean = String(b64).replace(/\s+/g, "");
    if (!clean) return "";
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  /**
   * Base64 双向转换的统一入口。
   * @param {string} src 输入
   * @param {"encode"|"decode"} mode 方向
   * @returns {{ok: boolean, value?: string, srcBytes?: number, outBytes?: number, error?: string}}
   */
  function base64Convert(src, mode) {
    try {
      if (mode === "decode") {
        var out = b64ToUtf8(src);
        return { ok: true, value: out, outBytes: new TextEncoder().encode(out).length };
      }
      var enc = utf8ToB64(src);
      return { ok: true, value: enc, srcBytes: new TextEncoder().encode(src).length, outBytes: enc.length };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /* ============================================================
   * 工具 3：时间戳 ⇄ 日期时间
   * ============================================================ */

  /**
   * 本地时间格式化为 YYYY-MM-DD HH:mm:ss。
   * @param {Date} d 日期对象
   * @returns {string} 本地时间串
   */
  function formatLocal(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  /**
   * UTC 时间格式化。
   * @param {Date} d 日期对象
   * @returns {string} UTC 时间串
   */
  function formatUtc(d) {
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + " " +
      pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + " UTC";
  }

  /**
   * 相对时间描述（注入 now 保持纯函数）。
   * @param {Date} d 目标时间
   * @param {number} now 当前时间戳（毫秒）
   * @returns {string} 如 "3 分钟前"
   */
  function relativeTime(d, now) {
    var diff = now - d.getTime(), abs = Math.abs(diff);
    var unit = abs < 60000 ? Math.round(abs / 1000) + " 秒"
      : abs < 3600000 ? Math.round(abs / 60000) + " 分钟"
        : abs < 86400000 ? Math.round(abs / 3600000) + " 小时"
          : Math.round(abs / 86400000) + " 天";
    return diff >= 0 ? unit + "前" : unit + "后";
  }

  /**
   * 解析时间戳（10 位秒 / 13 位毫秒）或标准日期时间串。
   * @param {string} raw 输入
   * @returns {Date|null} 解析结果，失败返回 null
   */
  function parseTimestampInput(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (/^\d+$/.test(s)) {
      var n = Number(s);
      return s.length <= 10 ? new Date(n * 1000) : new Date(n);
    }
    var d = new Date(s.replace(" ", "T"));
    if (!isNaN(d.getTime())) return d;
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return null;
  }

  /**
   * 生成时间戳报告行（与 v13 逐字保持兼容）。
   * @param {Date} d 目标时间
   * @param {number} now 当前时间戳（毫秒）
   * @returns {string[]} 报告行数组
   */
  function timestampLines(d, now) {
    var ms = d.getTime();
    return [
      "本地时间   " + formatLocal(d),
      "UTC 时间   " + formatUtc(d),
      "ISO 8601   " + d.toISOString(),
      "时间戳(s)  " + Math.floor(ms / 1000),
      "时间戳(ms) " + ms,
      "相对现在   " + relativeTime(d, now),
      "星期       " + ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()],
    ];
  }

  /* ============================================================
   * 工具 4：密码生成器（可注入 rng，纯函数化便于测试）
   * ============================================================ */

  /** 字符集常量 */
  var PW_SETS = Object.freeze({
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    digit: "0123456789",
    symbol: "!@#$%^&*()-_=+[]{}<>?~",
  });

  /**
   * [0,max) 无偏随机整数：拒绝采样消除取模偏置。
   * @param {number} max 上界（不含）
   * @param {function(Uint32Array):void} rng 随机源（默认 crypto.getRandomValues）
   * @returns {number} 无偏整数
   */
  function secureInt(max, rng) {
    if (max <= 0) return 0;
    var fill = rng || function (b) { root.crypto.getRandomValues(b); };
    var limit = Math.floor(4294967296 / max) * max;
    var buf = new Uint32Array(1), x;
    do { fill(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }

  /**
   * 生成高强度密码并计算香农熵。
   * @param {{length: number, upper: boolean, lower: boolean, digit: boolean,
   *          symbol: boolean, rng?: function}} opts 选项
   * @returns {{ok: boolean, password?: string, bits?: number, level?: string,
   *            levelClass?: string, pct?: number, charsetSize?: number,
   *            reason?: string}} 生成结果；未勾选任何字符类型时 ok=false
   */
  function generatePassword(opts) {
    var o = opts || {};
    var min = C.PW_MIN_LEN || 8, max = C.PW_MAX_LEN || 64, def = C.PW_DEFAULT_LEN || 20;
    var len = Math.max(min, Math.min(max, isNaN(o.length) ? def : Math.floor(o.length)));
    var keys = ["upper", "lower", "digit", "symbol"].filter(function (k) { return !!o[k]; });
    if (!keys.length) return { ok: false, reason: "请至少勾选一种字符类型" };
    var rng = o.rng;
    var charset = keys.map(function (k) { return PW_SETS[k]; }).join("");
    var chars = keys.map(function (k) {
      return PW_SETS[k].charAt(secureInt(PW_SETS[k].length, rng));
    });
    for (var i = chars.length; i < len; i++) chars.push(charset.charAt(secureInt(charset.length, rng)));
    for (var j = chars.length - 1; j > 0; j--) {
      var k = secureInt(j + 1, rng);
      var t = chars[j]; chars[j] = chars[k]; chars[k] = t;
    }
    var bits = Math.round(len * Math.log2(charset.length));
    var level = bits < (C.PW_ENTROPY_WEAK || 50) ? ["弱", "tb-bad"]
      : bits < (C.PW_ENTROPY_MID || 80) ? ["中", "tb-warn"]
        : bits < (C.PW_ENTROPY_STRONG || 120) ? ["强", "tb-ok"] : ["极强", "tb-excellent"];
    var pct = Math.max(C.PW_BAR_MIN_PCT || 6,
      Math.min(C.PW_BAR_MAX_PCT || 100, Math.round(bits / (C.PW_BAR_DIVISOR || 1.6))));
    return {
      ok: true, password: chars.join(""), bits: bits, level: level[0],
      levelClass: level[1], pct: pct, charsetSize: charset.length, length: len,
    };
  }

  /* ============================================================
   * 工具 5：文本哈希（MD5 纯 JS RFC1321 + Web Crypto 摘要）
   * ============================================================ */

  /**
   * MD5 摘要（RFC 1321 纯 JS 实现；Web Crypto 不提供 MD5）。
   * @param {Uint8Array} bytes 输入字节
   * @returns {string} 32 位十六进制 MD5
   */
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
    var bitLo = (len * 8) >>> 0, bitHi = Math.floor(len / 0x20000000);
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
      var A = a0, B = b0, Cc = c0, D = d0;
      for (var q = 0; q < 64; q++) {
        var F, g;
        if (q < 16) { F = (B & Cc) | (~B & D); g = q; }
        else if (q < 32) { F = (D & B) | (~D & Cc); g = (5 * q + 1) % 16; }
        else if (q < 48) { F = B ^ Cc ^ D; g = (3 * q + 5) % 16; }
        else { F = Cc ^ (B | ~D); g = (7 * q) % 16; }
        var sum = (A + F + K[q] + M[g]) >>> 0;
        var tmp = D; D = Cc; Cc = B;
        B = (B + rotl(sum, S[q])) >>> 0; A = tmp;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
      c0 = (c0 + Cc) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var hex = "";
    [a0, b0, c0, d0].forEach(function (w) {
      for (var k = 0; k < 4; k++) hex += pad2(((w >>> (8 * k)) & 0xff).toString(16));
    });
    return hex;
  }

  /**
   * 计算四种摘要（MD5 同步 + Web Crypto 异步）。
   * @param {string} text 输入文本
   * @param {{subtle?: object}} [env] 可注入 crypto.subtle（Worker/Node 通用）
   * @returns {Promise<{ok: boolean, bytes: number, hashes?: object, error?: string}>}
   */
  async function hashAll(text, env) {
    var bytes = new TextEncoder().encode(text);
    var subtle = (env && env.subtle) || (root.crypto && root.crypto.subtle);
    try {
      var md5 = md5Hex(bytes);
      if (!subtle) return { ok: true, bytes: bytes.length, hashes: { MD5: md5 } };
      var digests = await Promise.all(["SHA-1", "SHA-256", "SHA-512"].map(function (algo) {
        return subtle.digest(algo, bytes).then(toHex);
      }));
      return {
        ok: true, bytes: bytes.length,
        hashes: { MD5: md5, "SHA-1": digests[0], "SHA-256": digests[1], "SHA-512": digests[2] },
      };
    } catch (e) {
      return { ok: false, bytes: bytes.length, error: String(e && e.message || e) };
    }
  }

  /* ============================================================
   * 进阶工具 8：正则表达式测试（高亮 + 捕获组）
   * ============================================================ */

  /**
   * 执行正则匹配，返回匹配与捕获组的精确下标（供 UI 高亮）。
   * 非法正则在内部 try/catch 隔离，绝不向外抛异常。
   * @param {string} pattern 正则主体
   * @param {string} flags 标志串
   * @param {string} text 测试文本
   * @param {number} [maxMatches] 最多返回匹配数
   * @returns {{ok: boolean, error?: string, matches: Array, count: number,
   *            truncated: boolean, hasGroups: boolean}} 结构化匹配结果
   */
  function runRegex(pattern, flags, text, maxMatches) {
    var cap = maxMatches || C.REGEX_MAX_MATCHES || 500;
    var body = String(text == null ? "" : text).slice(0, C.REGEX_MAX_TEXT_LEN || 200000);
    var baseFlags = String(flags || "").replace(/[^gimsuyd]/g, "");
    var re, withIndices = false;
    // 优先使用 d（hasIndices）标志获取捕获组精确区间；旧引擎降级为 indexOf。
    try {
      re = new RegExp(pattern, baseFlags.indexOf("d") >= 0 ? baseFlags : baseFlags + "d");
      withIndices = true;
    } catch (e) {
      try { re = new RegExp(pattern, baseFlags); }
      catch (e2) { return { ok: false, error: String(e2 && e2.message || e2), matches: [], count: 0, truncated: false, hasGroups: false }; }
    }
    var global = /(?:^|[^\\])g/.test(baseFlags) || baseFlags.indexOf("g") >= 0;
    var iterRe = new RegExp(re.source, baseFlags.indexOf("g") >= 0 ? re.flags : re.flags + "g");
    var matches = [], m, guard = 0, truncated = false, hasGroups = false;
    var maxGuard = cap * 4 + body.length + 10;
    while ((m = iterRe.exec(body)) !== null) {
      if (matches.length >= cap) { truncated = true; break; }
      var groups = [];
      var whole = m[0];
      for (var gi = 1; gi < m.length; gi++) {
        var val = m[gi];
        var start = -1, end = -1;
        if (val !== undefined) {
          if (withIndices && m.indices && m.indices[gi]) {
            start = m.indices[gi][0]; end = m.indices[gi][1];
          } else {
            var rel = whole.indexOf(String(val));
            if (rel >= 0) { start = m.index + rel; end = start + String(val).length; }
          }
          if (start >= 0) hasGroups = true;
        }
        groups.push({ index: gi, start: start, end: end, text: val === undefined ? "" : String(val) });
      }
      matches.push({
        index: m.index, end: m.index + whole.length, text: whole,
        groups: groups, named: m.groups ? Object.keys(m.groups) : [],
      });
      if (whole.length === 0) iterRe.lastIndex++; // 防零宽匹配死循环
      if (++guard > maxGuard) { truncated = true; break; }
      if (!global) break; // 无 g 标志时只取首个匹配
    }
    return { ok: true, matches: matches, count: matches.length, truncated: truncated, hasGroups: hasGroups };
  }

  /**
   * 把匹配结果切成互不重叠的高亮片段，供 UI 用 textContent 安全渲染。
   * @param {string} text 原始文本
   * @param {Array} matches runRegex 返回的 matches
   * @returns {Array<{start: number, end: number, kind: string, groupIndex: number}>} 片段
   */
  function regexSegments(text, matches) {
    var src = String(text == null ? "" : text);
    var segs = [], cursor = 0;
    matches.forEach(function (mt) {
      if (mt.index > cursor) segs.push({ start: cursor, end: mt.index, kind: "plain", groupIndex: 0 });
      var inner = [];
      mt.groups.forEach(function (g) {
        if (g.start >= mt.index && g.end <= mt.end && g.end > g.start) {
          inner.push({ start: g.start, end: g.end, kind: "group", groupIndex: g.index });
        }
      });
      inner.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
      // 仅保留不重叠的捕获组区间（外层优先）
      var accepted = [], lastEnd = -1;
      inner.forEach(function (s) {
        if (s.start >= lastEnd) { accepted.push(s); lastEnd = s.end; }
      });
      var p = mt.index;
      accepted.forEach(function (s) {
        if (s.start > p) segs.push({ start: p, end: s.start, kind: "match", groupIndex: 0 });
        segs.push(s);
        p = s.end;
      });
      if (p < mt.end) segs.push({ start: p, end: mt.end, kind: "match", groupIndex: 0 });
      cursor = Math.max(cursor, mt.end);
    });
    if (cursor < src.length) segs.push({ start: cursor, end: src.length, kind: "plain", groupIndex: 0 });
    return segs;
  }

  /* ============================================================
   * 进阶工具 11：文本差异对比（LCS 行级 Diff）
   * ============================================================ */

  /**
   * 行级 LCS Diff。超过行数/格子数上限时降级为「整块删除 + 整块新增」，
   * 保证超大文本不会 OOM 或长时间占用线程。
   * @param {string} a 旧文本
   * @param {string} b 新文本
   * @param {number} [maxLines] 行数上限
   * @param {number} [maxCells] DP 格子上限
   * @returns {{ops: Array<{type: string, text: string, aLine: number, bLine: number}>,
   *            stats: {added: number, removed: number, equal: number},
   *            truncated: boolean}} Diff 结果
   */
  function diffLines(a, b, maxLines, maxCells) {
    var la = String(a == null ? "" : a).split("\n");
    var lb = String(b == null ? "" : b).split("\n");
    var maxL = maxLines || C.DIFF_MAX_LINES || 2000;
    var maxC = maxCells || C.DIFF_MAX_CELLS || 4000000;
    var stats = { added: 0, removed: 0, equal: 0 };
    function allReplace() {
      var ops = [];
      la.forEach(function (t, i) { ops.push({ type: "del", text: t, aLine: i + 1, bLine: 0 }); stats.removed++; });
      lb.forEach(function (t, i) { ops.push({ type: "add", text: t, aLine: 0, bLine: i + 1 }); stats.added++; });
      return { ops: ops, stats: stats, truncated: true };
    }
    if (la.length > maxL || lb.length > maxL || la.length * lb.length > maxC) return allReplace();
    var n = la.length, m = lb.length;
    // Uint32 滚动 DP：LCS 长度表（(n+1)*(m+1)）
    var dp = new Uint32Array((n + 1) * (m + 1));
    var at = function (i, j) { return i * (m + 1) + j; };
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[at(i, j)] = la[i] === lb[j] ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
      }
    }
    var ops = [], x = 0, y = 0;
    while (x < n && y < m) {
      if (la[x] === lb[y]) {
        ops.push({ type: "eq", text: la[x], aLine: x + 1, bLine: y + 1 }); stats.equal++; x++; y++;
      } else if (dp[at(x + 1, y)] >= dp[at(x, y + 1)]) {
        ops.push({ type: "del", text: la[x], aLine: x + 1, bLine: 0 }); stats.removed++; x++;
      } else {
        ops.push({ type: "add", text: lb[y], aLine: 0, bLine: y + 1 }); stats.added++; y++;
      }
    }
    while (x < n) { ops.push({ type: "del", text: la[x], aLine: x + 1, bLine: 0 }); stats.removed++; x++; }
    while (y < m) { ops.push({ type: "add", text: lb[y], aLine: 0, bLine: y + 1 }); stats.added++; y++; }
    return { ops: ops, stats: stats, truncated: false };
  }

  /* ============================================================
   * 进阶工具 9：二维码矩阵（注入 qrcode 工厂，保持纯函数）
   * ============================================================ */

  /**
   * 生成二维码布尔矩阵。qrFactory 由调用方注入（vendor/qrcode.js 的全局），
   * 使纯函数层不依赖任何具体库加载方式。
   * @param {string} text 待编码文本
   * @param {string} ecc 纠错等级 L/M/Q/H
   * @param {function} qrFactory qrcode(typeNumber, ecc) 工厂
   * @returns {{ok: boolean, size?: number, cells?: Array<Array<number>>,
   *            error?: string}} 矩阵结果（cells[row][col] = 1 表示深色）
   */
  function qrMatrix(text, ecc, qrFactory) {
    try {
      if (typeof qrFactory !== "function") return { ok: false, error: "二维码引擎未加载" };
      var s = String(text == null ? "" : text);
      if (!s) return { ok: false, error: "请输入要编码的内容" };
      if (s.length > (C.QR_MAX_TEXT_LEN || 800)) return { ok: false, error: "内容过长，无法生成二维码" };
      var qr = qrFactory(0, ecc || C.QR_DEFAULT_ECC || "M"); // 0 = 自动选型
      qr.addData(s, "Byte");
      qr.make();
      var size = qr.getModuleCount();
      var cells = [];
      for (var r = 0; r < size; r++) {
        var row = [];
        for (var c = 0; c < size; c++) row.push(qr.isDark(r, c) ? 1 : 0);
        cells.push(row);
      }
      return { ok: true, size: size, cells: cells };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e || "内容过长或不支持") };
    }
  }

  /* ============================================================
   * 进阶工具 10：图片压缩尺寸计算（纯几何，不含 DOM）
   * ============================================================ */

  /**
   * 等比缩放尺寸计算。
   * @param {number} w 原始宽
   * @param {number} h 原始高
   * @param {number} maxEdge 最长边上限
   * @returns {{w: number, h: number, scale: number}} 目标尺寸与缩放比
   */
  function fitDimensions(w, h, maxEdge) {
    var longest = Math.max(w, h);
    var scale = longest > maxEdge ? maxEdge / longest : 1;
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale: scale };
  }

  /**
   * 字节数组 → Base64（分块，供图片 Worker 使用）。
   * @param {Uint8Array} bytes 字节序列
   * @returns {string} Base64 串
   */
  function bytesToBase64(bytes) {
    var chunk = C.B64_CHUNK || 0x8000, bin = "";
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /* ============================================================
   * 进阶工具 12：颜色 / 渐变（纯数值转换 + CSS 生成）
   * ============================================================ */

  /**
   * #RGB / #RRGGBB → {r,g,b}。
   * @param {string} hex 十六进制色值
   * @returns {{r: number, g: number, b: number}|null} RGB 或 null
   */
  function hexToRgb(hex) {
    var s = String(hex || "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
  }

  /**
   * RGB → #RRGGBB。
   * @param {number} r 红
   * @param {number} g 绿
   * @param {number} b 蓝
   * @returns {string} 十六进制色值（大写）
   */
  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(function (v) {
      return pad2(Math.max(0, Math.min(255, Math.round(v))).toString(16));
    }).join("").toUpperCase();
  }

  /**
   * RGB → HSL。
   * @param {number} r 红
   * @param {number} g 绿
   * @param {number} b 蓝
   * @returns {{h: number, s: number, l: number}} HSL（h 度 / s,l 百分比）
   */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0, s = 0, l = (max + min) / 2;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = ((b - r) / d + 2);
      else h = ((r - g) / d + 4);
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  /**
   * 相对亮度（WCAG）。
   * @param {{r: number, g: number, b: number}} rgb RGB 对象
   * @returns {number} 0..1 亮度
   */
  function relativeLuminance(rgb) {
    var a = [rgb.r, rgb.g, rgb.b].map(function (v) {
      var c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }

  /**
   * 两色对比度（WCAG）。
   * @param {string} hexA 色值 A
   * @param {string} hexB 色值 B
   * @returns {number} 对比度 1..21
   */
  function contrastRatio(hexA, hexB) {
    var a = hexToRgb(hexA), b = hexToRgb(hexB);
    if (!a || !b) return 0;
    var la = relativeLuminance(a), lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /**
   * 生成 CSS 渐变声明。
   * @param {{type: "linear"|"radial", angle: number, stops: Array<{color: string, pos: number}>}} opts 渐变参数
   * @returns {string} CSS background 值
   */
  function buildGradientCss(opts) {
    var o = opts || {};
    var stops = (o.stops || []).map(function (s) { return s.color + " " + s.pos + "%"; }).join(", ");
    if (o.type === "radial") return "radial-gradient(circle at center, " + stops + ")";
    return "linear-gradient(" + (o.angle || 0) + "deg, " + stops + ")";
  }

  /**
   * 线性插值生成两色之间的调色板。
   * @param {string} hexA 起始色
   * @param {string} hexB 结束色
   * @param {number} count 色数（含首尾）
   * @returns {string[]} 十六进制色值数组
   */
  function gradientPalette(hexA, hexB, count) {
    var a = hexToRgb(hexA) || { r: 0, g: 0, b: 0 };
    var b = hexToRgb(hexB) || { r: 255, g: 255, b: 255 };
    var n = Math.max(2, Math.min(12, count || 5));
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      out.push(rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t));
    }
    return out;
  }

  /**
   * 随机十六进制色（可注入 rng）。
   * @param {function(Uint32Array):void} [rng] 随机源
   * @returns {string} #RRGGBB
   */
  function randomHex(rng) {
    return rgbToHex(secureInt(256, rng), secureInt(256, rng), secureInt(256, rng));
  }

  /* ============================================================
   * 导出
   * ============================================================ */

  /** @namespace ToolboxPure */
  var api = {
    // 通用
    escapeHtml, pad2, toHex, formatBytes,
    // 1 JSON
    highlightJson, formatJson,
    // 2 Base64
    utf8ToB64, b64ToUtf8, base64Convert,
    // 3 时间戳
    formatLocal, formatUtc, relativeTime, parseTimestampInput, timestampLines,
    // 4 密码
    PW_SETS, secureInt, generatePassword,
    // 5 哈希
    md5Hex, hashAll,
    // 8 正则
    runRegex, regexSegments,
    // 9 QR
    qrMatrix,
    // 10 图片
    fitDimensions, bytesToBase64,
    // 11 Diff
    diffLines,
    // 12 颜色
    hexToRgb, rgbToHex, rgbToHsl, relativeLuminance, contrastRatio,
    buildGradientCss, gradientPalette, randomHex,
  };

  root.ToolboxPure = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
