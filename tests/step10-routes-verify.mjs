// ============================================================
// v7.0 步骤 10：目录重构守护测试（路由重写 + 链接完整性）
//   场景（纯 Node，无浏览器，毫秒级）：
//   R1 路由表同步：_worker.js 内联 PAGE_REWRITES ≡ scripts/route-map.mjs
//   R2 Worker 重写行为：真实 worker + ASSETS mock
//      /drive.html → 200 云盘页；/ → 200 首页；/pages/drive.html 直通 200；
//      /post.html?id=x 查询串保留；/nope.html → 404；/api/* 仍走 API 派发
//   R3 静态资源不重写：/styles/common.css 原样服务
//   R4 全站链接完整性：10 个页面的全部本地引用 + SW 预缓存清单 + manifest
//      图标/start_url，逐一落盘存在性校验（搬迁漏改即红）
//   R5 SW 注册用绝对路径（/sw.js），scope 不被 pages/ 截断
//   R6 页面无相对本地引用（防止再次下沉目录时静默 404）
// 运行：node tests/step10-routes-verify.mjs
// ============================================================
import worker, { ROOT } from "./_helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { PAGE_FILES, staticFilePath, workerRewriteMap } from "../scripts/route-map.mjs";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? "｜" + detail : ""}`); }
}

/* ============ R1 路由表同步 ============ */
console.log("\n═══ R1 路由表同步（_worker.js ≡ route-map.mjs） ═══");
{
  const workerSrc = fs.readFileSync(path.join(ROOT, "_worker.js"), "utf8");
  const m = /const PAGE_REWRITES = \{([\s\S]*?)\n\};/.exec(workerSrc);
  check("_worker.js 含 PAGE_REWRITES 定义", !!m);
  if (m) {
    const pairs = [...m[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]);
    const inline = Object.fromEntries(pairs);
    const expected = workerRewriteMap();
    const same = JSON.stringify(inline) === JSON.stringify(expected);
    check(`内联表与 route-map 一致（${pairs.length} 条）`, same,
      same ? "" : `inline=${JSON.stringify(inline)} expected=${JSON.stringify(expected)}`);
  }
}

/* ============ R2 Worker 重写行为（真实 worker + ASSETS mock） ============ */
console.log("\n═══ R2 Worker 重写行为 ═══");
const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};
function makeAssets(log) {
  return {
    async fetch(request) {
      const p = decodeURIComponent(new URL(request.url).pathname);
      log.push(p);
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return new Response("nf", { status: 404, headers: { "Content-Type": "text/plain" } });
      }
      const ext = path.extname(file).toLowerCase();
      return new Response(fs.readFileSync(file), {
        status: 200,
        headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
      });
    },
  };
}
const assetsLog = [];
const kvStore = new Map();
const ENV = {
  ASSETS: makeAssets(assetsLog),
  DRIVE_PIN: "test-pin",
  GITHUB_TOKEN: "ghp_test",
  SITE_DATA: {
    get: async (k) => (kvStore.has(k) ? kvStore.get(k) : null),
    put: async (k, v) => { kvStore.set(k, v); },
    list: async () => ({ keys: [] }),
    delete: async (k) => { kvStore.delete(k); },
  },
};
const CTX = { waitUntil: () => {} };

async function wget(p) {
  const req = new Request("http://localhost" + p, { method: "GET" });
  const resp = await worker.fetch(req, ENV, CTX);
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, text };
}

{
  const r = await wget("/drive.html");
  check("GET /drive.html → 200 云盘页", r.status === 200 && r.text.includes("<title>云盘"), `status=${r.status}`);
  check("  └ 重写落点 pages/drive.html", assetsLog.includes("/pages/drive.html"), assetsLog.join(","));
  check("  └ HTML 缓存策略 max-age=0", (r.headers.get("Cache-Control") || "").includes("max-age=0"), r.headers.get("Cache-Control"));
  check("  └ 带 CSP 安全头", (r.headers.get("Content-Security-Policy") || "").includes("script-src"));

  const r2 = await wget("/");
  check("GET / → 200 首页", r2.status === 200 && r2.text.includes("<title>"), `status=${r2.status}`);
  check("  └ 重写落点 pages/index.html", assetsLog.includes("/pages/index.html"));

  const r3 = await wget("/index.html");
  check("GET /index.html → 200（旧 URL 兼容）", r3.status === 200, `status=${r3.status}`);

  const r4 = await wget("/pages/drive.html");
  check("GET /pages/drive.html 物理直通 → 200", r4.status === 200 && r4.text.includes("<title>云盘"), `status=${r4.status}`);

  const r5 = await wget("/post.html?id=abc");
  check("GET /post.html?id=abc → 200（查询串保留）", r5.status === 200 && r5.text.includes("<title>"), `status=${r5.status}`);

  const r6 = await wget("/nope.html");
  check("GET /nope.html → 404（未登记路径不重写）", r6.status === 404, `status=${r6.status}`);

  const r7 = await wget("/api/__nonexistent__");
  check("GET /api/* 仍走 API 派发（JSON 404）", r7.status === 404 && (r7.headers.get("Content-Type") || "").includes("json"), `status=${r7.status}`);

  // R3：静态资源不经重写
  const r8 = await wget("/styles/common.css");
  check("GET /styles/common.css → 200 CSS（不重写）", r8.status === 200 && (r8.headers.get("Content-Type") || "").includes("css"), `status=${r8.status}`);
  const r9 = await wget("/services/uploadService.js");
  check("GET /services/uploadService.js → 200 JS", r9.status === 200 && (r9.headers.get("Content-Type") || "").includes("javascript"), `status=${r9.status}`);
}

/* ============ R4 全站链接完整性 ============ */
console.log("\n═══ R4 全站链接完整性 ═══");
{
  const htmlFiles = fs.readdirSync(path.join(ROOT, "pages")).filter((f) => f.endsWith(".html"));
  let refTotal = 0, missing = [];
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, "pages", f), "utf8");
    // 所有以 "/" 开头的引用串（属性 + JS 字符串，如 games.html 的 src: "..."），
    // 排除 API 路径与协议相对 URL
    const refs = [...src.matchAll(/"(\/[^"]*)"/g)].map((x) => x[1]);
    for (let ref of refs) {
      if (ref === "/" || ref.startsWith("/api/") || ref.startsWith("//")) continue;
      ref = ref.split("?")[0].split("#")[0];
      if (!ref) continue;
      refTotal += 1;
      const file = path.join(ROOT, staticFilePath(ref));
      if (!fs.existsSync(file)) missing.push(`${f} → ${ref}`);
    }
  }
  check(`10 个页面 ${refTotal} 处本地引用全部落盘`, missing.length === 0, missing.slice(0, 5).join("；"));

  // SW 预缓存清单
  const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const preM = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(swSrc);
  const preUrls = preM ? [...preM[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  const preMissing = preUrls.filter((u) => !fs.existsSync(path.join(ROOT, staticFilePath(u))));
  check(`SW 预缓存清单 ${preUrls.length} 项全部落盘`, preUrls.length > 0 && preMissing.length === 0, preMissing.join(","));

  // manifest 图标与 start_url
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const iconMissing = (manifest.icons || []).filter((i) => !fs.existsSync(path.join(ROOT, i.src)));
  check("manifest 图标全部落盘", iconMissing.length === 0, iconMissing.map((i) => i.src).join(","));
  const startFile = path.join(ROOT, staticFilePath(manifest.start_url.replace(/^\.\//, "/")));
  check("manifest start_url 可解析", fs.existsSync(startFile), manifest.start_url);

  // 路由表登记的页面物理存在
  const pageMissing = Object.values(PAGE_FILES).filter((p) => !fs.existsSync(path.join(ROOT, p)));
  check("路由表 10 个页面物理存在", pageMissing.length === 0, pageMissing.join(","));
}

/* ============ R5 SW 注册绝对路径 ============ */
console.log("\n═══ R5 SW 注册路径 ═══");
{
  const commonSrc = fs.readFileSync(path.join(ROOT, "utils", "common.js"), "utf8");
  check("common.js 用绝对路径注册 /sw.js", commonSrc.includes('register("/sw.js")'));
  check("common.js 不再有相对 sw.js 注册", !commonSrc.includes('register("sw.js")'));
}

/* ============ R6 页面无相对本地引用 ============ */
console.log("\n═══ R6 页面引用规范 ═══");
{
  const htmlFiles = fs.readdirSync(path.join(ROOT, "pages")).filter((f) => f.endsWith(".html"));
  const bad = [];
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, "pages", f), "utf8");
    for (const m of src.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const v = m[1];
      if (!v || v.startsWith("/") || /^(https?:|data:|#|mailto:|javascript:)/i.test(v) || v.includes("${")) continue;
      bad.push(`${f} → ${v}`);
    }
  }
  check("无相对本地 href/src（下沉目录不会静默 404）", bad.length === 0, bad.slice(0, 5).join("；"));
}

console.log(`\n步骤10 路由与链接守护: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
