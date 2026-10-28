/**
 * js/utils.js —— 全站公共工具函数（BlogUtils）
 * ---------------------------------------------------------------
 * 重构背景：原先 escapeHtml/escapeAttr/safeStorage/formatDate/toast 等
 * 在 9 个页面 + game-core.js + music-player.js 中各定义一遍（共 11 份
 * escapeHtml、4 份 escapeAttr、3 种 formatDate 行为、4 套 toast），
 * 任何一处修复都要改十几个地方，是典型的重复代码维护陷阱。
 * 现全部收敛到本文件，页面通过别名方式零成本接入：
 *
 *   const { escapeHtml, formatDate } = window.BlogUtils;
 *
 * 命名规范：驼峰命名法；函数按「语义」拆分而非强并——
 * formatDateTime（绝对时间）/ formatRelativeDate（相对时间）/
 * fmtBytes（字节可读化）是三种不同的产品展示行为，不可互相替代。
 * （v7.3：零引用的 formatDateCN 已按死代码清除。）
 *
 * 加载方式：<head> 中置于 common.js 之后同步引入，
 * 对页面内联脚本与 defer 脚本（music-player.js）均立即可用。
 * ===============================================================
 */
window.BlogUtils = (function () {
  "use strict";

  /* ---- 元素选取 ---- */
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---- HTML 转义 ----
     同时转义 < > & " ：文本位置安全，拼进属性也不会被注入闭合。
     （历史教训：旧版 game-core 的 escapeHtml 不转义引号，属性位置
      必须再套一层 escapeAttr；现在一个函数全覆盖，杜绝用错。） */
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML.replace(/"/g, "&quot;");
  }

  /** 属性位置转义：在 escapeHtml 基础上再转义单引号（兼容单引号属性写法） */
  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  /* ---- 安全存储：隐私模式 / 存储被禁用时不抛错，避免中断业务循环 ---- */
  const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} },
    remove(key) { try { localStorage.removeItem(key); } catch (e) {} },
  };

  /* ---- 时间格式化（三种语义，按场景选用） ---- */

  /** 绝对时间：无效输入返回 "-"（后台列表场景） */
  function formatDateTime(dateStr) {
    if (!dateStr) return "-";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return escapeHtml(String(dateStr));
    return d.toLocaleString();
  }

  /**
   * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 30 天走 farFormat。
   * @param {string} dateStr
   * @param {object} [opts]
   * @param {function(Date):string} [opts.farFormat] 超 30 天的展示格式，
   *        默认 toLocaleDateString()；文章评论区传「日期+时分」变体
   */
  function formatRelativeDate(dateStr, opts) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "-";
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 2592000000) return Math.floor(diff / 86400000) + " 天前";
    const farFormat = (opts && opts.farFormat) || ((dd) => dd.toLocaleDateString());
    return farFormat(d);
  }

  /** 秒 → m:ss（播放器场景） */
  function formatTime(s) {
    if (!isFinite(s) || isNaN(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return m + ":" + sec;
  }

  /* ---- 字节单位常量（消除 1024/1048576/1073741824 魔法数字） ---- */
  const BYTES_PER_KB = 1024;
  const BYTES_PER_MB = BYTES_PER_KB * 1024;
  const BYTES_PER_GB = BYTES_PER_MB * 1024;

  /**
   * 字节数人类可读（云盘/相册/后台通用，v7.3 收敛此前三处重复实现）
   * 无效输入（null/undefined/NaN）返回 "—"，0 返回 "0 B"——
   * 与 drive.html / uploadService.js 原实现行为逐字节一致，回归零破坏。
   */
  function fmtBytes(n) {
    if (n == null || isNaN(n)) return "—";
    if (n < BYTES_PER_KB) return n + " B";
    if (n < BYTES_PER_MB) return (n / BYTES_PER_KB).toFixed(1) + " KB";
    if (n < BYTES_PER_GB) return (n / BYTES_PER_MB).toFixed(2) + " MB";
    return (n / BYTES_PER_GB).toFixed(2) + " GB";
  }

  /* ---- 轻提示：统一走页面 #toast 元素（无元素时静默降级） ---- */
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), ms || 2200);
  }

  /* ---- 函数节流 ---- */
  /** 尾调用延迟：连续触发只执行最后一次（搜索输入等场景） */
  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /** rAF 节流：同一帧内多次触发只执行一次（滚动/ resize 场景） */
  function throttleRaf(fn) {
    let ticking = false;
    return function (...args) {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; fn.apply(this, args); });
    };
  }

  /* ---- 剪贴板：navigator.clipboard 不可用（非安全上下文/旧浏览器）时降级 execCommand ---- */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 降级尝试 */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /** 是否为 http(s) 绝对外链（音乐外链校验等场景） */
  function isHttpUrl(s) {
    return /^https?:\/\//i.test(String(s || ""));
  }

  /** 延时（测试与重试退避场景） */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* --------------------------------------------------------------
   * 说明：数据请求（超时熔断 / 并发去重 / 离线缓存降级）统一在
   * services/request.js 的 BlogApi 层实现，本文件不重复造轮子——
   * 两处并存必然出现「改了一处忘了另一处」的口径分歧。
   * -------------------------------------------------------------- */

  /**
   * 局部失败占位块：某模块拉不到数据时只在这块区域显示「点击重试」，
   * 绝不让整页卡死或白屏。
   * @param {string} msg       提示文案
   * @param {function} onRetry 点击重试回调
   * @returns {HTMLElement}
   */
  function retryBlock(msg, onRetry) {
    const box = document.createElement("div");
    box.className = "retry-block";
    box.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.textContent = msg || "内容加载失败";
    const btn = document.createElement("button");
    btn.className = "btn btn-sm";
    btn.textContent = "点击重试";
    btn.onclick = () => { if (typeof onRetry === "function") onRetry(); };
    box.appendChild(text);
    box.appendChild(btn);
    return box;
  }

  return {
    $, $$,
    escapeHtml, escapeAttr,
    safeStorage,
    formatDateTime, formatRelativeDate, formatTime, fmtBytes,
    toast, debounce, throttleRaf,
    copyText, isHttpUrl, sleep,
    retryBlock,
  };
})();
