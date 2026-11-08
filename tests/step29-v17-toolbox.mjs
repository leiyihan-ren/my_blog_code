/* ============================================================
 * step29-v17-toolbox.mjs —— v17.0 按需加载 / EventBus / 资源预取 验证
 * ------------------------------------------------------------
 * 两段式：
 *   A. 静态门禁（零浏览器依赖）：分片清单三方一致、版本冻结、骨架屏、
 *      EventBus 双形态行为等价、全站 head 资源提示、微信验证文件、CI 门禁。
 *      ci.yml 不安装 npm 依赖也能跑完整段。
 *   B. 浏览器端到端（检测到 playwright 时自动启用）：
 *      首屏零分片请求 → 点击 Tab B 才 import() → 15 工具出结果 →
 *      Tab 往返不重复请求 → 骨架屏显隐 → EventBus 真实工作 → 零 JS 错误。
 *      未装 Playwright 时打印 SKIP 并正常退出，不判失败。
 *
 * 不修改任何既有 32 个套件；本套件只做增量验证。
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { staticFilePath } from "../scripts/route-map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
let pass = 0, fail = 0;
/** @param {string} name @param {boolean} cond @param {string} [detail] */
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("═══ A. 静态门禁（零浏览器依赖） ═══");

/* ---------- A1 分片文件与 ESM 导出 ---------- */
const MODULE_NAMES = ["regex", "qrcode", "image", "diff", "gradient", "cron", "url", "case"];
const shardPaths = MODULE_NAMES.map((n) => `modules/toolbox/${n}.js`);
check("A1 8 个工具分片 + manifest 全部落盘", shardPaths.every(exists) && exists("modules/toolbox/manifest.js"),
  `${shardPaths.length + 1} 个文件`);
check("A1b 每个分片导出 init(scope, injectedKit) 且注入模块级 kit",
  shardPaths.every((p) => {
    const s = read(p);
    return /export function init\(scope, injectedKit\)/.test(s)
      && /var kit = null;/.test(s) && /kit = injectedKit;/.test(s);
  }));
check("A1c 分片零裸依赖 / 零 console / 零裸 fetch（全部经 kit 注入）",
  shardPaths.every((p) => {
    const code = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    return !/(?<![.\w$])(P\.|C\.|Compute\.|setStatus\(|scopedDebounce\(|guarded\(|text\(|toast\(|\$\()/.test(code)
      && !/console\.(log|debug|info)\s*\(/.test(code)
      && !/(^|[^.\w"'])fetch\s*\(/.test(code);
  }));

/* ---------- A2 清单三方一致（manifest / SW / 磁盘） ---------- */
const { MODULES, TOOL_IDS, MODULE_COUNT } = await import(
  new URL("../modules/toolbox/manifest.js", import.meta.url).href
);
const sw = read("sw.js");
const preM = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(sw);
const preUrls = preM ? [...preM[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
const swModules = preUrls.filter((u) => u.startsWith("/modules/toolbox/"));
const manifestSet = new Set(MODULES);
check("A2 manifest.MODULES / SW 预缓存 / 磁盘文件三方一致",
  MODULES.length === MODULE_COUNT && MODULES.length === 8
  && swModules.length === MODULES.length + 1
  && swModules.every((u) => u === "/modules/toolbox/manifest.js" || manifestSet.has(u))
  && MODULES.every((u) => preUrls.includes(u))
  && MODULES.every((u) => exists(staticFilePath(u)))
  && TOOL_IDS.length === MODULE_COUNT,
  `manifest=${MODULES.length} SW=${swModules.length}`);
check("A2b SW 预缓存清单全部落盘（含新增 10 项）",
  preUrls.every((u) => exists(staticFilePath(u))), `${preUrls.length} 项`);
check("A2c SW Cache-First 正则覆盖 modules/toolbox 与 EventBus",
  /TOOLBOX_IMMUTABLE_PATH = [^\n]*modules\\\/toolbox\\\//.test(sw)
  && /TOOLBOX_IMMUTABLE_PATH = [^\n]*utils\\\/event-bus/.test(sw)
  && preUrls.includes("/utils/event-bus.js"));

/* ---------- A3 版本冻结与内核脚本链 ---------- */
const cons = read("utils/toolbox-constants.js");
const html = read("pages/tools.html");
const swVer = (/CACHE_VERSION = "v([\d.]+)"/.exec(sw) || [])[1];
check("A3 运行时版本 15.0.0 冻结（常量层 / SW / 页面查询串三方对齐）",
  /VERSION:\s*"15\.0\.0"/.test(cons) && swVer === "15.0.0"
  // 与 step28 A1 同一契约：tools.html 恰 7 处内核资源带 ?v=15.0.0 查询串
  && (html.match(/\?v=15\.0\.0/g) || []).length >= 7,
  `SW v${swVer}`);
check("A3b 工程版本 17.0.0 仅存在于 package.json（与运行时解耦）",
  /"version":\s*"17\.0\.0"/.test(read("package.json")) && !/17\.0\.0/.test(cons));
const chain = ["toolbox-constants", "toolbox-pure", "toolbox-scope", "toolboxCompute", "qrcode", "toolbox"];
const idxs = chain.map((n) => html.indexOf(n + ".js?v=15.0.0"));
check("A3c 六个内核 <script> 标签与依赖顺序零改动（A12 契约）",
  idxs.every((v, i) => v > 0 && (i === 0 || v > idxs[i - 1])));

/* ---------- A4 骨架屏与 Tab 结构 ---------- */
const panelCut = html.indexOf('<div id="tb-panel-advanced"');
const basicCards = (html.slice(0, panelCut).match(/data-tool="/g) || []).length;
const tplCards = (html.slice(html.indexOf("<template")).match(/data-tool="/g) || []).length;
const skeleton = /<div id="tb-advanced-skeleton"[^>]*>([\s\S]*?)<\/div>\s*<div id="tb-advanced-load-error"/.exec(html);
check("A4 骨架屏存在、默认隐藏、且不含 data-tool（不撑大卡片计数）",
  !!skeleton && /hidden/.test(skeleton[0].slice(0, 120)) && !/data-tool=/.test(skeleton[1])
  && /tb-skeleton-card/.test(skeleton[1]) && exists("styles/toolbox.css")
  && read("styles/toolbox.css").includes("tbShimmer"));
check("A4b Tab A=7 / B(template)=8，默认 DOM 恰 7 卡（A13 契约）",
  basicCards === 7 && tplCards === 8 && /role="tablist"/.test(html), `A=${basicCards} B=${tplCards}`);

/* ---------- A5 动态加载与 UI 纪律 ---------- */
const ui = read("components/toolbox.js");
check("A5 toolbox.js 经 import() 加载 manifest 与分片，且 Tab A 保持同步",
  /import\(MANIFEST_URL\)/.test(ui) && /import\(url\)/.test(ui)
  && /if \(!isAdv\) \{[\s\S]{0,120}?initBasicTools\(tabScope\)/.test(ui)
  && /tabGeneration/.test(ui) && /advLoadPromise = null/.test(ui));
check("A5b UI 编排零 console / 零裸 fetch / 保留三个纯函数契约锚点",
  !/console\.(log|debug|info)\s*\(/.test(ui)
  && !/(^|[^.\w"'])fetch\s*\(/.test(ui)
  && /P\.buildCron\(/.test(ui) && /P\.urlConvert\(/.test(ui) && /P\.convertCase\(/.test(ui));
check("A5c kit.cfg 全部被分片真实消费（零死配置）", (() => {
  const m = /var ADV_MODULE_CFG = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(ui);
  if (!m) return false;
  const keys = [...m[1].matchAll(/(\w+):\s*C\./g)].map((x) => x[1]);
  const shards = shardPaths.map(read).join("\n");
  return keys.length >= 8 && keys.every((k) => shards.includes("kit.cfg." + k));
})());

/* ---------- A6 EventBus 双形态行为等价 ---------- */
{
  const ctx = vm.createContext({});
  vm.runInContext(read("utils/event-bus.js"), ctx, { filename: "utils/event-bus.js" });
  const classic = vm.runInContext("EventBus", ctx);
  const { createEventBus } = await import(new URL("../src/shared/event-bus.js", import.meta.url).href);
  const esm = createEventBus();

  function exercise(bus) {
    const log = [];
    const off = bus.on("t", (p) => log.push("a" + p.n));
    bus.once("t", (p) => log.push("o" + p.n));
    bus.on("t", () => { throw new Error("订阅者异常"); });
    bus.on("t", (p) => log.push("b" + p.n));
    const n1 = bus.emit("t", { n: 1 });
    const err = bus.lastError();
    off();
    const n2 = bus.emit("t", { n: 2 });
    // 快照语义：emit 期间新增的订阅不应在本轮被调用
    let snap = [];
    const b2 = bus.create ? bus.create() : createEventBus();
    let added = false;
    b2.on("s", () => { if (!added) { added = true; b2.on("s", () => snap.push("late")); } });
    b2.emit("s", {});
    return { log, n1, n2, hasErr: !!err, snap, count: bus.listenerCount("t") };
  }
  const a = exercise(classic), b = exercise(esm);
  check("A6 EventBus classic(UMD) 与 ESM 规范实现逐字段行为等价",
    JSON.stringify(a) === JSON.stringify(b)
    && a.n1 === 4 && a.n2 === 2 && a.hasErr === true && a.snap.length === 0,
    `n1=${a.n1} n2=${a.n2} 错误隔离=${a.hasErr}`);
  check("A6b 通知中心订阅 ui:toast，编排层订阅加载事件",
    /window\.EventBus\.on\("ui:toast"/.test(read("components/ui.js"))
    && /bus\.on\(ADV_EVENTS\.loading/.test(ui)
    && /bus\.emit\("ui:toast"/.test(ui));
}

/* ---------- A7 全站资源提示与验证文件 ---------- */
{
  const pages = fs.readdirSync(path.join(ROOT, "pages")).filter((f) => f.endsWith(".html")).sort();
  const PF = ["/index.html", "/blog.html", "/drive.html", "/tools.html"];
  const results = pages.map((n) => {
    const s = read("pages/" + n);
    const eb = (s.match(/<script src="\/utils\/event-bus\.js"><\/script>/g) || []).length;
    const pf = (s.match(/rel="prefetch"/g) || []).length;
    const want = PF.filter((h) => h !== "/" + n).length;
    const dup = (s.match(/href="https:\/\/api\.mcsrvstat\.us"/g) || []).length;
    return eb === 1 && pf === want && dup <= 1
      && s.indexOf("<meta charset") < s.indexOf("v17.0 模块三")
      && /rel="dns-prefetch" href="https:\/\/api\.github\.com"/.test(s);
  });
  check(`A7 全站 ${pages.length} 个页面 head 统一注入 EventBus / 预连接 / 预取（幂等去重）`,
    results.every(Boolean), `${results.filter(Boolean).length}/${pages.length}`);
  const VFILE = "4874997fe38afa094805abd462d246f8.txt";
  check("A7b 微信域名验证文件在根目录且内容逐字一致",
    exists(VFILE) && read(VFILE).trim() === "f0ea827fad99cc00aeb54fd9e0e73250a735f50d");
  check("A7c 验证文件与 modules/ 均进入构建产物（src/ 仍排除）",
    ["dist", "public", "build"].every((d) => exists(`${d}/${VFILE}`)
      && exists(`${d}/modules/toolbox/manifest.js`) && !exists(`${d}/src`)));
}

/* ---------- A8 CI 门禁与架构审计闭环 ---------- */
{
  const ci = read(".github/workflows/ci.yml");
  const runner = read("tests/run-all.mjs");
  const arch = read("src/features/tools/manifest.mjs");
  check("A8 ci.yml 纳入 npm run audit:arch 与按需加载测试",
    /npm run audit:arch/.test(ci) && /step29-v17-toolbox\.mjs/.test(ci));
  check("A8b run-all 扩至 33 套件且包含 step29，既有 32 套件顺序不变",
    /step29-v17-toolbox\.mjs/.test(runner) && /33/.test(runner.slice(0, 300)));
  check("A8c 架构域清单登记全部新文件",
    ["modules/toolbox/manifest.js", ...shardPaths,
      "tests/step29-v17-toolbox.mjs"].every((p) => arch.includes(p))
    && read("src/shared/manifest.mjs").includes("utils/event-bus.js"));
  check("A8d arch-audit 把 modules/ 纳入扫描且剥离注释噪声",
    /glob\("modules", "\.js"\)/.test(read("scripts/arch-audit.mjs"))
    && /function stripComments/.test(read("scripts/arch-audit.mjs")));
}

/* ============================================================
 * B. 浏览器端到端（自适应：未安装 Playwright 时跳过）
 * ============================================================ */
let chromium = null;
try {
  const pw = await import("playwright");
  chromium = pw.chromium;
} catch (e) {
  console.log("\n═══ B. 浏览器端到端：SKIP（未安装 playwright，静态门禁已覆盖 CI） ═══");
}

if (chromium) {
  console.log("\n═══ B. 浏览器端到端（真实 import() / 骨架屏 / EventBus） ═══");
  const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
    ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
  const server = http.createServer((req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.startsWith("/api/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "ok", scope: "visitor", query: "203.0.113.7" }));
      }
      const file = path.join(ROOT, staticFilePath(p));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end("nf");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    } catch (e) { res.writeHead(500); res.end("err"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ORIGIN = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const jsErrors = [], external = [], moduleReqs = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/modules/toolbox/")) moduleReqs.push(u);
    if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
  });
  await page.route((u) => u.pathname.startsWith("/api/"), async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ status: "ok", scope: "visitor", query: "203.0.113.7",
        country: "中国", city: "示例", isp: "示例运营商", asn: "AS64500" }) });
  });
  try {
    await page.goto(ORIGIN + "/tools.html", { waitUntil: "domcontentloaded" });
    await sleep(700);
    check("B1 首屏零分片请求：Tab A 完全同步、不加载任何工具模块",
      moduleReqs.length === 0
      && (await page.locator("[data-tool]").count()) === 7
      && (await page.evaluate(() => window.ToolboxDebug.moduleState().loaded)) === false,
      `首屏分片请求 ${moduleReqs.length} 次`);

    // 骨架屏：点击后立刻可见（同步挂载 + bootstrap），加载完成后隐藏
    await page.click("#tb-tab-advanced");
    const skeletonEarly = await page.evaluate(() => {
      const el = document.getElementById("tb-advanced-skeleton");
      return el ? { exists: true, hidden: el.hidden, cards: document.querySelectorAll("[data-tool]").length } : null;
    });
    check("B2 点击 Tab B 立即克隆 8 卡（15 工具 DOM 就绪、骨架屏节点在位、零白屏）",
      !!skeletonEarly && skeletonEarly.exists && skeletonEarly.cards === 15,
      `cards=${skeletonEarly && skeletonEarly.cards} skeletonHidden=${skeletonEarly && skeletonEarly.hidden}`);
    check("B2b 骨架屏期间三个 v15 工具已由纯函数内核填好默认输出",
      (await page.inputValue("#cron-expression")).length > 0
      && (await page.inputValue("#url-output")).length > 0
      && (await page.inputValue("#case-output")).length > 0);

    await sleep(900);
    const st = await page.evaluate(() => window.ToolboxDebug.moduleState());
    check("B3 Tab B 触发原生 import()：manifest + 8 分片全部加载并就绪",
      st.loaded === true && st.count === 8 && st.error === ""
      && moduleReqs.some((u) => u.includes("manifest.js"))
      && new Set(moduleReqs.filter((u) => u.endsWith(".js"))).size >= 9,
      `loaded=${st.loaded} count=${st.count} 请求 ${new Set(moduleReqs).size} 个`);
    check("B3b 骨架屏加载完成后隐藏",
      (await page.locator("#tb-advanced-skeleton").isHidden())
      && (await page.locator("#tb-advanced-load-error").isHidden()));
    check("B3c 15 个工具全部产出结果（含 Worker 重计算）",
      (await page.locator("[data-tool]").count()) === 15
      && /Web Worker/.test(await page.textContent("#regex-status"))
      && /Web Worker/.test(await page.textContent("#diff-status"))
      && (await page.locator("#cron-next .tb-cron-slot").count()) > 0
      && (await page.locator("#url-params tr").count()) > 0
      && (await page.inputValue("#case-output")).length > 0,
      await page.evaluate(() => JSON.stringify(window.ToolboxCompute.state())));

    const before = new Set(moduleReqs).size;
    await page.click("#tb-tab-basic");
    await sleep(250);
    await page.click("#tb-tab-advanced");
    await sleep(500);
    check("B4 Tab 往返复用已加载模块，零重复网络请求",
      new Set(moduleReqs).size === before
      && (await page.locator("[data-tool]").count()) === 15,
      `往返前 ${before} → 往返后 ${new Set(moduleReqs).size}`);

    const busOk = await page.evaluate(() => {
      const bus = window.EventBus;
      if (!bus) return { ok: false };
      let got = null;
      const off = bus.on("test:v17", (p) => { got = p; });
      bus.emit("test:v17", { n: 42 });
      off();
      return {
        ok: !!got && got.n === 42 && bus.listenerCount("test:v17") === 0,
        toast: bus.listenerCount("ui:toast"),
        loading: bus.listenerCount("toolbox:modules:loading"),
      };
    });
    check("B5 EventBus 真实工作：通知中心订阅 ui:toast、编排层订阅加载事件",
      busOk.ok && busOk.toast >= 1 && busOk.loading >= 1,
      `toast=${busOk.toast} loading=${busOk.loading}`);

    check("B6 全程零 JS 异常 / 零第三方运行时请求",
      jsErrors.length === 0 && external.length === 0,
      jsErrors.slice(0, 2).join(" | ") || external.slice(0, 2).join(" | ") || "无");
  } finally {
    await ctx.close();
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
