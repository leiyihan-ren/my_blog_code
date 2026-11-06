/**
 * scripts/route-map.mjs —— 页面路由唯一事实来源（v7.0）
 * ---------------------------------------------------------------
 * 背景：v7.0 架构重构把 10 个页面下沉 pages/ 目录。为保持对外 URL
 * 零破坏（旧书签/外链/SW 预缓存/SEO 收录全部不变），_worker.js 内置
 * 一张重写表；本地测试的静态服务器需要同一张表才能复现线上行为。
 * 本文件即该表的唯一事实来源：
 *   - _worker.js 中的 PAGE_REWRITES 是本表的内联拷贝（Worker 无外部依赖）
 *   - tests/step10-routes-verify.mjs 断言两处一致，防止漂移
 *   - 各测试静态服务器用 staticFilePath() 解析物理文件
 *
 * 映射方向：对外 URL pathname → 仓库内物理文件路径（相对仓库根）。
 * 派生规则：Worker 重写 URL = "/" + 物理路径；两者天然一致。
 * ===============================================================
 */

/** 页面物理目录 */
export const PAGES_DIR = "pages";

/** 对外 URL pathname → 仓库内物理文件路径（相对仓库根） */
export const PAGE_FILES = {
  "/": "pages/index.html",
  "/index.html": "pages/index.html",
  "/admin.html": "pages/admin.html",
  "/album.html": "pages/album.html",
  "/blog.html": "pages/blog.html",
  "/drive.html": "pages/drive.html",
  "/games.html": "pages/games.html",
  "/guestbook.html": "pages/guestbook.html",
  "/links.html": "pages/links.html",
  "/mc.html": "pages/mc.html",
  "/post.html": "pages/post.html",
  "/timeline.html": "pages/timeline.html",
  // v12.0 战役一：全局播放内核（独立窗口 / 隐藏 iframe 共用同一文档）
  // ⚠️ 必须与 _worker.js 的 PAGE_REWRITES 同步，step10 有一致性断言。
  "/player.html": "pages/player.html",
  // v13.0 极客工具箱（7 个工具：5 个纯前端 + 2 个 Worker 代理）
  // ⚠️ 必须与 _worker.js 的 PAGE_REWRITES 同步，step10 有一致性断言。
  "/tools.html": "pages/tools.html",
};

/**
 * 静态服务器用：URL pathname → 仓库内物理文件路径。
 * 命中页面表走 pages/；其余（样式/脚本/图标等）物理路径 = URL 去前导斜杠，
 * 因为只有 HTML 页面被下沉，资产目录（styles/utils/services/components/icons）
 * 的对外 URL 与物理位置本就一致。
 */
export function staticFilePath(urlPathname) {
  // v13.0.1：允许带 cache-bust 查询串 / 锚点（如 SW 清单里的
  // /styles/toolbox.css?v=13.0.1），先剥离再映射，保证「清单全部落盘」校验
  // 与页面引用检查口径一致（后者本就 split("?")[0]）。
  const p = String(urlPathname).split("?")[0].split("#")[0];
  const mapped = PAGE_FILES[p];
  if (mapped) return mapped;
  return p.replace(/^\/+/, "");
}

/** 派生 Worker 侧重写表（URL pathname → URL pathname），供同步断言使用 */
export function workerRewriteMap() {
  const out = {};
  for (const [k, v] of Object.entries(PAGE_FILES)) out[k] = "/" + v;
  return out;
}
