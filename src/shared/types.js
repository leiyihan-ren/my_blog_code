/* ============================================================
 * src/shared/types.js —— 全局类型契约（JSDoc / types.ts 等价物）
 * ------------------------------------------------------------
 * 本站是纯 JavaScript MPA（零 TypeScript、零打包）。在 JS 栈下，
 * TypeScript 的 `types.ts` 正统等价物就是「全局 JSDoc @typedef」：
 * VS Code / tsc --allowJs --checkJs 均可识别，且零运行时开销。
 *
 * ⚠️ 本文件是纯注释契约：不加载、不执行、不进生产产物
 *    （scripts/build-pages.mjs 已把 src/ 排除部署）。
 *    所有 typedef 处于全局作用域，任意 .js 文件可直接引用类型名，
 *    不需要 import —— 这与全站 `<script>` 全局挂载模式保持一致。
 *
 * 分层归属：src/shared/ —— 跨功能域复用的公共类型。
 * ============================================================ */

/**
 * 任意可经 JSON 序列化的值。
 * @typedef {null|boolean|number|string|JsonValue[]|{[key:string]: JsonValue}} JsonValue
 */

/**
 * 统一 API 响应信封。Worker 的所有 `/api/*` 出口均遵循此形状。
 * @template T
 * @typedef {Object} ApiResult
 * @property {boolean} ok 业务是否成功
 * @property {T} [data] 成功后附的数据
 * @property {string} [error] 失败时的可读提示
 * @property {string} [code] 机器可读错误码（如 SSRF_BLOCKED / NOT_FOUND）
 */

/**
 * 工具箱 15 个工具的稳定标识。
 * @typedef {"json"|"b64"|"ts"|"pw"|"hash"|"probe"|"ip"|
 *           "regex"|"qrcode"|"image"|"diff"|"gradient"|
 *           "cron"|"url"|"case"} ToolboxToolId
 */

/**
 * 工具箱 Tab 分类。
 * @typedef {"basic"|"advanced"} ToolboxTab
 */

/**
 * 纯函数层返回的标准结果（失败时绝不抛异常，交由 UI 局部隔离）。
 * @template T
 * @typedef {Object} PureResult
 * @property {boolean} ok 是否成功
 * @property {T} [value] 成功结果
 * @property {string} [error] 失败原因（面向用户）
 */

/** @typedef {{key:string, value:string, invalid:boolean}} QueryParam */

/**
 * 展示塑形层（presenter）输出：只含数据，不含任何 DOM 引用。
 * UI 薄层消费它做一次性 DOM 写入，从而彻底与业务规则解耦。
 * @typedef {Object} ProbeViewModel
 * @property {string} badgeClass 状态码分档对应的 CSS 类
 * @property {string} codeText 状态码文本（无状态为 ERR）
 * @property {string} desc 状态描述
 * @property {string} latency 耗时文本
 * @property {string} method 请求方法
 * @property {string} target 目标 URL
 * @property {Array<{key:string, value:string}>} headers 响应头键值对
 * @property {string} noteClass 提示条附加类
 * @property {string} note 提示文本
 *
 * @typedef {Object} IpViewModel
 * @property {string} query 查询 IP
 * @property {string} location 国家/地区/城市拼接
 * @property {string} continent 大洲
 * @property {string} isp 运营商
 * @property {string} org 组织
 * @property {string} asn ASN
 * @property {string} timezone 时区
 * @property {string} source 数据来源
 * @property {string} elapsed 耗时文本
 * @property {string} noteClass 提示条附加类
 * @property {string} note 提示文本
 *
 * @typedef {Object} QueryViewModel
 * @property {string} countLabel 参数计数文案
 * @property {boolean} empty 是否展示空态
 * @property {Array<{key:string, value:string, invalid:boolean}>} rows 参数行
 */

/**
 * Cron 五段表达式的结构化表示。
 * @typedef {Object} CronParts
 * @property {string} minute 分
 * @property {string} hour 时
 * @property {string} dom 日
 * @property {string} month 月
 * @property {string} dow 周
 */

/** @typedef {"upper"|"lower"|"title"|"camel"|"pascal"|"snake"|"kebab"} CaseMode */

/**
 * 生命周期作用域句柄：所有监听器/定时器/Worker 均登记于此，
 * Tab 切换时一次性 dispose，杜绝内存泄漏。
 * @typedef {Object} ScopeHandle
 * @property {(target:Object, type:string, fn:Function) => void} on
 * @property {(fn:Function, ms:number) => void} timeout
 * @property {(fn:Function, ms:number) => void} interval
 * @property {() => boolean} disposed
 * @property {() => void} dispose
 */

/**
 * Web Worker 重计算结果。
 * @template T
 * @typedef {Object} ComputeResult
 * @property {boolean} ok 是否成功
 * @property {T} [value] 计算结果
 * @property {boolean} [cancelled] 是否已被取消
 * @property {"worker"|"main"} [engine] 实际执行引擎
 */

/** @typedef {{id:string, title:string, date:string, tags:string[], content:string}} BlogPost */
/** @typedef {{id:string, src:string, thumb:string, title:string, date:string}} AlbumItem */
/** @typedef {{path:string, name:string, size:number, type:"file"|"dir", sha?:string}} DriveEntry */
/** @typedef {{id:string, title:string, artist:string, src:string, cover?:string, lrc?:string}} MusicTrack */
