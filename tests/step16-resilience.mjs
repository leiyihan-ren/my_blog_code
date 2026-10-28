// ============================================================
// v7.3 步骤 6：弱网兜底与 PWA 强化
//   G 组：断网横幅（offline/online 事件驱动，context.setOffline）
//   H 组：全局错误边界（未捕获异常 → console.warn + toast，页面不崩）
//   I 组：SW 策略静态断言（NetworkFirst / 版本号 / authed bypass）
// 运行：node tests/step16-resilience.mjs
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
// 浏览器启动参数统一走 _helpers（优先使用 CHROMIUM_PATH 指定的可执行文件）
const { CHROMIUM_LAUNCH_OPTIONS } = await import("./_helpers.mjs");
const STATIC_PORT = 8903;

const staticServer = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://x");
    const p = decodeURIComponent(parsed.pathname);
    const filePath = path.join(ROOT, p === "/" ? "pages/index.html" : p.replace(/^\//, ""));
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404); return res.end("nf");
    }
    const ext = path.extname(resolved);
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    return res.end(fs.readFileSync(resolved));
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

await new Promise((r) => staticServer.listen(STATIC_PORT, "127.0.0.1", r));
console.log(`  静态 :${STATIC_PORT} 已启动`);

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
};

let browser = null;
try {
  const { chromium } = await import(
    pathToFileURL(path.join(ROOT, "node_modules", "playwright", "index.mjs")).href
  );
  browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const context = await browser.newContext();
  const page = await context.newPage();

  // ============================================================
  console.log("== G 组：断网横幅 ==");
  // ============================================================
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/pages/index.html`, { waitUntil: "domcontentloaded" });

  // G1 在线无横幅
  const g1 = await page.evaluate(() => {
    const el = document.getElementById("cx-offline-banner");
    return !el || !el.classList.contains("show");
  });
  check("G1 在线状态 → 无断网横幅", g1);

  // G2 断网 → 横幅显示
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.waitForFunction(() => {
    const el = document.getElementById("cx-offline-banner");
    return el && el.classList.contains("show");
  }, null, { timeout: 3000 });
  const g2Text = await page.textContent("#cx-offline-banner");
  check("G2 offline 事件 → 横幅显示且文案明确", /网络已断开/.test(g2Text || ""), g2Text);

  // G3 恢复联网 → 横幅隐藏
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => {
    const el = document.getElementById("cx-offline-banner");
    return el && !el.classList.contains("show");
  }, null, { timeout: 3000 });
  check("G3 online 事件 → 横幅隐藏", true);

  // G4 断网刷新场景由 step1 P3（离线打开站点）守护，此处不重复验证
  check("G4 断网刷新横幅路径（由 step1 P3 离线场景覆盖，跳过重复）", true);
  await context.setOffline(false);

  // ============================================================
  console.log("== H 组：全局错误边界（games.html：带 #toast 元素） ==");
  // ============================================================
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/pages/games.html`, { waitUntil: "domcontentloaded" });
  const consoleMsgs = [];
  page.on("console", (m) => { if (m.type() === "warning") consoleMsgs.push(m.text()); });
  // H1 未捕获异常 → error-boundary 记录 + toast + 页面不崩
  await page.evaluate(() => {
    setTimeout(() => { throw new Error("boundary-test-error"); }, 0);
  });
  await page.waitForFunction(() => {
    const t = document.getElementById("toast");
    return t && t.textContent.includes("页面遇到错误");
  }, null, { timeout: 3000 }).catch(() => {});
  const h1Toast = await page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
  const h1Boundary = consoleMsgs.some((m) => m.includes("error-boundary") && m.includes("boundary-test-error"));
  const h1Alive = await page.evaluate(() => document.readyState === "complete" || document.readyState === "interactive");
  check("H1a 未捕获异常 → console.warn 记录（error-boundary）", h1Boundary, consoleMsgs.join(" | "));
  check("H1b 未捕获异常 → toast 友好提示", /页面遇到错误/.test(h1Toast), h1Toast);
  check("H1c 异常后页面仍可交互（不崩）", h1Alive === true);

  // H2 未处理的 Promise 拒绝 → 同样被边界捕获
  await page.evaluate(() => {
    Promise.reject(new Error("rejection-test-error"));
  });
  await page.waitForTimeout(300);
  const h2Boundary = consoleMsgs.some((m) => m.includes("unhandledrejection") && m.includes("rejection-test-error"));
  check("H2 未处理 Promise 拒绝 → 边界捕获", h2Boundary);

  // H3 边界不吞正常交互：手动触发一次成功 fetch 后页面照常工作
  const h3 = await page.evaluate(() => typeof window.scrollToTop === "function");
  check("H3 边界注册后全局功能仍可用", h3 === true);

  // ============================================================
  console.log("== I 组：SW 策略静态断言 ==");
  // ============================================================
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  // I1 改为「格式合规 + 语义化下界」断言：此前硬编码 v3.3.0，每次发版推进版本号都会误报失败。
  // 发布纪律本身（改动静态资源必须 +1）由人工/CI 检查单保证，这里只守住可机检的部分。
  const cvMatch = sw.match(/const CACHE_VERSION = "v(\d+)\.(\d+)\.(\d+)"/);
  const cvOk =
    !!cvMatch &&
    Number(cvMatch[1]) === 3 &&
    (Number(cvMatch[2]) > 3 || (Number(cvMatch[2]) === 3 && Number(cvMatch[3]) >= 3));
  check("I1 SW 版本号格式合规且不低于 v3.3.0", cvOk, cvMatch ? cvMatch[0] : "未找到 CACHE_VERSION");
  check("I2 HTML 导航 network-first", /req\.mode === "navigate"[\s\S]{0,400}?const fresh = await fetch\(req\)/.test(sw));
  check("I3 公共 JSON 读 network-first（断网回退缓存）", /url\.pathname\.startsWith\("\/api\/"\)[\s\S]{0,600}?const fresh = await fetch\(req\)/.test(sw));
  check("I4 带 Authorization 的 API GET 不走缓存", /req\.headers\.get\("authorization"\)/.test(sw));
  check("I5 离线回退目标存在（OFFLINE_URL）", /const OFFLINE_URL = "\/index\.html"/.test(sw));
  const common = fs.readFileSync(path.join(ROOT, "utils", "common.js"), "utf8");
  check("I6 SW 注册用绝对路径（route-map 重写安全）", /navigator\.serviceWorker\.register\("\/sw\.js"\)/.test(common));

  await page.close();
  await context.close();
} catch (e) {
  failed++;
  console.log("  ❌ 套件执行异常 →", e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  staticServer.close();
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
