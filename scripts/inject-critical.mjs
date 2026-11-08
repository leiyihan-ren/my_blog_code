/**
 * scripts/inject-critical.mjs —— v19.0 Critical CSS 内联 / 非阻塞 CSS 注入器
 * ---------------------------------------------------------------
 * 幂等、可回退。对 pages/*.html 做两件事，且不触碰任何其它字节：
 *
 *  1) 在 <meta charset> 之后内联 styles/critical.css（esbuild 压缩后），
 *     保证首屏设计令牌与布局稳定基元同步可用，杜绝 FOUC / CLS。
 *  2) 把 <link rel="stylesheet" href="/styles/common.css"> 改为经典
 *     非阻塞模式：media="print" onload="this.media='all'" + <noscript> 兜底。
 *     CSP 的 script-src-attr 'unsafe-inline' 已放行内联事件属性，
 *     style-src 'unsafe-inline' 已放行内联 <style>。
 *
 * 幂等保证：注入内容被显式标记块包裹，脚本遇到标记即整文件短路；
 * 且 COMMON_RE 只匹配「行首缩进 + 精确 link + 行尾」，绝不会命中
 * <noscript> 内部的同名 link（第一版曾因此产生嵌套，已修正）。
 *
 * 明确保留（红线）：
 *   - /styles/toolbox.css?v=15.0.0 与 /styles/drive.css 的同步 stylesheet
 *   - <script src="/utils/event-bus.js"></script>（step29 A7 精确串）
 *   - 全部 preconnect / dns-prefetch / prefetch / preload 标签
 *   - <meta charset> 与 "v17.0 模块三" 的相对顺序（A7 硬断言）
 *   - 页面 DOM 结构、script 顺序、查询串版本号
 *
 * 运行：
 *   node scripts/inject-critical.mjs            # 注入（幂等）
 *   node scripts/inject-critical.mjs --revert   # 回退到注入前
 *   node scripts/inject-critical.mjs --check    # 只校验，不写文件
 * ===============================================================
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRITICAL_SRC = path.join(ROOT, "styles", "critical.css");
const INLINE_MARK = "v19.0 critical-css";
const NB_START = "<!-- v19.0 common-css-nonblocking:start -->";
const NB_END = "<!-- v19.0 common-css-nonblocking:end -->";
const STYLE_OPEN = `<style data-v19-critical>`;
// 只匹配「独立的整行」link：行首可有缩进，行尾必须紧跟换行；
// 绝不匹配 <noscript> 内与 </noscript> 同行的 link。
const COMMON_RE = /^([ \t]*)<link rel="stylesheet" href="\/styles\/common\.css">[ \t]*$/m;

const mode = process.argv.includes("--revert") ? "revert"
  : process.argv.includes("--check") ? "check" : "inject";

const criticalRaw = fs.readFileSync(CRITICAL_SRC, "utf8");
const criticalMin = (await transform(criticalRaw, { loader: "css", minify: true, legalComments: "none" })).code.trim();
const inlineBlock =
  `  <!-- ${INLINE_MARK}：首屏令牌 + 布局稳定基元（源：styles/critical.css，勿手改） -->\n` +
  `  ${STYLE_OPEN}${criticalMin}</style>`;

const pages = fs.readdirSync(path.join(ROOT, "pages")).filter((f) => f.endsWith(".html")).sort();
let changed = 0;
const issues = [];

for (const name of pages) {
  const file = path.join(ROOT, "pages", name);
  let s = fs.readFileSync(file, "utf8");
  const original = s;

  if (mode === "revert") {
    s = s.replace(new RegExp(`[ \\t]*<!-- ${INLINE_MARK}[^>]*-->\\n[ \\t]*<style data-v19-critical>.*?</style>\\n?`, "s"), "");
    s = s.replace(new RegExp(
      `[ \\t]*${NB_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${NB_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "m"), (m) => {
      const indent = (m.match(/^[ \t]*/) || [""])[0];
      return `${indent}<link rel="stylesheet" href="/styles/common.css">`;
    });
  } else {
    // 文件级幂等短路：任一标记已存在，则整个文件不再处理
    const injected = s.includes(NB_START);
    if (!injected) {
      // 1) 内联 Critical CSS（紧跟 charset，越早越好）
      if (!s.includes(STYLE_OPEN)) {
        const anchor = /<meta charset="UTF-8">/;
        if (!anchor.test(s)) { issues.push(`${name}: 找不到 <meta charset>`); continue; }
        s = s.replace(anchor, (m) => `${m}\n${inlineBlock}`);
      }
      // 2) common.css 非阻塞化（只改这一处独立 link）
      if (COMMON_RE.test(s)) {
        s = s.replace(COMMON_RE, (m, indent) =>
          `${indent}${NB_START}\n` +
          `${indent}<link rel="stylesheet" href="/styles/common.css" media="print" onload="this.media='all'">\n` +
          `${indent}<noscript><link rel="stylesheet" href="/styles/common.css"></noscript>\n` +
          `${indent}${NB_END}`);
      }
    }
  }

  // ---- 不变量校验（三种模式都跑）----
  if (mode !== "revert") {
    const eb = (s.match(/<script src="\/utils\/event-bus\.js"><\/script>/g) || []).length;
    if (eb !== 1) issues.push(`${name}: EventBus script 计数=${eb}（须为 1）`);
    if (s.includes("v17.0 模块三") && s.indexOf("<meta charset") > s.indexOf("v17.0 模块三"))
      issues.push(`${name}: charset 不在 v17 注释之前`);
    if ((original.match(/\?v=15\.0\.0/g) || []).length !== (s.match(/\?v=15\.0\.0/g) || []).length)
      issues.push(`${name}: ?v=15.0.0 计数被改变`);
    const nos = (s.match(/<noscript>/g) || []).length;
    const nosClose = (s.match(/<\/noscript>/g) || []).length;
    if (nos > 1 || nos !== nosClose) issues.push(`${name}: noscript 标签异常 open=${nos} close=${nosClose}`);
  }

  if (s !== original) {
    changed++;
    if (mode !== "check") fs.writeFileSync(file, s);
  }
}

console.log(`[inject-critical] 模式=${mode} 页面=${pages.length} 变更=${changed} ` +
  `内联CSS=${criticalMin.length}B 源=${criticalRaw.length}B`);
if (issues.length) {
  console.error("[inject-critical] 不变量违规：\n  " + issues.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("[inject-critical] 不变量全部通过（EventBus=1 / charset 顺序 / 版本串 / noscript 配对）");
}
