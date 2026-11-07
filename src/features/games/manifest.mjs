/** Feature 域契约：games —— 游戏大厅与 7 个小游戏内核 */
export default Object.freeze({
  id: "games",
  layer: "features",
  title: "游戏大厅",
  entries: Object.freeze(["pages/games.html"]),
  urls: Object.freeze(["/games.html"]),
  assets: Object.freeze([
    "components/game-core.js",
    "components/games/breakout.js",
    "components/games/g2048.js",
    "components/games/hanoi.js",
    "components/games/memory.js",
    "components/games/mines.js",
    "components/games/reaction.js",
    "components/games/snake.js",
  ]),
  tests: Object.freeze(["tests/step3-ui-stress.mjs"]),
  dependsOn: Object.freeze(["core", "services", "shared"]),
});
