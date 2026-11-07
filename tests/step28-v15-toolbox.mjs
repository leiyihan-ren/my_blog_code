// ============================================================
// 步骤 28：v15.0 工具箱终极增维 + PWA 离线强化 端到端验证
// ------------------------------------------------------------
// A. 静态架构：版本三方对齐 / 15 工具 / Tab / SW Cache-First 与离线外壳 /
//              CSS 过渡与按压反馈 / 移动端键盘与滑动
// B. 纯函数内核：Cron / URL / 大小写 三组新算法在 Node VM 自检
// C. 浏览器：15 工具 + 3 个新工具交互 + UI 微交互 + 平板/手机 + 生命周期
// D. PWA 完全离线：SW 注册 → 预缓存 → 断网重载 → 15 工具与 Worker 照常运行
// 运行：node tests/step28-v15-toolbox.mjs
// ============================================================
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import pkg from "playwright";
const { chromium } = pkg;

let pass = 0, fail = 0;
const findings = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* ============================================================
 * A. 静态架构（版本 / DOM / SW / CSS / 工程规范）
 * ============================================================ */
console.log("\n═══ A. v15 静态架构与工程规范 ═══");
{
  const cons = read("utils/toolbox-constants.js");
  const pure = read("utils/toolbox-pure.js");
  const ui = read("components/toolbox.js");
  const sw = read("sw.js");
  const html = read("pages/tools.html");
  const cssIn = read("styles/toolbox.input.css");
  const cssOut = read("styles/toolbox.css");

  const prodVer = (/VERSION:\s*"([\d.]+)"/.exec(cons) || [])[1] || "";
  const swVer = (/CACHE_VERSION = "v([\d.]+)"/.exec(sw) || [])[1] || "";
  check("A1 版本三方对齐 15.0.0（常量层 / SW / 页面查询串）",
    prodVer === "15.0.0" && swVer === "15.0.0"
    && (html.match(/\?v=15\.0\.0/g) || []).length >= 7
    && !/\?v=14\.0\.0/.test(html) && !/v14\.0\.0/.test(sw),
    `常量 ${prodVer} / SW v${swVer} / 页面 ${(html.match(/\?v=15\.0\.0/g) || []).length} 处`);

  check("A2 SEO 元信息同步到 15 工具 + 离线能力",
    /15 个硬核开发工具/.test(html) && /PWA 完全离线可用/.test(html)
    && /15 个硬核开发工具/.test(html.match(/<meta name="description"[^>]*>/)?.[0] || ""),
    "description / og / hero / footer 全部更新");

  check("A3 Tab 计数 A=07 / B=08 / 合计 15 TOOLS",
    /<span class="tb-tab-count">07<\/span>/.test(html)
    && /<span class="tb-tab-count">08<\/span>/.test(html)
    && /15 TOOLS · PURE \/ WORKER \/ OFFLINE/.test(html)
    && /8 MODULES/.test(html));

  const panelCut = html.indexOf('<div id="tb-panel-advanced"');
  const basicCards = (html.slice(0, panelCut).match(/data-tool="/g) || []).length;
  const tplCards = (html.slice(html.indexOf("<template")).match(/data-tool="/g) || []).length;
  check("A4 默认 DOM 恰 7 卡（step26 兼容），Tab B template 恰 8 卡",
    basicCards === 7 && tplCards === 8, `A=${basicCards} B=${tplCards}`);

  const newTools = ["cron", "url", "case"];
  check("A5 三个新工具卡片全部位于 inert template 内（不撑大首屏 DOM）",
    newTools.every((n) => (html.slice(html.indexOf("<template")).match(new RegExp('data-tool="' + n + '"', "g")) || []).length === 1)
    && newTools.every((n) => !html.slice(0, html.indexOf("<template")).includes('data-tool="' + n + '"')));

  const newIds = [
    "cron-minute", "cron-hour", "cron-dom", "cron-month", "cron-dow",
    "cron-expression", "cron-next", "cron-describe", "cron-count", "cron-status",
    "url-input", "url-output", "url-scope", "url-mode", "url-params", "url-status",
    "case-input", "case-output", "case-modes", "case-tokens", "case-status",
  ];
  const missIds = newIds.filter((id) => !html.includes('id="' + id + '"'));
  check("A6 三个新工具的关键 DOM 节点齐全", missIds.length === 0,
    missIds.length ? "缺失 " + missIds.join(",") : `${newIds.length} 个节点`);

  check("A7 SW 新增工具箱不可变资源 Cache-First 分支",
    /const TOOLBOX_IMMUTABLE_PATH = \/\^\\\/\(\?:utils\\\/toolbox-/.test(sw)
    && /async function cacheFirstImmutable\(req\)/.test(sw)
    && /event\.respondWith\(cacheFirstImmutable\(req\)\)/.test(sw)
    && /req\.mode !== "navigate"/.test(sw)
    && /TOOLBOX_IMMUTABLE_PATH\.test\(url\.pathname\)/.test(sw));

  check("A8 Cache-First 命中即返回，绝不后台 revalidate",
    /async function cacheFirstImmutable[\s\S]{0,900}?if \(hit\) return hit;/.test(sw)
    && /const hit = \(await runtime\.match\(req\)\)/.test(sw)
    && (sw.match(/ignoreSearch: true/g) || []).length >= 4);

  check("A9 Cache-First 严格置于 /api/ 分支之后，实时接口零影响",
    sw.indexOf('if (!url.pathname.startsWith("/api/") && req.mode !== "navigate"') >
    sw.indexOf('url.pathname.startsWith("/api/toolbox/")')
    && /url\.pathname\.startsWith\("\/api\/toolbox\/"\)[\s\S]{0,220}?event\.respondWith\(fetch\(req\)\)/.test(sw));

  check("A10 导航断网回退补齐 STATIC_CACHE（工具箱页面级离线）",
    /const shell = await caches\.open\(STATIC_CACHE\)/.test(sw)
    && /\(await shell\.match\(req\)\)/.test(sw)
    && /\(await shell\.match\(req, \{ ignoreSearch: true \}\)\)/.test(sw)
    && /\(await shell\.match\(OFFLINE_URL\)\)/.test(sw));

  const preM = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(sw);
  const preUrls = preM ? [...preM[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  const preMissing = preUrls.filter((u) => !fs.existsSync(path.join(ROOT, staticFilePath(u))));
  check("A11 预缓存清单补齐 Worker 裸 URL + 全部带版本资源，且全部落盘",
    ["/utils/toolbox-worker.js", "/utils/toolbox-constants.js", "/utils/toolbox-pure.js"]
      .every((u) => preUrls.includes(u))
    && (preUrls.filter((u) => /\?v=15\.0\.0/.test(u)).length >= 8)
    && preUrls.includes("/tools.html")
    && preMissing.length === 0,
    `${preUrls.length} 项，缺失 ${preMissing.length}`);

  check("A12 CSS：Tab 切换过渡动画关键帧 + 可见面板动画",
    /@keyframes tb-panel-in/.test(cssIn)
    && /\.tb-panel:not\(\[hidden\]\) \{ animation: tb-panel-in/.test(cssIn)
    && /@keyframes tb-panel-in/.test(cssOut)
    && /\.tb-panel:not\(\[hidden\]\)/.test(cssOut));

  check("A13 CSS：卡片 / 按钮 Active 按压缩放反馈",
    /\.tb-card:active \{ transform: scale\(\.995\)/.test(cssIn)
    && /\.tb-btn:active[^{]*\{ transform: scale\(\.95\)/.test(cssIn)
    && /transform \.16s var\(--ease\)/.test(cssIn)
    && /\.tb-card:active/.test(cssOut));

  check("A14 CSS：移动端 16px 输入框防键盘缩放 + 滚动 containment",
    /@media \(max-width: 640px\)[\s\S]{0,400}?font-size: 16px/.test(cssIn)
    && /scroll-padding-bottom: 42vh/.test(cssIn)
    && /overscroll-behavior: contain/.test(cssIn)
    && /-webkit-overflow-scrolling: touch/.test(cssIn)
    && /interactive-widget=resizes-content/.test(html));

  check("A15 新工具样式全部进入编译产物（Cache-First 的 CSS 真实可用）",
    [".tb-cron-grid", ".tb-cron-slot", ".tb-url-controls", ".tb-case-modes", ".tb-token"]
      .every((k) => cssOut.includes(k)));

  const newFns = ["parseCronField", "cronExpressionToParts", "buildCron", "cronMatches",
    "cronNext", "cronDescribe", "splitUrl", "formEncode", "formDecode", "urlConvert",
    "parseQuery", "splitWords", "capitalize", "convertCase"];
  check("A16 纯函数层新增 14 个导出函数且严格 JSDoc 同步增长",
    newFns.every((n) => new RegExp("\\b" + n + "\\s*[,}]").test(pure))
    && (pure.match(/@param/g) || []).length >= 75
    && (pure.match(/@returns/g) || []).length >= 42,
    `@param ${(pure.match(/@param/g) || []).length} / @returns ${(pure.match(/@returns/g) || []).length}`);

  check("A17 v15 新常量收敛（Cron / URL / Case / 键盘）零魔法数字",
    ["CRON_NEXT_COUNT", "CRON_MAX_SCAN_MINUTES", "CRON_RANGES", "CRON_FIELDS",
      "URL_MAX_LEN", "QUERY_MAX_PARAMS", "CASE_MODES", "KEYBOARD_GUARD_DELAY_MS"]
      .every((k) => cons.includes(k))
    && /C\.CRON_NEXT_COUNT/.test(ui) && /C\.CRON_FIELDS/.test(ui)
    && /C\.KEYBOARD_GUARD_DELAY_MS/.test(ui));

  check("A18 UI 薄层纪律不破：新代码零 console / 零裸 fetch / 零内联算法",
    !/console\.(log|debug|info)\s*\(/.test(ui)
    && !/(^|[^.\w"'])fetch\s*\(/.test(ui)
    && /P\.buildCron\(/.test(ui) && /P\.urlConvert\(/.test(ui) && /P\.convertCase\(/.test(ui));

  check("A19 PWA 离线守卫：断网跳过注定失败的 IP 查询 + 键盘守卫登记 Scope",
    /navigator\.onLine === false/.test(ui)
    && /当前离线，联网后可查询/.test(ui)
    && /function initKeyboardGuard\(scope\)/.test(ui)
    && /scope\.on\(vv, "resize", refocus\)/.test(ui)
    && /initKeyboardGuard\(rootScope\)/.test(ui));
}

/* ============================================================
 * B. 纯函数内核（Node VM 三端兼容 + 算法正确性 + 边缘隔离）
 * ============================================================ */
console.log("\n═══ B. v15 三组新纯函数 Node VM 自检 ═══");
{
  const ctx = vm.createContext({
    console, TextEncoder, TextDecoder, btoa, atob,
    crypto: globalThis.crypto, Uint8Array, Uint32Array, ArrayBuffer,
    Math, Date, Promise, Object, Array, String, Number, Boolean,
    isFinite, isNaN, parseInt, parseFloat, JSON, RegExp, Set, Map, Error,
  });
  ["utils/toolbox-constants.js", "utils/toolbox-pure.js", "vendor/qrcode.js"]
    .forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  const P = vm.runInContext("ToolboxPure", ctx);
  const C = vm.runInContext("ToolboxConstants", ctx);

  check("B1 常量层冻结 + v15 新增 14 函数可用 + 47 个导出",
    Object.isFrozen(C) && C.VERSION === "15.0.0"
    && ["buildCron", "cronNext", "urlConvert", "parseQuery", "convertCase"]
      .every((n) => typeof P[n] === "function")
    && Object.keys(P).length >= 45, `导出 ${Object.keys(P).length} 个`);

  // ---- Cron ----
  const built = P.buildCron({ minute: "0", hour: "9", dom: "*", month: "*", dow: "1-5" });
  check("B2 buildCron 五段组装 + 取值集合 + 通配标记",
    built.ok && built.expression === "0 9 * * 1-5"
    && built.fields.minute.length === 1 && built.fields.hour.length === 1
    && built.fields.dow.join(",") === "1,2,3,4,5" && built.wild.dom === true);

  const f1 = P.parseCronField("*/5", 0, 59);
  const f2 = P.parseCronField("1-5/2", 1, 12);
  const f3 = P.parseCronField("1,3,7", 0, 7);
  check("B3 parseCronField 通配步进 / 区间步进 / 列表",
    f1.ok && f1.values.length === 12 && f1.values[0] === 0 && f1.values[11] === 55
    && f2.ok && f2.values.join(",") === "1,3,5"
    && f3.ok && f3.values.join(",") === "1,3,7");

  check("B4 Cron 非法字段局部隔离（越界 / 非法步进 / 非法字符 / 空值）",
    P.parseCronField("99", 0, 59).ok === false
    && P.parseCronField("*/0", 0, 59).ok === false
    && P.parseCronField("abc", 0, 59).ok === false
    && P.parseCronField("", 0, 59).ok === false
    && P.buildCron({ minute: "99" }).ok === false
    && P.cronExpressionToParts("0 9 * *").ok === false);

  const from = new Date(2026, 10, 7, 9, 0, 0, 0).getTime(); // 2026-11-07 09:00 周六
  const n1 = P.cronNext("*/15 * * * *", 5, from);
  check("B5 cronNext 每 15 分钟：5 次预测严格递增且间隔精确",
    n1.ok && n1.count === 5 && n1.truncated === false
    && n1.times.every((t, i) => t > from && (i === 0 || t - n1.times[i - 1] === 15 * 60000)),
    n1.times.map((t) => new Date(t).toTimeString().slice(0, 5)).join(" "));

  const n2 = P.cronNext("30 9 * * 1-5", 3, from);
  check("B6 cronNext 工作日 09:30：全部落在周一至周五同一时刻",
    n2.ok && n2.count === 3 && n2.times.every((t) => {
      const d = new Date(t);
      return d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() === 9 && d.getMinutes() === 30;
    }), n2.times.map((t) => new Date(t).toDateString()).join(" | "));

  const n3 = P.cronNext("0 0 * * 7", 2, from), n4 = P.cronNext("0 0 * * 0", 2, from);
  check("B7 星期 7 与 0 同为周日，预测结果逐字一致",
    n3.ok && n4.ok && n3.times.join(",") === n4.times.join(",")
    && new Date(n3.times[0]).getDay() === 0);

  const n5 = P.cronNext("0 0 1 * 1", 3, from); // 日=1 或 周一 均触发（Vixie OR）
  check("B8 日 / 周同时受限时按 OR 语义匹配",
    n5.ok && n5.count === 3 && n5.times.some((t) => new Date(t).getDate() !== 1),
    n5.times.map((t) => new Date(t).toDateString()).join(" | "));

  const n6 = P.cronNext("0 0 29 2 *", 2, from, 366 * 24 * 60 * 5);
  check("B9 闰年 2/29 跳进扫描正确 + 未凑满时 truncated",
    n6.ok && n6.count >= 1 && new Date(n6.times[0]).getFullYear() === 2028
    && new Date(n6.times[0]).getMonth() === 1 && new Date(n6.times[0]).getDate() === 29
    && n6.truncated === true, new Date(n6.times[0]).toDateString());

  check("B10 非法表达式 / 永不触发的窗口局部隔离",
    P.cronNext("x x x x x", 3, from).ok === false
    && P.cronNext("0 0 30 2 *", 1, from, 60).ok === false);

  const desc = P.cronDescribe("0 9 * * 1-5");
  check("B11 cronDescribe 生成中文可读描述",
    desc.ok && /周一至周五/.test(desc.text) && /09:00/.test(desc.text), desc.text);

  // ---- URL ----
  const raw = "中文 & a=b/c?d";
  const ce = P.urlConvert(raw, "encode", "component");
  const cd = P.urlConvert(ce.value, "decode", "component");
  check("B12 component 整串 encodeURIComponent / decodeURIComponent 无损往返",
    ce.ok && cd.ok && cd.value === raw && ce.value.includes("%E4%B8%AD"));

  check("B13 component 非法百分号序列局部隔离（ok:false 且不抛异常）",
    P.urlConvert("%ZZ", "decode", "component").ok === false
    && P.urlConvert("%E4%B8", "decode", "component").ok === false);

  const urlRaw = "https://example.com/search?q=极客工具箱&lang=zh-CN&page=1&tag=cool tool#top";
  const ue = P.urlConvert(urlRaw, "encode", "query");
  check("B14 query 编码保留 URL 结构，仅参数值被编码（空格 → +）",
    ue.ok && ue.value.startsWith("https://example.com/search?")
    && ue.value.endsWith("#top")
    && ue.value.includes("q=%E6%9E%81%E5%AE%A2%E5%B7%A5%E5%85%B7%E7%AE%B1")
    && ue.value.includes("tag=cool+tool")
    && (ue.value.match(/&/g) || []).length === 3, ue.value);

  const ud = P.urlConvert(ue.value, "decode", "query");
  check("B15 query 解码还原中文 / 空格 / 结构",
    ud.ok && ud.value === urlRaw, ud.value);

  const ua = P.urlConvert("a b=c d&e=f", "encode", "all");
  check("B16 all 作用域连参数键一起编码",
    ua.ok && ua.value.startsWith("a+b=") && ua.value.includes("e=f"), ua.value);

  const q = P.parseQuery("https://x.com/s?q=%E4%B8%AD+%E6%96%87&n=1&n=2&empty=&bad=%ZZ&x#top");
  check("B17 parseQuery 重复键 / 空值 / + 空格 / hash / 非法编码隔离",
    q.ok && q.base === "https://x.com/s" && q.hash === "#top"
    && q.count === 6 && q.params[0].key === "q" && q.params[0].value === "中 文"
    && q.params[1].value === "1" && q.params[2].value === "2"
    && q.params[3].value === "" && q.params[4].invalid === true
    && q.invalid === 1, JSON.stringify(q.params.map((p) => p.key + "=" + p.value)));

  check("B18 URL 超长输入 / 不支持的作用域局部隔离",
    P.parseQuery("a".repeat(C.URL_MAX_LEN + 1)).ok === false
    && P.urlConvert("a=1", "encode", "nope").ok === false);

  // ---- 大小写 ----
  const cases = P.CASE_MODES || C.CASE_MODES;
  const sample = "helloWorld XMLHttpRequest user_name v2 API-test";
  const conv = {};
  cases.forEach((m) => { conv[m] = P.convertCase(sample, m); });
  check("B19 convertCase 七种模式全部 ok 且形态正确",
    cases.length === 7 && cases.every((m) => conv[m].ok)
    && conv.upper.value === sample.toUpperCase()
    && conv.lower.value === sample.toLowerCase()
    && conv.title.value.includes("Hello World")
    && conv.camel.value.startsWith("hello") && /[A-Z]/.test(conv.camel.value)
    && conv.pascal.value.startsWith("Hello")
    && conv.snake.value.includes("hello_world") && conv.snake.value.includes("_")
    && conv.kebab.value.includes("hello-world"));

  check("B20 splitWords 处理 camel / Pascal / 连续大写缩写 / 数字边界",
    P.splitWords("XMLHttpRequest v2Value fooBar").join("|") === "XML|Http|Request|v|2|Value|foo|Bar",
    P.splitWords("XMLHttpRequest v2Value fooBar").join("|"));

  check("B21 中文 Unicode 保留 + 非法模式隔离",
    P.convertCase("中文Abc", "snake").value.includes("中文")
    && P.convertCase("x", "nope").ok === false
    && P.convertCase("", "camel").value === "");

  check("B22 上/下转换保留原文标点与空格（不重组词元）",
    P.convertCase("a-b_c d", "upper").value === "A-B_C D"
    && P.convertCase("A-B_C D", "lower").value === "a-b_c d");
}

/* ============================================================
 * C / D. 浏览器端到端 + PWA 完全离线
 * ============================================================ */
console.log("\n═══ C. 浏览器 15 工具端到端 ═══");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav" };
const server = http.createServer((req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", scope: "visitor", query: "203.0.113.7",
        country: "中国", city: "示例", isp: "示例运营商", asn: "AS64500" }));
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
const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
const swVer = (/CACHE_VERSION = "v([\d.]+)"/.exec(read("sw.js")) || [])[1];
const STATIC_CACHE = `my-blog-static-v${swVer}`;

/* ---------------- C 段：在线交互 ---------------- */
const ctxMain = await browser.newContext({
  viewport: { width: 1280, height: 900 }, serviceWorkers: "block", acceptDownloads: true,
});
const page = await ctxMain.newPage();
const jsErrors = [], external = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
});
await page.route((u) => u.pathname.startsWith("/api/"), async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ status: "ok", scope: "visitor", query: "203.0.113.7",
      country: "中国", city: "示例", isp: "示例运营商", asn: "AS64500" }) });
});

try {
  await page.goto(ORIGIN + "/tools.html", { waitUntil: "domcontentloaded" });
  await sleep(600);

  check("C1 默认 Tab A 恰 7 卡 + 版本 15.0.0 + 零错误 / 零第三方",
    (await page.locator("[data-tool]").count()) === 7
    && (await page.evaluate(() => window.ToolboxDebug.version)) === "15.0.0"
    && jsErrors.length === 0 && external.length === 0,
    `cards=${await page.locator("[data-tool]").count()}`);

  await page.click("#tb-tab-advanced");
  await sleep(700);
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll("[data-tool]")].map((e) => e.getAttribute("data-tool")));
  check("C2 Tab B 共 15 工具，3 个 v15 新工具全部挂载 + aria 同步",
    tools.length === 15 && ["cron", "url", "case"].every((n) => tools.includes(n))
    && (await page.getAttribute("#tb-tab-advanced", "aria-selected")) === "true"
    && (await page.locator("#tb-panel-basic").isHidden()), `tools=${tools.length}`);

  // ---- 13 Cron ----
  const cronExpr0 = await page.inputValue("#cron-expression");
  check("C3 Cron 默认表达式 0 9 * * 1-5 + 中文描述 + 5 次预测",
    cronExpr0 === "0 9 * * 1-5"
    && /周一至周五/.test(await page.textContent("#cron-describe"))
    && (await page.locator("#cron-next .tb-cron-slot").count()) === 5
    && /VALID/.test(await page.textContent("#cron-status")), cronExpr0);

  await page.selectOption("#cron-minute", "*/5");
  await sleep(150);
  check("C4 Cron 可视化控件变更即时重算表达式与预测",
    (await page.inputValue("#cron-expression")) === "*/5 9 * * 1-5"
    && (await page.locator("#cron-next .tb-cron-slot").count()) === 5
    && /VALID/.test(await page.textContent("#cron-status")));

  await page.click("#cron-btn-reset");
  await sleep(150);
  check("C5 Cron 「重置为每天」一次性重置五段",
    (await page.inputValue("#cron-expression")) === "* * * * *"
    && /每分钟/.test(await page.textContent("#cron-describe")));

  await page.click("#cron-btn-now");
  await sleep(150);
  check("C6 Cron 「使用当前时间」动态补齐 option 不产生空白 select",
    /^\d+ \d+ \* \* \*$/.test(await page.inputValue("#cron-expression"))
    && (await page.locator("#cron-minute option:checked").count()) === 1);

  // ---- 14 URL ----
  const urlOut0 = await page.inputValue("#url-output");
  check("C7 URL 默认编码输出保留结构 + Query 参数列表 4 行",
    urlOut0.startsWith("https://example.com/search?")
    && urlOut0.includes("q=%E6%9E%81%E5%AE%A2%E5%B7%A5%E5%85%B7%E7%AE%B1")
    && urlOut0.includes("tag=cool+tool") && urlOut0.endsWith("#top")
    && (await page.locator("#url-params tr").count()) === 4
    && /极客工具箱/.test(await page.textContent("#url-params")),
    urlOut0.slice(0, 78));

  const encodedUrl = await page.inputValue("#url-output");
  await page.fill("#url-input", encodedUrl);
  await sleep(250);
  await page.click("#url-btn-decode");
  await sleep(200);
  check("C8 URL 解码按钮：已编码 URL 还原中文与空格，方向同步切换",
    (await page.inputValue("#url-mode")) === "decode"
    && (await page.inputValue("#url-output")).includes("q=极客工具箱")
    && (await page.inputValue("#url-output")).includes("tag=cool tool")
    && /已解码/.test(await page.textContent("#url-status")),
    (await page.inputValue("#url-output")).slice(0, 60));

  await page.selectOption("#url-scope", "component");
  await page.fill("#url-input", "%ZZ");
  await sleep(250);
  await page.click("#url-btn-decode");
  await sleep(150);
  check("C9 URL 非法百分号局部隔离：报错收敛、页面不崩、其余工具照常",
    /ERROR/.test(await page.textContent("#url-status"))
    && /对比完成|OK/.test(await page.textContent("#diff-status"))
    && jsErrors.length === 0);

  // ---- 15 Case ----
  check("C10 大小写默认 camelCase 输出 + 7 模式按钮 + 词元 chips",
    /XmlHttpRequest/.test(await page.inputValue("#case-output"))
    && (await page.locator("#case-modes [data-case]").count()) === 7
    && (await page.locator("#case-tokens .tb-token").count()) >= 8
    && /camelCase/.test(await page.textContent("#case-mode-label")));

  await page.click('#case-modes [data-case="snake"]');
  await sleep(120);
  check("C11 点击 snake_case 切换输出与激活态",
    /hello_world/.test(await page.inputValue("#case-output"))
    && (await page.locator('#case-modes [data-case="snake"].is-active').count()) === 1
    && /snake_case/.test(await page.textContent("#case-mode-label")));

  await page.fill("#case-input", "hello world");
  await sleep(350);
  check("C12 输入防抖重算保持当前模式",
    (await page.inputValue("#case-output")) === "hello_world"
    && (await page.locator("#case-tokens .tb-token").count()) === 2);

  // ---- 模块三：UI 微交互 ----
  const anim = await page.evaluate(() => {
    const p = document.getElementById("tb-panel-advanced");
    const cs = getComputedStyle(p);
    let cardActive = false, btnActive = false;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes(".tb-card:active") && /scale/.test(r.style.transform || "")) cardActive = true;
        if (r.selectorText && r.selectorText.includes(".tb-btn:active") && /scale/.test(r.style.transform || "")) btnActive = true;
      }
    }
    return { name: cs.animationName, cardActive, btnActive };
  });
  check("C13 Tab 过渡动画真实生效 + CSSOM 含卡片/按钮按压缩放规则",
    anim.name === "tb-panel-in" && anim.cardActive && anim.btnActive, JSON.stringify(anim));

  check("C14 Worker 重计算仍由 Web Worker 承担（v15 未破坏 v14 架构）",
    (await page.evaluate(() => window.ToolboxCompute.state())).workerAlive === true
    && /Web Worker/.test(await page.textContent("#regex-status"))
    && /Web Worker/.test(await page.textContent("#diff-status")));

  // ---- 移动端 / 平板 ----
  await page.setViewportSize({ width: 375, height: 812 });
  await sleep(250);
  async function overflow() {
    return page.evaluate(() => {
      const de = document.documentElement, bad = [];
      document.querySelectorAll("body *").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.visibility === "hidden" || cs.display === "none") return;
          let p = el.parentElement, scrollable = false;
          while (p) {
            const pcs = getComputedStyle(p);
            if (["auto", "scroll", "hidden"].includes(pcs.overflowX)) { scrollable = true; break; }
            p = p.parentElement;
          }
          if (!scrollable) bad.push(el.tagName + (el.id ? "#" + el.id : ""));
        }
      });
      return { scroll: de.scrollWidth, client: de.clientWidth, bad: bad.slice(0, 5) };
    });
  }
  const ov375 = await overflow();
  check("C15 375px 手机 Tab B（含 3 张新卡）零横向溢出",
    ov375.scroll <= ov375.client + 1 && ov375.bad.length === 0, JSON.stringify(ov375));

  const font375 = await page.evaluate(() => ({
    input: parseFloat(getComputedStyle(document.getElementById("url-input")).fontSize),
    select: parseFloat(getComputedStyle(document.getElementById("cron-minute")).fontSize),
    scrollPad: getComputedStyle(document.documentElement).scrollPaddingBottom,
  }));
  check("C16 移动端输入框 16px 防键盘缩放 + scroll-padding 生效",
    font375.input >= 16 && font375.select >= 16 && font375.scrollPad !== "auto",
    JSON.stringify(font375));

  await page.setViewportSize({ width: 768, height: 1024 });
  await sleep(250);
  const ov768 = await overflow();
  check("C17 768px 平板零横向溢出（滑动容器 containment 不撑破布局）",
    ov768.scroll <= ov768.client + 1 && ov768.bad.length === 0, JSON.stringify(ov768));

  // ---- 生命周期 ----
  const scopeBefore = await page.evaluate(() => window.ToolboxDebug.tabScopeSize());
  await page.click("#tb-tab-basic");
  await sleep(300);
  const disposed = await page.evaluate(() => ({
    disposed: window.ToolboxDebug.lastDisposedScopeDisposed(),
    size: window.ToolboxDebug.lastDisposedScopeSize(),
    pending: window.ToolboxCompute.state().pending,
  }));
  check("C18 Tab 切换彻底销毁新增工具的事件监听（资源归零）",
    scopeBefore > 0 && disposed.disposed && disposed.size === 0 && disposed.pending === 0,
    `切换前 ${scopeBefore} → 销毁后 ${disposed.size}`);

  check("C19 切回 Tab A 后原有 7 工具仍正常（红线）",
    (await page.getAttribute("#tb-tab-basic", "aria-selected")) === "true"
    && (await page.innerHTML("#json-output")).includes("tb-tok-key"));

  check("C20 全程零 JS 错误 / 零第三方运行时请求",
    jsErrors.length === 0 && external.length === 0,
    jsErrors.slice(0, 2).join(" | ") || external.slice(0, 2).join(" | ") || "无");
} finally {
  await ctxMain.close();
}

/* ---------------- D 段：PWA 完全离线 ---------------- */
console.log("\n═══ D. PWA 完全离线可用（断网重载 tools.html） ═══");
const ctxOffline = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageO = await ctxOffline.newPage();
const offErrors = [], offExternal = [];
pageO.on("pageerror", (e) => offErrors.push(String(e)));
pageO.on("console", (m) => {
  // 断网时浏览器自身会打印资源加载失败噪声，不属于 JS 异常，单独过滤
  if (m.type() === "error" && !/net::|Failed to load resource|ERR_/i.test(m.text())) offErrors.push(m.text());
});
pageO.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) offExternal.push(u);
});
try {
  await pageO.goto(ORIGIN + "/tools.html", { waitUntil: "load" });
  // 等 SW 接管并完成整份离线外壳预缓存
  let shellCount = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    shellCount = await pageO.evaluate(async (name) => {
      try {
        await navigator.serviceWorker.ready;
        const c = await caches.open(name);
        return (await c.keys()).length;
      } catch (e) { return 0; }
    }, STATIC_CACHE).catch(() => 0);
    if (shellCount >= 50) break;
  }
  const swState = await pageO.evaluate(async (name) => {
    const reg = await navigator.serviceWorker.ready;
    const c = await caches.open(name);
    const keys = (await c.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
    return { controlled: !!navigator.serviceWorker.controller, scope: reg.scope, keys };
  }, STATIC_CACHE);
  check("D1 SW 注册接管 + 离线外壳预缓存完成",
    swState.controlled && swState.scope.endsWith("/") && shellCount >= 50,
    `缓存 ${shellCount} 项`);
  check("D2 预缓存同时含带版本资源与 Worker 裸 URL（离线无 404）",
    ["/tools.html", "/utils/toolbox-worker.js", "/utils/toolbox-constants.js",
      "/utils/toolbox-pure.js", "/components/toolbox.js?v=15.0.0",
      "/styles/toolbox.css?v=15.0.0"].every((u) => swState.keys.includes(u)),
    `${swState.keys.length} 项`);

  // 在线预热一次 Tab B，让 8 个进阶工具 init 过（离线验证其可再次挂载）
  await pageO.click("#tb-tab-advanced");
  await sleep(700);
  await pageO.click("#tb-tab-basic");
  await sleep(250);

  await ctxOffline.setOffline(true);
  await pageO.reload({ waitUntil: "domcontentloaded" });
  await pageO.waitForFunction(() => !!document.getElementById("tb-tab-basic"), null, { timeout: 12000 });
  await sleep(600);

  const offPage = await pageO.evaluate(() => ({
    title: document.title,
    url: location.pathname,
    onLine: navigator.onLine,
    logo: (document.getElementById("nav-logo") || {}).textContent || "",
    cards: document.querySelectorAll("[data-tool]").length,
    version: window.ToolboxDebug ? window.ToolboxDebug.version : "",
  }));
  check("D3 断网重载仍打开 tools.html 自身（不再退化到 index.html）",
    offPage.onLine === false && offPage.url === "/tools.html"
    && /极客工具箱/.test(offPage.title) && !!offPage.logo && offPage.version === "15.0.0",
    `url=${offPage.url} title=${offPage.title}`);

  check("D4 离线首屏 7 卡 + JSON 高亮照常（前端计算零网络依赖）",
    offPage.cards === 7
    && (await pageO.innerHTML("#json-output")).includes("tb-tok-key")
    && (await pageO.inputValue("#b64-output")).length > 0);

  await pageO.click("#tb-tab-advanced");
  await sleep(800);
  const offTools = await pageO.evaluate(() =>
    [...document.querySelectorAll("[data-tool]")].map((e) => e.getAttribute("data-tool")));
  check("D5 离线 Tab B 仍挂载 15 工具，3 个新工具全部产出结果",
    offTools.length === 15 && ["cron", "url", "case"].every((n) => offTools.includes(n))
    && (await pageO.inputValue("#cron-expression")).length > 0
    && (await pageO.locator("#cron-next .tb-cron-slot").count()) > 0
    && (await pageO.inputValue("#url-output")).length > 0
    && (await pageO.locator("#url-params tr").count()) > 0
    && (await pageO.inputValue("#case-output")).length > 0,
    `tools=${offTools.length}`);

  const offCompute = await pageO.evaluate(() => window.ToolboxCompute.state());
  check("D6 离线后台重计算仍由 Worker 承担（裸 URL 预缓存真实命中）",
    offCompute.workerAlive === true && offCompute.broken === false
    && /Web Worker/.test(await pageO.textContent("#regex-status"))
    && /Web Worker/.test(await pageO.textContent("#diff-status")),
    `alive=${offCompute.workerAlive} seq=${offCompute.seq}`);

  await pageO.click("#tb-tab-basic");
  await sleep(300);
  check("D7 离线时 IP 查询工具给出明确离线提示（不发注定失败的请求）",
    /当前离线/.test(await pageO.textContent("#ip-note")),
    (await pageO.textContent("#ip-note")).trim());

  check("D8 离线全程零 JS 异常 / 零第三方运行时请求",
    offErrors.length === 0 && offExternal.length === 0,
    offErrors.slice(0, 2).join(" | ") || offExternal.slice(0, 2).join(" | ") || "无");

  const cacheFirstProof = await pageO.evaluate(async (name) => {
    const c = await caches.open(name);
    const r = await c.match(new Request("/components/toolbox.js?v=15.0.0"));
    return !!r && r.status === 200;
  }, STATIC_CACHE);
  check("D9 Cache-First 资源在离线外壳中可直接命中 200", cacheFirstProof);
} finally {
  await ctxOffline.close();
}

await browser.close();
server.closeAllConnections();
server.close();

console.log(`\n结果：通过 ${pass}/${pass + fail}，失败 ${fail}`);
if (fail) console.log("待整改：\n  - " + findings.join("\n  - "));
console.log("");
process.exit(fail ? 1 : 0);
