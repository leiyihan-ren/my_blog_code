// ============================================================
// 步骤 5 收尾：common.js 提取后的全页交互回归
// 9 页面验证：
//   A. 主题切换（点击 → body.dark 翻转 + localStorage 持久化 + 图标同步）
//   B. 主题持久化（刷新后 head 防闪脚本恢复 dark）
//   C. 移动端菜单（开合 / 点链接关闭 / 点外部关闭）
//   D. 滚动效果（navbar.scrolled + backTop.show 随 scrollY 切换）
//   E. 全程零 JS 错误
// 运行：node tests/step5-common-verify.mjs
// ============================================================
import http from "node:http";
import pkg from "playwright";
import { ROOT } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import fs from "node:fs";
import path from "node:path";
const { chromium } = pkg;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav" };
const staticServer = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, staticFilePath(p)); // v7.0：经 route-map 映射到 pages/ 等物理路径
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("nf");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => staticServer.listen(8899, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  { name: "index", url: "/index.html", hasMenu: true },
  { name: "blog", url: "/blog.html", hasMenu: true },
  { name: "games", url: "/games.html", hasMenu: true },
  { name: "album", url: "/album.html", hasMenu: true },
  { name: "links", url: "/links.html", hasMenu: true },
  { name: "timeline", url: "/timeline.html", hasMenu: true },
  { name: "guestbook", url: "/guestbook.html", hasMenu: true },
  { name: "post", url: "/post.html", hasMenu: true },
  { name: "admin", url: "/admin.html", hasMenu: false },
];

const jsErrors = [];

for (const p of PAGES) {
  console.log(`\n═══ ${p.name} ═══`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => jsErrors.push(`[${p.name}] ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/40[48]|50[02]|Failed to load|ERR_|net::|favicon/.test(m.text())) jsErrors.push(`[${p.name}] ${m.text()}`);
  });
  // API 全部 mock，隔离网络依赖
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // 阻止导航类点击跳出测试页
  await page.addInitScript(() => {
    document.addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); }, true);
  });

  // 初始化到 light 主题
  await page.goto("http://localhost:8899" + p.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { try { localStorage.setItem("theme", "light"); } catch (e) {} });
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(600);

  const errBefore = jsErrors.length;

  // ---- A/B. 主题切换 + 持久化 ----
  const themeBtn = await page.$(".theme-btn");
  check(`${p.name} 主题按钮存在`, !!themeBtn);
  if (themeBtn) {
    const before = await page.evaluate(() => ({
      dark: document.body.classList.contains("dark"),
      icon: document.querySelector(".theme-btn").textContent.trim(),
    }));
    check(`${p.name} 初始为 light`, !before.dark, `dark=${before.dark} icon=${before.icon}`);
    await themeBtn.click();
    await sleep(120);
    const after1 = await page.evaluate(() => ({
      dark: document.body.classList.contains("dark"),
      icon: document.querySelector(".theme-btn").textContent.trim(),
      stored: localStorage.getItem("theme"),
    }));
    check(`${p.name} 点击后切 dark + 持久化 + 图标☀️`, after1.dark && after1.stored === "dark" && after1.icon === "☀️",
      `dark=${after1.dark} stored=${after1.stored} icon=${after1.icon}`);
    // 刷新持久化
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(400);
    const afterReload = await page.evaluate(() => ({
      dark: document.body.classList.contains("dark"),
      icon: document.querySelector(".theme-btn").textContent.trim(),
    }));
    check(`${p.name} 刷新后 dark 保持（防闪脚本）`, afterReload.dark && afterReload.icon === "☀️",
      `dark=${afterReload.dark} icon=${afterReload.icon}`);
    // 再点回 light
    await page.click(".theme-btn");
    await sleep(120);
    const after2 = await page.evaluate(() => ({
      dark: document.body.classList.contains("dark"),
      icon: document.querySelector(".theme-btn").textContent.trim(),
      stored: localStorage.getItem("theme"),
    }));
    check(`${p.name} 再点回 light + 图标🌙`, !after2.dark && after2.stored === "light" && after2.icon === "🌙",
      `dark=${after2.dark} stored=${after2.stored} icon=${after2.icon}`);
  }

  // ---- C. 移动端菜单（375 视口） ----
  if (p.hasMenu) {
    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(250);
    const toggle = await page.$("#navToggle");
    check(`${p.name} navToggle 存在`, !!toggle);
    if (toggle) {
      await toggle.click();
      await sleep(120);
      const open = await page.evaluate(() => ({
        t: document.getElementById("navToggle").classList.contains("active"),
        m: document.getElementById("mobileMenu").classList.contains("active"),
      }));
      check(`${p.name} 菜单开：双 active`, open.t && open.m, `toggle=${open.t} menu=${open.m}`);
      // 点菜单内链接 → 关闭
      await page.evaluate(() => {
        const a = document.querySelector("#mobileMenu a");
        if (a) a.click();
      });
      await sleep(120);
      const afterLink = await page.evaluate(() => ({
        t: document.getElementById("navToggle").classList.contains("active"),
        m: document.getElementById("mobileMenu").classList.contains("active"),
      }));
      check(`${p.name} 点链接后菜单关`, !afterLink.t && !afterLink.m, `toggle=${afterLink.t} menu=${afterLink.m}`);
      // 重开 → 点外部关闭
      await toggle.click();
      await sleep(120);
      await page.mouse.click(187, 700); // 页面主体空白区
      await sleep(150);
      const afterOutside = await page.evaluate(() => ({
        t: document.getElementById("navToggle").classList.contains("active"),
        m: document.getElementById("mobileMenu").classList.contains("active"),
      }));
      check(`${p.name} 点外部菜单关`, !afterOutside.t && !afterOutside.m, `toggle=${afterOutside.t} menu=${afterOutside.m}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(200);
  }

  // ---- D. 滚动效果 ----
  if (p.hasMenu) {
    // 注入撑高元素：mock 环境下部分页面内容不足（如相册空列表）滚不动，
    // 撑高后直接验证 common.js 滚动逻辑本身，不受页面内容长度影响
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.style.cssText = "height:3000px;width:1px;";
      d.id = "scroll-test-spacer";
      document.body.appendChild(d);
    });
    await page.evaluate(() => window.scrollTo(0, 600));
    await sleep(250);
    const scrolled = await page.evaluate(() => ({
      y: window.scrollY,
      nav: document.querySelector(".navbar") ? document.querySelector(".navbar").classList.contains("scrolled") : null,
      top: document.getElementById("backTop") ? document.getElementById("backTop").classList.contains("show") : null,
    }));
    check(`${p.name} 下滚 600px：navbar.scrolled + backTop.show`, scrolled.nav === true && scrolled.top === true,
      `scrollY=${scrolled.y} nav=${scrolled.nav} backTop=${scrolled.top}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(250);
    const back = await page.evaluate(() => ({
      y: window.scrollY,
      nav: document.querySelector(".navbar") ? document.querySelector(".navbar").classList.contains("scrolled") : null,
      top: document.getElementById("backTop") ? document.getElementById("backTop").classList.contains("show") : null,
    }));
    check(`${p.name} 回顶：两状态移除`, back.nav === false && back.top === false, `scrollY=${back.y} nav=${back.nav} backTop=${back.top}`);
    await page.evaluate(() => document.getElementById("scroll-test-spacer")?.remove());
  }

  // ---- E. JS 错误 ----
  check(`${p.name} 全程零 JS 错误`, jsErrors.length === errBefore, jsErrors.slice(errBefore).join(" | ") || "无错误");

  await page.close();
}

console.log(`\n════════════════════════════════════`);
console.log(`步骤5 common.js 交互回归: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
await browser.close();
staticServer.close();
process.exit(fail ? 1 : 0);
