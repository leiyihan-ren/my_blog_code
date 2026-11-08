/**
 * 全局公共层契约：shared —— 跨功能域复用的组件、样式、类型与工具
 * ------------------------------------------------------------
 * 这是依赖图的叶子层：不允许依赖任何 features / core / services。
 */
export default Object.freeze({
  id: "shared",
  layer: "shared",
  title: "全局公共层",
  entries: Object.freeze([]),
  urls: Object.freeze([]),
  assets: Object.freeze([
    "src/shared/types.js",
    // v17.0 模块二：EventBus 规范实现（架构契约层）与生产 classic 运行时
    "src/shared/event-bus.js",
    "utils/event-bus.js",
    "components/ui.js",
    "utils/blog-utils.js",
    "utils/pinyin-gb2312.js",
    "styles/common.css",
    "manifest.json",
    // v19.0 模块三：首屏 Critical CSS 单一源（由 inject-critical 内联到 13 页）
    "styles/critical.css",
    // v19.0 模块一/四：esbuild 压缩管线、Critical CSS 注入器、可复现性能服务器
    "scripts/build-optimize.mjs",
    "scripts/inject-critical.mjs",
    "scripts/perf-server.mjs",
    // v19.0 工程化门禁配置（逻辑归属：全站公共基建）
    "eslint.config.mjs",
    "stylelint.config.mjs",
    "eslint-suppressions.json",
    // v21.0 模块一-1：全站轻量埋点与本地数据聚合层（叶子层公共数据层，
    // 被 common.js 空闲加载 + dashboard 域消费，无反向依赖）
    "utils/telemetry.js",
  ]),
  tests: Object.freeze([
    "tests/step5-common-verify.mjs",
    "tests/step15-dialogs.mjs",
    "tests/step30-v19-engineering.mjs",
  ]),
  dependsOn: Object.freeze([]),
});
