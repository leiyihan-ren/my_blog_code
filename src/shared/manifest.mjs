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
  ]),
  tests: Object.freeze([
    "tests/step5-common-verify.mjs",
    "tests/step15-dialogs.mjs",
  ]),
  dependsOn: Object.freeze([]),
});
