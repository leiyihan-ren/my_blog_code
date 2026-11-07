/**
 * 核心基建层契约：core —— 纯算法内核 / 生命周期 / Worker / PWA 外壳
 * ------------------------------------------------------------
 * 纪律：本层零 DOM、零网络、零 console（utils/toolbox-pure.js 尤其严格），
 * 可被主线程与 Worker 通过 importScripts 复用，结果逐字一致。
 */
export default Object.freeze({
  id: "core",
  layer: "core",
  title: "核心基建",
  entries: Object.freeze([]),
  urls: Object.freeze(["/sw.js"]),
  assets: Object.freeze([
    "utils/toolbox-constants.js",
    "utils/toolbox-pure.js",
    "utils/toolbox-scope.js",
    "utils/toolbox-worker.js",
    "services/computeClient.js",
    "services/computeWorker.js",
    "sw.js",
  ]),
  tests: Object.freeze([
    "tests/step23-v12-compute.mjs",
    "tests/step1-pwa-verify.mjs",
  ]),
  dependsOn: Object.freeze(["shared"]),
});
