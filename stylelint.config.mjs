/**
 * stylelint.config.mjs —— v19.0 Stylelint 门禁（零误报优先）
 * ---------------------------------------------------------------
 * 本站 CSS 含 Tailwind 编译产物、CSS 自定义属性、@view-transition、
 * animation-timeline、::-webkit-scrollbar 等非标准/新特性。Stylelint 17
 * 已移除 stylistic 规则，本配置只启用「静态可判定、零误报」的正确性规则，
 * 不强制 BEM 重命名（存量类名被 33 套件与 JS 字符串引用，重命名即回归）。
 *
 * BEM 作为新增样式的约定写入 src/shared/manifest.mjs 契约，不作历史清算。
 * ===============================================================
 */
export default {
  ignoreFiles: [
    "dist/**", "public/**", "build/**", "node_modules/**",
    "styles/toolbox.css", // Tailwind CLI 编译产物，非手写源
  ],
  rules: {
    "color-no-invalid-hex": true,
    "block-no-empty": true,
    "declaration-block-no-duplicate-properties": true,
    // 关闭：common.css / critical.css 有意把设计令牌分块定义在多个 :root /
    // body.dark 中（每次迭代增量追加），toolbox.input.css 也有分节追加的
    // .tb-tab/.tb-card 规则。合并会改变级联顺序并可能引入回归，属规则误报。
    "no-duplicate-selectors": null,
    "unit-no-unknown": true,
    "selector-pseudo-class-no-unknown": [true, { ignorePseudoClasses: ["global", "local"] }],
    "selector-pseudo-element-no-unknown": [true, { ignorePseudoElements: ["view-transition-old", "view-transition-new", "-webkit-scrollbar", "-webkit-scrollbar-thumb", "-webkit-scrollbar-track"] }],
    "at-rule-no-unknown": [true, { ignoreAtRules: ["view-transition", "supports", "keyframes", "-webkit-keyframes", "tailwind", "apply", "layer", "font-face"] }],
    "comment-no-empty": true,
    "no-invalid-double-slash-comments": true,
  },
};
