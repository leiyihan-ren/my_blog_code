// ============================================================
// 步骤 4 专项：灯箱 Focus Trap + Esc + 焦点归还运行时验证
// 运行：node tests/step4-lightbox-trap.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import http from "node:http";
import pkg from "playwright";
import fs from "node:fs";
import path from "node:path";
const { chromium } = pkg;

const PHOTO_N = 4;
const photoList = Array.from({ length: PHOTO_N }, (_, i) => ({
  name: `photo${String(i + 1).padStart(2, "0")}.jpg`, type: "file", size: 2048 + i,
}));
const IMG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const ghServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock.github");
  const rl = { "X-RateLimit-Remaining": "5000", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
  if (url.pathname.startsWith("/github/repos/")) {
    res.writeHead(200, { "Content-Type": "application/json", ETag: '"lv1"', ...rl });
    return res.end(JSON.stringify(photoList));
  }
  if (url.pathname.startsWith("/jd/")) {
    res.writeHead(200, { "Content-Type": "application/json", ETag: '"jv1"', ...rl });
    return res.end(JSON.stringify({ files: photoList }));
  }
  if (url.pathname.includes("/photos/")) {
    res.writeHead(200, { "Content-Type": "image/png", ETag: '"iv1"', ...rl });
    return res.end(IMG_BYTES);
  }
  res.writeHead(200, { "Content-Type": "application/json", ...rl });
  res.end("[]");
});
await new Promise((r) => ghServer.listen(0, "127.0.0.1", r));
const GH = `http://127.0.0.1:${ghServer.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const map = [
    ["https://api.github.com", GH + "/github"],
    ["https://raw.githubusercontent.com", GH + "/raw"],
    ["https://data.jsdelivr.com", GH + "/jd"],
    ["https://cdn.jsdelivr.net", GH + "/cdn"],
    ["https://cdn.statically.io", GH + "/statically"],
  ];
  for (const [from, to] of map) if (url.startsWith(from + "/")) return realFetch(url.replace(from, to), init);
  return realFetch(input, init);
};

const cacheStore = new Map();
const toResponse = (e) => new Response(e.body, { status: e.status, headers: new Headers(e.headers) });
const cacheObj = {
  async match(r) { const e = cacheStore.get(r.url); return e ? toResponse(e) : undefined; },
  async put(r, resp) { cacheStore.set(r.url, { body: await resp.arrayBuffer(), headers: [...resp.headers], status: resp.status }); },
  async delete(r) { return cacheStore.delete(r.url); },
  async keys() { return [...cacheStore.keys()].map((u) => new Request(u)); },
};
globalThis.caches = { default: cacheObj, async open() { return cacheObj; } };
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
const env = {
  SITE_DATA: makeKV({ site: JSON.stringify({ title: "审计博客", footer: "x", autoMode: true, githubRepo: "testowner/testrepo", githubBranch: "main", githubAlbumPath: "photos", useCdn: true }) }),
  GITHUB_TOKEN: "ghp_trap",
};
const deferred = [];
const apiServer = http.createServer(async (req, res) => {
  try {
    const request = new Request("http://api.local" + req.url, { method: req.method, headers: { "user-agent": "trap" } });
    const ctx = { waitUntil: (p) => { deferred.push(Promise.resolve(p).catch(() => {})); } };
    const response = await worker.fetch(request, env, ctx);
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
await new Promise((r) => apiServer.listen(8602, "127.0.0.1", r));

/* ---------- 静态服务器（8899，仅提供静态文件；/api 由 page.route 拦截转发 8602） ---------- */
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const staticServer = http.createServer((req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let fp = p;
    if (fp.endsWith("/")) fp += "index.html";
    const file = path.join(ROOT, fp);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => staticServer.listen(8899, "127.0.0.1", r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/40[48]|50[02]|Failed to load|ERR_|net::/.test(m.text())) jsErrors.push(m.text()); });

await page.route("**/api/**", async (route) => {
  const req = route.request();
  const parsed = new URL(req.url());
  try {
    const resp = await realFetch("http://127.0.0.1:8602" + parsed.pathname + parsed.search, { headers: { "user-agent": "trap" } });
    const body = await resp.arrayBuffer();
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
  } catch (e) { await route.fulfill({ status: 502, body: "{}" }); }
});
await page.route(/https:\/\/cdn\.(jsdelivr\.net|statically\.io)\/.*/, async (route) => {
  try {
    const resp = await fetch(route.request().url(), {});
    const body = await resp.arrayBuffer();
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
  } catch (e) { await route.fulfill({ status: 502, body: "e" }); }
});
await page.route(/https:\/\/raw\.githubusercontent\.com\/.*/, async (route) => {
  try {
    const resp = await fetch(route.request().url(), {});
    const body = await resp.arrayBuffer();
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
  } catch (e) { await route.fulfill({ status: 502, body: "e" }); }
});

await page.goto("http://localhost:8899/album.html", { waitUntil: "domcontentloaded" });
await sleep(1500);
const inLightbox = async () => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest(".lightbox"));

console.log("═══ 灯箱 Focus Trap ═══");
await page.locator(".photo-item").first().click();
await sleep(500);
check("灯箱打开且焦点在对话框内", await inLightbox());

// Tab ×10：焦点必须始终封锁在 .lightbox 内
let trapOk = 0;
for (let i = 0; i < 10; i++) {
  await page.keyboard.press("Tab");
  if (await inLightbox()) trapOk++;
}
check("Tab×10 焦点全部封锁在灯箱内", trapOk === 10, `${trapOk}/10`);

// Shift+Tab ×10：反向循环同样封锁
let trapBackOk = 0;
for (let i = 0; i < 10; i++) {
  await page.keyboard.press("Shift+Tab");
  if (await inLightbox()) trapBackOk++;
}
check("Shift+Tab×10 焦点全部封锁在灯箱内", trapBackOk === 10, `${trapBackOk}/10`);

// 方向键在灯箱内切图（focus trap 不应拦截）
const capBefore = await page.locator("#lightbox-caption").textContent();
await page.keyboard.press("ArrowRight");
await sleep(300);
const capAfter = await page.locator("#lightbox-caption").textContent();
check("灯箱内方向键切图正常", capBefore !== capAfter, `${capBefore} → ${capAfter}`);

// Esc 关闭 + 焦点归还
await page.keyboard.press("Escape");
await sleep(300);
check("Esc 关闭灯箱", !(await page.locator("#lightbox").evaluate((el) => el.classList.contains("active"))));
const focusAfterClose = await page.evaluate(() => document.activeElement.className);
check("关闭后焦点归还照片项", focusAfterClose.includes("photo-item"), focusAfterClose);
check("全程零 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));

console.log(`\n════════════════════════════════════`);
console.log(`灯箱 Focus Trap 专项: ${pass} 通过 / ${fail} 失败`);
console.log(`════════════════════════════════════`);
await browser.close();
apiServer.close();
ghServer.close();
process.exit(fail ? 1 : 0);
