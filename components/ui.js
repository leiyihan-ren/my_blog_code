/* ============================================================
   ui.js —— 全局 UI 组件库（v8.0「全生态重塑」产物）
   ------------------------------------------------------------
   背景：v7.3 之前，对话框基建长在 utils/common.js 里（与主题/菜单/
   滚动等「页面行为」耦合），toast 由 BlogUtils.toast 提供（无类型、
   无队列、无图标）。本文件把「UI 组件」这一功能域完整收拢：
     - 对话框：confirm / prompt / alert（Promise API，DOM 契约不变）
     - Toast：类型色 + 图标 + 队列 + 批量去重
     - copyText：剪贴板 + execCommand 降级（委托 BlogUtils 已有实现）
     - btnLoading：按钮忙碌态（网盘/表单提交防重复点击）
   零依赖自包含；与 common.js 解耦（common.js 只留桥接委托）。
   DOM 契约（step15 测试依赖，禁止改动）：
     - 对话框容器 id="cx-dialog"，主按钮类名含 cx-btn-primary
   ============================================================ */
(function () {
  "use strict";

  /* ============ Toast（#cx-toast，类型 + 图标 + 队列） ============ */
  var TOAST_ID = "cx-toast";
  var TOAST_ICONS = { success: "✅", error: "❌", info: "💡", warn: "⚠️" };
  var toastQueue = [];
  var toastTimer = null;

  function toastEl() { return document.getElementById(TOAST_ID); }

  function ensureToastCss() {
    if (document.getElementById("cx-toast-css")) return;
    var style = document.createElement("style");
    style.id = "cx-toast-css";
    style.textContent =
      ".cx-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(16px);" +
      "background:var(--text,#1a1a2e);color:var(--bg,#fff);padding:10px 20px;border-radius:999px;" +
      "font-size:14px;font-weight:600;opacity:0;pointer-events:none;z-index:2100;max-width:86vw;" +
      "text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.22);" +
      "transition:opacity .28s var(--ease,cubic-bezier(.4,0,.2,1)),transform .28s var(--ease,cubic-bezier(.4,0,.2,1))}" +
      ".cx-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}" +
      ".cx-toast.cx-toast-success{background:var(--success,#16a34a);color:#fff}" +
      ".cx-toast.cx-toast-error{background:var(--danger-solid,#dc2626);color:#fff}" +
      ".cx-toast.cx-toast-warn{background:var(--warning,#d97706);color:#fff}";
    document.head.appendChild(style);
  }

  function flushToast() {
    var el = toastEl();
    if (!el) return;
    if (!toastQueue.length) {
      el.classList.remove("show");
      toastTimer = null;
      return;
    }
    var item = toastQueue[0];
    el.textContent = (TOAST_ICONS[item.type] ? TOAST_ICONS[item.type] + " " : "") + item.msg;
    el.className = "cx-toast" + (item.type && item.type !== "info" ? " cx-toast-" + item.type : "");
    // 强制回流后再加 show，保证连续多条之间的过渡动画生效
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastQueue.shift();
      flushToast();
    }, item.duration || 2600);
  }

  /**
   * 全局 Toast。UI.toast("msg") / UI.toast("msg", "error") / UI.toast("msg", {type, duration})
   * 与 BlogUtils.toast 并存不冲突（独立元素与样式类），旧调用点零改动。
   */
  function toast(msg, opts) {
    ensureToastCss();
    var cfg = typeof opts === "string" ? { type: opts } : (opts || {});
    var type = cfg.type || "info";
    if (!/^(success|error|info|warn)$/.test(type)) type = "info";
    // 相邻去重：与队首同文本同类型则不重复入队
    if (toastQueue.length && toastQueue[0].msg === msg && toastQueue[0].type === type) return;
    if (toastQueue.length > 4) toastQueue.shift(); // 队列上限保护
    toastQueue.push({ msg: String(msg == null ? "" : msg), type: type, duration: cfg.duration });
    if (!toastTimer) flushToast();
    else if (!toastEl().classList.contains("show")) flushToast();
  }

  /* ============ 对话框（v7.3 实现整体收拢；DOM 契约保持） ============ */
  var DLG_ID = "cx-dialog";
  function dlgEl() { return document.getElementById(DLG_ID); }
  function ensureDialogCss() {
    if (document.getElementById("cx-dialog-css")) return;
    var style = document.createElement("style");
    style.id = "cx-dialog-css";
    style.textContent =
      ".cx-mask{position:fixed;inset:0;background:rgba(15,15,26,.55);display:none;align-items:center;justify-content:center;z-index:2000;padding:20px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}" +
      ".cx-mask.show{display:flex}" +
      ".cx-box{background:var(--card-bg,#fff);color:var(--text,#1a1a2e);border:1px solid var(--border,#e5e7eb);border-radius:16px;padding:24px;width:100%;max-width:400px;box-shadow:0 18px 60px rgba(0,0,0,.25);animation:cxIn .22s var(--ease-spring,cubic-bezier(.2,.8,.3,1.1))}" +
      "@keyframes cxIn{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}" +
      ".cx-box h3{margin:0 0 8px;font-size:17px;display:flex;align-items:center;gap:8px}" +
      ".cx-msg{margin:0 0 16px;font-size:14px;line-height:1.6;color:var(--text-mute,#6b7280);white-space:pre-wrap;word-break:break-all}" +
      ".cx-input{width:100%;box-sizing:border-box;border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:11px 14px;font-size:15px;background:var(--bg,#fff);color:var(--text,#1a1a2e);margin-bottom:16px;outline:none}" +
      ".cx-input:focus{border-color:var(--primary,#4f46e5)}" +
      ".cx-btns{display:flex;gap:10px;justify-content:flex-end}" +
      ".cx-btn{border:1px solid var(--border,#e5e7eb);background:var(--card-bg,#fff);color:var(--text,#1a1a2e);border-radius:999px;padding:9px 18px;font-size:14px;cursor:pointer;transition:all .18s ease}" +
      ".cx-btn:hover{border-color:var(--primary,#4f46e5);color:var(--primary-text,#4f46e5)}" +
      ".cx-btn-primary{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5);color:#fff}" +
      ".cx-btn-primary:hover{background:var(--primary-hover,#4338ca);color:#fff}" +
      ".cx-btn-danger{color:var(--danger-solid,#dc2626);border-color:var(--danger-solid,#dc2626);background:transparent}" +
      ".cx-btn-danger:hover{background:var(--danger-bg,#fef2f2);color:var(--danger-solid,#dc2626);border-color:var(--danger-solid,#dc2626)}" +
      ".cx-btn:disabled{opacity:.55;cursor:not-allowed}";
    document.head.appendChild(style);
  }

  function openDialog(opts) {
    ensureDialogCss();
    var mask = dlgEl();
    if (mask) mask.remove(); // 单例：复用时先移除旧实例（含残留监听）
    mask = document.createElement("div");
    mask.className = "cx-mask";
    mask.id = DLG_ID;
    var box = document.createElement("div");
    box.className = "cx-box";
    var h3 = document.createElement("h3");
    if (opts.icon) {
      var ic = document.createElement("span");
      ic.textContent = opts.icon;
      h3.appendChild(ic);
    }
    h3.appendChild(document.createTextNode(opts.title || "请确认"));
    var msg = document.createElement("p");
    msg.className = "cx-msg";
    msg.textContent = opts.message || "";
    box.appendChild(h3);
    box.appendChild(msg);
    var input = null;
    if (opts.mode === "prompt") {
      input = document.createElement("input");
      input.className = "cx-input";
      input.type = "text";
      input.value = opts.defaultValue || "";
      input.placeholder = opts.placeholder || "";
      input.maxLength = opts.maxLength || 200;
      box.appendChild(input);
    }
    var btns = document.createElement("div");
    btns.className = "cx-btns";
    var cancelBtn = null;
    if (opts.mode !== "alert") {
      cancelBtn = document.createElement("button");
      cancelBtn.className = "cx-btn";
      cancelBtn.textContent = opts.cancelText || "取消";
    }
    var okBtn = document.createElement("button");
    // 角色类 cx-btn-primary 恒定（调用方/测试稳定选择「确认按钮」）；danger 仅作样式修饰
    okBtn.className = "cx-btn cx-btn-primary" + (opts.danger ? " cx-btn-danger" : "");
    okBtn.textContent = opts.confirmText || "确认";
    if (cancelBtn) btns.appendChild(cancelBtn);
    btns.appendChild(okBtn);
    box.appendChild(btns);
    mask.appendChild(box);
    document.body.appendChild(mask);
    requestAnimationFrame(function () { mask.classList.add("show"); });
    if (input) { input.focus(); input.select(); }

    return new Promise(function (resolve) {
      var done = false;
      var finish = function (val) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey);
        mask.classList.remove("show");
        setTimeout(function () { mask.remove(); }, 180);
        resolve(val);
      };
      var onKey = function (e) {
        if (e.key === "Escape") { e.preventDefault(); finish(opts.mode === "prompt" ? null : false); }
        else if (e.key === "Enter" && (e.target !== input || opts.mode === "prompt")) {
          e.preventDefault();
          finish(opts.mode === "prompt" ? (input.value || "").trim() || null : true);
        }
      };
      if (cancelBtn) cancelBtn.onclick = function () { finish(opts.mode === "prompt" ? null : false); };
      okBtn.onclick = function () {
        if (opts.mode === "prompt") {
          var v = (input.value || "").trim();
          finish(v || null); // 空输入按取消处理（与原生 prompt 空串语义对齐调用方校验）
        } else finish(true);
      };
      mask.addEventListener("mousedown", function (e) { if (e.target === mask) finish(opts.mode === "prompt" ? null : false); });
      document.addEventListener("keydown", onKey);
      if (input) input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); okBtn.click(); } });
    });
  }

  /* ============ 剪贴板：优先 BlogUtils.copyText（已含降级），否则内置兜底 ============ */
  function copyText(text) {
    if (window.BlogUtils && typeof window.BlogUtils.copyText === "function") {
      return window.BlogUtils.copyText(text);
    }
    return new Promise(function (resolve) {
      var done = function (ok) { resolve(ok); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text)).then(function () { done(true); }, function () { done(legacy()); });
      } else done(legacy());
      function legacy() {
        try {
          var ta = document.createElement("textarea");
          ta.value = String(text);
          ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand("copy");
          ta.remove();
          return ok;
        } catch (e) { return false; }
      }
    });
  }

  /* ============ 按钮忙碌态：防重复点击（网盘提交/表单保存） ============ */
  function btnLoading(btn, state, loadingText) {
    if (!btn) return;
    if (state) {
      if (btn.dataset.cxBusy) return;
      btn.dataset.cxBusy = "1";
      btn.dataset.cxPrevText = btn.textContent;
      btn.disabled = true;
      btn.textContent = loadingText || "处理中…";
    } else {
      delete btn.dataset.cxBusy;
      btn.disabled = false;
      if (btn.dataset.cxPrevText != null) {
        btn.textContent = btn.dataset.cxPrevText;
        delete btn.dataset.cxPrevText;
      }
    }
  }

  window.UI = {
    toast: toast,
    confirm: function (opts) {
      return openDialog(Object.assign({ mode: "confirm" }, typeof opts === "string" ? { message: opts } : opts));
    },
    prompt: function (opts) {
      return openDialog(Object.assign({ mode: "prompt" }, typeof opts === "string" ? { message: opts } : opts));
    },
    alert: function (opts) {
      var o = typeof opts === "string" ? { message: opts } : Object.assign({}, opts);
      o.mode = "alert";
      return openDialog(o).then(function () { /* 单按钮也返回 Promise<void> */ });
    },
    copyText: copyText,
    btnLoading: btnLoading,
  };
})();
