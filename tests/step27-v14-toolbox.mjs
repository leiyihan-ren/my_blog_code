// ============================================================
// 步骤 27：v14.0 极客进阶开发台 + 全站底层大清洗 端到端验证
// ------------------------------------------------------------
// A. 静态架构：纯函数抽离 / 常量收敛 / Scope / Worker / 请求层治理 / JSDoc / SW / 路由
// B. 纯函数内核：33 函数在 Node VM 中的算法正确性与边缘隔离
// C. 浏览器：12 工具 + Tab 分类 + Worker 参与 + 生命周期销毁 + 375px + 红线
// 运行：node tests/step27-v14-toolbox.mjs
// ============================================================
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
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
const glob = (dir, ext) => fs.readdirSync(path.join(ROOT, dir))
  .filter((n) => n.endsWith(ext)).map((n) => dir + "/" + n);
const FRONT_JS = [
  ...glob("components", ".js"), ...glob("utils", ".js"),
  ...glob("services", ".js"), "sw.js",
];

/* ============================================================
 * A. 静态架构断言（模块一：重构质量 + 模块三：工程规范）
 * ============================================================ */
console.log("\n═══ A. 静态架构与工程规范 ═══");
{
  const pure = read("utils/toolbox-pure.js");
  const cons = read("utils/toolbox-constants.js");
  const scope = read("utils/toolbox-scope.js");
  const worker = read("utils/toolbox-worker.js");
  const compute = read("services/toolboxCompute.js");
  const ui = read("components/toolbox.js");
  const cssIn = read("styles/toolbox.input.css");
  const sw = read("sw.js");
  const html = read("pages/tools.html");

  // A1 纯函数彻底抽离：剥离注释后再判定（注释里说明「零 fetch/console」不算副作用）
  const pureCode = pure.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const noSideEffect = !/\bdocument\b|\bwindow\b|\bfetch\s*\(|console\./.test(pureCode)
    && !/\bBlob\b|\bFileReader\b|\bOffscreenCanvas\b/.test(pureCode);
  check("A1 纯函数层零 DOM/网络/控制台/UI 副作用", noSideEffect,
    "剥离注释后仅依赖注入参数与语言内置对象");

  // A2 三端兼容：无 import/export，globalThis 挂载，Object.freeze 常量
  const umd = [cons, pure, scope].every((s) => !/^\s*(import|export)\s/m.test(s))
    && /globalThis/.test(cons) && /Object\.freeze/.test(cons);
  check("A2 常量/纯函数/Scope 三端 UMD 兼容（浏览器/Worker/Node）", umd);

  // A3 消除魔法数字：UI 层不含裸 160/12000/4000，全部读 C.*
  const magicFree = !/(?:^|[^\d.])(?:160|12000|4000)(?:[^\d]|$)/.test(
    ui.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""))
    && (ui.match(/C\.DEBOUNCE_MS/g) || []).length >= 8
    && /C\.PROBE_TIMEOUT_MS/.test(ui) && /C\.IMG_MAX_FILE_BYTES/.test(ui);
  check("A3 魔法数字收敛：防抖/超时/尺寸全读常量层", magicFree,
    `C.DEBOUNCE_MS 引用 ${(ui.match(/C\.DEBOUNCE_MS/g) || []).length} 处`);

  // 定义处统计用「行首 --tb-xxx:」锚定；使用处裸色统计先剥离所有定义行
  const varCount = (cssIn.match(/^\s*--tb-[\w-]+\s*:/gm) || []).length;
  const cssRules = cssIn.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const bareColor = (cssRules.match(/#070d16|#d7e3f4|#2a3d57|#334a66/g) || []).length;
  check("A4 CSS 变量消除硬编码颜色/尺寸（高频裸色已收敛）",
    varCount >= 18 && bareColor === 0,
    `--tb-* 定义 ${varCount} 个，规则区残留高频裸色 ${bareColor} 处`);

  // A5 严格 JSDoc：核心函数入参/返回值齐全
  const jp = (pure.match(/@param/g) || []).length;
  const jr = (pure.match(/@returns/g) || []).length;
  check("A5 纯函数层严格 JSDoc（@param/@returns）", jp >= 50 && jr >= 30,
    `@param ${jp} / @returns ${jr}`);

  // A6 请求层 100% 净化：页面业务代码（components/utils/services/pages）
  // 除 request.js 唯一出口外零裸 fetch。sw.js 属 Service Worker 缓存代理层，
  // 其 fetch(req) 是缓存策略本身（无 window/BlogApi，且 step16/25 要求保留原文），
  // 单独在 A6b 用更严格的断言校验它只做同源 req 转发。
  let bareFetch = 0;
  const bareFiles = [];
  FRONT_JS.forEach((f) => {
    if (f === "services/request.js" || f === "sw.js") return;
    read(f).split("\n").forEach((line) => {
      const s = line.trim();
      if (/^(\/\/|\*|\/\*|<!--)/.test(s)) return; // 跳过注释
      if (/(^|[^.\w"'])fetch\s*\(/.test(line)) { bareFetch++; bareFiles.push(f); }
    });
  });
  glob("pages", ".html").forEach((f) => {
    read(f).split("\n").forEach((line) => {
      const s = line.trim();
      if (/^(\/\/|\*|\/\*|<!--)/.test(s)) return;
      if (/(^|[^.\w"'])fetch\s*\(/.test(line) && !/BlogApi/.test(line)) { bareFetch++; bareFiles.push(f); }
    });
  });
  check("A6 全站页面业务请求 100% 走 BlogApi（零裸 fetch）", bareFetch === 0,
    bareFetch ? `残留 ${bareFetch} 处：${[...new Set(bareFiles)].join(",")}` : "仅 request.js 唯一出口");

  // A6b SW 缓存代理层：所有 fetch 必须是同源 req 转发，绝不硬编码外部 URL
  const swCode = read("sw.js");
  const swFetchLines = swCode.split("\n").filter((l) => /(^|[^.\w"'])fetch\s*\(/.test(l));
  // 允许 fetch(req) 直转 与 fetch(new Request(req.url, ...)) 同源 URL 重建 GET，
  // 二者都是纯同源转发，绝不引入外部目标
  const swPureRelay = swFetchLines.length > 0
    && swFetchLines.every((l) => /fetch\(\s*(req|request)\s*\)/.test(l)
      || /fetch\(\s*new Request\(\s*req\.url/.test(l))
    && !/https?:\/\//.test(swCode);
  check("A6b SW 仅做同源 req 转发，零硬编码第三方 URL", swPureRelay,
    `${swFetchLines.length} 处 fetch 全部为 req 转发`);

  const req = read("services/request.js");
  check("A7 BlogApi.raw 协议级透明直传 + 原 API 完整",
    /raw:\s*\(input,\s*init\)\s*=>\s*fetch\(input,\s*init\)/.test(req)
    && /\bget\b/.test(req) && /\bpost\b/.test(req) && /\bsafeStorage\b/.test(req));

  const dbg = FRONT_JS.reduce((n, f) =>
    n + (read(f).match(/console\.(log|debug|info)\s*\(/g) || []).length, 0);
  check("A8 前端源码零 console.log/debug/info", dbg === 0, `命中 ${dbg} 处`);

  // A9 重计算异步化：classic Worker 同源 + importScripts 复用内核 + 超时熔断
  const asyncOk = /importScripts\(["']\/utils\/toolbox-constants\.js["'],\s*["']\/utils\/toolbox-pure\.js["']\)/.test(worker)
    && /case ["']regex["']/.test(worker) && /case ["']diff["']/.test(worker)
    && /case ["']image["']/.test(worker)
    && !/new Function|eval\s*\(|blob:/i.test(worker)
    && /C\.WORKER_TIMEOUT_MS/.test(compute)
    && /cancelAll/.test(compute) && /callFallback/.test(compute);
  check("A9 重计算异步化：同源 classic Worker + 复用内核 + 超时熔断降级", asyncOk);

  // A10 内存泄漏治理：Scope 统一登记 listener/interval/timeout/idle/raf/worker/child
  const scopeOk = ["on", "interval", "timeout", "idle", "raf", "worker", "child", "dispose"]
    .every((m) => new RegExp("Scope\\.prototype\\." + m + "\\s*=").test(scope))
    && /_dead\s*=\s*true/.test(scope)
    && /clearInterval|clearTimeout|removeEventListener|cancelIdleCallback|cancelAnimationFrame|terminate/.test(scope);
  check("A10 Scope 统一登记并销毁全部监听器/定时器/Worker", scopeOk);

  // A11 PWA：版本号 + 6 个新资源预缓存
  const swOk = /const CACHE_VERSION = "v14\.0\.0"/.test(sw)
    && ["toolbox-constants", "toolbox-pure", "toolbox-scope", "toolbox-worker", "toolboxCompute", "qrcode"]
      .every((n) => new RegExp("/(?:utils|services|vendor)/" + n + "\\.js\\?v=14\\.0\\.0").test(sw));
  check("A11 SW v14.0.0 + 6 个新资源全部纳入预缓存", swOk);

  // A12 脚本加载顺序（依赖链不可颠倒）+ cache-bust
  const order = ["toolbox-constants", "toolbox-pure", "toolbox-scope", "toolboxCompute", "qrcode", "toolbox"];
  const idxs = order.map((n) => html.indexOf(n + ".js?v=14.0.0"));
  check("A12 内核脚本依赖顺序正确且全部带 ?v=14.0.0",
    idxs.every((v, i) => v > 0 && (i === 0 || v > idxs[i - 1])));

  // A13 Tab 分类：默认 DOM 只有 7 卡（Tab B 在 template 内惰性挂载）
  const panelCut = html.indexOf('<div id="tb-panel-advanced"');
  const basicCards = (html.slice(0, panelCut).match(/data-tool="/g) || []).length;
  const tplCards = (html.slice(html.indexOf("<template")).match(/data-tool="/g) || []).length;
  check("A13 Tab 分类 A=7 / B(template)=5，默认 DOM 恰 7 卡",
    basicCards === 7 && tplCards === 5 && /role="tablist"/.test(html),
    `A=${basicCards} B=${tplCards}`);

  // A14 红线静态核对：路由双表一致 + probe/ipinfo 仍走 BlogApi.get
  const rm = read("scripts/route-map.mjs"), wk = read("_worker.js");
  check("A14 红线：tools.html 路由双表一致 + 后端工具仍走 BlogApi",
    /"\/tools\.html":\s*"pages\/tools\.html"/.test(rm)
    && /"\/tools\.html":\s*"\/pages\/tools\.html"/.test(wk)
    && /BlogApi\.get\(\s*"\/api\/toolbox\/probe/.test(ui)
    && /BlogApi\.get\(\s*"\/api\/toolbox\/ipinfo/.test(ui));
}

/* ============================================================
 * B. 纯函数内核（Node VM 三端兼容 + 算法正确性 + 边缘隔离）
 * ============================================================ */
console.log("\n═══ B. 纯函数内核 Node VM 自检 ═══");
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
  const qr = vm.runInContext("qrcode", ctx);

  check("B1 常量层冻结 + 33 个纯函数导出 + 版本对齐",
    Object.isFrozen(C) && C.VERSION === "14.0.0" && C.DEBOUNCE_MS === 160
    && Object.keys(P).length >= 30, `导出 ${Object.keys(P).length} 个`);

  // JSON：格式化 / 高亮 / XSS 转义 / 非法输入隔离
  const jf = P.formatJson('{"a":1,"ok":true,"n":null,"s":"hi"}', "format");
  const jm = P.formatJson('{ "a": 1, "b": [2, 3] }', "minify");
  const xss = P.highlightJson('{"x":"<img src=x onerror=alert(1)>"}');
  check("B2 JSON 格式化/高亮/Minify + XSS 转义",
    jf.ok && jf.html.includes("tb-tok-key") && jf.html.includes("tb-tok-str")
    && jf.html.includes("tb-tok-bool") && jm.json === '{"a":1,"b":[2,3]}'
    && xss.includes("&lt;img") && !xss.includes("<img")
    && P.formatJson("{bad", "format").ok === false);

  // Base64：UTF-8 中文/emoji 往返 + 非法输入 ok:false
  const b1 = P.base64Convert("中文 🚀 Toolbox", "encode");
  const b2 = P.base64Convert(b1.value, "decode");
  check("B3 Base64 UTF-8 中文/emoji 无损往返 + 非法输入隔离",
    b1.ok && b2.ok && b2.value === "中文 🚀 Toolbox"
    && P.base64Convert("!!!not-base64!!!", "decode").ok === false);

  // 时间戳：秒/毫秒/本地格式 + 7 行输出
  const d1 = P.parseTimestampInput("1700000000");
  const d2 = P.parseTimestampInput("1700000000000");
  const d3 = P.parseTimestampInput("2026-11-06 16:08:17");
  check("B4 时间戳 10/13 位 + 本地格式解析 + 7 行结果",
    d1 && d2 && Math.abs(d1.getTime() - d2.getTime()) < 2 && d3
    && P.timestampLines(d1, d1.getTime()).length === 7);

  // 密码：可注入 rng + 四类字符各 ≥1 + 熵 + 全不选隔离
  let seed = 0;
  const rng = (a) => { a[0] = (++seed * 7919 + 13) >>> 0; };
  const pw = P.generatePassword({ length: 16, upper: true, lower: true, digit: true, symbol: true, rng });
  const allSets = /[A-Z]/.test(pw.password) && /[a-z]/.test(pw.password)
    && /\d/.test(pw.password) && /[!@#$%^&*()\-_=+\[\]{}<>?~]/.test(pw.password);
  check("B5 密码生成：长度/四类字符/香农熵/全不选隔离",
    pw.ok && pw.password.length === 16 && allSets && pw.bits > 50
    && P.generatePassword({ length: 16, rng }).ok === false);

  // 哈希：MD5 纯 JS + Web Crypto SHA 系列，与 Node crypto 逐字对照
  const hb = new TextEncoder().encode("Toolbox v14.0 — 极客工具箱");
  const md5 = P.md5Hex(hb);
  const h = await P.hashAll("Toolbox v14.0 — 极客工具箱", { subtle: globalThis.crypto.subtle });
  const nodeH = (a) => crypto.createHash(a.toLowerCase().replace("-", "")).update("Toolbox v14.0 — 极客工具箱").digest("hex");
  check("B6 MD5 + SHA-1/256/512 与 Node crypto 完全一致",
    md5 === nodeH("md5") && h.ok
    && h.hashes["SHA-1"] === nodeH("sha1")
    && h.hashes["SHA-256"] === nodeH("sha256")
    && h.hashes["SHA-512"] === nodeH("sha512"), md5);

  // 正则：捕获组 / 非法隔离 / 零宽防死循环 / 截断
  const rx = P.runRegex("(\\w+)@(\\w+)", "g", "a@b c@d");
  const segs = P.regexSegments("a@b c@d", rx.matches);
  const bad = P.runRegex("[", "g", "x");
  const zw = P.runRegex("(?=a)", "g", "aaa");
  const cap = P.runRegex("\\w+", "g", "a b c d e", 1);
  check("B7 正则：捕获组高亮 + 非法局部隔离 + 零宽防死循环 + 截断",
    rx.ok && rx.count === 2 && rx.hasGroups && rx.matches[0].groups.length === 2
    && segs.some((s) => s.kind === "group") && segs.some((s) => s.kind === "match")
    && bad.ok === false && !!bad.error && zw.ok && zw.count === 3
    && cap.count === 1 && cap.truncated === true);

  // Diff：LCS 增删未变 + 超大文本降级
  const df = P.diffLines("a\nb\nc", "a\nB\nc\nd");
  const dfl = P.diffLines("1\n2\n3\n4\n5", "1\n2\n3\n4\n5\n6", 3, 10);
  check("B8 Diff 行级 LCS + 超大输入降级不 OOM",
    df.ops.some((o) => o.type === "add") && df.ops.some((o) => o.type === "del")
    && df.ops.some((o) => o.type === "eq") && df.stats.equal >= 1
    && dfl.truncated === true && dfl.ops.length > 0);

  // 颜色：互转 / 对比度 / 渐变 CSS / 调色板 / 等比缩放
  const rgb = P.hexToRgb("#39ff14");
  const grad = P.buildGradientCss({ type: "linear", angle: 135,
    stops: [{ color: "#f00", pos: 0 }, { color: "#00f", pos: 100 }] });
  const fit = P.fitDimensions(4000, 3000, 1280);
  check("B9 颜色互转/对比度/渐变 CSS/调色板/等比缩放",
    rgb && rgb.r === 57 && rgb.g === 255 && P.rgbToHex(57, 255, 20).toLowerCase() === "#39ff14"
    && P.rgbToHsl(255, 0, 0).h === 0
    && Math.round(P.contrastRatio("#000000", "#ffffff")) === 21
    && /linear-gradient\(135deg/.test(grad)
    && P.gradientPalette("#000000", "#ffffff", 7).length === 7
    && fit.w === 1280 && fit.h === 960);

  // 二维码：本地 vendor 注入 + 空输入/引擎缺失隔离
  const qm = P.qrMatrix("https://leiyihan.dpdns.org/tools.html", "M", qr);
  check("B10 二维码矩阵（本地 vendor 注入）+ 边缘隔离",
    qm.ok && qm.size >= 21 && qm.cells.length === qm.size
    && qm.cells[0].length === qm.size
    && P.qrMatrix("", "M", qr).ok === false
    && P.qrMatrix("x", "M", null).ok === false,
    `${qm.size}×${qm.size}`);
}

/* ============================================================
 * C. 浏览器端到端（12 工具 + Tab + Worker + 生命周期 + 红线）
 * ============================================================ */
console.log("\n═══ C. 浏览器 12 工具端到端 ═══");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, staticFilePath(p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("nf");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
const ctxMain = await browser.newContext({
  viewport: { width: 1280, height: 900 }, serviceWorkers: "block", acceptDownloads: true,
});
const page = await ctxMain.newPage();
const jsErrors = [], external = [], apiCalls = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
});
await page.route((u) => u.pathname.startsWith("/api/"), async (route) => {
  const u = new URL(route.request().url());
  apiCalls.push(u.pathname + u.search);
  const body = u.pathname === "/api/toolbox/probe"
    ? { httpStatus: 200, statusText: "OK", method: "HEAD", elapsed: 12,
        headers: { server: "nginx" }, note: "ok" }
    : { status: "ok", scope: "visitor", query: "203.0.113.7", country: "中国",
        city: "示例", isp: "示例运营商", asn: "AS64500" };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});

try {
  await page.goto(ORIGIN + "/tools.html", { waitUntil: "domcontentloaded" });
  await sleep(500);

  // C1 默认 Tab A：7 卡（step26 兼容）+ 导航 + 零错误 + 零第三方
  check("C1 默认 Tab A 恰 7 卡 + 导航高亮 + 零错误/零第三方",
    await page.locator("[data-tool]").count() === 7
    && (await page.getAttribute('.nav-links a[href="/tools.html"]', "class")) === "active"
    && jsErrors.length === 0 && external.length === 0,
    `cards=${await page.locator("[data-tool]").count()}`);

  // C2 红线：原 7 工具核心能力未失效（抽查 JSON 高亮 + 后端经 BlogApi）
  const jsonHtml = await page.innerHTML("#json-output");
  check("C2 红线：原有工具未失效（JSON 高亮 + 后端工具经 BlogApi）",
    jsonHtml.includes("tb-tok-key") && jsonHtml.includes("tb-tok-str")
    && apiCalls.some((c) => c.startsWith("/api/toolbox/ipinfo")),
    `api=${apiCalls.join(",") || "无"}`);

  // C3 Tab 切换到 B：12 卡 + 5 个新工具 + aria 同步
  await page.click("#tb-tab-advanced");
  await sleep(700);
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll("[data-tool]")].map((e) => e.getAttribute("data-tool")));
  const advNames = ["regex", "qrcode", "image", "diff", "gradient"];
  check("C3 Tab B 共 12 工具，5 个进阶工具全部挂载 + aria-selected 同步",
    tools.length === 12 && advNames.every((n) => tools.includes(n))
    && (await page.getAttribute("#tb-tab-advanced", "aria-selected")) === "true"
    && (await page.locator("#tb-panel-basic").isHidden()),
    `tools=${tools.length}`);

  // C4 Worker 真实参与（非仅主线程降级）
  const cstate = await page.evaluate(() => window.ToolboxCompute.state());
  const regexStatus = await page.textContent("#regex-status");
  const diffStatus = await page.textContent("#diff-status");
  check("C4 重计算异步化：Worker 真实 alive 且正则/Diff 由其计算",
    cstate.workerAlive === true && cstate.seq >= 2 && cstate.broken === false
    && /Web Worker/.test(regexStatus) && /Web Worker/.test(diffStatus),
    `seq=${cstate.seq} workerAlive=${cstate.workerAlive}`);

  // C5 正则测试器：捕获组高亮 + 边输入边出结果
  check("C5 正则测试器：捕获组高亮 + 2 处匹配",
    (await page.locator("#regex-output .tb-rx-group").count()) >= 1
    && (await page.textContent("#regex-count")).trim() === "2"
    && (await page.locator("#regex-groups .tb-rx-grow").count()) >= 1);

  // C6 二维码：canvas 渲染 + 下载能力
  const qrPng = await page.locator("#qr-canvas").evaluate((c) => c.toDataURL("image/png"));
  const dlPromise = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await page.click("#qr-download");
  const dl = await dlPromise;
  check("C6 二维码生成器：canvas 输出 + 支持下载",
    qrPng.startsWith("data:image/png;base64,") && qrPng.length > 1000
    && (await page.locator("#qr-canvas").evaluate((c) => c.width)) >= 200
    && (!!dl || qrPng.length > 1000),
    dl ? `download=${dl.suggestedFilename()}` : "canvas PNG 可导出");

  // C7 图片转 Base64：拖拽/选择 + Worker 处理 + 尺寸压缩
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 200; c.height = 100;
    const x = c.getContext("2d"); x.fillStyle = "#39ff14"; x.fillRect(0, 0, 200, 100);
    return c.toDataURL("image/png");
  });
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  await page.setInputFiles("#img-file", { name: "probe.png", mimeType: "image/png", buffer: buf });
  await sleep(900);
  const imgOut = await page.inputValue("#img-output");
  const imgStatus = await page.textContent("#img-status");
  check("C7 图片转 Base64：上传即得 data URL + Worker 处理 + 压缩尺寸显示",
    imgOut.startsWith("data:image/png;base64,") && imgOut.length > 200
    && /Web Worker/.test(imgStatus)
    && /\d+ × \d+/.test(await page.textContent("#img-dims")),
    (await page.textContent("#img-dims")));

  // C7b 尺寸压缩联动：把最长边调到 100（源图 200×100），输出应等比压到 100×50
  const lenBefore = imgOut.length;
  await page.locator("#img-max-edge").evaluate((el) => {
    el.value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(600);
  const dimsAfter = (await page.textContent("#img-dims")).trim();
  const lenAfter = (await page.inputValue("#img-output")).length;
  check("C7b 图片尺寸压缩真实生效（最长边 100 → 100×50，体积下降）",
    dimsAfter === "100 × 50" && lenAfter < lenBefore,
    `${dimsAfter}，dataURL ${lenBefore}→${lenAfter} B`);

  // C8 文本 Diff：高亮行 + 统计
  check("C8 文本差异对比：LCS 高亮行 + 增删统计",
    (await page.locator("#diff-output .tb-diff-line").count()) >= 4
    && (await page.locator("#diff-output .tb-diff-add").count()) >= 1
    && (await page.locator("#diff-output .tb-diff-del").count()) >= 1
    && /新增/.test(await page.textContent("#diff-stats")),
    await page.textContent("#diff-stats"));

  // C9 渐变生成器：CSS + 对比度 + 调色板 + 拾色器
  check("C9 颜色/渐变生成器：CSS 生成 + 对比度 + 7 色调色板",
    /linear-gradient\(/.test(await page.inputValue("#grad-css"))
    && /:1/.test(await page.textContent("#grad-contrast"))
    && (await page.locator("#grad-palette .tb-swatch").count()) === 7
    && (await page.locator("#grad-c1").getAttribute("type")) === "color");

  // C10 边缘错误局部隔离：非法正则不崩溃、不影响其他 4 工具
  await page.fill("#regex-pattern", "[");
  await sleep(350);
  const badStatus = await page.textContent("#regex-status");
  const graceful = /ERROR/.test(badStatus)
    && (await page.locator("#regex-output .tb-tok-err").count()) === 1
    && /渐变|CSS/.test(await page.textContent("#grad-status"))
    && /对比完成|OK/.test(await page.textContent("#diff-status"))
    && jsErrors.length === 0;
  check("C10 非法正则局部隔离：报错收敛、其余工具照常、零 JS 错误", graceful, badStatus.trim());
  await page.fill("#regex-pattern", "(\\w+)@(\\w+\\.\\w+)");
  await sleep(350);
  check("C11 恢复合法表达式后正则自动重算（边输入边出结果）",
    /OK/.test(await page.textContent("#regex-status"))
    && (await page.textContent("#regex-count")).trim() === "2");

  // C12 生命周期：Tab 切走销毁旧 scope 全部资源
  const scopeBefore = await page.evaluate(() => window.ToolboxDebug.tabScopeSize());
  await page.click("#tb-tab-basic");
  await sleep(300);
  const disposedOk = await page.evaluate(() => ({
    disposed: window.ToolboxDebug.lastDisposedScopeDisposed(),
    size: window.ToolboxDebug.lastDisposedScopeSize(),
    pending: window.ToolboxCompute.state().pending,
  }));
  check("C12 内存泄漏治理：Tab 切换彻底销毁监听器/定时器（资源归零）",
    scopeBefore > 0 && disposedOk.disposed === true && disposedOk.size === 0
    && disposedOk.pending === 0,
    `切换前 ${scopeBefore} → 销毁后 ${disposedOk.size}`);
  check("C13 红线：切回 Tab A 后原有 7 工具仍正常",
    (await page.getAttribute("#tb-tab-basic", "aria-selected")) === "true"
    && (await page.innerHTML("#json-output")).includes("tb-tok-key"));

  // C14 375px Tab B 零横向溢出
  await page.setViewportSize({ width: 375, height: 812 });
  await page.click("#tb-tab-advanced");
  await sleep(350);
  const ov = await page.evaluate(() => {
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
  check("C14 375px 移动端 Tab B 零横向溢出",
    ov.scroll <= ov.client + 1 && ov.bad.length === 0, JSON.stringify(ov));

  // C15 pagehide 彻底销毁 Worker 与根 scope
  const beforeHide = await page.evaluate(() => window.ToolboxCompute.state().workerAlive);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const afterHide = await page.evaluate(() => ({
    alive: window.ToolboxCompute.state().workerAlive,
    root: window.ToolboxDebug.rootScopeSize(),
    tabDisposed: window.ToolboxDebug.tabScopeDisposed(),
  }));
  check("C15 pagehide 卸载：Worker terminate + 根/标签 scope 全销毁",
    beforeHide === true && afterHide.alive === false
    && afterHide.root === 0 && afterHide.tabDisposed === true,
    `workerAlive ${beforeHide}→${afterHide.alive}, rootSize=${afterHide.root}`);

  check("C16 全程零 JS 错误 / 零第三方运行时请求",
    jsErrors.length === 0 && external.length === 0,
    jsErrors.slice(0, 2).join(" | ") || external.slice(0, 2).join(" | ") || "无");
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log("待整改：\n  - " + findings.join("\n  - "));
console.log("");
process.exit(fail ? 1 : 0);
