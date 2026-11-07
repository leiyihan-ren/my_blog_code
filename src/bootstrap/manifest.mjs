/**
 * 应用装配层契约：bootstrap —— 全站自举脚本
 * ------------------------------------------------------------
 * utils/common.js 是页面加载后的装配入口：绑定主题色、滚动、全局错误
 * 边界，并把 PlayerHost / UI / BlogUtils 等各层能力桥接到 window。
 * 它在架构上位于**最上层**，允许依赖任意下层；反向（下层引用装配层）
 * 才是违规。这不是「shared 叶子层」，审计工具据此判定依赖方向。
 */
export default Object.freeze({
  id: "bootstrap",
  layer: "bootstrap",
  title: "应用装配层",
  entries: Object.freeze([]),
  urls: Object.freeze([]),
  assets: Object.freeze(["utils/common.js"]),
  tests: Object.freeze(["tests/step5-common-verify.mjs"]),
  dependsOn: Object.freeze(["features", "core", "services", "shared"]),
});
