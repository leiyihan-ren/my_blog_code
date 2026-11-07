/**
 * Feature 域契约：blog —— 文章 / 时间线 / 留言 / 友链 / 全局搜索
 */
export default Object.freeze({
  id: "blog",
  layer: "features",
  title: "博客内容",
  entries: Object.freeze([
    "pages/index.html",
    "pages/blog.html",
    "pages/post.html",
    "pages/timeline.html",
    "pages/guestbook.html",
    "pages/links.html",
  ]),
  urls: Object.freeze(["/", "/blog.html", "/post.html", "/timeline.html", "/guestbook.html", "/links.html"]),
  assets: Object.freeze([
    "utils/blog-utils.js",
    "components/global-search.js",
    "vendor/minisearch.js",
  ]),
  tests: Object.freeze([
    "tests/step13-post-concurrency.mjs",
    "tests/step21-v11-global-search.mjs",
    "tests/step24-v12-search-drive.mjs",
  ]),
  dependsOn: Object.freeze(["core", "shared", "services"]),
});
