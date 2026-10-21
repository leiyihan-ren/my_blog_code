// ============================================================
// v3.0 步骤 2.1：动态歌单端到端验证
//   S1 worker 层：/api/music 合并后台 KV + GitHub 仓库歌单
//      - music.json 配置模式：file 相对路径 → 同源代理 URL
//      - source 来源标记（local / github）
//   S2 worker 层：music.json 缺失 → 目录扫描回退，URL 同样同源代理化
//   S3 端到端：页面播放仓库曲目（经 /api/github/raw/* 代理）
//      → fetch→Blob 管道 → SW 缓存 → 断网续播
// 运行：node tests/step2-music-dynamic.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav" };

function makeWav(seconds = 2) {
  const rate = 8000, samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buf;
}
const WAV = makeWav();

/* ---------- Mock GitHub 上游 ---------- */
const ghState = { musicJsonMissing: false, calls: [] };
const MUSIC_JSON = JSON.stringify([
  { file: "repo-a.mp3", title: "仓库曲目 Alpha", artist: "GitHub 艺人" },
  { file: "repo-b.wav", title: "仓库曲目 Beta", artist: "" },
]);
const DIR_LIST = JSON.stringify([
  { name: "scan-a.mp3", type: "file", size: 2048, download_url: "https://raw.githubusercontent.com/testowner/testrepo/main/music/scan-a.mp3" },
  { name: "scan-b.wav", type: "file", size: 2048, download_url: "https://raw.githubusercontent.com/testowner/testrepo/main/music/scan-b.wav" },
]);
const ghServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock.github");
  ghState.calls.push(url.pathname);
  const rl = { "X-RateLimit-Remaining": "5000", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
  const j = (body) => { res.writeHead(200, { "Content-Type": "application/json", ...rl }); res.end(body); };
  const nf = () => { res.writeHead(404, { "Content-Type": "application/json", ...rl }); res.end('{"message":"Not Found"}'); };
  if (url.pathname === "/raw/testowner/testrepo/main/music.json") {
    return ghState.musicJsonMissing ? nf() : j(MUSIC_JSON);
  }
  if (url.pathname.startsWith("/raw/testowner/testrepo/main/music/")) { res.writeHead(200, { "Content-Type": "audio/mpeg", ...rl }); return res.end(WAV); }
  if (url.pathname === "/github/repos/testowner/testrepo/contents/music") return j(DIR_LIST);
  if (url.pathname === "/github/repos/testowner/testrepo/contents/music.json") return ghState.musicJsonMissing ? nf() : j(MUSIC_JSON);
  // jsDelivr / statatically 降级源：music.json 与音频都 404（验证官方源优先）
  return nf();
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
  title: "动态歌单测试站", footer: "S2 Test", autoMode: true,
  githubRepo: "testowner/testrepo", githubBranch: "main",
  githubMusicPath: "music", githubAlbumPath: "photos", useCdn: false,
});
const LOCAL_MUSIC = JSON.stringify([
  { id: "l1", title: "后台曲目", artist: "本地歌手", url: "http://localhost:8899/local-song.wav", cover: "" },
]);

function startApi(port, musicJsonMissing) {
  ghState.musicJsonMissing = !!musicJsonMissing;
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
  const envFor = () => ({ SITE_DATA: makeKV({ site: SITE_SEED, music: LOCAL_MUSIC }), GITHUB_TOKEN: "ghp_s2" });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, drain: async () => { await Promise.all(deferred.splice(0)); } })));
}

/* ---------- 静态服务器（8899，含本地曲目 wav + /api 转发到 worker） ----------
   不用 page.route：route fulfill 会绕过 Service Worker（响应 fromSW=false），
   SW 永远缓存不到东西。这里用服务器级代理完整模拟生产链路
   （浏览器 → 同源 → worker → GitHub）。 */
const API_ORIGIN = "http://127.0.0.1:8602";
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
    if (p === "/local-song.wav") { res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": WAV.length }); return res.end(WAV); }
    if (p === "/test-song.wav") { res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": WAV.length }); return res.end(WAV); }
    let fp = p;
    if (fp.endsWith("/")) fp += "index.html";
    const file = path.join(ROOT, fp);
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

/* ============ S1 music.json 配置模式 ============ */
console.log("\n═══ S1 music.json 配置：file 相对路径 → 同源代理 URL ═══");
const apiA = await startApi(8602, false);
{
  const res = await realFetch("http://127.0.0.1:8602/api/music");
  const data = await res.json();
  check("/api/music 返回 200 数组", res.status === 200 && Array.isArray(data), `status=${res.status} len=${data.length}`);
  const gh = data.filter((m) => m.source === "github");
  const local = data.filter((m) => m.source === "local");
  check("合并后台 + 仓库歌单（2+1）", gh.length === 2 && local.length === 1, `github=${gh.length} local=${local.length}`);
  const alpha = data.find((m) => m.title === "仓库曲目 Alpha");
  check("仓库曲目 URL 为同源代理路径", !!alpha && alpha.url === "/api/github/raw/testowner/testrepo/main/music/repo-a.mp3", alpha && alpha.url);
  check("仓库曲目标题/艺术家来自 music.json", !!alpha && alpha.artist === "GitHub 艺人", alpha && `${alpha.title} / ${alpha.artist}`);
  check("后台曲目标记 source=local", local[0] && local[0].source === "local" && local[0].title === "后台曲目");
  const urls = data.map((m) => m.url);
  check("无 download_url 外链残留（全部可缓存）", urls.every((u) => u.startsWith("/") || u.includes("localhost")), urls.join(" | "));
}

/* ============ S2 目录扫描回退 ============ */
console.log("\n═══ S2 music.json 缺失 → 目录扫描回退 ═══");
const apiB = await startApi(8612, true);
{
  const res = await realFetch("http://127.0.0.1:8612/api/music");
  const data = await res.json();
  const gh = data.filter((m) => m.source === "github");
  check("目录扫描生成 2 首仓库歌曲", gh.length === 2, `github=${gh.length}`);
  const a = data.find((m) => m.title === "scan-a");
  check("扫描曲目 URL 同源代理化", !!a && a.url === "/api/github/raw/testowner/testrepo/main/music/scan-a.mp3", a && a.url);
  check("扫描曲目标题取文件名去扩展名", !!a && a.title === "scan-a", a && a.title);
}

/* ============ S3 端到端播放 + 离线 ============ */
console.log("\n═══ S3 端到端：页面播放仓库曲目 → SW 缓存 → 断网续播 ═══");
ghState.musicJsonMissing = false; // 恢复场景 A 的数据形态（ghState 为全局共享）
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
// 不注册 page.route：/api/* 由静态服务器代理到 worker，SW 完整参与链路
await page.goto("http://localhost:8899/index.html", { waitUntil: "load" });
await sleep(2500);
// 预热刷新：首屏 API 请求早于 SW 接管（首次访问的固有现象），
// 刷新一次让 SW 完整接管（与真实用户「第二次访问」同构）后再断言缓存
await page.reload({ waitUntil: "load" });
await sleep(2500);
const firstTitle = await page.evaluate(() => document.getElementById("mpTitle")?.textContent || "");
check("首曲为仓库曲目 Alpha（合并列表第一首）", firstTitle === "仓库曲目 Alpha", `mpTitle="${firstTitle}"`);
const badge = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".mp-playlist-item-title")];
  return { total: items.length, gh: items.filter((t) => t.querySelector(".mp-src-badge")).length };
});
check("播放列表渲染来源徽章（2 个 🐙）", badge.gh === 2 && badge.total === 3, JSON.stringify(badge));

// 播放仓库曲目（经同源代理）
await page.click("#mpPlay");
let playing = false;
try {
  await page.waitForFunction(() => document.getElementById("mpPlay")?.title === "暂停", { timeout: 8000 });
  playing = true;
} catch (e) {}
check("点击播放仓库曲目成功（fetch→Blob 管道）", playing, `title=${await page.evaluate(() => document.getElementById("mpPlay")?.title)}`);
await sleep(1200);
const cached = await page.evaluate(async () => {
  const c = await caches.open("my-blog-runtime-v1");
  const keys = await c.keys();
  return { audio: keys.some((r) => r.url.includes("/api/github/raw/") && r.url.includes("repo-a")), api: keys.some((r) => r.url.includes("/api/music")) };
});
check("仓库音频（代理路径）已入 SW 缓存", cached.audio, JSON.stringify(cached));
check("歌单 API 已入 SWR 缓存", cached.api);

// 断网续播
await context.setOffline(true);
await page.reload({ waitUntil: "load" });
await sleep(2500);
await page.click("#mpPlay");
let playingOffline = false;
try {
  await page.waitForFunction(() => document.getElementById("mpPlay")?.title === "暂停", { timeout: 8000 });
  playingOffline = true;
} catch (e) {}
check("断网刷新后仍能播放仓库曲目", playingOffline, `title=${await page.evaluate(() => document.getElementById("mpPlay")?.title)}`);
const offlineTitle = await page.evaluate(() => document.getElementById("mpTitle")?.textContent || "");
check("断网后歌单仍渲染（SWR 缓存命中）", offlineTitle === "仓库曲目 Alpha", `mpTitle="${offlineTitle}"`);
check("全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | ") || "无");
await context.setOffline(false);

console.log(`\n════════════════════════════════════`);
console.log(`v3.0 步骤2.1 动态歌单: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
await browser.close();
apiA.server.close(); apiB.server.close(); staticServer.close(); ghServer.close();
process.exit(fail ? 1 : 0);
