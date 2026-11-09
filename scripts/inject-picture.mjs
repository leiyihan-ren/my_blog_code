#!/usr/bin/env node
/**
 * v22.0 模块二：图片渐进增强注入器（幂等 / 可回退 / 可门禁校验）
 *
 * 在 pages/*.html 的 </body> 前注入一个真实生效的 <picture>：
 *   AVIF → WebP → 原 PNG（<img src> 作 fallback），保留 /og-image.png 等
 *   原有 <link rel=icon> 与 meta og:image 引用不变，守 step3-seo-csp 断言。
 * 选 32x32 极小图标 + loading=lazy + 固定 width/height + 首屏之外，
 * 目的是「实际落地标签」而几乎不增加首屏请求 / 不引入 CLS。
 *
 * 用法：
 *   node scripts/inject-picture.mjs            # 全量注入（幂等，业务侧按需启用）
 *   node scripts/inject-picture.mjs --safe     # 收敛到安全态：仅 dashboard/tools 落地
 *   node scripts/inject-picture.mjs --check    # CI 门禁：校验安全态（2 页注入 / 12 页未注入）
 *   node scripts/inject-picture.mjs --revert   # 全量回退到未注入状态
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_DIR = path.join(ROOT, "pages");
// v22.0 Lighthouse 实测：14 页全量注入会让首页移动中位数 100→96
// （新增 1 个 favicon-32.avif 首屏请求、LCP Render Delay 1.2s→2.4s），
// 而 dashboard / tools 两页含 picture 仍稳定 100 分。故收敛为「安全态」：
// 仅这两页实际落地，其余页面保留注入能力但不注入，由 --check 校验。
// 依据与取舍见《网页线·通宵工程战报.md》§2.1 与《待办决策.md》P3。
const SAFE_PAGES = Object.freeze(["dashboard.html", "tools.html"]);
const MODE = process.argv.includes("--revert")
  ? "revert"
  : process.argv.includes("--check")
    ? "check"
    : process.argv.includes("--safe")
      ? "safe"
      : "inject";

const BEGIN = "<!-- v22.0 picture:begin -->";
const END = "<!-- v22.0 picture:end -->";
const BLOCK = `${BEGIN}
<picture class="v22-picture" data-v22-picture>
  <source srcset="/assets/images/favicon-32.avif" type="image/avif">
  <source srcset="/assets/images/favicon-32.webp" type="image/webp">
  <img src="/icons/favicon-32.png" alt="站点图标" width="32" height="32" loading="lazy" decoding="async">
</picture>
${END}`;

function pages() {
  return fs
    .readdirSync(PAGES_DIR)
    .filter((n) => n.endsWith(".html"))
    .sort()
    .map((n) => path.join(PAGES_DIR, n));
}

function strip(src) {
  const i = src.indexOf(BEGIN);
  if (i < 0) return src;
  const j = src.indexOf(END, i);
  if (j < 0) return src;
  let from = i;
  // 连带吃掉块前的缩进与换行，保证 revert 后文件逐字还原
  while (from > 0 && (src[from - 1] === " " || src[from - 1] === "\t")) from--;
  let to = j + END.length;
  if (src[to] === "\r") to++;
  if (src[to] === "\n") to++;
  return src.slice(0, from) + src.slice(to);
}

let changed = 0;
let already = 0;
const problems = [];

for (const file of pages()) {
  const name = path.basename(file);
  const src = fs.readFileSync(file, "utf8");
  const has = src.includes(BEGIN) && src.includes(END);
  const safe = SAFE_PAGES.includes(name);

  // --revert 全量回退；--safe 把非安全页回退、安全页注入
  if (MODE === "revert" || (MODE === "safe" && !safe)) {
    if (!has) continue;
    const next = strip(src);
    if (next !== src) {
      fs.writeFileSync(file, next);
      changed++;
      console.log(`  [revert] ${name}`);
    }
    continue;
  }

  if (MODE === "check") {
    const expected = safe ? has : !has;
    if (expected) already++;
    else problems.push(`${name}（期望${safe ? "已注入" : "未注入"}）`);
    continue;
  }

  if (has) {
    already++;
    continue;
  }
  const at = src.lastIndexOf("</body>");
  if (at < 0) {
    problems.push(`${name}（缺少 </body>）`);
    continue;
  }
  const next = src.slice(0, at) + BLOCK + "\n" + src.slice(at);
  fs.writeFileSync(file, next);
  changed++;
  console.log(`  [inject] ${name}`);
}

if (MODE === "check") {
  console.log(`[inject-picture] check: 符合安全态 ${already}/${pages().length}`);
  if (problems.length) {
    console.error(`[inject-picture] 不符: ${problems.join(", ")}`);
    process.exit(1);
  }
  console.log("[inject-picture] 幂等校验通过");
} else {
  console.log(
    `[inject-picture] 模式=${MODE} 页面=${pages().length} 变更=${changed} 已存在=${already}`
  );
  if (problems.length) {
    console.error(`[inject-picture] 问题: ${problems.join(", ")}`);
    process.exit(1);
  }
}
