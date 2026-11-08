/**
 * eslint.config.mjs —— v19.0 ESLint flat config（对齐业界标准 + 存量风格）
 * ---------------------------------------------------------------
 * 设计原则（重要）：
 * 本站是长期演进的 classic <script> MPA，全站统一「双引号 + 分号 +
 * var/function + IIFE」。v19.0 是纯优化版本，红线是「绝不改变业务逻辑」。
 * 强行改成单引号会产生上万行无语义 diff，并可能破坏 step27/step28 等
 * 对源码做字符串断言的测试。因此：
 *   - 风格规则对齐现状（quotes: double / semi: always），保证「风格统一」
 *   - 只开启零误报、可静态判定的正确性规则
 *   - classic 全局契约（window.BlogApi / window.UI / EventBus / 纯函数内核）
 *     由 globals 声明，不误报 no-undef
 *   - 作用域：生产前端 JS + 构建脚本；不覆盖 tests/ 的既有断言文件
 *
 * 这是「引入 ESLint 门禁」而非「全量改码」：新增/修改代码受约束，
 * 存量代码零改动即可通过，符合渐进式工程化。
 * 不依赖 @eslint/js：规则显式列出，避免 recommended 规则集对 classic
 * script 与历史写法产生几百条无关告警。
 * ===============================================================
 */

/** classic MPA 的跨文件全局契约（由 window.* 挂载，非 ESM import） */
const CLASSIC_GLOBALS = {
  window: "readonly", document: "readonly", navigator: "readonly", location: "readonly",
  console: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
  setInterval: "readonly", clearInterval: "readonly",
  fetch: "readonly", Request: "readonly", Response: "readonly", Headers: "readonly",
  URL: "readonly", URLSearchParams: "readonly", Blob: "readonly", File: "readonly",
  FileReader: "readonly", FormData: "readonly", AbortController: "readonly",
  Worker: "readonly", importScripts: "readonly", self: "readonly", globalThis: "readonly",
  Event: "readonly", CustomEvent: "readonly", MutationObserver: "readonly",
  IntersectionObserver: "readonly", PerformanceObserver: "readonly",
  localStorage: "readonly", sessionStorage: "readonly", caches: "readonly",
  crypto: "readonly", TextEncoder: "readonly", TextDecoder: "readonly",
  atob: "readonly", btoa: "readonly", alert: "readonly", confirm: "readonly", prompt: "readonly",
  // 浏览器标准 API（存量代码实际使用，缺声明会误报 no-undef）
  requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", requestIdleCallback: "readonly",
  createImageBitmap: "readonly", OffscreenCanvas: "readonly", Image: "readonly", Audio: "readonly",
  XMLHttpRequest: "readonly", ReadableStream: "readonly", WritableStream: "readonly",
  BroadcastChannel: "readonly", indexedDB: "readonly", MediaMetadata: "readonly",
  Notification: "readonly", performance: "readonly", history: "readonly", screen: "readonly",
  getComputedStyle: "readonly", matchMedia: "readonly", DOMParser: "readonly",
  ImageData: "readonly", CanvasRenderingContext2D: "readonly",
  // Node 全局（构建脚本与测试共用同一份 config）
  process: "readonly", Buffer: "readonly", __dirname: "readonly", __filename: "readonly",
  module: "writable", require: "readonly", exports: "writable", structuredClone: "readonly",
  // 项目自有全局单例（详见 src/architecture.mjs 契约）
  BlogApi: "writable", BlogUtils: "writable", UI: "writable", EventBus: "writable",
  ToolboxConstants: "writable", ToolboxPure: "writable", ToolboxCompute: "writable",
  ToolboxDebug: "writable", GameCore: "writable", LrcParser: "writable",
  PlayerHost: "writable", ComputeWorker: "writable", RangeDownloader: "writable",
  PinyinGB2312: "writable", JSZip: "writable", QRCode: "writable",
  BlogConfig: "writable", CONFIG: "writable", promptDialog: "readonly",
};

/** 全站统一风格 + 零误报正确性规则 */
const RULES = {
  // 存量风格：双引号、分号（禁止无意义 churn）
  quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
  semi: ["error", "always"],
  // 正确性：静态可判定、零误报
  "no-unused-vars": ["error", {
    args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_",
    // catch(e) 绑定在存量代码里普遍只作占位；ESLint 官方选项，非放水
    caughtErrors: "none",
  }],
  "no-undef": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-unreachable": "error",
  "no-extra-semi": "error",
  "no-sparse-arrays": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  "no-const-assign": "error",
  "no-dupe-class-members": "error",
  "no-self-compare": "error",
  "no-debugger": "error",
};

export default [
  {
    ignores: [
      "dist/**", "public/**", "build/**", "node_modules/**",
      "vendor/**/*.min.js", "styles/**", "*.zip",
    ],
  },
  {
    files: ["components/**/*.js", "utils/**/*.js", "services/**/*.js", "vendor/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: CLASSIC_GLOBALS },
    rules: RULES,
  },
  {
    // ESM 域：v17 动态分片 / src 契约层 / 构建脚本 / 测试。
    // 注意 flat config 后者覆盖前者：components/global-search.js 是 v11 起
    // 由 common.js 动态 import() 的 ESM，必须放在 classic 组之后才能以
    // sourceType: module 解析（否则报 'import'/'export' 语法错）。
    files: ["components/global-search.js", "modules/**/*.js", "src/**/*.js", "scripts/**/*.mjs", "tests/**/*.mjs"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: CLASSIC_GLOBALS },
    rules: RULES,
  },
];
