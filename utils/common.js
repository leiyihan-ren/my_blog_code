/* ============================================================
   common.js —— 全站公共行为（步骤 5 重构产物）
   原 9 个页面各自重复的安全存储、主题切换、移动端菜单、
   滚动效果（rAF 节流）提取至此统一维护。
   加载方式：<head> 中同步引入（window.safeStorage 需对后续
   内联脚本立即可用；DOM 绑定统一在 DOMContentLoaded 执行，
   不阻塞解析）。幂等设计：重复调用不会重复绑定。
   ============================================================ */
(function () {
  "use strict";

  /* ---- 安全存储：隐私模式 / 存储被禁用时不抛错 ---- */
  const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} },
    remove(key) { try { localStorage.removeItem(key); } catch (e) {} },
  };
  window.safeStorage = safeStorage;

  /* ---- 回到顶部：原 6 个页面各自定义同一函数，抽至此全局挂载 ----
     页面按钮以 onclick="scrollToTop()" 调用，需保持 window 全局可见。 */
  window.scrollToTop = function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ---- v8.1：失效图片兜底为本地占位图 ----
     实测取证：内容仓库（music.json / 文章 front-matter）里残留了
     `https://example.com/cover.jpg` 之类的示例封面，该域名不可达，
     导致**每个页面都白扔一个 700~1900ms 的 FAILED 请求**，既拖慢
     首屏又在控制台刷红。内容数据由用户在后台维护，代码侧无法穷举，
     因此在最外层做一次兜底：任何 <img> 加载失败且未处理过的，
     一律换成本地 SVG 占位图，并打标记避免死循环。
     用捕获阶段监听：error 事件不冒泡，只能靠捕获拿得到。 */
  (function initImgFallback() {
    const PLACEHOLDER = "/icons/placeholder-cover.svg";
    document.addEventListener(
      "error",
      function (e) {
        const el = e.target;
        if (!el || el.tagName !== "IMG") return;
        if (el.dataset.imgFallback) return; // 已兜底过，防止占位图也失败时循环
        /* 关键：带 data-mirrors 的图由 BlogApi.github.loadImage 接管，
         * 它的 onerror 是「切下一个镜像」的降级链路。若这里抢先把 src 换成
         * 占位图，图片会立刻加载成功、onerror 不再触发 —— 多镜像降级被
         * 整个短路掉（step2 B6 实测：raw/jsDelivr/statically 三级降级全废）。
         * 这类图交给 loadImage 走完镜像链，全灭后由容器监听 imgallfailed
         * 决定呈现，本页面兜底不插手。 */
        if (el.dataset.mirrors) return;
        el.dataset.imgFallback = "1";
        el.src = PLACEHOLDER;
        el.classList.add("img-placeholder");
      },
      true
    );
  })();

  /* v8.1：离线降级横幅（全站共用，幂等）。
   * 任一读接口在「3s 熔断 + 重试」后仍失败、但本地兜底缓存命中时，
   * BlogApi 会回调 onFallback，这里在页面顶部挂一条提示条，
   * 让用户知道看到的是缓存数据，而不是假装一切正常。 */
  window.markOfflineBanner = function markOfflineBanner() {
    if (document.getElementById("offlineHint")) return;
    const bar = document.createElement("div");
    bar.id = "offlineHint";
    bar.setAttribute("role", "status");
    bar.textContent = "网络不稳定，当前展示的是本地缓存数据";
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px 14px;" +
      "background:#f59e0b;color:#fff;font-size:14px;text-align:center";
    document.body.prepend(bar);
  };

  /* ---- 主题切换：点击 .theme-btn 切换 body.dark 并持久化 ---- */
  function initTheme() {
    /* 主题色同步：移动端地址栏/状态栏颜色跟随手动主题
       （页面只保留一个无 media 的 theme-color，由这里按当前主题赋值；
         系统偏好由 head 防闪脚本在首屏决定初始 dark 类） */
    const syncThemeColor = () => {
      const meta = document.head.querySelector('meta[name="theme-color"]:not([media])');
      if (meta) meta.setAttribute("content", document.body.classList.contains("dark") ? "#0f0f1a" : "#4f46e5");
    };
    window.__syncThemeColor = syncThemeColor;
    syncThemeColor();
    const btn = document.querySelector(".theme-btn");
    if (!btn || btn.dataset.commonBound) return;
    btn.dataset.commonBound = "1";
    const syncIcon = () => {
      btn.textContent = document.body.classList.contains("dark") ? "☀️" : "🌙";
    };
    btn.addEventListener("click", () => {
      document.body.classList.toggle("dark");
      safeStorage.set("theme", document.body.classList.contains("dark") ? "dark" : "light");
      syncIcon();
      syncThemeColor();
    });
    syncIcon(); // 与 head 联防闪脚本的初始 dark 类对齐图标
  }

  /* ---- 移动端菜单：开合 / 点击链接关闭 / 点击外部关闭 ---- */
  function initMobileMenu() {
    const navToggle = document.getElementById("navToggle");
    const mobileMenu = document.getElementById("mobileMenu");
    if (!navToggle || !mobileMenu || navToggle.dataset.commonBound) return;
    navToggle.dataset.commonBound = "1";
    const close = () => {
      navToggle.classList.remove("active");
      mobileMenu.classList.remove("active");
    };
    navToggle.addEventListener("click", () => {
      navToggle.classList.toggle("active");
      mobileMenu.classList.toggle("active");
    });
    mobileMenu.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".nav-right") && !e.target.closest("#mobileMenu")) close();
    });
  }

  /* ---- 滚动效果：navbar .scrolled + backTop .show（rAF 节流，passive 监听）---- */
  function initScrollFx() {
    const navbar = document.querySelector(".navbar");
    const backTop = document.getElementById("backTop");
    if ((!navbar && !backTop) || window.__commonScrollBound) return;
    window.__commonScrollBound = true;
    let ticking = false;
    const apply = () => {
      if (navbar) navbar.classList.toggle("scrolled", window.scrollY > 10);
      if (backTop) backTop.classList.toggle("show", window.scrollY > 300);
      ticking = false;
    };
    window.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(apply);
    }, { passive: true });
    apply();
  }

  /* ---- PWA：注册 Service Worker + 新版本自动接管刷新 ----
     hadController=false 的首次注册不触发刷新，避免首访莫名 reload；
     仅当「旧 SW → 新 SW」接管（发布了新版本）时自动刷新一次。 */
  function initPwa() {
    if (!("serviceWorker" in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });
    const register = () => {
      // v7.0：页面物理位置在 pages/ 但对外 URL 仍是根级（Worker 重写），
      // 必须用绝对路径注册，否则会解析到 /pages/sw.js 而 404。
      navigator.serviceWorker.register("/sw.js").catch((e) => {
        console.warn("[pwa] Service Worker 注册失败：", e && e.message);
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);
  }

  /* ---- SEO URL 归一：canonical / og:url 与实际访问 URL 对齐 ----
     静态 <meta> 写死生产域名，供不执行 JS 的爬虫读取；
     运行时再按 location 覆写一次：换域名、经 CDN/镜像访问、
     Cloudflare 308 规范化（/album.html → /album）时，
     canonical 始终等于浏览器地址栏的真实 URL，不会留下错位。 */
  function initSeoUrls() {
    const here = location.origin + location.pathname;
    const setContent = (selector, value) => {
      const el = document.head.querySelector(selector);
      if (el) el.setAttribute("content", value);
    };
    const canonical = document.head.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute("href", here);
    setContent('meta[property="og:url"]', here);
    setContent('meta[name="twitter:url"]', here);
    // index 的 WebSite JSON-LD：url 字段同步归一（textContent 读写，防注入）
    const ld = document.getElementById("jsonld-website");
    if (ld) {
      try {
        const data = JSON.parse(ld.textContent);
        if (data && data["@type"] === "WebSite") {
          data.url = location.origin + "/";
          ld.textContent = JSON.stringify(data);
        }
      } catch (e) { /* 解析失败保持静态值 */ }
    }
  }

  /* 空闲预取（DevOps 2.2）：低优先级拉取高频下一页 HTML，经 SW SWR 写入
     运行时缓存——站内导航（尤其离线/弱网）秒开。省流模式与慢速网络自动跳过。 */
  function initPrefetch() {
    var NEXT_PAGES = {
      "/index.html": ["/blog.html", "/games.html"],
      "/blog.html": ["/index.html"],
      "/games.html": ["/index.html"],
      "/album.html": ["/links.html", "/index.html"],
      "/links.html": ["/guestbook.html", "/album.html"],
      "/guestbook.html": ["/links.html"],
      "/timeline.html": ["/index.html"],
      "/post.html": ["/blog.html"]
    };
    var here = location.pathname === "/" ? "/index.html" : location.pathname;
    var targets = NEXT_PAGES[here];
    if (!targets || !targets.length) return;
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && (conn.saveData || /(^|-)(slow-)?2g$/.test(conn.effectiveType || ""))) return;
    var idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 1500); };
    idle(function () {
      targets.forEach(function (href) {
        var l = document.createElement("link");
        l.rel = "prefetch";
        l.href = href;
        document.head.appendChild(l);
      });
    });
  }

  /* ---- v8.0 对话框基建已收拢至 components/ui.js（UI 组件域）。
     此处仅保留桥接：函数体内懒解析 window.UI，调用必然发生在
     用户交互时（ui.js 早已同步加载完毕），无加载顺序依赖。 ---- */
  window.confirmDialog = function (opts) {
    return window.UI.confirm(typeof opts === "string" ? { message: opts } : opts);
  };
  window.promptDialog = function (opts) {
    return window.UI.prompt(typeof opts === "string" ? { message: opts } : opts);
  };

  /* ---- v7.3 弱网兜底：断网横幅（offline/online 事件 + 首屏 onLine 检查） ---- */
  function initOfflineBanner() {
    var BANNER_ID = "cx-offline-banner";
    var show = function () {
      var el = document.getElementById(BANNER_ID);
      if (!el) {
        el = document.createElement("div");
        el.id = BANNER_ID;
        el.className = "offline-banner";
        el.setAttribute("role", "status");
        el.textContent = "⚠️ 网络已断开——显示的是缓存内容，恢复联网后将自动更新";
        document.body.appendChild(el);
      }
      requestAnimationFrame(function () { el.classList.add("show"); });
    };
    var hide = function () {
      var el = document.getElementById(BANNER_ID);
      if (el) el.classList.remove("show");
    };
    window.addEventListener("offline", show);
    window.addEventListener("online", function () {
      hide();
      if (window.BlogUtils && window.BlogUtils.toast) window.BlogUtils.toast("网络已恢复 ✅");
    });
    if (navigator.onLine === false) show(); // 断网状态下打开/刷新页面
  }

  /* ---- v7.3 全局错误边界：未捕获异常/拒绝只提示不崩溃（不影响 pageerror 事件本身） ---- */
  function initErrorBoundary() {
    var shown = false;
    var notify = function (tag, msg) {
      console.warn("[error-boundary][" + tag + "]", msg);
      if (shown) return;
      shown = true;
      if (window.BlogUtils && window.BlogUtils.toast) {
        window.BlogUtils.toast("页面遇到错误，部分功能可能不可用，请尝试刷新");
      }
    };
    window.addEventListener("error", function (e) { notify("error", e.message || String(e)); });
    window.addEventListener("unhandledrejection", function (e) {
      notify("unhandledrejection", (e && e.reason && e.reason.message) || String(e && e.reason) || "unknown");
    });
  }

  function boot() {
    initTheme();
    initMobileMenu();
    initScrollFx();
    initSeoUrls();
    initPwa();
    initPrefetch();
    initPageEnter();
    initOfflineBanner();
    initErrorBoundary();
  }

  /* ---- v7.3 进场淡入：body.page-enter 一次性动画，结束即摘除类（不干扰后续过渡） ---- */
  function initPageEnter() {
    if (!document.body || document.body.classList.contains("page-enter")) return;
    document.body.classList.add("page-enter");
    const done = () => document.body.classList.remove("page-enter");
    document.body.addEventListener("animationend", done, { once: true });
    setTimeout(done, 800); // 兜底：reduced-motion / 动画未触发时不残留类
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
