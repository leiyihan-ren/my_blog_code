// ============================================================
// v3.0 步骤 2.2：动态相册端到端验证
//   A1 worker 层：album.json 配置模式（分类/标题/日期/排序）
//   A2 worker 层：分页参数（offset/limit/hasMore/nextOffset/total）
//   A3 worker 层：分类过滤（category=travel）
//   A4 worker 层：album.json 404 → 目录扫描回退
//   A5 worker 层：album.json 损坏 → 目录模式不阻塞
//   B1 端到端：tabs 渲染 + 首屏 + 状态条
//   B2 端到端：分类切换（重置分页重新请求）
//   B3 端到端：灯箱 + 懒加载镜像同源代理
//   B4 端到端：无限滚动（60 张：24 → 48 → 60）
//   B5 端到端：断网 SWR 渲染 + localStorage v3 缓存兜底
// 运行：node tests/step2-album-dynamic.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

// 1x1 透明 PNG（懒加载/灯箱断言用，体积最小）
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/* ---------- Mock GitHub 上游 ---------- */
const ghState = { albumJsonMissing: false, albumJsonBroken: false, bigAlbum: false, ghDown: false, rawFail: false, cdnFail: false, staticallyFail: false, calls: [] };

const PHOTO_DIR = JSON.stringify([
  { name: "album.json", type: "file", size: 400 },
  { name: "cover.jpg", type: "file", size: 1024 },
  { name: "beach.jpg", type: "file", size: 1024 },
  { name: "sunset.jpg", type: "file", size: 1024 },
  { name: "forest.jpg", type: "file", size: 1024 },
  { name: "travel", type: "dir", size: 0 },
]);
const TRAVEL_DIR = JSON.stringify([
  { name: "mountain.jpg", type: "file", size: 1024 },
  { name: "city.jpg", type: "file", size: 1024 },
  { name: "lake.jpg", type: "file", size: 1024 },
]);
const ALBUM_JSON = JSON.stringify({
  categories: [{ id: "travel", name: "旅行" }],
  photos: [
    { file: "cover.jpg", title: "封面照片", category: "all", date: "2026-01-01" },
    { file: "travel/mountain.jpg", title: "山景", category: "travel", date: "2026-02-02" },
    { file: "beach.jpg", title: "海滩", category: "all" },
  ],
});

// 大相册（无限滚动用）：57 顶层 + travel 3 张 = 60 张，无 album.json
const BIG_DIR = JSON.stringify(
  Array.from({ length: 57 }, (_, i) => ({ name: `img-${String(i).padStart(2, "0")}.jpg`, type: "file", size: 1024 }))
    .concat([{ name: "travel", type: "dir", size: 0 }])
);

const ghServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock.github");
  ghState.calls.push(url.pathname);
  const rl = { "X-RateLimit-Remaining": "5000", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
  const j = (body) => { res.writeHead(200, { "Content-Type": "application/json", ...rl }); res.end(body); };
  const nf = () => { res.writeHead(404, { "Content-Type": "application/json", ...rl }); res.end('{"message":"Not Found"}'); };
  if (ghState.ghDown && (url.pathname.startsWith("/raw/testowner/testrepo/main/photos/") || url.pathname.startsWith("/github/repos/testowner/testrepo/contents/photos"))) {
    res.writeHead(500, { "Content-Type": "application/json", ...rl }); return res.end('{"message":"Server Error"}');
  }
  if (url.pathname === "/raw/testowner/testrepo/main/photos/album.json") {
    if (ghState.albumJsonMissing) return nf();
    if (ghState.albumJsonBroken) { res.writeHead(200, { "Content-Type": "text/plain", ...rl }); return res.end("not-json{{{"); }
    return j(ALBUM_JSON);
  }
  if (url.pathname.startsWith("/raw/testowner/testrepo/main/photos/")) {
    if (ghState.rawFail) { res.writeHead(500, { "Content-Type": "application/json", ...rl }); return res.end('{"message":"raw down"}'); }
    res.writeHead(200, { "Content-Type": "image/png", ...rl });
    return res.end(PNG);
  }
  if (url.pathname.startsWith("/cdn/") || url.pathname.startsWith("/statically/")) {
    const down = url.pathname.startsWith("/cdn/") ? ghState.cdnFail : ghState.staticallyFail;
    if (down) { res.writeHead(500, { "Content-Type": "application/json", ...rl }); return res.end('{"message":"cdn down"}'); }
    res.writeHead(200, { "Content-Type": "image/png", ...rl });
    return res.end(PNG);
  }
  if (url.pathname === "/github/repos/testowner/testrepo/contents/photos") return j(ghState.bigAlbum ? BIG_DIR : PHOTO_DIR);
  if (url.pathname === "/github/repos/testowner/testrepo/contents/photos/travel") return j(TRAVEL_DIR);
  return nf(); // jsDelivr / statically 降级源
});
await new Promise((r) => ghServer.listen(0, "127.0.0.1", r));
const GH_ORIGIN = `http://127.0.0.1:${ghServer.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const map = [
    ["https://api.github.com", GH_ORIGIN + "/github"],
    ["https://raw.githubusercontent.com", GH_ORIGIN + "/raw"],
    ["https://data.jsdelivr.com", GH_ORIGIN + "/jd"],
    ["https://cdn.jsdelivr.net", GH_ORIGIN + "/cdn"],
    ["https://cdn.statically.io", GH_ORIGIN + "/statically"],
  ];
  for (const [from, to] of map) if (url.startsWith(from + "/")) return realFetch(url.replace(from, to), init);
  return realFetch(input, init);
};

/* ---------- Mock Cache API / KV ---------- */
function makeCaches() {
  const store = new Map();
  const obj = {
    async match(r) { const e = store.get(typeof r === "string" ? r : r.url); return e ? new Response(e.body, { status: e.status, headers: new Headers(e.headers) }) : undefined; },
    async put(r, resp) { store.set(typeof r === "string" ? r : r.url, { body: await resp.arrayBuffer(), headers: [...resp.headers], status: resp.status }); },
    async delete(r) { return store.delete(typeof r === "string" ? r : r.url); },
    async keys() { return [...store.keys()].map((u) => new Request(u)); },
  };
  return { default: obj, async open() { return obj; } };
}
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
  title: "动态相册测试站", footer: "S2 Test", autoMode: true,
  githubRepo: "testowner/testrepo", githubBranch: "main",
  githubMusicPath: "music", githubAlbumPath: "photos", useCdn: false,
});

function startApi(port) {
  const deferred = [];
  const server = http.createServer(async (req, res) => {
    try {
      const request = new Request("http://api.local" + req.url, { method: req.method, headers: { "user-agent": "s2" } });
      const ctx = { waitUntil: (p) => deferred.push(Promise.resolve(p).catch(() => {})) };
      const response = await worker.fetch(request, envFor(), ctx);
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
  const envFor = () => ({ SITE_DATA: makeKV({ site: SITE_SEED }), GITHUB_TOKEN: "ghp_s2" });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, drain: async () => { await Promise.all(deferred.splice(0)); } })));
}

/* ---------- 静态服务器（8899，/api 转发到 worker，SW 完整参与） ---------- */
const API_ORIGIN = "http://127.0.0.1:8612";
const staticServer = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://x");
    const p = decodeURIComponent(parsed.pathname);
    if (p.startsWith("/api/")) {
      try {
        const resp = await realFetch(API_ORIGIN + parsed.pathname + parsed.search, { headers: { "user-agent": "s2" } });
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

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ A1 album.json 配置模式 ============ */
console.log("\n═══ A1 album.json 配置：分类/标题/日期/排序 ═══");
const apiA = await startApi(8622);
{
  const res = await realFetch("http://127.0.0.1:8622/api/album/photos?category=all&offset=0&limit=24");
  const data = await res.json();
  check("返回 200 且 configured=true", res.status === 200 && data.configured === true, `status=${res.status}`);
  check("共 7 张照片（3 配置 + 4 目录补录）", data.photos.length === 7, `len=${data.photos.length}`);
  const first = data.photos[0];
  check("配置条目保留排序意图（封面照片首位）", first && first.title === "封面照片" && first.category === "all", first && `${first.title}/${first.category}`);
  check("配置条目带日期", first && first.date === "2026-01-01", first && first.date);
  const mountain = data.photos.find((p) => p.name === "travel/mountain.jpg");
  check("子目录配置条目分类为 travel", !!mountain && mountain.category === "travel" && mountain.title === "山景", mountain && mountain.category);
  const beach = data.photos.find((p) => p.name === "beach.jpg");
  check("顶层未配置文件归 all 分类", !!beach && beach.category === "all", beach && beach.category);
  const lake = data.photos.find((p) => p.name === "travel/lake.jpg");
  check("子目录未配置文件分类为 travel", !!lake && lake.category === "travel", lake && lake.category);
  const cats = data.categories;
  check("分类列表 all 恒首位（count=7）", cats[0] && cats[0].id === "all" && cats[0].count === 7, JSON.stringify(cats));
  const travel = cats.find((c) => c.id === "travel");
  check("分类名取自 album.json 配置（旅行），count=3", !!travel && travel.name === "旅行" && travel.count === 3, JSON.stringify(travel));
  const mirror = first && first.mirrors && first.mirrors[0];
  check("首镜像为同源代理 /api/github/raw/*", !!mirror && mirror === "/api/github/raw/testowner/testrepo/main/photos/cover.jpg", mirror);
  check("hasMore=false（7 < 24）", data.hasMore === false && data.total === 7, `hasMore=${data.hasMore} total=${data.total}`);
}

/* ============ A2 分页 ============ */
console.log("\n═══ A2 分页参数：offset/limit/hasMore/nextOffset ═══");
{
  const p1 = await (await realFetch("http://127.0.0.1:8622/api/album/photos?category=all&offset=0&limit=3")).json();
  check("limit=3 返回 3 张", p1.photos.length === 3, `len=${p1.photos.length}`);
  check("hasMore=true 且 nextOffset=3", p1.hasMore === true && p1.nextOffset === 3, `hasMore=${p1.hasMore} next=${p1.nextOffset}`);
  check("total 为分类总数（7）", p1.total === 7, `total=${p1.total}`);
  const p3 = await (await realFetch("http://127.0.0.1:8622/api/album/photos?category=all&offset=6&limit=3")).json();
  check("offset=6 返回尾页 1 张且 hasMore=false", p3.photos.length === 1 && p3.hasMore === false, `len=${p3.photos.length} hasMore=${p3.hasMore}`);
  check("尾页 nextOffset=null", p3.nextOffset === null, `next=${p3.nextOffset}`);
  const beyond = await (await realFetch("http://127.0.0.1:8622/api/album/photos?category=all&offset=99&limit=3")).json();
  check("offset 越界返回空数组", Array.isArray(beyond.photos) && beyond.photos.length === 0, `len=${beyond.photos.length}`);
}

/* ============ A3 分类过滤 ============ */
console.log("\n═══ A3 分类过滤：category=travel ═══");
{
  const data = await (await realFetch("http://127.0.0.1:8622/api/album/photos?category=travel&offset=0&limit=24")).json();
  check("travel 分类返回 3 张", data.photos.length === 3 && data.total === 3, `len=${data.photos.length} total=${data.total}`);
  check("全部属于 travel 分类", data.photos.every((p) => p.category === "travel"));
  check("分类计数保持全局值（all=7）", data.categories.find((c) => c.id === "all").count === 7, JSON.stringify(data.categories));
}

/* ============ A4 album.json 404 → 目录回退 ============ */
console.log("\n═══ A4 album.json 缺失 → 目录扫描回退 ═══");
const apiB = await startApi(8623);
ghState.albumJsonMissing = true;
{
  const data = await (await realFetch("http://127.0.0.1:8623/api/album/photos?category=all&offset=0&limit=24")).json();
  check("目录模式仍返回 7 张（album.json 非图片不入列）", data.photos.length === 7, `len=${data.photos.length}`);
  check("目录模式分类：「全部」=总数 7、travel=3", data.categories.find((c) => c.id === "all").count === 7 && data.categories.find((c) => c.id === "travel").count === 3, JSON.stringify(data.categories));
  check("目录模式无标题配置（title 为空串）", data.photos.every((p) => p.title === ""), JSON.stringify(data.photos[0]));
  check("目录模式首镜像仍为同源代理", data.photos[0].mirrors[0].startsWith("/api/github/raw/"), data.photos[0].mirrors[0]);
}

/* ============ A5 album.json 损坏 ============ */
console.log("\n═══ A5 album.json 损坏 → 目录模式不阻塞 ═══");
const apiC = await startApi(8624);
ghState.albumJsonMissing = false; ghState.albumJsonBroken = true;
{
  const data = await (await realFetch("http://127.0.0.1:8624/api/album/photos?category=all&offset=0&limit=24")).json();
  check("配置损坏退化为目录模式（7 张）", data.photos.length === 7, `len=${data.photos.length}`);
  check("配置损坏时不抛错、分类完整", data.categories.length === 2, JSON.stringify(data.categories));
}

/* ============ B1-B3 端到端：tabs/首屏/分类切换/灯箱 ============ */
console.log("\n═══ B1 端到端：tabs 渲染 + 首屏 + 状态条 ═══");
ghState.albumJsonMissing = false; ghState.albumJsonBroken = false; // 恢复配置模式
// B1-B3 的页面经静态服务器把 /api 转发到 8612，这里启动配置模式的 worker 实例
const apiMain = await startApi(8612);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
await page.goto("http://localhost:8899/album.html", { waitUntil: "load" });
await sleep(2000);

const tabs = await page.evaluate(() => [...document.querySelectorAll(".album-tab")].map((b) => ({
  text: b.textContent.trim(), cat: b.dataset.cat, selected: b.getAttribute("aria-selected"),
})));
check("渲染 2 个分类 tab（全部/旅行）", tabs.length === 2, JSON.stringify(tabs));
check("「全部」tab 计数 7 且默认选中", tabs[0] && tabs[0].cat === "all" && tabs[0].text.includes("7") && tabs[0].selected === "true", JSON.stringify(tabs[0]));
check("「旅行」tab 计数 3 且未选中", tabs[1] && tabs[1].cat === "travel" && tabs[1].text.includes("3") && tabs[1].selected === "false", JSON.stringify(tabs[1]));

const first = await page.evaluate(() => ({
  items: document.querySelectorAll(".photo-item").length,
  status: document.getElementById("album-status")?.textContent || "",
  subtitle: document.getElementById("album-subtitle")?.textContent || "",
  firstSrc: document.querySelector(".lazy-img")?.getAttribute("src") || "",
  firstIdx: document.querySelector(".photo-item")?.dataset.idx,
}));
check("首屏渲染全部 7 张（24 ≥ 7）", first.items === 7, `items=${first.items}`);
check("状态条提示「已展示全部 7 张照片」", first.status.includes("已展示全部 7 张"), first.status);
check("副标题显示仓库同步标识", first.subtitle.includes("testowner/testrepo") && first.subtitle.includes("GitHub 同步"), first.subtitle);
check("懒加载首图为同源代理镜像", first.firstSrc.startsWith("/api/github/raw/testowner/testrepo/main/photos/"), first.firstSrc);
check("照片索引连续（data-idx 从 0 起）", first.firstIdx === "0", `idx=${first.firstIdx}`);

/* ---- B2 分类切换 ---- */
console.log("\n═══ B2 分类切换：重置分页重新请求 ═══");
await page.click('.album-tab[data-cat="travel"]');
await sleep(1200);
const afterSwitch = await page.evaluate(() => ({
  items: document.querySelectorAll(".photo-item").length,
  status: document.getElementById("album-status")?.textContent || "",
  selected: document.querySelector('.album-tab[data-cat="travel"]')?.getAttribute("aria-selected"),
  allSelected: document.querySelector('.album-tab[data-cat="all"]')?.getAttribute("aria-selected"),
}));
check("切换到旅行后网格只显示 3 张", afterSwitch.items === 3, `items=${afterSwitch.items}`);
check("状态条更新为「已展示全部 3 张照片」", afterSwitch.status.includes("已展示全部 3 张"), afterSwitch.status);
check("tab 激活态跟随切换", afterSwitch.selected === "true" && afterSwitch.allSelected === "false", JSON.stringify(afterSwitch));

await page.click('.album-tab[data-cat="all"]');
await sleep(1200);
const backAll = await page.evaluate(() => document.querySelectorAll(".photo-item").length);
check("切回全部恢复 7 张", backAll === 7, `items=${backAll}`);

/* ---- B3 灯箱 ---- */
console.log("\n═══ B3 灯箱 + 键盘可用性 ═══");
await page.click(".photo-item");
await sleep(800);
const lb = await page.evaluate(() => ({
  active: document.getElementById("lightbox").classList.contains("active"),
  caption: document.getElementById("lightbox-caption")?.textContent || "",
  src: document.getElementById("lightbox-img")?.getAttribute("src") || "",
}));
check("点击照片打开灯箱", lb.active, JSON.stringify(lb));
check("灯箱 caption 显示 序号/总数", lb.caption.includes("1 / 7"), lb.caption);
check("灯箱图片走同源代理镜像", lb.src.startsWith("/api/github/raw/"), lb.src);
await page.keyboard.press("ArrowRight");
await sleep(500);
const lbNext = await page.evaluate(() => document.getElementById("lightbox-caption")?.textContent || "");
check("方向键切换到下一张（2 / 7）", lbNext.includes("2 / 7"), lbNext);
await page.keyboard.press("Escape");
await sleep(300);
const lbClosed = await page.evaluate(() => !document.getElementById("lightbox").classList.contains("active"));
check("Escape 关闭灯箱", lbClosed);

/* ============ B4 无限滚动（60 张大相册） ============ */
console.log("\n═══ B4 无限滚动：60 张分三页加载 ═══");
// 停掉配置模式实例，切换大相册数据后启动全新实例（KV 全新 → 重新拉取 GitHub）
await apiMain.server.close();
ghState.bigAlbum = true;
const apiD = await startApi(8612);
{
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  // 无限滚动触发助手：懒加载图片会改变文档高度，单次 scrollTo 可能踩空哨兵或撞上 loading 窗口；
  // 循环滚动 + 直滚哨兵，直到达到目标张数或超时（45s 容忍慢环境）。仅改测试触发方式，不改断言强度。
  async function scrollUntilPhotos(page, target, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const n = await page.evaluate(() => document.querySelectorAll(".photo-item").length);
      if (n >= target) return n;
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const s = document.getElementById("album-sentinel");
        if (s && s.scrollIntoView) s.scrollIntoView({ block: "end" });
      });
      await sleep(400);
    }
    return page.evaluate(() => document.querySelectorAll(".photo-item").length);
  }
  const jsErrors2 = [];
  page2.on("pageerror", (e) => jsErrors2.push(String(e)));
  await page2.goto("http://localhost:8899/album.html", { waitUntil: "load" });
  await sleep(2000);
  // 预热刷新：让 SW 接管 /api（首次访问 API 请求早于 SW 激活，与真实用户第二次访问同构）
  await page2.reload({ waitUntil: "load" });
  await sleep(2000);
  const p1count = await page2.evaluate(() => document.querySelectorAll(".photo-item").length);
  check("第一页加载 24 张", p1count === 24, `items=${p1count}`);
  const st1 = await page2.evaluate(() => document.getElementById("album-status")?.textContent || "");
  check("状态条显示 24 / 60", st1.includes("24 / 60"), st1);
  // 滚动触发第二页（懒加载图片改变文档高度，单次 scrollTo 易踩空哨兵，循环滚动兜底）
  await scrollUntilPhotos(page2, 48);
  const p2count = await page2.evaluate(() => document.querySelectorAll(".photo-item").length);
  check("滚动后加载第二页（48 张）", p2count === 48, `items=${p2count}`);
  const st2 = await page2.evaluate(() => document.getElementById("album-status")?.textContent || "");
  check("状态条显示 48 / 60", st2.includes("48 / 60"), st2);
  // 索引连续性：第 25 张的 data-idx 应为 24（增量渲染不重排）
  const idx25 = await page2.evaluate(() => {
    const items = document.querySelectorAll(".photo-item");
    return items[24] ? items[24].dataset.idx : null;
  });
  check("增量渲染索引连续（第 25 张 idx=24）", idx25 === "24", `idx=${idx25}`);
  // 第三页（末页竞态最高发处，同样循环滚动兜底）
  await scrollUntilPhotos(page2, 60);
  await sleep(600);
  const p3 = await page2.evaluate(() => ({
    count: document.querySelectorAll(".photo-item").length,
    status: document.getElementById("album-status")?.textContent || "",
  }));
  check("第三页加载完全部 60 张", p3.count === 60, `items=${p3.count}`);
  check("状态条显示「已展示全部 60 张照片」", p3.status.includes("已展示全部 60 张"), p3.status);
  check("大相册分类：「全部」=总数 60、travel=3", await page2.evaluate(() => {
    const t = [...document.querySelectorAll(".album-tab")].map((b) => b.textContent.trim());
    return t.some((s) => s.includes("全部") && s.includes("60")) && t.some((s) => s.includes("travel") && s.includes("3"));
  }), JSON.stringify(await page2.evaluate(() => [...document.querySelectorAll(".album-tab")].map((b) => b.textContent.trim()))));
  // 缓存写入：60 张全量 → localStorage v3
  const cached = await page2.evaluate(() => {
    const raw = localStorage.getItem("album_photos_v3");
    if (!raw) return null;
    const d = JSON.parse(raw);
    return { v: d.v, count: d.photos.length, cats: d.categories.length };
  });
  check("localStorage v3 缓存写入（60 张 + 分类）", !!cached && cached.v === 3 && cached.count === 60, JSON.stringify(cached));

  /* ---- B5 断网 SWR + 接口故障 localStorage 兜底 ---- */
  console.log("\n═══ B5 断网 SWR 渲染 + 接口故障 localStorage 兜底 ═══");
  // 趁 mock 健康拉取全量相册，构造 localStorage v3 种子（供兜底场景预置）
  const fullAlbum = await (await realFetch("http://127.0.0.1:8612/api/album/photos?category=all&offset=0&limit=100")).json();
  const v3Seed = { v: 3, categories: fullAlbum.categories, photos: fullAlbum.photos };
  // 清掉前面无限滚动污染进 SW Cache Storage 的 48/60 张，重新只预热第一页（24 张），
  // 使离线断言确定命中 24 而非被污染的缓存（否则 CI headless 上会得到 48）。
  await page2.evaluate(async () => {
    if (typeof caches !== "undefined") { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
    localStorage.removeItem("album_photos_v3");
  });
  await page2.reload({ waitUntil: "load" });
  // 双保险：album.html 已设 scrollRestoration=manual，这里再显式置顶，
  // 杜绝任何滚动位置残留触发哨兵翻页（确保只预热第一页 24 张）
  await page2.evaluate(() => window.scrollTo(0, 0));
  await sleep(2500); // 等首屏 24 张渲染 + SW 把 API 响应写入 SWR 缓存
  await context.setOffline(true);
  await page2.reload({ waitUntil: "load" });
  await sleep(2500);
  const offline = await page2.evaluate(() => ({
    count: document.querySelectorAll(".photo-item").length,
    status: document.getElementById("album-status")?.textContent || "",
  }));
  check("断网刷新后 SWR 缓存仍渲染第一页（24 张）", offline.count === 24, `items=${offline.count}`);
  check("断网状态条正常（24 / 60）", offline.status.includes("24 / 60"), offline.status);
  await context.setOffline(false);

  // GitHub 故障场景（worker 多源全部失败 → /api/album/photos 502 → localStorage v3 兜底）。
  // 注意：不能复用 page2——SW 缓存可清，但 worker 给 API 设了
  // `Cache-Control: public, max-age=ttl, stale-while-revalidate`，SW 的 fetch(req)
  // 会命中浏览器 HTTP 磁盘缓存拿到陈旧 200（这是正确的边缘缓存行为）。
  // 因此用全新 context（无 SW 缓存、无 HTTP 缓存）确定性复现「缓存全失效」路径，
  // 并预置 v3 本地缓存模拟「用户此前成功加载过」。
  ghState.ghDown = true;
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page3 = await ctx3.newPage();
  const jsErrors3 = [];
  page3.on("pageerror", (e) => jsErrors3.push(String(e)));
  await page3.goto("http://localhost:8899/album.html", { waitUntil: "load" });
  await sleep(1500);
  const errState = await page3.evaluate(() => ({
    items: document.querySelectorAll(".photo-item").length,
    hasRetry: !!document.querySelector(".album-retry"),
  }));
  check("接口 502 且无缓存时展示错误态 + 重试按钮", errState.items === 0 && errState.hasRetry, JSON.stringify(errState));
  await page3.evaluate((seed) => { localStorage.setItem("album_photos_v3", JSON.stringify(seed)); }, v3Seed);
  await page3.evaluate(() => init());
  await sleep(1500);
  const fallback = await page3.evaluate(() => ({
    count: document.querySelectorAll(".photo-item").length,
    notice: document.getElementById("album-notice")?.textContent || "",
    status: document.getElementById("album-status")?.textContent || "",
  }));
  check("接口 502 时展示缓存兜底（60 张全量）", fallback.count === 60, `items=${fallback.count}`);
  check("兜底提示「网络不稳定，正在展示缓存」", fallback.notice.includes("网络不稳定"), fallback.notice);
  // 缓存模式下点分类 → 本地过滤，不再打接口
  await page3.click('.album-tab[data-cat="travel"]');
  await sleep(600);
  const cacheFilter = await page3.evaluate(() => ({
    count: document.querySelectorAll(".photo-item").length,
    status: document.getElementById("album-status")?.textContent || "",
  }));
  check("缓存模式分类切换为本地过滤（3 张）", cacheFilter.count === 3, `items=${cacheFilter.count}`);
  check("缓存模式状态条标注「离线缓存」", cacheFilter.status.includes("离线缓存"), cacheFilter.status);
  check("兜底场景零 JS 错误", jsErrors3.length === 0, jsErrors3.join(" | ") || "无");
  await ctx3.close();
  ghState.ghDown = false;

  check("大相册全程零 JS 错误", jsErrors2.length === 0, jsErrors2.join(" | ") || "无");
  await ctx2.close();
}


/* ============ B6 弱网镜像分级降级 ============ */
console.log("\n═══ B6 弱网镜像分级降级：镜像逐个兜底 ═══");
// 单元级验证 BlogApi.github.loadImage 的四镜像链（代理 → jsDelivr → raw → statically）。
// CDN 镜像为跨域图片请求（SW 不接管），用 page.route 精准转发到 mock；
// 同源的 /api/github/raw/* 不走 route，完整经过 SW → worker 链路。
await page.route(/https:\/\/cdn\.jsdelivr\.net\/.*/, async (route) => {
  try {
    const resp = await fetch(route.request().url());
    const body = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body });
  } catch (e) { await route.fulfill({ status: 502, body: "cdn down" }); }
});
await page.route(/https:\/\/cdn\.statically\.io\/.*/, async (route) => {
  try {
    const resp = await fetch(route.request().url());
    const body = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body });
  } catch (e) { await route.fulfill({ status: 502, body: "statically down" }); }
});
await page.route(/https:\/\/raw\.githubusercontent\.com\/.*/, async (route) => {
  try {
    const resp = await fetch(route.request().url());
    const body = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body });
  } catch (e) { await route.fulfill({ status: 502, body: "raw down" }); }
});

const probeImg = (name) => page.evaluate(async (probeName) => {
  const mirrors = [
    `/api/github/raw/testowner/testrepo/main/photos/${probeName}.jpg`,
    `https://cdn.jsdelivr.net/gh/testowner/testrepo@main/photos/${probeName}.jpg`,
    `https://raw.githubusercontent.com/testowner/testrepo/main/photos/${probeName}.jpg`,
    `https://cdn.statically.io/gh/testowner/testrepo/main/photos/${probeName}.jpg`,
  ];
  const img = document.createElement("img");
  img.className = "lazy-img";
  img.dataset.mirrors = JSON.stringify(mirrors);
  img.dataset.idx = "0";
  document.getElementById("album-content").appendChild(img);
  BlogApi.github.loadImage(img); // 真实网格由 IntersectionObserver 触发，探针直接调用
  const result = await new Promise((resolve) => {
    img.addEventListener("load", () => resolve({ loaded: true, src: img.src }));
    img.addEventListener("imgallfailed", () => resolve({ loaded: false, allFailed: true, src: img.src }));
    setTimeout(() => resolve({ loaded: false, timeout: true, src: img.src }), 8000);
  });
  img.remove();
  return result;
}, name);

// 场景 1：raw.githubusercontent.com 故障（代理首镜像 502）→ 降级 jsDelivr
ghState.rawFail = true;
const r1 = await probeImg("probe-raw-down");
check("raw 故障时降级到 jsDelivr 镜像并加载成功", r1.loaded && r1.src.includes("cdn.jsdelivr.net"), JSON.stringify(r1));

// 场景 2：raw + jsDelivr 均故障 → 降级 raw 直连（mock 的 rawFail 同时模拟上游故障）→ statically
ghState.rawFail = true; ghState.cdnFail = true;
const r2 = await probeImg("probe-raw-cdn-down");
check("raw+jsDelivr 故障时降级到 statically 镜像并加载成功", r2.loaded && r2.src.includes("cdn.statically.io"), JSON.stringify(r2));

// 场景 3：全部镜像故障 → imgallfailed 事件（网格呈现失败态）
ghState.rawFail = true; ghState.cdnFail = true; ghState.staticallyFail = true;
const r3 = await probeImg("probe-all-down");
check("全部镜像故障时派发 imgallfailed（呈现失败态）", r3.allFailed === true, JSON.stringify(r3));
ghState.rawFail = false; ghState.cdnFail = false; ghState.staticallyFail = false;

console.log(`\n════════════════════════════════════`);
console.log(`v3.0 步骤2.2 动态相册: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
ghState.ghDown = false;
await browser.close();
apiA.server.close(); apiB.server.close(); apiC.server.close(); staticServer.close(); ghServer.close();
process.exit(fail ? 1 : 0);
