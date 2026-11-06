/* ============================================================
 * toolbox-constants.js —— 极客工具箱全局常量（v14.0）
 * ------------------------------------------------------------
 * 单一事实来源：所有硬编码的防抖时长、超时阈值、尺寸上限、
 * 强度分档、默认值、状态文案前缀统一收敛于此，UI 层与 Worker
 * 层一律读取本对象，杜绝「魔法数字」散落。
 *
 * 兼容性（三处运行环境共用同一份文件）：
 *   · 主线程经典 <script> → globalThis === window → window.ToolboxConstants
 *   · Web Worker importScripts → globalThis === self → self.ToolboxConstants
 *   · Node ESM（step27 静态校验）→ globalThis → 可读取源码做断言
 * 本文件不含任何 import/export 语句，故三种环境均可直接执行。
 * ============================================================ */
(function (root) {
  "use strict";

  /**
   * 工具箱全局配置常量（冻结，运行期不可篡改）。
   * @typedef {Object} ToolboxConstants
   * @property {string} VERSION 产品版本（与 SW CACHE_VERSION 对齐）
   * @property {number} DEBOUNCE_MS 输入防抖时长
   * @property {number} CLOCK_TICK_MS 实时时钟刷新间隔
   * @property {number} COPY_FEEDBACK_MS 「已复制」按钮反馈复位时长
   * @property {number} IPINFO_AUTO_DELAY_MS 页面加载后自动查询 IP 的延后时间
   * @property {number} PROBE_TIMEOUT_MS 状态码探测超时熔断
   * @property {number} PROBE_RETRY 探测重试次数（实时动作，不重试）
   * @property {number} IPINFO_TIMEOUT_MS IP 查询超时熔断
   * @property {number} IPINFO_RETRY IP 查询重试次数
   * @property {number} WORKER_TIMEOUT_MS 后台重计算超时（灾难性正则/超大 Diff 熔断）
   * @property {number} IDLE_TIMEOUT_MS requestIdleCallback 兜底超时
   * @property {number} PW_MIN_LEN 密码最小长度
   * @property {number} PW_MAX_LEN 密码最大长度
   * @property {number} PW_DEFAULT_LEN 密码默认长度
   * @property {number} PW_ENTROPY_WEAK 熵 < 该值判「弱」
   * @property {number} PW_ENTROPY_MID 熵 < 该值判「中」
   * @property {number} PW_ENTROPY_STRONG 熵 < 该值判「强」，否则「极强」
   * @property {number} PW_BAR_MIN_PCT 强度条最小可见宽度百分比
   * @property {number} PW_BAR_MAX_PCT 强度条最大宽度百分比
   * @property {number} PW_BAR_DIVISOR 熵→百分比换算除数
   * @property {number} B64_CHUNK Base64 分块大小（避免 apply 展开栈溢出）
   * @property {number} REGEX_MAX_MATCHES 正则最多返回匹配数
   * @property {number} REGEX_MAX_TEXT_LEN 正则测试文本最大长度
   * @property {number} DIFF_MAX_LINES Diff 最大行数（超出降级为整块替换）
   * @property {number} DIFF_MAX_CELLS LCS 动态规划最大格子数（防 OOM）
   * @property {number} IMG_MAX_FILE_BYTES 图片文件最大字节数
   * @property {number} IMG_DEFAULT_MAX_EDGE 图片压缩默认最长边像素
   * @property {number} IMG_MIN_EDGE 图片压缩最小边长
   * @property {number} IMG_MAX_EDGE 图片压缩最大边长
   * @property {number} IMG_DEFAULT_QUALITY JPEG/WebP 默认质量
   * @property {string} QR_DEFAULT_ECC 二维码默认纠错等级
   * @property {number} QR_MODULE_PX 二维码单模块像素
   * @property {number} QR_MARGIN_MODULES 二维码静默区（模块数）
   * @property {number} QR_MAX_TEXT_LEN 二维码最大文本长度
   * @property {number} GRADIENT_DEFAULT_ANGLE 线性渐变默认角度
   * @property {string} STATUS_OK 成功状态前缀
   * @property {string} STATUS_ERROR 失败状态前缀
   */
  var C = {
    VERSION: "14.0.0",

    /* ---- 时序 ---- */
    DEBOUNCE_MS: 160,
    CLOCK_TICK_MS: 1000,
    COPY_FEEDBACK_MS: 1200,
    IPINFO_AUTO_DELAY_MS: 60,
    PROBE_TIMEOUT_MS: 12000,
    PROBE_RETRY: 0,
    IPINFO_TIMEOUT_MS: 12000,
    IPINFO_RETRY: 1,
    WORKER_TIMEOUT_MS: 4000,
    IDLE_TIMEOUT_MS: 400,

    /* ---- 密码生成器 ---- */
    PW_MIN_LEN: 8,
    PW_MAX_LEN: 64,
    PW_DEFAULT_LEN: 20,
    PW_ENTROPY_WEAK: 50,
    PW_ENTROPY_MID: 80,
    PW_ENTROPY_STRONG: 120,
    PW_BAR_MIN_PCT: 6,
    PW_BAR_MAX_PCT: 100,
    PW_BAR_DIVISOR: 1.6,

    /* ---- 编码 / 哈希 ---- */
    B64_CHUNK: 0x8000,
    HASH_ALGOS: ["MD5", "SHA-1", "SHA-256", "SHA-512"],

    /* ---- 正则 / Diff ---- */
    REGEX_MAX_MATCHES: 500,
    REGEX_MAX_TEXT_LEN: 200000,
    REGEX_LIST_LIMIT: 8,
    DIFF_MAX_LINES: 2000,
    DIFF_MAX_CELLS: 4000000,

    /* ---- 图片 → Base64 ---- */
    IMG_MAX_FILE_BYTES: 20 * 1024 * 1024,
    IMG_DEFAULT_MAX_EDGE: 1280,
    IMG_MIN_EDGE: 16,
    IMG_MAX_EDGE: 4096,
    IMG_DEFAULT_QUALITY: 0.85,

    /* ---- 二维码 ---- */
    QR_DEFAULT_ECC: "M",
    QR_MODULE_PX: 8,
    QR_MARGIN_MODULES: 4,
    QR_MAX_TEXT_LEN: 800,
    QR_BG: "#FFFFFF",
    QR_FG: "#070B12",

    /* ---- 颜色 / 渐变 ---- */
    GRADIENT_DEFAULT_ANGLE: 135,
    GRADIENT_MIN_ANGLE: 0,
    GRADIENT_MAX_ANGLE: 360,
    GRADIENT_PALETTE_SIZE: 7,
    WCAG_AA: 4.5,
    WCAG_AAA: 7,

    /* ---- HTTP 状态码分档（探测结果着色语义，非魔法数字） ---- */
    HTTP_2XX: 200,
    HTTP_3XX: 300,
    HTTP_4XX: 400,
    HTTP_5XX: 500,

    /* ---- 状态文案 ---- */
    STATUS_OK: "● OK  ",
    STATUS_ERROR: "● ERROR  ",
    STATUS_VALID: "● VALID  ",
  };

  /** @type {ToolboxConstants} */
  root.ToolboxConstants = (typeof Object.freeze === "function") ? Object.freeze(C) : C;
})(typeof globalThis !== "undefined" ? globalThis : this);
