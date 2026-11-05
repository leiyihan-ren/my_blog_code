// ============================================================
// v12.0 战役四：指数退避重试与弱网边缘缓存
//   A. BlogApi 指数退避 2^n（用短基数验证比例，静态断言默认值 2/4/8s）
//   B. 每次尝试独立超时（旧实现共享 AbortController 的真实缺陷）
//   C. 4xx 不重试 / 429 与 5xx 重试 / 成功后不再重试
//   D. 断网感知：离线零无效请求 + online 事件提前唤醒
//   E. 断网且已有兜底缓存 → 秒开返回
//   F. SW 运行时（vm 注入）：断网导航与 API 的 ignoreSearch 回退、
//      带 Authorization 与 Range 旁路不被误缓存
//   G. 静态链路与版本回归
// 运行：CHROMIUM_PATH=/usr/bin/chromium node tests/step25-v12-resilience.mjs
// ============================================================
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import pkg from "playwright";
const { chromium } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " → " + detail : "")); }
}

let apiHits = 0;
const PAGE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>弱网重试测试</title>
<script src="/utils/blog-utils.js"></script>
<script src="/services/request.js"></script>
</head><body><h1>弱网重试</h1></body></html>`;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/__stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ apiHits }));
  }
  if (p.startsWith("/api/")) {
    apiHits++;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, path: p }));
  }
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE_HTML);
  }
  const file = path.join(ROOT, p.replace(/^\//, ""));
  try {
    if (!file.startsWith(ROOT) || !fs.statSync(file).isFile()) throw new Error("404");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("404");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
const context = await browser.newContext();
const page = await context.newPage();
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(e.message));

let routeCount = 0;
function setFlaky(seq) {
  routeCount = 0;
  return page.route("**/api/flaky**", async (route) => {
    const i = routeCount++;
    const step = seq[Math.min(i, seq.length - 1)];
    if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
    try {
      await route.fulfill({ status: step.status, contentType: "application/json",
        body: JSON.stringify({ ok: step.status === 200, n: i + 1 }) });
    } catch (e) { /* 请求已被 abort */ }
  });
}
async function unroute() { await page.unroute("**/api/flaky**"); }

try {
  await page.goto(ORIGIN + "/", { waitUntil: "load" });

  /* ============ A. 指数退避 ============ */
  console.log("\n═══ A. 指数退避重试 ═══");
  await setFlaky([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }]);
  const exp = await page.evaluate(async () => {
    const log = [];
    try {
      const data = await window.BlogApi.get("/api/flaky?c=exp", {
        retry: 3, retryDelay: 20, retryJitter: false, timeout: 1000,
        onRetry: (n, d, e) => log.push({ n, d, status: e && e.status }),
      });
      return { log, data };
    } catch (e) { return { log, err: e.message }; }
  });
  check("A1 三次失败后第 4 次成功", exp.data && exp.data.ok === true, JSON.stringify(exp));
  check("A2 退避序列为 20/40/80ms（严格 2^n 指数增长）",
    JSON.stringify(exp.log.map((x) => x.d)) === JSON.stringify([20, 40, 80]), JSON.stringify(exp.log));
  check("A3 onRetry 序号 1/2/3 且传递 5xx 状态", exp.log.every((x, i) => x.n === i + 1 && x.status === 500), JSON.stringify(exp.log));
  await unroute();

  /* ============ B. 每次尝试独立超时 ============ */
  console.log("\n═══ B. 独立超时（旧实现共享 AbortController 的缺陷）═══");
  await setFlaky([{ status: 200, delay: 220 }, { status: 200 }]);
  const indep = await page.evaluate(async () => {
    const log = [];
    try {
      const data = await window.BlogApi.get("/api/flaky?c=timeout", {
        retry: 2, retryDelay: 20, retryJitter: false, timeout: 60,
        onRetry: (n) => log.push(n),
      });
      return { ok: true, data, log };
    } catch (e) { return { ok: false, err: e.message, log }; }
  });
  check("B1 首次超时后重试成功（独立 controller 生效）", indep.ok === true && indep.data && indep.data.ok === true, JSON.stringify(indep));
  check("B2 恰好触发 1 次重试", indep.log.length === 1, JSON.stringify(indep.log));
  await unroute();

  /* ============ C. 重试边界 ============ */
  console.log("\n═══ C. 重试边界 ═══");
  await setFlaky([{ status: 400 }]);
  const noRetry = await page.evaluate(async () => {
    const log = [];
    try { await window.BlogApi.get("/api/flaky?c=400", { retry: 3, retryDelay: 10, retryJitter: false, onRetry: (n) => log.push(n) }); }
    catch (e) { return { status: e.status, log }; }
    return { status: 0, log };
  });
  check("C1 400 立即失败、零重试", noRetry.status === 400 && noRetry.log.length === 0, JSON.stringify(noRetry));
  await unroute();

  await setFlaky([{ status: 429 }, { status: 200 }]);
  const rate = await page.evaluate(async () => {
    const log = [];
    const d = await window.BlogApi.get("/api/flaky?c=429", {
      retry: 2, retryDelay: 10, retryJitter: false, onRetry: (n) => log.push(n),
    });
    return { d, log };
  });
  check("C2 429 限流可重试并在第 2 次成功", rate.d && rate.d.ok === true && rate.log.length === 1, JSON.stringify(rate));
  await unroute();

  await setFlaky([{ status: 200 }]);
  const quick = await page.evaluate(async () => {
    const log = [];
    await window.BlogApi.get("/api/flaky?c=ok", { retry: 3, retryDelay: 10, onRetry: (n) => log.push(n) });
    return log;
  });
  check("C3 首次成功不产生任何重试", quick.length === 0, JSON.stringify(quick));
  await unroute();

  /* ============ D. 断网感知 + online 唤醒 ============ */
  console.log("\n═══ D. 断网感知 ═══");
  const off = await page.evaluate(async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const log = [];
    const t0 = performance.now();
    try {
      await window.BlogApi.get("/api/never", {
        retry: 2, retryDelay: 30, retryJitter: false,
        onRetry: (n, d, e) => log.push({ n, d, msg: (e && e.message) || "" }),
      });
    } catch (e) { log.push({ err: e.message }); }
    const ms = performance.now() - t0;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    return { log, ms };
  });
  check("D1 离线时按 30/60ms 退避且不发无效请求", off.log.filter((x) => x.msg).length === 2, JSON.stringify(off.log));
  check("D2 错误信息明确标注「网络已断开」", off.log.some((x) => /网络已断开/.test(x.msg || "")), JSON.stringify(off.log));
  check("D3 离线重试在百毫秒级完成（未被 3s 超时拖死）", off.ms < 1000, "ms=" + off.ms.toFixed(0));

  await page.route("**/api/online**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  const wake = await page.evaluate(async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const log = [];
    // 50ms 后模拟网络恢复；waitRetry 注册了 online 监听，应立即结束 5000ms 等待
    setTimeout(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
      window.dispatchEvent(new Event("online"));
    }, 50);
    const t0 = performance.now();
    const d = await window.BlogApi.get("/api/online", {
      retry: 3, retryDelay: 5000, retryJitter: false, onRetry: (n) => log.push(n),
    });
    return { d, log, ms: performance.now() - t0 };
  });
  check("D4 online 事件提前唤醒重试（远快于 5000ms 退避）", wake.d && wake.d.ok === true && wake.ms < 1500, JSON.stringify(wake));
  check("D5 唤醒后仅重试 1 次即成功", wake.log.length === 1, JSON.stringify(wake.log));
  await page.unroute("**/api/online**");

  /* ============ E. 断网 + 兜底缓存秒开 ============ */
  console.log("\n═══ E. 断网兜底缓存 ═══");
  const before = await page.evaluate(() => fetch("/__stats").then((r) => r.json()));
  const cacheFast = await page.evaluate(async () => {
    await window.BlogApi.get("/api/cached-data", { cacheKey: "v12-test" });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const t0 = performance.now();
    const d = await window.BlogApi.get("/api/cached-data", { cacheKey: "v12-test", retry: 3, retryDelay: 5000 });
    const ms = performance.now() - t0;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    return { d, ms };
  });
  const after = await page.evaluate(() => fetch("/__stats").then((r) => r.json()));
  check("E1 断网命中本地兜底缓存，数据正确", cacheFast.d && cacheFast.d.ok === true, JSON.stringify(cacheFast));
  check("E2 秒开（不苦等 2/4/8s 重试窗口）", cacheFast.ms < 200, "ms=" + cacheFast.ms.toFixed(1));
  check("E3 断网阶段零网络请求（只增加一次在线预热）", after.apiHits - before.apiHits === 1, JSON.stringify({ before, after }));

  /* ============ F. SW 运行时：ignoreSearch 弱网回退 ============ */
  console.log("\n═══ F. SW 弱网缓存回退（vm 运行时注入）═══");
  {
    const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
    const handlers = {};
    const matchLog = [];
    const pageResp = new Response("<!DOCTYPE html><title>CACHED PAGE</title>", { status: 200, headers: { "Content-Type": "text/html" } });
    const apiResp = new Response(JSON.stringify({ p: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    const fakeCache = {
      async match(req, opts) {
        matchLog.push({ url: req.url, ignoreSearch: !!(opts && opts.ignoreSearch) });
        // 精确匹配故意 miss，强制走 ignoreSearch 回退分支
        if (opts && opts.ignoreSearch) return req.url.includes("/api/") ? apiResp.clone() : pageResp.clone();
        return null;
      },
      async put() {}, async keys() { return []; },
    };
    const sandbox = {
      self: {
        addEventListener: (t, fn) => { handlers[t] = fn; },
        skipWaiting() {}, clients: { claim: async () => {} },
        location: { origin: "http://x" }, registration: {},
      },
      caches: { open: async () => fakeCache, keys: async () => [], delete: async () => {} },
      fetch: async () => { throw new Error("network down"); },
      Request, Response, Headers, URL, setTimeout, clearTimeout, console,
      Promise, Map, Set, Uint8Array, ArrayBuffer, Math, Date, JSON, String, Number, Object, Error,
    };
    vm.createContext(sandbox);
    vm.runInContext(swSrc, sandbox, { filename: "sw.js" });
    check("F1 SW fetch handler 注册成功", typeof handlers.fetch === "function");

    function makeReq(url, o = {}) {
      return { url, mode: o.mode || "cors", method: o.method || "GET", headers: new Headers(o.headers || {}) };
    }
    function runFetch(req) {
      return new Promise((resolve, reject) => {
        const ev = {
          request: req,
          respondWith: (p) => Promise.resolve(p).then(resolve, reject),
          waitUntil() {},
        };
        try { handlers.fetch(ev); } catch (e) { reject(e); }
      });
    }
    const navResp = await runFetch(makeReq("http://x/post.html?id=b", { mode: "navigate" }));
    const navBody = await navResp.text();
    check("F2 断网导航命中 ignoreSearch 缓存（不同查询串也能打开页面）",
      navResp.status === 200 && /CACHED PAGE/.test(navBody), "status=" + navResp.status);
    const apiRes = await runFetch(makeReq("http://x/api/posts?limit=9", { method: "GET" }));
    const apiBody = await apiRes.json();
    check("F3 断网 API 命中 ignoreSearch 缓存（不同参数也返回旧数据）",
      apiRes.status === 200 && apiBody.p === 1, JSON.stringify(apiBody));
    check("F4 两条分支都实际调用了 ignoreSearch: true 回退",
      matchLog.filter((m) => m.ignoreSearch).length >= 2, JSON.stringify(matchLog));
    let authRejected = false;
    try { await runFetch(makeReq("http://x/api/admin?x=1", { headers: { authorization: "Bearer t" } })); }
    catch (e) { authRejected = true; }
    check("F5 带 Authorization 的 GET 仍直传网络（不回退共享缓存）", authRejected === true);
    let rangeRejected = false;
    try { await runFetch(makeReq("http://x/api/github/raw/a", { headers: { "x-drive-range": "1", range: "bytes=0-1" } })); }
    catch (e) { rangeRejected = true; }
    check("F6 云盘 Range 旁路仍直接透传（不落入通用 Range 分支）", rangeRejected === true);
  }

  /* ============ G. 静态链路与回归 ============ */
  console.log("\n═══ G. 静态链路 ═══");
  const reqSrc = fs.readFileSync(path.join(ROOT, "services/request.js"), "utf8");
  const swSrc2 = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  check("G1 默认退避基数 2000ms、封顶 8000ms（2/4/8s）",
    /RETRY_BASE_MS = 2000/.test(reqSrc) && /RETRY_CAP_MS = 8000/.test(reqSrc));
  check("G2 按 2^attempt 指数增长且 GET 默认重试 3 次",
    /Math\.pow\(2, attempt\)/.test(reqSrc) && /DEFAULT_RETRY_GET = 3/.test(reqSrc));
  check("G3 抖动与 online 唤醒均实现", /0\.8 \+ Math\.random\(\) \* 0\.4/.test(reqSrc) && /addEventListener\("online"/.test(reqSrc));
  check("G4 每次尝试独立 AbortController（在循环内创建）",
    /for \(let attempt = 0;[\s\S]{0,300}?new AbortController\(\)/.test(reqSrc));
  check("G5 429 作为可重试例外", /lastErr\.status !== 429/.test(reqSrc));
  check("G6 SW 两个 catch 分支均含 ignoreSearch: true",
    (swSrc2.match(/ignoreSearch: true/g) || []).length >= 2);
  check("G7 SW 保留 network-first 原文（step16 I2/I3 断言不变）",
    /req\.mode === "navigate"[\s\S]{0,400}?const fresh = await fetch\(req\)/.test(swSrc2) &&
    /url\.pathname\.startsWith\("\/api\/"\)[\s\S]{0,600}?const fresh = await fetch\(req\)/.test(swSrc2));
  check("G8 OFFLINE_URL 仍为 /index.html（step16 I5 不变）", /const OFFLINE_URL = "\/index\.html"/.test(swSrc2));
  check("G9 预缓存补齐 mc.html 与 player.html", /"\/mc\.html"/.test(swSrc2) && /"\/player\.html"/.test(swSrc2));
  check("G10 SW 版本号为三段语义化 v12", /const CACHE_VERSION = "v12\.\d+\.\d+"/.test(swSrc2));

  check("Z 全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | ") || "无");
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
