// ============================================================
// 线上全页面巡检实测（阶段一）
//   真实访问线上环境，逐页抓取：
//   - Web Vitals：TTFB / FCP / LCP / DOMContentLoaded / load
//   - Network 瀑布流：每请求耗时、状态、pending / failed
//   - 重点标记 /api/*（Worker → GitHub）的端到端耗时与缓存头
//   - 输出《全页面诊断报告》markdown
// 运行：DRIVE_PIN=xxx CHROMIUM_PATH=/usr/bin/chromium node tests/_perf-audit.mjs
// ============================================================
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.AUDIT_BASE || "https://leiyihan.pages.dev";
const PIN = process.env.DRIVE_PIN || "";
const SETTLE_MS = 4000; // 导航后再等异步 API 落地
const NAV_TIMEOUT = 45000;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

/* 先看线上有哪些文章，用于文章详情页实测 */
let firstPostId = "";
try {
  const r = await fetch(`${BASE}/api/posts`, { timeout: 15000 }).catch(() => null);
  if (r && r.ok) {
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.data || [];
    if (list.length) firstPostId = String(list[0].id || list[0].slug || "");
  }
} catch { /* 忽略：拿不到就用无参数 URL */ }

const PAGES = [
  { name: "首页", path: "/index.html" },
  { name: "文章列表", path: "/blog.html" },
  { name: "文章详情", path: firstPostId ? `/post.html?id=${encodeURIComponent(firstPostId)}` : "/post.html" },
  { name: "相册", path: "/album.html" },
  { name: "网盘", path: "/drive.html", pin: true },
  { name: "小游戏", path: "/games.html" },
];

const results = [];

for (const p of PAGES) {
  const page = await browser.newPage();
  const t0 = Date.now();
  const recs = new Map(); // Request -> record
  const consoleErrors = [];

  await page.addInitScript(() => {
    window.__perf = { paints: {}, lcp: null };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__perf.paints[e.name] = Math.round(e.startTime);
      }).observe({ type: "paint", buffered: true });
    } catch { /* ignore */ }
    try {
      new PerformanceObserver((l) => {
        const es = l.getEntries();
        const last = es[es.length - 1];
        window.__perf.lcp = Math.round(last.startTime);
        /* 记录 LCP 元素本身：只知道「LCP 3.4s」没有行动价值，
         * 必须知道「是谁钉住了首屏」——是某张图、某个标题，还是背景块。
         * 优化只有打在真正的 LCP 元素上才会体现在数字上。 */
        const el = last.element;
        if (el) {
          const cls = typeof el.className === "string" && el.className.trim()
            ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
            : "";
          window.__perf.lcpEl = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
        } else if (last.url) {
          window.__perf.lcpEl = "url:" + String(last.url).split("/").pop().slice(0, 60);
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch { /* ignore */ }
  });

  page.on("request", (r) => {
    recs.set(r, {
      url: r.url(), method: r.method(), type: r.resourceType(),
      start: Date.now() - t0, status: null, end: null, failed: false, api: false, headers: null,
    });
  });
  page.on("response", (r) => {
    const rec = recs.get(r.request());
    if (!rec) return;
    rec.status = r.status();
    rec.api = /\/api\//.test(new URL(r.url()).pathname);
    try {
      const h = r.headers();
      rec.cache = h["cf-cache-status"] || h["x-cache"] || "";
      rec.age = h["age"] || "";
      rec.serverTiming = h["server-timing"] || "";
    } catch { /* ignore */ }
  });
  page.on("requestfinished", (r) => {
    const rec = recs.get(r);
    if (rec && rec.end == null) rec.end = Date.now() - t0;
  });
  page.on("requestfailed", (r) => {
    const rec = recs.get(r);
    if (rec) { rec.end = Date.now() - t0; rec.failed = true; rec.status = rec.status || "FAILED"; }
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });

  let navErr = "";
  try {
    await page.goto(BASE + p.path, { waitUntil: "load", timeout: NAV_TIMEOUT });
  } catch (e) {
    navErr = String(e.message || e).slice(0, 120);
  }

  // 网盘页需口令解锁才会发起 /api/drive/list
  if (p.pin && PIN) {
    try {
      await page.waitForSelector("#pinModal.show", { timeout: 10000 });
      await page.fill("#pinInput", PIN);
      await page.click("#btnPinOk");
    } catch { /* 已解锁或模态未出现 */ }
  }

  await page.waitForTimeout(SETTLE_MS);

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] || {};
    const res = performance.getEntriesByType("resource") || [];
    const R = (v) => (typeof v === "number" ? Math.round(v) : null);
    return {
      ttfb: R(n.responseStart),
      dcl: R(n.domContentLoadedEventEnd),
      load: R(n.loadEventEnd),
      fcp: window.__perf.paints["first-contentful-paint"] ?? null,
      lcp: window.__perf.lcp,
      lcpEl: window.__perf.lcpEl || "",
      transfer: R(n.transferSize),
      resCount: res.length,
      resBytes: R(res.reduce((s, x) => s + (x.transferSize || 0), 0)),
    };
  }).catch(() => ({ ttfb: null, dcl: null, load: null, fcp: null, lcp: null, transfer: null, resCount: 0, resBytes: 0 }));

  const list = [...recs.values()].map((r) => ({ ...r, dur: r.end == null ? null : r.end - r.start }));
  const finished = list.filter((r) => r.dur != null);
  const pending = list.filter((r) => r.dur == null);
  const failed = list.filter((r) => r.failed);
  const apiReqs = list.filter((r) => r.api);
  const slowest = finished.slice().sort((a, b) => b.dur - a.dur).slice(0, 3)
    .map((r) => `${Math.round(r.dur)}ms ${r.method} ${r.url.replace(BASE, "")}`);
  const apiSlowest = apiReqs.filter((r) => r.dur != null).slice().sort((a, b) => b.dur - a.dur)
    .map((r) => ({ url: r.url.replace(BASE, ""), dur: Math.round(r.dur), status: r.status, cache: r.cache, age: r.age }));

  /* 重复请求：同 method+url 发起多次（阶段四要去重） */
  const dupMap = new Map();
  for (const r of list) { const k = r.method + " " + r.url; dupMap.set(k, (dupMap.get(k) || 0) + 1); }
  const dups = [...dupMap.entries()].filter(([, c]) => c > 1)
    .map(([k, c]) => ({ url: k.replace(BASE, ""), count: c }));

  /* 静态资源（非 API）边缘缓存命中情况 */
  const statics = list.filter((r) => !r.api && /(html|css|js|png|jpg|svg|ico|woff2?)$/i.test(new URL(r.url).pathname));
  const hit = statics.filter((r) => /HIT|REVALIDATED/i.test(r.cache || "")).length;

  /* 第三方域耗时（非本站、非 API） */
  const thirdParty = list.filter((r) => {
    try { return new URL(r.url()).host !== new URL(BASE).host; } catch { return false; }
  });
  const tpTop = thirdParty.filter((r) => r.dur != null).sort((a, b) => b.dur - a.dur).slice(0, 2)
    .map((r) => `${Math.round(r.dur)}ms ${r.url.slice(0, 60)}`);

  const failedList = failed.map((r) => `${r.method} ${r.url.slice(0, 80)}${r.status ? " [" + r.status + "]" : ""}`);

  results.push({
    name: p.name, path: p.path, nav, navErr,
    total: list.length, pending: pending.length, failed: failed.length,
    slowest, apiReqs: apiSlowest, consoleErrors: consoleErrors.slice(0, 3),
    pendingList: pending.slice(0, 5).map((r) => r.url.replace(BASE, "")),
    dups, statics: statics.length, staticsHit: hit, tpTop, failedList: failedList.slice(0, 3),
  });

  console.log(`\n== ${p.name} (${p.path}) ==`);
  console.log(`  TTFB=${nav.ttfb}ms FCP=${nav.fcp}ms LCP=${nav.lcp}ms DCL=${nav.dcl}ms LOAD=${nav.load}ms`);
  if (nav.lcpEl) console.log(`  🎯 LCP 元素: ${nav.lcpEl}`);
  console.log(`  请求 ${list.length} 个｜pending ${pending.length}｜failed ${failed.length}｜API ${apiReqs.length}`);
  console.log(`  最慢: ${slowest.join(" ｜ ") || "无"}`);
  apiSlowest.forEach((a) => console.log(`  API ${a.dur}ms [${a.status}] ${a.url}${a.cache ? " cache=" + a.cache : ""}${a.age ? " age=" + a.age : ""}`));
  console.log(`  静态 ${statics.length} 个（边缘命中 ${hit}）｜第三方最慢: ${tpTop.join(" ｜ ") || "无"}`);
  if (dups.length) console.log(`  ⚠️ 重复请求: ${dups.map((d) => d.count + "× " + d.url).join(" ｜ ")}`);
  if (failedList.length) console.log(`  ❌ 失败请求: ${failedList.join(" ｜ ")}`);
  if (consoleErrors.length) console.log(`  JS 错误: ${consoleErrors.slice(0, 2).join(" | ")}`);

  await page.close();
}

await browser.close();

/* ---------- 汇总 ---------- */
const ranked = results.slice().sort((a, b) => (b.nav.lcp ?? b.nav.load ?? 0) - (a.nav.lcp ?? a.nav.load ?? 0));
console.log(`\n=========== 汇总：最慢页面 TOP3 ===========`);
ranked.slice(0, 3).forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.name}：LCP=${r.nav.lcp}ms LOAD=${r.nav.load}ms 请求=${r.total} pending=${r.pending} API=${r.apiReqs.length}`);
});

/* ---------- markdown 报告 ---------- */
const md = [];
md.push("# 线上全页面诊断报告（阶段一实测）");
md.push("");
md.push(`- 基线站点：\`${BASE}\``);
md.push(`- 采集时间：${new Date().toISOString()}`);
md.push(`- 采集方式：Playwright 真实访问，\`waitUntil=load\` + 静置 ${SETTLE_MS}ms，逐请求计时`);
md.push("");
md.push("## 一、逐页指标");
md.push("");
md.push("| 页面 | TTFB | FCP | LCP | DCL | LOAD | 请求数 | Pending | Failed | API 数 |");
md.push("|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  md.push(`| ${r.name} | ${r.nav.ttfb ?? "—"}ms | ${r.nav.fcp ?? "—"}ms | ${r.nav.lcp ?? "—"}ms | ${r.nav.dcl ?? "—"}ms | ${r.nav.load ?? "—"}ms | ${r.total} | ${r.pending} | ${r.failed} | ${r.apiReqs.length} |`);
}
md.push("");
md.push("## 二、每页最慢请求 TOP3");
md.push("");
for (const r of results) {
  md.push(`### ${r.name}`);
  md.push("");
  if (!r.slowest.length) md.push("- （无已完成请求）");
  else r.slowest.forEach((s) => md.push(`- \`${s}\``));
  if (r.apiReqs.length) {
    md.push("");
    md.push("Worker→GitHub 接口耗时：");
    md.push("");
    md.push("| 接口 | 耗时 | 状态 | 边缘缓存 | age |");
    md.push("|---|---|---|---|---|");
    r.apiReqs.forEach((a) => md.push(`| \`${a.url}\` | ${a.dur}ms | ${a.status} | ${a.cache || "—"} | ${a.age || "—"} |`));
  }
  md.push("");
  md.push(`静态资源 ${r.statics} 个，边缘缓存命中 ${r.staticsHit} 个；第三方最慢：${r.tpTop.join(" ｜ ") || "无"}`);
  if (r.dups.length) {
    md.push("");
    md.push(`⚠️ **重复请求**：${r.dups.map((d) => `${d.count}× \`${d.url}\``).join("、")}`);
  }
  if (r.failedList.length) {
    md.push("");
    md.push(`❌ 失败请求：${r.failedList.map((f) => `\`${f}\``).join("、")}`);
  }
  if (r.pendingList.length) {
    md.push("");
    md.push(`⚠️ 悬挂请求（${r.pending}）：${r.pendingList.map((u) => `\`${u}\``).join("、")}`);
  }
  if (r.consoleErrors.length) {
    md.push("");
    md.push(`JS 错误：${r.consoleErrors.join(" ｜ ")}`);
  }
  md.push("");
}
md.push("## 三、结论：谁最慢、卡在哪");
md.push("");
ranked.slice(0, 3).forEach((r, i) => {
  md.push(`${i + 1}. **${r.name}**（LCP ${r.nav.lcp ?? "—"}ms / LOAD ${r.nav.load ?? "—"}ms）：` +
    `${r.apiReqs.length ? `API ${r.apiReqs.length} 个，最慢 ${r.apiReqs[0] ? r.apiReqs[0].dur + "ms" : "—"}` : "无 API 请求"}；` +
    `${r.slowest[0] ? `最慢资源 ${r.slowest[0]}` : "无明显慢资源"}`);
});
const allApi = results.flatMap((r) => r.apiReqs);
if (allApi.length) {
  const sorted = allApi.slice().sort((a, b) => b.dur - a.dur);
  const avg = Math.round(allApi.reduce((s, x) => s + x.dur, 0) / allApi.length);
  md.push("");
  md.push(`- Worker→GitHub 接口**平均 ${avg}ms**，最慢 ${sorted[0].dur}ms（\`${sorted[0].url}\`）`);
  const dyn = allApi.filter((a) => a.cache && !/HIT|REVALIDATED/i.test(a.cache)).length;
  md.push(`- 未命中边缘缓存的接口：${dyn}/${allApi.length}`);
}
fs.writeFileSync("docs/线上全页面诊断报告.md", md.join("\n"));
console.log("\n✅ 报告已写入 docs/线上全页面诊断报告.md");
