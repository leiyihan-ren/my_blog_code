/* ============================================================
 * src/shared/event-bus.js —— 极简原生发布订阅（规范实现 / 架构契约层）
 * ------------------------------------------------------------
 * 分层归属：src/shared/（依赖图叶子层，零依赖、零副作用）。
 *
 * 本文件是架构契约层的「规范实现」，纯 ESM、可在 Node / 浏览器 /
 * Worker 三端运行；不进生产产物（scripts/build-pages.mjs 已排除 src/）。
 * 生产运行时版本是 utils/event-bus.js（classic UMD，挂 globalThis.EventBus），
 * 两者算法同源，由 tests/step29-v17-toolbox.mjs 做行为等价性断言。
 *
 * 设计目标：让各独立模块通过事件通信，切断「模块 A 直接持有模块 B
 * 的函数引用」这种编译期耦合。发布者只知道事件名与载荷，不知道谁在
 * 监听；订阅者也不必知道事件由谁发出。通知中心（components/ui.js）
 * 订阅 ui:toast，工具箱与加载编排只负责 emit，互不 import。
 *
 * 语义保证：
 *   1) 快照遍历：emit 期间新增 / 移除订阅不影响本轮派发；
 *   2) 错误隔离：单个订阅者抛错不中断其余订阅者，也不冒泡到发布者；
 *   3) once 只触发一次，触发后自动摘除；
 *   4) on 返回 unsubscribe，便于登记进 ToolboxScope 生命周期。
 * ============================================================ */

/**
 * 事件订阅者。
 * @callback EventHandler
 * @param {*} payload 事件载荷（约定为普通对象）
 * @returns {void}
 */

/**
 * 事件总线句柄。
 * @typedef {Object} EventBusInstance
 * @property {(type:string, fn:EventHandler)=>function():void} on 订阅，返回取消订阅函数
 * @property {(type:string, fn:EventHandler)=>function():void} once 单次订阅
 * @property {(type:string, fn?:EventHandler)=>void} off 退订（省略 fn 清空该频道）
 * @property {(type:string, payload?:*)=>number} emit 发布，返回实际通知到的订阅者数
 * @property {(type?:string)=>void} clear 清空（省略 type 清空全部）
 * @property {(type:string)=>number} listenerCount 频道订阅者数（诊断用）
 * @property {()=>unknown} lastError 最近一次订阅者异常（诊断用，绝不打印控制台）
 */

/**
 * 创建一个独立的事件总线实例。
 * 工厂而非纯单例：测试与隔离场景可持有互不影响的总线；生产环境
 * 由 utils/event-bus.js 额外暴露一个共享单例。
 * @returns {EventBusInstance} 冻结的总线句柄
 */
export function createEventBus() {
  /** @type {Map<string, Array<{fn:EventHandler, once:boolean}>>} */
  const channels = new Map();
  /** @type {unknown} */
  let lastError = null;

  /** @param {string} type @returns {Array<{fn:EventHandler, once:boolean}>} */
  function channel(type) {
    let list = channels.get(type);
    if (!list) { list = []; channels.set(type, list); }
    return list;
  }

  /**
   * @param {string} type 事件名
   * @param {EventHandler} fn 订阅者
   * @param {boolean} once 是否单次
   * @returns {function():void} 取消订阅
   */
  function subscribe(type, fn, once) {
    if (typeof type !== "string" || !type || typeof fn !== "function") {
      return function noop() {};
    }
    const entry = { fn: fn, once: !!once };
    channel(type).push(entry);
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      const list = channels.get(type);
      if (!list) return;
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) channels.delete(type);
    };
  }

  /** @param {string} type @param {EventHandler} fn @returns {function():void} */
  function on(type, fn) { return subscribe(type, fn, false); }

  /** @param {string} type @param {EventHandler} fn @returns {function():void} */
  function once(type, fn) { return subscribe(type, fn, true); }

  /**
   * @param {string} type 事件名
   * @param {EventHandler} [fn] 省略则清空整个频道
   * @returns {void}
   */
  function off(type, fn) {
    if (typeof type !== "string" || !type) return;
    if (typeof fn !== "function") { channels.delete(type); return; }
    const list = channels.get(type);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) list.splice(i, 1);
    if (!list.length) channels.delete(type);
  }

  /**
   * 发布事件。先取快照，保证派发期间的订阅变更不影响本轮。
   * @param {string} type 事件名
   * @param {*} [payload] 事件载荷
   * @returns {number} 实际调用到的订阅者数量
   */
  function emit(type, payload) {
    if (typeof type !== "string" || !type) return 0;
    const snapshot = (channels.get(type) || []).slice();
    let delivered = 0;
    for (const entry of snapshot) {
      if (entry.once) off(type, entry.fn);
      try {
        // 与 classic UMD 实现同源：先计数再调用，投递数含「已调用但抛错」的订阅者。
        delivered++;
        entry.fn(payload);
      } catch (e) {
        // 错误隔离：一个订阅者出错不影响其余订阅者，也不冒泡到发布者。
        lastError = e;
      }
    }
    return delivered;
  }

  /** @param {string} [type] @returns {void} */
  function clear(type) {
    if (typeof type === "string" && type) channels.delete(type);
    else channels.clear();
  }

  /** @param {string} type @returns {number} */
  function listenerCount(type) { return (channels.get(type) || []).length; }

  return Object.freeze({
    on: on, once: once, off: off, emit: emit, clear: clear,
    listenerCount: listenerCount,
    lastError: function () { return lastError; },
  });
}

/** 规范层的默认共享实例（便于 Node 侧直接消费） */
export const EventBus = createEventBus();
