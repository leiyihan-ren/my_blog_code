/**
 * services/computeClient.js —— 后台计算内核的主线程客户端
 * ---------------------------------------------------------------
 * v12.0 战役二。对 services/computeWorker.js 的 Promise 化封装：
 *   - 单例 Worker，懒创建（首次调用才起线程，首屏零成本）
 *   - Blob 直接 structured clone 传入（底层字节引用式共享，不复制、不转 Base64）
 *   - 进度消息按 id 路由给对应调用方
 *   - 任何异常（Worker 不可用 / importScripts 失败 / 超时）都 reject，
 *     由调用方**自动回退到主线程路径**，绝不阻断打包下载
 *
 *   window.ComputeWorker.supported()
 *   window.ComputeWorker.hashBlob(blob, onProgress) -> { hash, bytes }
 *   window.ComputeWorker.zip(entries, onProgress)   -> { buffer, sums, bytes }
 *        entries: [{ name: "路径/文件名", blob: Blob }]
 *   window.ComputeWorker.sha256(arrayBuffer)        -> { hash }   （正确性对照）
 * ===============================================================
 */
window.ComputeWorker = (function () {
  "use strict";

  var worker = null;
  var seq = 0;
  var broken = false;
  var waiting = Object.create(null);
  var CALL_TIMEOUT = 120000; // 上百文件 + DEFLATE 允许较久，但仍需兜底防悬挂

  function supported() {
    return typeof Worker !== "undefined" && !broken;
  }

  function failAll(err) {
    broken = true;
    Object.keys(waiting).forEach(function (id) {
      var w = waiting[id];
      clearTimeout(w.timer);
      w.reject(err instanceof Error ? err : new Error(String(err)));
      delete waiting[id];
    });
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null;
  }

  function ensure() {
    if (worker) return worker;
    if (broken || typeof Worker === "undefined") return null;
    try {
      worker = new Worker("/services/computeWorker.js");
      worker.onmessage = function (e) {
        var m = e.data || {};
        var w = waiting[m.id];
        if (!w) return;
        if (m.type === "progress") {
          if (typeof w.onProgress === "function") {
            try { w.onProgress(m); } catch (err) { /* 进度回调异常不影响计算 */ }
          }
          return;
        }
        clearTimeout(w.timer);
        delete waiting[m.id];
        if (m.ok) w.resolve(m);
        else w.reject(new Error(m.error || "后台计算失败"));
      };
      worker.onerror = function (e) {
        failAll(new Error("计算 Worker 运行错误：" + ((e && e.message) || "未知")));
      };
    } catch (e) {
      broken = true;
      worker = null;
    }
    return worker;
  }

  function call(cmd, payload, onProgress) {
    var w = ensure();
    if (!w) return Promise.reject(new Error("计算 Worker 不可用"));
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete waiting[id];
        reject(new Error("后台计算超时：" + cmd));
      }, CALL_TIMEOUT);
      waiting[id] = { resolve: resolve, reject: reject, onProgress: onProgress, timer: timer };
      var msg = Object.assign({ id: id, cmd: cmd }, payload || {});
      try { w.postMessage(msg); }
      catch (e) {
        clearTimeout(timer);
        delete waiting[id];
        reject(e);
      }
    });
  }

  return {
    supported: supported,
    hashBlob: function (blob, onProgress) { return call("hash", { blob: blob }, onProgress); },
    zip: function (entries, onProgress) { return call("zip", { entries: entries, sums: true }, onProgress); },
    sha256: function (buffer) { return call("sha256", { buffer: buffer }); },
    ping: function () { return call("ping", {}); },
    isBroken: function () { return broken; },
    /** 仅供测试：强制重建 Worker（模拟 Worker 崩溃后的降级） */
    reset: function () {
      if (worker) { try { worker.terminate(); } catch (e) {} }
      worker = null; broken = false;
      Object.keys(waiting).forEach(function (id) { clearTimeout(waiting[id].timer); delete waiting[id]; });
    },
  };
})();
