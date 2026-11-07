/** Feature 域契约：player —— 全局播放内核 / 独立窗口 / 歌词 */
export default Object.freeze({
  id: "player",
  layer: "features",
  title: "音乐播放器",
  entries: Object.freeze(["pages/player.html"]),
  urls: Object.freeze(["/player.html"]),
  assets: Object.freeze([
    "components/music-player.js",
    "components/player-engine.js",
    "components/player-host.js",
    "components/lrc.js",
  ]),
  tests: Object.freeze([
    "tests/step2-music-dynamic.mjs",
    "tests/step22-v12-player.mjs",
  ]),
  dependsOn: Object.freeze(["core", "services", "shared"]),
});
