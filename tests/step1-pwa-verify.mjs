// ============================================================
// v3.0 步骤 1：PWA 全量验证
//   P1 manifest 有效性与服务端响应
//   P2 Service Worker 注册 + 预缓存完整性
//   P3 离线打开站点（network-first 回退缓存）
//   P4 离线小游戏（预缓存 JS 直接运行）
//   P5 离线音乐播放（API SWR + 音频缓存 + Range 切片）
//   P6 SW 版本控制 ★核心：新版本发布 → 自动安装接管 → 旧缓存清理
//       → 页面自动刷新 → 用户永远看不到旧页面
//   P7 HTML 内容新鲜度（网络优先，旧缓存不卡新内容）
//   P8 worker 响应头：sw.js 不长缓存 / CSP 放行 worker-src
// 运行：node tests/step1-pwa-verify.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import pkg from "playwright";
const { chromium } = pkg;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav" };

/* ---- 3 秒 8kHz 8bit wav（测试曲目） ---- */
function makeWav(seconds = 3) {
  const rate = 8000, samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}
const WAV = makeWav();

const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/test-song.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": WAV.length });
      return res.end(WAV);
    }
    // API 由服务器直接提供：Playwright 的 page.route 拦不住 SW 内部发起的 fetch，
    // 用 route mock 的数据永远进不了 SW 的 SWR 缓存（离线测试必须走真实服务器路径）
    if (p === "/api/music") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([{ id: "t1", title: "PWA 测试曲目", artist: "离线测试", url: "http://localhost:8899/test-song.wav" }]));
    }
    if (p.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("nf");
    }
    const ext = path.extname(file);
    // 对齐生产行为：_worker.js 对 HTML 发 max-age=0, must-revalidate，
    // 避免 Chromium 启发式缓存把旧 HTML 喂给 network-first 的 SW
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => server.listen(8899, "127.0.0.1", r));

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 测试前保存原始文件内容，结束后文件系统级恢复（git 管不了未跟踪文件） ---- */
const SW_PATH = path.join(ROOT, "sw.js");
const IDX_PATH = path.join(ROOT, "index.html");
const SW_ORIG = fs.readFileSync(SW_PATH, "utf8");
const IDX_ORIG = fs.readFileSync(IDX_PATH, "utf8");
const restore = () => {
  try {
    fs.writeFileSync(SW_PATH, SW_ORIG);
    fs.writeFileSync(IDX_PATH, IDX_ORIG);
  } catch (e) { console.error("restore failed:", e.message); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const jsErrors = [];
context.on("page", () => {});

/* ============ P1 manifest ============ */
console.log("\n═══ P1 manifest 有效性与响应 ═══");
{
  const res = await fetch("http://127.0.0.1:8899/manifest.json");
  const ct = res.headers.get("content-type") || "";
  check("manifest.json 可访问且 JSON 类型", res.status === 200 && ct.includes("json"), `status=${res.status} ct=${ct}`);
  const m = await res.json();
  check("manifest 必需字段齐全", !!(m.name && m.short_name && m.start_url && m.display === "standalone" && m.theme_color),
    `name=${m.name} display=${m.display} theme=${m.theme_color}`);
  const sizes = (m.icons || []).map((i) => i.sizes).join(",");
  check("manifest 含 192/512 图标", sizes.includes("192x192") && sizes.includes("512x512"), sizes);
  check("manifest 含 maskable 图标", (m.icons || []).some((i) => i.purpose === "maskable"));
  for (const icon of m.icons || []) {
    const r = await fetch("http://127.0.0.1:8899/" + icon.src.replace(/^\.\//, ""));
    check(`图标 ${icon.src} 可访问`, r.status === 200 && (r.headers.get("content-type") || "").includes("image"), `status=${r.status}`);
  }
  const page = await context.newPage();
  await page.goto("http://localhost:8899/index.html", { waitUntil: "domcontentloaded" });
  await sleep(400);
  const metaOk = await page.evaluate(() => ({
    manifest: !!document.querySelector('link[rel="manifest"]'),
    themeColor: !!document.querySelector('meta[name="theme-color"]'),
    appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content === "yes",
    appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
    swReg: "serviceWorker" in navigator,
  }));
  check("页面注入 manifest link", metaOk.manifest);
  check("页面注入 theme-color", metaOk.themeColor);
  check("页面注入 apple-mobile-web-app-capable", metaOk.appleCapable);
  check("页面注入 apple-touch-icon", metaOk.appleIcon);
  check("浏览器支持 Service Worker", metaOk.swReg);
  await page.close();
}

/* ============ P2 SW 注册 + 预缓存 ============ */
console.log("\n═══ P2 Service Worker 注册与预缓存 ═══");
const pageA = await context.newPage();
pageA.on("pageerror", (e) => jsErrors.push(`[A] ${String(e)}`));
await pageA.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await pageA.goto("http://localhost:8899/index.html", { waitUntil: "load" });
await sleep(1500);
const swState = await pageA.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return {
    hasController: !!navigator.serviceWorker.controller,
    scriptURL: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : "",
    scope: reg.scope,
    cacheKeys: await caches.keys(),
  };
});
check("SW 注册成功且激活控制页面", swState.hasController, swState.scriptURL);
check("SW scope 覆盖全站", swState.scope.endsWith("/"), swState.scope);
const STATIC_CACHE = "my-blog-static-v3.0.1";
check(`预缓存容器 ${STATIC_CACHE} 已创建`, swState.cacheKeys.includes(STATIC_CACHE), swState.cacheKeys.join(","));

const precached = await pageA.evaluate(async (cacheName) => {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  return keys.map((r) => new URL(r.url).pathname).sort();
}, STATIC_CACHE);
const EXPECT_CORE = [
  "/index.html", "/blog.html", "/games.html", "/album.html", "/links.html",
  "/timeline.html", "/guestbook.html", "/post.html", "/admin.html",
  "/common.css", "/common.js", "/music-player.js", "/game-core.js",
  "/games/breakout.js", "/games/g2048.js", "/games/hanoi.js",
  "/games/memory.js", "/games/mines.js", "/games/reaction.js", "/games/snake.js",
  "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png",
];
const missing = EXPECT_CORE.filter((u) => !precached.includes(u));
check(`预缓存清单完整（${EXPECT_CORE.length} 项核心资源）`, missing.length === 0, missing.length ? "缺失: " + missing.join(",") : `实际 ${precached.length} 项`);

/* ============ P3 离线打开站点 ============ */
console.log("\n═══ P3 离线打开站点 ═══");
await context.setOffline(true);
await pageA.reload({ waitUntil: "domcontentloaded" });
await sleep(1200);
const offlineIndex = await pageA.evaluate(() => ({
  title: document.title,
  logo: (document.getElementById("nav-logo") || {}).textContent || "",
  cssLoaded: getComputedStyle(document.body).backgroundColor,
}));
check("离线刷新 index.html 仍可打开", !!offlineIndex.logo || !!offlineIndex.title, `logo="${offlineIndex.logo}" bg=${offlineIndex.cssLoaded}`);

/* ============ P4 离线小游戏 ============ */
console.log("\n═══ P4 离线小游戏 ═══");
await pageA.goto("http://localhost:8899/games.html", { waitUntil: "domcontentloaded" });
await sleep(1500);
const gameGrid = await pageA.evaluate(() => document.querySelectorAll(".game-card").length);
check("离线下游戏列表渲染（JS 已缓存）", gameGrid >= 7, `${gameGrid} 张卡片`);
if (gameGrid > 0) {
  await pageA.click(".game-card");
  await sleep(900);
  const canvas = await pageA.evaluate(() => !!document.querySelector("#board-wrap canvas, .board-wrap canvas, canvas"));
  check("离线下点击卡片可启动游戏（canvas 创建）", canvas);
  const noErr = jsErrors.filter((e) => e.startsWith("[A]")).length;
  check("离线游戏过程零 JS 错误", noErr === 0, jsErrors.join(" | ") || "无");
}

/* ============ P5 离线音乐（独立 context：避免其他部分的 API mock 污染 SW 缓存） ============ */
console.log("\n═══ P5 离线音乐播放 ═══");
await context.setOffline(false);
await sleep(300);
const ctxM = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageM = await ctxM.newPage();
pageM.on("pageerror", (e) => jsErrors.push(`[M] ${String(e)}`));
// 不注册 page.route：API 由测试服务器直接提供，SW 的 SWR 才能真实缓存（离线可命中）
await pageM.goto("http://localhost:8899/index.html", { waitUntil: "load" });
await sleep(1800);
await pageM.click("#mpPlay");
let playingOnline = false;
try {
  await pageM.waitForFunction(() => document.getElementById("mpPlay")?.title === "暂停", { timeout: 8000 });
  playingOnline = true;
} catch (e) {}
check("在线播放成功（音频已加载）", playingOnline, `mpPlay title=${await pageM.evaluate(() => document.getElementById("mpPlay")?.title)}`);
await sleep(1500); // 让 SW 完成音频缓存写入
const audioCached = await pageM.evaluate(async () => {
  const c = await caches.open("my-blog-runtime-v1");
  const all = await c.keys();
  return all.some((r) => r.url.includes("test-song.wav"));
});
check("音频文件已进入 SW 缓存", audioCached);
// 断网 → 刷新 → 再播
await context.setOffline(true);
await pageM.reload({ waitUntil: "load" });
await sleep(1800);
await pageM.click("#mpPlay");
let playingOffline = false;
try {
  await pageM.waitForFunction(() => document.getElementById("mpPlay")?.title === "暂停", { timeout: 8000 });
  playingOffline = true;
} catch (e) {}
check("离线播放成功（歌单 API 走 SWR 缓存 + 音频走本地缓存）", playingOffline,
  `mpPlay title=${await pageM.evaluate(() => document.getElementById("mpPlay")?.title)}`);
const offlineTitle = await pageM.evaluate(() => document.getElementById("mpTitle")?.textContent || "");
check("离线歌单信息正确渲染", offlineTitle.includes("PWA 测试曲目"), `title="${offlineTitle}"`);
await ctxM.setOffline(false);
await ctxM.close();
// 恢复主 context 网络（P3/P4 曾将其设为离线，P7 需要在线网络优先）
await context.setOffline(false);

/* ============ P7 HTML 内容新鲜度（置于 P6 前：P6 的 sw.js 篡改/恢复会引发 SW 更新抖动） ============ */
console.log("\n═══ P7 HTML 内容新鲜度（网络优先，旧缓存不卡新内容） ═══");
{
  const idx = fs.readFileSync(IDX_PATH, "utf8");
  fs.writeFileSync(IDX_PATH, idx.replace("</body>", "<!-- pwa-fresh-marker -->\n</body>"));
  const pageC = await context.newPage();
  await pageC.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await pageC.goto("http://localhost:8899/index.html", { waitUntil: "load" });
  await sleep(1200);
  const fresh = await pageC.evaluate(() => document.documentElement.outerHTML.includes("pwa-fresh-marker"));
  check("在线刷新后立即看到最新 HTML（不被 SW 旧缓存卡住）", fresh);
  await pageC.close();
  restore();
}

/* ============ P6 SW 版本控制（核心） ============ */
console.log("\n═══ P6 SW 版本控制：新版本发布后用户不停留旧页面 ═══");
await pageA.close(); // 关闭旧页面，避免其 controllerchange 自动刷新干扰
const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const OLD_VER = "v3.0.1", NEW_VER = "v3.0.2";
if (!swSrc.includes(`"${OLD_VER}"`)) {
  check("sw.js 含可替换版本常量", false, "未找到版本常量");
} else {
  // 篡改 sw.js：升级版本号（模拟发布新版本）
  fs.writeFileSync(path.join(ROOT, "sw.js"), swSrc.replace(`"${OLD_VER}"`, `"${NEW_VER}"`));
  const pageB = await context.newPage();
  pageB.on("pageerror", (e) => jsErrors.push(`[B] ${String(e)}`));
  await pageB.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await pageB.goto("http://localhost:8899/index.html", { waitUntil: "domcontentloaded" });
  // 轮询等待：新 SW 安装 → activate 清旧缓存 → 页面自动 reload → 新 SW 控制
  let settled = false, detail = "";
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const st = await pageB.evaluate(async () => ({
        keys: await caches.keys(),
        controlled: !!navigator.serviceWorker.controller,
        url: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : "",
      }));
      const hasNew = st.keys.includes(`my-blog-static-${NEW_VER}`);
      const oldGone = !st.keys.includes(`my-blog-static-${OLD_VER}`);
      if (hasNew && oldGone && st.controlled) { settled = true; detail = st.keys.join(","); break; }
      detail = st.keys.join(",");
    } catch (e) { /* 页面正在自动刷新，重试 */ }
  }
  check(`新版本缓存 ${NEW_VER} 已建立且旧版本 ${OLD_VER} 已清理`, settled, detail);
  const controlled = await pageB.evaluate(() => !!navigator.serviceWorker.controller);
  check("页面最终由新 SW 控制（自动刷新生效）", controlled);
  // 刷新一次，确认新 SW 稳定控制不循环刷新
  await pageB.reload({ waitUntil: "load" });
  await sleep(1200);
  const stable = await pageB.evaluate(async () => ({
    keys: await caches.keys(),
    controlled: !!navigator.serviceWorker.controller,
  }));
  check("刷新后仍稳定受控（无刷新循环）", stable.controlled && !stable.keys.includes(`my-blog-static-${OLD_VER}`), stable.keys.join(","));
  await pageB.close();
}
// 恢复真实 sw.js
restore();

/* ============ P8 worker 响应头 ============ */
console.log("\n═══ P8 Worker 响应头：sw.js 缓存策略 + CSP ═══");
{
  const deferred = [];
  const ctx = { waitUntil: (p) => deferred.push(Promise.resolve(p).catch(() => {})) };
  const assetBody = "console.log('x')";
  const env = {
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        const ct = u.pathname.endsWith(".html") ? "text/html" : u.pathname.endsWith(".js") ? "text/javascript" : "application/json";
        return new Response(assetBody, { status: 200, headers: { "Content-Type": ct } });
      },
    },
  };
  const swResp = await worker.fetch(new Request("http://x/sw.js"), env, ctx);
  const swCC = swResp.headers.get("Cache-Control");
  check("sw.js 响应 max-age=0, must-revalidate（防止 SW 脚本被长缓存）", /max-age=0/.test(swCC || ""), swCC);
  const manResp = await worker.fetch(new Request("http://x/manifest.json"), env, ctx);
  check("manifest.json 同样不长缓存", /max-age=0/.test(manResp.headers.get("Cache-Control") || ""), manResp.headers.get("Cache-Control"));
  const htmlResp = await worker.fetch(new Request("http://x/index.html"), env, ctx);
  const csp = htmlResp.headers.get("Content-Security-Policy") || "";
  check("HTML 响应带 CSP", csp.length > 0);
  check("CSP 放行 worker-src 'self'（否则 SW 注册被 CSP 拦截）", /worker-src 'self'/.test(csp), csp.match(/worker-src [^;]*/)?.[0]);
  const nosniff = htmlResp.headers.get("X-Content-Type-Options");
  check("其他安全头保留（nosniff/x-frame）", nosniff === "nosniff" && htmlResp.headers.get("X-Frame-Options") === "DENY");
}

/* ============ 汇总 ============ */
console.log(`\n════════════════════════════════════`);
console.log(`v3.0 步骤1 PWA 验证: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
restore();
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
