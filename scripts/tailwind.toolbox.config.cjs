/**
 * Tailwind CLI 配置（仅构建期使用，不参与部署）
 * ---------------------------------------------------------------
 * 用法（在仓库根目录执行）：
 *   npx tailwindcss@3.4.17 -c scripts/tailwind.toolbox.config.cjs \
 *     -i styles/toolbox.input.css -o styles/toolbox.css --minify
 *
 * 关键决策：
 *  · corePlugins.preflight = false —— 本站是多页静态站，common.css 已提供
 *    全局重置与设计令牌。开启 preflight 会覆盖 body/h1/ul 等基础样式，
 *    导致全局导航与页脚错位。这里只取 utilities，零全局副作用。
 *  · 产物 styles/toolbox.css 直接入库：Cloudflare Pages 构建脚本只复制文件，
 *    不运行 Tailwind，因此线上不需要 Node 工具链。
 *  · scripts/ 目录被 build-pages.mjs 排除在部署产物之外，本配置不会上线。
 */
module.exports = {
  content: ["./pages/tools.html", "./components/toolbox.js"],
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
