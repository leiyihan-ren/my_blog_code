/* ============================================================
 * modules/toolbox/case.js —— Tab B 工具分片 15：文本大小写转换器
 * ------------------------------------------------------------
 * v17.0 模块一「极致的按需加载」：本文件是原生 ESM 分片，只在用户
 * 首次点击【进阶工具】Tab 时由 components/toolbox.js 通过 import()
 * 动态加载；Tab A 与首屏完全不请求它，从而削减首屏 JS 体积。
 *
 * 依赖全部经 kit 注入（kit.$/text/setStatus/scopedDebounce/guarded/
 * P/C/Compute/noop），零全局耦合、零 DOM 之外的副作用。
 * 业务逻辑自 v15.0 的 UI 薄层逐字迁移，未改写算法；渲染仍遵守
 * 「读 DOM → 调 ToolboxPure / ToolboxCompute → 写 DOM」纪律。
 * 严格 CSP：无 eval / 无内联脚本 / 无第三方请求 / 零 console 输出。
 * ============================================================ */

/** 依赖注入容器：由 init(scope, injectedKit) 赋值，供本模块全部辅助函数共享 */
var kit = null;

/** 各转换模式的中文标签（模块级私有常量） */
var CASE_LABELS = {
  upper: "全大写 UPPER", lower: "全小写 lower", title: "首字母大写 Title Case",
  camel: "驼峰 camelCase", pascal: "帕斯卡 PascalCase",
  snake: "下划线 snake_case", kebab: "短横线 kebab-case",
};

  /* ============================================================
   * 15 文本大小写转换器 —— 纯函数层：convertCase / splitWords
   * ============================================================ */

  /**
   * 渲染词元切分结果。
   * @param {string[]} words 词元数组
   * @returns {void}
   */
  function renderTokens(words) {
    var host = kit.$("case-tokens");
    if (!host) return;
    host.textContent = "";
    kit.text(kit.$("case-words"), words.length + " 个");
    words.forEach(function (w) {
      var s = document.createElement("span");
      s.className = "tb-token"; s.textContent = w;
      host.appendChild(s);
    });
    if (!words.length) {
      var e = document.createElement("span");
      e.className = "tb-dim"; e.textContent = "—";
      host.appendChild(e);
    }
  }

  /**
   * 按指定模式转换文本并刷新输出 / 词元 / 激活态按钮。
   * @param {string} mode 目标形态
   * @returns {void}
   */
  function runCase(mode) {
    var input = kit.$("case-input"), out = kit.$("case-output");
    if (!input || !out) return;
    var r = kit.P.convertCase(input.value, mode);
    if (!r.ok) {
      out.value = "";
      kit.setStatus("case-status", false, r.error);
      return;
    }
    out.value = r.value;
    kit.text(kit.$("case-mode-label"), CASE_LABELS[mode] || mode);
    document.querySelectorAll("#case-modes [data-case]").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-case") === mode);
    });
    renderTokens(r.words);
    kit.setStatus("case-status", true, "已转换 · " + r.words.length + " 个词元 · " + r.value.length + " 字符", "VALID");
  }

  /**
   * 初始化大小写工具：模式按钮委托 + 输入防抖重算 + 清空。
   * @param {Object} scope 生命周期作用域
   * @returns {void}
   */
  export function init(scope, injectedKit) {
    kit = injectedKit;
    var input = kit.$("case-input");
    if (!input) return;
    var currentMode = "camel";
    var rerun = function () { runCase(currentMode); };
    scope.on(input, "input", kit.scopedDebounce(scope, rerun, kit.cfg.caseDebounceMs));
    scope.on(kit.$("case-modes"), "click", kit.guarded(scope, function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-case]") : null;
      if (!b) return;
      currentMode = b.getAttribute("data-case");
      rerun();
    }));
    scope.on(kit.$("case-btn-clear"), "click", kit.guarded(scope, function () {
      input.value = ""; rerun();
    }));
    rerun();
  }
