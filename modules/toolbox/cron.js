/* ============================================================
 * modules/toolbox/cron.js —— Tab B 工具分片 13：Cron 表达式生成器
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
   * 13 Cron 表达式生成器 —— 纯函数层：buildCron / cronNext / cronDescribe
   * ============================================================ */
  /**
   * 读取五个 Cron 可视化控件的当前取值。
   * @returns {{minute: string, hour: string, dom: string, month: string, dow: string}} 字段对象
   */
  function readCronParts() {
    var parts = {};
    kit.C.CRON_FIELDS.forEach(function (name) {
      parts[name] = (kit.$("cron-" + name) || {}).value || "*";
    });
    return parts;
  }

  /**
   * 设置 select 的值；不存在对应 option 时动态补齐，避免「使用当前时间」出现空白。
   * @param {string} id select 元素 id
   * @param {string|number} value 目标值
   * @returns {void}
   */
  function setCronSelect(id, value) {
    var el = kit.$(id);
    if (!el) return;
    var v = String(value);
    var exists = false;
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].value === v) { exists = true; break; }
    }
    if (!exists) {
      var opt = document.createElement("option");
      opt.value = v; opt.textContent = v;
      el.appendChild(opt);
    }
    el.value = v;
  }

  /**
   * 渲染 Cron 表达式、中文描述与接下来 N 次执行时间。
   * @returns {void}
   */
  function runCron() {
    var built = kit.P.buildCron(readCronParts());
    var expr = kit.$("cron-expression"), out = kit.$("cron-next"), desc = kit.$("cron-describe");
    if (!built.ok) {
      if (expr) expr.value = "";
      if (desc) kit.text(desc, "表达式非法：" + built.error);
      if (out) out.textContent = "";
      kit.text(kit.$("cron-count"), "—");
      kit.setStatus("cron-status", false, built.error);
      return;
    }
    if (expr) expr.value = built.expression;
    var d = kit.P.cronDescribe(built.expression);
    if (desc) kit.text(desc, d.ok ? d.text : "—");
    var next = kit.P.cronNext(built.expression, kit.cfg.cronNextCount, Date.now());
    if (out) {
      out.textContent = "";
      if (!next.ok) {
        var empty = document.createElement("span");
        empty.className = "tb-dim";
        empty.textContent = "扫描窗口内未找到下次执行时间";
        out.appendChild(empty);
      } else {
        var now = Date.now();
        next.times.forEach(function (ts, i) {
          var row = document.createElement("div");
          row.className = "tb-cron-slot";
          var no = document.createElement("span");
          no.className = "tb-cron-no"; no.textContent = "#" + (i + 1);
          var code = document.createElement("code");
          code.textContent = kit.P.formatLocal(new Date(ts)) + " · " +
            ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(ts).getDay()];
          var rel = document.createElement("span");
          rel.className = "tb-cron-rel";
          rel.textContent = kit.P.relativeTime(new Date(ts), now);
          row.appendChild(no); row.appendChild(code); row.appendChild(rel);
          out.appendChild(row);
        });
      }
    }
    kit.text(kit.$("cron-count"), next.count + " 次预测");
    kit.setStatus("cron-status", true, "表达式合法 · " + next.count + " 次预测" +
      (next.truncated ? "（扫描窗口内未凑满）" : ""), "VALID");
  }

  /**
   * 初始化 Cron 工具：五段 select 变更即时重算 + 两个快捷按钮。
   * @param {Object} scope 生命周期作用域
   * @returns {void}
   */
  export function init(scope, injectedKit) {
    kit = injectedKit;
    if (!kit.$("cron-minute")) return;
    kit.C.CRON_FIELDS.forEach(function (name) {
      scope.on(kit.$("cron-" + name), "change", kit.guarded(scope, runCron));
    });
    scope.on(kit.$("cron-btn-reset"), "click", kit.guarded(scope, function () {
      kit.C.CRON_FIELDS.forEach(function (name) {
        var el = kit.$("cron-" + name);
        if (el) el.value = "*";
      });
      runCron();
    }));
    scope.on(kit.$("cron-btn-now"), "click", kit.guarded(scope, function () {
      var d = new Date();
      setCronSelect("cron-minute", d.getMinutes());
      setCronSelect("cron-hour", d.getHours());
      setCronSelect("cron-dom", "*");
      setCronSelect("cron-month", "*");
      setCronSelect("cron-dow", "*");
      runCron();
    }));
    runCron();
  }
