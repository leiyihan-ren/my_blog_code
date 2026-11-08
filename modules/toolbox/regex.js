/* ============================================================
 * modules/toolbox/regex.js —— Tab B 工具分片 08：正则表达式测试器（Worker 重计算）
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
   * 08 正则表达式测试器 —— Worker：ToolboxCompute("regex")
   * ============================================================ */
  var REGEX_FLAGS = ["g", "i", "m", "s", "u"];

  function readRegex() {
    var flags = REGEX_FLAGS.filter(function (f) {
      var el = kit.$("regex-flag-" + f); return !!(el && el.checked);
    }).join("");
    return {
      pattern: (kit.$("regex-pattern") || {}).value || "",
      flags: flags,
      text: (kit.$("regex-input") || {}).value || "",
    };
  }

  function regexFallback(req) {
    var r = kit.P.runRegex(req.pattern, req.flags, req.text);
    return {
      ok: r.ok, error: r.error || "", matches: r.matches, count: r.count,
      truncated: r.truncated, hasGroups: r.hasGroups,
      segments: r.ok ? kit.P.regexSegments(req.text, r.matches) : [],
    };
  }

  function renderRegex(res) {
    var host = kit.$("regex-output"), groups = kit.$("regex-groups"), list = kit.$("regex-match-list");
    if (!host) return;
    host.textContent = "";
    if (groups) groups.textContent = "";
    if (list) list.textContent = "";
    if (!res.ok) {
      var err = document.createElement("span");
      err.className = "tb-tok-err";
      err.textContent = "正则非法：" + (res.error || "未知错误");
      host.appendChild(err);
      kit.setStatus("regex-status", false, "表达式无法解析（已局部隔离，未影响其他工具）");
      kit.text(kit.$("regex-count"), "—");
      return;
    }
    var src = readRegex().text;
    (res.segments || []).forEach(function (seg) {
      var span = document.createElement("span");
      span.className = seg.kind === "group" ? "tb-rx-group tb-rx-group-" + (seg.groupIndex % 5 + 1)
        : seg.kind === "match" ? "tb-rx-match" : "";
      span.textContent = src.slice(seg.start, seg.end);
      host.appendChild(span);
    });
    kit.text(kit.$("regex-count"), res.count + (res.truncated ? "（已截断）" : ""));
    kit.setStatus("regex-status", true,
      (res.hasGroups ? "捕获组已高亮 · " : "") + res.count + " 处匹配 · " +
      (res.engine === "worker" ? "Web Worker 计算" : "主线程计算"));
    if (list) {
      var shown = (res.matches || []).slice(0, kit.C.REGEX_LIST_LIMIT);
      shown.forEach(function (mt, i) {
        var li = document.createElement("div");
        li.className = "tb-rx-item";
        var no = document.createElement("span");
        no.className = "tb-rx-no"; no.textContent = "#" + (i + 1) + " @" + mt.index;
        var val = document.createElement("code");
        val.textContent = mt.text;
        li.appendChild(no); li.appendChild(val);
        list.appendChild(li);
      });
    }
    if (groups && res.hasGroups) {
      var first = (res.matches || [])[0];
      if (first) first.groups.forEach(function (g) {
        var row = document.createElement("div");
        row.className = "tb-rx-grow";
        var k = document.createElement("span"); k.className = "tb-rx-no"; k.textContent = "$" + g.index;
        var v = document.createElement("code"); v.textContent = g.text || "(未参与匹配)";
        row.appendChild(k); row.appendChild(v); groups.appendChild(row);
      });
    }
  }

  function runRegex(scope) {
    var req = readRegex();
    return kit.Compute.exec("regex", req, function () { return regexFallback(req); })
      .then(function (res) { if (!scope.disposed() && !res.cancelled) renderRegex(res); }, kit.noop);
  }

  export function init(scope, injectedKit) {
    kit = injectedKit;
    if (!kit.$("regex-pattern")) return;
    var auto = kit.scopedDebounce(scope, function () { runRegex(scope); }, kit.cfg.regexDebounceMs);
    [ kit.$("regex-pattern"), kit.$("regex-input") ].forEach(function (el) {
      scope.on(el, "input", auto);
    });
    REGEX_FLAGS.forEach(function (f) {
      scope.on(kit.$("regex-flag-" + f), "change", kit.guarded(scope, function () { runRegex(scope); }));
    });
    scope.on(kit.$("regex-btn-clear"), "click", kit.guarded(scope, function () {
      var t = kit.$("regex-input"); if (t) t.value = ""; runRegex(scope);
    }));
    runRegex(scope);
  }
