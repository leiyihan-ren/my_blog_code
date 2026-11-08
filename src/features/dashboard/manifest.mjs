/**
 * Feature 域契约：dashboard —— 全站数据大屏（v21.0 模块一-1）
 * ------------------------------------------------------------
 * 纯本地可视化功能域：读 LocalStorage 埋点 / IndexedDB 分片缓存，
 * 用 Canvas + 纯 CSS 绘制站点访问趋势、工具使用频率、网盘空间占用。
 * 零网络请求、零后端依赖、零第三方库，断网与脏数据下优雅降级。
 *
 * 依赖方向（features → shared）：telemetry.js 是叶子层公共数据层，
 * 登记在 shared 域；本域只消费它，不反向依赖其它 features / bootstrap。
 * 物理路径保持冻结（绝对红线），本清单只描述逻辑归属。
 */
export default Object.freeze({
  id: "dashboard",
  layer: "features",
  title: "全站数据大屏",
  entries: Object.freeze(["pages/dashboard.html"]),
  urls: Object.freeze(["/dashboard.html"]),
  assets: Object.freeze([
    "components/dashboard.js",
    "styles/dashboard.css",
  ]),
  tests: Object.freeze([
    "tests/step31-v21-dashboard.mjs",
  ]),
  dependsOn: Object.freeze(["core", "shared", "services"]),
});
