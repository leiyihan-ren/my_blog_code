/**
 * services/computeWorker.js —— v12.0 战役二：后台计算内核
 * ---------------------------------------------------------------
 * 把两类 CPU 密集任务彻底移出主线程：
 *   1) 大文件 SHA-256 完整性校验 —— 标准 FIPS 180-4 **增量**实现，
 *      按 1MB 分块读取 Blob，内存占用恒定 O(1MB)，几百 MB 文件也不 OOM。
 *      （Web Crypto 的 subtle.digest 不接受流，一次性读整文件会打爆内存，
 *       因此这里自带增量压缩函数，并用 subtle.digest 做正确性对照。）
 *   2) JSZip 打包 —— importScripts 本地 vendor 后，在 Worker 内完成
 *      Blob→ArrayBuffer、压缩、生成 zip；进度回传主线程只更新一行文字，
 *      主线程的 rAF 不再被 DEFLATE 压缩长任务阻塞。
 *
 * 额外产出：zip 内自动写入 SHA256SUMS.txt（每个文件的标准 SHA-256），
 * 让「哈希校验」不只是性能测试，而是真实可用的完整性凭证。
 *
 * 消息协议（classic worker，script-src 'self' / worker-src 'self' 均放行同源）：
 *   in : { id, cmd:"ping" }
 *      | { id, cmd:"hash", blob: Blob }
 *      | { id, cmd:"sha256", buffer: ArrayBuffer }         （正确性对照用）
 *      | { id, cmd:"zip", entries:[{name, blob}], sums?:boolean }
 *   out: { id, type:"progress", phase, done, total, percent }
 *      | { id, ok:true, ... }  | { id, ok:false, error }
 *   zip 成功回传 { ok:true, buffer: ArrayBuffer, sums:[...], bytes }，
 *   buffer 走 transferable 零拷贝移交主线程。
 * ===============================================================
 */
"use strict";

/* ---------------- 标准 SHA-256（增量，FIPS 180-4） ---------------- */
var K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function compress(h, block) {
  var w = new Uint32Array(64);
  var i, s0, s1, t1, t2, ch, maj, S0, S1;
  for (i = 0; i < 16; i += 1) {
    w[i] = ((block[i * 4] << 24) | (block[i * 4 + 1] << 16) |
            (block[i * 4 + 2] << 8) | block[i * 4 + 3]) | 0;
  }
  for (i = 16; i < 64; i += 1) {
    s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (i = 0; i < 64; i += 1) {
    S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    ch = (e & f) ^ (~e & g);
    t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
    S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    maj = (a & b) ^ (a & c) ^ (b & c);
    t2 = (S0 + maj) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
  h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
  h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
}

function Sha256() {
  this.h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  this.buf = new Uint8Array(64);
  this.bufLen = 0;
  this.total = 0;
}
Sha256.prototype.update = function (bytes) {
  var p = 0;
  this.total += bytes.length;
  if (this.bufLen > 0) {
    while (this.bufLen < 64 && p < bytes.length) this.buf[this.bufLen++] = bytes[p++];
    if (this.bufLen === 64) { compress(this.h, this.buf); this.bufLen = 0; }
  }
  while (p + 64 <= bytes.length) {
    compress(this.h, bytes.subarray(p, p + 64));
    p += 64;
  }
  while (p < bytes.length) this.buf[this.bufLen++] = bytes[p++];
  return this;
};
Sha256.prototype.hex = function () {
  // bitLen = total * 8，用高低 32 位分别写入，兼容 >512MB 的文件
  var hi = Math.floor(this.total / 0x20000000);
  var lo = (this.total * 8) >>> 0;
  var padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
  var pad = new Uint8Array(padLen + 8);
  pad[0] = 0x80;
  var dv = new DataView(pad.buffer);
  dv.setUint32(padLen, hi, false);
  dv.setUint32(padLen + 4, lo, false);
  this.update(pad);
  var out = new Uint8Array(32);
  var ov = new DataView(out.buffer);
  for (var i = 0; i < 8; i += 1) ov.setUint32(i * 4, this.h[i], false);
  var s = "";
  for (i = 0; i < 32; i += 1) s += out[i].toString(16).padStart(2, "0");
  return s;
};

/** 分块流式哈希：Blob 可 structured clone 传入，无需在主线程读成 ArrayBuffer */
async function hashBlob(blob, onChunk) {
  var CHUNK = 1024 * 1024;
  var h = new Sha256();
  var size = blob.size || 0;
  for (var off = 0; off < size; off += CHUNK) {
    var part = blob.slice(off, Math.min(off + CHUNK, size));
    var buf = await part.arrayBuffer();
    h.update(new Uint8Array(buf));
    if (onChunk) onChunk(Math.min(off + CHUNK, size), size);
  }
  if (size === 0) h.update(new Uint8Array(0));
  return h.hex();
}

// 暴露给测试做「增量实现 vs crypto.subtle」正确性对照
self.__sha256 = function (buffer) {
  return new Sha256().update(new Uint8Array(buffer)).hex();
};

/* ---------------- JSZip（本地 vendor，Worker 内 importScripts） ---------------- */
var jszipLoaded = false;
function ensureJSZip() {
  if (jszipLoaded || typeof JSZip !== "undefined") { jszipLoaded = true; return; }
  // 严格 CSP 下不用 CDN；同源静态脚本由 worker-src 'self' 放行
  importScripts("/vendor/jszip.min.js");
  jszipLoaded = true;
  if (typeof JSZip === "undefined") throw new Error("JSZip 加载失败");
}

function post(msg, transfer) {
  if (transfer && transfer.length) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

self.onmessage = async function (event) {
  var m = event.data || {};
  var id = m.id;
  try {
    if (m.cmd === "ping") return post({ id: id, ok: true, pong: true });

    if (m.cmd === "sha256") {
      return post({ id: id, ok: true, hash: self.__sha256(m.buffer) });
    }

    if (m.cmd === "hash") {
      if (!m.blob || typeof m.blob.slice !== "function") throw new Error("无效的 Blob");
      var hash = await hashBlob(m.blob, function (done, total) {
        post({ id: id, type: "progress", phase: "hash", done: done, total: total,
          percent: total ? (done / total) * 100 : 100 });
      });
      return post({ id: id, ok: true, hash: hash, bytes: m.blob.size || 0 });
    }

    if (m.cmd === "zip") {
      ensureJSZip();
      var entries = Array.isArray(m.entries) ? m.entries : [];
      if (!entries.length) throw new Error("没有需要打包的文件");
      var zip = new JSZip();
      var sums = [];
      for (var i = 0; i < entries.length; i += 1) {
        var en = entries[i];
        var name = String(en.name || ("file-" + (i + 1))).replace(/^\/+/, "");
        var blob = en.blob;
        if (!blob || typeof blob.arrayBuffer !== "function") throw new Error("无效条目: " + name);
        var buf = await blob.arrayBuffer();
        // 一次读取同时完成「入库」与「标准 SHA-256 校验」，不重复 IO
        var digest = new Sha256().update(new Uint8Array(buf)).hex();
        zip.file(name, buf, { binary: true });
        sums.push(digest + "  " + name);
        post({ id: id, type: "progress", phase: "hash", done: i + 1, total: entries.length,
          percent: ((i + 1) / entries.length) * 100 });
      }
      if (m.sums !== false) zip.file("SHA256SUMS.txt", sums.join("\n") + "\n");
      var out = await zip.generateAsync(
        { type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } },
        function (meta) {
          post({ id: id, type: "progress", phase: "zip", percent: meta.percent,
            done: entries.length, total: entries.length });
        }
      );
      return post({ id: id, ok: true, buffer: out, sums: sums, bytes: out.byteLength }, [out]);
    }

    return post({ id: id, ok: false, error: "未知命令: " + m.cmd });
  } catch (e) {
    post({ id: id, ok: false, error: (e && e.message) || String(e) });
  }
};
