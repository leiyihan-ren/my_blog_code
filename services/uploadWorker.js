/**
 * services/uploadWorker.js —— v11.0 战役二：Web Worker 分片器
 * ---------------------------------------------------------------
 * 职责：在**后台线程**把大文件切成 ArrayBuffer 分片，并计算 SHA-256
 * 校验和（端到端完整性），通过 transferable 零拷贝回传主线程。
 * 主线程只负责发网络请求，不再承担 8MB 切片的编码/哈希 CPU 开销，
 * 彻底消除「点了上传先卡一下」以及长列表滚动掉帧。
 *
 * 协议说明（诚实标注）：
 *   - 这里产出的是**裸 ArrayBuffer**，浏览器 → Worker 代理全程二进制，
 *     不做 Base64 膨胀（Base64 只存在于 Worker → GitHub API 的边界，
 *     因为 GitHub 的写端点只接受 JSON 文本，见 _worker.js 注释）。
 *   - 不使用 SharedArrayBuffer（需 COOP/COEP 跨源隔离头，会破坏现有
 *     外链图片/音乐加载）；transferable 已足够做到零拷贝。
 *
 * 消息协议：
 *   in : { cmd: "slice", file: File, index: number, start: number, end: number }
 *   out: { ok: true,  index, buffer: ArrayBuffer, sha256: string, bytes: number }
 *      | { ok: false, index, error: string }
 * ===============================================================
 */
"use strict";

/** 大文件分块转十六进制，避免 String.fromCharCode(...huge) 爆栈 */
function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function digest(buffer) {
  // crypto.subtle 在安全上下文的 Worker 中可用；不可用时降级为轻量校验和，
  // 完整性校验是增强项，绝不能因为环境差异阻断上传。
  if (globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.subtle.digest) {
    try {
      return toHex(await globalThis.crypto.subtle.digest("SHA-256", buffer));
    } catch (e) { /* 降级 */ }
  }
  const view = new Uint8Array(buffer);
  let a = 2166136261 >>> 0;
  for (let i = 0; i < view.length; i += 1) {
    a ^= view[i];
    a = Math.imul(a, 16777619) >>> 0;
  }
  return "fnv1a-" + a.toString(16);
}

self.onmessage = async function (event) {
  const msg = event.data || {};
  if (msg.cmd !== "slice") return;
  const { file, index, start, end } = msg;
  try {
    if (!file || typeof file.slice !== "function") throw new Error("无效的 File 对象");
    const blob = file.slice(start, end);
    const buffer = await blob.arrayBuffer();
    const sha256 = await digest(buffer);
    // buffer 作为 transferable 移交：主线程零拷贝拿到字节，Worker 侧随即失效
    self.postMessage({ ok: true, index, buffer, sha256, bytes: buffer.byteLength }, [buffer]);
  } catch (e) {
    self.postMessage({ ok: false, index, error: (e && e.message) || "分片读取失败" });
  }
};
