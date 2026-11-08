/* ============================================================
 * utils/event-bus.js —— 全局事件总线（生产运行时 / classic UMD）
 * ------------------------------------------------------------
 * v17.0 模块二：让各独立模块通过 Pub/Sub 通信，切断跨模块的直接
 * 函数引用（例如业务模块不再持有 window.UI.toast 的引用）。
 *
 * 形态说明：本站是纯 classic <script> 的 MPA（零框架、零打包），
 * 因此这里是零依赖的 UMD 风格全局挂载，与 utils/toolbox-*.js
 * 的三端兼容写法一致：浏览器 / Worker / Node VM 均可直接执行。
 * 规范实现见 src/shared/event-bus.js（ESM，架构契约层，不进产物），
 * 两者算法同源，由 tests/step29-v17-toolbox.mjs 断言行为等价。
 *
 * 用法：
 *   // 通知中心（订阅方，components/ui.js）
 *   window.EventBus.on("ui:toast", function (p) { UI.toast(p.message, p.type); });
 *   // 任意业务模块（发布方，不 import 任何模块）
 *   window.EventBus.emit("ui:toast", { message: "已复制", type: "success" });
 *   // 生命周期：把 on 返回的 unsubscribe 登记进 ToolboxScope
 *   scope.add(window.EventBus.on("toolbox:modules:ready", handler));
 *
 * 语义保证：快照遍历 / 错误隔离 / once 自动摘除 / on 返回退订函数。
 * 严格 CSP：无 eval、无内联脚本、无第三方请求、零 console 输出。
 * ============================================================ */
(function (root) {
  "use strict";

  /**
   * 创建独立总线实例。
   * @returns {Object} 冻结的总线句柄
   */
  function createEventBus() {
    /** @type {Object<string, Array<{fn:Function, once:boolean}>>} */
    var channels = Object.create(null);
    var lastError = null;

    /** @param {string} type @returns {Array} 频道（惰性创建） */
    function channel(type) {
      if (!channels[type]) channels[type] = [];
      return channels[type];
    }

    /**
     * @param {string} type 事件名
     * @param {Function} fn 订阅者
     * @param {boolean} once 是否单次
     * @returns {Function} 取消订阅
     */
    function subscribe(type, fn, once) {
      if (typeof type !== "string" || !type || typeof fn !== "function") return function () {};
      var entry = { fn: fn, once: !!once };
      channel(type).push(entry);
      var active = true;
      return function unsubscribe() {
        if (!active) return;
        active = false;
        var list = channels[type];
        if (!list) return;
        var i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) delete channels[type];
      };
    }

    /**
     * @param {string} type 事件名
     * @param {Function} [fn] 省略则清空该频道
     * @returns {void}
     */
    function off(type, fn) {
      if (typeof type !== "string" || !type) return;
      if (typeof fn !== "function") { delete channels[type]; return; }
      var list = channels[type];
      if (!list) return;
      for (var i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) list.splice(i, 1);
      if (!list.length) delete channels[type];
    }

    /**
     * 发布事件（快照遍历）。
     * @param {string} type 事件名
     * @param {*} [payload] 事件载荷
     * @returns {number} 实际通知到的订阅者数
     */
    function emit(type, payload) {
      if (typeof type !== "string" || !type) return 0;
      var snapshot = (channels[type] || []).slice();
      var delivered = 0;
      for (var i = 0; i < snapshot.length; i++) {
        var entry = snapshot[i];
        if (entry.once) off(type, entry.fn);
        try {
          // 先计数再调用：投递数应包含「已调用但自身抛错」的订阅者。
          // 错误隔离不改变投递事实，否则返回值会低估本轮真实派发规模。
          delivered++;
          entry.fn(payload);
        } catch (e) {
          // 错误隔离：单个订阅者异常既不中断其余订阅者，也不冒泡到发布者。
          lastError = e;
        }
      }
      return delivered;
    }

    /** @param {string} [type] @returns {void} */
    function clear(type) {
      if (typeof type === "string" && type) { delete channels[type]; return; }
      channels = Object.create(null);
    }

    return Object.freeze({
      /** @param {string} type @param {Function} fn @returns {Function} 退订函数 */
      on: function (type, fn) { return subscribe(type, fn, false); },
      /** @param {string} type @param {Function} fn @returns {Function} 退订函数 */
      once: function (type, fn) { return subscribe(type, fn, true); },
      off: off,
      emit: emit,
      clear: clear,
      /** @param {string} type @returns {number} 频道订阅者数 */
      listenerCount: function (type) { return (channels[type] || []).length; },
      /** @returns {*} 最近一次订阅者异常（诊断用，绝不打印控制台） */
      lastError: function () { return lastError; },
    });
  }

  // 共享单例：全站所有模块默认复用它；create 供测试 / 隔离场景使用。
  var shared = createEventBus();
  var api = Object.freeze({
    on: shared.on, once: shared.once, off: shared.off, emit: shared.emit,
    clear: shared.clear, listenerCount: shared.listenerCount,
    lastError: shared.lastError,
    /** @returns {Object} 独立总线实例 */
    create: createEventBus,
  });

  root.EventBus = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
