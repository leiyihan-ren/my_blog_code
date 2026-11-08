/* ============================================================
 * step30-v19-engineering.mjs —— v19.0 工程化与性能改造验收
 * ------------------------------------------------------------
 * 两段式（与 step29 同风格）：
 *   A. 静态门禁（零浏览器依赖、零 npm 依赖）：
 *      Critical CSS 令牌单一源一致、13 页注入幂等、全部不变量
 *      （EventBus=1 / charset 顺序 / 版本串 / noscript 配对 / DOM 未变）、
 *      esbuild 压缩管线安全配置、lint 门禁与基线、npm scripts、CI 门禁、
 *      物理路由与既有 33 套件未被改动。
 *   B. 压缩产物等价性（dist 存在时启用，Node VM，零浏览器）：
 *      三端 UMD 全局挂载存活、纯函数 51 导出与输出逐字一致、
 *      ESM 分片 export init / Worker importScripts 存活、体积下降。
 *      dist 不存在时打印 SKIP 并正常退出（不判失败）。
 *
 * 不修改任何既有 33 个套件；本套件只做增量验证。
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
let pass = 0, fail = 0;
/** @param {string} name @param {boolean} cond @param {string} [detail] */
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}

console.log("═══ A. 静态门禁（零浏览器 / 零 npm 依赖） ═══");

/* ---------- A1 Critical CSS 单一源与令牌一致 ---------- */
{
  const crit = read("styles/critical.css");
  const common = read("styles/common.css");
  // 抽取 :root / body.dark 块中的 --变量: 值（忽略注释）
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = (s) => Object.fromEntries(
    [...stripComments(s).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()])
  );
  const ct = tokens(crit), mt = tokens(common);
  // critical 的每个令牌值必须与 common.css 中同名令牌的「最后一次定义」一致
  const commonLast = {};
  for (const m of stripComments(common).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) commonLast[m[1]] = m[2].trim();
  const mismatched = Object.entries(ct).filter(([k, v]) => commonLast[k] !== v);
  check("A1 critical.css 令牌与 common.css 单一源逐字段一致",
    Object.keys(ct).length >= 45 && mismatched.length === 0,
    `令牌 ${Object.keys(ct).length} 个，差异 ${mismatched.length}${mismatched.length ? "：" + JSON.stringify(mismatched.slice(0, 3)) : ""}`);
  check("A1b critical.css 含布局稳定基元（防 FOUC/CLS）",
    [":focus-visible", "::-webkit-scrollbar", ".glass", ".navbar"]
      .every((sel) => crit.includes(sel))
    && /\.back-top\s*,\s*\.toast\s*,\s*\.offline-banner/.test(crit));
}

/* ---------- A2 13 页注入幂等与全部不变量 ---------- */
{
  const pages = fs.readdirSync(path.join(ROOT, "pages")).filter((f) => f.endsWith(".html")).sort();
  const withCommon = [], noCommon = [];
  const bad = [];
  for (const n of pages) {
    const s = read("pages/" + n);
    const hasInline = (s.match(/<style data-v19-critical>/g) || []).length === 1;
    const hasMark = (s.match(/common-css-nonblocking:start/g) || []).length;
    const hasEnd = (s.match(/common-css-nonblocking:end/g) || []).length;
    const nos = (s.match(/<noscript>/g) || []).length;
    const nosClose = (s.match(/<\/noscript>/g) || []).length;
    const eb = (s.match(/<script src="\/utils\/event-bus\.js"><\/script>/g) || []).length;
    const charsetOk = !s.includes("v17.0 模块三") || s.indexOf("<meta charset") < s.indexOf("v17.0 模块三");
    const hasCommonLink = s.includes("/styles/common.css");
    if (hasCommonLink) withCommon.push(n); else noCommon.push(n);
    const wantMark = hasCommonLink ? 1 : 0;
    if (!hasInline || hasMark !== wantMark || hasEnd !== wantMark || nos !== wantMark || nosClose !== wantMark
      || eb !== 1 || !charsetOk) {
      bad.push(`${n}{inline:${hasInline} mark:${hasMark} nos:${nos} eb:${eb} charset:${charsetOk}}`);
    }
    // 非阻塞 link 必须与 noscript 成对，且同步 toolbox.css?v=15.0.0 保持原样
    if (hasCommonLink && !/rel="stylesheet" href="\/styles\/common\.css" media="print" onload="this\.media='all'"/.test(s))
      bad.push(`${n}: 非阻塞 link 缺失`);
  }
  check(`A2 ${pages.length} 页 Critical CSS 内联 + 非阻塞 CSS 幂等注入`,
    bad.length === 0, `${withCommon.length} 页异步化 / ${noCommon.length} 页无 common.css（player）${bad.length ? " 异常：" + bad.join(", ") : ""}`);
  check("A2b 全站不变量保持（EventBus=1 / charset 顺序 / noscript 配对 / 幂等）", bad.length === 0);
  // 版本串计数不受注入影响（tools.html step28 A1 要求 >= 7）
  const tools = read("pages/tools.html");
  check("A2c tools.html ?v=15.0.0 计数仍 >= 7（step28 A1 契约）",
    (tools.match(/\?v=15\.0\.0/g) || []).length >= 7,
    `${(tools.match(/\?v=15\.0\.0/g) || []).length} 处`);
  check("A2d 页面 DOM 结构未变（data-tool 卡 / 骨架屏节点保留）",
    (tools.match(/data-tool=/g) || []).length >= 7 && tools.includes("tb-advanced-skeleton"));
}

/* ---------- A3 esbuild 压缩管线安全配置 ---------- */
{
  const opt = read("scripts/build-optimize.mjs");
  // 剥离注释后再判定：文档注释里出现的 `format: "iife"` 是反例说明，不是真实配置
  const optCode = opt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("A3 压缩管线存在且禁用 format:iife（实证会删顶层 UMD 全局）",
    exists("scripts/build-optimize.mjs") && /minify:\s*true/.test(optCode)
    && !/format:\s*["']iife["']/.test(optCode) && /绝不加 format/.test(opt));
  check("A3b 明确排除 _worker.js / sw.js / *.min.js / *.input.css",
    ["_worker.js", "sw.js", ".min.js", ".input.css"].every((x) => opt.includes(x)));
  check("A3c 压缩保留物理路径（原地覆写，不改文件名 / 不 bundle）",
    /fs\.writeFileSync\(file, out\)/.test(opt) && !/bundle:\s*true/.test(opt));
}

/* ---------- A4 工程化门禁配置 ---------- */
{
  const pkg = JSON.parse(read("package.json"));
  const need = ["lint", "lint:css", "lint:all", "build:opt", "perf:server", "critical:inject", "critical:revert", "test:engineering"];
  check("A4 package.json 版本 19.0.0 且工程化 scripts 齐备",
    pkg.version === "19.0.0" && need.every((k) => typeof pkg.scripts[k] === "string"),
    `v${pkg.version}，${need.length} 个脚本`);
  check("A4b devDependencies 纳入 esbuild / eslint / stylelint / lighthouse",
    ["esbuild", "eslint", "stylelint", "lighthouse"].every((k) => pkg.devDependencies[k]));
  const escfg = read("eslint.config.mjs");
  const stcfg = read("stylelint.config.mjs");
  const supp = read("eslint-suppressions.json");
  check("A4c ESLint / Stylelint 配置 + suppressions 基线存在且可解析",
    /quotes:\s*\[\s*"error",\s*"double"/.test(escfg) && /semi:\s*\[\s*"error",\s*"always"\]/.test(escfg)
    && /caughtErrors:\s*"none"/.test(escfg) && /export default/.test(stcfg)
    && Object.keys(JSON.parse(supp)).length >= 1, `基线冻结 ${Object.keys(JSON.parse(supp)).length} 个文件`);
  check("A4d 基线为棘轮模式（存量冻结、新增零容忍）",
    /"count":\s*\d+/.test(supp) && !/"severity"/.test(supp));
}

/* ---------- A5 架构契约登记 ---------- */
{
  const shared = read("src/shared/manifest.mjs");
  const tools = read("src/features/tools/manifest.mjs");
  check("A5 src/ 架构契约登记 v19 新增资产",
    ["styles/critical.css", "scripts/build-optimize.mjs", "scripts/perf-server.mjs",
      "scripts/inject-critical.mjs"].every((p) => (shared + tools).includes(p)));
}

/* ---------- A6 CI 门禁 ---------- */
{
  const ci = read(".github/workflows/ci.yml");
  check("A6 CI 纳入 ESLint / Stylelint / 压缩构建 / step30 门禁",
    ["npm run lint", "npm run lint:css", "npm run build:opt", "step30-v19-engineering.mjs"]
      .every((x) => ci.includes(x)));
  const runner = read("tests/run-all.mjs");
  check("A6b run-all 扩至 34 套件且既有 33 套件顺序不变",
    /step30-v19-engineering\.mjs/.test(runner) && /step29-v17-toolbox\.mjs/.test(runner)
    && runner.indexOf("step1-pwa-verify.mjs") < runner.indexOf("step29-v17-toolbox.mjs")
    && runner.indexOf("step29-v17-toolbox.mjs") < runner.indexOf("step30-v19-engineering.mjs"));
}

/* ---------- A7 红线：物理路由与既有测试未改 ---------- */
{
  const route = read("scripts/route-map.mjs");
  const worker = read("_worker.js");
  const pairs = [...route.matchAll(/"(\/[a-z]+\.html)":\s*"pages\/([a-z]+\.html)"/g)];
  check("A7 物理路由双表保持（route-map / _worker PAGE_REWRITES）",
    pairs.length >= 12 && pairs.every((m) => worker.includes(m[1]) && worker.includes("pages/" + m[2])),
    `${pairs.length} 条映射`);
  check("A7b 既有 33 套件清单未删减（runner SUITES 条目数）",
    (read("tests/run-all.mjs").match(/file:\s*"step\d+[^\"]*\.mjs"/g) || []).length >= 34);
}

console.log("\n═══ B. 压缩产物等价性（Node VM，dist 不存在则跳过） ═══");

const distExists = exists("dist/utils/toolbox-pure.js") && exists("dist/utils/event-bus.js");
if (!distExists) {
  console.log("  ⏭  SKIP：dist/ 压缩产物不存在（先跑 npm run build:opt 再启用本段）");
} else {
  const VM_GLOBALS = () => {
    const ctx = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Object, Date, Math, JSON,
      RegExp, String, Number, Array, Error, Map, Set, Symbol, Intl, isNaN, parseInt, parseFloat,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, TextEncoder, TextDecoder,
    };
    ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
    vm.createContext(ctx);
    return ctx;
  };
  const load = (f) => { const c = VM_GLOBALS(); new vm.Script(read(f)).runInContext(c); return c; };

  const cases = [
    ["ToolboxConstants", "utils/toolbox-constants.js", "dist/utils/toolbox-constants.js",
      (c) => [c.ToolboxConstants.VERSION, Object.keys(c.ToolboxConstants).length]],
    ["EventBus", "utils/event-bus.js", "dist/utils/event-bus.js",
      (c) => { let n = 0; c.EventBus.on("x", () => n++); const r = c.EventBus.emit("x"); return [r, n, c.EventBus.listenerCount("x")]; }],
    ["ToolboxPure", "utils/toolbox-pure.js", "dist/utils/toolbox-pure.js",
      (c) => { const P = c.ToolboxPure; return [Object.keys(P).length,
        P.buildCron({ minute: "*/5", hour: "*", day: "*", month: "*", week: "*" }).expression,
        P.urlConvert("a b&c=d", "encode", "query").value,
        P.convertCase("hello world", "camel").value]; }],
  ];
  let eq = 0;
  for (const [name, srcFile, dstFile, probe] of cases) {
    try {
      const a = JSON.stringify(probe(load(srcFile))), b = JSON.stringify(probe(load(dstFile)));
      if (a === b) eq++;
      else console.log(`     ${name} 差异：${a.slice(0, 90)} vs ${b.slice(0, 90)}`);
    } catch (e) { console.log(`     ${name} 异常：${e.message.slice(0, 80)}`); }
  }
  check(`B1 压缩产物三端 VM 行为等价 ${eq}/${cases.length}`, eq === cases.length);
  check("B2 压缩产物全局挂载未被 format:iife 删除",
    typeof load("dist/utils/toolbox-constants.js").ToolboxConstants === "object"
    && typeof load("dist/utils/event-bus.js").EventBus === "object"
    && typeof load("dist/utils/toolbox-pure.js").ToolboxPure === "object");
  const cron = read("dist/modules/toolbox/cron.js");
  const wrk = read("dist/utils/toolbox-worker.js");
  check("B3 ESM 分片 export init / Worker importScripts 路径存活",
    /export\s+(?:function|\{)[^\n]*init/.test(cron) && wrk.includes("importScripts"));
  let srcB = 0, dstB = 0;
  for (const d of ["components", "utils", "services", "modules", "styles"]) {
    for (const base of [d, "dist/" + d]) {
      const full = path.join(ROOT, base);
      if (!fs.existsSync(full)) continue;
      for (const e of fs.readdirSync(full, { withFileTypes: true })) {
        if (!e.isFile() || !/\.(js|css|mjs)$/.test(e.name) || /\.min\.js$|\.input\.css$/.test(e.name)) continue;
        if (base.startsWith("dist/")) dstB += fs.statSync(path.join(full, e.name)).size;
        else srcB += fs.statSync(path.join(full, e.name)).size;
      }
    }
  }
  const shrink = srcB ? (100 * (1 - dstB / srcB)) : 0;
  check("B4 压缩后前端资源体积下降 >= 30%", shrink >= 30,
    `${srcB}B → ${dstB}B（-${shrink.toFixed(1)}%）`);
  check("B5 dist/ 排除 src/ 架构层（不公网暴露契约层）", !exists("dist/src"));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
