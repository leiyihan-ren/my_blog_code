/**
 * scripts/build-pages.mjs —— Cloudflare Pages 构建加固脚本
 * ---------------------------------------------------------------
 * 背景：本站是纯静态多页站点（无框架、无打包），文件就在仓库根目录。
 * Cloudflare Pages 的「Build output directory」配置项因账号/项目设置而异，
 * 常见取值为 `/`、`/dist`、`/public`、`/build`。本脚本在构建时把整站
 * 同步到三个最常见的候选输出目录，做到「不管 dashboard 里配了哪个都能构建」：
 *
 *   - dist/     （Vite/CRA 等工具链的默认输出目录）
 *   - public/   （Vite 源码目录约定，部分教程让设为输出目录）
 *   - build/    （Create React App 默认输出目录）
 *
 * 输出目录里的内容 = 仓库根目录整站文件（排除 node_modules/.git/归档等），
 * `_worker.js` 位于输出目录根部，满足 Pages 高级模式（Advanced Mode）要求。
 *
 * 若 dashboard 的 Build output directory 配的是 `/`（本站推荐配置），
 * 则构建产物直接就是根目录，本脚本生成的目录不会被使用，无副作用。
 * ===============================================================
 */
import { cp, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 部署输出中不需要的条目（目录或文件名，精确匹配） */
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  "dist",
  "public",
  "build",
  "docs",
  "tests",
  "scripts",
  "playwright-report",
  "test-results",
  "blob-report",
  ".cache",
  ".wrangler",
]);
const EXCLUDE_FILE_RE = [
  /\.zip$/, /\.log$/, /^\.env/, /^\.dev\.vars/, /^\.DS_Store$/, /^Thumbs\.db$/,
  // 开发/仓库管理文件：不属于部署产物（同时避免 Pages 在输出目录里触发 npm 安装）
  /^package\.json$/, /^package-lock\.json$/, /^README\.md$/, /^\.gitignore$/,
  /^\.npmrc$/, /^wrangler\.toml$/,
];

async function listEntries(dir) {
  const names = await readdir(dir);
  const keep = [];
  for (const name of names) {
    if (EXCLUDE_DIRS.has(name)) continue;
    if (EXCLUDE_FILE_RE.some((re) => re.test(name))) continue;
    const st = await stat(path.join(dir, name));
    keep.push({ name, isDir: st.isDirectory() });
  }
  return keep;
}

/** 把整站文件复制到目标输出目录（先清空重建，保证与当前提交一致） */
async function buildInto(outName) {
  const outDir = path.join(ROOT, outName);
  await rm(outDir, { recursive: true, force: true });
  const entries = await listEntries(ROOT);
  for (const entry of entries) {
    await cp(path.join(ROOT, entry.name), path.join(outDir, entry.name), { recursive: true });
  }
  return entries.length;
}

const targets = ["dist", "public", "build"];
let total = 0;
for (const t of targets) {
  if (existsSync(path.join(ROOT, t))) {
    total += await buildInto(t);
  }
}
if (total === 0) {
  // 三个候选目录都不存在（dashboard 配的是 `/` 或未创建过输出目录）：
  // 全部生成，保证任何配置都能构建成功。
  for (const t of targets) total += await buildInto(t);
}
console.log(
  `[build-pages] 已同步整站至 ${targets.join("/")}（共 ${total} 个顶层条目）；` +
    `若 dashboard 输出目录为 /，则直接使用仓库根目录。`
);
