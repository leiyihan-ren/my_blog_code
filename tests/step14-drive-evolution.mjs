// ============================================================
// v7.3 步骤 4：网盘高级进化专项测试（Playwright）
//   本地装配同 step7：mock GitHub 上游 + worker API server + 静态 server。
//   E1 列表渲染（小文件 + 大文件 manifest 条目）
//   E2 默认排序：上传时间倒序（最新在上）
//   E3 按大小排序 + 方向翻转
//   E4 按名称排序
//   E5 搜索过滤 / 清空 / 无结果空态
//   E6 重命名小文件：读回→新路径上传→删旧路径（大文件按钮禁用）
//   E7 大文件（manifest）重命名按钮禁用 + title 说明
//   E8 乐观删除：API 失败 → 行即时移除后回滚 + 错误提示
//   E9 上传完成 → 队列分组渲染 → 「清除已完成」只清面板不动文件
//   E10 分组 DOM 契约：.up-item 数与任务数一致（分组头不混入 up-item）
// 运行：node tests/step14-drive-evolution.mjs
// ============================================================
import worker, { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

/* ---------- Mock GitHub 上游（内存文件表 + 可控故障开关） ---------- */
const ghDrive = {
  files: [
    { type: "file", name: "hello.txt", path: "drive/hello.txt", size: 12, sha: "sha-1" },
    { type: "file", name: "note.md", path: "drive/note.md", size: 34, sha: "sha-2" },
    { type: "file", name: "pic.png", path: "drive/pic.png", size: 2048, sha: "sha-3" },
    // 大文件 manifest（storage: chunked）——drive/.m-<id>.json 内容即清单
    { type: "file", name: ".m-bigfile01.json", path: "drive/.m-bigfile01.json", size: 120, sha: "sha-m1" },
  ],
  putBodies: [],
  delBodies: [],
  failDelete: false, // E8：打开后 DELETE 一律 500，验证乐观回滚
};
const MANIFEST_B64 = Buffer.from(JSON.stringify({
  name: "big.bin", size: 20 * 1024 * 1024, uploadId: "bigfile01", total: 4,
})).toString("base64");
const COMMIT_TIMES = {
  "drive/hello.txt": "2026-10-20T08:00:00Z",
  "drive/note.md": "2026-10-22T08:00:00Z",
  "drive/pic.png": "2026-10-21T08:00:00Z",
  "drive/.m-bigfile01.json": "2026-10-19T08:00:00Z",
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
    if (!f) return j({ message: "Not Found" }, 404);
    if (f.name === ".m-bigfile01.json") {
      return j({ ...f, content: MANIFEST_B64, encoding: "base64" });
    }
    return j({ ...f, content: Buffer.from("file-content-of-" + f.name).toString("base64"), encoding: "base64" });
  }
  const cp = u.match(/\/commits\?path=([^&]+)&/);
  if (cp && method === "GET") {
    const p = decodeURIComponent(cp[1]);
    return j([{ commit: { committer: { date: COMMIT_TIMES[p] || "2026-10-18T08:00:00Z" } } }]);
  }
  // raw 代理上游（重命名读回文件内容走这里）
  const raw = u.match(/^https:\/\/raw\.githubusercontent\.com\/leiyihan-ren\/Blog\/main\/(drive\/.+)$/);
  if (raw && method === "GET") {
    return new Response("file-content-of-" + raw[1].split("/").pop(), { status: 200, headers: rl });
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
    }
    return j({ content: { sha: "sha-new" }, commit: { sha: "c1" } }, 201);
  }
  if (u.includes("/contents/drive/") && method === "DELETE") {
    if (ghDrive.failDelete) return j({ message: "simulated delete failure" }, 500);
    const body = JSON.parse(init.body);
    // worker→GitHub 的 DELETE body 只带 sha；用 sha 反查路径记录（前端不发 __path）
    const idx = ghDrive.files.findIndex((x) => x.sha === body.sha);
    ghDrive.delBodies.push({ path: idx >= 0 ? ghDrive.files[idx].path : "", sha: body.sha || "" });
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

const API_PORT = 8615;
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

  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 等列表稳定：加载态收起 + 行数连续 2 次采样一致（排除仍有 loadList 在飞行中）
  const waitStableRows = async () => {
    let prev = -1, same = 0;
    for (let i = 0; i < 50; i++) {
      const loading = await page.evaluate(() => {
        const ls = document.querySelector("#loadingState");
        return !!ls && ls.hidden === false;
      });
      const n = await page.locator("#fileTbody tr").count();
      if (!loading && n === prev) { if (++same >= 2) return n; } else { same = 0; }
      prev = n;
      await sleep(120);
    }
    return prev;
  };
  const firstRowName = () => page.evaluate(() => {
    const tr = document.querySelector("#fileTbody tr");
    return tr ? (tr.querySelector(".f-name a").textContent || "").replace(" 🧩", "") : null;
  });

  try {
    console.log("== E 组：v7.3 网盘高级进化 ==");

    await page.goto(`http://127.0.0.1:${WEB_PORT}/drive.html`);
    await page.waitForSelector("#pinModal.show", { timeout: 5000 });
    await page.fill("#pinInput", DRIVE_PIN);
    await page.click("#btnPinOk");
    await page.waitForSelector("#fileTable:not([hidden])", { timeout: 8000 });

    // E1 列表渲染：3 小文件 + 1 大文件 manifest 条目
    const rowCount = await page.locator("#fileTbody tr").count();
    check("E1a 渲染 4 行（含 manifest 大文件）", rowCount === 4, `rows=${rowCount}`);
    const hasChunked = await page.evaluate(() =>
      [...document.querySelectorAll("#fileTbody tr")].some((tr) => (tr.textContent || "").includes("🧩")));
    check("E1b 大文件行带 🧩 标识", hasChunked);

    // E2 默认排序：上传时间倒序（note.md 10-22 最新 → 第一）
    const firstName = await firstRowName();
    check("E2 默认时间倒序 → note.md 在第一行", firstName === "note.md", String(firstName));

    // E3 按大小排序：big.bin（manifest 20MB）最大 → 第一；再点一次翻转 → hello.txt 12 最小
    await page.click('.sort-btn[data-sort="size"]');
    await sleep(120);
    let n1 = await firstRowName();
    check("E3a 按大小降序 → big.bin 在第一行", n1 === "big.bin", String(n1));
    await page.click('.sort-btn[data-sort="size"]');
    await sleep(120);
    let n2 = await firstRowName();
    check("E3b 再点大小翻转升序 → hello.txt 在第一行", n2 === "hello.txt", String(n2));

    // E4 按名称排序：字典序 big.bin < hello.txt → big.bin 第一
    await page.click('.sort-btn[data-sort="name"]');
    await sleep(120);
    let n3 = await firstRowName();
    check("E4 按名称升序 → big.bin 在第一行", n3 === "big.bin", String(n3));

    // E5 搜索
    await page.fill("#fileSearch", "note");
    await page.waitForFunction(() => document.querySelectorAll("#fileTbody tr").length === 1, null, { timeout: 8000, polling: 100 });
    check("E5a 搜索 note → 仅 1 行", true);
    await page.fill("#fileSearch", "zzz-no-match");
    await page.waitForFunction(() => !document.querySelector("#fileTable") || document.querySelector("#fileTable").hidden, null, { timeout: 8000, polling: 100 });
    const emptyVisible = await page.isVisible("#emptyState");
    const emptyText = await page.textContent("#emptyState");
    check("E5b 搜索无结果 → 空态可见且文案可操作", emptyVisible && /没有匹配/.test(emptyText), emptyText);
    await page.fill("#fileSearch", "");
    await page.waitForFunction(() => document.querySelectorAll("#fileTbody tr").length === 4, null, { timeout: 8000, polling: 100 });
    check("E5c 清空搜索 → 恢复 4 行", true);

    // E6 重命名小文件（hello.txt → renamed.txt）
    const putBefore = ghDrive.putBodies.length;
    const delBefore = ghDrive.delBodies.length;
    await page.click('#fileTbody tr[data-path="drive/hello.txt"] .rn');
    await page.waitForSelector("#renameModal.show", { timeout: 8000 });
    check("E6a 重命名模态弹出", true);
    await page.fill("#renameInput", "renamed.txt");
    await page.click("#btnRenameOk");
    // 等待列表刷新出新文件名（读回→上传→删旧→loadList 全链路落地）
    await page.waitForFunction(
      () => [...document.querySelectorAll("#fileTbody tr")].some((tr) => (tr.querySelector(".f-name a").textContent || "").includes("renamed.txt")),
      null,
      { timeout: 10000, polling: 100 }
    );
    check("E6b 重命名 → 新路径上传", ghDrive.putBodies.length > putBefore && ghDrive.putBodies[ghDrive.putBodies.length - 1].path === "drive/renamed.txt", JSON.stringify(ghDrive.putBodies[ghDrive.putBodies.length - 1] && ghDrive.putBodies[ghDrive.putBodies.length - 1].path));
    check("E6c 重命名 → 旧路径删除", ghDrive.delBodies.length > delBefore && ghDrive.delBodies[ghDrive.delBodies.length - 1].path === "drive/hello.txt", JSON.stringify(ghDrive.delBodies[ghDrive.delBodies.length - 1] && ghDrive.delBodies[ghDrive.delBodies.length - 1].path));
    check("E6d 上传内容为 Base64", /^[A-Za-z0-9+/\s]+=*$/.test(ghDrive.putBodies[ghDrive.putBodies.length - 1].body.content || ""), "");

    // E7 大文件重命名按钮禁用
    const bigRn = await page.evaluate(() => {
      const tr = [...document.querySelectorAll("#fileTbody tr")].find((t) => (t.textContent || "").includes("🧩"));
      const btn = tr && tr.querySelector(".rn");
      return btn ? { disabled: btn.disabled, title: btn.title } : null;
    });
    check("E7 大文件重命名按钮禁用 + 有说明", !!bigRn && bigRn.disabled === true && /大文件/.test(bigRn.title || ""), JSON.stringify(bigRn));

    // E8 乐观删除回滚：DELETE 500 → 行即时移除后恢复 + 错误提示
    ghDrive.failDelete = true;
    // 基线取样前先等列表稳定：E6 重命名末尾的 loadList() 是「异步整表重绘」，
    // CI 慢机器上若在其落地前采样，总行数基线会失效 → 乐观删除后永远不等于 n-1（历史 flake 根因）
    const rowsBeforeDel = await waitStableRows();
    await page.waitForSelector('#fileTbody tr[data-path="drive/note.md"]', { timeout: 8000 });
    await page.click('#fileTbody tr[data-path="drive/note.md"] .del');
    await page.waitForSelector("#confirmModal.show", { timeout: 8000 });
    await page.click("#btnConfirmDel");
    // 乐观移除：判据用「目标行消失」而非总行数，避免被并发 loadList 重绘干扰
    // polling 显式设为定时轮询：headless CI 上 rAF 可能因负载长时间不触发
    await page.waitForFunction(
      () => !document.querySelector('#fileTbody tr[data-path="drive/note.md"]'),
      null,
      { timeout: 8000, polling: 50 }
    );
    check("E8a 乐观删除 → 行即时移除", true);
    // 失败回滚：目标行恢复
    await page.waitForFunction(
      () => !!document.querySelector('#fileTbody tr[data-path="drive/note.md"]'),
      null,
      { timeout: 8000, polling: 100 }
    );
    const rowsAfterRollback = await page.locator("#fileTbody tr").count();
    check("E8b API 失败 → 行回滚恢复", rowsAfterRollback === rowsBeforeDel, `回滚后=${rowsAfterRollback} 期望=${rowsBeforeDel}`);
    const toastText = await page.textContent("#toast");
    check("E8c 回滚后有错误提示", /删除失败|已恢复显示/.test(toastText || ""), toastText);
    ghDrive.failDelete = false;

    // E9 上传完成 → 队列分组 → 清除已完成（只清面板，文件不动）
    await page.setInputFiles("#fileInput", {
      name: "evo-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("v7.3 evolution test"),
    });
    await page.waitForSelector(".up-item.done", { timeout: 15000 });
    const groupInfo = await page.evaluate(() => {
      const heads = [...document.querySelectorAll(".up-group-head")].map((h) => h.textContent || "");
      return {
        heads,
        groupCount: heads.length,
        itemsAreNotHeads: document.querySelectorAll(".up-item").length === 1,
        lastHeadIsDone: heads.length > 0 && /已完成/.test(heads[heads.length - 1]),
        clearBtn: !!document.querySelector("#upGlobalBtns .up-cancel"),
      };
    });
    check("E9a 队列分组渲染（含已完成组头）", groupInfo.lastHeadIsDone, JSON.stringify(groupInfo.heads));
    check("E9b 分组头不占用 up-item 类", groupInfo.itemsAreNotHeads);
    check("E9c 全局按钮区有「清除已完成」", groupInfo.clearBtn);
    const rowsBeforeClear = await page.locator("#fileTbody tr").count();
    await page.click("#upGlobalBtns .up-cancel");
    await page.waitForFunction(() => document.querySelector("#uploadPanel").hidden, null, { timeout: 8000, polling: 100 });
    check("E9d 清除已完成 → 队列面板收起", true);
    await sleep(300);
    const rowsAfterClear = await page.locator("#fileTbody tr").count();
    check("E9e 清除已完成不动云端文件（列表行不变）", rowsAfterClear === rowsBeforeClear, `${rowsBeforeClear} → ${rowsAfterClear}`);

    // E10 队列空态时面板隐藏
    check("E10 队列清空后 uploadPanel 隐藏", await page.evaluate(() => document.querySelector("#uploadPanel").hidden));
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
