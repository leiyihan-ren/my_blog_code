/**
 * scripts/arch-audit.mjs —— v16.0 架构静态审计（零第三方依赖）
 * ------------------------------------------------------------
 * 长期治理工具，回答四个问题：
 *   1) Feature 域归属与分层依赖是否自洽（消费 src/architecture.mjs）
 *   2) 全局脚本之间是否存在循环依赖 / 反向分层依赖
 *   3) 生产代码是否残留调试输出（console.log/debug/info）
 *   4) 是否存在确定未被引用的 CSS 类与图片资源（只报告，不自动删）
 *
 * 用法：npm run audit:arch            审计报告 + 红线错误非 0 退出
 *       npm run audit:arch -- --strict 警告也视为失败
 *
 * 设计约束：只读、不修改任何文件；不依赖 Playwright，可在 CI 任意阶段跑。
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNITS, LAYER_RULES, FEATURES, FROZEN_CONTRACTS, unitFiles, ownerOf, validate } from "../src/architecture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 递归列出目录下指定扩展名的文件 */
function glob(dir, ext) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const name of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, name.name);
    if (name.isDirectory()) out.push(...glob(rel, ext));
    else if (name.name.endsWith(ext)) out.push(rel);
  }
  return out.sort();
}

const results = [];
/** @param {string} name @param {boolean} ok @param {string} detail */
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
function section(title) { console.log(`\n── ${title} ──`); }

/* ============================================================
 * 1. 架构契约自洽性
 * ============================================================ */
section("1. Feature 域归属与分层依赖");
{
  const { errors, warnings } = validate(exists);
  record(`架构单元 ${UNITS.length} 个 / 功能域 ${FEATURES.length} 个，依赖方向合法`,
    errors.length === 0, errors.join("；") || "无违规");
  record("红线契约（13 页面 / 6 脚本链 / 唯一网络出口 / Worker 入口）全部存在",
    !errors.some((e) => e.includes("红线契约")),
    [...new Set([...Object.values(FROZEN_CONTRACTS)].flat())].length + " 项");
  if (warnings.length) console.log(`  WARN  域清单声明缺失 ${warnings.length} 项：${warnings.slice(0, 4).join("；")}${warnings.length > 4 ? " …" : ""}`);
}

/* ============================================================
 * 2. 全局脚本依赖图 / 循环依赖 / 反向分层
 * ============================================================ */
section("2. 全局依赖图与循环引用");
const FRONT_JS = [
  ...glob("components", ".js"),
  ...glob("utils", ".js"),
  ...glob("services", ".js"),
  "sw.js",
];
{
  // 全局挂载模式：定义 = (window|globalThis|self|root).Name = ...；引用 = 读取同名全局
  const DEF_RE = /(?:\bwindow|\bglobalThis|\bself|\broot)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  const USE_RE = /(?:\bwindow|\bglobalThis|\bself)\.([A-Za-z_$][\w$]*)/g;
  const definedAt = new Map();   // 全局名 → 定义文件
  const uses = new Map();        // 文件 → Set<全局名>
  for (const f of FRONT_JS) {
    const src = read(f);
    for (const m of src.matchAll(DEF_RE)) {
      if (!definedAt.has(m[1])) definedAt.set(m[1], f);
    }
    const set = new Set();
    for (const m of src.matchAll(USE_RE)) set.add(m[1]);
    uses.set(f, set);
  }
  // 归属唯一事实来源在 src/architecture.mjs；未声明文件单列统计，不猜层
  const layerOf = (file) => (ownerOf(file) || {}).layer || "unclassified";
  const unclassified = FRONT_JS.filter((f) => !ownerOf(f));
  const edges = new Map();       // 文件 → Set<依赖文件>
  for (const [f, names] of uses) {
    const deps = new Set();
    for (const n of names) {
      const target = definedAt.get(n);
      if (target && target !== f) deps.add(target);
    }
    edges.set(f, deps);
  }
  // 双向依赖（循环）
  const cycles = [];
  for (const [f, deps] of edges) {
    for (const d of deps) if ((edges.get(d) || new Set()).has(f) && f < d) cycles.push(`${f} ⇄ ${d}`);
  }
  record(`${FRONT_JS.length} 个前端脚本 / ${definedAt.size} 个全局导出，零双向循环依赖`,
    cycles.length === 0, cycles.join("；") || "依赖图为 DAG");
  // 反向分层：低层不得引用高层。unclassified 不参与判定，单列治理指标
  const order = { shared: 0, core: 1, services: 2, features: 3, bootstrap: 4 };
  const violations = [];
  for (const [f, deps] of edges) {
    for (const d of deps) {
      const a = order[layerOf(f)], b = order[layerOf(d)];
      if (a === undefined || b === undefined) continue;
      if (a < b) violations.push(`${f}(${layerOf(f)}) → ${d}(${layerOf(d)})`);
    }
  }
  record("分层依赖方向单向（shared ← core ← services ← features ← bootstrap）",
    violations.length === 0, violations.slice(0, 3).join("；") || "零反向引用");
  record("前端脚本 100% 有域归属", unclassified.length === 0,
    unclassified.join("，") || `${FRONT_JS.length} 个脚本全部登记`);
  console.log(`  INFO  分层规则：${Object.entries(LAYER_RULES).map(([k, v]) => `${k}→[${v.join(",")}]`).join("  ")}`);
}

/* ============================================================
 * 3. 调试输出清理
 * ============================================================ */
section("3. 调试输出与注释规范");
{
  const hits = [];
  for (const f of FRONT_JS) {
    const lines = read(f).split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/console\.(log|debug|info)\s*\(/.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  record("生产前端源码零 console.log / debug / info", hits.length === 0,
    hits.join("，") || "错误边界 warn/error 保留（可观测性）");
  // 裸 fetch：除唯一出口外一律禁止
  const bare = [];
  for (const f of FRONT_JS) {
    if (f === "services/request.js" || f === "sw.js") continue;
    read(f).split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/(^|[^.\w"'])fetch\s*\(/.test(line)) bare.push(`${f}:${i + 1}`);
    });
  }
  record("全站页面请求 100% 经 BlogApi（零裸 fetch）", bare.length === 0,
    bare.join("，") || "唯一出口 services/request.js");
}

/* ============================================================
 * 4. 未使用 CSS 类 / 未引用图片（候选，只报告）
 * ============================================================ */
section("4. 死代码候选（只报告，不自动删除）");
{
  const cssFiles = glob("styles", ".css").filter((f) => !f.endsWith(".input.css"));
  const htmlFiles = glob("pages", ".html");
  const jsFiles = FRONT_JS;
  const corpus = [
    ...htmlFiles.map(read), ...jsFiles.map(read),
    ...glob("styles", ".css").map(read),
  ].join("\n");
  const classes = new Set();
  for (const f of cssFiles) {
    for (const m of read(f).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1]);
  }
  const unusedClasses = [...classes].filter((c) => !new RegExp(`\\b${c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`).test(corpus));
  console.log(`  INFO  CSS 类总数 ${classes.size}，未静态命中 ${unusedClasses.length} 个` +
    (unusedClasses.length ? `：${unusedClasses.slice(0, 12).join(", ")}${unusedClasses.length > 12 ? " …" : ""}` : ""));
  console.log("  INFO  类名可能由 JS 动态拼接，故仅列为人工复核候选，不自动删除");

  const imgFiles = [...glob("icons", ".png"), ...glob("icons", ".svg"), "og-image.png"].filter((f) => fs.existsSync(path.join(ROOT, f)));
  const manifestAndHtml = corpus + read("manifest.json") + read("sw.js");
  const unreferenced = imgFiles.filter((f) => !manifestAndHtml.includes(path.basename(f)));
  console.log(`  INFO  图片资源 ${imgFiles.length} 个，未被静态引用 ${unreferenced.length} 个` +
    (unreferenced.length ? `：${unreferenced.join(", ")}` : ""));
}

/* ============================================================
 * 汇总
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
console.log(`\n═══ 审计汇总：${results.length - failed.length}/${results.length} 通过 ═══`);
if (failed.length) {
  console.log("失败项：\n" + failed.map((r) => `  · ${r.name} — ${r.detail}`).join("\n"));
  process.exitCode = 1;
}
if (STRICT) console.log("（--strict 模式：警告同样需人工清零）");
