/** Feature 域契约：drive —— 极客云盘（分片/断点/原子上传/Range 下载） */
export default Object.freeze({
  id: "drive",
  layer: "features",
  title: "极客云盘",
  entries: Object.freeze(["pages/drive.html", "pages/admin.html"]),
  urls: Object.freeze(["/drive.html", "/admin.html"]),
  assets: Object.freeze([
    "styles/drive.css",
    "services/uploadService.js",
    "services/uploadWorker.js",
    "services/rangeDownloader.js",
    "vendor/jszip.min.js",
  ]),
  tests: Object.freeze([
    "tests/step7-drive-api.mjs",
    "tests/step11-drive-state-machine.mjs",
    "tests/step19-v11-range.mjs",
    "tests/step20-v11-atomic-upload.mjs",
  ]),
  dependsOn: Object.freeze(["core", "services", "shared"]),
});
