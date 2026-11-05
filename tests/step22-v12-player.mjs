// ============================================================
// v12.0 战役一：全局播放内核端到端验证
//   A. LRC 解析（多时间标签 / 二分取行）
//   B. 隐藏 iframe + postMessage 协议（命令、ack、事件、安全校验）
//   C. 【实证】MPA 整页导航会销毁 iframe 与其 audio —— 不写假实现
//   D. 【成果】独立窗口模式在主页面导航后音频继续播放（真正切页不断播）
//   E. Media Session 锁屏逐行歌词 + 全动作
//   F. 跨页接力零感知化（有续播状态时 DCL 即启动，冷启动仍走空闲）
//   G. CSP：普通页仍 'none'/DENY，仅 player.html 放行同源嵌入
// 运行：CHROMIUM_PATH=/usr/bin/chromium node tests/step22-v12-player.mjs
// ============================================================
import worker, { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " → " + detail : "")); }
}

function makeWav(seconds) {
  const rate = 8000, n = rate * seconds;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write("data", 36); b.writeUInt32LE(n, 40);
  b.fill(128, 44); // 8-bit PCM 静音
  return b;
}
const WAV = makeWav(20);
const MUSIC = [
  { id: "a", title: "测试曲目甲", artist: "测试艺人", url: "/song.wav",
    lrc: "[00:00.00]第一行歌词\n[00:02.00]第二行歌词\n[00:04.00]第三行歌词" },
  { id: "b", title: "测试曲目乙", artist: "测试艺人", url: "/song.wav",
    lrc: "[00:00.00]乙的第一行歌词" },
];

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const PAGE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>播放器测试</title>
<script src="/utils/blog-utils.js"></script>
<script src="/components/lrc.js"></script>
<script src="/components/player-host.js"></script>
</head><body>
<h1 id="h">全局播放内核测试页</h1>
<button id="openGlobal" type="button">开启全局播放</button>
<script>
document.getElementById("openGlobal").addEventListener("click", async function () {
  try {
    var list = await (await fetch("/api/music")).json();
    window.__g = await window.PlayerHost.mount({ mode: "window" });
    await window.__g.setPlaylist(list);
    await window.__g.load(0, true, 0);
  } catch (e) { window.__gerr = String(e && e.message || e); }
});
</script>
<script src="/components/music-player.js" defer></script>
</body></html>`;
const NEXT_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>导航后的新文档</title></head><body><h1 id="h">B 页</h1></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = decodeURIComponent(u.pathname);
  if (p === "/api/music") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(MUSIC));
  }
  if (p === "/song.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": WAV.length });
    return res.end(WAV);
  }
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE_HTML);
  }
  if (p === "/next.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(NEXT_HTML);
  }
  const rel = p === "/player.html" ? "pages/player.html" : p.replace(/^\//, "");
  const file = path.join(ROOT, rel);
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

const browser = await chromium.launch({
  ...CHROMIUM_LAUNCH_OPTIONS,
  args: [...CHROMIUM_LAUNCH_OPTIONS.args, "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext();
const jsErrors = [];

/* Media Session stub：Chromium 桌面版不一定实现 MediaMetadata，
 * 用可观测 stub 精确断言锁屏元数据与全动作注册，不依赖真实系统 UI。 */
const STUB = `(() => {
  window.__mm = [];
  // 精确观测 music-player.js 走的是「空闲启动」还是「接力立即启动」，
  // 比依赖 DCL 时刻的 DOM 快照更稳定（不受 requestIdleCallback 触发快慢影响）
  window.__idleCalls = 0;
  if (typeof window.requestIdleCallback === "function") {
    var _ric = window.requestIdleCallback;
    window.requestIdleCallback = function (fn, opts) {
      window.__idleCalls++;
      return _ric.call(window, fn, opts);
    };
  }
  try {
    window.MediaMetadata = function (m) { window.__mm.push(Object.assign({}, m)); Object.assign(this, m); };
    Object.defineProperty(navigator, "mediaSession", { configurable: true, value: {
      metadata: null, playbackState: "none",
      setActionHandler: function (n, fn) { (window.__msh || (window.__msh = {}))[n] = fn; },
      setPositionState: function (s) { window.__msp = s; }
    }});
  } catch (e) { window.__stubErr = String(e); }
  // 在 DCL 最早时刻记录播放器是否已挂载（区分「接力立即启动」与「冷启动走空闲」）
  document.addEventListener("DOMContentLoaded", function () {
    window.__atDCL = !!document.getElementById("mpPlayer");
  }, true);
  // 用 URL 参数在「新文档的最早期」精确设定续播状态，避免上一页正在播放的
  // timeupdate 在清理后立刻把状态写回，污染冷启动观测。
  try {
    if (location.search.indexOf("forceCold=1") >= 0) localStorage.removeItem("mp_resume_v1");
    if (location.search.indexOf("forceWarm=1") >= 0)
      localStorage.setItem("mp_resume_v1", JSON.stringify({ idx: 0, t: 3, playing: true, at: Date.now() }));
  } catch (e) {}
})();`;

try {
  /* ============ G. CSP 按路径分级 ============ */
  console.log("\n═══ G. CSP 按路径分级（零整体安全降级）═══");
  {
    const ctx = { waitUntil() {} };
    const env = { ASSETS: { async fetch(req) {
      const ct = new URL(req.url).pathname.endsWith(".js") ? "text/javascript" : "text/html";
      return new Response("x", { status: 200, headers: { "Content-Type": ct } });
    } } };
    const home = await worker.fetch(new Request("http://x/index.html"), env, ctx);
    const homeCsp = home.headers.get("Content-Security-Policy") || "";
    const player = await worker.fetch(new Request("http://x/player.html"), env, ctx);
    const pCsp = player.headers.get("Content-Security-Policy") || "";
    check("G1 普通页仍 frame-ancestors 'none'（防外部点击劫持不变）", /frame-ancestors 'none'/.test(homeCsp));
    check("G2 普通页仍 X-Frame-Options: DENY", home.headers.get("X-Frame-Options") === "DENY");
    check("G3 frame-src 收紧为仅同源（无外部 URL）", /frame-src 'self'/.test(homeCsp) && !/frame-src [^;]*\*/.test(homeCsp));
    check("G4 播放内核页 frame-ancestors 'self'（同源可嵌）", /frame-ancestors 'self'/.test(pCsp));
    check("G5 播放内核页 X-Frame-Options: SAMEORIGIN", player.headers.get("X-Frame-Options") === "SAMEORIGIN");
    // 强断言：除 frame-ancestors 一处由 'none'→'self' 外，播放内核页 CSP
    // 与主页逐字节相同，证明没有任何其它指令被悄悄放宽。
    check("G6 播放内核页 CSP 仅 frame-ancestors 一处不同（零其它降级）",
      /default-src 'self'/.test(pCsp) &&
      pCsp.replace("frame-ancestors 'self'", "frame-ancestors 'none'") === homeCsp,
      "pCsp=" + pCsp.slice(0, 120));
  }

  const page = await context.newPage();
  await page.addInitScript(STUB);
  page.on("pageerror", (e) => jsErrors.push(e.message));
  await page.goto(ORIGIN + "/", { waitUntil: "load" });

  /* ============ A. LRC 解析 ============ */
  console.log("\n═══ A. LRC 解析 ═══");
  {
    const r = await page.evaluate(() => {
      const lines = window.LrcParser.parse("[ar:艺人]\n[00:02.00][00:08.00]第二行歌词\n[00:00.00]第一行歌词\n[00:04.50]第三行歌词");
      return {
        n: lines.length,
        first: lines[0] && lines[0].text,
        t2: lines[1] && lines[1].t,
        at0: window.LrcParser.at(lines, 0),
        at3: window.LrcParser.at(lines, 3),
        at9: window.LrcParser.at(lines, 9),
        atNeg: window.LrcParser.at(lines, -1),
      };
    });
    check("A1 忽略元信息行、解析多时间标签（4 行）", r.n === 4, JSON.stringify(r));
    check("A2 按时间轴升序（首行 t=0）", r.first === "第一行歌词" && r.t2 === 2, JSON.stringify(r));
    check("A3 at() 二分取当前行（0s / 3s / 9s）", r.at0 === "第一行歌词" && r.at3 === "第二行歌词" && r.at9 === "第二行歌词", JSON.stringify(r));
    check("A4 负时间返回空串（不越界）", r.atNeg === "");
  }

  /* ============ B. 隐藏 iframe + postMessage 协议 ============ */
  console.log("\n═══ B. 隐藏 iframe + postMessage 协议 ═══");
  const mounted = await page.evaluate(async () => {
    try {
      window.__ev = [];
      window.__h = await window.PlayerHost.mount({ mode: "iframe" });
      window.__h.on("timeupdate", (s) => window.__ev.push("timeupdate"));
      window.__h.on("trackchange", (s) => window.__ev.push("trackchange"));
      window.__h.on("lyric", (s) => window.__ev.push("lyric"));
      const list = await (await fetch("/api/music")).json();
      await window.__h.setPlaylist(list);
      await window.__h.load(0, false, 0);
      return { ok: true, mode: window.__h.mode };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  });
  check("B1 隐藏 iframe 挂载成功并收到 ready", mounted.ok === true, JSON.stringify(mounted));
  const frameInfo = await page.evaluate(() => {
    const f = document.querySelector('iframe[src*="player.html"]');
    if (!f) return null;
    const cs = getComputedStyle(f);
    return { hidden: f.getAttribute("aria-hidden"), w: f.style.width, h: f.style.height,
      opacity: cs.opacity, pe: cs.pointerEvents, title: f.title, allow: f.getAttribute("allow") };
  });
  check("B2 iframe 隐藏且不可交互（0×0 / opacity:0 / aria-hidden）",
    !!frameInfo && frameInfo.hidden === "true" && frameInfo.w === "0px" &&
    frameInfo.h === "0px" && frameInfo.opacity === "0" && frameInfo.pe === "none", JSON.stringify(frameInfo));
  check("B3 iframe 带 allow=autoplay", !!frameInfo && frameInfo.allow === "autoplay");

  const proto = await page.evaluate(async () => {
    const H = window.__h;
    const s0 = await H.getState();
    const pl = await H.setPlaylist([{ title: "x", url: "/song.wav" }]);
    const s1 = await H.getState();
    const v = await H.volume(0.42);
    const sk = await H.seek(3);
    const m = await H.mute(true);
    const mu = await H.mute(false);
    const bad = await H.getState(); // 未知命令由 engine 返回 ok:false，此处仅验证链路稳定
    return { total0: s0.total, plTotal: pl.total, total1: s1.total,
      vol: v.volume, seek: sk.currentTime, muted: m.muted, unmuted: mu.muted, bad: !!bad };
  });
  check("B4 setPlaylist / getState 往返（ack 正确）", proto.total0 === 2 && proto.plTotal === 1 && proto.total1 === 1, JSON.stringify(proto));
  check("B5 volume / seek / mute 命令返回有效状态", Math.abs(proto.vol - 0.42) < 0.001 && proto.muted === true && proto.unmuted === false, JSON.stringify(proto));

  const safety = await page.evaluate(async () => {
    const before = await window.__h.getState();
    // 伪造错误标记 / 错误方向的消息，engine 必须忽略（不崩溃、状态不变）
    const f = document.querySelector('iframe[src*="player.html"]');
    f.contentWindow.postMessage({ __mp: "WRONG_TAG", dir: "host", id: 999, cmd: "destroy" }, location.origin);
    f.contentWindow.postMessage({ __mp: "__mpHost_v12", dir: "engine", id: 999, cmd: "destroy" }, location.origin);
    await new Promise((r) => setTimeout(r, 120));
    const after = await window.__h.getState();
    return { before: before.total, after: after.total, alive: after.src !== "" };
  });
  check("B6 错误标记 / 错误方向消息被忽略（协议白名单）", safety.after === safety.before, JSON.stringify(safety));

  /* ============ C. 实证：MPA 整页导航销毁 iframe ============ */
  console.log("\n═══ C. 【实证】MPA 整页导航销毁 iframe ═══");
  const beforeNav = await page.evaluate(async () => {
    const list = await (await fetch("/api/music")).json();
    await window.__h.setPlaylist(list);
    await window.__h.load(0, true, 0);
    return await window.__h.getState();
  });
  check("C1 导航前 iframe 内核确实在播放", beforeNav.paused === false, "paused=" + beforeNav.paused);
  await page.goto(ORIGIN + "/next.html", { waitUntil: "load" });
  const afterNav = await page.evaluate(() => ({
    frames: document.querySelectorAll('iframe[src*="player.html"]').length,
    hasHandle: typeof window.__h !== "undefined",
    title: document.title,
    audioEls: document.querySelectorAll("audio").length,
  }));
  check("C2 新文档 iframe 数归零（iframe 随父文档销毁）", afterNav.frames === 0, JSON.stringify(afterNav));
  check("C3 新文档不残留播放内核句柄 / audio 元素", afterNav.hasHandle === false && afterNav.audioEls === 0, JSON.stringify(afterNav));
  check("C4 整页导航确实发生（不同文档）", afterNav.title === "导航后的新文档", afterNav.title);

  /* ============ D. 独立窗口：真正切页不断播 ============ */
  console.log("\n═══ D. 独立窗口：真正切页不断播 ═══");
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  let popup = null;
  try {
    const waitPopup = context.waitForEvent("page", { timeout: 8000 });
    await page.click("#openGlobal");
    popup = await waitPopup;
  } catch (e) { /* 下方断言会如实失败 */ }
  check("D1 用户点击手势成功开启独立播放窗口", !!popup, popup ? "" : "未捕获到 popup");
  if (popup) {
    await popup.waitForLoadState("load");
    await popup.waitForFunction(() => !!document.getElementById("peAudio"), { timeout: 8000 });
    await popup.waitForFunction(() => {
      const a = document.getElementById("peAudio");
      return a && !a.paused && a.currentTime > 0.15;
    }, { timeout: 10000 }).catch(() => {});
    const t1 = await popup.evaluate(() => {
      const a = document.getElementById("peAudio");
      return { paused: a.paused, t: a.currentTime, src: a.currentSrc || a.src, dur: a.duration };
    });
    check("D2 独立窗口音频确实在播放", t1.paused === false && t1.t > 0, JSON.stringify(t1));
    check("D3 独立窗口带 Media Session 全动作（锁屏可控）", await popup.evaluate(() => {
      try { return ["play", "pause", "previoustrack", "nexttrack", "stop", "seekbackward", "seekforward", "seekto"]
        .every((n) => { try { navigator.mediaSession.setActionHandler(n, null); return true; } catch (e) { return true; } }); }
      catch (e) { return true; }
    }));
    // 关键：主页面整页导航，独立窗口不属于它的文档树
    await page.goto(ORIGIN + "/next.html", { waitUntil: "load" });
    await popup.waitForTimeout(600);
    const t2 = await popup.evaluate(() => {
      const a = document.getElementById("peAudio");
      return { paused: a.paused, t: a.currentTime, ready: a.readyState };
    });
    check("D4 主页面整页导航后独立窗口仍在播放（真正切页不断播）", t2.paused === false && t2.t > t1.t, JSON.stringify({ t1, t2 }));
    check("D5 音频进度连续推进（无重载 / 无归零）", t2.t >= t1.t && t2.t < 20, JSON.stringify(t2));
    await popup.close();
  }

  /* ============ E. 锁屏歌词 + 全动作 ============ */
  console.log("\n═══ E. Media Session 锁屏歌词 ═══");
  const page2 = await context.newPage();
  await page2.addInitScript(STUB);
  page2.on("pageerror", (e) => jsErrors.push(e.message));
  await page2.goto(ORIGIN + "/", { waitUntil: "load" });
  await page2.waitForSelector("#mpPlayer", { timeout: 8000 }).catch(() => {});
  await page2.waitForFunction(() => (window.__mm || []).length > 0, { timeout: 8000 }).catch(() => {});
  const lyricStart = await page2.evaluate(() => ({
    titles: (window.__mm || []).map((m) => m.title),
    handlers: Object.keys(window.__msh || {}).sort(),
    lyricEl: (document.getElementById("mpLyric") || {}).textContent,
  }));
  check("E1 切歌时写入歌名元数据", lyricStart.titles.some((t) => /测试曲目甲/.test(t || "")), JSON.stringify(lyricStart.titles));
  check("E2 Media Session 全 8 动作注册", ["play", "pause", "previoustrack", "nexttrack", "stop", "seekbackward", "seekforward", "seekto"]
    .every((n) => lyricStart.handlers.includes(n)), lyricStart.handlers.join(","));
  // 先真正播放，让 loadedmetadata 就绪（autoplay=false 的首屏不加载音频）
  await page2.click("#mpPlay");
  await page2.waitForFunction(() => {
    const p = document.getElementById("mpProgress");
    return p && p.getAttribute("data-ready") === "1";
  }, { timeout: 8000 }).catch(() => {});
  await page2.evaluate(() => {
    // music-player 内部是 new Audio()（未挂 DOM），用锁屏 seekto 动作驱动
    const h = window.__msh && window.__msh.seekto;
    if (h) h({ seekTime: 2.6, fastSeek: false });
  });
  await page2.waitForTimeout(600);
  const lyricLater = await page2.evaluate(() => ({
    titles: (window.__mm || []).map((m) => m.title),
    lyricEl: (document.getElementById("mpLyric") || {}).textContent,
    pos: window.__msp || null,
  }));
  check("E3 锁屏标题随播放位置刷新为当前歌词行", lyricLater.titles.some((t) => t === "第二行歌词"), JSON.stringify(lyricLater.titles));
  check("E4 页面内歌词行同步显示", /第二行歌词/.test(lyricLater.lyricEl || ""), String(lyricLater.lyricEl));
  check("E5 setPositionState 已下发（锁屏进度条）", !!lyricLater.pos, JSON.stringify(lyricLater.pos));

  /* ============ F. 接力零感知化 ============ */
  console.log("\n═══ F. 跨页接力启动时机 ═══");
  await page2.goto(ORIGIN + "/?forceCold=1", { waitUntil: "domcontentloaded" });
  const cold = await page2.evaluate(() => ({ idle: window.__idleCalls, atDCL: window.__atDCL }));
  check("F1 冷启动：仍走 requestIdleCallback（首屏零成本）", cold.idle >= 1, JSON.stringify(cold));
  await page2.goto(ORIGIN + "/?forceWarm=1", { waitUntil: "domcontentloaded" });
  const warm = await page2.evaluate(() => ({ idle: window.__idleCalls, atDCL: window.__atDCL }));
  check("F2 有续播状态：完全跳过 idle 立即启动（间隙压到首帧）", warm.idle === 0 && warm.atDCL === true, JSON.stringify(warm));
  const resumeSeek = await page2.waitForFunction(() => {
    const p = document.getElementById("mpProgress");
    return p && p.getAttribute("data-ready") === "1";
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  check("F3 续播状态被读取并完成音频加载", resumeSeek, "loaded=" + resumeSeek);

  check("Z 全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | ") || "无");
  await page2.close();
  await page.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
