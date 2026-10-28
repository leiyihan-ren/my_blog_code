// ============================================================
// v5.0 步骤 7b：云盘页面端到端测试（Playwright）
//   本地装配：mock GitHub 上游（contents/commits/PUT/DELETE）
//   + worker API server + 静态 server，Chromium 打 drive.html。
//   U1 PIN 模态自动弹出（未验证）
//   U2 错误 PIN 被拒，模态停留
//   U3 正确 PIN → 文件列表 + 统计渲染
//   U4 删除：二次确认模态 → 确认后列表减少
//   U5 上传：setInputFiles → 队列进度 → 完成 → 列表新增
//   U6 下载链接指向 /api/github/raw/ 同源代理
// 运行：node tests/step7-drive-ui.mjs
// ============================================================
import worker, { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

/* ---------- Mock GitHub 上游（内存文件表） ---------- */
const ghDrive = {
  files: [
    { type: "file", name: "hello.txt", path: "drive/hello.txt", size: 12, sha: "sha-1" },
    { type: "file", name: "note.md", path: "drive/note.md", size: 34, sha: "sha-2" },
    { type: "file", name: "pic.png", path: "drive/pic.png", size: 2048, sha: "sha-3" },
  ],
  putBodies: [],
  delBodies: [],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input.url;
  const method = (init && init.method) || "GET";
  const rl = { "X-RateLimit-Remaining": "5000", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
  const j = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...rl } });
  const REPO = "leiyihan-ren/Blog";

  if (u === `https://api.github.com/repos/${REPO}/contents/drive?ref=main`) {
    return j(ghDrive.files);
  }
  const meta = u.match(new RegExp(`/contents/(drive/[^?]+)\\?ref=`));
  if (meta && method === "GET") {
    const f = ghDrive.files.find((x) => x.path === meta[1]);
    return f ? j(f) : j({ message: "Not Found" }, 404);
  }
  if (u.includes("/commits?path=")) {
    return j([{ commit: { committer: { date: "2026-10-20T08:00:00Z" } } }]);
  }
  const put = u.match(new RegExp(`/contents/(drive/[^?]+)\\?ref=`));
  if (put && method === "PUT") {
    const body = JSON.parse(init.body);
    ghDrive.putBodies.push(body);
    const idx = ghDrive.files.findIndex((x) => x.path === put[1]);
    if (idx >= 0) {
      if (body.sha !== ghDrive.files[idx].sha) return j({ message: "conflict" }, 409);
      ghDrive.files[idx] = { ...ghDrive.files[idx], sha: "sha-new-" + idx };
    } else {
      ghDrive.files.push({ type: "file", name: put[1].split("/").pop(), path: put[1], size: 99, sha: "sha-new" });
    }
    return j({ content: { sha: "sha-new" }, commit: { sha: "c1" } }, 201);
  }
  if (u.includes("/contents/drive/") && method === "DELETE") {
    const body = JSON.parse(init.body);
    ghDrive.delBodies.push(body);
    const idx = ghDrive.files.findIndex((x) => x.path === body.__path || x.sha === body.sha);
    if (idx >= 0) ghDrive.files.splice(idx, 1);
    return j({ commit: { sha: "c2" } });
  }
  return j({ message: "unexpected: " + u }, 500);
};

/* ---------- Mock Cache / KV ---------- */
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
const SITE_SEED = JSON.stringify({ title: "云盘测试站", githubRepo: "leiyihan-ren/Blog", githubBranch: "main", useCdn: false });

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
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
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
      const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((r) => staticServer.listen(WEB_PORT, "127.0.0.1", r));

  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    console.log("== U 组：云盘页面端到端 ==");

    await page.goto(`http://127.0.0.1:${WEB_PORT}/drive.html`);

    // U1 PIN 模态自动弹出
    await page.waitForSelector("#pinModal.show", { timeout: 5000 });
    check("U1 未验证 → PIN 模态自动弹出", true);

    // U2 错误 PIN
    await page.fill("#pinInput", "0000");
    await page.click("#btnPinOk");
    await sleep(600);
    check("U2 错误 PIN → 模态停留且未进页面", await page.isVisible("#pinModal.show"));

    // U3 正确 PIN → 列表渲染
    await page.fill("#pinInput", DRIVE_PIN);
    await page.click("#btnPinOk");
    await page.waitForSelector("#fileTable:not([hidden])", { timeout: 8000 });
    const rowCount = await page.locator("#fileTbody tr").count();
    check("U3a 正确 PIN → 进入并渲染 3 个文件", rowCount === 3, `rows=${rowCount}`);
    const statText = await page.textContent("#statCount");
    check("U3b 统计显示文件数", /3 个/.test(statText), statText);
    const timeText = await page.textContent("#fileTbody tr:first-child td.f-time");
    check("U3c 上传时间列有值", /2026-10-20/.test(timeText), timeText);

    // U6 下载链接
    const dlHref = await page.getAttribute("#fileTbody tr:first-child .f-name a", "href");
    check("U6 下载链接为同源 raw 代理", dlHref.startsWith("/api/github/raw/leiyihan-ren/Blog/main/drive/"), dlHref);

    // U4 删除流程（二次确认 → 确认 → 列表减少）
    await page.click("#fileTbody tr:first-child .del");
    await page.waitForSelector("#confirmModal.show", { timeout: 3000 });
    check("U4a 删除前弹出二次确认", true);
    const confirmName = await page.textContent("#confirmName");
    check("U4b 确认框显示文件名", confirmName === "hello.txt", confirmName);
    await page.click("#btnConfirmDel");
    await page.waitForFunction(() => document.querySelectorAll("#fileTbody tr").length === 2, null, { timeout: 8000 });
    const rowCount2 = await page.locator("#fileTbody tr").count();
    check("U4c 确认删除 → 列表减为 2", rowCount2 === 2, `rows=${rowCount2}`);
    check("U4d DELETE 带 sha", ghDrive.delBodies.length === 1 && !!ghDrive.delBodies[0].sha, JSON.stringify(ghDrive.delBodies));

    // U5 上传流程（setInputFiles → 进度 → 完成 → 列表新增）
    await page.setInputFiles("#fileInput", {
      name: "test-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello drive v5"),
    });
    await page.waitForSelector("#uploadPanel:not([hidden])", { timeout: 3000 });
    await page.waitForSelector(".up-item.done", { timeout: 15000 });
    check("U5a 上传队列出现且完成", true);
    await page.waitForFunction(() => document.querySelectorAll("#fileTbody tr").length >= 3, null, { timeout: 10000 });
    const rowCount3 = await page.locator("#fileTbody tr").count();
    check("U5b 上传后列表新增（3 个）", rowCount3 === 3, `rows=${rowCount3}`);
    check("U5c 上传走 PUT 且新文件不带 sha", ghDrive.putBodies.length >= 1 && !ghDrive.putBodies[ghDrive.putBodies.length - 1].sha, JSON.stringify(ghDrive.putBodies.slice(-1)));

    // U7 导航含云盘且 active
    const navActive = await page.getAttribute('.nav-links a[href="/drive.html"]', "class");
    check("U7 导航云盘项 active", navActive === "active", navActive);
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
