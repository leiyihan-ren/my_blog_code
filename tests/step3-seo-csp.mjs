// ============================================================
// v3.0 步骤 3：SEO 与安全加固验证
//   C1 worker 层：CSP 增强（frame-ancestors/manifest-src/upgrade-insecure-requests）
//      + 全套安全响应头 + PWA 关键文件不长缓存 + API 不带 CSP
//   C2a 源码级：8 个前台页面 og:image/twitter:image/canonical/description 完整
//   C2b DOM 级：index/post/album 三页真实渲染 meta + og-image.png 可访问 + 零 JS 错误
//   C3 admin noindex
//   C4 post.html 动态 SEO：title/description/og/canonical/JSON-LD 按文章内容生成
//   C5 index.html WebSite JSON-LD
// 运行：node tests/step3-seo-csp.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const ORIGIN = "https://leiyihan.dpdns.org";
const PAGES = ["index.html", "blog.html", "post.html", "album.html", "timeline.html", "guestbook.html", "games.html", "links.html"];

/* ---------- Mock KV ---------- */
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys: keys.slice(0, limit || 1000), list_complete: true };
    },
  };
}
const SITE_SEED = JSON.stringify({
  title: "动态歌单测试站", footer: "S3 Test", autoMode: false, githubRepo: "", useCdn: false,
});
const SEO_POST = {
  id: "seo-test", title: "动态SEO测试文章", date: "2026-03-01",
  content: "# 一级标题\n\n这是**加粗**的正文第一句，包含 `代码` 与 [链接](https://example.com)。\n\n第二段内容紧随其后，用于验证摘要提取。",
};

/* ---------- 静态服务器（8899，/api 转发到内嵌 worker） ---------- */
const realFetch = globalThis.fetch;
const API_PORT = 8632;
const staticServer = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://x");
    const p = decodeURIComponent(parsed.pathname);
    if (p.startsWith("/api/")) {
      try {
        const resp = await realFetch(`http://127.0.0.1:${API_PORT}` + parsed.pathname + parsed.search, { headers: { "user-agent": "s3" } });
        const body = Buffer.from(await resp.arrayBuffer());
        const headers = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(resp.status, headers);
        return res.end(body);
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: String(e) }));
      }
    }
    const file = path.join(ROOT, staticFilePath(p)); // v7.0：经 route-map 映射到 pages/ 等物理路径
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    const ext = path.extname(file);
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => staticServer.listen(8899, "127.0.0.1", r));

const apiServer = http.createServer(async (req, res) => {
  try {
    const request = new Request("http://api.local" + req.url, { method: req.method, headers: { "user-agent": "s3" } });
    const env = { SITE_DATA: makeKV({ site: SITE_SEED, posts: JSON.stringify([SEO_POST]) }) };
    const response = await worker.fetch(request, env, { waitUntil: () => {} });
    const buf = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});
await new Promise((r) => apiServer.listen(API_PORT, "127.0.0.1", r));

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ C1 worker 层安全响应头 ============ */
console.log("\n═══ C1 CSP 增强 + 安全响应头 ═══");
{
  const deferred = [];
  const ctx = { waitUntil: (p) => deferred.push(Promise.resolve(p).catch(() => {})) };
  const env = {
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        const ct = u.pathname.endsWith(".html") ? "text/html" : u.pathname.endsWith(".js") ? "text/javascript" : "application/json";
        return new Response("x", { status: 200, headers: { "Content-Type": ct } });
      },
    },
  };
  const htmlResp = await worker.fetch(new Request("http://x/index.html"), env, ctx);
  const csp = htmlResp.headers.get("Content-Security-Policy") || "";
  check("HTML 响应带 CSP", csp.length > 0);
  check("CSP 含 frame-ancestors 'none'（防点击劫持）", /frame-ancestors 'none'/.test(csp), csp.match(/frame-ancestors [^;]*/)?.[0]);
  check("CSP 含 manifest-src 'self'（PWA manifest 限同源）", /manifest-src 'self'/.test(csp), csp.match(/manifest-src [^;]*/)?.[0]);
  check("CSP 含 upgrade-insecure-requests", /upgrade-insecure-requests/.test(csp));
  check("CSP 保留 worker-src 'self'（SW 注册前提）", /worker-src 'self'/.test(csp));
  check("CSP 保留 default-src 'self' 与 script-src 白名单", /default-src 'self'/.test(csp) && /script-src 'self' 'unsafe-inline' https:\/\/static\.cloudflareinsights\.com/.test(csp));
  check("X-Frame-Options: DENY（frame-ancestors 兼容回退）", htmlResp.headers.get("X-Frame-Options") === "DENY");
  check("X-Content-Type-Options: nosniff", htmlResp.headers.get("X-Content-Type-Options") === "nosniff");
  check("Referrer-Policy 严格跨域", (htmlResp.headers.get("Referrer-Policy") || "").includes("strict-origin-when-cross-origin"));
  check("Permissions-Policy 禁用定位/麦克风/摄像头", /geolocation=\(\)/.test(htmlResp.headers.get("Permissions-Policy") || ""));
  const swResp = await worker.fetch(new Request("http://x/sw.js"), env, ctx);
  check("sw.js 仍不长缓存（SW 版本更新前提）", /max-age=0/.test(swResp.headers.get("Cache-Control") || ""));
  const apiResp = await worker.fetch(new Request("http://api.local/api/site"), env, ctx);
  check("API 响应同样带 CSP（buildHeaders 全站统一安全头，无漏网响应）", (apiResp.headers.get("Content-Security-Policy") || "").includes("default-src 'self'"), String(apiResp.headers.get("Content-Security-Policy")).slice(0, 60));
}

/* ============ C2a 源码级：8 页 meta 完整性 ============ */
console.log("\n═══ C2a 源码级：8 个前台页面 SEO 标签 ═══");
for (const page of PAGES) {
  const html = await (await realFetch(`http://localhost:8899/${page}`)).text();
  const meta = (re) => (html.match(re) || [])[1] || "";
  const ogImage = meta(/<meta property="og:image" content="([^"]*)"/);
  const twitterImage = meta(/<meta name="twitter:image" content="([^"]*)"/);
  const canonical = meta(/<link rel="canonical" href="([^"]*)"/);
  const desc = meta(/<meta name="description" content="([^"]*)"/);
  const ogTitle = meta(/<meta property="og:title" content="([^"]*)"/);
  const title = meta(/<title>([^<]*)<\/title>/);
  check(`${page}: og:image/twitter:image 指向 og-image.png`, ogImage === `${ORIGIN}/og-image.png` && twitterImage === ogImage, ogImage);
  check(`${page}: canonical 指向自身绝对 URL`, canonical === `${ORIGIN}/${page}`, canonical);
  check(`${page}: description/og:title/title 非空`, desc.length > 5 && ogTitle.length > 2 && title.length > 2, `title="${title}"`);
}
{
  const imgResp = await realFetch(`http://localhost:8899/og-image.png`);
  const buf = Buffer.from(await imgResp.arrayBuffer());
  check("og-image.png 可访问（200 + image/png + 非空）", imgResp.status === 200 && (imgResp.headers.get("content-type") || "").includes("image/png") && buf.length > 1000, `${imgResp.status} ${buf.length}B`);
  const admin = await (await realFetch("http://localhost:8899/admin.html")).text();
  check("admin.html 带 noindex,nofollow（后台不进索引）", /<meta name="robots" content="noindex, nofollow">/.test(admin));
}

/* ============ C2b + C4 + C5 DOM 级 ============ */
console.log("\n═══ C2b/C4/C5 DOM 级：动态 SEO 与 JSON-LD ═══");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// index：WebSite JSON-LD + 静态 meta 真实可读
{
  const page = await context.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  await page.goto("http://localhost:8899/index.html", { waitUntil: "load" });
  await sleep(1200);
  const info = await page.evaluate(() => {
    const ld = document.getElementById("jsonld-website");
    let parsed = null;
    try { parsed = ld ? JSON.parse(ld.textContent) : null; } catch (e) {}
    return {
      ogImage: document.head.querySelector('meta[property="og:image"]')?.getAttribute("content"),
      canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute("href"),
      ldType: parsed && parsed["@type"],
      ldName: parsed && parsed.name,
    };
  });
  // canonical 由 common.js initSeoUrls 按 location 动态归一（换域名/308 规范化后仍等于真实 URL），
  // og:image 保持静态生产域名（绝对 URL 公开可访问，任何域名下都有效）
  check("index DOM 层 og:image/canonical 正确", info.ogImage === `${ORIGIN}/og-image.png` && info.canonical === "http://localhost:8899/index.html", JSON.stringify(info));
  check("index WebSite JSON-LD 可解析且类型正确", info.ldType === "WebSite" && info.ldName === "Lei Yihan 的个人博客", JSON.stringify(info));
  check("index 加载零 JS 错误", jsErrors.length === 0, jsErrors.join(" | ") || "无");
  await page.close();
}

// post：动态 SEO（核心场景）
{
  const page = await context.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  await page.goto("http://localhost:8899/post.html?id=seo-test", { waitUntil: "load" });
  // 动态 SEO 由文章数据加载后的异步回调填充：条件等待 og:url 就位，
  // 替代固定 sleep(2000)——高负载机器上固定等待可能读到填充前的中间态（flaky）
  await page.waitForFunction(
    () => {
      const el = document.head.querySelector('meta[property="og:url"]');
      return !!el && /id=seo-test/.test(el.getAttribute("content") || "");
    },
    null,
    { timeout: 10000 }
  );
  const seo = await page.evaluate(() => {
    const get = (s) => document.head.querySelector(s)?.getAttribute("content") || "";
    const ld = document.getElementById("jsonld-blogposting");
    let ldParsed = null;
    try { ldParsed = ld ? JSON.parse(ld.textContent) : null; } catch (e) {}
    return {
      title: document.title,
      desc: get('meta[name="description"]'),
      ogDesc: get('meta[property="og:description"]'),
      twitterDesc: get('meta[name="twitter:description"]'),
      ogTitle: get('meta[property="og:title"]'),
      ogUrl: get('meta[property="og:url"]'),
      ogImage: get('meta[property="og:image"]'),
      canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
      ld: ldParsed && { type: ldParsed["@type"], headline: ldParsed.headline, date: ldParsed.datePublished },
      articleTitle: document.querySelector(".article-title")?.textContent || "",
    };
  });
  check("文章 title 动态生成", seo.title === "动态SEO测试文章 - 我的博客", seo.title);
  check("文章 description 按正文生成（剥离 markdown 标记）", seo.desc.includes("这是") && seo.desc.includes("加粗") && seo.desc.includes("链接") && !/[#*`\[\]()]/.test(seo.desc) && seo.desc.length <= 120, seo.desc);
  check("og:description 与 twitter:description 同步更新", seo.ogDesc === seo.desc && seo.twitterDesc === seo.desc);
  check("og:title 为文章标题", seo.ogTitle === "动态SEO测试文章", seo.ogTitle);
  check("og:url 与 canonical 指向当前完整 URL", seo.ogUrl === "http://localhost:8899/post.html?id=seo-test" && seo.canonical === seo.ogUrl, `${seo.ogUrl} / ${seo.canonical}`);
  check("og:image 指向站点分享图", seo.ogImage === "http://localhost:8899/og-image.png", seo.ogImage);
  check("BlogPosting JSON-LD 动态注入且字段正确", !!seo.ld && seo.ld.type === "BlogPosting" && seo.ld.headline === "动态SEO测试文章" && seo.ld.date === "2026-03-01", JSON.stringify(seo.ld));
  check("文章正文正常渲染（SEO 改造未破坏阅读）", seo.articleTitle === "动态SEO测试文章", seo.articleTitle);
  check("post 加载零 JS 错误", jsErrors.length === 0, jsErrors.join(" | ") || "无");
  await page.close();
}

// album：动态相册页面在 SEO 改造后仍正常（回归）
{
  const page = await context.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  await page.goto("http://localhost:8899/album.html", { waitUntil: "load" });
  await sleep(1500);
  const ok = await page.evaluate(() => ({
    hasTabs: !!document.getElementById("album-tabs"),
    content: !!document.getElementById("album-content"),
    canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
  }));
  // canonical 由 common.js initSeoUrls 按 location 动态归一（同 index），断言运行时真实 URL
  check("album 页面结构完好 + canonical 正确", ok.hasTabs && ok.content && ok.canonical === "http://localhost:8899/album.html", JSON.stringify(ok));
  check("album 加载零 JS 错误", jsErrors.length === 0, jsErrors.join(" | ") || "无");
  await page.close();
}

console.log(`\n════════════════════════════════════`);
console.log(`v3.0 步骤3 SEO与安全加固: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
await browser.close();
apiServer.close(); staticServer.close();
process.exit(fail ? 1 : 0);
