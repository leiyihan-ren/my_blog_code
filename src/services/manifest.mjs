/**
 * API 封装层契约：services —— 全站唯一网络出口与上传/下载服务
 * ------------------------------------------------------------
 * 纪律：services/request.js 的 BlogApi 是页面侧唯一 fetch 出口，
 * 其它业务代码一律走 get/post/put/del/raw，禁止裸 fetch。
 */
export default Object.freeze({
  id: "services",
  layer: "services",
  title: "API 封装层",
  entries: Object.freeze([]),
  urls: Object.freeze(["/api/*"]),
  assets: Object.freeze([
    "services/request.js",
    "services/toolboxCompute.js",
    "services/uploadService.js",
    "services/uploadWorker.js",
    "services/rangeDownloader.js",
  ]),
  tests: Object.freeze([
    "tests/step16-resilience.mjs",
    "tests/step20-v11-atomic-upload.mjs",
  ]),
  dependsOn: Object.freeze(["core", "shared"]),
});
