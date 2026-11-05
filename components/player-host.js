/**
 * player-host.js —— 全局播放内核的宿主侧客户端
 * ---------------------------------------------------------------
 * v12.0 战役一。两种宿主形态，同一套 postMessage 协议：
 *
 *   mount({ mode: "window" })  独立窗口（默认）。窗口拥有自己的文档与 <audio>，
 *      主页面 MPA 整页导航时**窗口不销毁**，这是本架构下真正「切页不断播」的形态。
 *      新页面调用 reconnect() 会用 window.open("", 同名) 重新拿到窗口引用并接管
 *      控制，全程不重载内核、不打断音频。
 *   mount({ mode: "iframe" })  隐藏 iframe。把音频从主文档解耦，页面内局部更新/
 *      主题切换/动态模块加载不打断播放；父文档整页导航时 iframe 仍会随之卸载。
 *      （需要 CSP 放行同源嵌入；不允许时自动回退到独立窗口。）
 *
 * 安全：只接受同源、带 __mpHost_v12 标记、且来源恰为宿主窗口的消息；
 *      下发命令一律指定 targetOrigin = location.origin。
 * 降级：能力探测失败 / 弹窗被拦截 / 内核 6s 无响应 → reject，调用方保留原播放器。
 *
 *   window.PlayerHost.mount(opts)      -> Promise<handle>
 *   window.PlayerHost.reconnect()      -> Promise<handle|null>  （静默接管，不新开窗）
 *   window.PlayerHost.current()        -> handle|null
 */
window.PlayerHost = (function () {
  "use strict";

  var TAG = "__mpHost_v12";
  var ORIGIN = location.origin;
  var PLAYER_URL = "/player.html";
  var WIN_NAME = "mp_global_v12";
  var READY_TIMEOUT = 6000;
  var CALL_TIMEOUT = 5000;

  var instance = null;
  var seq = 0;

  function supported() {
    try {
      return typeof window !== "undefined" && typeof window.postMessage === "function" &&
        typeof window.addEventListener === "function" && !!document.createElement;
    } catch (e) { return false; }
  }

  function create(mode, reuseOnly) {
    mode = mode === "iframe" ? "iframe" : "window";
    return new Promise(function (resolve, reject) {
      if (!supported()) return reject(new Error("当前环境不支持 postMessage"));
      if (instance && !instance.dead) return resolve(instance);

      var target = null, iframe = null, popup = null;
      var waiting = Object.create(null);
      var listeners = Object.create(null);
      var settled = false;
      var dead = false;
      var reused = false;
      var readyTimer = null;
      var probeTimer = null;

      function cleanupTimers() {
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
      }
      function fail(err) {
        if (settled) return;
        settled = true; dead = true; cleanupTimers();
        window.removeEventListener("message", onMessage);
        if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      function succeed(handle) {
        if (settled) return;
        settled = true; cleanupTimers();
        resolve(handle);
      }

      function dispatch(ev, state, raw) {
        var list = listeners[ev];
        if (list) list.slice().forEach(function (fn) {
          try { fn(state, raw); } catch (e) { /* 单个订阅者异常不影响其它 */ }
        });
        if (ev !== "*") dispatch("*", state, raw);
      }

      function onMessage(e) {
        if (e.origin !== ORIGIN || !e.source || e.source !== target) return;
        var m = e.data;
        if (!m || m.__mp !== TAG || m.dir !== "engine") return;
        if (m.type === "ready") {
          if (m.mode) handle.mode = m.mode;
          succeed(handle);
          return;
        }
        if (m.type === "ack") {
          if (m.id === 0 && m.ok && reused) succeed(handle); // 复用窗口的探活回包
          var cb = waiting[m.id];
          if (cb) { delete waiting[m.id]; cb(m.ok, m.result, m.error); }
          return;
        }
        if (m.type === "event") dispatch(m.ev, m.state, m);
        if (m.type === "state") dispatch("state", m.state, m);
      }

      function call(cmd, args, timeout) {
        if (dead) return Promise.reject(new Error("播放内核已关闭"));
        return new Promise(function (res, rej) {
          var id = ++seq;
          var timer = setTimeout(function () {
            delete waiting[id];
            rej(new Error("播放内核响应超时: " + cmd));
          }, timeout || CALL_TIMEOUT);
          waiting[id] = function (ok, result, err) {
            clearTimeout(timer);
            if (ok) res(result);
            else rej(new Error(err || cmd + " 失败"));
          };
          try { target.postMessage({ __mp: TAG, dir: "host", id: id, cmd: cmd, args: args || {} }, ORIGIN); }
          catch (e) { clearTimeout(timer); delete waiting[id]; rej(e); }
        });
      }

      var handle = {
        mode: mode,
        dead: false,
        get target() { return target; },
        isAlive: function () { return !dead; },
        getState: function () { return call("getState"); },
        setPlaylist: function (list) { return call("setPlaylist", { playlist: list || [] }); },
        load: function (i, autoplay, t) { return call("load", { idx: i || 0, autoplay: !!autoplay, t: t || 0 }); },
        play: function () { return call("play"); },
        pause: function () { return call("pause"); },
        next: function () { return call("next"); },
        prev: function () { return call("prev"); },
        seek: function (t) { return call("seek", { t: t }); },
        volume: function (v) { return call("volume", { v: v }); },
        mute: function (on) { return call("mute", { on: on }); },
        rate: function (r) { return call("rate", { r: r }); },
        focus: function () { return call("focus"); },
        on: function (ev, fn) {
          if (typeof fn !== "function") return function () {};
          (listeners[ev] || (listeners[ev] = [])).push(fn);
          return function () { handle.off(ev, fn); };
        },
        off: function (ev, fn) {
          var l = listeners[ev];
          if (!l) return;
          var i = l.indexOf(fn);
          if (i >= 0) l.splice(i, 1);
        },
        // 仅移除宿主侧的桥与 iframe；独立窗口不自动关闭（音频继续播放）
        detach: function () {
          dead = true; handle.dead = true; cleanupTimers();
          window.removeEventListener("message", onMessage);
          if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
          if (instance === handle) instance = null;
        },
        close: function () {
          handle.detach();
          if (popup) { try { popup.close(); } catch (e) {} }
        },
      };

      window.addEventListener("message", onMessage);
      readyTimer = setTimeout(function () { fail(new Error("播放内核启动超时")); }, READY_TIMEOUT);

      if (mode === "iframe") {
        iframe = document.createElement("iframe");
        iframe.src = PLAYER_URL + "?embed=1";
        iframe.title = "全局播放内核";
        iframe.setAttribute("aria-hidden", "true");
        iframe.tabIndex = -1;
        iframe.setAttribute("allow", "autoplay");
        iframe.style.cssText = "position:absolute;width:0;height:0;border:0;opacity:0;" +
          "pointer-events:none;left:-9999px;top:0;";
        var mountPoint = document.body || document.documentElement;
        iframe.addEventListener("load", function () {
          if (!iframe.contentWindow) fail(new Error("隐藏 iframe 被 CSP 拒绝"));
        });
        mountPoint.appendChild(iframe);
        target = iframe.contentWindow;
      } else {
        // 先按名字取已有窗口：已存在时 window.open("", name) 返回引用且不导航，
        // 这正是「切页后重新接管、不打断播放」的关键。
        try { popup = window.open("", WIN_NAME); } catch (e) { popup = null; }
        if (!popup) {
          // 弹窗被拦截：reuseOnly 模式下安静失败；否则降级为隐藏 iframe
          if (reuseOnly) return fail(new Error("没有可接管的全局播放窗口"));
          handle.mode = "iframe";
          iframe = document.createElement("iframe");
          iframe.src = PLAYER_URL + "?embed=1&fallback=1";
          iframe.title = "全局播放内核";
          iframe.setAttribute("aria-hidden", "true");
          iframe.setAttribute("allow", "autoplay");
          iframe.style.cssText = "position:absolute;width:0;height:0;border:0;opacity:0;" +
            "pointer-events:none;left:-9999px;top:0;";
          (document.body || document.documentElement).appendChild(iframe);
          target = iframe.contentWindow;
          return;
        }
        target = popup;
        var isPlayer = false;
        try { isPlayer = !!popup.location && popup.location.pathname === "/player.html"; }
        catch (e) { isPlayer = false; }
        if (!isPlayer && reuseOnly) {
          // reconnect 语义：只能接管已有内核，绝不新开窗口。window.open("", name)
          // 在窗口不存在时会创建 about:blank，必须立刻关掉，避免残留空白标签。
          try { popup.close(); } catch (e) {}
          return fail(new Error("没有可接管的全局播放窗口"));
        }
        if (isPlayer) {
          reused = true;
          // 探活：已有内核回 ack 即接管；无响应则导航重载（不打断其它流程）
          target.postMessage({ __mp: TAG, dir: "host", id: 0, cmd: "getState", args: {} }, ORIGIN);
          probeTimer = setTimeout(function () {
            try { popup.location.replace(PLAYER_URL + "?standalone=1"); } catch (e) { fail(e); }
          }, 1200);
        } else {
          try { popup.location.replace(PLAYER_URL + "?standalone=1"); }
          catch (e) { return fail(e); }
        }
      }
      instance = handle;
    });
  }

  /** 静默接管：只在已存在同名窗口时返回 handle，绝不新开窗口/弹窗 */
  function reconnect() {
    return new Promise(function (resolve) {
      var w = null;
      try { w = window.open("", WIN_NAME); } catch (e) { w = null; }
      if (!w) return resolve(null);
      var isPlayer = false;
      try { isPlayer = !!w.location && w.location.pathname === "/player.html"; } catch (e) {}
      if (!isPlayer) { try { w.close(); } catch (e) {} return resolve(null); }
      create("window", true).then(resolve, function () { resolve(null); });
    });
  }

  return {
    supported: supported,
    mount: function (opts) { return create((opts && opts.mode) || "window", false); },
    reconnect: reconnect,
    current: function () { return instance && !instance.dead ? instance : null; },
    WIN_NAME: WIN_NAME,
    TAG: TAG,
  };
})();
