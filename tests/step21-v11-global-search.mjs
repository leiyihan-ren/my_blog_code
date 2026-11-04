// ============================================================
// v11.0 战役五：极速全站本地搜索 —— 端到端极限压测
// ------------------------------------------------------------
// 真实 Chromium + 真实 IndexedDB，验证：拼音表覆盖与转换、MiniSearch
// 中文/全拼/首字母/模糊检索、XSS 防线、Ctrl+K 面板与键盘导航、
// 零 /api 网络检索、IndexedDB 快照与 reload 秒开、URL 协议白名单。
// 端口 listen(0)，不与其它套件冲突。
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pw from "playwright";
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";

const { chromium } = pw;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const XSS = '<img src=x onerror="window.__xssFired=1">';
const DATA = {
  "/api/posts": [
    { id: "p1", title: "云计算深度攻坚", content: "# 标题\nRange 并行下载与 Git Data API 原子上传实战", date: "2026-11-01" },
    { id: "p2", title: "夜间算力优化笔记", content: "加载速度极限压榨、模板精修与安全加固", date: "2026-10-30" },
    { id: "p3", title: XSS, content: "恶意标题用于验证 textContent 防线", date: "2026-10-29" },
  ],
  "/api/links": [
    { name: "独立博客联盟", desc: "优质中文独立博客", url: "https://example.org" },
    { name: "恶意链接测试", desc: "javascript 协议应被 URL 白名单过滤", url: "javascript:window.__xssFired=1" },
  ],
  "/api/album/photos": [{ title: "海边日落", desc: "相册照片" }],
  "/api/music": [{ title: "夜航西飞", artist: "测试艺人" }],
  "/api/timeline": [{ title: "站点上线", content: "第一篇文章发布" }],
};
const TEST_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>search e2e</title></head><body>
<script src="/utils/common.js"></script>
</body></html>`;

let apiCalls = 0;
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/" || p === "/index.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(TEST_HTML); }
  if (DATA[p]) {
    apiCalls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(DATA[p]));
  }
  // 让 SW 注册自然失败（register().catch 会吞掉），不屏蔽
  // navigator.serviceWorker，避免破坏 common.js 的 "serviceWorker" in navigator 判断
  if (p === "/sw.js") { res.writeHead(404); return res.end("no sw"); }
  if (/^\/(post|album|timeline|blog|games|links|guestbook|index)\.html$/.test(p)) {
    res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><body>ok</body></html>");
  }
  const f = path.join(ROOT, p.replace(/^\//, ""));
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end("nf");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  ✅ " + n); }
  else { fail++; console.log("  ❌ " + n + (d ? " → " + d : "")); }
};

let browser;
try {
  browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForFunction(() => window.GlobalSearchReady === true, null, { timeout: 15000 });

  console.log("== 战役四/五：拼音表与索引 ==");
  const py = await page.evaluate(() => ({
    size: window.PinyinGB2312 && window.PinyinGB2312.size(),
    full: window.PinyinGB2312 && window.PinyinGB2312.full("云计算"),
    abbr: window.PinyinGB2312 && window.PinyinGB2312.abbr("云计算深度攻坚"),
    tok: window.PinyinGB2312 && window.PinyinGB2312.tokenize("云计算"),
  }));
  check("D1 拼音表覆盖 20902 字", py.size === 20902, "size=" + py.size);
  check("D2 全拼转换正确", py.full === "yunjisuan", py.full);
  check("D3 首字母缩写正确", py.abbr === "yjssdgj", py.abbr);
  check("D4 中文单字+bigram 分词", py.tok === "云 云计 计 计算 算", py.tok);
  check("D5 MiniSearch 已 vendor 化挂载（零 CDN）", await page.evaluate(() => typeof window.MiniSearch === "function"));
  const cnt = await page.evaluate(() => window.GlobalSearch.docCount());
  check("D6 索引已建立（含 5 类数据源）", cnt >= 7, "count=" + cnt);

  console.log("== 战役四/五：检索能力 ==");
  const s = (q) => page.evaluate((qq) => window.GlobalSearch.search(qq).map((r) => r.title), q);
  check("D7 中文前缀「云」命中云计算", (await s("云")).some((t) => t.includes("云计算")));
  check("D8 全拼「yunjisuan」命中", (await s("yunjisuan")).some((t) => t.includes("云计算")));
  check("D9 首字母「yjs」命中", (await s("yjs")).some((t) => t.includes("云计算")));
  check("D10 正文关键词「Range」命中", (await s("Range")).some((t) => t.includes("云计算")));
  check("D11 模糊拼写「yunjisua」容错", (await s("yunjisua")).some((t) => t.includes("云计算")));
  check("D12 友链数据源「联盟」命中", (await s("联盟")).length >= 1);
  check("D13 无结果返回空数组", (await s("zzzzqqqq不存在的词")).length === 0);
  check("D14 XSS payload 未被解析为可执行脚本", await page.evaluate(() => window.__xssFired === undefined));

  console.log("== 战役四/五：Ctrl+K 面板与交互 ==");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(250);
  check("D15 Ctrl+K 唤起面板", await page.evaluate(() => window.GlobalSearch.isOpen()));
  await page.fill("#cxSearchInput", "云计算");
  await page.waitForTimeout(200);
  const items = await page.locator("#cxSearchList .cxs-item").count();
  check("D16 输入后渲染结果项", items >= 1, "items=" + items);
  const htmlCheck = await page.evaluate(() => document.getElementById("cxSearchList").querySelectorAll("img").length);
  check("D17 结果列表无注入的 img 元素（textContent 防线）", htmlCheck === 0, "imgs=" + htmlCheck);
  check("D18 高亮使用 mark 节点而非 innerHTML", await page.evaluate(() => !!document.querySelector("#cxSearchList mark.cxs-mark")));

  const before = apiCalls;
  await page.fill("#cxSearchInput", "云计算");
  await page.waitForTimeout(150);
  await page.fill("#cxSearchInput", "夜间");
  await page.waitForTimeout(150);
  check("D19 检索全程零 /api 网络请求（纯本地）", apiCalls === before, `before=${before} after=${apiCalls}`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("D20 ESC 关闭面板", await page.evaluate(() => !window.GlobalSearch.isOpen()));

  console.log("== 战役四/五：IndexedDB 快照 ==");
  const snap = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open("site_search_v11", 1);
    r.onsuccess = () => {
      const q = r.result.transaction("snapshot", "readonly").objectStore("snapshot").get("index");
      q.onsuccess = () => resolve({ found: !!q.result, docs: q.result && q.result.docs ? q.result.docs.length : 0 });
      q.onerror = () => resolve({ found: false, docs: 0 });
    };
    r.onerror = () => resolve({ found: false, docs: 0 });
  }));
  check("D21 IndexedDB 已写入快照", snap.found, JSON.stringify(snap));
  check("D22 快照含完整文档", snap.docs >= 7, "docs=" + snap.docs);

  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.GlobalSearchReady === true, null, { timeout: 15000 });
  check("D23 二次加载从快照恢复索引", await page.evaluate(() => window.GlobalSearch.docCount() >= 7));
  check("D24 reload 后仍可拼音检索", (await s("yjs")).some((t) => t.includes("云计算")));

  console.log("== 战役五新增：键盘导航、快捷键与 URL 白名单 ==");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(200);
  await page.fill("#cxSearchInput", "恶意");
  await page.waitForTimeout(200);
  const navCount = await page.locator("#cxSearchList .cxs-item").count();
  const activeBefore = await page.evaluate(() => document.querySelector("#cxSearchList .cxs-item.active")?.dataset.idx);
  await page.keyboard.press("ArrowDown");
  const activeAfter = await page.evaluate(() => document.querySelector("#cxSearchList .cxs-item.active")?.dataset.idx);
  check("D25 ↓ 键切换选中项（多项结果时 0→1）",
    navCount >= 2 && activeBefore === "0" && activeAfter === "1",
    `items=${navCount} before=${activeBefore} after=${activeAfter}`);
  await page.keyboard.press("ArrowUp");
  check("D26 ↑ 键回到首项", (await page.evaluate(() => document.querySelector("#cxSearchList .cxs-item.active")?.dataset.idx)) === "0");

  await page.keyboard.press("Escape");
  // 测试页 body 无内容、高度为 0，Playwright 无法点击；直接让输入框失焦，
  // 使 document.activeElement 不再是 INPUT，从而走 "/" 快捷键分支
  await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
  await page.waitForTimeout(100);
  await page.keyboard.press("/");
  await page.waitForTimeout(200);
  check("D27 「/」快捷键唤起面板（焦点不在输入框）", await page.evaluate(() => window.GlobalSearch.isOpen()));

  await page.fill("#cxSearchInput", "恶意链接");
  await page.waitForTimeout(200);
  // common.js 的 SEO URL 规范化会把 "/" 归一成 "/index.html"，
  // 因此必须以「点击前的 path」为基线，不能硬编码 "/"
  const pathBefore = await page.evaluate(() => location.pathname);
  const dump = await page.evaluate(() => ({
    items: [...document.querySelectorAll("#cxSearchList .cxs-item")]
      .map((li) => ({ idx: li.dataset.idx, text: (li.textContent || "").trim().slice(0, 50) })),
    searched: window.GlobalSearch.search("恶意链接").map((r) => ({ title: r.title, url: r.url })),
  }));
  const evilItem = page.locator("#cxSearchList .cxs-item", { hasText: "恶意链接测试" });
  const evilExists = (await evilItem.count()) >= 1;
  if (evilExists) await evilItem.first().click();
  await page.waitForTimeout(200);
  const evilState = await page.evaluate(() => ({ fired: window.__xssFired, path: location.pathname }));
  check("D28 javascript: URL 被白名单拒绝（不执行、不导航）",
    evilExists && evilState.fired === undefined && evilState.path === pathBefore,
    `exists=${evilExists} before=${pathBefore} after=${evilState.path} fired=${evilState.fired} dump=${JSON.stringify(dump)}`);

  check("D29 全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | "));

  await ctx.close();
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
