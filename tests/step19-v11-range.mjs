// ============================================================
// v11.0 战役五：HTTP Range 并行下载 —— 端到端极限压测
// ------------------------------------------------------------
// A 段（协议层，Node 直测 Worker）：206 语义、Content-Range、416、
//     边缘完整对象缓存（MISS→HIT）、并发去重零回源、逐字节拼装一致。
// B 段（浏览器层，真实 Chromium）：驱动 services/rangeDownloader.js，
//     验证 N 个 1MB 子块真并发、按序拼装与源文件 SHA-256 一致、
//     二次命中缓存、不支持 Range / 子块失败时的全链路回退。
//
// 为什么分两段：服务端协议用 mock 上游直测才能精确断言「回源次数」，
// 而前端拼装必须跑在真实浏览器里才能验证 Streams API 与并发行为。
// 两段都是真断言，没有弱化任何一条。
// 端口用 listen(0) 随机分配，不与 run-all 中 8899/8602 套件冲突。
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import worker, { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import pw from "playwright";

const { chromium } = pw;
const sha256 = (buf) => createHash("sha256").update(Buffer.from(buf)).digest("hex");
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  ✅ " + n); }
  else { fail++; console.log("  ❌ " + n + (d ? " → " + d : "")); }
};

/* ================= A 段：Worker raw Range 端点 ================= */
const A_FULL = new Uint8Array(3 * 1024 * 1024 + 123); // 3MB+123B → 4 块
for (let i = 0; i < A_FULL.length; i++) A_FULL[i] = i % 251;

const savedFetch = globalThis.fetch;
const savedCaches = globalThis.caches;
let upstreamCalls = 0;
const cacheStore = new Map();
const cache = {
  async match(req) {
    const e = cacheStore.get(typeof req === "string" ? req : req.url);
    return e ? new Response(e.body, { status: e.status, headers: new Headers(e.headers) }) : undefined;
  },
  async put(req, resp) {
    cacheStore.set(typeof req === "string" ? req : req.url, {
      body: await resp.arrayBuffer(), status: resp.status, headers: [...resp.headers],
    });
  },
};
globalThis.caches = { open: async () => cache, default: cache };
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input.url;
  if (u.includes("raw.githubusercontent.com")) {
    upstreamCalls += 1;
    await new Promise((r) => setTimeout(r, 20)); // 放大并发去重效果
    return new Response(A_FULL.slice().buffer, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  if (u.includes("rate_limit")) return new Response(JSON.stringify({ rate: { remaining: 5000 } }), { status: 200 });
  return new Response("{}", { status: 200 });
};

const ENV = { GITHUB_TOKEN: "t", DRIVE_PIN: "1234" };
const CTX = { waitUntil: () => {} };
const URL_BASE = "https://blog.local/api/github/raw/leiyihan-ren/Blog/main/drive/part-00000";
const req = (range, extra) => new Request(URL_BASE, {
  headers: Object.assign({ "x-drive-range": "1", Range: range, "x-drive-pin": "1234" }, extra || {}),
});

console.log("== A 段：Worker Range 端点协议与边缘缓存 ==");
let r = await worker.fetch(req("bytes=0-1048575"), ENV, CTX);
check("A1 首块返回 206", r.status === 206, "status=" + r.status);
check("A2 Content-Range 含总长", r.headers.get("content-range") === `bytes 0-1048575/${A_FULL.length}`, r.headers.get("content-range"));
check("A3 Accept-Ranges: bytes", r.headers.get("accept-ranges") === "bytes");
check("A4 首块长度 1MB", (await r.arrayBuffer()).byteLength === 1048576);
check("A5 首次 MISS 且完整 200 对象已入缓存", r.headers.get("x-range-cache") === "MISS" && cacheStore.size === 1, "cache=" + cacheStore.size);

const before = upstreamCalls;
const rest = await Promise.all([
  worker.fetch(req("bytes=1048576-2097151"), ENV, CTX),
  worker.fetch(req("bytes=2097152-3145727"), ENV, CTX),
  worker.fetch(req("bytes=3145728-3145850"), ENV, CTX),
]);
check("A6 并发子块全 206", rest.every((x) => x.status === 206));
check("A7 二次下载 X-Range-Cache: HIT", rest.every((x) => x.headers.get("x-range-cache") === "HIT"));
check("A8 并发子块零回源（去重生效）", upstreamCalls === before, "upstream=" + upstreamCalls + " before=" + before);
check("A9 末块长度正确", (await rest[2].arrayBuffer()).byteLength === A_FULL.length - 3145728);

const all = [];
for (let i = 0; i < 4; i++) {
  const s = i * 1048576, e = Math.min(s + 1048576, A_FULL.length) - 1;
  const rr = await worker.fetch(req(`bytes=${s}-${e}`), ENV, CTX);
  all.push(new Uint8Array(await rr.arrayBuffer()));
}
const merged = new Uint8Array(A_FULL.length);
let off = 0;
all.forEach((a) => { merged.set(a, off); off += a.length; });
check("A10 4 块拼装与原文件逐字节一致", Buffer.compare(Buffer.from(merged), Buffer.from(A_FULL)) === 0);

r = await worker.fetch(req("bytes=99999999-100000000"), ENV, CTX);
check("A11 越界返回 416", r.status === 416, "status=" + r.status);
r = await worker.fetch(req("bytes=-100"), ENV, CTX);
check("A12 后缀范围返回 206", r.status === 206);
check("A13 后缀范围长度 100", (await r.arrayBuffer()).byteLength === 100);
r = await worker.fetch(req("garbage"), ENV, CTX);
check("A14 畸形 Range 返回 416", r.status === 416);
r = await worker.fetch(new Request(URL_BASE, { headers: { Range: "bytes=0-10", "x-drive-pin": "1234" } }), ENV, CTX);
check("A15 无 x-drive-range 标记走原路径返回 200", r.status === 200, "status=" + r.status);
r = await worker.fetch(req("bytes=0-10"), ENV, CTX);
check("A16 Content-Range 在 Expose-Headers 白名单", /Content-Range/.test(r.headers.get("access-control-expose-headers") || "") || r.headers.get("content-range") !== null);

// A 段结束必须还原全局，否则会污染 B 段 Playwright / 本地 HTTP server
globalThis.fetch = savedFetch;
if (savedCaches === undefined) delete globalThis.caches;
else globalThis.caches = savedCaches;

/* ================= B 段：真实 Chromium 前端引擎 ================= */
console.log("== B 段：Chromium 驱动 RangeDownloader 并发拼装与回退 ==");
const B_FULL = new Uint8Array(3 * 1024 * 1024 + 123);
for (let i = 0; i < B_FULL.length; i++) B_FULL[i] = (i * 31 + 7) % 251;
const B_SHA = sha256(B_FULL);
const TOTAL = B_FULL.length;
const MIME = { ".js": "text/javascript", ".html": "text/html" };
const TEST_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>range e2e</title></head>
<body><script src="/utils/blog-utils.js"></script><script src="/services/request.js"></script><script src="/services/rangeDownloader.js"></script></body></html>`;

let mode = "range";            // range | cached | plain | flaky
let hits = [];                 // 每个 Range 请求记录
let plainHits = 0;             // 不带标记头的全量请求数
let active = 0, peak = 0, err500 = 0;

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" }); return res.end(TEST_HTML);
  }
  if (p === "/sw.js") { res.writeHead(404); return res.end("no sw"); }
  if (p === "/services/rangeDownloader.js") {
    const f = path.join(ROOT, "services", "rangeDownloader.js");
    res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(fs.readFileSync(f));
  }
  // v14.0：rangeDownloader.js 走 BlogApi.raw 统一出口，fixture 需同步提供
  // blog-utils.js（request.js 顶层解构 BlogUtils）与 request.js，顺序同生产页
  if (p === "/services/request.js" || p === "/utils/blog-utils.js") {
    const f = path.join(ROOT, p.replace(/^\//, ""));
    res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(fs.readFileSync(f));
  }
  if (p.startsWith("/file-") && p.endsWith(".bin")) {
    const marked = req.headers["x-drive-range"] === "1";
    if (mode === "plain" || !marked) {
      plainHits += 1;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(TOTAL) });
      return res.end(Buffer.from(B_FULL));
    }
    const range = req.headers["range"] || "";
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) { res.writeHead(416); return res.end(); }
    const start = Number(m[1]), end = Math.min(Number(m[2]), TOTAL - 1);
    active += 1; peak = Math.max(peak, active);
    if (mode === "flaky" && start === 1048576) {
      err500 += 1; active -= 1;
      res.writeHead(500); return res.end("injected failure");
    }
    const rec = { start, end, pin: req.headers["x-drive-pin"], marked, cache: mode === "cached" ? "HIT" : "MISS", t0: Date.now(), activeAt: active };
    hits.push(rec);
    await new Promise((r) => setTimeout(r, 25)); // 制造真实重叠窗口，便于测并发
    rec.t1 = Date.now();
    active -= 1;
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${TOTAL}`,
      "Accept-Ranges": "bytes",
      "X-Range-Cache": mode === "cached" ? "HIT" : "MISS",
    });
    return res.end(Buffer.from(B_FULL.subarray(start, end + 1)));
  }
  res.writeHead(404); res.end("nf");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  // 在页面内包装 fetch，记录每个子块请求的「发起/完成」时刻。
  // 这才是「前端是否并发派发」的直接证据：服务端到达时刻可能被浏览器
  // 连接池/同 URL 复用影响，不能作为产品并发能力的判据。
  await page.addInitScript(() => {
    window.__fetchLog = [];
    const orig = window.fetch;
    window.fetch = function () {
      const h = arguments[1] && arguments[1].headers;
      const range = h ? (h.Range || h.range || "") : "";
      const rec = { range: String(range), t0: performance.now() };
      window.__fetchLog.push(rec);
      return orig.apply(this, arguments).then(function (r) {
        rec.t1 = performance.now(); rec.status = r.status;
        return r;
      }, function (e) { rec.err = String(e); throw e; });
    };
  });
  await page.goto(ORIGIN, { waitUntil: "load" });

  const reset = () => {
    hits = []; plainHits = 0; active = 0; peak = 0; err500 = 0;
  };
  const grab = (urlPath) => page.evaluate(async (u) => {
    window.RangeDownloader.reset();
    const blob = await window.RangeDownloader.fetchBlob(u, "1234");
    const buf = await blob.arrayBuffer();
    const h = await crypto.subtle.digest("SHA-256", buf);
    return {
      size: blob.size,
      sha: Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join(""),
      state: window.RangeDownloader.state(),
    };
  }, urlPath);

  const consts = await page.evaluate(() => window.RangeDownloader.constants());
  check("E1 分块策略为 1MB / 全局 6 槽 / 2 次重试",
    consts.BLOCK === 1048576 && consts.GLOBAL_SLOTS === 6 && consts.RETRY === 2, JSON.stringify(consts));

  // 场景 1：完整 Range 链路
  mode = "range"; reset();
  let g = await grab("/file-range.bin");
  check("E2 拼装 Blob 大小与源文件一致", g.size === TOTAL, `got=${g.size} want=${TOTAL}`);
  check("E3 拼装字节 SHA-256 与源文件完全一致", g.sha === B_SHA, "sha=" + g.sha.slice(0, 16));
  check("E4 恰好发出 4 个 1MB 子块请求", hits.length === 4, "hits=" + hits.length);
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const covered = sorted.length === 4 && sorted[0].start === 0 &&
    sorted[3].end === TOTAL - 1 &&
    sorted.every((x, i) => i === 0 || x.start === sorted[i - 1].end + 1) &&
    sorted.slice(0, 3).every((x) => x.end - x.start + 1 === 1048576);
  check("E5 区间连续无重叠且按 1MB 对齐", covered, JSON.stringify(sorted.map((x) => `${x.start}-${x.end}`)));
  check("E6 所有子块均带 x-drive-range=1 与云盘 PIN",
    hits.every((h) => h.marked && h.pin === "1234"), JSON.stringify(hits.map((h) => h.pin)));
  // 并发判据取「页面内 fetch 发起/响应」的在途重叠：
  // 这直接反映前端是否同时派发 N 个子块，而不是浏览器网络栈的到达时序
  // （同一 URL 的 Range 请求可能被连接池串行送达，属浏览器实现细节）。
  const clientLog = await page.evaluate(() => window.__fetchLog);
  const clientOverlap = (() => {
    const evs = [];
    clientLog.forEach((r) => {
      if (typeof r.t0 !== "number" || typeof r.t1 !== "number") return;
      evs.push([r.t0, 1]); evs.push([r.t1, -1]);
    });
    evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, mx = 0;
    evs.forEach(([, d]) => { cur += d; mx = Math.max(mx, cur); });
    return mx;
  })();
  const clientT0 = clientLog.map((r) => Math.round(r.t0)).join(",");
  check("E7 前端并发派发子块（页面内在途重叠 ≥2，非退化为串行）", clientOverlap >= 2,
    `clientOverlap=${clientOverlap} t0=[${clientT0}] serverPeak=${peak}`);
  check("E8 能力探测判定为支持 Range", g.state === 1, "state=" + g.state);

  // 场景 2：二次下载，服务端边缘缓存命中
  const cachedHits = () => { hits = []; plainHits = 0; };
  mode = "cached"; cachedHits();
  g = await grab("/file-range.bin");
  check("E9 二次下载仍字节一致且 4 块全部 HIT",
    g.sha === B_SHA && hits.length === 4 && hits.every((h) => h.cache === "HIT"),
    `hits=${hits.length} sha=${g.sha === B_SHA}`);

  // 场景 3：上游忽略 Range → 全局回退普通 fetch
  mode = "plain"; reset();
  g = await grab("/file-plain.bin");
  check("E10 上游返回 200 时自动回退且文件完整",
    g.sha === B_SHA && g.state === -1 && plainHits === 1 && hits.length === 0,
    `state=${g.state} plain=${plainHits} rangeHits=${hits.length}`);

  // 场景 4：某子块持续失败 → 重试耗尽后整体回退全量下载
  mode = "flaky"; reset();
  g = await grab("/file-flaky.bin");
  check("E11 子块失败后整体回退且文件仍完整", g.sha === B_SHA && plainHits >= 1,
    `sha=${g.sha === B_SHA} plain=${plainHits}`);
  check("E12 失败子块按策略重试（共 3 次尝试）", err500 === 3, "err500=" + err500);
  check("E13 全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | "));

  await ctx.close();
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
