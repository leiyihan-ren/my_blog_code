/**
 * scripts/inject-preload.mjs —— v19.0 首屏脚本 Preload / fetchpriority 注入器
 * ---------------------------------------------------------------
 * 背景：v17.0 已全站注入 preconnect / dns-prefetch / prefetch；但 13 个页面
 * 里只有 index.html 有 4 条 `preload as=script`，其余 12 页零 preload、
 * 全站零 fetchpriority。本脚本按每页**真实同步脚本链**精确补齐。
 *
 * 精确匹配规则（避免「preloaded but not used」浪费请求）：
 *   - 只 preload body 中无 defer/async 的同步 <script src>，且最多 4 条
 *   - 跳过带查询串的 URL（如 toolbox.js?v=15.0.0）——preload 与 script 的
 *     URL 必须逐字相同才能复用请求，带版本串易漂移，保守跳过
 *   - 全站额外 preload /utils/event-bus.js（唯一 head 同步脚本），
 *     fetchpriority="high"，让浏览器在解析到 <script> 前就发起请求
 *   - 已有 preload 的页面（index.html）不重复添加，只补 fetchpriority
 *   - 不新增任何 prefetch/preconnect（避免破坏 step29 A7 的精确计数）
 *
 * 幂等：注入块由显式标记包裹，重复运行零变更；--revert 精确还原。
 *
 * 运行：node scripts/inject-preload.mjs [--revert | --check]
 * ===============================================================
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const START = "<!-- v19.0 preload:start -->";
const END = "<!-- v19.0 preload:end -->";
// head 唯一同步脚本：全站统一预加载，提权为 high
const EB_PRELOAD = `<link rel="preload" as="script" href="/utils/event-bus.js" fetchpriority="high">`;

const mode = process.argv.includes("--revert") ? "revert"
  : process.argv.includes("--check") ? "check" : "inject";

const pages = fs.readdirSync(path.join(ROOT, "pages")).filter((f) => f.endsWith(".html")).sort();
let changed = 0;
const summary = [];

for (const name of pages) {
  const file = path.join(ROOT, "pages", name);
  let s = fs.readFileSync(file, "utf8");
  const original = s;

  if (mode === "revert") {
    s = s.replace(new RegExp(`[ \\t]*${START}[\\s\\S]*?${END}\\n?`, "m"), "");
    s = s.replace(/ fetchpriority="high"(?= \/>|>)/g, "");
  } else if (!s.includes(START)) {
    const headEnd = s.indexOf("</head>");
    const head = s.slice(0, headEnd);
    const body = s.slice(headEnd);

    // 1) body 中真实同步脚本（排除 defer / async / 带查询串）
    const syncSrc = [];
    for (const m of body.matchAll(/<script([^>]*)\bsrc="([^"]+)"([^>]*)>/g)) {
      const attrs = m[1] + m[3];
      const url = m[2];
      if (/\bdefer\b|\basync\b/.test(attrs)) continue;
      if (url.includes("?")) continue;
      if (!url.startsWith("/")) continue;
      if (syncSrc.includes(url)) continue;
      syncSrc.push(url);
    }

    // 2) head 里已存在的 script preload（index.html 的 4 条）
    const existing = new Set(
      [...head.matchAll(/<link rel="preload" as="script" href="([^"]+)"/g)].map((m) => m[1])
    );

    const toAdd = [];
    if (!existing.has("/utils/event-bus.js")) toAdd.push(EB_PRELOAD);
    for (const u of syncSrc.slice(0, 4)) {
      if (existing.has(u) || u === "/utils/event-bus.js") continue;
      toAdd.push(`<link rel="preload" as="script" href="${u}">`);
    }

    if (toAdd.length) {
      const block = `  ${START}\n` + toAdd.map((l) => `  ${l}`).join("\n") + `\n  ${END}\n`;
      // 插在 charset 之后、v17 资源提示块之前；A7 只要求 charset 在 v17 注释前，满足
      const anchor = /<meta charset="UTF-8">/;
      if (!anchor.test(s)) { console.error(`[inject-preload] ${name}: 找不到 charset`); continue; }
      s = s.replace(anchor, (m) => `${m}\n${block}`);
    }
    // 3) 给 index.html 已有的 4 条 script preload 补 fetchpriority（仅首条 high）
    s = s.replace(
      /(<link rel="preload" as="script" href="\/components\/ui\.js")>/,
      `$1 fetchpriority="high">`
    );
    summary.push(`${name}: +${toAdd.length}`);
  }

  if (s !== original) {
    changed++;
    if (mode !== "check") fs.writeFileSync(file, s);
  }
}

console.log(`[inject-preload] 模式=${mode} 页面=${pages.length} 变更=${changed}`);
if (summary.length) console.log("  " + summary.join("  "));
if (mode !== "revert") {
  // 不变量：prefetch 计数、EventBus 精确串、charset 顺序
  const bad = [];
  for (const name of pages) {
    const s = fs.readFileSync(path.join(ROOT, "pages", name), "utf8");
    const eb = (s.match(/<script src="\/utils\/event-bus\.js"><\/script>/g) || []).length;
    const pf = (s.match(/rel="prefetch"/g) || []).length;
    const want = ["/index.html", "/blog.html", "/drive.html", "/tools.html"].filter((h) => h !== "/" + name).length;
    if (eb !== 1 || pf !== want) bad.push(`${name}{eb:${eb} pf:${pf}/${want}}`);
    if (s.includes("v17.0 模块三") && s.indexOf("<meta charset") > s.indexOf("v17.0 模块三")) bad.push(`${name}: charset 顺序`);
  }
  if (bad.length) { console.error("[inject-preload] 不变量违规: " + bad.join(", ")); process.exitCode = 1; }
  else console.log("[inject-preload] A7 不变量通过（EventBus=1 / prefetch 计数 / charset 顺序）");
}
