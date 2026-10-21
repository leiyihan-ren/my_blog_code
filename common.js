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
      navigator.serviceWorker.register("sw.js").catch((e) => {
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

  function boot() {
    initTheme();
    initMobileMenu();
    initScrollFx();
    initSeoUrls();
    initPwa();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
