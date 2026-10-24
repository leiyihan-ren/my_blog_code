// ============================================================
// v6.0 步骤 9：云盘大文件分片端到端测试（Playwright）
//   场景（mock GitHub 内存存储 + 故障注入 + 并发统计）：
//   V1 12MB 文件 → 3 片分片上传 → finish → 列表出现 🧩 大文件条目
//   V2 弱网重试：第 1 片首次请求 500 → 前端自动重试成功
//   V3 断点续传：第 2 片连续失败耗尽重试 → 「继续上传」→ 只补失败片
//   V4 删除锁：同名大文件上传中 → 删除按钮禁用 → 完成后恢复；覆盖不产生重复条目
//   V5 并发控制：3 个 11MB 文件 → mock 侧峰值并发 ≤2
//   V6 大文件重组下载：Blob 总字节 = 文件大小
//   V7 小文件直传路径不受影响（回归）
//   V8 32MB 端到端：7 片上传+进度条 → 列表 → 重组下载 32MB Blob → 删除注入 409 自愈
// 运行：node tests/step9-drive-chunked-ui.mjs
// 注意：所有上传项按 data-name 定位（队列并发下避免任务间串扰）。
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

/* ---------- Mock GitHub（内存 store：parts/manifest/普通文件） ---------- */
const store = new Map(); // path → {sha, content(b64), size}
const ghLog = { partPuts: [], manifestPuts: [], partFails: 0, deletes: [], del409: [] };
const partFail = {}; // part index → 剩余注入失败次数
const delete409Once = new Set(); // path → 下次 DELETE 返回 409 一次（读副本滞后模拟）
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // 故障注入：该片剩余失败次数 >0 → 500（模拟网络波动）
      if (partFail[idx] > 0) {
        partFail[idx] -= 1;
        ghLog.partFails += 1;
        return j({ message: "injected network failure" }, 500);
      }
      // 并发统计：模拟网络耗时让并发窗口可观测
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(120);
      inFlight -= 1;
      ghLog.partPuts.push({ path: p, index: idx, sha: body.sha || null });
      store.set(p, { sha: "psha-" + store.size, content: body.content, size: Math.floor((body.content.length * 3) / 4) });
      return j({ content: { sha: "psha" }, commit: { sha: "c" } }, 201);
    }
    if (p.includes("/.m-")) {
      ghLog.manifestPuts.push({ path: p, content: body.content });
    }
    store.set(p, { sha: "msha-" + store.size, content: body.content, size: body.content.length });
    return j({ content: { sha: "msha" }, commit: { sha: "c" } }, 201);
  }
  if (meta && method === "DELETE") {
    const p = decodeURIComponent(meta[1]);
    // 409 注入：模拟 GitHub 读副本滞后（sha 过期），验证 worker 自愈重删
    if (delete409Once.has(p)) {
      delete409Once.delete(p);
      ghLog.del409.push(p);
      const v = store.get(p);
      if (v) v.sha = v.sha + "-rotated";
      return j({ message: "conflict" }, 409);
    }
    store.delete(p);
    ghLog.deletes.push(p);
    return j({ commit: { sha: "d" } });
  }
  if (u.includes("/commits?path=")) {
    return j([{ commit: { committer: { date: "2026-10-24T10:00:00Z" } } }]);
  }
  // raw 拉取（大文件重组下载：manifest 清单 + parts 分片，均为文件原始内容）
  const rawM = u.match(/raw\.githubusercontent\.com\/leiyihan-ren\/Blog\/main\/(drive\/.+)$/);
  if (rawM && method === "GET") {
    const p = decodeURIComponent(rawM[1]);
    const v = store.get(p);
    if (!v) return new Response("Not Found", { status: 404 });
    return new Response(Buffer.from(v.content, "base64"), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  return j({ message: "unexpected: " + u }, 500);
};

/* ---------- 预置：一个已存在的大文件（manifest，用于覆盖与锁测试） ---------- */
{
  const manifest = {
    uploadId: "bigexist",
    name: "big.bin",
    size: 12 * 1024 * 1024,
    total: 3,
    chunkBytes: 5 * 1024 * 1024,
    createdAt: "2026-10-24T09:00:00Z",
  };
  store.set("drive/.m-bigexist.json", {
    sha: "msha-bigexist",
    content: Buffer.from(JSON.stringify(manifest), "utf-8").toString("base64"),
    size: 120,
  });
  for (let i = 0; i < 1; i++) {
    store.set(`drive/.parts/bigexist/part-0000${i}`, {
      sha: `psha-bigexist-${i}`,
      content: Buffer.alloc(i === 2 ? 2 * 1024 * 1024 : 5 * 1024 * 1024, 65 + i).toString("base64"),
      size: i === 2 ? 2 * 1024 * 1024 : 5 * 1024 * 1024,
    });
  }
}

/* ---------- Mock Cache / KV（同 step7） ---------- */
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
const SITE_SEED = JSON.stringify({ title: "云盘大文件测试站", githubRepo: "leiyihan-ren/Blog", githubBranch: "main", useCdn: false });
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

const API_PORT = 8613;
const WEB_PORT = 8898;
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
      let fp = p;
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

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__blobSizes = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (b) {
      try { window.__blobSizes.push(b.size); } catch (e) { /* ignore */ }
      return orig.call(URL, b);
    };
  });
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const doneSel = (name) => `.up-item[data-name="${name}"].done`;

  try {
    console.log("== V 组：大文件分片端到端 ==");

    await page.goto(`http://127.0.0.1:${WEB_PORT}/drive.html`);
    await page.waitForSelector("#pinModal.show", { timeout: 5000 });
    await page.fill("#pinInput", DRIVE_PIN);
    await page.click("#btnPinOk");
    await page.waitForSelector("#fileTable:not([hidden])", { timeout: 8000 });

    // V1 12MB 文件 → 3 片分片上传
    ghLog.partPuts.length = 0;
    ghLog.manifestPuts.length = 0;
    await page.setInputFiles("#fileInput", {
      name: "movie-12mb.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(12 * 1024 * 1024, 0x42),
    });
    await page.waitForSelector(doneSel("movie-12mb.bin"), { timeout: 90000 });
    check("V1a 12MB 文件分片上传完成", true);
    check(
      "V1b 3 个分片按序落库（part-00000/1/2）",
      ghLog.partPuts.length === 3 && ghLog.partPuts.every((p, i) => p.index === i),
      JSON.stringify(ghLog.partPuts.map((p) => p.index))
    );
    check(
      "V1c manifest 内容含正确文件名",
      ghLog.manifestPuts.length === 1 &&
        JSON.parse(Buffer.from(ghLog.manifestPuts[0].content, "base64").toString("utf-8")).name === "movie-12mb.bin",
      JSON.stringify(ghLog.manifestPuts)
    );
    await page.waitForFunction(
      () => [...document.querySelectorAll("#fileTbody tr")].some((tr) => (tr.textContent || "").includes("🧩")),
      null,
      { timeout: 10000 }
    );
    const chunkedRow = await page.locator("#fileTbody tr", { hasText: "movie-12mb.bin" }).count();
    check("V1d 列表出现 🧩 大文件条目", chunkedRow === 1, `rows=${chunkedRow}`);

    // V2 弱网重试：新文件第 1 片首次 500 → 自动重试后成功
    partFail[0] = 1;
    ghLog.partPuts.length = 0;
    await page.setInputFiles("#fileInput", {
      name: "weak-net.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(11 * 1024 * 1024, 0x43),
    });
    await page.waitForSelector(doneSel("weak-net.bin"), { timeout: 90000 });
    check("V2a 弱网下分片自动重试并成功", ghLog.partFails >= 1 && ghLog.partPuts.length === 3, `注入失败=${ghLog.partFails} 落库=${ghLog.partPuts.length}`);
    check("V2b 3 片全部落库", ghLog.partPuts.length === 3, `puts=${ghLog.partPuts.length}`);

    // V3 断点续传：index=1 连续失败耗尽 1+3 次尝试 → 继续上传只补失败片
    partFail[1] = 4;
    ghLog.partPuts.length = 0;
    await page.setInputFiles("#fileInput", {
      name: "resumable.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(13 * 1024 * 1024, 0x44),
    });
    await page.waitForSelector('.up-item[data-name="resumable.bin"].failed', { timeout: 120000 });
    const beforeFail = ghLog.partPuts.map((p) => p.index).sort();
    check("V3a 重试耗尽后进入失败态", true);
    check("V3b 失败前其余分片已落库（0 和 2）", JSON.stringify(beforeFail) === JSON.stringify([0, 2]), JSON.stringify(beforeFail));
    // 放行 index=1，点击「继续上传（断点续传）」
    partFail[1] = 0;
    const before = ghLog.partPuts.length;
    await page.click('.up-item[data-name="resumable.bin"] .up-retry');
    await page.waitForSelector(doneSel("resumable.bin"), { timeout: 90000 });
    const newPuts = ghLog.partPuts.slice(before);
    check("V3c 继续上传只补失败分片（仅 1 个新 PUT）", newPuts.length === 1 && newPuts[0].index === 1, JSON.stringify(newPuts));

    // V4 删除锁 + 同名覆盖
    ghLog.partPuts.length = 0;
    await page.setInputFiles("#fileInput", {
      name: "big.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(12 * 1024 * 1024, 0x45),
    });
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll("#fileTbody tr")];
        const row = rows.find((tr) => (tr.textContent || "").includes("big.bin"));
        if (!row) return false;
        const btn = row.querySelector(".del");
        return btn && btn.disabled === true;
      },
      null,
      { timeout: 20000 }
    );
    check("V4a 上传中同名文件删除按钮禁用（锁生效）", true);
    await page.waitForSelector(doneSel("big.bin"), { timeout: 90000 });
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll("#fileTbody tr")];
        const row = rows.find((tr) => (tr.textContent || "").includes("big.bin"));
        if (!row) return false;
        const btn = row.querySelector(".del");
        return btn && btn.disabled === false;
      },
      null,
      { timeout: 10000 }
    );
    check("V4b 上传完成后删除按钮恢复", true);
    const bigRows = await page.locator("#fileTbody tr", { hasText: "big.bin" }).count();
    check("V4c 同名覆盖不产生重复条目", bigRows === 1, `rows=${bigRows}`);
    // 覆盖上传复用原 uploadId：parts 落在 .parts/bigexist/ 下
    check(
      "V4d 覆盖上传复用原 uploadId（断点跳过 part0，补传 1/2 于原目录）",
      ghLog.partPuts.length === 2 &&
        ghLog.partPuts.every((p) => p.path.includes("/.parts/bigexist/")) &&
        ghLog.partPuts.map((p) => p.index).sort().join(",") === "1,2",
      JSON.stringify(ghLog.partPuts.map((p) => p.path))
    );

    // V5 并发控制：3 个 11MB 文件 → 峰值并发 ≤2
    maxInFlight = 0;
    const files = [];
    for (let i = 0; i < 3; i++) {
      files.push({
        name: `conc-${i}.bin`,
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(11 * 1024 * 1024, 0x50 + i),
      });
    }
    await page.setInputFiles("#fileInput", files);
    await page.waitForFunction(
      () => ["conc-0.bin", "conc-1.bin", "conc-2.bin"].every((n) => document.querySelector(`.up-item[data-name="${n}"].done`)),
      null,
      { timeout: 180000 }
    );
    check("V5a 3 个 11MB 文件全部完成", true);
    check("V5b 分片并发峰值 ≤2（队列限流生效）", maxInFlight <= 2, `峰值=${maxInFlight}`);

    // V6 大文件重组下载：先校验 manifest 与分片直链可用，再点击下载验证 Blob 重组
    await page.addInitScript(() => { window.__blobSizes = []; });
    await page.reload();
    // sessionStorage 中 PIN 仍在 → 不弹模态，直接等列表
    await page.waitForSelector("#fileTable:not([hidden])", { timeout: 8000 });
    const chain = await page.evaluate(async () => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      const row = rows.find((tr) => (tr.textContent || "").includes("big.bin"));
      if (!row) return { err: "no row" };
      const out = {};
      try {
        const r1 = await fetch("/api/github/raw/leiyihan-ren/Blog/main/drive/.m-bigexist.json");
        out.manifestStatus = r1.status;
        const m = await r1.json();
        out.total = m.total;
        out.uploadId = m.uploadId;
        out.parts = [];
        for (let i = 0; i < (m.total || 0); i++) {
          const pad = String(i).padStart(5, "0");
          const r = await fetch("/api/github/raw/leiyihan-ren/Blog/main/drive/.parts/" + m.uploadId + "/part-" + pad);
          out.parts.push([r.status, (await r.blob()).size]);
        }
      } catch (e) { out.err = String(e); }
      return out;
    });
    check(
      "V6a manifest 与 3 个分片直链全部 200（字节 5M+5M+2M）",
      chain.manifestStatus === 200 && chain.total === 3 &&
        chain.parts.length === 3 && chain.parts.every((p) => p[0] === 200) &&
        chain.parts.map((p) => p[1]).join(",") === [5242880, 5242880, 2097152].join(","),
      JSON.stringify(chain)
    );
    await page.evaluate(() => { window.__blobSizes = []; });
    const blobSize = await page.evaluate(async () => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      const row = rows.find((tr) => (tr.textContent || "").includes("big.bin"));
      row.querySelector(".dl").click();
      for (let i = 0; i < 150; i++) {
        if (window.__blobSizes && window.__blobSizes.length) return window.__blobSizes[0];
        await new Promise((r) => setTimeout(r, 100));
      }
      return 0;
    });
    check("V6b 重组下载生成 Blob 且总字节正确（12MB）", blobSize === 12 * 1024 * 1024, `blobSize=${blobSize}`);

    // V7 小文件直传不受影响
    ghLog.partPuts.length = 0;
    await page.setInputFiles("#fileInput", {
      name: "tiny.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("small file still works"),
    });
    await page.waitForSelector(doneSel("tiny.txt"), { timeout: 20000 });
    check("V7a 小文件上传完成", true);
    check("V7b 小文件不走分片（零 part PUT）", ghLog.partPuts.length === 0, `partPuts=${ghLog.partPuts.length}`);

    // V8 32MB 端到端（20-50MB 区间）：7 片上传 → 进度条 → 列表可见
    //     → 重组下载 32MB Blob → 删除时注入 409 读副本滞后 → worker 自愈后删除成功
    ghLog.partPuts.length = 0;
    ghLog.deletes.length = 0;
    await page.setInputFiles("#fileInput", {
      name: "movie-32mb.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(32 * 1024 * 1024, 0x46),
    });
    // 上传中：进度条真实推进（fill 宽度 > 0）
    await page.waitForFunction(
      () => {
        const it = document.querySelector('.up-item[data-name="movie-32mb.bin"]');
        if (!it) return false;
        const fill = it.querySelector(".up-bar i");
        return !!fill && parseFloat(fill.style.width) > 0;
      },
      null,
      { timeout: 60000 }
    );
    check("V8a 上传中进度条实时推进", true);
    const hintSeen = await page.evaluate(() => {
      const it = document.querySelector('.up-item[data-name="movie-32mb.bin"]');
      return it ? /第 \d\/7 片/.test(it.textContent) : false;
    });
    check("V8b 队列显示分片进度（第 x/7 片）", hintSeen);
    await page.waitForSelector(doneSel("movie-32mb.bin"), { timeout: 150000 });
    check("V8c 32MB 文件上传完成", true);
    check(
      "V8d 7 个分片按序落库（6×5MB + 1×2MB）",
      ghLog.partPuts.length === 7 && ghLog.partPuts.every((p, i) => p.index === i),
      JSON.stringify(ghLog.partPuts.map((p) => p.index))
    );
    await page.waitForFunction(
      () => [...document.querySelectorAll("#fileTbody tr")].some((tr) => (tr.textContent || "").includes("movie-32mb.bin")),
      null,
      { timeout: 10000 }
    );
    check("V8e 列表出现 🧩 32MB 大文件条目", true);

    // V8f 重组下载：32MB Blob
    await page.evaluate(() => { window.__blobSizes = []; });
    const blob32 = await page.evaluate(async () => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      const row = rows.find((tr) => (tr.textContent || "").includes("movie-32mb.bin"));
      row.querySelector(".dl").click();
      for (let i = 0; i < 200; i++) {
        if (window.__blobSizes && window.__blobSizes.length) return window.__blobSizes[0];
        await new Promise((r) => setTimeout(r, 100));
      }
      return 0;
    });
    check("V8f 重组下载生成 32MB Blob", blob32 === 32 * 1024 * 1024, `blobSize=${blob32}`);

    // V8g 删除：注入首片 409（读副本滞后）→ worker 自愈刷新重删 → UI 删除成功
    const uid32 = ghLog.partPuts[0].path.match(/drive\/\.parts\/([^/]+)\//)[1];
    delete409Once.add(`drive/.parts/${uid32}/part-00000`);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      const row = rows.find((tr) => (tr.textContent || "").includes("movie-32mb.bin"));
      row.querySelector(".del").click();
    });
    await page.waitForSelector("#confirmModal.show", { timeout: 8000 });
    await page.click("#btnConfirmDel");
    await page.waitForFunction(
      () => ![...document.querySelectorAll("#fileTbody tr")].some((tr) => (tr.textContent || "").includes("movie-32mb.bin")),
      null,
      { timeout: 30000 }
    );
    check("V8g 409 自愈后 UI 删除成功（列表行消失）", true);
    const p0 = `drive/.parts/${uid32}/part-00000`;
    check(
      "V8h 自愈路径：首片 409 一次 + 刷新重删成功一次",
      ghLog.del409.filter((p) => p === p0).length === 1 && ghLog.deletes.filter((p) => p === p0).length === 1,
      `del409=${JSON.stringify(ghLog.del409)} deletes0=${ghLog.deletes.filter((p) => p === p0).length}`
    );
    const all32 = ghLog.deletes.filter((p) => p.includes(uid32));
    check("V8i 7 片 + manifest 全部删除（自愈不影响其余）", all32.length === 8, `got ${all32.length}`);
  } finally {
    await browser.close();
    staticServer.close();
    api.server.close();
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
