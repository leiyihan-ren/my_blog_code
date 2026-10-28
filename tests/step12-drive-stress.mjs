// ============================================================
// v7.2 步骤 12：云盘反脆弱魔鬼压测（Playwright）
//   场景（mock GitHub 内存存储 + 文件选择器 spam + 崩溃恢复）：
//   P1 连点上传 100 次：100 个小文件经真实 filechooser 入队 → 全部完成
//      → 列表 100 行 → 零 JS 错误 → 全程主线程响应
//   P2 50MB+ 超大文件：50MB 十片上传 → 进度条 → 完成 → 重组下载 50MB Blob → 删除
//   P3 传一半强关浏览器：12MB 传 1 片后强关 → 重开恢复「等待文件」态
//      → 重选同名文件 → 断点续传完成 → 分片无重复
//   P4 并发上限压测：6 个 11MB 同时入队 → 峰值并发 ≤3 → 全部完成
// 运行：node tests/step12-drive-stress.mjs
// ============================================================
import worker, { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

/* ---------- Mock GitHub（内存 store：parts/manifest/普通文件） ---------- */
const store = new Map();
const ghLog = { partPuts: [], manifestPuts: [], contentPuts: [], deletes: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inFlight = 0, maxInFlight = 0;

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
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(300); // 分片网络窗口（并发可观测）
      inFlight -= 1;
      ghLog.partPuts.push({ path: p, index: idx });
      store.set(p, { sha: "psha-" + store.size, content: body.content, size: Math.floor((body.content.length * 3) / 4) });
      return j({ content: { sha: "psha" }, commit: { sha: "c" } }, 201);
    }
    if (p.includes("/.m-")) {
      ghLog.manifestPuts.push({ path: p, content: body.content });
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(200); // 直传网络窗口
    inFlight -= 1;
    ghLog.contentPuts.push({ path: p });
    store.set(p, { sha: "csha-" + store.size, content: body.content, size: body.content.length });
    return j({ content: { sha: "csha" }, commit: { sha: "c" } }, 201);
  }
  if (meta && method === "DELETE") {
    const p = decodeURIComponent(meta[1]);
    store.delete(p);
    ghLog.deletes.push(p);
    return j({ commit: { sha: "d" } });
  }
  if (u.includes("/commits?path=")) {
    return j([{ commit: { committer: { date: "2026-10-24T10:00:00Z" } } }]);
  }
  const rawM = u.match(/raw\.githubusercontent\.com\/leiyihan-ren\/Blog\/main\/(drive\/.+)$/);
  if (rawM && method === "GET") {
    const p = decodeURIComponent(rawM[1]);
    const v = store.get(p);
    if (!v) return new Response("Not Found", { status: 404 });
    return new Response(Buffer.from(v.content, "base64"), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  return j({ message: "unexpected: " + u }, 500);
};

/* ---------- Mock Cache / KV（同 step7/9/11） ---------- */
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
const SITE_SEED = JSON.stringify({ title: "云盘压测站", githubRepo: "leiyihan-ren/Blog", githubBranch: "main", useCdn: false });
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

const API_PORT = 8615;
const WEB_PORT = 8900;
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
      const file = path.join(ROOT, staticFilePath(p));
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
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
  };
  const doneSel = (name) => `.up-item[data-name="${name}"].done`;
  const alloc = (mb, fill) => Buffer.alloc(mb * 1024 * 1024, fill);
  const pageErrors = [];

  async function openDrive() {
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.addInitScript(() => {
      window.__blobSizes = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = function (b) {
        try { window.__blobSizes.push(b.size); } catch (e) { /* ignore */ }
        return orig.call(URL, b);
      };
    });
    await page.goto(`http://127.0.0.1:${WEB_PORT}/drive.html`);
    // 兼容两种启动态：新标签页可能继承 sessionStorage（Chromium 真实行为）→ 无模态直达列表；
    // 全新会话 → 弹 PIN 模态。等任一态出现再分流。
    await page.waitForFunction(
      () => document.getElementById("pinModal").classList.contains("show") ||
        (document.getElementById("loadingState").hidden &&
          (!document.getElementById("emptyState").hidden || !document.getElementById("fileTable").hidden)),
      null,
      { timeout: 8000 }
    );
    if (await page.$("#pinModal.show")) {
      await page.fill("#pinInput", DRIVE_PIN);
      await page.click("#btnPinOk");
      await page.waitForFunction(
        () => document.getElementById("loadingState").hidden &&
          (!document.getElementById("emptyState").hidden || !document.getElementById("fileTable").hidden),
        null,
        { timeout: 8000 }
      );
    }
    return page;
  }

  let page = await openDrive();

  try {
    console.log("== P 组：v7.2 反脆弱魔鬼压测 ==");

    /* ---------- P1 连点上传 100 次 ---------- */
    console.log("-- P1 连点上传 100 次 --");
    let chooserCount = 0;
    page.on("filechooser", async (chooser) => {
      chooserCount += 1;
      await chooser.setFiles({
        name: `spam-${String(chooserCount).padStart(3, "0")}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from("spam payload " + chooserCount),
      });
    });
    const spamT0 = Date.now();
    for (let i = 0; i < 100; i++) {
      await page.click("#btnUpload");
    }
    // 100 个任务全部入队
    await page.waitForFunction(() => document.querySelectorAll(".up-item").length === 100, null, { timeout: 30000 });
    check("P1a 连点 100 次全部入队（无丢失无卡死）", true);
    // 入队后主线程立即可响应（UI 不冻结）
    const t1 = Date.now();
    const itemCount = await page.evaluate(() => document.querySelectorAll(".up-item").length);
    check("P1b 100 任务在队时主线程响应正常", itemCount === 100 && Date.now() - t1 < 2000, `耗时=${Date.now() - t1}ms`);
    // 全部完成
    await page.waitForFunction(
      () => document.querySelectorAll(".up-item.done").length === 100,
      null,
      { timeout: 180000 }
    );
    check("P1c 100 个文件全部上传完成", true, `总耗时=${((Date.now() - spamT0) / 1000).toFixed(1)}s`);
    const summary = await page.evaluate(() => document.getElementById("upSummary").textContent);
    check("P1d 队列摘要正确（共 100 · 完成 100）", /共 100 个 · 完成 100/.test(summary || ""), summary);
    // 列表出现文件（产品设计：顶层列表上限 50 个——N+1 commits 时间查询的配额保护，
    // _worker.js handleDrive list 分支 topFiles.slice(0, 50)；上传侧 100 个已全部成功）
    await page.waitForFunction(() => document.querySelectorAll("#fileTbody tr").length === 50, null, { timeout: 30000 });
    check("P1e 文件列表展示 50 行（产品上限生效，上传侧 100 个全部成功）", true);
    const hasSpam1 = await page.evaluate(() =>
      [...document.querySelectorAll("#fileTbody tr")].some((tr) => (tr.textContent || "").includes("spam-001.txt"))
    );
    check("P1f 连点产生的文件确实在列（spam-001.txt 可见）", hasSpam1);
    check("P1g 全程零 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

    /* ---------- P2 50MB+ 超大文件 ---------- */
    console.log("-- P2 50MB 超大文件 --");
    ghLog.partPuts.length = 0;
    // Playwright 限制：setInputFiles 单 buffer ≤50MB → 50MB 整文件写临时文件传路径
    const bigDir = "/tmp/step12-big";
    fs.mkdirSync(bigDir, { recursive: true });
    const big50Path = path.join(bigDir, "movie-50mb.bin");
    fs.writeFileSync(big50Path, alloc(50, 0x5a));
    await page.setInputFiles("#fileInput", big50Path);
    // 上传中进度条真实推进
    await page.waitForFunction(
      () => {
        const it = document.querySelector('.up-item[data-name="movie-50mb.bin"]');
        if (!it) return false;
        const fill = it.querySelector(".up-bar i");
        return !!fill && parseFloat(fill.style.width) > 0;
      },
      null,
      { timeout: 60000 }
    );
    check("P2a 50MB 上传中进度条实时推进", true);
    await page.waitForSelector(doneSel("movie-50mb.bin"), { timeout: 180000 });
    check("P2b 50MB（10 片）上传完成", true);
    check(
      "P2c 10 个分片按序落库",
      ghLog.partPuts.length === 10 && ghLog.partPuts.every((p, i) => p.index === i),
      JSON.stringify(ghLog.partPuts.map((p) => p.index))
    );
    // 重组下载 50MB Blob
    await page.evaluate(() => { window.__blobSizes = []; });
    const blob50 = await page.evaluate(async () => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      const row = rows.find((tr) => (tr.textContent || "").includes("movie-50mb.bin"));
      row.querySelector(".dl").click();
      for (let i = 0; i < 300; i++) {
        if (window.__blobSizes && window.__blobSizes.length) return window.__blobSizes[0];
        await new Promise((r) => setTimeout(r, 100));
      }
      return 0;
    });
    check("P2d 重组下载生成 50MB Blob（字节精确）", blob50 === 50 * 1024 * 1024, `blobSize=${blob50}`);
    // 删除 50MB 文件（10 片 + manifest 一并清理）
    ghLog.deletes.length = 0;
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      const row = rows.find((tr) => (tr.textContent || "").includes("movie-50mb.bin"));
      row.querySelector(".del").click();
    });
    await page.waitForSelector("#confirmModal.show", { timeout: 8000 });
    await page.click("#btnConfirmDel");
    await page.waitForFunction(
      () => ![...document.querySelectorAll("#fileTbody tr")].some((tr) => (tr.textContent || "").includes("movie-50mb.bin")),
      null,
      { timeout: 15000 }
    );
    check("P2e 50MB 文件（含 10 分片）删除成功", true, `deletes=${ghLog.deletes.length}`);

    /* ---------- P3 传一半强关浏览器 → 重开断点续传 ---------- */
    console.log("-- P3 强关浏览器断点续传 --");
    ghLog.partPuts.length = 0;
    await page.setInputFiles("#fileInput", {
      name: "crash-12mb.bin",
      mimeType: "application/octet-stream",
      buffer: alloc(12, 0x77),
    });
    // 等第 1 片落库后立刻强关（模拟崩溃/误关）
    for (let i = 0; i < 100 && ghLog.partPuts.length < 1; i++) await sleep(100);
    check("P3a 强关前第 1 片已落库", ghLog.partPuts.length >= 1, `partPuts=${ghLog.partPuts.length}`);
    await page.evaluate(() => UploadService.flushPersist()); // 模拟 pagehide 的同步落盘
    await page.close(); // 强关：不跑 beforeunload，任务进程直接蒸发
    await sleep(200);

    const page2 = await openDrive(); // 重开：新标签页，sessionStorage 为空需重新验 PIN
    // 恢复：未完成任务以「等待文件」态回到队列
    await page2.waitForSelector('.up-item[data-name="crash-12mb.bin"].paused', { timeout: 10000 });
    const crashText = await page2.evaluate(() => {
      const it = document.querySelector('.up-item[data-name="crash-12mb.bin"]');
      return it ? it.textContent : null;
    });
    check("P3b 重开后未完成任务恢复（等待文件态）", /重新选择/.test(crashText || ""), crashText);
    check("P3c 恢复态无恢复按钮（防无 File 句柄启动）", await page2.evaluate(() => {
      const it = document.querySelector('.up-item[data-name="crash-12mb.bin"]');
      return it && !it.querySelector(".up-retry");
    }));
    // 重新选择同名同尺寸文件 → 自动装配 → 断点续传
    await page2.setInputFiles("#fileInput", {
      name: "crash-12mb.bin",
      mimeType: "application/octet-stream",
      buffer: alloc(12, 0x77),
    });
    await page2.waitForSelector(doneSel("crash-12mb.bin"), { timeout: 90000 });
    check("P3d 重选同名文件后断点续传完成", true);
    const crashIdx = ghLog.partPuts.map((p) => p.index).sort((a, b) => a - b);
    check(
      "P3e 分片无重复（强关前 1 片 + 重开后补齐，共 3 片各一次）",
      crashIdx.length === 3 && new Set(crashIdx).size === 3,
      `indices=${JSON.stringify(crashIdx)}`
    );
    // 崩溃恢复数据在任务完成后自动清除
    await sleep(600);
    check("P3f 完成后崩溃恢复数据自动清除", await page2.evaluate(() => {
      try { return !localStorage.getItem("drive_upload_resume"); } catch (e) { return true; }
    }));
    await page2.close();

    /* ---------- P4 并发上限压测：6 个 11MB 同时入队 ---------- */
    console.log("-- P4 并发上限压测 --");
    page = await openDrive();
    maxInFlight = 0;
    // 6×11MB=66MB 超 Playwright 单次 50MB buffer 上限 → 写临时文件传路径（保持单次批量入队语义）
    const manyPaths = [];
    for (let i = 0; i < 6; i++) {
      const fp = path.join(bigDir, `many-${i}.bin`);
      fs.writeFileSync(fp, alloc(11, 0x40 + i));
      manyPaths.push(fp);
    }
    await page.setInputFiles("#fileInput", manyPaths);
    await page.waitForFunction(
      () => ["many-0.bin", "many-1.bin", "many-2.bin", "many-3.bin", "many-4.bin", "many-5.bin"]
        .every((n) => document.querySelector(`.up-item[data-name="${n}"].done`)),
      null,
      { timeout: 180000 }
    );
    check("P4a 6 个 11MB 排队任务全部完成", true);
    check("P4b 峰值并发 ≤3（队列限流在重压下不破防）", maxInFlight <= 3, `峰值=${maxInFlight}`);
    check("P4c 全程零 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

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
