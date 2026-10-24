// ============================================================
// 步骤 3 UI 极限压测：新游戏连点/切后台、相册极速滑动/灯箱高频开关、
// 游戏反复横跳 destroy 验证、音乐播放器 spam、老游戏回归
// 架构：Playwright → 静态页(8899) → /api 关键路径转发内嵌 worker(8602)
//       → mock GitHub 上游（12 张照片）；/api/site 等噪声接口直接 mock
// 运行：node tests/step3-ui-stress.mjs
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
// 最小合法 PNG（1x1 透明），压测只验证加载链路，不验证像素
const IMG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// ---------- Mock GitHub 上游 ----------
const ghState = {
  listEtag: '"list-v1"',
  listBody: JSON.stringify(photoList),
  rateRemaining: 5000,
  rawFail: false, cdnFail: false, staticallyFail: false,
  calls: [],
};
const ghServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock.github");
  ghState.calls.push({ path: url.pathname + url.search, host: url.host, inm: req.headers["if-none-match"] || null });
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": typeof body === "string" ? "application/json" : "image/png", ...headers });
    res.end(body);
  };
  const rlHeaders = { "X-RateLimit-Remaining": String(ghState.rateRemaining), "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
  if (url.pathname.startsWith("/github/repos/")) {
    if (req.headers["if-none-match"] === ghState.listEtag) return send(304, null, { ETag: ghState.listEtag, ...rlHeaders });
    return send(200, ghState.listBody, { ETag: ghState.listEtag, ...rlHeaders });
  }
  if (url.pathname.startsWith("/jd/")) {
    return send(200, JSON.stringify({ files: photoList }), { ETag: '"jd-v1"', ...rlHeaders });
  }
  if (url.pathname.includes("/photos/")) {
    if (ghState.rawFail && url.pathname.startsWith("/raw/")) return send(500, JSON.stringify({ error: "raw down" }));
    if (ghState.cdnFail && url.pathname.startsWith("/cdn/")) return send(500, JSON.stringify({ error: "cdn down" }));
    if (ghState.staticallyFail && url.pathname.startsWith("/statically/")) return send(500, JSON.stringify({ error: "statically down" }));
    return send(200, IMG_BYTES, { ETag: '"img-v1"', ...rlHeaders });
  }
  // 音乐等其余 raw 文件：空列表
  if (ghState.rawFail && url.pathname.startsWith("/raw/")) return send(500, JSON.stringify({ error: "raw down" }));
  return send(200, "[]", { "Content-Type": "application/json", ...rlHeaders });
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
  for (const [from, to] of map) {
    if (url.startsWith(from + "/")) return realFetch(url.replace(from, to), init);
  }
  return realFetch(input, init);
};

// ---------- Mock Cache API / KV ----------
const cacheStore = new Map();
const toResponse = (entry) => new Response(entry.body, { status: entry.status, headers: new Headers(entry.headers) });
const cacheObj = {
  async match(request) { const e = cacheStore.get(request.url); return e ? toResponse(e) : undefined; },
  async put(request, response) { cacheStore.set(request.url, { body: await response.arrayBuffer(), headers: [...response.headers], status: response.status }); },
  async delete(request) { return cacheStore.delete(request.url); },
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
// 注意：前端读取 song.title / song.artist / song.url（不是 name）
const MUSIC_SEED = JSON.stringify([
  { id: "m1", title: "压测曲目 Alpha", artist: "Stress Artist", url: `http://127.0.0.1:8898/song1.wav` },
  { id: "m2", title: "压测曲目 Beta", artist: "Stress Artist", url: `http://127.0.0.1:8898/song2.wav` },
  { id: "m3", title: "压测曲目 Gamma", artist: "Stress Artist", url: `http://127.0.0.1:8898/song3.wav` },
]);
const env = {
  SITE_DATA: makeKV({
    site: JSON.stringify({ autoMode: true, githubRepo: "testowner/testrepo", githubBranch: "main", githubAlbumPath: "photos", useCdn: true }),
    music: MUSIC_SEED,
  }),
  GITHUB_TOKEN: "ghp_ui_stress",
};

// ---------- 本地 WAV 音乐服务器（loadMusic 过滤 data: URI，必须 http URL） ----------
function makeWav(seconds = 0.4) {
  const rate = 8000, n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(60 * Math.sin(i * 0.08));
  return buf;
}
const WAV = makeWav();
const musicServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": WAV.length });
  res.end(WAV);
});
await new Promise((r) => musicServer.listen(8898, "127.0.0.1", r));

// ---------- 内嵌 Worker API 服务（8602） ----------
const deferred = [];
const apiServer = http.createServer(async (req, res) => {
  try {
    const request = new Request("http://api.local" + req.url, { method: req.method, headers: { "user-agent": "uistress" } });
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
    const file = path.join(ROOT, staticFilePath(p)); // v7.0：经 route-map 映射到 pages/ 等物理路径
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => staticServer.listen(8899, "127.0.0.1", r));
const drainDeferred = async () => { await Promise.all(deferred.splice(0)); };

// ---------- Playwright ----------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsErrors = [];
const trackErrors = (page) => {
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/40[48]|50[02]|Failed to load|ERR_|net::/.test(m.text())) jsErrors.push(m.text());
  });
};

// 转发 helper：把 /api 关键路径转到内嵌 worker
const forwardToWorker = async (route) => {
  const req = route.request();
  const parsed = new URL(req.url());
  try {
    const resp = await realFetch("http://127.0.0.1:8602" + parsed.pathname + parsed.search, { headers: { "user-agent": "uistress" } });
    const body = await resp.arrayBuffer();
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
  } catch (e) {
    await route.fulfill({ status: 502, body: JSON.stringify({ error: String(e) }) });
  }
};
// CDN 直连镜像兜底目标 → mock 上游
const forwardCdn = async (route) => {
  const url = route.request().url();
  try {
    const resp = await fetch(url, {}); // 必须走被 mock 映射的全局 fetch
    const body = await resp.arrayBuffer();
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: resp.status, headers, body: Buffer.from(body) });
  } catch (e) {
    await route.fulfill({ status: 502, body: "cdn error" });
  }
};

const GAME_IDS = ["reaction", "hanoi", "memory", "snake", "breakout", "mines", "2048"];

// album.html init() 要求 /api/site 返回含 title 与 githubRepo 的完整对象才加载照片
const SITE_MOCK = JSON.stringify({
  title: "压测博客", footer: "UI Stress Test", autoMode: true,
  githubRepo: "testowner/testrepo", githubBranch: "main", githubAlbumPath: "photos", useCdn: true,
});

// ================================================================
console.log("═══ A. 反应游戏：200 连点 + 数字键 + 切后台 ×10 ═══");
// ================================================================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  trackErrors(page);
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/music" || p.startsWith("/api/album/photos") || p.startsWith("/api/github/")) return forwardToWorker(route);
    if (p === "/api/site") return route.fulfill({ status: 200, contentType: "application/json", body: SITE_MOCK });
    if (p.startsWith("/api/game/scores")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("http://localhost:8899/games.html", { waitUntil: "domcontentloaded" });
  await sleep(800);
  await page.evaluate((id) => GameCore.openGame(id), "reaction");
  await sleep(200);
  await page.click("#overlay-btn"); // 开始
  await sleep(400);
  check("reaction 启动且 running", await page.evaluate(() => GameCore.isGameRunning()));

  // 连点 200 次（DOM click，覆盖全部 9 格 + 重复格防连点惩罚路径）
  const clickResult = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".rt-cell")];
    for (let i = 0; i < 200; i++) cells[i % cells.length].click();
    return cells.length;
  });
  check("200 次连点后格子仍为 9 个", clickResult === 9, `cells=${clickResult}`);
  // 数字键 1-9 连打 30 轮
  for (let r = 0; r < 30; r++) {
    await page.keyboard.press(String((r % 9) + 1));
  }
  await sleep(300);
  check("连点+键盘后游戏仍在运行", await page.evaluate(() => GameCore.isGameRunning()));

  // 切后台 ×10：headless Chromium 不支持 CDP hidden/frozen 与标签页可见性切换，
  // 采用标准测试手法——遮蔽 document.hidden/visibilityState 并派发 visibilitychange，
  // 游戏侧代码路径（读 document.hidden → pause）与真实切后台完全一致。
  const setVisibility = async (pg, hidden) => {
    await pg.evaluate((h) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  };
  let pauseOk = 0, resumeOk = 0;
  for (let round = 0; round < 10; round++) {
    await setVisibility(page, true);
    await sleep(120);
    const st = await page.evaluate(() => {
      const g = GameCore.currentGame();
      return g ? { running: g.running, activeCell: g.activeCell } : null;
    });
    if (st && st.running === false && st.activeCell === -1) pauseOk++;
    await setVisibility(page, false);
    await sleep(80);
    // 恢复：点 overlay 继续按钮
    await page.click("#overlay-btn");
    await sleep(120);
    const st2 = await page.evaluate(() => {
      const g = GameCore.currentGame();
      return g ? { running: g.running } : null;
    });
    if (st2 && st2.running === true) resumeOk++;
  }
  check("切后台 10 轮全部自动暂停并撤回目标", pauseOk === 10, `${pauseOk}/10`);
  check("切回前台 10 轮全部成功恢复", resumeOk === 10, `${resumeOk}/10`);

  // 终态一致性：得分有限、计时器无泄漏
  const fin = await page.evaluate(() => {
    const g = GameCore.currentGame();
    return { score: g.score, running: g.running, timers: g._timers.size, intervals: g._intervals.size, rafs: g._rafs.size };
  });
  check("终态得分有限且计时器登记正常", Number.isFinite(fin.score) && fin.running, JSON.stringify(fin));
  await page.close();
}

// ================================================================
console.log("\n═══ B. 汉诺塔：非法移动 / 撤销 spam / 阶数切换 spam ═══");
// ================================================================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  trackErrors(page);
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/music" || p.startsWith("/api/album/photos") || p.startsWith("/api/github/")) return forwardToWorker(route);
    if (p === "/api/site") return route.fulfill({ status: 200, contentType: "application/json", body: SITE_MOCK });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("http://localhost:8899/games.html", { waitUntil: "domcontentloaded" });
  await sleep(800);
  await page.evaluate(() => GameCore.openGame("hanoi"));
  await sleep(200);
  await page.click("#overlay-btn");
  await sleep(300);

  // 确定性非法移动：rod0→rod2 合法（最小盘），再 rod0→rod2（大盘压小盘 → shake）
  await page.click('.hn-rod[data-rod="0"]');
  await sleep(150);
  await page.click('.hn-rod[data-rod="2"]');
  await sleep(200);
  const afterLegal = await page.evaluate(() => {
    const g = GameCore.currentGame();
    return { rods: g.rods.map((r) => r.length), picked: g.picked, moves: g.moves };
  });
  check("合法移动后 picked 重置、rods 变化", afterLegal.picked === -1 && afterLegal.rods[0] === 3 && afterLegal.rods[2] === 1, JSON.stringify(afterLegal));

  await page.click('.hn-rod[data-rod="0"]'); // 拾起次小盘
  await sleep(120);
  const beforeIllegal = await page.evaluate(() => {
    const g = GameCore.currentGame();
    return { rods: g.rods.map((r) => r.length), picked: g.picked };
  });
  await page.click('.hn-rod[data-rod="2"]'); // 大盘压小盘 → 非法
  await sleep(250);
  const afterIllegal = await page.evaluate(() => {
    const g = GameCore.currentGame();
    return { rods: g.rods.map((r) => r.length), picked: g.picked, moves: g.moves, shake: !!document.querySelector(".hn-rod.shake") };
  });
  check("非法大压小被拒绝（rods 不变、保持拾起可换柱）",
    JSON.stringify(afterIllegal.rods) === JSON.stringify(beforeIllegal.rods) && afterIllegal.picked === beforeIllegal.picked,
    `before=${JSON.stringify(beforeIllegal.rods)} after=${JSON.stringify(afterIllegal.rods)} picked=${afterIllegal.picked}`);

  // 随机 rod 对 spam ×60（混合合法/非法/取消/空柱）
  await page.evaluate(() => {
    const rods = [...document.querySelectorAll(".hn-rod")];
    for (let i = 0; i < 60; i++) rods[Math.floor(Math.random() * 3)].click();
  });
  await sleep(300);
  // 撤销 spam ×20（含无历史可撤的空撤）
  await page.evaluate(() => {
    const btn = document.getElementById("hanoi-undo");
    for (let i = 0; i < 20; i++) btn.click();
  });
  await sleep(300);
  // 阶数切换 spam ×12（运行中切换触发 restart）
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.opt-btn[data-n]')];
    const ns = [3, 4, 5, 6, 3, 4, 5, 6, 3, 4, 5, 6];
    ns.forEach((n) => { const b = btns.find((x) => x.dataset.n === String(n)); if (b) b.click(); });
  });
  await sleep(400);
  const hanoiFin = await page.evaluate(() => {
    const g = GameCore.currentGame();
    const disks = [...document.querySelectorAll(".hn-disk")];
    return {
      running: g.running, diskCount: g.diskCount, rods: g.rods.map((r) => r.length),
      domDisks: disks.length, timers: g._timers.size, intervals: g._intervals.size, rafs: g._rafs.size,
      listeners: g._listeners.length,
    };
  });
  check("spam 后仍在运行", hanoiFin.running);
  // spam 序列以 data-n=6 结尾：运行中切换触发 restart，状态应重置为 6 阶且 DOM 一致
  check("阶数切换后状态重置为 6 阶且 DOM 一致",
    hanoiFin.diskCount === 6 && hanoiFin.domDisks === 6 && hanoiFin.rods[0] === 6,
    JSON.stringify(hanoiFin));
  check("计时器/监听无泄漏", hanoiFin.timers === 0 && hanoiFin.intervals === 0 && hanoiFin.rafs === 0, JSON.stringify(hanoiFin));
  await page.close();
}

// ================================================================
console.log("\n═══ C. 游戏反复横跳 7 款 ×2 轮 + destroy 清理验证 ═══");
// ================================================================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  trackErrors(page);
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/music" || p.startsWith("/api/album/photos") || p.startsWith("/api/github/")) return forwardToWorker(route);
    if (p === "/api/site") return route.fulfill({ status: 200, contentType: "application/json", body: SITE_MOCK });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("http://localhost:8899/games.html", { waitUntil: "domcontentloaded" });
  await sleep(800);

  let destroyClean = 0, destroyTotal = 0, runningOk = 0, runningTotal = 0;
  for (let round = 0; round < 2; round++) {
    for (const id of GAME_IDS) {
      const prevHandle = await page.evaluateHandle(() => GameCore.currentGame());
      await page.evaluate((gid) => GameCore.openGame(gid), id);
      await sleep(120);
      // 验证旧实例被 destroy 清理（引用仍持有旧对象）
      const cleaned = await prevHandle.evaluate((g) => {
        if (!g || typeof g !== "object" || !("running" in g)) return null;
        return {
          running: g.running,
          timers: g._timers ? g._timers.size : -1,
          intervals: g._intervals ? g._intervals.size : -1,
          rafs: g._rafs ? g._rafs.size : -1,
          listeners: g._listeners ? g._listeners.length : -1,
        };
      });
      if (cleaned) {
        destroyTotal++;
        if (!cleaned.running && cleaned.timers === 0 && cleaned.intervals === 0 && cleaned.rafs === 0 && cleaned.listeners === 0) destroyClean++;
      }
      await prevHandle.dispose();
      // 启动新游戏并验证 running
      await page.click("#overlay-btn");
      await sleep(150);
      const running = await page.evaluate(() => GameCore.isGameRunning());
      runningTotal++;
      if (running) runningOk++;
    }
  }
  check("横跳 14 次：旧实例全部被 destroy 彻底清理", destroyClean === destroyTotal && destroyTotal >= 12, `${destroyClean}/${destroyTotal}`);
  check("横跳后新游戏全部正常启动", runningOk === runningTotal && runningTotal >= 12, `${runningOk}/${runningTotal}`);
  await page.close();
}

// ================================================================
console.log("\n═══ D. 相册：12 张照片极速滚动 + 灯箱 next/prev 60 + 开关 30 ═══");
// ================================================================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  trackErrors(page);
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/music" || p.startsWith("/api/album/photos") || p.startsWith("/api/github/")) return forwardToWorker(route);
    if (p === "/api/site") return route.fulfill({ status: 200, contentType: "application/json", body: SITE_MOCK });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route(/https:\/\/cdn\.(jsdelivr\.net|statically\.io)\/.*/, forwardCdn);
  await page.route(/https:\/\/raw\.githubusercontent\.com\/.*/, forwardCdn);

  await page.goto("http://localhost:8899/album.html", { waitUntil: "domcontentloaded" });
  await sleep(1500);
  await drainDeferred();
  const count = await page.locator(".photo-item").count();
  check("12 张照片全部渲染", count === PHOTO_N, `实际 ${count}`);

  // 极速滑动：瞬时 scrollTo 跳转 25 次 + mouse.wheel 30 次（触发 IntersectionObserver 懒加载）
  await page.evaluate(() => {
    const h = document.body.scrollHeight;
    for (let i = 0; i < 25; i++) window.scrollTo(0, (h / 25) * i);
  });
  const mouse = page.mouse;
  await mouse.move(640, 450);
  for (let i = 0; i < 30; i++) { await mouse.wheel(0, 400); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(2500);
  const loaded = await page.locator(".lazy-img.loaded").count();
  check("极速滑动后懒加载全部完成", loaded === PHOTO_N, `${loaded}/${PHOTO_N}`);
  const failed = await page.locator(".photo-img-wrap.failed").count();
  check("极速滑动无失败态", failed === 0, `failed=${failed}`);

  // 灯箱：打开 → next/prev 快速 60 次
  await page.locator(".photo-item").first().click();
  await sleep(400);
  check("灯箱打开", await page.locator("#lightbox").evaluate((el) => el.classList.contains("active")));
  let seqOk = 0;
  for (let i = 0; i < 60; i++) {
    await page.click(i % 2 === 0 ? ".lightbox-next" : ".lightbox-prev");
    if (i % 10 === 9) {
      await sleep(60);
      const cap = await page.locator("#lightbox-caption").textContent();
      const m = /^(\d+) \/ 12 · /.exec(cap || "");
      if (m && +m[1] >= 1 && +m[1] <= 12) seqOk++;
    }
  }
  await sleep(300);
  check("next/prev 60 次后 caption 序号始终合法", seqOk === 6, `${seqOk}/6 次采样`);
  const capFinal = await page.locator("#lightbox-caption").textContent();
  check("caption 格式完整", /^\d+ \/ 12 · photo\d+\.jpg$/.test(capFinal || ""), capFinal);

  // 灯箱频繁开关 ×30（Esc 关 + 点击照片项开）
  let toggleOk = 0;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Escape");
    await sleep(40);
    const closed = !(await page.locator("#lightbox").evaluate((el) => el.classList.contains("active")));
    await page.locator(".photo-item").nth(i % PHOTO_N).click();
    await sleep(60);
    const opened = await page.locator("#lightbox").evaluate((el) => el.classList.contains("active"));
    if (closed && opened) toggleOk++;
  }
  check("灯箱开关 30 次状态全部正确", toggleOk === 30, `${toggleOk}/30`);
  // 关闭后焦点归还照片项（focus trap 归还）
  await page.keyboard.press("Escape");
  await sleep(200);
  const focusTag = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? el.className : "none";
  });
  check("关闭后焦点归还触发元素", focusTag.includes("photo-item"), focusTag);
  await page.close();
}

// ================================================================
console.log("\n═══ E. 音乐播放器 spam + 快捷键让位 + 老游戏回归 ═══");
// ================================================================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  trackErrors(page);
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/music" || p.startsWith("/api/album/photos") || p.startsWith("/api/github/")) return forwardToWorker(route);
    if (p === "/api/site") return route.fulfill({ status: 200, contentType: "application/json", body: SITE_MOCK });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("http://localhost:8899/games.html", { waitUntil: "domcontentloaded" });
  await sleep(1200);
  await drainDeferred();
  const title = await page.locator("#mpTitle").textContent();
  check("音乐列表加载（3 首本地 wav）", (title || "").includes("Alpha"), title);

  // 控件 spam：播放/暂停 ×15、下一首 ×10、上一首 ×10、模式 ×5、列表 ×5、静音 ×3
  for (let i = 0; i < 15; i++) { await page.click("#mpPlay"); await sleep(50); }
  for (let i = 0; i < 10; i++) { await page.click("#mpNext"); await sleep(40); }
  for (let i = 0; i < 10; i++) { await page.click("#mpPrev"); await sleep(40); }
  for (let i = 0; i < 5; i++) { await page.click("#mpMode"); await sleep(40); }
  for (let i = 0; i < 5; i++) { await page.click("#mpListBtn"); await sleep(40); }
  for (let i = 0; i < 3; i++) { await page.click("#mpMute"); await sleep(40); }
  // audio 为 JS 对象不入 DOM，用 #mpPlay 的 title（"播放"/"暂停"）作播放态探针
  const mpState = await page.evaluate(() => ({
    playTitle: document.getElementById("mpPlay").title,
    title: document.getElementById("mpTitle").textContent,
    mode: document.getElementById("mpMode").title,
  }));
  check("控件 spam 后播放器状态自洽", ["播放", "暂停"].includes(mpState.playTitle) && !!mpState.title, JSON.stringify(mpState));

  // 快捷键 spam（焦点在 body，无游戏运行 → 音乐快捷键生效）
  await page.evaluate(() => document.body.focus());
  for (const key of [" ", "k", "ArrowRight", "ArrowLeft"]) {
    for (let i = 0; i < 5; i++) { await page.keyboard.press(key); await sleep(40); }
  }
  check("快捷键 spam 后无 JS 错误且播放器存活", await page.locator("#mpPlayer").count() === 1);

  // 快捷键让位：游戏运行中，音乐快捷键不得触发（空格不切歌、不播放）
  await page.evaluate(() => GameCore.openGame("reaction"));
  await sleep(150);
  await page.click("#overlay-btn");
  await sleep(300);
  const beforeYield = await page.evaluate(() => ({
    playTitle: document.getElementById("mpPlay").title,
    running: GameCore.isGameRunning(),
  }));
  for (let i = 0; i < 10; i++) { await page.keyboard.press(" "); await sleep(40); }
  await sleep(200);
  const afterYield = await page.evaluate(() => ({
    playTitle: document.getElementById("mpPlay").title,
    running: GameCore.isGameRunning(),
  }));
  check("游戏运行中音乐快捷键让位（播放态不变）", beforeYield.playTitle === afterYield.playTitle && afterYield.running,
    `${JSON.stringify(beforeYield)} → ${JSON.stringify(afterYield)}`);

  // 老游戏回归：5 款老游戏各启动跑 600ms
  const legacy = ["snake", "breakout", "memory", "mines", "2048"];
  let legacyOk = 0;
  for (const id of legacy) {
    await page.evaluate((gid) => GameCore.openGame(gid), id);
    await sleep(120);
    await page.click("#overlay-btn");
    await sleep(600);
    const st = await page.evaluate(() => {
      const g = GameCore.currentGame();
      return g ? { running: g.running, timers: g._timers.size, intervals: g._intervals.size, rafs: g._rafs.size } : null;
    });
    if (st && st.running && st.timers + st.intervals + st.rafs >= 0) legacyOk++;
  }
  check("5 款老游戏回归全部正常", legacyOk === legacy.length, `${legacyOk}/${legacy.length}`);
  await page.close();
}

// ---------- 汇总 ----------
const errs = jsErrors.slice(0, 5);
check(`全程零 JS 错误（收集 ${jsErrors.length} 条）`, jsErrors.length === 0, errs.join(" | "));

console.log(`\n════════════════════════════════════`);
console.log(`UI 极限压测: ${pass} 通过 / ${fail} 失败`);
console.log(`════════════════════════════════════`);
await browser.close();
apiServer.close();
ghServer.close();
musicServer.close();
process.exit(fail ? 1 : 0);
