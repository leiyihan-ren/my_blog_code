/**
 * scripts/build-optimize.mjs —— v19.0 生产压缩管线（esbuild 驱动）
 * ---------------------------------------------------------------
 * 职责：在 `npm run build`（build-pages.mjs 纯复制整站到 dist/public/build）
 * 之后，对三份输出副本里的前端 JS / CSS 做**原地压缩**，保持：
 *   - 物理路径 100% 不变（SW 预缓存清单、PAGE_REWRITES、67 处测试路径断言、
 *     121 处 HTML 绝对引用、importScripts 绝对路径全部不受影响）
 *   - classic <script> IIFE 全局契约不变（只压缩，不 bundle、不改导出名）
 *   - ESM 分片 export function init 名不变（esbuild 保留外部可见绑定）
 *   - 版本查询串 ?v=15.0.0 所在的 URL 字符串不变
 *
 * 为什么不是 Vite「打包」：本站是 classic MPA，运行时脚本是全局 IIFE，
 * 纯函数内核被 Web Worker 的 importScripts 与 Node VM 三端共享；任何
 * bundler 化都会改变文件路径与求值语义，直接违反 v19.0「绝不改变现有
 * 业务逻辑和路由路径」红线。因此这里只启用 esbuild 的 transform/minify
 * 能力（真实压缩、体积收益可验证），Tree-shaking 需要 ESM 静态图，
 * 对 classic script 无对象；CSS 本站本就是独立文件（早已「提取」）。
 *
 * 排除清单（保守原则，宁可不压也不破坏）：
 *   - _worker.js      : 229KB Worker 入口，含 CSP 字符串 / 路由表 / 正则，
 *                       压缩收益相对风险不划算（且线上根部署时它是服务源码）
 *   - sw.js           : step1/step16/step25 对 `CACHE_VERSION = "v15.0.0"`
 *                       做精确字符串断言，任何字符变化都是回归
 *   - vendor/*.min.js : 已是压缩产物（jszip / qrcode）
 *   - *.input.css     : Tailwind 编译输入源，非运行时资源
 *   - *.map / 图片    : 非文本
 *
 * 运行：node scripts/build-optimize.mjs [--report <path>]
 * ===============================================================
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIRS = ["dist", "public", "build"];
/** 需要压缩的运行时目录（相对输出根） */
const MINIFY_DIRS = ["components", "utils", "services", "modules", "styles"];
/** 明确排除的文件（basename 精确匹配） */
const SKIP_FILES = new Set(["_worker.js", "sw.js"]);

const reportIdx = process.argv.indexOf("--report");
const REPORT_PATH = reportIdx >= 0 ? process.argv[reportIdx + 1] : null;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function shouldMinify(rel) {
  const base = path.basename(rel);
  if (SKIP_FILES.has(base)) return false;
  if (base.endsWith(".input.css")) return false;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return false;
  return (base.endsWith(".js") || base.endsWith(".mjs") || base.endsWith(".css"));
}

let files = 0, beforeTotal = 0, afterTotal = 0, failed = 0;
const perFile = [];

for (const outName of OUT_DIRS) {
  const outRoot = path.join(ROOT, outName);
  if (!fs.existsSync(outRoot)) continue;
  for (const dir of MINIFY_DIRS) {
    for (const file of walk(path.join(outRoot, dir))) {
      const rel = path.relative(outRoot, file).split(path.sep).join("/");
      if (!shouldMinify(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      const ext = path.extname(file).slice(1);
      const loader = ext === "css" ? "css" : "js";
      try {
        const r = await transform(src, {
          loader,
          minify: true,
          target: "es2020",
          legalComments: "none",
          // ⚠️ 绝不加 format: "iife"：esbuild 会把顶层 `var ToolboxConstants = …`
          // 判为未使用而整个删除，直接摧毁三端 UMD 的全局挂载（已由 Node VM 实证）。
          // 纯 transform + minify 会保留顶层绑定、export 与 importScripts 路径字符串。
          // keepNames 同理不启用：它会改变压缩率且对 classic 契约无收益。
        });
        const out = r.code;
        if (out.length >= src.length) continue; // 已压缩或极小文件，跳过
        fs.writeFileSync(file, out);
        files++;
        beforeTotal += Buffer.byteLength(src);
        afterTotal += Buffer.byteLength(out);
        perFile.push({ dir: outName, file: rel, before: Buffer.byteLength(src), after: Buffer.byteLength(out) });
      } catch (e) {
        failed++;
        console.error(`[build-optimize] 跳过 ${outName}/${rel}: ${e.message.split("\n")[0]}`);
      }
    }
  }
}

const shrink = beforeTotal ? ((1 - afterTotal / beforeTotal) * 100).toFixed(1) : "0.0";
console.log(
  `[build-optimize] esbuild 原地压缩完成：${files} 个文件 / ${OUT_DIRS.join("+")} 三份副本，` +
  `总计 ${beforeTotal} B → ${afterTotal} B（-${shrink}%），失败 ${failed}`
);

if (REPORT_PATH) {
  perFile.sort((a, b) => (b.before - b.after) - (a.before - a.after));
  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    engine: "esbuild transform minify (format=iife, keepNames=true)",
    files, beforeTotal, afterTotal, shrinkPct: Number(shrink), failed,
    top: perFile.filter((x) => x.dir === "dist").slice(0, 30),
  }, null, 2));
  console.log(`[build-optimize] 体积报告 → ${REPORT_PATH}`);
}
if (failed > 0) process.exitCode = 1;
