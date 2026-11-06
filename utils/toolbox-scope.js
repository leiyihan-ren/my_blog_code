/* ============================================================
 * toolbox-scope.js —— 生命周期作用域注册表（v14.0）
 * ------------------------------------------------------------
 * 模块一「内存泄漏大排查」的统一基建：
 *   · 所有 addEventListener / setInterval / setTimeout / Worker /
 *     requestIdleCallback / requestAnimationFrame 必须经 Scope 登记。
 *   · Tab 切换时销毁对应 Scope；pagehide 时销毁根 Scope，
 *     彻底杜绝「工具切走了但定时器 / 监听 / Worker 回调还在跑」。
 *   · Scope 可嵌套（child），父级 dispose 会级联销毁子级。
 *   · dispose 幂等，重复调用无副作用；任一清理器抛错不影响其余清理。
 *
 * 兼容：浏览器 <script> → window.ToolboxScope；Node 静态校验可直接读源码。
 * ============================================================ */
(function (root) {
  "use strict";

  /**
   * 一个可整体销毁的资源作用域。
   * @param {string} [name] 作用域名称（便于调试与测试断言）
   * @constructor
   */
  function Scope(name) {
    this.name = name || "scope";
    this._disposers = [];
    this._dead = false;
  }

  /**
   * 登记任意清理函数。
   * @param {function():void} fn 清理器
   * @returns {function():void} 可单独调用的注销函数
   */
  Scope.prototype.add = function (fn) {
    var self = this;
    if (typeof fn !== "function") return function () {};
    if (this._dead) { try { fn(); } catch (e) {} return function () {}; }
    var alive = true;
    var off = function () {
      if (!alive) return;
      alive = false;
      try { fn(); } catch (e) {}
      var i = self._disposers.indexOf(off);
      if (i >= 0) self._disposers.splice(i, 1);
    };
    this._disposers.push(off);
    return off;
  };

  /**
   * 登记 DOM 事件监听。
   * @param {EventTarget} target 事件目标
   * @param {string} type 事件名
   * @param {function(Event):void} fn 处理函数
   * @param {Object|boolean} [opts] addEventListener 选项
   * @returns {function():void} 注销函数
   */
  Scope.prototype.on = function (target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== "function") return function () {};
    target.addEventListener(type, fn, opts);
    return this.add(function () { target.removeEventListener(type, fn, opts); });
  };

  /**
   * 登记周期定时器。
   * @param {function():void} fn 回调
   * @param {number} ms 间隔毫秒
   * @returns {number} 定时器 id
   */
  Scope.prototype.interval = function (fn, ms) {
    var id = setInterval(fn, ms);
    this.add(function () { clearInterval(id); });
    return id;
  };

  /**
   * 登记一次性定时器。
   * @param {function():void} fn 回调
   * @param {number} ms 延迟毫秒
   * @returns {number} 定时器 id
   */
  Scope.prototype.timeout = function (fn, ms) {
    var id = setTimeout(fn, ms);
    this.add(function () { clearTimeout(id); });
    return id;
  };

  /**
   * 在浏览器空闲期执行；不支持 requestIdleCallback 时降级为 setTimeout。
   * @param {function():void} fn 回调
   * @param {number} [timeoutMs] 兜底超时
   * @returns {function():void} 注销函数
   */
  Scope.prototype.idle = function (fn, timeoutMs) {
    var C = root.ToolboxConstants || {};
    var ms = timeoutMs || C.IDLE_TIMEOUT_MS || 400;
    if (typeof root.requestIdleCallback === "function") {
      var idleId = root.requestIdleCallback(fn, { timeout: ms });
      return this.add(function () {
        if (typeof root.cancelIdleCallback === "function") root.cancelIdleCallback(idleId);
      });
    }
    var t = setTimeout(fn, 0);
    return this.add(function () { clearTimeout(t); });
  };

  /**
   * 登记动画帧。
   * @param {function(number):void} fn 回调
   * @returns {function():void} 注销函数
   */
  Scope.prototype.raf = function (fn) {
    if (typeof root.requestAnimationFrame !== "function") return function () {};
    var id = root.requestAnimationFrame(fn);
    return this.add(function () {
      if (typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(id);
    });
  };

  /**
   * 登记 Worker，dispose 时 terminate。
   * @param {Worker} w Worker 实例
   * @returns {Worker} 原实例
   */
  Scope.prototype.worker = function (w) {
    this.add(function () { try { w.terminate(); } catch (e) {} });
    return w;
  };

  /**
   * 创建级联子作用域。
   * @param {string} [name] 子作用域名
   * @returns {Scope} 子作用域
   */
  Scope.prototype.child = function (name) {
    var s = new Scope(name);
    this.add(function () { s.dispose(); });
    return s;
  };

  /**
   * 是否已销毁。
   * @returns {boolean} 销毁状态
   */
  Scope.prototype.disposed = function () { return this._dead; };

  /**
   * 登记的资源数量（供测试断言）。
   * @returns {number} 资源数
   */
  Scope.prototype.size = function () { return this._disposers.length; };

  /**
   * 彻底销毁本作用域登记的全部资源（幂等）。
   * @returns {void}
   */
  Scope.prototype.dispose = function () {
    if (this._dead) return;
    this._dead = true;
    var list = this._disposers.slice().reverse();
    this._disposers.length = 0;
    list.forEach(function (off) { try { off(); } catch (e) {} });
  };

  root.ToolboxScope = Object.freeze({
    Scope: Scope,
    /**
     * 创建作用域。
     * @param {string} [name] 名称
     * @returns {Scope} 新作用域
     */
    create: function (name) { return new Scope(name); },
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
