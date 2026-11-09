/* ============================================================
 * render-scheduler.js —— v21.0 DOM 渲染拦截与分片挂载调度器
 * ------------------------------------------------------------
 * 解决的真实问题（v14 起计算已在 Worker，但主线程渲染仍是瓶颈）：
 *   · 正则 / Diff 的大结果在主线程逐节点 appendChild，几百 KB 长文本
 *     会生成成千上万个 span/div，每次都触发强制同步布局（Reflow）；
 *   · 输入防抖期间连续发起多次计算，旧结果乱序回写、重复全量重建 DOM。
 *
 * 三条纪律：
 *   ① 小结果（<= SYNC_LIMIT）走 **同步 DocumentFragment 一次挂载**：
 *      DOM 结构与原逐节点渲染逐字一致、零延迟，保证既有测试与首屏确定性；
 *   ② 超大结果按 **requestAnimationFrame 分片**：每帧只创建并挂载一批
 *      节点，用时间预算（8ms）把主线程让给绘制，保持 60fps 丝滑滚动；
 *   ③ 同一 key 的新任务 **抢占取消** 旧任务（含在途分片），杜绝旧结果
 *      回写覆盖新结果，配合 schedule() 的 rAF 节流合并连续触发。
 *
 * 零依赖：classic UMD（window / self / globalThis 三端），无 eval、
 * 无 console、无裸 fetch、无第三方库，满足严格 CSP 与 arch-audit。
 * 经 kit 依赖注入被 ESM 分片消费，不产生新的 window.* 全局引用边。
 *
 * 对外 API（window.RenderScheduler，冻结）：
 *   mount(host, items, makeNode, opts)  批量/分片挂载，返回 cancel 句柄
 *   schedule(key, fn)                   rAF 节流，同 key 只保留最后一次
 *   cancel(key) / cancelAll()           取消在途任务
 *   stats()                             只读诊断计数（供 step33 断言）
 * ============================================================ */
(function (root) {
  "use strict";

  /**
   * @typedef {Object} MountHandle 挂载句柄
   * @property {function():void} cancel 取消在途分片（同步挂载时为空操作）
   * @property {boolean} done 是否已全部挂载完成
   * @property {"empty"|"sync"|"chunked"} mode 实际采用的挂载模式
   * @property {number} total 本次数据项总数
   */
  /**
   * @typedef {Object} SchedulerStats 调度器诊断计数（冻结快照）
   * @property {number} syncMounts 同步 DocumentFragment 挂载次数
   * @property {number} chunkedMounts rAF 分片挂载次数
   * @property {number} frames 已执行的分片帧数
   * @property {number} nodes 累计创建节点数
   * @property {number} cancelled 被抢占/手动取消的任务数
   * @property {number} scheduled schedule() 发起次数
   * @property {number} merged 合并掉的重复触发次数
   * @property {number} pending 当前在途任务数
   * @property {number} syncLimit 同步挂载阈值
   * @property {number} frameBudgetMs 每帧时间预算
   */

  /** 节点数阈值：以下同步挂载（零 rAF、DOM 确定性），以上分片 */
  var SYNC_LIMIT = 160;
  /** 每帧主线程时间预算（ms），留出余量给浏览器绘制以稳定 60fps */
  var FRAME_BUDGET_MS = 8;
  /** 每帧最少处理条数，避免极端慢设备上分片退化成每帧 1 条 */
  var MIN_BATCH = 16;

  var jobs = Object.create(null);   // key → { gen, raf, cancelled }
  var genSeq = 0;
  var counters = { syncMounts: 0, chunkedMounts: 0, frames: 0, nodes: 0, cancelled: 0, scheduled: 0, merged: 0 };

  function hasRaf() { return typeof root.requestAnimationFrame === "function"; }
  function now() {
    try { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }

  /**
   * 取消某 key 的在途任务（分片 + 节流各一份）。
   * @param {string} key 任务标识
   * @returns {boolean} 是否存在并成功取消了在途任务
   */
  function cancel(key) {
    var j = jobs[key];
    if (!j) return false;
    j.cancelled = true;
    if (j.raf != null && typeof root.cancelAnimationFrame === "function") {
      try { root.cancelAnimationFrame(j.raf); } catch (e) {}
      j.raf = null;
    }
    delete jobs[key];
    counters.cancelled++;
    return true;
  }

  /**
   * 取消全部在途任务（Tab 切换 / 页面卸载时调用）。
   * @returns {void}
   */
  function cancelAll() {
    Object.keys(jobs).forEach(cancel);
  }

  /**
   * 批量 / 分片挂载。
   * @param {HTMLElement} host 容器（分片开始前清空一次）
   * @param {Array} items 数据项
   * @param {function(*, number):Node} makeNode 把数据项转成 DOM 节点（只在本帧调用，懒创建）
   * @param {{key?:string, syncLimit?:number, onDone?:function}} [opts]
   * @returns {MountHandle} 挂载句柄（可 cancel / 查询 done 与 mode）
   */
  function mount(host, items, makeNode, opts) {
    var o = opts || {};
    var list = Array.isArray(items) ? items : [];
    var limit = typeof o.syncLimit === "number" ? o.syncLimit : SYNC_LIMIT;
    var handle = { cancel: function () {}, done: false, mode: "empty", total: list.length };

    if (!host || typeof host.appendChild !== "function") return handle;
    if (o.key) cancel(o.key);

    // ---- 小结果：同步 DocumentFragment 一次挂载（零重排、零延迟）----
    if (list.length <= limit || !hasRaf()) {
      var frag = root.document.createDocumentFragment();
      for (var i = 0; i < list.length; i++) {
        var n = makeNode(list[i], i);
        if (n) frag.appendChild(n);
      }
      host.textContent = "";
      host.appendChild(frag);
      counters.syncMounts++;
      counters.nodes += list.length;
      handle.done = true;
      handle.mode = "sync";
      if (typeof o.onDone === "function") o.onDone();
      return handle;
    }

    // ---- 超大结果：rAF 分片，每帧按时间预算懒创建 + 批量挂载 ----
    var key = o.key || "__chunk_" + (++genSeq);
    var job = { gen: ++genSeq, raf: null, cancelled: false };
    jobs[key] = job;
    counters.chunkedMounts++;
    handle.mode = "chunked";
    handle.cancel = function () { if (!job.cancelled) cancel(key); };

    host.textContent = "";
    var cursor = 0;
    function frame() {
      if (job.cancelled) return;
      var t0 = now(), frag2 = root.document.createDocumentFragment(), count = 0;
      // 时间预算：一批至少 MIN_BATCH 条，超过 8ms 立即让出主线程
      while (cursor < list.length) {
        var node = makeNode(list[cursor], cursor);
        if (node) frag2.appendChild(node);
        cursor++;
        count++;
        if (count >= MIN_BATCH && now() - t0 >= FRAME_BUDGET_MS) break;
      }
      host.appendChild(frag2);
      counters.frames++;
      counters.nodes += count;
      if (cursor >= list.length) {
        delete jobs[key];
        handle.done = true;
        if (typeof o.onDone === "function") o.onDone();
        return;
      }
      job.raf = root.requestAnimationFrame(frame);
    }
    job.raf = root.requestAnimationFrame(frame);
    return handle;
  }

  /**
   * rAF 节流：同一 key 连续触发只保留最后一次，合并防抖期间的重复计算。
   * @param {string} key 任务标识
   * @param {function():void} fn 目标函数
   * @returns {void}
   */
  function schedule(key, fn) {
    var j = jobs[key];
    if (j && j.kind === "schedule" && j.raf != null) {
      // 已有在途帧：替换回调，不新增 rAF（合并）
      j.fn = fn;
      counters.merged++;
      return;
    }
    if (j) cancel(key);
    var job = { gen: ++genSeq, raf: null, cancelled: false, kind: "schedule", fn: fn };
    jobs[key] = job;
    counters.scheduled++;
    if (!hasRaf()) { delete jobs[key]; fn(); return; }
    job.raf = root.requestAnimationFrame(function () {
      if (job.cancelled) return;
      delete jobs[key];
      try { job.fn(); } catch (e) { /* 渲染异常局部隔离，不阻断调度器 */ }
    });
  }

  /**
   * 只读诊断计数（冻结快照，供 step33 断言与运维排障）。
   * @returns {SchedulerStats} 当前调度器统计快照
   */
  function stats() {
    var pending = Object.keys(jobs).length;
    return Object.freeze({
      syncMounts: counters.syncMounts, chunkedMounts: counters.chunkedMounts,
      frames: counters.frames, nodes: counters.nodes, cancelled: counters.cancelled,
      scheduled: counters.scheduled, merged: counters.merged, pending: pending,
      syncLimit: SYNC_LIMIT, frameBudgetMs: FRAME_BUDGET_MS,
    });
  }

  var API = Object.freeze({
    version: "21.0.0",
    mount: mount, schedule: schedule, cancel: cancel, cancelAll: cancelAll, stats: stats,
  });

  // 挂载到全局：classic <script> 为 window / Web Worker 为 self /
  // Node VM 为 globalThis。用显式 root.<Name> 赋值，使 arch-audit 的
  // DEF_RE 能识别该全局定义，依赖图如实反映 toolbox.js → 本文件这条
  // features→shared 的合法单向边（不引入任何反向分层或环）。
  if (root) root.RenderScheduler = API;
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
