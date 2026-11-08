/* ============================================================
 * modules/toolbox/diff.js —— Tab B 工具分片 11：文本差异对比（Worker LCS）
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
   * 11 文本差异对比 —— Worker：ToolboxCompute("diff")
   * ============================================================ */
  function diffFallback(req) {
    var d = kit.P.diffLines(req.a, req.b);
    return { ops: d.ops, stats: d.stats, truncated: d.truncated };
  }

  function renderDiff(res) {
    var host = kit.$("diff-output");
    if (!host) return;
    host.textContent = "";
    var prefix = { add: "+", del: "-", eq: " " };
    (res.ops || []).forEach(function (op) {
      var line = document.createElement("div");
      line.className = "tb-diff-line tb-diff-" + op.type;
      var gutter = document.createElement("span");
      gutter.className = "tb-diff-gutter";
      gutter.textContent = (op.aLine || "") + (op.bLine ? "/" + op.bLine : "");
      var body = document.createElement("span");
      body.className = "tb-diff-text";
      body.textContent = prefix[op.type] + " " + op.text;
      line.appendChild(gutter); line.appendChild(body);
      host.appendChild(line);
    });
    var s = res.stats || { added: 0, removed: 0, equal: 0 };
    kit.text(kit.$("diff-stats"), "+" + s.added + " 新增 / -" + s.removed + " 删除 / " + s.equal + " 未变" +
      (res.truncated ? " · 超大文本已降级为整块对比" : ""));
    kit.setStatus("diff-status", true, "对比完成 · " + (res.engine === "worker" ? "Web Worker" : "主线程") + " LCS");
  }

  function runDiff(scope) {
    var req = {
      a: (kit.$("diff-a") || {}).value || "",
      b: (kit.$("diff-b") || {}).value || "",
    };
    return kit.Compute.exec("diff", req, function () { return diffFallback(req); })
      .then(function (res) { if (!scope.disposed() && !res.cancelled) renderDiff(res); }, kit.noop);
  }

  export function init(scope, injectedKit) {
    kit = injectedKit;
    if (!kit.$("diff-a")) return;
    var auto = kit.scopedDebounce(scope, function () { runDiff(scope); }, kit.cfg.diffDebounceMs);
    [ kit.$("diff-a"), kit.$("diff-b") ].forEach(function (el) { scope.on(el, "input", auto); });
    scope.on(kit.$("diff-btn-swap"), "click", kit.guarded(scope, function () {
      var a = kit.$("diff-a"), b = kit.$("diff-b");
      var t = a.value; a.value = b.value; b.value = t; runDiff(scope);
    }));
    scope.on(kit.$("diff-btn-clear"), "click", kit.guarded(scope, function () {
      kit.$("diff-a").value = ""; kit.$("diff-b").value = ""; runDiff(scope);
    }));
    runDiff(scope);
  }
