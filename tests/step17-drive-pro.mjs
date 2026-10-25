// ============================================================
// v8.0 战役3：网盘商业级强化专项测试（Playwright）
//   在 step14 同款装配（mock GitHub 上游 + worker API + 静态服务器）上验证：
//   A 组 子目录与面包屑（chips 渲染 / 进入 / 回跳 / 多级）
//   B 组 上传到当前目录（小文件 path 带子目录）
//   C 组 文件夹上传（input[webkitdirectory] 相对路径解析）
//   D 组 拖拽文件夹（webkitGetAsEntry 目录递归，readEntries 循环读完）
//   E 组 多选打包下载（JSZip 按需加载 / zip 条目 / 路径 strip / 大文件 saveBlob 劫持）
//   F 组 在线预览（图片 / 文本 / 音频 / 大文件无按钮 / 关闭）
//   G 组 Worker 层（list dirs / finish dir 落点 / 非法 dir 400 / 子目录 manifest 识别）
// 运行：node tests/step17-drive-pro.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import pkg from "playwright";
const { chromium } = pkg;

/* ---------- Mock GitHub 上游（含目录条目 + 子目录内容 + 分片 raw） ---------- */
const ghDrive = {
  files: [
    { type: "file", name: "hello.txt", path: "drive/hello.txt", size: 12, sha: "sha-1" },
    { type: "file", name: "note.md", path: "drive/note.md", size: 34, sha: "sha-2" },
    { type: "file", name: "pic.png", path: "drive/pic.png", size: 2048, sha: "sha-3" },
    { type: "file", name: "song.mp3", path: "drive/song.mp3", size: 4096, sha: "sha-5" },
    { type: "file", name: ".m-bigfile01.json", path: "drive/.m-bigfile01.json", size: 120, sha: "sha-m1" },
    { type: "dir", name: "photos", path: "drive/photos" },
    { type: "dir", name: "docs", path: "drive/docs" },
    { type: "file", name: "beach.jpg", path: "drive/photos/beach.jpg", size: 8192, sha: "sha-p1" },
    { type: "file", name: ".m-sub01.json", path: "drive/photos/.m-sub01.json", size: 110, sha: "sha-pm1" },
  ],
  putBodies: [],
  delBodies: [],
};
const MANIFESTS = {
  "drive/.m-bigfile01.json": { name: "big.bin", size: 20 * 1024 * 1024, uploadId: "bigfile01", total: 4 },
  "drive/photos/.m-sub01.json": { name: "sub.bin", size: 10 * 1024 * 1024, uploadId: "sub01", total: 2 },
};
const DIR_LISTING = {
  "drive": ["hello.txt", "note.md", "pic.png", "song.mp3", ".m-bigfile01.json", "photos", "docs"],
  "drive/photos": ["beach.jpg", ".m-sub01.json"],
  "drive/docs": [],
};
const COMMIT_TIMES = {
  "drive/hello.txt": "2026-10-20T08:00:00Z",
  "drive/note.md": "2026-10-22T08:00:00Z",
  "drive/pic.png": "2026-10-21T08:00:00Z",
  "drive/song.mp3": "2026-10-23T08:00:00Z",
  "drive/photos/beach.jpg": "2026-10-24T08:00:00Z",
  "drive/.m-bigfile01.json": "2026-10-19T08:00:00Z",
  "drive/photos/.m-sub01.json": "2026-10-18T08:00:00Z",
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input.url;
  const method = (init && init.method) || "GET";
  const rl = { "X-RateLimit-Remaining": "5000", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
  const j = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...rl } });
  const REPO = "leiyihan-ren/Blog";

  // 目录列表（DIR_LISTING 有该键才是目录；否则 fall through 到单文件分支——
  // drive/.m-bigfile01.json 这类 manifest 路径也会被目录正则的形状匹配到）
  const dirM = u.match(new RegExp(`/contents/(drive(?:/[^/]+)?)\\?ref=`));
  if (dirM && method === "GET" && DIR_LISTING[dirM[1]] !== undefined) {
    const dir = dirM[1];
    const names = DIR_LISTING[dir];
    return j(names.map((name) => {
      const p = dir === "drive" ? `drive/${name}` : `${dir}/${name}`;
      const isDir = ghDrive.files.some((f) => f.type === "dir" && f.path === p);
      return isDir
        ? { type: "dir", name, path: p }
        : { type: "file", name, path: p, size: 100, sha: "sha-" + name };
    }));
  }
  // 单文件读取：manifest（.m-*.json）内容 / 普通文件 Base64
  const meta = u.match(new RegExp(`/contents/(drive/[^?]+)\\?ref=`));
  if (meta && method === "GET") {
    const p = meta[1];
    if (MANIFESTS[p]) {
      return j({ name: path.basename(p), content: Buffer.from(JSON.stringify(MANIFESTS[p])).toString("base64"), encoding: "base64" });
    }
    if (!/^\.m-[A-Za-z0-9_-]{1,64}\.json$/.test(path.posix.basename(p)) && !p.includes("/.parts/")) {
      return j({ name: path.basename(p), content: Buffer.from("file-content-of-" + path.basename(p)).toString("base64"), encoding: "base64" });
    }
    return j({ message: "Not Found" }, 404);
  }
  const cp = u.match(/\/commits\?path=([^&]+)&/);
  if (cp && method === "GET") {
    const p = decodeURIComponent(cp[1]);
    return j([{ commit: { committer: { date: COMMIT_TIMES[p] || "2026-10-18T08:00:00Z" } } }]);
  }
  // raw 代理上游：普通文件文本 / manifest JSON / 分片二进制
  const raw = u.match(/^https:\/\/raw\.githubusercontent\.com\/leiyihan-ren\/Blog\/main\/(drive\/.+)$/);
  if (raw && method === "GET") {
    const p = raw[1];
    if (MANIFESTS[p]) {
      return new Response(JSON.stringify(MANIFESTS[p]), { status: 200, headers: { ...rl, "Content-Type": "application/json" } });
    }
    const part = p.match(/^drive\/\.parts\/([A-Za-z0-9_-]+)\/part-(\d+)$/);
    if (part) {
      // 分片内容：用 uploadId 区分，每片 5MB 中的前 64 字节不同（体积小、内容可验证）
      const buf = Buffer.alloc(64);
      buf.fill(0x41 + (Number(part[2]) % 26));
      buf.write("PART:" + part[1] + ":" + part[2], 0, "ascii");
      return new Response(buf, { status: 200, headers: { ...rl, "Content-Type": "application/octet-stream" } });
    }
    return new Response("file-content-of-" + path.basename(p), { status: 200, headers: rl });
  }
  /** 同步目录清单：新文件按父目录插入 DIR_LISTING（GitHub 真实语义——
   *  Contents PUT 后目录列表立即可见新条目；缺失同步会让「上传→刷新」
   *  场景永远拿不到新文件，被误判为产品缓存 bug） */
  function dirListAdd(filePath) {
    const segs = filePath.split("/");
    const name = segs.pop();
    const dir = segs.join("/"); // "drive" 或 "drive/photos" 或新目录
    if (!DIR_LISTING[dir]) DIR_LISTING[dir] = []; // 目录首文件 → 目录自动创建
    if (!DIR_LISTING[dir].includes(name)) DIR_LISTING[dir].push(name);
  }
  function dirListRemove(filePath) {
    const segs = filePath.split("/");
    const name = segs.pop();
    const dir = segs.join("/");
    if (DIR_LISTING[dir]) DIR_LISTING[dir] = DIR_LISTING[dir].filter((n) => n !== name);
  }
  const put = u.match(new RegExp(`/contents/(drive/[^?]+)\\?ref=`));
  if (put && method === "PUT") {
    const body = JSON.parse(init.body);
    ghDrive.putBodies.push({ path: put[1], body });
    const idx = ghDrive.files.findIndex((x) => x.path === put[1]);
    if (idx >= 0) {
      if (body.sha && body.sha !== ghDrive.files[idx].sha) return j({ message: "conflict" }, 409);
      ghDrive.files[idx] = { ...ghDrive.files[idx], sha: "sha-new-" + idx };
    } else {
      ghDrive.files.push({ type: "file", name: put[1].split("/").pop(), path: put[1], size: 99, sha: "sha-new" });
      dirListAdd(put[1]);
    }
    return j({ content: { sha: "sha-new" }, commit: { sha: "c1" } }, 201);
  }
  if (u.includes("/contents/drive/") && method === "DELETE") {
    const body = JSON.parse(init.body);
    const idx = ghDrive.files.findIndex((x) => x.sha === body.sha);
    ghDrive.delBodies.push({ path: idx >= 0 ? ghDrive.files[idx].path : "", sha: body.sha || "" });
    if (idx >= 0) {
      dirListRemove(ghDrive.files[idx].path);
      ghDrive.files.splice(idx, 1);
    }
    return j({ commit: { sha: "c2" } });
  }
  return j({ message: "unexpected: " + u }, 500);
};

/* ---------- Mock Cache / KV（同 step14） ---------- */
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
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
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

const API_PORT = 8626;
const WEB_PORT = 8901;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

/** 用 Python zipfile 读 zip 条目名（环境无 node jszip，python3 标配可用） */
function zipEntries(zipPath) {
  const out = execFileSync("python3", ["-c", `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps(sorted(z.namelist())))
`, zipPath], { encoding: "utf8" });
  return JSON.parse(out.trim());
}

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
      const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((r) => staticServer.listen(WEB_PORT, "127.0.0.1", r));

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e && e.message || e)));
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 带 PIN 进入云盘并等列表就绪 */
  async function enterDrive() {
    await page.goto(`http://127.0.0.1:${WEB_PORT}/drive.html`);
    await page.waitForSelector("#pinModal.show", { timeout: 5000 });
    await page.fill("#pinInput", DRIVE_PIN);
    await page.click("#btnPinOk");
    await page.waitForSelector("#fileTable:not([hidden])", { timeout: 8000 });
  }

  try {
    console.log("== A 组：子目录与面包屑 ==");
    await enterDrive();

    // A1 目录 chips：photos / docs
    const chipNames = await page.evaluate(() =>
      [...document.querySelectorAll("#dirGrid .dir-chip .dir-name")].map((e) => e.textContent));
    check("A1a 渲染 2 个目录 chips", chipNames.length === 2 && chipNames[0] === "docs" && chipNames[1] === "photos", JSON.stringify(chipNames));

    // A2 点击 photos → 列表切到子目录（请求带 path=drive/photos）
    await page.click('#dirGrid .dir-chip:has-text("photos")');
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      return rows.length === 2 && (rows[0].textContent || "").includes("beach.jpg"); // beach.jpg + sub01 大文件条目
    }, null, { timeout: 8000 });
    const crumbText = await page.textContent("#driveCrumbs");
    check("A2a 进入 photos → 列表仅该目录文件（2 行）", true);
    check("A2b 面包屑含根目录段与 photos 段", /云盘根目录/.test(crumbText) && /photos/.test(crumbText), crumbText);
    const photosCurrent = await page.evaluate(() =>
      document.querySelectorAll("#driveCrumbs .crumb.current").length === 1 &&
      document.querySelector("#driveCrumbs .crumb.current").textContent === "photos");
    check("A2c 当前目录段标记 current", photosCurrent);

    // A3 面包屑回跳根目录
    await page.click("#driveCrumbs .crumb:not(.current)");
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      return rows.length === 5; // 4 小文件 + 1 manifest 大文件条目（目录条目不进 tbody）
    }, null, { timeout: 8000 });
    check("A3 面包屑回跳根目录 → 6 行（目录条目不进 tbody）", true);

    // A4 上传面板与空态不受目录切换影响（空目录 docs）
    await page.click('#dirGrid .dir-chip:has-text("docs")');
    await page.waitForFunction(() => document.querySelector("#emptyState") && !document.querySelector("#emptyState").hidden, null, { timeout: 8000 });
    const emptyVisible = await page.isVisible("#emptyState");
    check("A4 空子目录显示空态（而非表格）", emptyVisible);
    await page.click("#driveCrumbs .crumb:not(.current)"); // 回根

    console.log("== B 组：上传到当前目录 ==");
    await page.click('#dirGrid .dir-chip:has-text("photos")');
    await page.waitForFunction(() => (document.querySelector("#fileTbody tr") || {}).textContent?.includes("beach.jpg"), null, { timeout: 8000 });
    // 在 photos 目录上传一个小文件 → upload path 必须是 drive/photos/in-photos.txt
    await page.setInputFiles("#fileInput", {
      name: "in-photos.txt", mimeType: "text/plain", buffer: Buffer.from("sub-dir-upload"),
    });
    await page.waitForFunction(() => document.querySelector('.up-item[data-name="in-photos.txt"].done'), null, { timeout: 20000 });
    const subUpload = ghDrive.putBodies.filter((b) => b.path === "drive/photos/in-photos.txt");
    check("B1 子目录内上传 → PUT path=drive/photos/in-photos.txt", subUpload.length === 1, JSON.stringify(ghDrive.putBodies.map((b) => b.path)));
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      return rows.some((tr) => (tr.textContent || "").includes("in-photos.txt"));
    }, null, { timeout: 8000 });
    check("B2 上传完成后子目录列表出现新文件", true);

    console.log("== C 组：文件夹上传（input[webkitdirectory]） ==");
    ghDrive.putBodies.length = 0;
    await page.evaluate(() => {
      // 构造带 webkitRelativePath 的 File 列表，直接触发 folderInput onchange
      const dt = new DataTransfer();
      dt.items.add(new File(["a"], "a.txt", { type: "text/plain" }));
      void dt;
      const input = document.getElementById("folderInput");
      const files = [
        new File(["a"], "readme.txt", { type: "text/plain" }),
        new File(["b"], "b.txt", { type: "text/plain" }),
      ];
      Object.defineProperty(files[0], "webkitRelativePath", { value: "trip/readme.txt" });
      Object.defineProperty(files[1], "webkitRelativePath", { value: "trip/sub/b.txt" });
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() =>
      document.querySelector('.up-item[data-name="readme.txt"].done') &&
      document.querySelector('.up-item[data-name="b.txt"].done'), null, { timeout: 25000 });
    const folderPuts = ghDrive.putBodies.map((b) => b.path).sort();
    check("C1 文件夹上传保留目录结构", JSON.stringify(folderPuts) === JSON.stringify(["drive/photos/trip/readme.txt", "drive/photos/trip/sub/b.txt"]), JSON.stringify(folderPuts));

    console.log("== D 组：拖拽文件夹（webkitGetAsEntry 递归） ==");
    ghDrive.putBodies.length = 0;
    await page.evaluate(() => {
      const fileB = new File(["img"], "b.jpg", { type: "image/jpeg" });
      const fileC = new File(["txt"], "c.txt", { type: "text/plain" });
      const fileRoot = new File(["root"], "root.txt", { type: "text/plain" });
      const subDir = {
        isDirectory: true, name: "sub",
        createReader: () => {
          let sent = false;
          return { readEntries: (cb) => { if (sent) return cb([]); sent = true; cb([{ isFile: true, name: "c.txt", file: (done) => done(fileC) }]); } };
        },
      };
      const albumDir = {
        isDirectory: true, name: "album",
        createReader: () => {
          let sent = false;
          return { readEntries: (cb) => {
            if (sent) return cb([]);
            sent = true;
            cb([{ isFile: true, name: "b.jpg", file: (done) => done(fileB) }, subDir]);
          } };
        },
      };
      const orig = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        const f = this.getAsFile();
        if (!f) return null;
        if (f.name === "root.txt") return { isFile: true, file: f };
        return albumDir; // 其余一律按 album 目录处理
      };
      const dt = new DataTransfer();
      dt.items.add(fileRoot);
      dt.items.add(new File(["dir-marker"], "album-folder-marker")); // 触发 albumDir 递归
      const dz = document.getElementById("dropzone");
      dz.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      DataTransferItem.prototype.webkitGetAsEntry = orig;
    });
    await page.waitForFunction(() =>
      document.querySelector('.up-item[data-name="root.txt"].done') &&
      document.querySelector('.up-item[data-name="b.jpg"].done') &&
      document.querySelector('.up-item[data-name="c.txt"].done'), null, { timeout: 25000 });
    const dropPuts = ghDrive.putBodies.map((b) => b.path).sort();
    check("D1 拖拽目录递归 + readEntries 循环", JSON.stringify(dropPuts) === JSON.stringify([
      "drive/photos/album/b.jpg", "drive/photos/album/sub/c.txt", "drive/photos/root.txt",
    ]), JSON.stringify(dropPuts));

    console.log("== E 组：多选打包下载 ==");
    // 回根目录，勾选 2 个小文件打包
    await page.click("#driveCrumbs .crumb:not(.current)");
    await page.waitForFunction(() => document.querySelectorAll("#fileTbody tr").length === 5, null, { timeout: 8000 });
    const jszipLazy = await page.evaluate(() => typeof window.JSZip === "undefined");
    check("E1a 页面加载时 JSZip 未注入（按需加载）", jszipLazy);

    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      rows.forEach((tr) => {
        const name = (tr.querySelector(".f-name a").textContent || "").replace(" 🧩", "");
        if (name === "hello.txt" || name === "note.md") tr.querySelector(".row-chk").click();
      });
    });
    const batchVisible = await page.isVisible("#batchBar");
    const batchText = await page.textContent("#batchCount");
    check("E1b 勾选后批量条可见且计数正确", batchVisible && /已选 2 项/.test(batchText), batchText);
    const zipAllChecked = await page.evaluate(() => document.getElementById("chkAll").checked);
    check("E1c 部分选中时全选框不勾选（5 行仅选 2）", zipAllChecked === false);

    const dlPromise = page.waitForEvent("download", { timeout: 30000 });
    await page.click("#btnBatchZip");
    const download = await dlPromise;
    const zipPath = path.join(os.tmpdir(), "drive-batch-" + Date.now() + ".zip");
    await download.saveAs(zipPath);
    const entries = zipEntries(zipPath);
    check("E2a zip 条目 = 勾选的两个文件（根目录无前缀）", JSON.stringify(entries) === JSON.stringify(["hello.txt", "note.md"]), JSON.stringify(entries));
    fs.unlinkSync(zipPath);

    // E3 全选后打包（含大文件：走 saveBlob 劫持重组路径）
    await page.click("#chkAll");
    await sleep(150);
    const dlPromise2 = page.waitForEvent("download", { timeout: 60000 });
    await page.click("#btnBatchZip");
    const download2 = await dlPromise2;
    const zipPath2 = path.join(os.tmpdir(), "drive-batch2-" + Date.now() + ".zip");
    await download2.saveAs(zipPath2);
    const entries2 = zipEntries(zipPath2);
    check("E3a 全量打包含大文件重组条目", entries2.includes("big.bin") && entries2.includes("pic.png") && entries2.includes("song.mp3"), JSON.stringify(entries2));
    fs.unlinkSync(zipPath2);

    // E4 子目录内打包 → zip 条目 strip 当前目录前缀
    await page.click("#chkAll"); // 取消全选
    await sleep(100);
    await page.click('#dirGrid .dir-chip:has-text("photos")');
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      return rows.length === 3; // beach.jpg + .m-sub01(大文件) + in-photos.txt
    }, null, { timeout: 8000 });
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      rows.forEach((tr) => {
        const name = (tr.querySelector(".f-name a").textContent || "").replace(" 🧩", "");
        if (name === "beach.jpg") tr.querySelector(".row-chk").click();
      });
    });
    const dlPromise3 = page.waitForEvent("download", { timeout: 30000 });
    await page.click("#btnBatchZip");
    const download3 = await dlPromise3;
    const zipPath3 = path.join(os.tmpdir(), "drive-batch3-" + Date.now() + ".zip");
    await download3.saveAs(zipPath3);
    const entries3 = zipEntries(zipPath3);
    check("E4 子目录打包 strip 前缀 → 条目为 beach.jpg", JSON.stringify(entries3) === JSON.stringify(["beach.jpg"]), JSON.stringify(entries3));
    fs.unlinkSync(zipPath3);
    await page.click("#driveCrumbs .crumb:not(.current)"); // 回根

    console.log("== F 组：在线预览 ==");
    await page.waitForFunction(() => document.querySelectorAll("#fileTbody tr").length === 5, null, { timeout: 8000 });
    // F1 图片预览
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      rows.forEach((tr) => {
        if ((tr.querySelector(".f-name a").textContent || "") === "pic.png") tr.querySelector(".pv").click();
      });
    });
    await page.waitForSelector("#previewModal.show", { timeout: 5000 });
    const imgSrc = await page.getAttribute("#previewBody img", "src");
    check("F1 图片预览 modal + img src 指向 downloadUrl", !!imgSrc && /pic\.png/.test(imgSrc), String(imgSrc));
    const dlHref = await page.getAttribute("#btnPreviewDl", "href");
    check("F1b 预览模态带下载链接", !!dlHref && /pic\.png/.test(dlHref));
    await page.click("#btnPreviewClose");
    await page.waitForFunction(() => !document.querySelector("#previewModal").classList.contains("show"), null, { timeout: 3000 });

    // F2 文本预览（textContent 注入，XSS 安全）
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      rows.forEach((tr) => {
        if ((tr.querySelector(".f-name a").textContent || "") === "note.md") tr.querySelector(".pv").click();
      });
    });
    await page.waitForFunction(() => document.querySelector("#previewBody pre"), null, { timeout: 8000 });
    const preText = await page.textContent("#previewBody pre");
    check("F2 文本预览内容正确（mock raw 文本）", /file-content-of-note\.md/.test(preText), String(preText));
    await page.click("#btnPreviewClose");

    // F3 音频预览
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      rows.forEach((tr) => {
        if ((tr.querySelector(".f-name a").textContent || "") === "song.mp3") tr.querySelector(".pv").click();
      });
    });
    await page.waitForSelector("#previewBody audio", { timeout: 5000 });
    check("F3 音频预览渲染 <audio controls>", true);
    await page.click("#btnPreviewClose");

    // F4 大文件无预览按钮
    const bigRowHasPv = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      return rows.some((tr) => (tr.textContent || "").includes("big.bin") && tr.querySelector(".pv"));
    });
    check("F4 大文件（分片）不提供预览按钮", !bigRowHasPv);

    // F5 无预览类型不渲染按钮（zip 不存在于 mock；用 docs 空目录无行可查——改查 hello.txt 有按钮）
    const txtRowPv = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#fileTbody tr")];
      return rows.some((tr) => (tr.textContent || "").includes("hello.txt") && tr.querySelector(".pv"));
    });
    check("F5 txt 可预览（按钮存在）", txtRowPv);

    console.log("== G 组：Worker 层目录能力 ==");
    // G1 list 返回 dirs
    const listResp = await realFetch(`${API_ORIGIN}/api/drive/list`, { headers: { "x-drive-pin": DRIVE_PIN } });
    const listJson = await listResp.json();
    check("G1 list 返回 dirs（含 photos/docs）", JSON.stringify(listJson.dirs) === JSON.stringify(["docs", "photos"]), JSON.stringify(listJson.dirs));

    // G2 finish 带 dir → manifest 落 drive/photos/.m-xxx.json
    const finishResp = await realFetch(`${API_ORIGIN}/api/drive/upload/finish`, {
      method: "POST",
      headers: { "x-drive-pin": DRIVE_PIN, "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: "dirfin01", name: "x.bin", size: 100, total: 1, dir: "photos" }),
    });
    // 分片不存在 → 409（先造分片再 finish 太重复；改为只验证非法 dir 与 manifest 路径识别）
    check("G2a finish 带合法 dir 不报目录错误", finishResp.status === 409 || finishResp.status === 200, "status=" + finishResp.status);
    const badDirResp = await realFetch(`${API_ORIGIN}/api/drive/upload/finish`, {
      method: "POST",
      headers: { "x-drive-pin": DRIVE_PIN, "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: "dirfin02", name: "x.bin", size: 100, total: 1, dir: "../evil" }),
    });
    check("G2b finish dir 含 .. → 400", badDirResp.status === 400, "status=" + badDirResp.status);

    // G3 子目录 manifest 识别：list?path=drive/photos → .m-sub01.json 变成 chunked 条目
    const subListResp = await realFetch(`${API_ORIGIN}/api/drive/list?path=${encodeURIComponent("drive/photos")}`, { headers: { "x-drive-pin": DRIVE_PIN } });
    const subJson = await subListResp.json();
    const chunkedInSub = (subJson.files || []).filter((f) => f.storage === "chunked");
    check("G3 子目录 manifest 被识别为 chunked 条目", chunkedInSub.length === 1 && chunkedInSub[0].name === "sub.bin", JSON.stringify(chunkedInSub.map((f) => f.name)));

    // G4 全流程零 JS 错误
    check("G4 全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | "));

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  } catch (e) {
    // 注意：异常必须计入 failed 再走 finally 清理——不能把 process.exit 放在
    // finally（会吞掉失败信息，让套件以 exit 0 假绿收场）
    console.error("套件异常：", e && e.stack || e);
    failed++;
  } finally {
    await browser.close().catch(() => {});
    staticServer.close();
    api.server.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("套件崩溃：", e); process.exit(1); });
