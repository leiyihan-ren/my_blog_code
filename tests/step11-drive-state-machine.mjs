// ============================================================
// v7.1 步骤 11：云盘状态机端到端测试（Playwright）
//   场景（mock GitHub 内存存储 + 网络离线注入 + 并发统计）：
//   S1 暂停/恢复：分片上传中点暂停 → abort 在途 XHR（无新分片落库）
//      → 恢复 → 断点续传完成，分片 index 无重复
//   S2a 弱网自愈：offline 注入 → 单片指数退避重试 → online 恢复 → 自愈完成
//   S2b 断网耗尽重连：持续 offline → 重试耗尽进 failed（断点保留）
//      → online 事件 → 自动续跑 → 完成（无需手动干预）
//   S3 beforeunload：上传中离开页面被拦截（defaultPrevented）；全部暂停后不拦
//   S4 并发 3：3 个 11MB 同时上传 → mock 侧峰值并发 =3 且 UI 响应不卡死
//   S5 取消：上传中取消 → 任务出队 + 在途 abort → 其余任务不受影响
//   S6 安全关闭：全部暂停后 isBusy=false，runBeforeUnload 关闭不卡死
// 运行：node tests/step11-drive-state-machine.mjs
// ============================================================
import worker, { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

/* ---------- Mock GitHub（内存 store：parts/manifest/普通文件） ---------- */
const store = new Map(); // path → {sha, content(b64), size}
const ghLog = { partPuts: [], manifestPuts: [], contentPuts: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inFlight = 0, maxInFlight = 0;
/** v8.2：S5「传输中取消」段专用——拉长单片传输窗口，保证取消落在途 */
let slowMode = false;

function listUnder(prefix) {
  const items = [];
  const seenDirs = new Set();
  for (const [p, v] of store) {
    if (!p.startsWith(prefix + "/")) continue;
    const rest = p.slice(prefix.length + 1);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const d = rest.slice(0, slash);
      if (!seenDirs.has(d)) { seenDirs.add(d); items.push({ type: "dir", name: d, path: `${prefix}/${d}` }); }
    } else {
      items.push({ type: "file", name: rest, path: p, size: v.size, sha: v.sha });
    }
  }
  return items;
}
function topLevel() {
  const items = [];
  const seenDirs = new Set();
  for (const [p, v] of store) {
    if (!p.startsWith("drive/")) continue;
    const rest = p.slice(6);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const d = rest.slice(0, slash);
      if (!seenDirs.has(d)) { seenDirs.add(d); items.push({ type: "dir", name: d, path: "drive/" + d }); }
    } else {
      items.push({ type: "file", name: rest, path: p, size: v.size, sha: v.sha });
    }
  }
  return items;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input.url;
  const method = (init && init.method) || "GET";
  const rl = { "X-RateLimit-Remaining": "5000" };
  const j = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...rl } });
  const REPO = "leiyihan-ren/Blog";

  if (u === `https://api.github.com/repos/${REPO}/contents/drive?ref=main` && method === "GET") {
    return j(topLevel());
  }
  const meta = u.match(new RegExp(`/contents/(drive/[^?]+)\\?ref=`));
  if (meta && method === "GET") {
    const p = decodeURIComponent(meta[1]);
    if (store.has(p)) {
      const v = store.get(p);
      return j({ type: "file", name: p.split("/").pop(), path: p, size: v.size, sha: v.sha, content: v.content });
    }
    const children = listUnder(p);
    if (children.length) return j(children);
    return j({ message: "Not Found" }, 404);
  }
  if (meta && method === "PUT") {
    const p = decodeURIComponent(meta[1]);
    const body = JSON.parse(init.body);
    const partM = p.match(/part-(\d+)$/);
    if (partM) {
      const idx = Number(partM[1]);
      // 并发统计：300ms 网络窗口（比 step9 的 120ms 宽，供暂停/取消/离线观测）
      // v8.2：分片 5MB→8MB 后片数减少、单轮即可传完，S5「传输中点取消」的
      //   观察窗口被压缩到小于「等 hint → 点取消」的往返延迟，导致取消时上传
      //   其实已结束（表现为 S5d 假阳性）。S5 段单独开启慢速模式拉宽窗口，
      //   确保取消真的落在传输途中——这是测试时序修复，不掩盖任何产品缺陷。
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(slowMode ? 1200 : 300);
      inFlight -= 1;
      ghLog.partPuts.push({ path: p, index: idx });
      store.set(p, { sha: "psha-" + store.size, content: body.content, size: Math.floor((body.content.length * 3) / 4) });
      return j({ content: { sha: "psha" }, commit: { sha: "c" } }, 201);
    }
    if (p.includes("/.m-")) {
      ghLog.manifestPuts.push({ path: p, content: body.content, at: Date.now(), parts: ghLog.partPuts.length });
    }
    // 小文件直传：200ms 窗口（供直传路径的暂停观测）
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(200);
    inFlight -= 1;
    ghLog.contentPuts.push({ path: p });
    store.set(p, { sha: "csha-" + store.size, content: body.content, size: body.content.length });
    return j({ content: { sha: "csha" }, commit: { sha: "c" } }, 201);
  }
  if (meta && method === "DELETE") {
    const p = decodeURIComponent(meta[1]);
    store.delete(p);
    return j({ commit: { sha: "d" } });
  }
  if (u.includes("/commits?path=")) {
    return j([{ commit: { committer: { date: "2026-10-24T10:00:00Z" } } }]);
  }
  // raw 拉取（大文件重组下载）
  const rawM = u.match(/raw\.githubusercontent\.com\/leiyihan-ren\/Blog\/main\/(drive\/.+)$/);
  if (rawM && method === "GET") {
    const p = decodeURIComponent(rawM[1]);
    const v = store.get(p);
    if (!v) return new Response("Not Found", { status: 404 });
    return new Response(Buffer.from(v.content, "base64"), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  return j({ message: "unexpected: " + u }, 500);
};

/* ---------- Mock Cache / KV（同 step7/9） ---------- */
function makeCaches() {
  const s = new Map();
  const obj = {
    async match(r) { const e = s.get(typeof r === "string" ? r : r.url); return e ? new Response(e.body, { status: e.status, headers: new Headers(e.headers) }) : undefined; },
    async put(r, resp) { s.set(typeof r === "string" ? r : r.url, { body: await resp.arrayBuffer(), headers: [...resp.headers], status: resp.status }); },
    async delete(r) { return s.delete(typeof r === "string" ? r : r.url); },
    async keys() { return [...s.keys()].map((u) => new Request(u)); },
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
const SITE_SEED = JSON.stringify({ title: "云盘状态机测试站", githubRepo: "leiyihan-ren/Blog", githubBranch: "main", useCdn: false });
const DRIVE_PIN = "1234";

function startApi(port) {
  const deferred = [];
  const server = http.createServer(async (req, res) => {
    try {
      const bodyBuf = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request("http://api.local" + req.url, {
        method: req.method,
        headers: { "user-agent": "drive-test", "x-drive-pin": req.headers["x-drive-pin"] || "" },
        body: bodyBuf,
      });
      const ctx = { waitUntil: (p) => deferred.push(Promise.resolve(p).catch(() => {})) };
      const response = await worker.fetch(request, { SITE_DATA: makeKV({ site: SITE_SEED }), GITHUB_TOKEN: "ghp_drive", DRIVE_PIN }, ctx);
      const buf = Buffer.from(await response.arrayBuffer());
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, drain: async () => { await Promise.all(deferred.splice(0)); } })));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const API_PORT = 8614;
const WEB_PORT = 8899;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

async function main() {
  const api = await startApi(API_PORT);
  const staticServer = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url, "http://x");
      const p = decodeURIComponent(parsed.pathname);
      if (p.startsWith("/api/")) {
        const resp = await realFetch(API_ORIGIN + parsed.pathname + parsed.search, {
          method: req.method,
          headers: { "user-agent": "drive-test", "x-drive-pin": req.headers["x-drive-pin"] || "", "content-type": req.headers["content-type"] || "" },
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req),
        });
        const body = Buffer.from(await resp.arrayBuffer());
        const headers = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(resp.status, headers);
        return res.end(body);
      }
      const file = path.join(ROOT, staticFilePath(p)); // v7.0：经 route-map 映射到 pages/ 等物理路径
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("nf"); }
      const ext = path.extname(file).toLowerCase();
      const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((r) => staticServer.listen(WEB_PORT, "127.0.0.1", r));

  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const context = await browser.newContext();
  const page = await context.newPage();
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
  };
  const doneSel = (name) => `.up-item[data-name="${name}"].done`;
  const itemText = (n) => page.evaluate((name) => {
    const it = document.querySelector(`.up-item[data-name="${name}"]`);
    return it ? it.textContent : null;
  }, n);
  const alloc = (mb, fill) => Buffer.alloc(mb * 1024 * 1024, fill);

  /* v8.2：分片大小是「可调策略常量」（5MB→8MB），片数 = ⌈size/CHUNK⌉。
     断言里的片数必须从引擎实时读取，不能写死——否则每次调参都会假阳性。
     同时：hint 是瞬时状态（每片完成即清空），采样式断言会漏采，
     故配套 observeHint() 用 MutationObserver 做事件驱动捕获。 */
  /**
   * 在上传开始前挂载观察器，全程记录目标任务行的文本快照。
   * @param {string} name 文件名（用于定位 .up-item[data-name]）
   */
  const observeHint = (name) => page.evaluate((n) => {
    window.__hintLog = [];
    if (window.__hintObserver) { try { window.__hintObserver.disconnect(); } catch (e) { /* ignore */ } }
    const grab = () => {
      const it = document.querySelector(`.up-item[data-name="${n}"]`);
      if (!it) return;
      const t = it.textContent || "";
      if (window.__hintLog[window.__hintLog.length - 1] !== t) window.__hintLog.push(t);
    };
    window.__hintObserver = new MutationObserver(grab);
    window.__hintObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    grab();
  }, name);
  /** 读取并断开观察器：返回是否命中过「第 x/total 片」 */
  const hintSeen = (total) => page.evaluate((n) => {
    const log = window.__hintLog || [];
    const re = new RegExp("第 \\d/" + n + " 片");
    const hit = log.filter((t) => re.test(t));
    if (window.__hintObserver) { try { window.__hintObserver.disconnect(); } catch (e) { /* ignore */ } }
    return { total: log.length, hit: hit.length, sample: (hit[0] || log[log.length - 1] || "").slice(-60) };
  }, total);

  try {
    console.log("== S 组：v7.1 状态机（暂停/恢复/断网重连/并发3/取消） ==");

    await page.goto(`http://127.0.0.1:${WEB_PORT}/drive.html`);
    await page.waitForSelector("#pinModal.show", { timeout: 5000 });
    await page.fill("#pinInput", DRIVE_PIN);
    await page.click("#btnPinOk");
    // 列表 settled：加载态结束且（空态 或 文件表）之一可见（本套件 mock store 初始为空）
    await page.waitForFunction(
      () => document.getElementById("loadingState").hidden &&
        (!document.getElementById("emptyState").hidden || !document.getElementById("fileTable").hidden),
      null,
      { timeout: 8000 }
    );

    /* 分片片数一律实时推算：⌈文件大小 / 引擎 CHUNK_SIZE⌉ */
    const CHUNK = await page.evaluate(() =>
      window.UploadService && UploadService.constants ? UploadService.constants().CHUNK_SIZE : 8 * 1024 * 1024
    );
    const partsOf = (mb) => Math.ceil((mb * 1024 * 1024) / CHUNK);
    const seq = (n) => Array.from({ length: n }, (_, i) => i);

    /* ---------- S4 并发 3：3 个 11MB 同时跑，峰值并发=3 ---------- */
    console.log("-- S4 并发 3 --");
    maxInFlight = 0;
    const conc = [];
    for (let i = 0; i < 3; i++) {
      conc.push({ name: `sm-conc-${i}.bin`, mimeType: "application/octet-stream", buffer: alloc(11, 0x60 + i) });
    }
    await page.setInputFiles("#fileInput", conc);
    await page.waitForFunction(
      () => ["sm-conc-0.bin", "sm-conc-1.bin", "sm-conc-2.bin"].every((n) => document.querySelector(`.up-item[data-name="${n}"].done`)),
      null,
      { timeout: 120000 }
    );
    check("S4a 3 个 11MB 并发全部完成", true);
    check("S4b 峰值并发 =3（MAX_CONCURRENT 3 生效）", maxInFlight === 3, `峰值=${maxInFlight}`);
    // 3 并发下 UI 主线程响应：evaluate 应快速返回（无卡死）
    const t0 = Date.now();
    const responsive = await page.evaluate(() => document.querySelectorAll(".up-item").length);
    const dt = Date.now() - t0;
    check("S4c 并发中 UI 主线程响应正常", responsive > 0 && dt < 2000, `items=${responsive} 耗时=${dt}ms`);

    /* ---------- S1 暂停/恢复（分片路径） ---------- */
    console.log("-- S1 暂停/恢复 --");
    ghLog.partPuts.length = 0;
    const nPause = partsOf(12);
    await observeHint("sm-pause-12mb.bin"); // 上传前挂载，避免瞬时 hint 漏采
    await page.setInputFiles("#fileInput", { name: "sm-pause-12mb.bin", mimeType: "application/octet-stream", buffer: alloc(12, 0x70) });
    // 等第 1 片开始传输（hint 显示「第 x/N 片」，N 由引擎分片大小推算）
    const s1 = await page
      .waitForFunction(
        (n) => {
          const it = document.querySelector('.up-item[data-name="sm-pause-12mb.bin"]');
          return it && new RegExp("第 \\d/" + n + " 片").test(it.textContent);
        },
        nPause,
        { timeout: 30000 }
      )
      .then(() => ({ hit: 1 }))
      .catch(() => hintSeen(nPause));
    check(`S1a 分片上传启动（第 x/${nPause} 片）`, s1.hit > 0, JSON.stringify(s1));
    await page.click('.up-item[data-name="sm-pause-12mb.bin"] .up-pause');
    await page.waitForSelector('.up-item[data-name="sm-pause-12mb.bin"].paused', { timeout: 10000 });
    check("S1b 点击暂停 → UI 进入 paused 态", true);
    // abort 生效验证：在途 PUT 服务端可能已收完（HTTP 语义，落库 ≤+1 属正常，
    // 恢复时断点查询会跳过）；等 500ms 让其落定后，后续必须零增长
    await sleep(500);
    const putsAfterSettle = ghLog.partPuts.length;
    await sleep(1500);
    check(
      "S1c 暂停落定后无新分片落库（在途 XHR 被 abort）",
      ghLog.partPuts.length === putsAfterSettle,
      `落定=${putsAfterSettle} 1.5s后=${ghLog.partPuts.length}`
    );
    // 恢复（paused 态按钮为 .up-retry「▶️ 恢复」）
    await page.click('.up-item[data-name="sm-pause-12mb.bin"] .up-retry');
    await page.waitForSelector(doneSel("sm-pause-12mb.bin"), { timeout: 90000 });
    check("S1d 恢复后断点续传完成", true);
    // v8.2：并发上传下分片落库顺序不保证，断言改为「序号齐全且各一次」
    const pauseIdx = ghLog.partPuts.map((p) => p.index).sort((a, b) => a - b);
    const pauseExp = seq(partsOf(12));
    check(
      `S1e 分片无重复上传（断点跳过已传片，${pauseExp.length} 片各一次）`,
      JSON.stringify(pauseIdx) === JSON.stringify(pauseExp),
      `indices=${JSON.stringify(pauseIdx)}`
    );

    /* ---------- S2a 传输中掉线：指数退避 → online 自愈 ---------- */
    console.log("-- S2a 传输中掉线自愈 --");
    ghLog.partPuts.length = 0;
    const nFlaky = partsOf(9);
    await observeHint("sm-flaky-9mb.bin");
    await page.setInputFiles("#fileInput", { name: "sm-flaky-9mb.bin", mimeType: "application/octet-stream", buffer: alloc(9, 0x80) });
    // 先让断点查询通过、第 1 片进入传输，再掐网——模拟「传到一半断网」
    await page
      .waitForFunction(
        (n) => {
          const it = document.querySelector('.up-item[data-name="sm-flaky-9mb.bin"]');
          return it && new RegExp("第 \\d/" + n + " 片").test(it.textContent);
        },
        nFlaky,
        { timeout: 30000 }
      )
      .catch(async () => {
        const r = await hintSeen(nFlaky);
        if (!r.hit) throw new Error("未观测到分片进度提示 " + JSON.stringify(r));
      });
    await context.setOffline(true); // 传输中途断网：在途 XHR onerror → 单片退避重试
    await page.waitForFunction(
      () => {
        const it = document.querySelector('.up-item[data-name="sm-flaky-9mb.bin"]');
        return it && /片失败，\d+s 后第 \d+ 次重试/.test(it.textContent);
      },
      null,
      { timeout: 20000 }
    );
    check("S2a-1 传输中掉网触发指数退避重试（非立即失败）", true);
    await sleep(600);
    await context.setOffline(false); // 恢复网络：退避中的重试随即成功
    await page.waitForSelector(doneSel("sm-flaky-9mb.bin"), { timeout: 60000 });
    check("S2a-2 网络恢复后退避重试自愈完成（无需手动干预）", true);
    check(
      "S2a-3 9MB 两片全部落库",
      ghLog.partPuts.filter((p) => p.index <= 1).length >= 2,
      `partPuts=${JSON.stringify(ghLog.partPuts.map((p) => p.index))}`
    );

    /* ---------- S2b 入队即断网 → status 查询退避 → 耗尽 failed → online 自动重连 ---------- */
    console.log("-- S2b 入队即断网+自动重连 --");
    ghLog.partPuts.length = 0;
    await context.setOffline(true);
    await page.setInputFiles("#fileInput", { name: "sm-dead-12mb.bin", mimeType: "application/octet-stream", buffer: alloc(12, 0x90) });
    // 入队即断网：断点 status 查询（GET 幂等）先走指数退避 1s/2s/4s
    await page.waitForFunction(
      () => {
        const it = document.querySelector('.up-item[data-name="sm-dead-12mb.bin"]');
        return it && /检查断点失败，\d+s 后第 \d+ 次重试/.test(it.textContent);
      },
      null,
      { timeout: 20000 }
    );
    check("S2b-1 断网下断点查询走指数退避（非立即失败）", true);
    // 持续断网：查询重试耗尽（≈7s）→ 进入 failed（断点保留不丢任务）
    await page.waitForSelector('.up-item[data-name="sm-dead-12mb.bin"].failed', { timeout: 90000 });
    check("S2b-2 重试耗尽后进入 failed（断点保留不丢任务）", true);
    const failedText = await itemText("sm-dead-12mb.bin");
    check("S2b-3 failed 态提示可继续上传（断点信息）", /可继续上传/.test(failedText || ""), failedText);
    await context.setOffline(false); // online 事件 → uploadService 自动 resume
    await page.waitForSelector(doneSel("sm-dead-12mb.bin"), { timeout: 90000 });
    check("S2b-4 online 事件自动续跑完成（无需手动重试）", true);
    // v8.2：分片序号“齐全”为准（并发上传不保证落库先后），片数按引擎分片大小推算
    const deadIdx = ghLog.partPuts.map((p) => p.index).sort((a, b) => a - b);
    const deadExp = seq(partsOf(12));
    check(
      `S2b-5 断网期间未落库的分片在重连后补齐（${deadExp.join("/")} 齐全）`,
      JSON.stringify(deadIdx) === JSON.stringify(deadExp),
      `indices=${JSON.stringify(deadIdx)}`
    );

    /* ---------- S3 beforeunload 防误关 ---------- */
    console.log("-- S3 beforeunload --");
    const nBu = partsOf(12);
    await observeHint("sm-bu-12mb.bin");
    await page.setInputFiles("#fileInput", { name: "sm-bu-12mb.bin", mimeType: "application/octet-stream", buffer: alloc(12, 0xa0) });
    await page
      .waitForFunction(
        (n) => {
          const it = document.querySelector('.up-item[data-name="sm-bu-12mb.bin"]');
          return it && new RegExp("第 \\d/" + n + " 片").test(it.textContent);
        },
        nBu,
        { timeout: 30000 }
      )
      .catch(async () => {
        // 采样漏采兜底：改查 MutationObserver 全程记录
        const r = await hintSeen(nBu);
        if (!r.hit) throw new Error("未观测到分片进度提示 " + JSON.stringify(r));
      });
    const r1 = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return { prevented: e.defaultPrevented, busy: UploadService.isBusy() };
    });
    check("S3a 上传中 beforeunload 被拦截（defaultPrevented=true）", r1.prevented === true && r1.busy === true, JSON.stringify(r1));
    // 全部暂停 → 不再拦截
    await page.evaluate(() => UploadService.pauseAll());
    await page.waitForSelector('.up-item[data-name="sm-bu-12mb.bin"].paused', { timeout: 10000 });
    const r2 = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return { prevented: e.defaultPrevented, busy: UploadService.isBusy() };
    });
    check("S3b 全部暂停后 beforeunload 不拦截（可安全关闭）", r2.prevented === false && r2.busy === false, JSON.stringify(r2));
    // 恢复继续传完（顺便验证 pauseAll/resumeAll 成对）
    await page.evaluate(() => UploadService.resumeAll());
    await page.waitForSelector(doneSel("sm-bu-12mb.bin"), { timeout: 90000 });
    check("S3c 全部恢复后传完", true);

    /* ---------- S5 取消：出队 + abort + 不影响他人 ---------- */
    console.log("-- S5 取消 --");
    slowMode = true; // 拉宽单片窗口，确保“点取消”时分片仍在途
    ghLog.partPuts.length = 0;
    const cancels = [];
    for (let i = 0; i < 3; i++) {
      // cancel-1 刻意做大（21MB）：留出足够时间窗，保证点取消时它仍在
      // 第 1~2 片，不会撞上「最后一片刚传完、finish 请求已发出」这段前端
      // 侧也无法拦截的竞态（v8.1：uploadService 侧已加 throwIfPaused 闸门，
      // 但 HTTP 请求一旦发出，服务端写入不可撤销，只能从时序上避开）。
      // 上限约束：Playwright setInputFiles 单批合计不得超过 50MB（21+11+11）。
      const mb = i === 1 ? 21 : 11;
      cancels.push({ name: `sm-cancel-${i}.bin`, mimeType: "application/octet-stream", buffer: alloc(mb, 0xb0 + i) });
    }
    await page.setInputFiles("#fileInput", cancels);
    // 等 3 个都开始传（并发 3 全部占槽）
    await page.waitForFunction(
      () => ["sm-cancel-0.bin", "sm-cancel-1.bin", "sm-cancel-2.bin"].every((n) => {
        const it = document.querySelector(`.up-item[data-name="${n}"]`);
        return it && /第 \d+\/\d+ 片/.test(it.textContent);
      }),
      null,
      { timeout: 30000 }
    );
    // 取消前读取被取消任务的 uploadId（服务端分片路径 drive/.parts/<uploadId>/ 含它，可精确归属）
    const cancelUid = await page.evaluate(() => {
      const t = UploadService.tasks().find((x) => x.file.name === "sm-cancel-1.bin");
      return t ? t.uploadId : null;
    });
    // 队列面板随进度高频重渲染，原生 click 的 stability 等待会被反复 detach 打断
    // （v7.1 起已知 flaky）。改为向同一个按钮直接派发 click：走的仍是
    // 「真实 DOM 事件 → 页面 handler → UploadService.cancel」这条完整链路。
    // 诊断采样：点取消前该任务已落库片数 / 任务状态（判断是否“传完才取消”的时序问题）
    const putsBeforeCancel = ghLog.partPuts.filter((p) => cancelUid && p.path.includes(cancelUid)).length;
    const stateBeforeCancel = await page.evaluate(() => {
      const t = UploadService.tasks().find((x) => x.file.name === "sm-cancel-1.bin");
      return t ? { status: t.status, total: t.total, done: Object.keys(t.done || {}).length } : null;
    });
    const diagBefore = await page.evaluate(() => {
      const t = UploadService.tasks().find((x) => x.file.name === "sm-cancel-1.bin");
      if (!t) return { missing: true };
      return {
        status: t.status,
        hasAbort: typeof t._abort === "function",
        inFlight: (t._aborts || []).length,
        doneKeys: Object.keys(t.done || {}).length,
        total: t.total,
      };
    });
    const cancelAt = Date.now();
    await page.$eval('.up-item[data-name="sm-cancel-1.bin"] .up-cancel', (el) => el.click());
    const diagAfter = await page.evaluate((cat) => {
      const t = UploadService.tasks().find((x) => x.file.name === "sm-cancel-1.bin");
      return {
        stillInQueue: !!t,
        status: t ? t.status : null,
        finishTrace: (window.__finishTrace || []).map((f) => ({ n: f.name, s: f.status, fl: f.failed, dt: f.at - cat })),
      };
    }, cancelAt);
    await page.waitForFunction(
      () => !document.querySelector('.up-item[data-name="sm-cancel-1.bin"]'),
      null,
      { timeout: 10000 }
    );
    check("S5a 取消后任务立即出队", true);
    // 在途 PUT 服务端可能已收完（HTTP 语义，落库 ≤+1 属正常，resume 时断点查询会跳过）；
    // 等 500ms 让其落定后，该任务必须零增长
    await sleep(500);
    const putsOfCanceled = () => ghLog.partPuts.filter((p) => cancelUid && p.path.includes(cancelUid)).length;
    const cancelPutsAt = putsOfCanceled();
    await sleep(1200);
    check(
      "S5b 取消落定后该任务无新分片落库（在途 XHR 被 abort，其余任务照传）",
      putsOfCanceled() === cancelPutsAt,
      `落定=${cancelPutsAt} 1.2s后=${putsOfCanceled()}`
    );
    await page.waitForFunction(
      () => ["sm-cancel-0.bin", "sm-cancel-2.bin"].every((n) => document.querySelector(`.up-item[data-name="${n}"].done`)),
      null,
      { timeout: 120000 }
    );
    check("S5c 其余任务不受取消影响，全部完成", true);
    const finishTrace = await page.evaluate(() => window.__finishTrace || []);
    check(
      "S5d 取消的任务不会写 manifest（不会误入文件列表）",
      !ghLog.manifestPuts.some((m) => {
        try { return JSON.parse(Buffer.from(m.content, "base64").toString("utf-8")).name === "sm-cancel-1.bin"; } catch (e) { return false; }
      }),
      `manifests=${ghLog.manifestPuts.length} 取消前已落库=${putsBeforeCancel} 取消前状态=${JSON.stringify(stateBeforeCancel)} ` +
      `全部=${JSON.stringify(ghLog.manifestPuts.map((m) => {
        try { return JSON.parse(Buffer.from(m.content, "base64").toString("utf-8")).name; } catch (e) { return "?"; }
      }))} 取消时刻=${cancelAt} 明细=${JSON.stringify(ghLog.manifestPuts.map((m) => ({
        p: m.path, dt: m.at - cancelAt, parts: m.parts,
      })))} cancelUid=${cancelUid} 取消前诊断=${JSON.stringify(diagBefore)} 取消后诊断=${JSON.stringify(diagAfter)} finishTrace=${JSON.stringify(finishTrace)}`
    );

    /* ---------- S6 暂停态安全关闭（runBeforeUnload 不卡死） ---------- */
    console.log("-- S6 安全关闭 --");
    const nSafe = partsOf(12);
    await observeHint("sm-safe-12mb.bin");
    await page.setInputFiles("#fileInput", { name: "sm-safe-12mb.bin", mimeType: "application/octet-stream", buffer: alloc(12, 0xc0) });
    await page
      .waitForFunction(
        (n) => {
          const it = document.querySelector('.up-item[data-name="sm-safe-12mb.bin"]');
          return it && new RegExp("第 \\d/" + n + " 片").test(it.textContent);
        },
        nSafe,
        { timeout: 30000 }
      )
      .catch(async () => {
        const r = await hintSeen(nSafe);
        if (!r.hit) throw new Error("未观测到分片进度提示 " + JSON.stringify(r));
      });
    await page.evaluate(() => UploadService.pauseAll());
    const busy = await page.evaluate(() => UploadService.isBusy());
    check("S6a 全部暂停后 isBusy=false", busy === false);
    // runBeforeUnload：paused 态无拦截，close 应立即完成不卡死
    const closeT0 = Date.now();
    await page.close({ runBeforeUnload: true });
    check("S6b 暂停态 runBeforeUnload 关闭不卡死", Date.now() - closeT0 < 15000, `耗时=${Date.now() - closeT0}ms`);

    console.log(`通过 ${passed}/${passed + failed}`);
    await context.close();
    await browser.close();
    staticServer.close();
    api.server.close();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error("测试执行异常：", e);
    try { await browser.close(); } catch (e2) { /* ignore */ }
    process.exit(1);
  }
}

main();
