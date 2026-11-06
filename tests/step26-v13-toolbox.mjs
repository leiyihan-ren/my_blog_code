// ============================================================
// 步骤 26：v13.0 极客工具箱端到端验证
// ------------------------------------------------------------
// A. Worker 端点：SSRF 防护 / HEAD 降级 / no-store / IP 缓存与降级
// B. 浏览器 7 工具：结果正确性 / 防抖 / 卡片折叠 / 统一 API 封装 / 375px 无溢出
// 运行：node tests/step26-v13-toolbox.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pkg from "playwright";
const { chromium } = pkg;

let pass = 0, fail = 0;
const findings = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
 * A. Worker 后端端点（Node 层，上游 fetch 全量 mock，不依赖外网）
 * ============================================================ */
console.log("\n═══ A. Worker /api/toolbox/* ═══");
const realFetch = globalThis.fetch;
const upstreamCalls = [];
let headStatus = 200;
let ipUpstreamOk = true;
globalThis.fetch = async (input, init) => {
  const u = String((input && input.url) || input);
  const method = (input && input.method) || (init && init.method) || "GET";
  upstreamCalls.push({ url: u, method, headers: (init && init.headers) || {} });
  if (u.startsWith("https://ipwho.is/")) {
    if (!ipUpstreamOk) throw new Error("ipwho.is unreachable");
    return new Response(JSON.stringify({
      ip: "8.8.8.8", success: true, country: "美国", region: "California",
      city: "Mountain View", continent: "North America",
      connection: { asn: 15169, org: "Google LLC", isp: "Google LLC" },
      timezone: { id: "America/Los_Angeles" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.startsWith("http://ip-api.com/")) {
    if (!ipUpstreamOk) throw new Error("ip-api.com unreachable");
    return new Response(JSON.stringify({
      status: "success", query: "8.8.8.8", country: "美国", regionName: "California",
      city: "Mountain View", isp: "Google LLC", org: "Google LLC", as: "AS15169",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.startsWith("https://example.com")) {
    return new Response(null, {
      status: headStatus, statusText: headStatus === 200 ? "OK" : "Method Not Allowed",
      headers: { server: "nginx", "content-type": "text/html", "set-cookie": "SECRET=never-leak" },
    });
  }
  return new Response(null, { status: 502 });
};

const ENV = { ASSETS: { fetch: async () => new Response("nf", { status: 404 }) } };
const CTX = { waitUntil() {} };
async function wget(p, headers, method) {
  const r = await worker.fetch(new Request("https://leiyihan.dpdns.org" + p, { method: method || "GET", headers: headers || {} }), ENV, CTX);
  let body = null;
  try { body = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, body, headers: r.headers };
}

{
  const evil = [
    "http://127.0.0.1", "http://2130706433", "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1", "http://192.168.1.1", "http://172.16.0.1", "http://100.64.0.1",
    "http://[::1]", "http://[fd00::1]", "http://localhost", "http://foo.local",
    "http://metadata.google.internal", "ftp://example.com", "http://user:pw@example.com",
    "http://example.com:8080", "https://leiyihan.dpdns.org/", "http://224.0.0.1",
  ];
  let blocked = 0;
  for (const e of evil) {
    const r = await wget("/api/toolbox/probe?url=" + encodeURIComponent(e));
    if (r.status === 400 && r.body && r.body.code === "INVALID_URL") blocked++;
  }
  check(`SSRF 防护拦截 ${evil.length} 种内网/回环/保留域/本站绕过`, blocked === evil.length,
    `拦截 ${blocked}/${evil.length}`);

  const ok = await wget("/api/toolbox/probe?url=" + encodeURIComponent("https://example.com"));
  check("合法 URL 探测返回 200 + 真实状态码", ok.status === 200 && ok.body.httpStatus === 200,
    `httpStatus=${ok.body && ok.body.httpStatus}`);
  check("默认使用 HEAD 且不下载正文", ok.body.method === "HEAD", ok.body.method);
  check("响应带白名单响应头", ok.body.headers && ok.body.headers.server === "nginx");
  check("绝不透传 Set-Cookie", !JSON.stringify(ok.body).includes("never-leak"));
  check("探测响应 no-store", ok.headers.get("cache-control") === "no-store");
  check("统一入口附加 X-Response-Time", !!ok.headers.get("x-response-time"));

  headStatus = 405;
  const fallback = await wget("/api/toolbox/probe?url=" + encodeURIComponent("https://example.com"));
  check("HEAD 405 自动降级 Range GET", fallback.body.method === "GET+Range", fallback.body.method);
  check("降级请求带 Range: bytes=0-0", upstreamCalls.some((c) => c.headers && c.headers.Range === "bytes=0-0"));
  headStatus = 200;

  const ip = await wget("/api/toolbox/ipinfo", { "CF-Connecting-IP": "8.8.8.8" });
  check("IP 查询返回访客视角", ip.status === 200 && ip.body.scope === "visitor", ip.body.scope);
  check("归属地 / ISP / ASN 字段映射正确",
    ip.body.city === "Mountain View" && ip.body.isp === "Google LLC" && ip.body.asn === "AS15169",
    `${ip.body.city} / ${ip.body.isp} / ${ip.body.asn}`);
  check("IP 响应 no-store（防跨访客串号）", ip.headers.get("cache-control") === "no-store");
  const before = upstreamCalls.length;
  const ip2 = await wget("/api/toolbox/ipinfo", { "CF-Connecting-IP": "8.8.8.8" });
  check("同 IP 二次查询命中内存缓存", ip2.body.cached === true && upstreamCalls.length === before,
    `新增上游调用 ${upstreamCalls.length - before}`);
  const egress = await wget("/api/toolbox/ipinfo");
  check("无 CF-Connecting-IP 时诚实降级为出口视角", egress.body.scope === "egress" && /出口/.test(egress.body.message || ""));

  ipUpstreamOk = false;
  const down = await wget("/api/toolbox/ipinfo", { "CF-Connecting-IP": "1.1.1.1" });
  check("上游全挂返回 unavailable 而非 500", down.status === 200 && down.body.status === "unavailable",
    down.body.code);
  check("unavailable 保留尝试记录便于排障", Array.isArray(down.body.attempts) && down.body.attempts.length === 2);
  ipUpstreamOk = true;

  const nf = await wget("/api/toolbox/nope");
  check("未知工具接口 404", nf.status === 404 && nf.body.code === "NOT_FOUND");
  const bad = await wget("/api/toolbox/ipinfo", {}, "POST");
  check("非 GET 方法 405", bad.status === 405 && bad.body.code === "METHOD_NOT_ALLOWED");
}
globalThis.fetch = realFetch;

/* ============================================================
 * B. 浏览器端 7 个工具
 * ============================================================ */
console.log("\n═══ B. 页面与 7 个工具 ═══");
const PORT = 8901;
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
};
const staticServer = http.createServer((req, res) => {
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
await new Promise((r) => staticServer.listen(PORT, "127.0.0.1", r));

const PROBE_OK = {
  status: "ok", code: "OK", url: "https://example.com/", method: "HEAD",
  httpStatus: 200, statusText: "OK", healthy: true, elapsed: 123,
  headers: { server: "nginx", "content-type": "text/html" },
  checkedAt: new Date().toISOString(), note: "测试 mock 响应",
};
const IP_OK = {
  status: "ok", scope: "visitor", source: "CF-Connecting-IP", provider: "ipwho.is",
  query: "203.0.113.7", country: "中国", region: "广东", city: "深圳",
  isp: "中国电信", org: "CHINANET", asn: "AS4134", timezone: "Asia/Shanghai",
  continent: "Asia", elapsed: 42, cached: false, message: "",
};
let probeResponse = PROBE_OK;
const apiCalls = [];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
// Service Worker 一旦控制页面，它内部 fetch() 发出的请求不会被 page.route 拦截
// （Playwright 只拦页面直发请求）。本套件需要在加载后点击按钮再发请求，
// 因此显式 block SW，保证 mock 覆盖到每一次 /api/toolbox/* 调用。
// 生产侧 SW 已在 /api/toolbox/ 分支直传网络并跳过缓存，见 sw.js。
const ctxMain = await browser.newContext({
  viewport: { width: 1280, height: 900 }, serviceWorkers: "block",
});
const page = await ctxMain.newPage();
const jsErrors = [];
const externalRequests = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
page.on("request", (r) => {
  if (!r.url().startsWith(`http://localhost:${PORT}/`) && !r.url().startsWith("data:")) {
    externalRequests.push(r.url());
  }
});
await page.route((u) => u.pathname.startsWith("/api/"), async (route) => {
  const u = new URL(route.request().url());
  apiCalls.push(u.pathname + u.search);
  const body = u.pathname === "/api/toolbox/probe" ? probeResponse
    : u.pathname === "/api/toolbox/ipinfo" ? IP_OK : {};
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});

try {
  await page.goto(`http://localhost:${PORT}/tools.html`, { waitUntil: "domcontentloaded" });
  await sleep(700); // 等 debounce 与自动 IP 查询完成

  const cards = await page.locator("[data-tool]").count();
  check("7 个工具卡片全部渲染", cards === 7, `cards=${cards}`);
  const navActive = await page.getAttribute('.nav-links a[href="/tools.html"]', "class");
  check("接入全局导航且高亮当前页", navActive === "active", String(navActive));
  check("页面加载零 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | ") || "无");
  check("前端工具零第三方/直连请求", externalRequests.length === 0,
    externalRequests.slice(0, 2).join(" | ") || "全部同源");

  /* --- 01 JSON --- */
  const jsonHtml = await page.innerHTML("#json-output");
  check("JSON 自动格式化并语法高亮", jsonHtml.includes("tb-tok-key") && jsonHtml.includes("tb-tok-str"));
  const jsonStatus0 = await page.textContent("#json-status");
  check("JSON 初始状态 VALID", /VALID/.test(jsonStatus0));
  await page.fill("#json-input", '{"broken": }');
  await page.waitForFunction(() => /ERROR/.test(document.getElementById("json-status").textContent), null, { timeout: 3000 });
  check("非法 JSON 给出明确错误而非崩溃", /ERROR/.test(await page.textContent("#json-status")));
  await page.fill("#json-input", '{"a":1,"b":[2,3]}');
  await page.waitForFunction(() => /VALID/.test(document.getElementById("json-status").textContent), null, { timeout: 3000 });
  await page.click("#json-btn-minify");
  const minified = await page.textContent("#json-output");
  check("Minify 输出无缩进换行", minified === '{"a":1,"b":[2,3]}', minified);

  /* --- 02 Base64 --- */
  const b64Input = await page.inputValue("#b64-input");
  const expectB64 = Buffer.from(b64Input, "utf8").toString("base64");
  check("Base64 编码与 Node 一致（UTF-8 安全）", (await page.inputValue("#b64-output")) === expectB64,
    expectB64.slice(0, 32));
  await page.selectOption("#b64-mode", "decode");
  await page.fill("#b64-input", expectB64);
  await page.waitForFunction((want) => document.getElementById("b64-output").value === want, b64Input, { timeout: 3000 });
  check("Base64 解码还原中文与 emoji", (await page.inputValue("#b64-output")) === b64Input);
  await page.fill("#b64-input", "!!!not-base64!!!");
  await page.waitForFunction(() => /ERROR/.test(document.getElementById("b64-status").textContent), null, { timeout: 3000 });
  check("非法 Base64 有错误提示", /ERROR/.test(await page.textContent("#b64-status")));

  /* --- 03 时间戳 --- */
  const tsOut = await page.textContent("#ts-output");
  check("时间戳→日期输出本地/UTC/ISO/双时间戳", /本地时间/.test(tsOut) && /UTC 时间/.test(tsOut)
    && /ISO 8601/.test(tsOut) && /时间戳\(ms\)/.test(tsOut));
  await page.fill("#ts-input", "2026-11-06 16:08:17");
  await page.waitForFunction(() => /本地时间   2026-11-06 16:08:17/.test(document.getElementById("ts-output").textContent), null, { timeout: 3000 });
  const tsBack = await page.textContent("#ts-output");
  check("日期→时间戳反向转换正确", /时间戳\(s\)  \d{10}/.test(tsBack), tsBack.split("\n")[3]);
  const nowS = Number(await page.textContent("#ts-now-s"));
  check("当前秒级时间戳实时刷新", Math.abs(nowS - Math.floor(Date.now() / 1000)) <= 2, String(nowS));

  /* --- 04 密码 --- */
  const pw0 = await page.inputValue("#pw-output");
  check("默认生成 20 位密码", pw0.length === 20, `len=${pw0.length}`);
  check("密码含大写/小写/数字/特殊符号", /[A-Z]/.test(pw0) && /[a-z]/.test(pw0) && /[0-9]/.test(pw0) && /[^A-Za-z0-9]/.test(pw0));
  const entropy = await page.textContent("#pw-entropy");
  check("显示香农熵与字符集", /bits 熵/.test(entropy) && /字符集/.test(entropy), entropy);
  await page.locator("#pw-length").evaluate((el) => {
    el.value = "32"; el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById("pw-output").value.length === 32, null, { timeout: 3000 });
  check("长度滑杆边改边出结果（防抖）", (await page.inputValue("#pw-output")).length === 32);
  const barW = await page.locator("#pw-strength-bar").evaluate((el) => el.style.width);
  check("强度条按熵值渲染", parseFloat(barW) > 0, barW);
  for (const k of ["upper", "lower", "digit", "symbol"]) await page.uncheck("#pw-" + k);
  await page.waitForFunction(() => /至少勾选/.test(document.getElementById("pw-strength-text").textContent), null, { timeout: 3000 });
  check("全部取消勾选时给出提示且不生成空密码", (await page.inputValue("#pw-output")) === "");
  for (const k of ["upper", "lower", "digit", "symbol"]) await page.check("#pw-" + k);

  /* --- 05 哈希 --- */
  const hashText = await page.inputValue("#hash-input");
  const enc = Buffer.from(hashText, "utf8");
  const expected = {
    "hash-md5": crypto.createHash("md5").update(enc).digest("hex"),
    "hash-sha1": crypto.createHash("sha1").update(enc).digest("hex"),
    "hash-sha256": crypto.createHash("sha256").update(enc).digest("hex"),
    "hash-sha512": crypto.createHash("sha512").update(enc).digest("hex"),
  };
  for (const [id, want] of Object.entries(expected)) {
    check(`${id.replace("hash-", "").toUpperCase()} 与 Node crypto 一致`, (await page.textContent("#" + id)) === want);
  }
  const newHash = "中文哈希 🚀 v13.0";
  await page.fill("#hash-input", newHash);
  const want256 = crypto.createHash("sha256").update(Buffer.from(newHash, "utf8")).digest("hex");
  await page.waitForFunction((w) => document.getElementById("hash-sha256").textContent === w, want256, { timeout: 3000 });
  check("哈希边输入边出结果（防抖 + 乱序保护）", (await page.textContent("#hash-sha256")) === want256);

  /* --- 卡片折叠 --- */
  await page.click('[data-tool="json"] .tb-card-head');
  check("单卡平滑折叠并同步 aria-expanded",
    (await page.getAttribute('[data-tool="json"] .tb-card-head', "aria-expanded")) === "false");
  await page.click("#tb-collapse-all");
  const collapsed = await page.locator(".tb-card.is-collapsed").count();
  check("一键折叠全部 7 张卡", collapsed === 7, `collapsed=${collapsed}`);
  await page.click("#tb-expand-all");
  check("一键展开全部 7 张卡", (await page.locator(".tb-card.is-collapsed").count()) === 0);

  /* --- 06 / 07 后端工具 --- */
  check("IP 信息页面加载即自动查询", apiCalls.some((c) => c.startsWith("/api/toolbox/ipinfo")));
  check("IP 归属地 / ISP 正确渲染",
    (await page.textContent("#ip-query")) === "203.0.113.7" &&
    (await page.textContent("#ip-location")) === "中国 · 广东 · 深圳" &&
    (await page.textContent("#ip-isp")) === "中国电信");
  await page.click("#probe-btn");
  await page.waitForFunction(() => document.getElementById("probe-status-text").textContent === "200", null, { timeout: 3000 });
  check("探测器渲染状态码与耗时",
    (await page.textContent("#probe-status-text")) === "200" &&
    (await page.textContent("#probe-latency")) === "123 ms");
  check("探测器渲染白名单响应头", /nginx/.test(await page.textContent("#probe-headers")));
  const probeCall = apiCalls.filter((c) => c.startsWith("/api/toolbox/probe")).pop();
  check("后端请求统一走 /api/toolbox/ 且 URL 已编码",
    !!probeCall && probeCall.includes("url=https%3A%2F%2F"), probeCall);
  check("两个后端调用均未直连第三方", externalRequests.length === 0,
    externalRequests.slice(0, 2).join(" | ") || "全部同源");

  probeResponse = { status: "error", code: "DNS_ERROR", error: "域名解析失败", httpStatus: 0, elapsed: 5000, headers: {} };
  await page.fill("#probe-url", "https://not-exist.invalid");
  await page.click("#probe-btn");
  await page.waitForFunction(() => /DNS_ERROR/.test(document.getElementById("probe-note").textContent), null, { timeout: 3000 });
  check("探测失败时展示错误分类而非白屏", /域名解析失败/.test(await page.textContent("#probe-note")));

  /* --- 375px 无横向溢出 + a11y 基础 --- */
  const ctxSmall = await browser.newContext({
    viewport: { width: 375, height: 812 }, serviceWorkers: "block",
  });
  const small = await ctxSmall.newPage();
  await small.route((u) => u.pathname.startsWith("/api/"), async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(u.pathname === "/api/toolbox/ipinfo" ? IP_OK : PROBE_OK) });
  });
  await small.goto(`http://localhost:${PORT}/tools.html`, { waitUntil: "domcontentloaded" });
  await sleep(500);
  const overflow = await small.evaluate(() => {
    const de = document.documentElement;
    const offenders = [];
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.visibility === "hidden" || cs.display === "none") return;
        let p = el.parentElement, inScroller = false;
        while (p) {
          const pcs = getComputedStyle(p);
          if (["auto", "scroll", "hidden"].includes(pcs.overflowX)) { inScroller = true; break; }
          p = p.parentElement;
        }
        if (!inScroller) offenders.push(`${el.tagName}${el.id ? "#" + el.id : ""} right=${Math.round(r.right)}`);
      }
    });
    return { scroll: de.scrollWidth, client: de.clientWidth, offenders: offenders.slice(0, 4) };
  });
  check("375px 手机视口零横向溢出",
    overflow.scroll <= overflow.client + 1 && overflow.offenders.length === 0,
    `scrollW=${overflow.scroll} clientW=${overflow.client} ${overflow.offenders.join(" | ")}`);
  const noName = await small.evaluate(() => {
    const bad = [];
    document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea").forEach((el) => {
      if (el.offsetParent === null) return;
      const name = (el.getAttribute("aria-label") || el.getAttribute("title") ||
        (el.labels && el.labels.length ? el.labels[0].textContent : "") || el.textContent || "").trim();
      if (!name && !el.getAttribute("placeholder")) bad.push(el.tagName + "#" + el.id);
    });
    return bad.slice(0, 4);
  });
  check("所有交互元素有可访问名称", noName.length === 0, noName.join(" | "));
  await small.close();

  check("全程零 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | ") || "无");
} finally {
  await browser.close();
  staticServer.closeAllConnections();
  staticServer.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log("待整改：\n  - " + findings.join("\n  - "));
console.log("");
process.exit(fail ? 1 : 0);
