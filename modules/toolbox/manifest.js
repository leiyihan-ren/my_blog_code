/* ============================================================
 * modules/toolbox/manifest.js —— Tab B 进阶工具 ESM 分片清单
 * ------------------------------------------------------------
 * v17.0 模块一「极致的按需加载」的单一事实来源：
 *   · components/toolbox.js 在用户首次点击 Tab B 时 import() 本清单，
 *     再 Promise.all 动态加载 8 个工具分片；
 *   · sw.js 的 PRECACHE_URLS 逐字引用同一批 URL，保证断网可命中；
 *   · tests/step29-v17-toolbox.mjs 断言三方一致，防止新增工具时漂移。
 *
 * 为什么是裸 URL（不带 ?v=）：这些分片只在 SW 版本升级时变更，
 * 由 sw.js 的 /modules/toolbox/ Cache-First 分支按精确 URL 命中；
 * 运行时版本 15.0.0 仍冻结在常量层 / SW / 页面查询串三处（step28 A1）。
 *
 * 每个分片导出 init(scope, kit)，依赖全部经 kit 注入，零全局耦合。
 * 严格 CSP：script-src-elem 'self' 放行同源 ESM；零第三方请求。
 * ============================================================ */

/** Tab B 八个进阶工具的 ESM 分片 URL（顺序即 init 顺序，与 DOM 卡序一致） */
export const MODULES = Object.freeze([
  "/modules/toolbox/regex.js",
  "/modules/toolbox/qrcode.js",
  "/modules/toolbox/image.js",
  "/modules/toolbox/diff.js",
  "/modules/toolbox/gradient.js",
  "/modules/toolbox/cron.js",
  "/modules/toolbox/url.js",
  "/modules/toolbox/case.js",
]);

/** 与 MODULES 一一对应的工具 id（DOM 上 data-tool 的取值） */
export const TOOL_IDS = Object.freeze([
  "regex", "qrcode", "image", "diff", "gradient", "cron", "url", "case",
]);

/** 分片数量（供骨架屏占位与诊断展示） */
export const MODULE_COUNT = MODULES.length;
