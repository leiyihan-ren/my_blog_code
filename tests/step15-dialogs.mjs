// ============================================================
// v7.3 步骤 5：视觉微交互打磨（全局对话框替代原生 confirm/prompt）
//   D 组：对话框基建（confirmDialog 确认/取消/Esc、promptDialog
//         输入/取消/空输入、单例复用不叠加）
//   E 组：admin 删除文章走 confirmDialog 模态（确认删 / 取消留）
//   F 组：静态扫描——全站源码无原生 confirm(/prompt( 残留
// 运行：node tests/step15-dialogs.mjs
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const worker = (await import(pathToFileURL(path.join(ROOT, "_worker.js")).href)).default;
// 浏览器启动参数统一走 _helpers（优先使用 CHROMIUM_PATH 指定的可执行文件）
const { CHROMIUM_LAUNCH_OPTIONS } = await import("./_helpers.mjs");

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

// 测试专用口令（v8.0 起 Worker 不再回退硬编码口令，必须同步注入 env.ADMIN_PASSWORD，
// 否则登录接口直接 500）。此处刻意使用与任何环境都不同的测试值，避免误用真实凭据。
const ADMIN_PWD = "test-admin-pwd-v8";
const CTX = { waitUntil: () => {} };
const sharedKV = makeKV();
const STATIC_PORT = 8901;
const API_PORT = 8605;

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
      { SITE_DATA: sharedKV, GITHUB_TOKEN: "gh-test", ADMIN_PASSWORD: ADMIN_PWD },
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
    res.writeHead(500); res.end(String(e));
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

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
};

let browser = null;
try {
  const { chromium } = await import(
    pathToFileURL(path.join(ROOT, "node_modules", "playwright", "index.mjs")).href
  );
  browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));

  // ============================================================
  console.log("== D 组：对话框基建（common.js confirmDialog/promptDialog） ==");
  // ============================================================
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/pages/index.html`, { waitUntil: "domcontentloaded" });

  // D1 确认 → true
  await page.evaluate(() => { window.__r = window.confirmDialog({ title: "t", message: "m", confirmText: "删", danger: true }); });
  await page.waitForSelector("#cx-dialog.show", { timeout: 3000 });
  const d1Title = await page.textContent("#cx-dialog h3");
  const d1Btn = await page.textContent("#cx-dialog .cx-btn-primary");
  const d1Danger = await page.getAttribute("#cx-dialog .cx-btn-primary", "class");
  check("D1a confirmDialog 渲染标题/确认按钮/危险样式",
    d1Title === "t" && d1Btn === "删" && /cx-btn-danger/.test(d1Danger || ""), `${d1Title} / ${d1Btn} / ${d1Danger}`);
  await page.click("#cx-dialog .cx-btn-primary");
  check("D1b 点确认 → resolve true", (await page.evaluate(() => window.__r)) === true);

  // D2 取消 → false
  await page.evaluate(() => { window.__r = window.confirmDialog({ title: "t2", message: "m2" }); });
  await page.waitForSelector("#cx-dialog.show", { timeout: 3000 });
  await page.click("#cx-dialog .cx-btn:not(.cx-btn-primary)");
  check("D2 点取消 → resolve false", (await page.evaluate(() => window.__r)) === false);

  // D3 Esc → false
  await page.evaluate(() => { window.__r = window.confirmDialog({ title: "t3", message: "m3" }); });
  await page.waitForSelector("#cx-dialog.show", { timeout: 3000 });
  await page.keyboard.press("Escape");
  check("D3 Esc → resolve false", (await page.evaluate(() => window.__r)) === false);

  // D4 prompt 输入 → 字符串
  await page.evaluate(() => { window.__r = window.promptDialog({ title: "昵", message: "输入昵称", defaultValue: "旧", maxLength: 12 }); });
  await page.waitForSelector("#cx-dialog.show", { timeout: 3000 });
  const d4Val = await page.inputValue("#cx-dialog .cx-input");
  await page.fill("#cx-dialog .cx-input", "新昵称");
  await page.click("#cx-dialog .cx-btn-primary");
  check("D4 promptDialog 输入 → resolve 字符串", (await page.evaluate(() => window.__r)) === "新昵称" && d4Val === "旧", String(await page.evaluate(() => window.__r)));

  // D5 prompt Esc → null
  await page.evaluate(() => { window.__r = window.promptDialog({ title: "昵2", message: "再输入" }); });
  await page.waitForSelector("#cx-dialog.show", { timeout: 3000 });
  await page.keyboard.press("Escape");
  check("D5 promptDialog Esc → resolve null", (await page.evaluate(() => window.__r)) === null);

  // D6 prompt 空输入 → null（按取消处理）
  await page.evaluate(() => { window.__r = window.promptDialog({ title: "昵3", message: "空输入" }); });
  await page.waitForSelector("#cx-dialog.show", { timeout: 3000 });
  await page.click("#cx-dialog .cx-btn-primary");
  check("D6 promptDialog 空输入 → resolve null", (await page.evaluate(() => window.__r)) === null);

  // D7 单例复用：不叠加 DOM
  await page.evaluate(() => { window.confirmDialog({ title: "a", message: "1" }); window.confirmDialog({ title: "b", message: "2" }); });
  await page.waitForTimeout(200);
  const dlgCount = await page.evaluate(() => document.querySelectorAll("#cx-dialog").length);
  const dlgLast = await page.textContent("#cx-dialog h3");
  check("D7 连续两次调用 → 仅一个对话框实例（最新）", dlgCount === 1 && dlgLast === "b", `count=${dlgCount} last=${dlgLast}`);
  await page.keyboard.press("Escape");

  // ============================================================
  console.log("== E 组：admin 删除走 confirmDialog 模态 ==");
  // ============================================================
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/pages/admin.html`, { waitUntil: "domcontentloaded" });
  await page.fill("#password", ADMIN_PWD);
  await page.click("#login-page .btn-primary");
  await page.waitForSelector("#admin-page:not([style*='none'])", { timeout: 10000 });
  check("E0 登录管理后台", true);

  // 经 UI 发布两篇文章（API 直写不进已加载的列表，与真实用户路径一致）
  const publish = async (title) => {
    await page.click("button[onclick='openPostModal()']");
    await page.waitForFunction(() => document.getElementById("post-modal").classList.contains("active"), null, { timeout: 5000 });
    await page.fill("#post-title", title);
    await page.fill("#post-content", `${title}的正文内容`);
    await page.locator("#post-modal .btn-row .btn-primary").click();
    await page.waitForFunction(() => !document.getElementById("post-modal").classList.contains("active"), null, { timeout: 15000 });
    await page.waitForTimeout(400);
  };
  await page.click("button[onclick=\"switchTab('posts')\"]");
  await publish("模态删除保留篇");
  await publish("模态删除确认篇");
  await page.waitForFunction(() => document.querySelectorAll("#posts-list .list-item").length >= 2, null, { timeout: 8000 });

  // E1 取消分支：点删除 → 模态 → 取消 → 文章还在
  await page.evaluate(() => {
    const items = [...document.querySelectorAll("#posts-list .list-item")];
    const target = items.find((el) => el.querySelector(".list-item-title").textContent.includes("模态删除保留篇"));
    target.querySelector(".btn-delete-post").click();
  });
  await page.waitForSelector("#cx-dialog.show", { timeout: 5000 });
  const e1Msg = await page.textContent("#cx-dialog .cx-msg");
  check("E1a 删除弹出 confirmDialog 且文案正确", /确定要删除这篇文章吗/.test(e1Msg || ""), e1Msg);
  await page.click("#cx-dialog .cx-btn:not(.cx-btn-primary)");
  await page.waitForTimeout(600);
  const stillThere = await page.evaluate(() =>
    [...document.querySelectorAll("#posts-list .list-item-title")].some((el) => el.textContent.includes("模态删除保留篇")));
  check("E1b 点取消 → 文章保留", stillThere);

  // E2 确认分支：点删除 → 模态 → 确认 → 文章消失
  await page.evaluate(() => {
    const items = [...document.querySelectorAll("#posts-list .list-item")];
    const target = items.find((el) => el.querySelector(".list-item-title").textContent.includes("模态删除确认篇"));
    target.querySelector(".btn-delete-post").click();
  });
  await page.waitForSelector("#cx-dialog.show", { timeout: 5000 });
  await page.click("#cx-dialog .cx-btn-primary");
  await page.waitForFunction(
    () => ![...document.querySelectorAll("#posts-list .list-item-title")].some((el) => el.textContent.includes("模态删除确认篇")),
    null, { timeout: 10000 }
  );
  const gone = await page.evaluate(() =>
    [...document.querySelectorAll("#posts-list .list-item-title")].some((el) => el.textContent.includes("模态删除确认篇")));
  check("E2 点确认 → 文章删除且列表同步", gone === false);

  // ============================================================
  console.log("== F 组：静态扫描（无原生 confirm/prompt 残留） ==");
  // ============================================================
  const scanTargets = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      // public/ build/ dist/ 均为构建同步产物（非源码），node_modules 依赖，tests 测试自身
      if (name === "node_modules" || name === "dist" || name === "build" || name === "public" || name === "tests" || name.startsWith(".")) continue;
      const fp = path.join(dir, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp);
      else if (/\.(html|js)$/.test(name)) scanTargets.push(fp);
    }
  };
  walk(ROOT);
  const nativeCalls = [];
  for (const fp of scanTargets) {
    const lines = fs.readFileSync(fp, "utf8").split("\n");
    let inBlock = false; // 块注释状态机：跨行 /* */ 内的文字不算调用
    lines.forEach((line, i) => {
      let code = line;
      if (inBlock) {
        const end = code.indexOf("*/");
        if (end === -1) return;
        code = code.slice(end + 2);
        inBlock = false;
      }
      for (;;) {
        const s = code.indexOf("/*");
        const l = code.indexOf("//");
        if (s === -1 && l === -1) break;
        if (s !== -1 && (l === -1 || s < l)) {
          const end = code.indexOf("*/", s + 2);
          if (end === -1) { code = code.slice(0, s); inBlock = true; break; }
          code = code.slice(0, s) + code.slice(end + 2);
        } else { code = code.slice(0, l); break; }
      }
      if (/(^|[^.\w])confirm\s*\(/.test(code) || /(^|[^.\w])prompt\s*\(/.test(code)) {
        nativeCalls.push(`${path.relative(ROOT, fp)}:${i + 1}`);
      }
    });
  }
  check("F1 全站源码无原生 confirm()/prompt() 调用", nativeCalls.length === 0, nativeCalls.join(" | "));

  check("D/E 组全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | "));
  await page.close();
} catch (e) {
  failed++;
  console.log("  ❌ 套件执行异常 →", e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  apiServer.close();
  staticServer.close();
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
