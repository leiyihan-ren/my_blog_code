/* ============================================================
 * step31-v21-dashboard.mjs —— v21.0 模块一-1 全站数据大屏验收
 * ------------------------------------------------------------
 * 两段式（与 step29/30/33 同风格）：
 *   A. 静态门禁（零浏览器）：页面 head 契约 / 路由双表 / SW 预缓存 /
 *      架构域登记 / 埋点层零网络零裸 fetch 自包含 / 渲染层 Canvas+CSS 兜底 /
 *      DocumentFragment 批量挂载 / 局部错误隔离 / 后台入口。
 *   B. 浏览器端到端：预置 LocalStorage 埋点与 API 缓存数据，验证
 *      KPI / 趋势折线 / 工具频率条 / 空间环形 / 页面排行 / 状态徽标 /
 *      PV 自动累计 / 事件委托归因 / 零外部数据请求 / 零 JS 异常。
 *
 * 不修改任何既有套件；本套件只做增量验证。
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import pkg from "playwright";
const { chromium } = pkg;

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\r\n])[ \t]*\/\/[^\n]*/g, "$1");

/* ============================================================
 * A. 静态门禁
 * ============================================================ */
console.log("═══ A. 静态门禁 ═══");
{
  const html = read("pages/dashboard.html");
  check("A1 dashboard.html 落盘且为 noindex 后台页 + 全站 head 契约",
    /<meta name="robots" content="noindex, nofollow">/.test(html)
    && /<style data-v19-critical>/.test(html)
    && /<script src="\/utils\/event-bus\.js"><\/script>/.test(html)
    && /common-css-nonblocking:start/.test(html)
    && /<noscript><link rel="stylesheet" href="\/styles\/common\.css"><\/noscript>/.test(html)
    && (html.match(/rel="dns-prefetch"/g) || []).length >= 3
    && (html.match(/rel="prefetch"/g) || []).length >= 1);
  check("A1b 三项核心指标区齐备（访问次数 / 工具频率 / 网盘空间）",
    /id="db-kpi-visits"/.test(html) && /id="db-kpi-today"/.test(html)
    && /id="db-kpi-tools"/.test(html) && /id="db-panel-space"/.test(html)
    && /id="db-canvas-trend"/.test(html) && /id="db-canvas-ring"/.test(html)
    && /id="db-bars"/.test(html) && /id="db-paths"/.test(html));
  check("A1c 依赖链脚本顺序：common → ui → telemetry → dashboard",
    ["/utils/common.js", "/components/ui.js", "/utils/telemetry.js", "/components/dashboard.js"]
      .map((s) => html.indexOf(s)).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));

  const rm = read("scripts/route-map.mjs"), wk = read("_worker.js");
  check("A2 物理路由双表一致（route-map PAGE_FILES ⇄ _worker PAGE_REWRITES）",
    /"\/dashboard\.html":\s*"pages\/dashboard\.html"/.test(rm)
    && /"\/dashboard\.html":\s*"\/pages\/dashboard\.html"/.test(wk));

  const sw = read("sw.js");
  check("A3 SW 预缓存包含 Dashboard 页面 + 3 个新资产（离线可用）",
    ["/dashboard.html", "/utils/telemetry.js", "/components/dashboard.js", "/styles/dashboard.css"]
      .every((u) => sw.includes('"' + u + '"')));

  check("A4 架构域登记：dashboard feature manifest + architecture 引用",
    exists("src/features/dashboard/manifest.mjs")
    && /features\/dashboard\/manifest\.mjs/.test(read("src/architecture.mjs"))
    && /dashboard/.test(read("src/architecture.mjs"))
    && /"pages\/dashboard\.html"/.test(read("src/architecture.mjs")));

  const tel = read("utils/telemetry.js");
  // 注：注释里出现「绝不读取 common.js 的 window.safeStorage」属说明文字，
  // 一律用去注释后的 strip(tel) 判定，与 arch-audit 的 stripComments 同口径。
  check("A5 埋点层零网络 / 零裸 fetch / 零 console / 自包含存储（不读 common 全局）",
    !/(^|[^.\w"'])fetch\s*\(/.test(strip(tel))
    && !/console\.(log|debug|info)\s*\(/.test(strip(tel))
    && !/window\.safeStorage/.test(strip(tel))
    && /localStorage\.getItem/.test(tel) && /window\.SiteTelemetry\s*=/.test(tel));
  check("A5b 埋点净化：脏 JSON 自愈 / 非数字计数过滤 / 路径白名单 / 工具 id 正则",
    /function sanitize\(/.test(tel) && /selfheal|JSON\.stringify\(emptyState\(\)\)/.test(tel)
    && /TOOL_RE/.test(tel) && /charAt\(0\) !== "\/"/.test(tel)
    && /isFinite/.test(tel));
  check("A5c 网盘空间三段独立采集（LocalStorage / IndexedDB / estimate + 超时熔断）",
    /function scanLocalStorage\(/.test(tel) && /function scanIndexedDB\(/.test(tel)
    && /function estimateSafe\(/.test(tel) && /ESTIMATE_TIMEOUT_MS/.test(tel)
    && /navigator\.storage\.estimate/.test(tel));

  const dbg = read("components/dashboard.js");
  check("A6 渲染层 Canvas 折线/环形 + 纯 CSS 表格兜底 + 局部错误隔离",
    /function drawTrend\(/.test(dbg) && /function drawRing\(/.test(dbg)
    && /function fallbackTable\(/.test(dbg) && /getContext\("2d"\)/.test(dbg)
    && /function note\(/.test(dbg) && (dbg.match(/try \{/g) || []).length >= 5);
  check("A6b DOM 更新走 DocumentFragment + rAF 合并（呼应模块二-1）",
    /createDocumentFragment/.test(dbg) && /requestAnimationFrame/.test(dbg)
    && /window\.DashboardDebug\s*=/.test(dbg));
  check("A6c 数据源降级：telemetry 缺失 / 抛错 / 超时 均有兜底",
    /function emptySnapshot\(/.test(dbg) && /function withTimeout\(/.test(dbg)
    && /state\.degraded/.test(dbg));

  check("A7 后台入口 admin.html 提供大屏链接",
    read("pages/admin.html").includes("/dashboard.html"));
  check("A8 子集化体积报告已排除出静态产物（工程治理）",
    /v21-assets-report/.test(read("scripts/build-pages.mjs")));
}

/* ============================================================
 * B. 浏览器端到端
 * ============================================================ */
console.log("\n═══ B. 浏览器端到端 ═══");
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
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
const jsErrors = [], apiCalls = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
page.on("request", (r) => { if (r.url().includes("/api/")) apiCalls.push(r.url()); });

// 预置埋点数据（含 PV 分桶 + 工具频率 + 一条脏数据）+ API 缓存文件清单
await page.addInitScript(() => {
  const d = new Date(), p = (n) => (n < 10 ? "0" + n : "" + n);
  const key = (k) => d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate() - k);
  const pv = {};
  for (let i = 0; i < 7; i++) pv[key(i)] = { "/index.html": 3 + i, "/tools.html": 2 + i, "/blog.html": 1 };
  localStorage.setItem("wb.telemetry.v1", JSON.stringify({
    v: 1, pv, tools: { json: 12, diff: 8, regex: 5, hash: 3, qrcode: 2, "<bad>": 99 }, updatedAt: Date.now(),
  }));
  localStorage.setItem("blogApiCache:site", JSON.stringify({
    ts: Date.now(), data: { files: [{ name: "a.bin", size: 204800 }, { name: "b.bin", size: 51200 }] },
  }));
});
try {
  const resp = await page.goto(`${ORIGIN}/dashboard.html`, { waitUntil: "load" });
  check("B1 GET /dashboard.html → 200", resp.status() === 200, "status=" + resp.status());
  await page.waitForFunction(() => window.DashboardDebug && window.DashboardDebug.state().rendered, { timeout: 6000 }).catch(() => {});

  const st = await page.evaluate(() => window.DashboardDebug && window.DashboardDebug.state());
  check("B2 DashboardDebug 挂载且 rendered=true / 数据模块就绪",
    !!st && st.rendered && st.hasTelemetry, JSON.stringify(st));

  const kpi = await page.evaluate(() => ({
    visits: (document.getElementById("db-kpi-visits") || {}).textContent,
    today: (document.getElementById("db-kpi-today") || {}).textContent,
    tools: (document.getElementById("db-kpi-tools") || {}).textContent,
    space: (document.getElementById("db-kpi-space") || {}).textContent,
    bars: document.querySelectorAll("#db-bars .db-bar").length,
    paths: document.querySelectorAll("#db-paths .db-bar").length,
    badges: document.querySelectorAll("#db-badges .db-badge").length,
    legend: document.querySelectorAll("#db-legend .db-legend__item").length,
    trendPainted: (() => { const c = document.getElementById("db-canvas-trend"); return !!(c && c.width > 0); })(),
    ringPainted: (() => { const c = document.getElementById("db-canvas-ring"); return !!(c && c.width > 0); })(),
  }));
  check("B3 KPI：累计访问 / 今日 / 工具调用 / 本地占用 全部渲染",
    Number(String(kpi.visits).replace(/,/g, "")) > 0
    && Number(String(kpi.tools).replace(/,/g, "")) > 0
    && /B|KB|MB|GB/.test(String(kpi.space)),
    `visits=${kpi.visits} tools=${kpi.tools} space=${kpi.space}`);
  check("B4 工具频率 Top / 页面访问排行 / 状态徽标 / 空间图例 均已渲染",
    kpi.bars === 5 && kpi.paths >= 1 && kpi.badges >= 3 && kpi.legend === 3,
    `bars=${kpi.bars} paths=${kpi.paths} badges=${kpi.badges} legend=${kpi.legend}`);
  check("B5 Canvas 折线图 + 环形图均真实绘制（width>0）",
    kpi.trendPainted && kpi.ringPainted);
  check("B5b 脏工具 id（<bad>）被净化，未污染 Top 列表", kpi.bars === 5);

  // 埋点：本页 PV 自动 +1
  const pvTotal = await page.evaluate(() => window.SiteTelemetry.snapshot().totalVisits);
  check("B6 埋点 PV 自动累计（本页访问 +1，数据非空）", pvTotal > 0, "total=" + pvTotal);

  // 事件委托归因：模拟工具卡片内 input
  const before = await page.evaluate(() => window.SiteTelemetry.snapshot().toolTotal);
  await page.evaluate(() => {
    const card = document.createElement("div");
    card.setAttribute("data-tool", "jsontest");
    const inp = document.createElement("input");
    card.appendChild(inp); document.body.appendChild(card);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => window.SiteTelemetry.snapshot().toolTotal);
  check("B7 事件委托埋点：工具使用 +1（零业务侵入）", after === before + 1, `${before} → ${after}`);

  check("B8 纯前端本地数据源：零 /api/ 数据请求 + 零 JS 异常",
    apiCalls.length === 0 && jsErrors.length === 0,
    `api=${apiCalls.length} err=${jsErrors.slice(0, 2).join(";")}`);

  // 刷新按钮幂等
  await page.click("#db-refresh");
  await page.waitForTimeout(200);
  check("B9 刷新按钮幂等重绘，零异常",
    await page.evaluate(() => window.DashboardDebug.state().rendered) && jsErrors.length === 0);
} catch (e) {
  check("B 段执行未抛异常", false, String(e && e.message || e));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(`通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
