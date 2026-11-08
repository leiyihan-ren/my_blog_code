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
 * v21.0 模块一-3「异步计算中心」强化：
 *   · exec() 新增可选第 4 参 slot：同一 slot 的新任务到达时，立即让在途
 *     旧任务以 { cancelled:true } 结束并从 waiting 摘除，杜绝长文本连续
 *     输入时旧结果乱序回写、重复触发主线程重渲染（60 帧的关键前提）。
 *   · 抢占只在显式传 slot 时启用；不传 slot 的既有调用行为逐字不变，
 *     cancelAll() / dispose() / state() 契约与 v14 完全一致（step27/28
 *     的 pending===0 等断言不受影响）。
 *   · 新增 stats() 暴露抢占计数，供 step33 验收。
 *
 * 对外 API：
 *   ToolboxCompute.supported()                          → boolean
 *   ToolboxCompute.exec(cmd, payload, fallback, slot)  → Promise<result>
 *       result 附带 engine: "worker" | "main" | "cancelled"
 *   ToolboxCompute.cancelAll()                         → void
 *   ToolboxCompute.dispose()                           → void
 *   ToolboxCompute.state()                             → { workerAlive, pending, broken, seq }
 *   ToolboxCompute.stats()                             → { superseded, ... }
 * ============================================================ */
window.ToolboxCompute = (function () {
  "use strict";

  var C = window.ToolboxConstants || {};
  var worker = null;
  var broken = false;
  var seq = 0;
  var waiting = Object.create(null);
  var slots = Object.create(null);   // v21: slot → 在途任务 id
  var superseded = 0;                // v21: 被抢占取消的任务计数

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
      if (w.slot && slots[w.slot] === id) delete slots[w.slot];
      w.resolve({ ok: false, cancelled: true, engine: "cancelled" });
    });
  }

  /**
   * v21.0：抢占同一 slot 的在途任务。长文本连续输入时，只让最新一次
   * 计算的结果回写 DOM，旧结果立即以 cancelled 结束，避免乱序重渲染。
   * @param {string} slot 任务槽位（如 "regex" / "diff"）
   * @returns {void}
   */
  function supersede(slot) {
    var oldId = slots[slot];
    if (oldId == null) return;
    var w = waiting[oldId];
    if (!w) { delete slots[slot]; return; }
    clearTimeout(w.timer);
    delete waiting[oldId];
    delete slots[slot];
    superseded++;
    w.resolve({ ok: false, cancelled: true, engine: "cancelled", superseded: true });
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
      if (w.slot && slots[w.slot] === id) delete slots[w.slot];
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
        if (w.slot && slots[w.slot] === m.id) delete slots[w.slot];
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
   * @param {string} cmd 指令（regex / diff / image / ping / highlight）
   * @param {Object} payload 参数（不得含不可结构化克隆的对象）
   * @param {function():(Object|Promise<Object>)} fallback 主线程降级实现
   * @param {string} [slot] v21 可选抢占槽位；同 slot 新任务会取消在途旧任务
   * @returns {Promise<Object>} 计算结果（含 engine 字段）
   */
  function exec(cmd, payload, fallback, slot) {
    if (slot) supersede(slot);
    var w = ensure();
    if (!w) return callFallback(fallback, new Error(lastError || "Worker 不可用"));
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete waiting[id];
        if (slot && slots[slot] === id) delete slots[slot];
        callFallback(fallback, new Error("后台计算超时")).then(resolve, reject);
      }, C.WORKER_TIMEOUT_MS || 4000);
      waiting[id] = { resolve: resolve, reject: reject, timer: timer, fallback: fallback, slot: slot || "" };
      if (slot) slots[slot] = id;
      try {
        // 不转移 ArrayBuffer：降级路径仍需读取同一份字节
        w.postMessage(Object.assign({ id: id, cmd: cmd }, payload || {}));
      } catch (e) {
        clearTimeout(timer);
        delete waiting[id];
        if (slot && slots[slot] === id) delete slots[slot];
        callFallback(fallback, e).then(resolve, reject);
      }
    });
  }

  /**
   * 页面卸载时彻底释放：取消在途调用 + 清空抢占槽位 + 终止 Worker。
   * broken 保持 false，若从 bfcache 恢复可再次懒创建。
   * @returns {void}
   */
  function dispose() {
    cancelAll();
    slots = Object.create(null);
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

  /**
   * v21.0：异步计算中心诊断计数，供 step33 验收抢占与降级链路。
   * @returns {{superseded: number, pending: number, slots: number, broken: boolean, seq: number}} 统计
   */
  function stats() {
    return Object.freeze({
      superseded: superseded,
      pending: Object.keys(waiting).length,
      slots: Object.keys(slots).length,
      broken: broken,
      seq: seq,
    });
  }

  return Object.freeze({
    supported: supported,
    exec: exec,
    cancelAll: cancelAll,
    dispose: dispose,
    state: state,
    stats: stats,
  });
})();
