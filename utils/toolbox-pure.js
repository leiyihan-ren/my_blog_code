/* ============================================================
 * toolbox-pure.js —— 极客工具箱「纯函数内核」（v15.0）
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
   * v15.0 工具 13：Cron 表达式生成 / 解析 / 下次执行时间预测
   * ------------------------------------------------------------
   * 纯数值 + Date 运算，不依赖任何 DOM、Intl 或第三方库。时间基准
   * 一律采用「本地时区」（与用户在可视化界面上看到的时间一致），
   * 起始时间戳由调用方注入，保证相同入参必得相同出参。
   * ============================================================ */

  /**
   * 解析 Cron 单字段为排序去重的合法取值集合。
   * 支持通配星号、带步进的通配、单值 `a`、区间 `a-b`、区间带步进、起始值带步进，
   * 以及用逗号连接的多段组合（如 1,3,5-9）。
   * @param {string} field 字段原文
   * @param {number} min 该字段合法最小值
   * @param {number} max 该字段合法最大值
   * @returns {{ok: boolean, values?: number[], star?: boolean, error?: string}} 解析结果
   */
  function parseCronField(field, min, max) {
    var s = String(field == null ? "" : field).trim();
    if (!s) return { ok: false, error: "字段不能为空" };
    var star = /^\*$/.test(s);
    var out = [];
    var parts = s.split(",");
    for (var pi = 0; pi < parts.length; pi++) {
      var part = parts[pi].trim();
      if (!part) return { ok: false, error: "存在空的分段" };
      var step = 1, range = part, stepped = false;
      var slash = part.indexOf("/");
      if (slash >= 0) {
        range = part.slice(0, slash).trim();
        var stepRaw = part.slice(slash + 1).trim();
        if (!/^\d+$/.test(stepRaw)) return { ok: false, error: "步进值必须是正整数：" + part };
        step = Number(stepRaw);
        if (step < 1) return { ok: false, error: "步进值必须大于 0：" + part };
        stepped = true;
      }
      var lo, hi;
      if (range === "*") {
        lo = min; hi = max;
      } else {
        var m = /^(\d+)(?:-(\d+))?$/.exec(range);
        if (!m) return { ok: false, error: "无法解析字段：" + part };
        lo = Number(m[1]);
        hi = m[2] === undefined ? (stepped ? max : lo) : Number(m[2]);
      }
      if (!isFinite(lo) || !isFinite(hi) || lo < min || hi > max || lo > hi) {
        return { ok: false, error: "字段超出范围 " + min + "–" + max + "：" + part };
      }
      for (var v = lo; v <= hi; v += step) out.push(v);
    }
    if (!out.length) return { ok: false, error: "字段未产生任何取值" };
    out.sort(function (a, b) { return a - b; });
    var uniq = [];
    for (var i = 0; i < out.length; i++) {
      if (uniq.length === 0 || uniq[uniq.length - 1] !== out[i]) uniq.push(out[i]);
    }
    return { ok: true, values: uniq, star: star };
  }

  /**
   * 把 5 段 Cron 表达式字符串拆为字段对象。
   * @param {string} expression Cron 表达式（分 时 日 月 周）
   * @returns {{ok: boolean, parts?: Object, error?: string}} 拆分结果
   */
  function cronExpressionToParts(expression) {
    var t = String(expression == null ? "" : expression).trim().split(/\s+/);
    if (t.length !== 5 || !t[0]) return { ok: false, error: "Cron 表达式必须恰好 5 段（分 时 日 月 周）" };
    return {
      ok: true,
      parts: { minute: t[0], hour: t[1], dom: t[2], month: t[3], dow: t[4] },
    };
  }

  /**
   * 校验并组装 Cron 表达式（可视化控件的唯一出口）。
   * @param {Object|string} parts 字段对象或 5 段表达式字符串
   * @returns {{ok: boolean, expression?: string, fields?: Object, wild?: Object,
   *            parts?: Object, field?: string, error?: string}} 组装结果
   */
  function buildCron(parts) {
    var p = parts;
    if (typeof parts === "string") {
      var sp = cronExpressionToParts(parts);
      if (!sp.ok) return { ok: false, error: sp.error };
      p = sp.parts;
    }
    var src = p || {};
    var ranges = C.CRON_RANGES || {
      minute: { min: 0, max: 59 }, hour: { min: 0, max: 23 }, dom: { min: 1, max: 31 },
      month: { min: 1, max: 12 }, dow: { min: 0, max: 7 },
    };
    var names = C.CRON_FIELDS || ["minute", "hour", "dom", "month", "dow"];
    var fields = {}, wild = {}, normalized = {}, text = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var raw = String(src[name] == null ? "*" : src[name]).trim() || "*";
      var r = parseCronField(raw, ranges[name].min, ranges[name].max);
      if (!r.ok) return { ok: false, error: name + " 段：" + r.error, field: name };
      fields[name] = r.values;
      wild[name] = !!r.star;
      normalized[name] = raw;
      text.push(raw);
    }
    // 星期 7 与 0 都代表周日，统一归并，避免预测时漏匹配
    var dow = fields.dow.slice();
    if (dow.indexOf(7) >= 0 && dow.indexOf(0) < 0) dow.push(0);
    fields.dow = dow.sort(function (a, b) { return a - b; });
    return {
      ok: true, expression: text.join(" "), fields: fields,
      wild: wild, parts: normalized,
    };
  }

  /**
   * 判断某个本地时间点是否命中 Cron 各字段。
   * 遵循 Vixie cron 语义：日 / 周都受限时二者为「或」关系，都通配时每天命中。
   * @param {Object} fields buildCron 返回的取值集合
   * @param {Object} wild buildCron 返回的通配标记
   * @param {Date} d 待判定的本地时间点
   * @returns {boolean} 是否命中
   */
  function cronMatches(fields, wild, d) {
    var minute = d.getMinutes(), hour = d.getHours();
    var month = d.getMonth() + 1, dom = d.getDate(), dow = d.getDay();
    if (fields.minute.indexOf(minute) < 0) return false;
    if (fields.hour.indexOf(hour) < 0) return false;
    if (fields.month.indexOf(month) < 0) return false;
    var domHit = fields.dom.indexOf(dom) >= 0;
    var dowHit = fields.dow.indexOf(dow) >= 0;
    if (!wild.dom && !wild.dow) return domHit || dowHit;
    if (!wild.dom) return domHit;
    if (!wild.dow) return dowHit;
    return true;
  }

  /**
   * 预测接下来 N 次执行时间戳（升序）。
   * 采用「按月 / 按小时」跳进 + 分钟级扫描，避免逐年逐分钟遍历带来的开销；
   * 扫描窗口耗尽仍凑不满 N 次时返回已找到的结果并置 truncated。
   * @param {string|Object} expression Cron 表达式或字段对象
   * @param {number} [count] 需要预测的条数
   * @param {number} [fromMs] 起始时间戳（毫秒，注入保证可测）
   * @param {number} [maxScanMinutes] 最大扫描窗口（分钟）
   * @returns {{ok: boolean, times: number[], count: number, truncated: boolean,
   *            expression?: string, error?: string}} 预测结果
   */
  function cronNext(expression, count, fromMs, maxScanMinutes) {
    var built = buildCron(expression);
    if (!built.ok) return { ok: false, times: [], count: 0, truncated: false, error: built.error };
    var want = Math.max(1, Math.min(20, Number(count) || C.CRON_NEXT_COUNT || 5));
    var limit = Math.max(1, Number(maxScanMinutes) || C.CRON_MAX_SCAN_MINUTES || 527040);
    var start = (typeof fromMs === "number" && isFinite(fromMs)) ? fromMs : Date.now();
    var deadline = start + limit * 60000;
    var t = Math.floor(start / 60000) * 60000 + 60000;
    var times = [], steps = 0;
    var fields = built.fields, wild = built.wild;
    while (t <= deadline && times.length < want) {
      if (++steps > limit * 2) break; // 绝对熔断，杜绝任何异常导致的死循环
      var d = new Date(t);
      if (fields.month.indexOf(d.getMonth() + 1) < 0) {
        var nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
        t = nextMonth > t ? nextMonth : t + 60000;
        continue;
      }
      var domHit = fields.dom.indexOf(d.getDate()) >= 0;
      var dowHit = fields.dow.indexOf(d.getDay()) >= 0;
      var dayOk = (!wild.dom && !wild.dow) ? (domHit || dowHit)
        : !wild.dom ? domHit : !wild.dow ? dowHit : true;
      if (!dayOk) {
        var nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
        t = nextDay > t ? nextDay : t + 60000;
        continue;
      }
      if (fields.hour.indexOf(d.getHours()) < 0) {
        var nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
        t = nextHour > t ? nextHour : t + 60000;
        continue;
      }
      if (fields.minute.indexOf(d.getMinutes()) < 0) { t += 60000; continue; }
      times.push(t);
      t += 60000;
    }
    return {
      ok: times.length > 0, times: times, count: times.length,
      truncated: times.length < want, expression: built.expression,
    };
  }

  /**
   * 生成 Cron 表达式的中文可读描述（用于可视化面板的即时反馈）。
   * @param {string|Object} expression Cron 表达式或字段对象
   * @returns {{ok: boolean, text?: string, error?: string}} 描述结果
   */
  function cronDescribe(expression) {
    var b = buildCron(expression);
    if (!b.ok) return { ok: false, error: b.error };
    var p = b.parts, w = b.wild;
    var days = [];
    if (!w.dom) days.push("每月 " + p.dom + " 日");
    if (!w.dow) {
      var dows = b.fields.dow.filter(function (v) { return v !== 7; });
      var names = dows.map(function (v) {
        return "周" + ["日", "一", "二", "三", "四", "五", "六"][v];
      });
      var contiguous = dows.length > 2 && dows[dows.length - 1] - dows[0] === dows.length - 1;
      days.push(contiguous ? names[0] + "至" + names[names.length - 1] : names.join("、"));
    }
    if (!w.month) days.push(p.month + " 月");
    var when = "每分钟";
    if (!w.minute && !w.hour) when = "每天 " + pad2(Number(p.hour.split(/[^0-9]/)[0]) || 0) + ":" + pad2(Number(p.minute) || 0);
    else if (!w.minute) when = "每小时的第 " + p.minute + " 分";
    else if (!w.hour) when = p.hour + " 点的每分钟";
    return { ok: true, text: (days.length ? days.join(" / ") + " · " : "") + when + " 执行" };
  }

  /* ============================================================
   * v15.0 工具 14：URL 编解码 / Query 参数解析
   * ------------------------------------------------------------
   * 三种作用域：component（整串当作一个 URI 组件，严格按
   * encodeURIComponent / decodeURIComponent）、query（保留 URL 结构，
   * 只处理参数值）、all（键与值都处理）。query/all 采用表单语义，
   * 空格编码为 `+`，保证编解码可逆且不破坏 `://` `?` `&` `#` 结构。
   * ============================================================ */

  /**
   * 拆分 URL 为 base / query / hash（不依赖全局 URL 类，三端通用）。
   * @param {string} raw 原始输入
   * @returns {{base: string, query: string, hash: string, hasQuery: boolean}} 拆分结果
   */
  function splitUrl(raw) {
    var s = String(raw == null ? "" : raw);
    var hash = "", hi = s.indexOf("#");
    if (hi >= 0) { hash = s.slice(hi); s = s.slice(0, hi); }
    var qi = s.indexOf("?");
    return {
      base: qi >= 0 ? s.slice(0, qi) : "",
      query: qi >= 0 ? s.slice(qi + 1) : s,
      hash: hash,
      hasQuery: qi >= 0,
    };
  }

  /**
   * 表单语义编码（空格 → `+`）。
   * @param {string} v 明文
   * @returns {string} 编码串
   */
  function formEncode(v) {
    return encodeURIComponent(String(v == null ? "" : v)).replace(/%20/g, "+");
  }

  /**
   * 表单语义解码（`+` → 空格），非法百分号序列局部隔离为原串。
   * @param {string} v 编码串
   * @returns {{value: string, invalid: boolean}} 解码值与是否遇到非法编码
   */
  function formDecode(v) {
    var raw = String(v == null ? "" : v);
    try {
      return { value: decodeURIComponent(raw.replace(/\+/g, " ")), invalid: false };
    } catch (e) {
      return { value: raw, invalid: true };
    }
  }

  /**
   * URL 编解码统一入口。
   * @param {string} input 输入串
   * @param {"encode"|"decode"} mode 编码 / 解码
   * @param {"component"|"query"|"all"} [scope] 作用域，默认 query
   * @returns {{ok: boolean, value?: string, invalid?: number, error?: string}} 转换结果
   */
  function urlConvert(input, mode, scope) {
    var s = String(input == null ? "" : input);
    if (s.length > (C.URL_MAX_LEN || 20000)) return { ok: false, error: "输入过长，无法处理" };
    var dec = mode === "decode";
    var sc = scope || "query";
    if (sc === "component") {
      try {
        return { ok: true, value: dec ? decodeURIComponent(s) : encodeURIComponent(s), invalid: 0 };
      } catch (e) {
        return { ok: false, error: dec ? "包含非法的百分号编码（% 后需跟两位十六进制）" : "编码失败：" + String(e && e.message || e) };
      }
    }
    if (sc !== "query" && sc !== "all") return { ok: false, error: "不支持的作用域：" + sc };
    var sp = splitUrl(s);
    var pairs = sp.query.length ? sp.query.split("&") : [];
    var out = [], invalid = 0;
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      if (pair === "") { out.push(""); continue; }
      var eq = pair.indexOf("=");
      var k = eq >= 0 ? pair.slice(0, eq) : pair;
      var v = eq >= 0 ? pair.slice(eq + 1) : "";
      var nk = k, nv = v;
      if (dec) {
        var dk = formDecode(k), dv = formDecode(v);
        if (dk.invalid) invalid++;
        if (dv.invalid) invalid++;
        nk = sc === "all" ? dk.value : k;
        nv = dv.value;
      } else {
        nk = sc === "all" ? formEncode(k) : k;
        nv = formEncode(v);
      }
      out.push(eq >= 0 ? nk + "=" + nv : nk);
    }
    var prefix = sp.hasQuery ? sp.base + "?" : "";
    return { ok: true, value: prefix + out.join("&") + sp.hash, invalid: invalid };
  }

  /**
   * 解析 URL 的 Query 参数列表（保留原始值与解码值，重复键按出现顺序保留）。
   * @param {string} url 完整 URL 或纯查询串
   * @returns {{ok: boolean, base: string, hash: string,
   *            params: Array<{key: string, value: string, rawKey: string, rawValue: string, invalid: boolean}>,
   *            count: number, invalid: number, truncated: boolean}} 解析结果
   */
  function parseQuery(url) {
    var s = String(url == null ? "" : url);
    if (s.length > (C.URL_MAX_LEN || 20000)) return {
      ok: false, base: "", hash: "", params: [], count: 0, invalid: 0, truncated: true,
    };
    var sp = splitUrl(s);
    var limit = C.QUERY_MAX_PARAMS || 200;
    var segs = sp.query.length ? sp.query.split("&") : [];
    var params = [], invalid = 0;
    for (var i = 0; i < segs.length && params.length < limit; i++) {
      var seg = segs[i];
      if (seg === "") continue;
      var eq = seg.indexOf("=");
      var rawK = eq >= 0 ? seg.slice(0, eq) : seg;
      var rawV = eq >= 0 ? seg.slice(eq + 1) : "";
      var dk = formDecode(rawK), dv = formDecode(rawV);
      if (dk.invalid || dv.invalid) invalid++;
      params.push({
        key: dk.value, value: dv.value,
        rawKey: rawK, rawValue: rawV,
        invalid: dk.invalid || dv.invalid,
      });
    }
    return {
      ok: true, base: sp.hasQuery ? sp.base : "", hash: sp.hash,
      params: params, count: params.length, invalid: invalid,
      truncated: segs.length > limit,
    };
  }

  /* ============================================================
   * v15.0 工具 15：文本大小写转换
   * ------------------------------------------------------------
   * 词元切分同时处理：空格/标点分隔、camelCase / PascalCase 边界、
   * 连续大写缩写、字母与数字边界，以及中文等 Unicode 字母。
   * ============================================================ */

  /**
   * 把任意文本切分为词元数组（保留原始大小写）。
   * @param {string} text 输入文本
   * @returns {string[]} 词元数组
   */
  function splitWords(text) {
    var s = String(text == null ? "" : text).trim();
    if (!s) return [];
    var normalized = s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2");
    return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  /**
   * 词元首字母大写、其余小写。
   * @param {string} w 词元
   * @returns {string} 首字母大写形式
   */
  function capitalize(w) {
    var s = String(w == null ? "" : w).toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * 文本大小写 / 命名风格转换。
   * @param {string} text 输入文本
   * @param {"upper"|"lower"|"title"|"camel"|"pascal"|"snake"|"kebab"} mode 目标形态
   * @returns {{ok: boolean, value?: string, words?: string[], mode?: string, error?: string}} 转换结果
   */
  function convertCase(text, mode) {
    var raw = String(text == null ? "" : text);
    var m = mode || "lower";
    var words = splitWords(raw);
    var value;
    switch (m) {
      case "upper": value = raw.toUpperCase(); break;
      case "lower": value = raw.toLowerCase(); break;
      case "title": value = words.map(capitalize).join(" "); break;
      case "camel": value = words.map(function (w, i) {
        return i === 0 ? w.toLowerCase() : capitalize(w);
      }).join(""); break;
      case "pascal": value = words.map(capitalize).join(""); break;
      case "snake": value = words.map(function (w) { return w.toLowerCase(); }).join("_"); break;
      case "kebab": value = words.map(function (w) { return w.toLowerCase(); }).join("-"); break;
      default: return { ok: false, error: "不支持的转换模式：" + m };
    }
    return { ok: true, value: value, words: words, mode: m };
  }

  /* ============================================================
   * v16.0 展示塑形层（Presenters）
   * ------------------------------------------------------------
   * 把「业务规则 → 展示数据」这一步从 components/toolbox.js 抽离：
   * 状态码分档、探测结果文案、IP 字段映射、Query 空值判定等规则
   * 全部下沉到本层，输出纯数据视图模型；UI 薄层只做一次 DOM 写入，
   * 不再持有任何业务判定。零 DOM / 零网络 / 零 console，
   * 主线程与 Worker 可安全复用，类型契约见 src/shared/types.js。
   * ============================================================ */

  /**
   * 按 HTTP 状态码分档返回状态色类名（与探测卡片着色规则一致）。
   * @param {number} code HTTP 状态码，0 或非法值归为 dim
   * @returns {string} CSS 类名（tb-ok / tb-redirect / tb-warn / tb-bad / tb-dim）
   */
  function httpStatusClass(code) {
    if (code >= C.HTTP_2XX && code < C.HTTP_3XX) return "tb-ok";
    if (code >= C.HTTP_3XX && code < C.HTTP_4XX) return "tb-redirect";
    if (code >= C.HTTP_4XX && code < C.HTTP_5XX) return "tb-warn";
    if (code >= C.HTTP_5XX) return "tb-bad";
    return "tb-dim";
  }

  /**
   * 状态码探测结果 → 展示视图模型（ProbeViewModel）。
   * @param {Object} d Worker 代理返回的数据，允许为空
   * @returns {Object} 纯数据视图模型，UI 层据此写 DOM
   */
  function probeViewModel(d) {
    var data = d || {};
    var code = data.httpStatus ? data.httpStatus : 0;
    var hs = data.headers || {};
    var isError = data.status === "error";
    return {
      badgeClass: httpStatusClass(code),
      codeText: code ? String(code) : "ERR",
      desc: data.statusText ? data.statusText : (data.error ? "探测失败" : "—"),
      latency: typeof data.elapsed === "number" ? data.elapsed + " ms" : "—",
      method: data.method || "—",
      target: data.url || "—",
      headers: Object.keys(hs).map(function (k) {
        return { key: k, value: hs[k] };
      }),
      noteClass: isError ? "tb-note-bad" : "",
      note: isError
        ? "✕ " + (data.error || "目标不可达") + "（" + (data.code || "NETWORK_ERROR") + "）"
        : data.note || "—",
    };
  }

  /**
   * IP 归属信息 → 展示视图模型（IpViewModel）。
   * @param {Object} d ipinfo 返回数据
   * @param {boolean} fallback 是否为本地缓存降级数据
   * @returns {Object} 纯数据视图模型
   */
  function ipViewModel(d, fallback) {
    var data = d || {};
    var unavailable = data.status === "unavailable";
    var loc = [data.country, data.region, data.city].filter(Boolean).join(" · ");
    var msg = unavailable
      ? "✕ " + (data.error || "上游暂不可用") +
        (data.attempts && data.attempts.length ? "：" + data.attempts.join("；") : "")
      : (fallback ? "⚠ 网络不稳定，展示的是本地缓存数据。" : "") + (data.message || "") +
        (data.scope === "visitor" ? "  · 数据来自访客真实公网 IP" : "  · 出口视角");
    return {
      query: data.query || "—",
      location: unavailable ? "—" : (loc || "—"),
      continent: data.continent || "—",
      isp: data.isp || "—",
      org: data.org || "—",
      asn: data.asn || "—",
      timezone: data.timezone || "—",
      source: (data.provider || "—") + " / " + (data.source || "—") + (data.cached ? " / 缓存" : ""),
      elapsed: typeof data.elapsed === "number" ? data.elapsed + " ms" : "—",
      noteClass: unavailable ? "tb-note-bad" : "",
      note: msg || "查询完成",
    };
  }

  /**
   * URL Query 参数 → 表格视图模型（QueryViewModel）。
   * @param {string} src 原始 URL 或纯查询串
   * @returns {Object} 含计数文案、空态标记与参数行的视图模型
   */
  function queryViewModel(src) {
    var q = parseQuery(src);
    return {
      countLabel: q.ok ? q.count + " 个参数" : "—",
      empty: !q.ok || !q.params.length,
      rows: (q.params || []).map(function (p) {
        return { key: p.key, value: p.value === "" ? "(空)" : p.value, invalid: !!p.invalid };
      }),
    };
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
    // 13 Cron
    parseCronField, cronExpressionToParts, buildCron, cronMatches, cronNext, cronDescribe,
    // 14 URL
    splitUrl, formEncode, formDecode, urlConvert, parseQuery,
    // 15 文本大小写
    splitWords, capitalize, convertCase,
    // v16.0 展示塑形层（业务规则下沉，UI 层只做 DOM 写入）
    httpStatusClass, probeViewModel, ipViewModel, queryViewModel,
  };

  root.ToolboxPure = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
