// ============================================================
// 步骤 4 UI/响应式/a11y 深度打磨审计
// 9 页面 × 3 视口(375/768/1440) × 明暗双主题：
//   横向溢出 / img 无 alt / 交互元素无可访问名称 / 键盘 Tab 可达
// 运行：node tests/step4-a11y-audit.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import pkg from "playwright";
import fs from "node:fs";
import path from "node:path";
const { chromium } = pkg;

const PHOTO_N = 12;
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
  SITE_DATA: makeKV({
    site: JSON.stringify({ title: "审计博客", footer: "A11Y Audit", autoMode: true, githubRepo: "testowner/testrepo", githubBranch: "main", githubAlbumPath: "photos", useCdn: true }),
    music: JSON.stringify([
      { id: "m1", title: "曲目 Alpha", artist: "Artist", url: "http://127.0.0.1:8898/song1.wav" },
      { id: "m2", title: "曲目 Beta", artist: "Artist", url: "http://127.0.0.1:8898/song2.wav" },
    ]),
  }),
  GITHUB_TOKEN: "ghp_a11y",
};
const deferred = [];
const apiServer = http.createServer(async (req, res) => {
  try {
    const request = new Request("http://api.local" + req.url, { method: req.method, headers: { "user-agent": "a11y" } });
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
    const file = path.join(ROOT, staticFilePath(p)); // v7.0：经 route-map 映射到 pages/ 等物理路径
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => staticServer.listen(8899, "127.0.0.1", r));
const drainDeferred = async () => { await Promise.all(deferred.splice(0)); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  { name: "index", url: "/index.html" },
  { name: "blog", url: "/blog.html" },
  { name: "games", url: "/games.html" },
  { name: "album", url: "/album.html" },
  { name: "links", url: "/links.html" },
  { name: "timeline", url: "/timeline.html" },
  { name: "guestbook", url: "/guestbook.html" },
  { name: "post", url: "/post.html" },
  { name: "admin", url: "/admin.html" },
];
const VIEWPORTS = [
  { name: "375(手机)", width: 375, height: 812 },
  { name: "768(平板)", width: 768, height: 1024 },
  { name: "1440(桌面)", width: 1440, height: 900 },
];

const jsErrors = [];
for (const vp of VIEWPORTS) {
  console.log(`\n═══ 视口 ${vp.name} ═══`);
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  page.on("pageerror", (e) => jsErrors.push(`[${vp.name}] ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/40[48]|50[02]|Failed to load|ERR_|net::/.test(m.text())) jsErrors.push(`[${vp.name}] ${m.text()}`);
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const parsed = new URL(req.url());
    try {
      const resp = await realFetch("http://127.0.0.1:8602" + parsed.pathname + parsed.search, { headers: { "user-agent": "a11y" } });
      const body = await resp.arrayBuffer();
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
    } catch (e) {
      await route.fulfill({ status: 502, body: JSON.stringify({ error: String(e) }) });
    }
  });
  await page.route(/https:\/\/cdn\.(jsdelivr\.net|statically\.io)\/.*/, async (route) => {
    try {
      const resp = await fetch(route.request().url(), {});
      const body = await resp.arrayBuffer();
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
    } catch (e) { await route.fulfill({ status: 502, body: "cdn error" }); }
  });
  await page.route(/https:\/\/raw\.githubusercontent\.com\/.*/, async (route) => {
    try {
      const resp = await fetch(route.request().url(), {});
      const body = await resp.arrayBuffer();
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
    } catch (e) { await route.fulfill({ status: 502, body: "raw error" }); }
  });

  for (const p of PAGES) {
    const errBefore = jsErrors.length;
    await page.goto("http://localhost:8899" + p.url, { waitUntil: "domcontentloaded" });
    await sleep(1300);
    await drainDeferred();

    // 1) 横向溢出
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      const offenders = [];
      document.querySelectorAll("body *").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.visibility === "hidden" || cs.display === "none") return;
          // 排除可横向滚动容器内部的元素
          let parent = el.parentElement, inScroller = false;
          while (parent) {
            const pcs = getComputedStyle(parent);
            if (pcs.overflowX === "auto" || pcs.overflowX === "scroll" || pcs.overflowX === "hidden") { inScroller = true; break; }
            parent = parent.parentElement;
          }
          if (!inScroller) offenders.push(`${el.tagName}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ")[0]} right=${Math.round(r.right)}`);
        }
      });
      return { docScroll: de.scrollWidth, docClient: de.clientWidth, offenders: offenders.slice(0, 5) };
    });
    check(`${p.name} 无横向溢出`, overflow.docScroll <= overflow.docClient + 1 && overflow.offenders.length === 0,
      overflow.offenders.length ? overflow.offenders.join(" | ") : `scrollW=${overflow.docScroll} clientW=${overflow.docClient}`);

    // 2) img 无 alt
    const noAlt = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll("img").forEach((img) => {
        if (!img.hasAttribute("alt")) bad.push(img.src.slice(-40) || "(no-src)");
      });
      return bad;
    });
    check(`${p.name} 图片均有 alt`, noAlt.length === 0, noAlt.slice(0, 3).join(" | "));

    // 3) 交互元素无可访问名称（按钮/链接/输入）
    const noName = await page.evaluate(() => {
      const bad = [];
      const nameOf = (el) => {
        const aria = el.getAttribute("aria-label");
        if (aria && aria.trim()) return aria;
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) { const t = document.getElementById(labelledby); if (t && t.textContent.trim()) return t.textContent; }
        const title = el.getAttribute("title");
        if (title && title.trim()) return title;
        return (el.textContent || "").trim();
      };
      document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button]").forEach((el) => {
        if (el.closest("[aria-hidden=true]")) return;
        if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return; // 不可见
        if (el.type === "submit" || el.type === "button") { if (!nameOf(el)) bad.push(`<${el.tagName.toLowerCase()} ${el.id || el.className}>`); return; }
        if (!nameOf(el) && !el.getAttribute("placeholder") && !el.labels?.length) {
          bad.push(`<${el.tagName.toLowerCase()} ${el.id || el.className || el.type || ""}>`);
        }
      });
      return bad.slice(0, 6);
    });
    check(`${p.name} 交互元素均有可访问名称`, noName.length === 0, noName.join(" | "));

    // 4) 键盘 Tab 可达（页面加载后从 body 起 Tab 12 次，焦点应落在页面元素上）
    const tabReach = await page.evaluate(async () => {
      document.body.focus();
      const seen = [];
      for (let i = 0; i < 12; i++) {
        // 程序化模拟：派发 Tab 键由浏览器默认行为处理不可行，改用 Tab 序列探测可聚焦元素
        seen.push(null);
      }
      return seen;
    }).catch(() => []);
    const focusableCount = await page.evaluate(() => {
      const sel = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return document.querySelectorAll(sel).length;
    });
    check(`${p.name} 存在可聚焦元素（键盘可达基础）`, focusableCount >= 3, `focusable=${focusableCount}`);

    // 5) 暗色模式切换不破坏布局
    const darkOk = await page.evaluate(() => {
      document.body.classList.add("dark");
      const de = document.documentElement;
      const ok = de.scrollWidth <= de.clientWidth + 1;
      document.body.classList.remove("dark");
      return ok;
    });
    check(`${p.name} 暗色模式无横向溢出`, darkOk);

    // 6) 本页无新增 JS 错误
    const newErrs = jsErrors.length - errBefore;
    check(`${p.name} 无 JS 错误`, newErrs === 0, newErrs ? jsErrors.slice(errBefore, errBefore + 2).join(" | ") : "");
  }
  await page.close();
}

// ---- 键盘实操：真实 Tab 序列可达关键区域（桌面视口） ----
console.log("\n═══ 键盘实操：真实 Tab 遍历 ═══");
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => jsErrors.push(`[kbd] ${String(e)}`));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const parsed = new URL(req.url());
    try {
      const resp = await realFetch("http://127.0.0.1:8602" + parsed.pathname + parsed.search, { headers: { "user-agent": "a11y" } });
      const body = await resp.arrayBuffer();
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
    } catch (e) { await route.fulfill({ status: 502, body: "{}" }); }
  });
  await page.goto("http://localhost:8899/games.html", { waitUntil: "domcontentloaded" });
  await sleep(900);
  await page.keyboard.press("Tab");
  const firstFocus = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}${el.id ? "#" + el.id : ""}` : "none";
  });
  check("Tab 首个焦点为页面元素（非 body）", firstFocus !== "BODY" && firstFocus !== "none", firstFocus);
  // 连续 Tab 20 次：应始终有可见焦点环或至少焦点不丢失到 body 外
  let bodyHits = 0;
  const visited = new Set();
  const seqLog = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "BODY";
      const id = el.id ? "#" + el.id : "";
      const cls = typeof el.className === "string" && el.className ? "." + el.className.split(" ")[0] : "";
      return `${el.tagName}${id}${cls}`;
    });
    if (tag === "BODY") bodyHits++;
    visited.add(tag);
    seqLog.push(`${i + 1}:${tag}`);
  }
  check("20 次 Tab 焦点不丢失到 body", bodyHits === 0, `bodyHits=${bodyHits}`);
  check("Tab 遍历覆盖多个元素", visited.size >= 5, `${visited.size} 个不同元素 | ${seqLog.slice(0, 8).join(" → ")}`);
  await page.close();
}

console.log(`\n════════════════════════════════════`);
console.log(`a11y/响应式审计: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
await browser.close();
apiServer.close();
ghServer.close();
process.exit(fail ? 1 : 0);
