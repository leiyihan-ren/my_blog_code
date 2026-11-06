/* ============================================================
 * toolboxCompute.js —— 后台重计算主线程调度器（v14.0）
 * ------------------------------------------------------------
 * 模块一「重计算异步化」+「内存泄漏大排查」的调度中枢：
 *   · 单例 classic Worker 懒创建（首屏零成本），满足 worker-src 'self'。
 *   · 每次调用带唯一 id + 超时熔断（ToolboxConstants.WORKER_TIMEOUT_MS），
 *     灾难性正则 / 超大 Diff / 图片解码卡死都不会悬挂主线程。
 *   · Worker 不可用 / importScripts 失败 / 超时 / 抛错 → **自动降级**到
 *     ToolboxPure 主线程路径，结果结构完全一致，UI 无感。
 *   · Tab 切换调用 cancelAll() 取消在途调用；pagehide 调用 dispose()
 *     terminate Worker 并清空全部在途 Promise，杜绝悬挂回调。
 *
 * 对外 API：
 *   ToolboxCompute.supported()                       → boolean
 *   ToolboxCompute.exec(cmd, payload, fallback)     → Promise<result>
 *       result 附带 engine: "worker" | "main" | "cancelled"
 *   ToolboxCompute.cancelAll()                      → void
 *   ToolboxCompute.dispose()                        → void
 *   ToolboxCompute.state()                          → { workerAlive, pending, broken, seq }
 * ============================================================ */
window.ToolboxCompute = (function () {
  "use strict";

  var C = window.ToolboxConstants || {};
  var worker = null;
  var broken = false;
  var seq = 0;
  var waiting = Object.create(null);

  /** @returns {boolean} 当前是否可尝试启用后台计算 */
  function supported() { return typeof Worker !== "undefined" && !broken; }

  /**
   * 让所有在途调用以「已取消」正常结束，避免 Tab 切换后回调仍然渲染。
   * @returns {void}
   */
  function cancelAll() {
    Object.keys(waiting).forEach(function (id) {
      var w = waiting[id];
      clearTimeout(w.timer);
      delete waiting[id];
      w.resolve({ ok: false, cancelled: true, engine: "cancelled" });
    });
  }

  /**
   * Worker 级故障：终止线程、标记不可用、取消全部在途调用。
   * @param {Error|string} err 故障原因
   * @returns {void}
   */
  function failAll(err) {
    broken = true;
    // 故障信息只作为状态保留，不写 console（全站 console 清零要求）
    lastError = String((err && err.message) || err || "unknown");
    Object.keys(waiting).forEach(function (id) {
      var w = waiting[id];
      clearTimeout(w.timer);
      delete waiting[id];
      callFallback(w.fallback, new Error(lastError)).then(w.resolve, w.reject);
    });
    if (worker) {
      try { worker.terminate(); } catch (e) {}
    }
    worker = null;
  }

  var lastError = "";

  /**
   * 懒创建 Worker 并挂载消息路由。
   * @returns {Worker|null} 可用实例或 null
   */
  function ensure() {
    if (worker) return worker;
    if (broken || typeof Worker === "undefined") return null;
    try {
      worker = new Worker("/utils/toolbox-worker.js");
      worker.onmessage = function (e) {
        var m = e.data || {};
        var w = waiting[m.id];
        if (!w) return;
        clearTimeout(w.timer);
        delete waiting[m.id];
        if (m.ok === false) {
          // 计算层报错交由 fallback 兜底，保证 UI 永不白屏
          callFallback(w.fallback, new Error(m.error || "后台计算失败"))
            .then(w.resolve, w.reject);
          return;
        }
        w.resolve(m);
      };
      worker.onerror = function (e) {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        failAll((e && e.message) || "worker error");
      };
      worker.onmessageerror = function () { failAll("worker messageerror"); };
    } catch (e) {
      broken = true;
      worker = null;
      lastError = String((e && e.message) || e);
    }
    return worker;
  }

  /**
   * 执行主线程降级路径，并统一标记 engine。
   * @param {function():*} fallback 降级函数（可返回 Promise）
   * @param {Error} [err] 触发降级的原因
   * @returns {Promise<Object>} 结果
   */
  function callFallback(fallback, err) {
    return Promise.resolve().then(function () {
      if (typeof fallback !== "function") throw err || new Error("后台计算不可用且未提供降级路径");
      return fallback();
    }).then(function (res) {
      return Object.assign({ engine: "main" }, res || {});
    });
  }

  /**
   * 派发一次后台计算，失败自动降级。
   * @param {string} cmd 指令（regex / diff / image / ping）
   * @param {Object} payload 参数（不得含不可结构化克隆的对象）
   * @param {function():(Object|Promise<Object>)} fallback 主线程降级实现
   * @returns {Promise<Object>} 计算结果（含 engine 字段）
   */
  function exec(cmd, payload, fallback) {
    var w = ensure();
    if (!w) return callFallback(fallback, new Error(lastError || "Worker 不可用"));
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete waiting[id];
        callFallback(fallback, new Error("后台计算超时")).then(resolve, reject);
      }, C.WORKER_TIMEOUT_MS || 4000);
      waiting[id] = { resolve: resolve, reject: reject, timer: timer, fallback: fallback };
      try {
        // 不转移 ArrayBuffer：降级路径仍需读取同一份字节
        w.postMessage(Object.assign({ id: id, cmd: cmd }, payload || {}));
      } catch (e) {
        clearTimeout(timer);
        delete waiting[id];
        callFallback(fallback, e).then(resolve, reject);
      }
    });
  }

  /**
   * 页面卸载时彻底释放：取消在途调用 + 终止 Worker。
   * broken 保持 false，若从 bfcache 恢复可再次懒创建。
   * @returns {void}
   */
  function dispose() {
    cancelAll();
    if (worker) {
      try { worker.terminate(); } catch (e) {}
    }
    worker = null;
  }

  /**
   * 供测试与调试读取内部状态。
   * @returns {{workerAlive: boolean, pending: number, broken: boolean, seq: number, lastError: string}} 状态
   */
  function state() {
    return {
      workerAlive: !!worker,
      pending: Object.keys(waiting).length,
      broken: broken,
      seq: seq,
      lastError: lastError,
    };
  }

  return Object.freeze({
    supported: supported,
    exec: exec,
    cancelAll: cancelAll,
    dispose: dispose,
    state: state,
  });
})();
