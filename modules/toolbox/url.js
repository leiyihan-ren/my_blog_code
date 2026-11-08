/* ============================================================
 * modules/toolbox/url.js —— Tab B 工具分片 14：URL 编解码器
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

  /* ============================================================
   * 14 URL 编解码器 —— 纯函数层：urlConvert / parseQuery
   * ============================================================ */

  /**
   * 渲染 Query 参数表（展示解码后的键与值，非法编码标红）。
   * @param {string} src 原始输入串
   * @returns {void}
   */
  /**
   * 把 Query 参数视图模型写入 DOM。
   * v16.0：计数文案、空态判定、空值/非法编码标记已下沉至
   * ToolboxPure.queryViewModel，本函数只负责 DOM 写入。
   * @param {string} src 原始 URL 或查询串
   * @returns {void}
   */
  function renderQuery(src) {
    var tbody = kit.$("url-params");
    if (!tbody) return;
    tbody.textContent = "";
    var vm = kit.P.queryViewModel(src);
    kit.text(kit.$("url-param-count"), vm.countLabel);
    if (vm.empty) {
      var tr0 = document.createElement("tr"), td0 = document.createElement("td");
      td0.colSpan = 2; td0.className = "tb-url-empty";
      td0.textContent = "（无 Query 参数，或输入为纯组件串）";
      tr0.appendChild(td0); tbody.appendChild(tr0);
      return;
    }
    vm.rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var a = document.createElement("td"), b = document.createElement("td");
      a.textContent = r.key;
      b.textContent = r.value;
      if (r.invalid) b.className = "tb-tok-err";
      tr.appendChild(a); tr.appendChild(b); tbody.appendChild(tr);
    });
  }

  /**
   * 按当前方向 / 作用域执行 URL 转换并刷新参数表。
   * @returns {void}
   */
  function runUrl() {
    var input = kit.$("url-input"), out = kit.$("url-output");
    if (!input || !out) return;
    var mode = (kit.$("url-mode") || {}).value || "encode";
    var scopeName = (kit.$("url-scope") || {}).value || "query";
    var src = input.value;
    if (!src) {
      out.value = "";
      renderQuery("");
      kit.setStatus("url-status", true, "等待输入");
      return;
    }
    var r = kit.P.urlConvert(src, mode, scopeName);
    if (!r.ok) {
      out.value = "";
      kit.setStatus("url-status", false, r.error);
      return;
    }
    out.value = r.value;
    var q = kit.P.parseQuery(src);
    renderQuery(src);
    kit.setStatus("url-status", true,
      (mode === "decode" ? "已解码 · " : "已编码 · ") + q.count + " 个参数 · " +
      (r.invalid || 0) + " 处非法编码已隔离", "VALID");
  }

  /**
   * 初始化 URL 工具：输入防抖转换 + 方向/作用域切换 + 两个快捷按钮。
   * @param {Object} scope 生命周期作用域
   * @returns {void}
   */
  export function init(scope, injectedKit) {
    kit = injectedKit;
    var input = kit.$("url-input"), mode = kit.$("url-mode"), scopeSel = kit.$("url-scope");
    if (!input) return;
    var auto = kit.scopedDebounce(scope, runUrl, kit.cfg.urlDebounceMs);
    scope.on(input, "input", auto);
    scope.on(mode, "change", kit.guarded(scope, runUrl));
    scope.on(scopeSel, "change", kit.guarded(scope, runUrl));
    scope.on(kit.$("url-btn-encode"), "click", kit.guarded(scope, function () {
      mode.value = "encode"; runUrl();
    }));
    scope.on(kit.$("url-btn-decode"), "click", kit.guarded(scope, function () {
      mode.value = "decode"; runUrl();
    }));
    scope.on(kit.$("url-btn-clear"), "click", kit.guarded(scope, function () {
      input.value = ""; runUrl(); input.focus();
    }));
    runUrl();
  }
