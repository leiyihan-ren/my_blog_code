// ============================================================
// P0 修复验证：文章发布重复提交 + 删除失效（并发防护）
//   背景：连点「发布」曾产生 N 篇重复文章；连删曾因 KV 读-改-写
//   竞态「删不掉」（已删条目被旧读回写复活）。
//   修复：前端发布锁（按钮置灰+isPublishing）+ 后端写串行化
//   （withWriteLock）+ 同标题同内容 60s 防重（409）+ 删除
//   「取最新→删→写后校验→有限重试」。
// 本套件分两部分：
//   A 组：Node 直测 worker（API 级防重/删除重试/串行化）
//   B 组：Playwright 端到端（真实浏览器 50 连点发布 → 仅 1 篇；
//          UI 删除单篇 + 三篇重复文章删干净）
// 运行：node tests/step13-post-concurrency.mjs
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const worker = (await import(pathToFileURL(path.join(ROOT, "_worker.js")).href)).default;

/* ---------- mock KV（与既有套件一致；Map 直存，读己所写） ---------- */
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

const ADMIN_PWD = "Ly!2026@Secure#8848"; // 未设置 env.ADMIN_PASSWORD 时的兜底密码
const AUTH = { Authorization: `Bearer ${ADMIN_PWD}` };
const CTX = { waitUntil: () => {} };

/** 直连 worker 的文章 API 调用 */
async function callApi(method, urlPath, { body, auth = true, kv } = {}) {
  const headers = { "CF-Connecting-IP": "1.2.3.4" };
  if (auth) Object.assign(headers, AUTH);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const env = { SITE_DATA: kv, GITHUB_TOKEN: "gh-test" };
  const req = new Request(`https://blog.local${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, CTX);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json, text };
}

/* ---------- 断言工具 ---------- */
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
}

// ============================================================
// A 组：API 级并发防护（Node 直测 worker）
// ============================================================
console.log("== A 组：文章 API 并发防护（Node 直测 worker） ==");

// A1：50 次并发发布同一篇文章 → 只创建 1 篇，其余 409 拦截
{
  const kv = makeKV();
  const payload = {
    title: "P0 防重测试文章",
    content: "同一标题同一内容连点五十次，也只能存在一篇。",
    date: "2026-10-25",
    desc: "防重",
  };
  const results = await Promise.all(
    Array.from({ length: 50 }, () => callApi("POST", "/api/posts", { body: payload, kv }))
  );
  const created = results.filter((r) => r.status === 200 && r.json && r.json.success);
  const blocked = results.filter((r) => r.status === 409 && r.json && r.json.duplicate === true);
  check("A1a 50 连发仅 1 篇创建成功", created.length === 1, `created=${created.length}`);
  check("A1b 其余 49 次被 409 防重拦截", blocked.length === 49, `blocked=${blocked.length}`);

  const list = await callApi("GET", "/api/posts", { kv });
  const same = (list.json || []).filter((p) => p.title === payload.title);
  check("A1c 列表中该标题文章恰好 1 篇", same.length === 1, `got ${same.length}`);
  check("A1d 被拦截请求带回已发布文章 id", blocked.every((r) => typeof r.json.id === "string" && r.json.id.length > 0));
}

// A2：不同内容不受防重影响（防重不能误伤正常发布）
{
  const kv = makeKV();
  const base = { title: "正常发布", content: "内容甲", date: "2026-10-25" };
  const r1 = await callApi("POST", "/api/posts", { body: base, kv });
  const r2 = await callApi("POST", "/api/posts", { body: { ...base, content: "内容乙" }, kv });
  const r3 = await callApi("POST", "/api/posts", { body: { ...base, title: "另一篇" }, kv });
  check("A2a 首篇发布成功", r1.status === 200 && r1.json.success === true, `got ${r1.status}`);
  check("A2b 同标题不同内容可发布", r2.status === 200 && r2.json.success === true, `got ${r2.status}`);
  check("A2c 同内容不同标题可发布", r3.status === 200 && r3.json.success === true, `got ${r3.status}`);
  const list = await callApi("GET", "/api/posts", { kv });
  check("A2d 共 3 篇且无重复", (list.json || []).length === 3, `got ${(list.json || []).length}`);
}

// A3：编辑（带 id）重复保存不被防重误拦
{
  const kv = makeKV();
  const created = await callApi("POST", "/api/posts", {
    body: { title: "可编辑文章", content: "初始内容", date: "2026-10-25" }, kv,
  });
  const id = created.json.id;
  const e1 = await callApi("POST", "/api/posts", {
    body: { id, title: "可编辑文章", content: "初始内容", date: "2026-10-25" }, kv,
  });
  const e2 = await callApi("POST", "/api/posts", {
    body: { id, title: "可编辑文章（改）", content: "初始内容", date: "2026-10-25" }, kv,
  });
  check("A3a 同内容再次保存（编辑）不被拦截", e1.status === 200 && e1.json.success === true, `got ${e1.status}`);
  check("A3b 改标题保存成功", e2.status === 200 && e2.json.success === true, `got ${e2.status}`);
  const list = await callApi("GET", "/api/posts", { kv });
  check("A3c 仍只有 1 篇（未产生副本）", (list.json || []).length === 1, `got ${(list.json || []).length}`);
}

// A4：删除单篇文章 → 成功且列表同步（空列表时合并视图按设计回退默认欢迎文章，
// 故断言「被删文章彻底消失」而非「列表为空」）
{
  const kv = makeKV();
  const created = await callApi("POST", "/api/posts", {
    body: { title: "待删除", content: "一次性的内容", date: "2026-10-25" }, kv,
  });
  const del = await callApi("POST", `/api/post/delete/${created.json.id}`, { kv });
  check("A4a 删除返回成功", del.status === 200 && del.json.success === true, `got ${del.status}`);
  const list = await callApi("GET", "/api/posts", { kv });
  check("A4b 删除后该文章从列表消失", !(list.json || []).some((p) => p.id === created.json.id),
    JSON.stringify(list.json));
}

// A5：三篇重复文章（模拟事故现场：直接种子灌入）→ 3 次并发连删 → 删干净无复活
{
  const kv = makeKV({
    posts: JSON.stringify([
      { id: "p-dup-1", title: "重复文章", content: "一模一样的内容", date: "2026-10-25", desc: "" },
      { id: "p-dup-2", title: "重复文章", content: "一模一样的内容", date: "2026-10-25", desc: "" },
      { id: "p-dup-3", title: "重复文章", content: "一模一样的内容", date: "2026-10-25", desc: "" },
    ]),
  });
  // 并发连删三篇（旧代码在此场景下会因读-改-写竞态复活已删文章）
  const dels = await Promise.all([
    callApi("POST", "/api/post/delete/p-dup-1", { kv }),
    callApi("POST", "/api/post/delete/p-dup-2", { kv }),
    callApi("POST", "/api/post/delete/p-dup-3", { kv }),
  ]);
  check("A5a 三次并发删除全部成功", dels.every((r) => r.status === 200 && r.json.success === true),
    dels.map((r) => r.status).join(","));
  const list = await callApi("GET", "/api/posts", { kv });
  const dupLeft = (list.json || []).filter((p) => p.title === "重复文章");
  check("A5b 三篇重复文章删干净（无复活）", dupLeft.length === 0,
    `left=${dupLeft.length} ${JSON.stringify((list.json || []).map((p) => p.id))}`);

  // 同一 id 并发双删：第二次必须得到明确 404，绝不静默
  const kv2 = makeKV({
    posts: JSON.stringify([{ id: "p-x", title: "双删", content: "c", date: "2026-10-25", desc: "" }]),
  });
  const [d1, d2] = await Promise.all([
    callApi("POST", "/api/post/delete/p-x", { kv: kv2 }),
    callApi("POST", "/api/post/delete/p-x", { kv: kv2 }),
  ]);
  const oks = [d1, d2].filter((r) => r.status === 200).length;
  const notFounds = [d1, d2].filter((r) => r.status === 404).length;
  check("A5c 同 id 并发双删：1 成功 + 1 明确 404", oks === 1 && notFounds === 1,
    `ok=${oks} 404=${notFounds}`);
}

// A6：删除不存在的文章 → 明确 404（不静默失败）
{
  const kv = makeKV();
  const r = await callApi("POST", "/api/post/delete/p-nope", { kv });
  check("A6 删除不存在文章 → 404 明确报错", r.status === 404 && r.json && /不存在/.test(r.json.error || ""),
    `got ${r.status} ${r.text}`);
}

// A7：删完后立即重发同内容 → 防重窗口内仍被拦截（数据卫生）
{
  const kv = makeKV();
  const payload = { title: "删了再发", content: "同样的内容再发一次", date: "2026-10-25" };
  const c = await callApi("POST", "/api/posts", { body: payload, kv });
  await callApi("POST", `/api/post/delete/${c.json.id}`, { kv });
  const again = await callApi("POST", "/api/posts", { body: payload, kv });
  check("A7 删除后 60s 窗口内重发同内容 → 409 拦截", again.status === 409 && again.json.duplicate === true,
    `got ${again.status}`);
}

// ============================================================
// B 组：Playwright 端到端（真实浏览器 50 连点）
// ============================================================
console.log("== B 组：真实浏览器 50 连点发布（Playwright） ==");

const STATIC_PORT = 8899;
const API_PORT = 8602;

/* API 服务器：把 /api/* 转发给 worker（KV 在内存中，跨请求共享） */
const sharedKV = makeKV();
const apiServer = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://x");
    const headers = {};
    for (const k of Object.keys(req.headers)) headers[k] = req.headers[k];
    const init = { method: req.method, headers };
    if (req.method === "POST" || req.method === "PUT") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length) init.body = buf;
    }
    const resp = await worker.fetch(
      new Request(`http://127.0.0.1:${API_PORT}${parsed.pathname}${parsed.search}`, init),
      { SITE_DATA: sharedKV, GITHUB_TOKEN: "gh-test" },
      CTX
    );
    const body = Buffer.from(await resp.arrayBuffer());
    const outHeaders = {};
    resp.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(resp.status, outHeaders);
    return res.end(body);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: String(e) }));
  }
});

/* 静态服务器：托管页面，/api 代理到 API 服务器 */
const staticServer = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://x");
    const p = decodeURIComponent(parsed.pathname);
    if (p.startsWith("/api/")) {
      const resp = await fetch(`http://127.0.0.1:${API_PORT}${parsed.pathname}${parsed.search}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] || "application/json", authorization: req.headers.authorization || "" },
        body: req.method === "POST" ? await readBody(req) : undefined,
      });
      const body = Buffer.from(await resp.arrayBuffer());
      const outHeaders = {};
      resp.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(resp.status, outHeaders);
      return res.end(body);
    }
    const filePath = path.join(ROOT, p === "/" ? "pages/index.html" : p.replace(/^\//, ""));
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404); return res.end("nf");
    }
    const ext = path.extname(resolved);
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    return res.end(fs.readFileSync(resolved));
  } catch (e) {
    res.writeHead(500); return res.end(String(e));
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function listen(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}

await listen(apiServer, API_PORT);
await listen(staticServer, STATIC_PORT);
console.log(`  API :${API_PORT} / 静态 :${STATIC_PORT} 已启动`);

let browser = null;
try {
  const { chromium } = await import(
    pathToFileURL(path.join(ROOT, "node_modules", "playwright", "index.mjs")).href
  );
  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  // 删除操作的 confirm 确认框：统一自动接受（否则 Playwright 默认 dismiss，删除不执行）
  page.on("dialog", (d) => d.accept());

  // B0：登录管理后台
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/pages/admin.html`, { waitUntil: "domcontentloaded" });
  await page.fill("#password", ADMIN_PWD);
  await page.click("#login-page .btn-primary");
  await page.waitForSelector("#admin-page:not([style*='none'])", { timeout: 10000 });
  check("B0 登录成功进入后台", true);

  // B1：切到文章 tab，打开发布模态
  await page.click("button[onclick=\"switchTab('posts')\"]");
  await page.click("button[onclick='openPostModal()']");
  await page.waitForSelector("#post-modal.active", { timeout: 5000 });

  // B2：50 次浏览器级暴力连点「保存」→ 最终只应有 1 篇文章
  // 用 el.click() 同步循环（绕过 Playwright 行动性等待）：
  // 第一次点击进入 savePost，按钮同步置灰；后续 49 次点在禁用按钮上
  // 被浏览器直接吞掉——这正是线上用户连点的真实行为。
  await page.fill("#post-title", "浏览器连点测试");
  await page.fill("#post-content", "真实浏览器里连点五十次保存按钮。");
  const stateDuring = await page.evaluate(() => {
    const btn = document.querySelector("#post-modal .btn-row .btn-primary");
    btn.click();
    return { disabled: btn.disabled, text: btn.textContent };
  });
  check("B2a 点击瞬间按钮置灰并显示「正在发布…」",
    stateDuring.disabled === true && /正在发布/.test(stateDuring.text),
    JSON.stringify(stateDuring));
  await page.evaluate(() => {
    const btn = document.querySelector("#post-modal .btn-row .btn-primary");
    for (let i = 0; i < 50; i++) btn.click();
  });
  // 等请求彻底结束（模态关闭 + 按钮恢复可点）
  // 注意：模态关闭后 overlay 处于 CSS hidden 状态，不能用默认可见性断言，
  // 必须等 classList 移除 active
  await page.waitForFunction(
    () => !document.getElementById("post-modal").classList.contains("active"),
    null,
    { timeout: 20000 }
  );
  await page.waitForFunction(
    () => !document.querySelector("#post-modal .btn-row .btn-primary").disabled,
    null,
    { timeout: 10000 }
  );
  await page.waitForTimeout(500); // 等 loadPosts 渲染完成
  let itemCount = await page.evaluate(() => document.querySelectorAll("#posts-list .list-item").length);
  let titles = await page.evaluate(() =>
    [...document.querySelectorAll("#posts-list .list-item-title")].map((el) => el.textContent.trim())
  );
  // 注意：默认欢迎文章仅在 KV 为空时兜底展示；发布成功后列表就是纯新文章。
  // 连点 50 次必须只产生这 1 篇。
  check("B2b 50 连点后列表恰好 1 篇新文章", itemCount === 1, `got ${itemCount}`);
  check("B2c 新文章标题恰好出现 1 次", titles.filter((t) => t.includes("浏览器连点测试")).length === 1,
    titles.join(" | "));

  // B2d：绕过「禁用按钮」防护，直接同步调用 savePost() 三次 → isPublishing 锁兜底
  await page.click("button[onclick='openPostModal()']");
  await page.waitForFunction(
    () => document.getElementById("post-modal").classList.contains("active"),
    null,
    { timeout: 5000 }
  );
  await page.fill("#post-title", "函数级连调测试");
  await page.fill("#post-content", "直接同步调用 savePost 三次，锁必须兜住。");
  await page.evaluate(() => { savePost(); savePost(); savePost(); });
  await page.waitForFunction(
    () => !document.getElementById("post-modal").classList.contains("active"),
    null,
    { timeout: 20000 }
  );
  await page.waitForTimeout(500);
  itemCount = await page.evaluate(() => document.querySelectorAll("#posts-list .list-item").length);
  titles = await page.evaluate(() =>
    [...document.querySelectorAll("#posts-list .list-item-title")].map((el) => el.textContent.trim())
  );
  check("B2d 三次同步调用后共 2 篇且新文章仅 1 篇（isPublishing 锁生效）",
    itemCount === 2 && titles.filter((t) => t.includes("函数级连调测试")).length === 1,
    `total=${itemCount} titles=${titles.join(" | ")}`);

  // B3：UI 删除「浏览器连点测试」那篇 → 从列表消失（只剩函数级连调）
  // v7.3：admin 删除确认已从原生 confirm 迁至全局 confirmDialog 模态，
  // 删除流改为「点删除 → cx-dialog 出现 → 点确认按钮」（不再依赖 dialog 事件）
  await page.evaluate(() => {
    const items = [...document.querySelectorAll("#posts-list .list-item")];
    const target = items.find((el) => el.querySelector(".list-item-title").textContent.includes("浏览器连点测试"));
    target.querySelector(".btn-delete-post").click();
  });
  await page.waitForSelector("#cx-dialog.show", { timeout: 5000 });
  await page.click("#cx-dialog .cx-btn-primary");
  await page.waitForFunction(
    () => ![...document.querySelectorAll("#posts-list .list-item-title")].some((el) => el.textContent.includes("浏览器连点测试")),
    null,
    { timeout: 15000 }
  );
  const afterDelete = await page.evaluate(() =>
    [...document.querySelectorAll("#posts-list .list-item-title")].map((el) => el.textContent.trim())
  );
  check("B3 UI 删除单篇成功（confirmDialog 确认流）", !afterDelete.some((t) => t.includes("浏览器连点测试")), afterDelete.join(" | "));

  // B4：UI 删除交互完整体验——发布 1 篇 → 删除 → 列表回到 1 篇
  await page.click("button[onclick='openPostModal()']");
  await page.waitForFunction(
    () => document.getElementById("post-modal").classList.contains("active"),
    null,
    { timeout: 5000 }
  );
  await page.fill("#post-title", "UI 删除交互验证");
  await page.fill("#post-content", "验证删除按钮的加载态与成功提示。");
  await page.locator("#post-modal .btn-row .btn-primary").click();
  await page.waitForFunction(
    () => !document.getElementById("post-modal").classList.contains("active"),
    null,
    { timeout: 15000 }
  );
  await page.waitForTimeout(600);
  const beforeCount = await page.evaluate(() => document.querySelectorAll("#posts-list .list-item").length);
  check("B4a 发布 1 篇成功（UI，列表变 2 篇）", beforeCount === 2, `got ${beforeCount}`);

  // 点击删除 → confirmDialog 模态出现 → 点确认 → 等待列表回落
  await page.evaluate(() => {
    const items = [...document.querySelectorAll("#posts-list .list-item")];
    const target = items.find((el) => el.querySelector(".list-item-title").textContent.includes("UI 删除交互验证"));
    target.querySelector(".btn-delete-post").click();
  });
  await page.waitForSelector("#cx-dialog.show", { timeout: 5000 });
  await page.click("#cx-dialog .cx-btn-primary");
  await page.waitForFunction(
    () => document.querySelectorAll("#posts-list .list-item").length === 1,
    null,
    { timeout: 15000 }
  );
  check("B4b UI 删除后列表回到 1 篇", true);

  await page.close();
} catch (e) {
  failed++;
  console.log("  ❌ B 组执行异常 →", e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  apiServer.close();
  staticServer.close();
}

/* ---------- 汇总 ---------- */
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
