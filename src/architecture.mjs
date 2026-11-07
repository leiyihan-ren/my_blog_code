/**
 * src/architecture.mjs —— Feature-Based 架构「唯一事实来源」
 * ------------------------------------------------------------
 * 本站是纯静态 MPA（零框架、零打包、零 TypeScript）。把物理目录强行
 * 迁移到 `src/features/*` 会同时打断：
 *   · _worker.js 的 PAGE_REWRITES（对外 URL → pages/*.html）
 *   · scripts/route-map.mjs 的 PAGE_FILES（测试静态服务器同源映射）
 *   · 13 个 HTML 内 121 处 /styles /utils /services /components 绝对引用
 *   · sw.js 的 56 项预缓存清单（v15 离线闭环）
 *   · 32 个测试套件里硬编码的物理路径（本轮禁止改测试）
 * 因此「按功能域划分」以**逻辑架构层**落地：本文件声明域归属与依赖
 * 规则，scripts/arch-audit.mjs 消费它做静态校验，物理路径保持冻结。
 *
 * 这层是纯工程契约：不进生产产物（build-pages.mjs 已排除 src/），
 * 不产生任何浏览器请求，零运行时开销。
 * ============================================================ */
import core from "./core/manifest.mjs";
import services from "./services/manifest.mjs";
import shared from "./shared/manifest.mjs";
import tools from "./features/tools/manifest.mjs";
import blog from "./features/blog/manifest.mjs";
import album from "./features/album/manifest.mjs";
import player from "./features/player/manifest.mjs";
import drive from "./features/drive/manifest.mjs";
import games from "./features/games/manifest.mjs";
import bootstrap from "./bootstrap/manifest.mjs";

/** 全部架构单元（层 + 功能域），顺序即 ownerOf 的归属优先级 */
export const UNITS = Object.freeze([
  shared, core, services, tools, blog, album, player, drive, games, bootstrap,
]);

/** 功能域（对外可交付的能力集合） */
export const FEATURES = Object.freeze([tools, blog, album, player, drive, games]);

/** 分层依赖白名单：key 层只能依赖 value 中列出的层，反向一律判违规 */
export const LAYER_RULES = Object.freeze({
  bootstrap: Object.freeze(["features", "core", "services", "shared"]),
  features: Object.freeze(["core", "services", "shared"]),
  services: Object.freeze(["core", "shared"]),
  core: Object.freeze(["shared"]),
  shared: Object.freeze([]),
});

/**
 * 绝对红线：物理路径与对外 URL 契约，任何重构都不得改动。
 * arch-audit 会逐项校验存在性，缺失即判红线破损。
 */
export const FROZEN_CONTRACTS = Object.freeze({
  /** 页面物理路径（与 route-map.mjs / _worker.js 双表一致） */
  pages: Object.freeze([
    "pages/index.html", "pages/admin.html", "pages/album.html",
    "pages/blog.html", "pages/drive.html", "pages/games.html",
    "pages/guestbook.html", "pages/links.html", "pages/mc.html",
    "pages/player.html", "pages/post.html", "pages/timeline.html",
    "pages/tools.html",
  ]),
  /** 工具箱运行时依赖链（顺序即 <script> 加载顺序，不可颠倒） */
  toolboxScriptChain: Object.freeze([
    "utils/toolbox-constants.js",
    "utils/toolbox-pure.js",
    "utils/toolbox-scope.js",
    "services/toolboxCompute.js",
    "vendor/qrcode.js",
    "components/toolbox.js",
  ]),
  /** 全站唯一网络出口 */
  networkEgress: Object.freeze(["services/request.js"]),
  /** 后端单文件入口（Cloudflare Pages Advanced Mode 要求） */
  workerEntry: Object.freeze(["_worker.js"]),
});

/**
 * 汇总某单元声明的全部物理文件（含入口与测试）。
 * @param {Object} unit 架构单元
 * @returns {string[]} 去重后的相对路径列表
 */
export function unitFiles(unit) {
  return [...new Set([
    ...(unit.entries || []), ...(unit.assets || []), ...(unit.tests || []),
  ])];
}

/**
 * 查询物理文件归属的架构单元（单一事实来源，供审计工具判定分层）。
 * @param {string} file 相对仓库根的路径
 * @returns {Object|null} 归属单元，未声明返回 null
 */
export function ownerOf(file) {
  for (const unit of UNITS) if (unitFiles(unit).includes(file)) return unit;
  return null;
}

/**
 * 校验架构自洽性：依赖方向、单元 id 唯一、红线文件齐备。
 * @param {(p:string)=>boolean} exists 物理文件存在性判定（注入以便测试）
 * @returns {{errors:string[], warnings:string[]}} 校验结果
 */
export function validate(exists) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  for (const unit of UNITS) {
    if (ids.has(unit.id)) errors.push(`单元 id 重复：${unit.id}`);
    ids.add(unit.id);
    const allowed = LAYER_RULES[unit.layer] || [];
    for (const dep of unit.dependsOn || []) {
      if (!allowed.includes(dep)) {
        errors.push(`${unit.layer}/${unit.id} 不允许依赖 ${dep}（违反分层依赖方向）`);
      }
    }
    for (const file of unitFiles(unit)) {
      if (!exists(file)) warnings.push(`${unit.id} 声明的文件不存在：${file}`);
    }
  }
  for (const [group, files] of Object.entries(FROZEN_CONTRACTS)) {
    for (const file of files) {
      if (!exists(file)) errors.push(`红线契约 ${group} 缺失文件：${file}`);
    }
  }
  return { errors, warnings };
}
