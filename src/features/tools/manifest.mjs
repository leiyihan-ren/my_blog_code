/**
 * Feature 域契约：tools —— 极客工具箱（15 工具）
 * ------------------------------------------------------------
 * 这是「按功能域划分」的机器可读事实来源，供 scripts/arch-audit.mjs
 * 校验域归属、依赖方向与循环引用。物理路径保持冻结（绝对红线），
 * 本清单只描述逻辑归属，不改变任何对外 URL 或文件位置。
 */
export default Object.freeze({
  id: "tools",
  layer: "features",
  title: "极客工具箱",
  entries: Object.freeze(["pages/tools.html"]),
  urls: Object.freeze(["/tools.html"]),
  assets: Object.freeze([
    "components/toolbox.js",
    "styles/toolbox.css",
    "styles/toolbox.input.css",
    "utils/toolbox-constants.js",
    "utils/toolbox-pure.js",
    "utils/toolbox-scope.js",
    "utils/toolbox-worker.js",
    "services/toolboxCompute.js",
    "vendor/qrcode.js",
    "scripts/tailwind.toolbox.config.cjs",
    // v17.0 模块一：Tab B 八个工具 ESM 分片 + URL 清单（按需 import）
    "modules/toolbox/manifest.js",
    "modules/toolbox/regex.js",
    "modules/toolbox/qrcode.js",
    "modules/toolbox/image.js",
    "modules/toolbox/diff.js",
    "modules/toolbox/gradient.js",
    "modules/toolbox/cron.js",
    "modules/toolbox/url.js",
    "modules/toolbox/case.js",
  ]),
  tests: Object.freeze([
    "tests/step26-v13-toolbox.mjs",
    "tests/step27-v14-toolbox.mjs",
    "tests/step28-v15-toolbox.mjs",
    "tests/step29-v17-toolbox.mjs",
  ]),
  /** 允许依赖的层（禁止反向） */
  dependsOn: Object.freeze(["core", "shared", "services"]),
});
