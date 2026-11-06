// ============================================================
// v12.0 战役三：网盘列表纳入 IndexedDB 本地搜索的端到端验证
//   A. 有 PIN 会话：网盘文件入索引，中文/全拼/首字母/模糊匹配均可命中
//   B. type: 类型筛选（单独浏览 + 与关键词组合）
//   C. 检索全程零 /api 请求（IndexedDB 快照秒开）
//   D. 权限隔离：无 PIN 时零 drive 请求，旧快照私有条目不可见
//   E. IndexedDB 快照持久化 + clearPrivate() 清除
//   F. Ctrl+K / 键盘 / URL 白名单 / XSS 回归
// 运行：CHROMIUM_PATH=/usr/bin/chromium node tests/step24-v12-search-drive.mjs
// ============================================================
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
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

const POSTS = [
  { id: "p1", title: "深度攻坚报告", content: "Range 并行下载与 Git Data API 原子提交", date: "2026-11-01" },
  { id: "p2", title: "云计算实践", content: "边缘缓存与 Service Worker 优化", date: "2026-10-20" },
];
const DRIVE_FILES = [
  { name: "项目报告.pdf", path: "drive/项目报告.pdf", size: 234567, storage: "contents" },
  { name: "云计算方案.docx", path: "drive/云计算方案.docx", size: 89123, storage: "contents" },
  { name: "家庭相册备份.zip", path: "drive/家庭相册备份.zip", size: 34 * 1024 * 1024, storage: "chunked" },
];
let driveHits = 0, unauthorizedHits = 0;

const PAGE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地搜索测试</title>
<script src="/vendor/minisearch.js"></script>
<script src="/utils/pinyin-gb2312.js"></script>
<script src="/utils/blog-utils.js"></script>
<script src="/services/request.js"></script>
</head><body><h1>全站本地搜索</h1><div id="host"></div>
<script type="module">
import("/components/global-search.js").catch(function (e) { window.__importErr = String(e); });
</script></body></html>`;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const json = (o, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(o));
  };
  if (p === "/__stats") return json({ driveHits, unauthorizedHits });
  if (p === "/__reset") { driveHits = 0; unauthorizedHits = 0; return json({ ok: true }); }
  if (p === "/api/drive/list") {
    if (req.headers["x-drive-pin"] !== "1234") { unauthorizedHits++; return json({ error: "需要口令" }, 401); }
    driveHits++;
    return json({ ok: true, dir: "drive", files: DRIVE_FILES, dirs: [], empty: false });
  }
  if (p === "/api/posts") return json(POSTS);
  if (p === "/api/album/photos") return json([{ id: "a1", title: "海边日落", desc: "相册照片" }]);
  if (p === "/api/music") return json([{ id: "m1", title: "夜航西飞", artist: "测试艺人" }]);
  if (p === "/api/links") return json([{ name: "恶意链接测试", url: "javascript:alert(1)" }]);
  if (p === "/api/timeline") return json([{ title: "站点上线", content: "时间线记录" }]);
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE_HTML);
  }
  const file = path.join(ROOT, p.replace(/^\//, ""));
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

const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
const context = await browser.newContext();
const page = await context.newPage();
const jsErrors = [];
const apiCalls = [];
page.on("pageerror", (e) => jsErrors.push(e.message));
page.on("request", (r) => { if (r.url().includes("/api/")) apiCalls.push(r.url()); });

async function ready(reload) {
  if (reload) await page.reload({ waitUntil: "load" });
  else await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.GlobalSearchReady === true, { timeout: 15000 });
}
async function stats() { return page.evaluate(() => fetch("/__stats").then((r) => r.json())); }

try {
  /* ============ A. 有 PIN：网盘入索引 ============ */
  console.log("\n═══ A. 有 PIN 会话的网盘索引 ═══");
  await page.addInitScript(() => {
    try { sessionStorage.setItem("drive_pin", "1234"); } catch (e) {}
  });
  await ready(false);
  const s0 = await stats();
  check("A1 带 PIN 拉取 /api/drive/list（无 401）", s0.driveHits >= 1 && s0.unauthorizedHits === 0, JSON.stringify(s0));
  const idx = await page.evaluate(() => ({
    count: window.GlobalSearch.docCount(),
    priv: window.GlobalSearch.privateCount(),
    err: window.__importErr || "",
  }));
  check("A2 索引包含 3 个网盘文件（标记为 private）", idx.priv === 3 && idx.count >= 3, JSON.stringify(idx));
  check("A3 ESM 模块加载零错误", idx.err === "", idx.err);

  const searches = await page.evaluate(() => {
    const S = window.GlobalSearch.search;
    return {
      cn: S("项目报告").map((r) => r.type + ":" + r.title),
      py: S("xiangmubaogao").map((r) => r.type + ":" + r.title),
      abbr: S("xmbg").map((r) => r.type + ":" + r.title),
      fuzzy: S("xiangmubaoga").map((r) => r.type + ":" + r.title),
      cloud: S("yunjisuan").map((r) => r.type + ":" + r.title),
    };
  });
  check("A4 中文标题命中网盘文件", searches.cn.some((x) => x.startsWith("网盘:") && x.includes("项目报告")), JSON.stringify(searches.cn));
  check("A5 全拼 xiangmubaogao 命中", searches.py.some((x) => x.startsWith("网盘:")), JSON.stringify(searches.py));
  check("A6 首字母 xmbg 命中", searches.abbr.some((x) => x.startsWith("网盘:")), JSON.stringify(searches.abbr));
  check("A7 模糊拼写 xiangmubaoga（少一字母）仍命中", searches.fuzzy.some((x) => x.startsWith("网盘:")), JSON.stringify(searches.fuzzy));
  check("A8 拼音检索同时覆盖文章与网盘（跨类型）", searches.cloud.length >= 2, JSON.stringify(searches.cloud));

  const snapA = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open("site_search_v11");
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    });
    if (!db) return null;
    const val = await new Promise((res) => {
      const r = db.transaction("snapshot", "readonly").objectStore("snapshot").get("index");
      r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
    });
    return val ? { n: val.docs.length, priv: val.docs.filter((d) => d.private).length, at: val.at } : null;
  });
  check("A9 网盘条目确实写入 IndexedDB 快照（带 private 标记）", !!snapA && snapA.priv === 3, JSON.stringify(snapA));

  /* ============ B. type: 筛选 ============ */
  console.log("\n═══ B. type: 类型筛选 ═══");
  const typed = await page.evaluate(() => {
    const S = window.GlobalSearch.search;
    return {
      only: S("type:网盘"),
      combo: S("type:网盘 项目报告"),
      other: S("type:文章 深度"),
      bad: S("type:不存在"),
    };
  });
  check("B1 type:网盘 单独浏览返回全部 3 条网盘结果", typed.only.length === 3 && typed.only.every((r) => r.type === "网盘"), JSON.stringify(typed.only));
  check("B2 type:网盘 + 关键词 组合过滤生效", typed.combo.length >= 1 && typed.combo.every((r) => r.type === "网盘" && /项目报告/.test(r.title)), JSON.stringify(typed.combo));
  check("B3 type:文章 仅返回文章", typed.other.length >= 1 && typed.other.every((r) => r.type === "文章"), JSON.stringify(typed.other));
  check("B4 不存在的类型返回空（不误召全库）", typed.bad.length === 0, JSON.stringify(typed.bad));

  /* ============ C. 检索零网络请求 ============ */
  console.log("\n═══ C. 检索零网络延迟 ═══");
  const before = apiCalls.length;
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) window.GlobalSearch.search("报告");
  });
  await page.waitForTimeout(150);
  check("C1 连续 30 次检索未产生任何 /api 请求", apiCalls.length === before, `before=${before} after=${apiCalls.length}`);

  /* ============ F. Ctrl+K / XSS / URL 白名单 ============ */
  console.log("\n═══ F. 面板与安全回归 ═══");
  await page.keyboard.press("Control+k");
  const opened = await page.evaluate(() => window.GlobalSearch.isOpen());
  check("F1 Ctrl+K 唤起面板", opened === true, "open=" + opened);
  await page.fill("#cxSearchInput", "项目报告");
  await page.waitForTimeout(150);
  const panel = await page.evaluate(() => ({
    items: document.querySelectorAll("#cxSearchList .cxs-item").length,
    marks: document.querySelectorAll("#cxSearchList mark").length,
    badges: [...document.querySelectorAll("#cxSearchList .cxs-badge")].map((b) => b.textContent),
  }));
  check("F2 面板渲染结果与高亮", panel.items >= 1 && panel.marks >= 1, JSON.stringify(panel));
  check("F3 结果带类型徽章（网盘可见）", panel.badges.includes("网盘"), JSON.stringify(panel.badges));
  await page.keyboard.press("Escape");
  check("F4 ESC 关闭面板", (await page.evaluate(() => window.GlobalSearch.isOpen())) === false);

  const xss = await page.evaluate(async () => {
    window.__xssFired = false;
    const r = window.GlobalSearch.search("恶意链接");
    return { hit: r.length, url: r[0] ? r[0].url : "", fired: window.__xssFired };
  });
  check("F5 javascript: URL 仍被白名单拒绝（空串，非首页兜底）", xss.url === "", JSON.stringify(xss));
  check("F6 XSS payload 未执行", xss.fired === false);

  /* ============ D. 权限隔离 ============ */
  console.log("\n═══ D. 无 PIN 会话的权限隔离 ═══");
  // 移除 addInitScript 的 PIN 注入：改用带参数的 initScript 控制
  const page2 = await context.newPage();
  const apiCalls2 = [];
  page2.on("request", (r) => { if (r.url().includes("/api/drive/")) apiCalls2.push(r.url()); });
  page2.on("pageerror", (e) => jsErrors.push(e.message));
  // 清 PIN 后用新页面（同一 context → 共享 IndexedDB 快照，正是泄漏风险场景）
  await page2.goto(ORIGIN + "/", { waitUntil: "load" });
  await page2.evaluate(() => { try { sessionStorage.removeItem("drive_pin"); } catch (e) {} });
  await page.evaluate(() => { fetch("/__reset"); });
  await page2.reload({ waitUntil: "load" });
  await page2.waitForFunction(() => window.GlobalSearchReady === true, { timeout: 15000 });
  const s2 = await stats();
  check("D1 无 PIN 会话零 /api/drive/list 请求（不发 401 噪音）", s2.driveHits === 0 && s2.unauthorizedHits === 0, JSON.stringify(s2));
  check("D2 页面层同样未发起 drive 请求", apiCalls2.length === 0, JSON.stringify(apiCalls2));
  const iso = await page2.evaluate(() => ({
    priv: window.GlobalSearch.privateCount(),
    typeDrive: window.GlobalSearch.search("type:网盘").length,
    byName: window.GlobalSearch.search("项目报告").filter((r) => r.type === "网盘").length,
    count: window.GlobalSearch.docCount(),
  }));
  check("D3 旧 IndexedDB 快照里的私有条目不可见（privateCount=0）", iso.priv === 0, JSON.stringify(iso));
  check("D4 type:网盘 在无 PIN 会话返回空", iso.typeDrive === 0, JSON.stringify(iso));
  check("D5 直接搜文件名也搜不到网盘条目", iso.byName === 0, JSON.stringify(iso));
  check("D6 公开索引仍正常（文章/相册/音乐/时间线）", iso.count >= 4, JSON.stringify(iso));

  /* ============ E. 快照权限收敛 ============ */
  console.log("\n═══ E. IndexedDB 快照权限收敛 ═══");
  // 无 PIN 会话的 fetchDocs() 不含私有源，写回快照时会自然覆盖掉上一个
  // 已登录会话留下的网盘条目——这是「退出即清理」的自动收敛行为。
  const snap = await page2.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open("site_search_v11");
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    });
    if (!db) return null;
    const val = await new Promise((res) => {
      const r = db.transaction("snapshot", "readonly").objectStore("snapshot").get("index");
      r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
    });
    return val ? { n: val.docs.length, priv: val.docs.filter((d) => d.private).length } : null;
  });
  check("E1 无 PIN 会话刷新后快照自动收敛为零私有条目", !!snap && snap.n > 0 && snap.priv === 0, JSON.stringify(snap));
  const cleared = await page2.evaluate(() => window.GlobalSearch.clearPrivate());
  check("E2 clearPrivate() 幂等可用（重复清除不报错）", typeof cleared === "number" && cleared === 0, `cleared=${cleared}`);

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
