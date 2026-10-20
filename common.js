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

  /* ---- 主题切换：点击 .theme-btn 切换 body.dark 并持久化 ---- */
  function initTheme() {
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

  function boot() {
    initTheme();
    initMobileMenu();
    initScrollFx();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
