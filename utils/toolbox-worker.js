/* ============================================================
 * toolbox-worker.js —— 极客工具箱后台重计算内核（v14.0）
 * ------------------------------------------------------------
 * 模块一「重计算异步化」落地：
 *   · 正则测试、行级 LCS Diff、图片缩放压缩 → 全部移出主线程。
 *   · classic Worker（非 blob / 非 data），满足 CSP worker-src 'self'。
 *   · importScripts 复用 utils/toolbox-constants.js 与 toolbox-pure.js，
 *     保证主线程与 Worker 的算法实现逐字一致，不存在两套逻辑漂移。
 *   · 主线程 services/toolboxCompute.js 负责超时熔断与降级；本文件
 *     只做纯计算，绝不持有任何 UI 状态。
 *
 * 消息协议：
 *   in : { id, cmd:"ping" }
 *      | { id, cmd:"regex", pattern, flags, text }
 *      | { id, cmd:"diff",  a, b }
 *      | { id, cmd:"image", buffer:ArrayBuffer, type, maxEdge, quality }
 *   out: { id, ok:true, ... } | { id, ok:false, error }
 * ============================================================ */
"use strict";

importScripts("/utils/toolbox-constants.js", "/utils/toolbox-pure.js");

var P = self.ToolboxPure;
var C = self.ToolboxConstants;

/**
 * 依据输入 MIME 选择输出编码格式。
 * PNG / WebP 保留原格式（PNG 需保留透明通道）；其余统一 JPEG 以获得压缩率。
 * @param {string} inputType 输入文件 MIME
 * @returns {string} 输出 MIME
 */
function pickMime(inputType) {
  var t = String(inputType || "").toLowerCase();
  if (t === "image/png") return "image/png";
  if (t === "image/webp") return "image/webp";
  return "image/jpeg";
}

/**
 * 图片等比压缩并转 Base64 Data URL（全程在 Worker 内，主线程零阻塞）。
 * @param {{buffer: ArrayBuffer, type: string, maxEdge: number, quality: number}} m 任务参数
 * @returns {Promise<{dataUrl: string, base64: string, mime: string,
 *                    width: number, height: number, bytes: number,
 *                    sourceWidth: number, sourceHeight: number}>} 结果
 */
async function handleImage(m) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new Error("当前环境不支持 Worker 内图像解码");
  }
  var blob = new Blob([m.buffer], { type: m.type || "image/png" });
  var bmp = await createImageBitmap(blob);
  var sourceWidth = bmp.width, sourceHeight = bmp.height;
  var dim = P.fitDimensions(sourceWidth, sourceHeight, m.maxEdge || C.IMG_DEFAULT_MAX_EDGE);
  var canvas = new OffscreenCanvas(dim.w, dim.h);
  var ctx = canvas.getContext("2d");
  if (!ctx) { bmp.close(); throw new Error("无法创建 OffscreenCanvas 2D 上下文"); }
  ctx.drawImage(bmp, 0, 0, dim.w, dim.h);
  bmp.close();
  var mime = pickMime(m.type);
  var outBlob = await canvas.convertToBlob({ type: mime, quality: m.quality });
  var buf = await outBlob.arrayBuffer();
  var b64 = P.bytesToBase64(new Uint8Array(buf));
  return {
    dataUrl: "data:" + mime + ";base64," + b64,
    base64: b64,
    mime: mime,
    width: dim.w,
    height: dim.h,
    bytes: buf.byteLength,
    sourceWidth: sourceWidth,
    sourceHeight: sourceHeight,
  };
}

/**
 * 分发单条任务。
 * @param {Object} m 消息体
 * @returns {Object|Promise<Object>} 计算结果
 */
function handle(m) {
  switch (m.cmd) {
    case "ping":
      return { pong: true, version: C.VERSION, engine: "worker" };
    case "regex": {
      if (!P) throw new Error("纯函数内核未加载");
      var r = P.runRegex(m.pattern, m.flags, m.text);
      return {
        ok: r.ok, error: r.error || "", matches: r.matches, count: r.count,
        truncated: r.truncated, hasGroups: r.hasGroups,
        segments: r.ok ? P.regexSegments(m.text, r.matches) : [],
      };
    }
    case "diff": {
      if (!P) throw new Error("纯函数内核未加载");
      var d = P.diffLines(m.a, m.b);
      return { ops: d.ops, stats: d.stats, truncated: d.truncated };
    }
    case "image":
      return handleImage(m);
    default:
      throw new Error("未知指令：" + String(m.cmd));
  }
}

self.onmessage = function (e) {
  var m = e.data || {};
  var id = m.id;
  Promise.resolve()
    .then(function () { return handle(m); })
    .then(function (res) {
      var out = Object.assign({ id: id, ok: true, engine: "worker" }, res);
      self.postMessage(out);
    })
    .catch(function (err) {
      self.postMessage({ id: id, ok: false, engine: "worker", error: String((err && err.message) || err) });
    });
};
