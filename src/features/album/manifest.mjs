/**
 * Feature 域契约：album —— 相册 / 灯箱
 */
export default Object.freeze({
  id: "album",
  layer: "features",
  title: "相册",
  entries: Object.freeze(["pages/album.html"]),
  urls: Object.freeze(["/album.html"]),
  assets: Object.freeze([
    "icons/placeholder-cover.svg",
    "scripts/gen-album-thumbs.py",
  ]),
  tests: Object.freeze([
    "tests/step2-album-dynamic.mjs",
    "tests/step4-lightbox-trap.mjs",
  ]),
  dependsOn: Object.freeze(["core", "shared", "services"]),
});
