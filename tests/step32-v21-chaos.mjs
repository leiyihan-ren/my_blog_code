/* ============================================================
 * step32-v21-chaos.mjs —— v21.0 模块二-3 混沌测试（优雅降级）
 * ------------------------------------------------------------
 * 模拟断网、接口超时/格式错乱、脏数据、Canvas 不可用、埋点层缺失、
 * Worker 不可用、调度器缺失等故障，确保 Dashboard 图表与工具箱
 * 都不白屏、不抛未捕获异常、有明确降级提示。
 *
 * 六个独立故障场景（各自独立浏览器 context，互不污染）：
 *   S1 断网          → Dashboard 纯本地数据，图表/KPI 不受影响，徽标提示离线
 *   S2 脏数据投毒    → LocalStorage 非法 JSON / 错型计数，埋点自愈，大屏不白屏
 *   S3 Canvas 不可用 → getContext 返回 null，自动切纯 CSS 表格兜底
 *   S4 埋点层缺失    → telemetry.js 返回空，大屏降级为空视图，仍 render
 *   S5 Worker+调度器双缺失 → 工具箱 regex/diff 降级主线程 + DocumentFragment，结果仍出
 *   S6 接口超时/格式错乱 → 工具箱 probe/ipinfo 请求失败/乱码，局部隔离不白屏
 *
 * 每个场景都断言：零 pageerror、关键 DOM 仍渲染、降级路径真实生效。
 * 不修改任何既有套件；本套件只做增量验证。
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import pkg from "playwright";
const { chromium } = pkg;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, staticFilePath(p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("nf");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);

/** 预置合法埋点数据（供 S1/S3 等需要「有数据」的场景复用） */
function seedData() {
  const d = new Date(), p = (n) => (n < 10 ? "0" + n : "" + n);
  const key = (k) => d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate() - k);
  const pv = {};
  for (let i = 0; i < 7; i++) pv[key(i)] = { "/index.html": 3 + i, "/tools.html": 2 + i, "/blog.html": 1 };
  localStorage.setItem("wb.telemetry.v1", JSON.stringify({
    v: 1, pv, tools: { json: 12, diff: 8, regex: 5 }, updatedAt: Date.now(),
  }));
  localStorage.setItem("blogApiCache:site", JSON.stringify({
    ts: Date.now(), data: { files: [{ name: "a.bin", size: 204800 }] },
  }));
}

/**
 * 创建一个隔离的混沌场景 context。
 * @param {{initScript?:Function, routes?:Array}} cfg 配置
 * @returns {Promise<{ctx:Object, page:Object, errs:string[], apiCalls:string[]}>}
 */
async function scenario(cfg) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  if (cfg.initScript) await ctx.addInitScript(cfg.initScript);
  const page = await ctx.newPage();
  const errs = [], apiCalls = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("request", (r) => { if (r.url().includes("/api/")) apiCalls.push(r.url()); });
  for (const [matcher, handler] of (cfg.routes || [])) await page.route(matcher, handler);
  return { ctx, page, errs, apiCalls };
}
const dashReady = (page) => page.waitForFunction(
  () => window.DashboardDebug && window.DashboardDebug.state().rendered, { timeout: 6000 }).catch(() => {});

try {
  /* ---------- S1 断网：Dashboard 纯本地数据不受影响 ---------- */
  console.log("\n═══ S1 断网 ═══");
  {
    const { ctx, page, errs, apiCalls } = await scenario({ initScript: seedData });
    await page.goto(`${ORIGIN}/dashboard.html`, { waitUntil: "load" });
    await dashReady(page);
    const before = await page.evaluate(() => (document.getElementById("db-kpi-visits") || {}).textContent);
    await ctx.setOffline(true);
    await page.click("#db-refresh");
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({
      visits: (document.getElementById("db-kpi-visits") || {}).textContent,
      bars: document.querySelectorAll("#db-bars .db-bar").length,
      badges: [...document.querySelectorAll("#db-badges .db-badge")].map((e) => e.textContent),
      rendered: window.DashboardDebug.state().rendered,
    }));
    check("S1 断网后大屏仍正常重绘（KPI 不变 / 工具条仍在 / rendered）",
      r.rendered && r.visits === before && r.bars === 3,
      `before=${before} after=${r.visits} bars=${r.bars}`);
    check("S1b 徽标明确提示离线且数据源仍为本地 / 零 /api/ 请求 / 零异常",
      r.badges.some((b) => /离线/.test(b)) && r.badges.some((b) => /LocalStorage/.test(b))
      && apiCalls.length === 0 && errs.length === 0,
      `err=${errs.slice(0, 1).join(";")}`);
    await ctx.close();
  }

  /* ---------- S2 脏数据投毒：埋点自愈、大屏不白屏 ---------- */
  console.log("\n═══ S2 脏数据投毒 ═══");
  {
    const { ctx, page, errs } = await scenario({
      initScript: () => {
        localStorage.setItem("wb.telemetry.v1", "{{{NOT JSON");
        localStorage.setItem("blogApiCache:bad", "no-json-here");
      },
    });
    await page.goto(`${ORIGIN}/dashboard.html`, { waitUntil: "load" });
    await dashReady(page);
    const r = await page.evaluate(() => ({
      visits: (document.getElementById("db-kpi-visits") || {}).textContent,
      kpiCount: document.querySelectorAll(".db-kpi__value").length,
      canvas: !!(document.getElementById("db-canvas-trend") && document.getElementById("db-canvas-trend").width > 0),
      rendered: window.DashboardDebug.state().rendered,
      healed: (() => { try { return !!JSON.parse(localStorage.getItem("wb.telemetry.v1")); } catch (e) { return false; } })(),
      snapErrors: window.SiteTelemetry.snapshot().errors.length,
    }));
    check("S2 非法 JSON 投毒：大屏仍完整渲染（4 KPI / Canvas / rendered）",
      r.rendered && r.kpiCount === 4 && r.canvas && r.visits !== "",
      `kpi=${r.kpiCount} visits=${r.visits}`);
    check("S2b 埋点自愈重写为合法空状态且记录脏数据错误 / 零异常",
      r.healed && r.snapErrors >= 1 && errs.length === 0,
      `snapErrors=${r.snapErrors} err=${errs.slice(0, 1).join(";")}`);
    await ctx.close();
  }

  /* ---------- S3 Canvas 不可用：自动切纯 CSS 表格 ---------- */
  console.log("\n═══ S3 Canvas 不可用 ═══");
  {
    const { ctx, page, errs } = await scenario({
      initScript: () => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type) {
          if (this.id === "db-canvas-trend" || this.id === "db-canvas-ring") return null;
          return orig.apply(this, arguments);
        };
        const d = new Date(), p = (n) => (n < 10 ? "0" + n : "" + n);
        localStorage.setItem("wb.telemetry.v1", JSON.stringify({
          v: 1, pv: { [d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())]: { "/index.html": 5 } },
          tools: { json: 3 }, updatedAt: Date.now(),
        }));
      },
    });
    await page.goto(`${ORIGIN}/dashboard.html`, { waitUntil: "load" });
    await dashReady(page);
    const r = await page.evaluate(() => ({
      fallbackTables: document.querySelectorAll(".db-fallback").length,
      fallbackCount: window.DashboardDebug.state().canvasFallback,
      trendHidden: (document.getElementById("db-canvas-trend") || {}).hidden,
      bars: document.querySelectorAll("#db-bars .db-bar").length,
      rendered: window.DashboardDebug.state().rendered,
    }));
    check("S3 Canvas 不可用自动切纯 CSS 表格兜底（趋势 + 环形两张表）",
      r.fallbackTables >= 2 && r.fallbackCount >= 2 && r.trendHidden === true,
      `tables=${r.fallbackTables} fallbackCount=${r.fallbackCount}`);
    check("S3b CSS 图表（工具频率条）不受影响，零异常",
      r.rendered && r.bars >= 1 && errs.length === 0,
      `bars=${r.bars} err=${errs.slice(0, 1).join(";")}`);
    await ctx.close();
  }

  /* ---------- S4 埋点层缺失：大屏降级空视图 ---------- */
  console.log("\n═══ S4 埋点层缺失 ═══");
  {
    const { ctx, page, errs } = await scenario({
      // 用 200 + 空 JS 阻断 telemetry.js（避免 404 造成 console 噪声）
      routes: [["**/utils/telemetry.js", (route) =>
        route.fulfill({ status: 200, contentType: "text/javascript", body: "" })]],
    });
    await page.goto(`${ORIGIN}/dashboard.html`, { waitUntil: "load" });
    await dashReady(page);
    const r = await page.evaluate(() => ({
      hasTelemetry: !!window.SiteTelemetry,
      degraded: window.DashboardDebug.state().degraded,
      rendered: window.DashboardDebug.state().rendered,
      kpiCount: document.querySelectorAll(".db-kpi__value").length,
      meta: (document.getElementById("db-kpi-meta") || {}).textContent,
      badges: [...document.querySelectorAll("#db-badges .db-badge")].map((e) => e.textContent),
    }));
    check("S4 SiteTelemetry 缺失：大屏降级为空视图仍完整 render（不白屏）",
      !r.hasTelemetry && r.degraded && r.rendered && r.kpiCount === 4,
      `degraded=${r.degraded} kpi=${r.kpiCount}`);
    check("S4b 明确降级提示（数据模块未就绪 / 部分数据源降级）/ 零异常",
      /未就绪|降级/.test(r.meta) && r.badges.some((b) => /降级/.test(b)) && errs.length === 0,
      `meta=${r.meta} err=${errs.slice(0, 1).join(";")}`);
    await ctx.close();
  }

  /* ---------- S5 工具箱：Worker + 调度器双缺失仍完整可用 ---------- */
  console.log("\n═══ S5 工具箱 Worker + 调度器双缺失 ═══");
  {
    const { ctx, page, errs } = await scenario({
      initScript: () => {
        // 让 new Worker() 直接抛错 → ToolboxCompute 立即 broken → 走主线程 fallback
        window.Worker = function () { throw new Error("chaos: worker disabled"); };
      },
      routes: [
        // render-scheduler.js 返回空 → window.RenderScheduler 为 undefined → 分片降级 DocumentFragment
        ["**/utils/render-scheduler.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: "" })],
        [(u) => u.pathname.startsWith("/api/"), (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "{}" })],
      ],
    });
    await page.goto(`${ORIGIN}/tools.html`, { waitUntil: "load" });
    await page.click("#tb-tab-advanced");
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => ({
      schedMissing: typeof window.RenderScheduler === "undefined",
      computeBroken: window.ToolboxCompute.state().broken,
      regexStatus: (document.getElementById("regex-status") || {}).textContent || "",
      regexSpans: document.querySelectorAll("#regex-output span").length,
      diffLines: document.querySelectorAll("#diff-output .tb-diff-line").length,
      diffStatus: (document.getElementById("diff-status") || {}).textContent || "",
    }));
    check("S5 Worker 不可用：regex/diff 降级主线程仍出结果（engine=main）",
      r.computeBroken === true && r.regexSpans >= 1 && r.diffLines >= 1
      && /主线程/.test(r.regexStatus) && /主线程/.test(r.diffStatus),
      `broken=${r.computeBroken} spans=${r.regexSpans} lines=${r.diffLines}`);
    check("S5b 调度器缺失：分片降级 DocumentFragment 不白屏 / 零异常",
      r.schedMissing && errs.length === 0,
      `schedMissing=${r.schedMissing} err=${errs.slice(0, 1).join(";")}`);
    await ctx.close();
  }

  /* ---------- S6 接口超时 / 格式错乱：工具箱局部隔离 ---------- */
  console.log("\n═══ S6 接口超时 / 格式错乱 ═══");
  {
    const { ctx, page, errs } = await scenario({
      routes: [
        // 模拟格式错乱：返回非 JSON 乱码
        [(u) => u.pathname.indexOf("/api/toolbox/ipinfo") >= 0, (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "<<<NOT JSON>>>" })],
        // 模拟超时/断连：直接 abort
        [(u) => u.pathname.indexOf("/api/toolbox/probe") >= 0, (route) => route.abort("failed")],
        [(u) => u.pathname.startsWith("/api/"), (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "{}" })],
      ],
    });
    await page.goto(`${ORIGIN}/tools.html`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.fill("#probe-url", "https://example.com");
    await page.click("#probe-btn");
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({
      probeStatus: (document.getElementById("probe-status-text") || {}).textContent || "",
      ipNote: (document.getElementById("ip-note") || {}).textContent || "",
      cardCount: document.querySelectorAll(".tb-card").length,
      jsonOut: (document.getElementById("json-output") || {}).textContent || "",
    }));
    check("S6 接口乱码 / 断连：工具箱不白屏、错误局部收敛、其他工具照常",
      r.cardCount >= 7 && r.jsonOut.length > 0 && errs.length === 0,
      `cards=${r.cardCount} err=${errs.slice(0, 1).join(";")}`);
    check("S6b 探测/IP 工具有明确降级反馈（非空白）",
      r.probeStatus.length > 0 || r.ipNote.length > 0,
      `probe="${r.probeStatus.slice(0, 24)}" ip="${r.ipNote.slice(0, 24)}"`);
    await ctx.close();
  }
} catch (e) {
  check("混沌场景执行未抛异常", false, String(e && e.message || e));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(`通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
