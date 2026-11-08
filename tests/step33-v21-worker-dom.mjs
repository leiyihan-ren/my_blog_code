/* ============================================================
 * step33-v21-worker-dom.mjs —— v21.0 模块一-3 / 模块二-1 验收
 * ------------------------------------------------------------
 * Web Worker 异步计算中心强化 + DOM 渲染拦截（批量挂载 / rAF 分片）。
 *
 * 事实基线（如实披露）：regex / diff 的「重计算」自 v14 起就经
 * ToolboxCompute 派发到 classic Worker，Worker 内核里已调用
 * P.regexSegments / P.diffLines。v21 不重复搬迁算法，而是治理真正的
 * 主线程瓶颈：① 成千上万个 span/div 逐节点 appendChild 引发的强制
 * 重排；② 长文本防抖期间旧计算乱序回写、重复全量重建 DOM。
 *
 * 四段式（与 step27/29/30 同风格）：
 *   A. 静态门禁：调度器 / Compute slot / 分片 / 内核脚本链 / SW / 架构
 *   B. Node VM 单测 RenderScheduler：同步挂载 / rAF 分片 / 抢占 / 节流 / stats
 *   C. Node VM 单测 ToolboxCompute slot：抢占取消 / pending 契约 / dispose
 *   D. 浏览器端到端：真实 Worker 参与 + 长文本分片 + DOM 结构等价 + 零异常
 *
 * 不修改任何既有套件；本套件只做增量验证。
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import { staticFilePath } from "../scripts/route-map.mjs";
import pkg from "playwright";
const { chromium } = pkg;

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\r\n])[ \t]*\/\/[^\n]*/g, "$1");

/* ============================================================
 * A. 静态门禁（零浏览器 / 零 npm 依赖）
 * ============================================================ */
console.log("═══ A. 静态门禁 ═══");
{
  const sched = read("utils/render-scheduler.js");
  check("A1 render-scheduler.js 落盘且为 classic UMD（root/window/self/globalThis 三端）",
    /\(function \(root\)/.test(sched) && /root\.RenderScheduler\s*=\s*API/.test(sched)
    && /typeof window !== "undefined" \? window/.test(sched)
    && /typeof self !== "undefined" \? self : globalThis/.test(sched));
  check("A1b 调度器实现批量挂载 / rAF 分片 / 每帧时间预算 / 抢占 / 节流",
    /createDocumentFragment/.test(sched) && /requestAnimationFrame/.test(sched)
    && /FRAME_BUDGET_MS\s*=\s*8/.test(sched) && /MIN_BATCH/.test(sched)
    && /SYNC_LIMIT\s*=\s*160/.test(sched)
    && /function mount\(/.test(sched) && /function schedule\(/.test(sched)
    && /function cancel\(/.test(sched) && /counters\.merged\+\+/.test(sched));
  check("A1c 调度器零 console / 零裸 fetch / 零 eval / 冻结 API",
    !/console\.(log|debug|info)\s*\(/.test(strip(sched))
    && !/(^|[^.\w"'])fetch\s*\(/.test(strip(sched))
    && !/eval\s*\(|new Function/.test(strip(sched))
    && /Object\.freeze\(\{\s*version/.test(sched));
  check("A1d 调度器挂载后暴露 stats() 只读诊断",
    /function stats\(\)/.test(sched) && /stats:\s*stats/.test(sched)
    && /syncMounts|chunkedMounts|frames/.test(sched));

  const compute = read("services/toolboxCompute.js");
  check("A2 ToolboxCompute 支持第 4 参 slot + supersede 抢占",
    /function exec\(cmd, payload, fallback, slot\)/.test(compute)
    && /function supersede\(slot\)/.test(compute)
    && /if \(slot\) supersede\(slot\)/.test(compute)
    && /slots\[slot\]\s*=\s*id/.test(compute));
  check("A2b cancelAll / failAll / onmessage / timeout / dispose 均正确维护 slots",
    (compute.match(/delete slots\[/g) || []).length >= 4
    && /slots = Object\.create\(null\)/.test(compute)
    && /superseded\+\+/.test(compute));
  check("A2c stats() 暴露抢占计数，state() 契约逐字不变",
    /function stats\(\)/.test(compute) && /superseded:\s*superseded/.test(compute)
    && /stats:\s*stats/.test(compute)
    && /workerAlive: !!worker/.test(compute) && /pending: Object\.keys\(waiting\)\.length/.test(compute)
    && /callFallback/.test(compute) && /C\.WORKER_TIMEOUT_MS/.test(compute));

  const diff = read("modules/toolbox/diff.js"), rx = read("modules/toolbox/regex.js");
  check("A3 diff.js / regex.js 使用 kit.Scheduler.mount（或 mountInto）批量挂载",
    /S\.mount\(host, ops, makeLine, \{ key: "tb-diff-lines" \}\)/.test(diff)
    && /S\.mount\(host, list, makeNode, \{ key: key \}\)/.test(rx)
    && /function mountInto\(/.test(rx));
  check("A3b 两个分片均带 slot 抢占（第 4 参 diff / regex）",
    /Compute\.exec\("diff",[\s\S]*?"diff"\)/.test(diff)
    && /Compute\.exec\("regex",[\s\S]*?"regex"\)/.test(rx));
  check("A3c 调度器缺失时有等价 DocumentFragment 降级路径（优雅降级）",
    /else \{[\s\S]*?createDocumentFragment/.test(diff)
    && /else \{[\s\S]*?createDocumentFragment/.test(rx));
  check("A3d regex 三容器统一按 key 抢占，非法分支也清空并取消在途分片",
    (rx.match(/"tb-regex-(segments|list|groups)"/g) || []).length >= 6
    && /正则非法/.test(rx) && /function \(\) \{ return null; \}/.test(rx));
  check("A3e 分片零 console / 零裸依赖 / 零裸 fetch（step29 A1c 兼容）",
    [diff, rx].every((s) => {
      const c = strip(s);
      return !/(?<![.\w$])(P\.|C\.|Compute\.|setStatus\(|scopedDebounce\(|guarded\(|text\(|toast\(|\$\()/.test(c)
        && !/console\.(log|debug|info)\s*\(/.test(c)
        && !/(^|[^.\w"'])fetch\s*\(/.test(c);
    }));

  const ui = read("components/toolbox.js");
  check("A4 toolkit 的 kit 注入 Scheduler（唯一注入点）",
    /var Scheduler = window\.RenderScheduler \|\| null/.test(ui)
    && /P: P, C: C, Compute: Compute, Scheduler: Scheduler/.test(ui));

  const html = read("pages/tools.html");
  const iSched = html.indexOf("/utils/render-scheduler.js");
  const iCompute = html.indexOf("toolboxCompute.js?v=15.0.0");
  const iToolbox = html.indexOf("components/toolbox.js?v=15.0.0");
  check("A5 tools.html 引入 render-scheduler.js 且先于 toolbox.js 加载",
    iSched > 0 && iSched < iToolbox,
    `sched=${iSched} toolbox=${iToolbox}`);
  const chain = ["toolbox-constants", "toolbox-pure", "toolbox-scope", "toolboxCompute", "qrcode", "toolbox"];
  const idxs = chain.map((n) => html.indexOf(n + ".js?v=15.0.0"));
  check("A5b 六个内核 <script> 顺序 + ?v=15.0.0 计数契约零改动（step29 A3c）",
    idxs.every((v, i) => v > 0 && (i === 0 || v > idxs[i - 1]))
    && (html.match(/\?v=15\.0\.0/g) || []).length >= 7);

  const sw = read("sw.js");
  check("A6 SW 预缓存 + Cache-First 正则覆盖 render-scheduler.js",
    /"\/utils\/render-scheduler\.js"/.test(sw)
    && /TOOLBOX_IMMUTABLE_PATH = [^\n]*utils\\\/render-scheduler\\\.js/.test(sw));
  const arch = read("src/shared/manifest.mjs");
  check("A7 shared 域登记 render-scheduler.js（arch-audit 零 unclassified）",
    /"utils\/render-scheduler\.js"/.test(arch));

  const worker = read("utils/toolbox-worker.js");
  check("A8 重计算确在 classic Worker 内核（regexSegments / diffLines 于 Worker 内）",
    /importScripts\(\s*"\/utils\/toolbox-constants\.js",\s*"\/utils\/toolbox-pure\.js"\s*\)/.test(worker)
    && /case "regex"/.test(worker) && /P\.regexSegments\(m\.text, r\.matches\)/.test(worker)
    && /case "diff"/.test(worker) && /P\.diffLines\(m\.a, m\.b\)/.test(worker));
}

/* ============================================================
 * B. Node VM 单测 RenderScheduler（零浏览器）
 * ============================================================ */
console.log("\n═══ B. Node VM 单测 RenderScheduler ═══");
function harness() {
  let clock = 0;
  const rafQueue = [];
  const doc = {
    createDocumentFragment() {
      const f = { __frag: true, children: [] };
      f.appendChild = (n) => { f.children.push(n); return n; };
      return f;
    },
    createElement(tag) { return { tagName: tag, className: "", textContent: "" }; },
  };
  const makeHost = () => {
    const h = { children: [], _text: "" };
    Object.defineProperty(h, "textContent", {
      get() { return h._text; },
      set(v) { h._text = v; if (v === "") h.children = []; },
    });
    h.appendChild = (n) => {
      if (n && n.__frag) { for (const c of n.children) h.children.push(c); }
      else h.children.push(n);
      return n;
    };
    return h;
  };
  const ctx = {
    console, Date, Object, Array, Math, String, Number, isFinite, Promise, Error,
    document: doc,
    performance: { now: () => clock++ },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
  };
  return {
    ctx, makeHost, rafQueue,
    drain(max = 2000) { let n = 0; while (rafQueue.length && n++ < max) { const q = rafQueue.splice(0); q.forEach((fn) => fn()); } },
  };
}
{
  const h = harness();
  vm.createContext(h.ctx);
  vm.runInContext(read("utils/render-scheduler.js"), h.ctx, { filename: "render-scheduler.js" });
  const S = h.ctx.RenderScheduler;
  check("B1 UMD 挂载成功且 API 冻结 / 版本号 21.0.0",
    !!S && Object.isFrozen(S) && S.version === "21.0.0"
    && ["mount", "schedule", "cancel", "cancelAll", "stats"].every((k) => typeof S[k] === "function"));

  // 小结果：同步 DocumentFragment 一次挂载，DOM 逐字成型、零 rAF
  const host1 = h.makeHost();
  const before = S.stats();
  const r1 = S.mount(host1, [1, 2, 3], (n) => ({ tagName: "span", textContent: n }), { key: "t1" });
  check("B2 小结果（<=160）同步一次挂载，mode=sync / done=true / 零 rAF 排队",
    r1.mode === "sync" && r1.done === true && host1.children.length === 3
    && h.rafQueue.length === 0 && S.stats().syncMounts === before.syncMounts + 1);

  // 大结果：rAF 分片，按 8ms 帧预算跨多帧，最终节点数完整
  const host2 = h.makeHost();
  const items = Array.from({ length: 400 }, (_, i) => i);
  const r2 = S.mount(host2, items, (n) => ({ tagName: "div", textContent: n }), { key: "t2", syncLimit: 20 });
  check("B3 超大结果走 rAF 分片：mode=chunked / 起始未 done / 有在途帧",
    r2.mode === "chunked" && r2.done === false && h.rafQueue.length === 1);
  h.drain();
  check("B3b 分片跨多帧完成，节点数与顺序逐字完整（400 项 0→399）",
    r2.done === true && host2.children.length === 400
    && host2.children[0].textContent === 0 && host2.children[399].textContent === 399
    && S.stats().frames > 1 && S.stats().chunkedMounts >= 1);

  // 同 key 抢占：新任务取消在途旧分片，旧分片帧不再回写
  const host3 = h.makeHost();
  const old = S.mount(host3, Array.from({ length: 300 }, (_, i) => i), (n) => ({ v: n }), { key: "race", syncLimit: 20 });
  const fresh = S.mount(host3, [9, 9, 9], (n) => ({ v: n }), { key: "race" });
  h.drain();
  check("B4 同 key 抢占：新任务取消旧在途分片，仅最新结果留在 DOM",
    old.done === false && fresh.done === true && host3.children.length === 3
    && host3.children.every((c) => c.v === 9) && S.stats().cancelled >= 1);

  // schedule：同 key 连续触发只保留最后一次（rAF 节流合并）
  let ran = [];
  S.schedule("debounce", () => ran.push("first"));
  S.schedule("debounce", () => ran.push("second"));
  S.schedule("debounce", () => ran.push("third"));
  const merged = S.stats().merged;
  h.drain();
  check("B5 schedule 同 key 节流合并：只执行最后一次，merged>=2",
    ran.length === 1 && ran[0] === "third" && merged >= 2);

  const st = S.stats();
  check("B6 stats() 诊断计数自洽（pending 清零 / 冻结 / 字段齐备）",
    Object.isFrozen(st) && st.pending === 0
    && st.syncMounts >= 2 && st.chunkedMounts >= 2 && st.nodes >= 400
    && st.syncLimit === 160 && st.frameBudgetMs === 8,
    `nodes=${st.nodes} frames=${st.frames} sync=${st.syncMounts} chunked=${st.chunkedMounts}`);
}

/* ============================================================
 * C. Node VM 单测 ToolboxCompute slot 抢占（零浏览器）
 * ============================================================ */
console.log("\n═══ C. Node VM 单测 ToolboxCompute slot ═══");
async function computeHarness() {
  const ctx = {
    console, Date, Object, Array, Math, String, Number, Promise, Error,
    setTimeout, clearTimeout,
    ToolboxConstants: Object.freeze({ WORKER_TIMEOUT_MS: 4000, VERSION: "15.0.0" }),
  };
  ctx.window = ctx;
  ctx.window.Worker = class MockWorker {
    constructor(url) { this.url = url; this.sent = []; this.onmessage = null; this.onerror = null; this.onmessageerror = null; ctx.__lastWorker = this; }
    postMessage(m) { this.sent.push(m); }
    terminate() { this.terminated = true; }
  };
  vm.createContext(ctx);
  vm.runInContext(read("services/toolboxCompute.js"), ctx, { filename: "toolboxCompute.js" });
  return ctx;
}
{
  const ctx = await computeHarness();
  const C = ctx.window.ToolboxCompute;
  const fb = () => ({ ok: true, count: 0 });
  check("C1 ToolboxCompute 挂载成功，stats() / exec 第 4 参可用",
    !!C && typeof C.stats === "function" && typeof C.exec === "function"
    && C.state().pending === 0);

  const p1 = C.exec("regex", { pattern: "a" }, fb, "regex");
  const p2 = C.exec("regex", { pattern: "b" }, fb, "regex");
  const r1 = await p1;
  check("C2 同 slot 新任务抢占：旧任务立即以 cancelled/superseded 结束",
    r1.cancelled === true && r1.superseded === true && r1.engine === "cancelled"
    && C.stats().superseded === 1);

  const sent = ctx.__lastWorker.sent;
  const lastId = sent[sent.length - 1].id;
  ctx.__lastWorker.onmessage({ data: { id: lastId, ok: true, engine: "worker", count: 1 } });
  const r2 = await p2;
  check("C2b 最新任务正常由 Worker 结果 resolve（engine=worker）",
    r2.ok !== false && r2.engine === "worker" && r2.count === 1
    && C.state().pending === 0 && !r2.cancelled);

  const p3 = C.exec("diff", { a: "x", b: "y" }, fb, "diff");
  const snapBefore = C.stats();
  C.cancelAll();
  const r3 = await p3;
  check("C3 cancelAll() 后 state().pending===0（step27/28 硬契约不变）",
    r3.cancelled === true && C.state().pending === 0 && C.stats().pending === 0
    && snapBefore.pending === 1);

  C.dispose();
  check("C4 dispose() 清空 slots 与在途、worker 已终止",
    C.stats().slots === 0 && C.stats().pending === 0 && ctx.__lastWorker.terminated === true);
}

/* ============================================================
 * D. 浏览器端到端（真实 Worker + 长文本分片 + DOM 等价）
 * ============================================================ */
console.log("\n═══ D. 浏览器端到端 ═══");
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
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
await page.route((u) => u.pathname.startsWith("/api/"), (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
try {
  await page.goto(`${ORIGIN}/tools.html`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  check("D1 tools.html 200 + 调度器 / Compute.stats 均挂载，零未捕获异常",
    await page.evaluate(() => !!window.RenderScheduler && typeof window.ToolboxCompute.stats === "function")
    && jsErrors.length === 0, jsErrors.slice(0, 2).join(";"));

  await page.click("#tb-tab-advanced");
  await page.waitForTimeout(900);
  const domOk = await page.evaluate(() => ({
    regexCount: document.querySelectorAll("#regex-output span").length,
    diffLines: document.querySelectorAll("#diff-output .tb-diff-line").length,
    regexStatus: (document.getElementById("regex-status") || {}).textContent || "",
    diffStatus: (document.getElementById("diff-status") || {}).textContent || "",
  }));
  check("D2 Tab B 经调度器挂载后 DOM 结构与旧实现等价（高亮 span / Diff 行）",
    domOk.regexCount >= 1 && domOk.diffLines >= 1
    && /Web Worker/.test(domOk.regexStatus) && /Web Worker/.test(domOk.diffStatus),
    `regexSpan=${domOk.regexCount} diffLine=${domOk.diffLines}`);

  // 长文本：制造 > 160 个高亮片段，验证 rAF 分片真实触发且结果完整
  const longText = ("abc123 ".repeat(400));
  await page.fill("#regex-pattern", "\\d+");
  await page.fill("#regex-input", longText);
  await page.waitForTimeout(900);
  const chunk = await page.evaluate(() => ({
    stats: window.RenderScheduler.stats(),
    nodes: document.querySelectorAll("#regex-output span").length,
    countText: (document.getElementById("regex-count") || {}).textContent || "",
    compute: window.ToolboxCompute.stats(),
  }));
  // 注：801 节点在真实浏览器 8ms 帧预算内可能一帧挂完（frames=1 属正常「能快则快」），
  // 多帧预算逻辑由 B3b 的强制时钟单测验证；slot 抢占由 C2 严格验证。
  // 此处只需确认长文本确实走了 chunked 分片路径（而非退化成逐节点 appendChild）。
  check("D3 长文本高亮：>160 片段走 rAF 分片路径（chunkedMounts/frames 增长）",
    chunk.stats.chunkedMounts >= 1 && chunk.stats.frames >= 1,
    `chunked=${chunk.stats.chunkedMounts} frames=${chunk.stats.frames} superseded=${chunk.compute.superseded}`);
  check("D3b 分片结果完整（高亮节点 >= 160，匹配数一致，无异常）",
    chunk.nodes >= 160 && /\d/.test(chunk.countText) && jsErrors.length === 0,
    `nodes=${chunk.nodes} count=${chunk.countText}`);

  // 连续快速输入：slot 抢占 + 同 key mount 抢占，最终 DOM 只保留最新结果，无乱序
  for (let i = 0; i < 6; i++) {
    await page.fill("#regex-input", ("x".repeat(20 + i * 60)) + " abc " + i);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(900);
  const final = await page.evaluate(() => ({
    text: (document.getElementById("regex-input") || {}).value || "",
    errors: window.ToolboxCompute.state().pending,
    sched: window.RenderScheduler.stats().pending,
  }));
  check("D4 连续输入收敛：pending 归零、调度器无悬挂任务、零 JS 异常",
    final.errors === 0 && final.sched === 0 && jsErrors.length === 0,
    `computePending=${final.errors} schedPending=${final.sched}`);

  await page.evaluate(() => window.ToolboxCompute.cancelAll());
  check("D5 页面内 cancelAll() 后 pending===0，Worker 未损坏",
    await page.evaluate(() => {
      const s = window.ToolboxCompute.state();
      return s.pending === 0 && s.broken === false;
    }));
} catch (e) {
  check("D 段执行未抛异常", false, String(e && e.message || e));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(`通过 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
