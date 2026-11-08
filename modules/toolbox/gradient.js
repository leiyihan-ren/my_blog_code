/* ============================================================
 * modules/toolbox/gradient.js —— Tab B 工具分片 12：颜色与渐变生成器
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
   * 12 颜色与渐变生成器 —— 纯函数层：buildGradientCss / palette / contrast
   * ============================================================ */
  function runGradient() {
    var c1 = (kit.$("grad-c1") || {}).value || "#39FF14";
    var c2 = (kit.$("grad-c2") || {}).value || "#0EA5E9";
    var angle = parseInt((kit.$("grad-angle") || {}).value, 10);
    var type = (kit.$("grad-type") || {}).value || "linear";
    var css = kit.P.buildGradientCss({
      type: type, angle: angle,
      stops: [{ color: c1, pos: 0 }, { color: c2, pos: 100 }],
    });
    var preview = kit.$("grad-preview");
    if (preview) preview.style.background = css;
    var out = kit.$("grad-css");
    if (out) out.value = "background: " + css + ";";
    var ratio = kit.P.contrastRatio(c1, c2);
    var judge = ratio >= kit.C.WCAG_AAA ? "AAA 级" : ratio >= kit.C.WCAG_AA ? "AA 级" : "偏低";
    kit.text(kit.$("grad-contrast"), ratio.toFixed(2) + ":1 · " + judge);
    kit.text(kit.$("grad-hex"), c1.toUpperCase() + " → " + c2.toUpperCase());
    var rgb1 = kit.P.hexToRgb(c1), rgb2 = kit.P.hexToRgb(c2);
    kit.text(kit.$("grad-rgb"), (rgb1 ? "rgb(" + rgb1.r + "," + rgb1.g + "," + rgb1.b + ")" : "—") +
      " → " + (rgb2 ? "rgb(" + rgb2.r + "," + rgb2.g + "," + rgb2.b + ")" : "—"));
    var hsl = rgb1 ? kit.P.rgbToHsl(rgb1.r, rgb1.g, rgb1.b) : null;
    kit.text(kit.$("grad-hsl"), hsl ? "hsl(" + hsl.h + ", " + hsl.s + "%, " + hsl.l + "%)" : "—");
    var host = kit.$("grad-palette");
    if (host) {
      host.textContent = "";
      kit.P.gradientPalette(c1, c2, kit.C.GRADIENT_PALETTE_SIZE).forEach(function (hex) {
        var sw = document.createElement("span");
        sw.className = "tb-swatch";
        sw.style.background = hex;
        sw.title = hex;
        var code = document.createElement("code");
        code.textContent = hex;
        sw.appendChild(code);
        host.appendChild(sw);
      });
    }
    kit.setStatus("grad-status", true, "CSS 已生成 · 可直接复制");
  }

  export function init(scope, injectedKit) {
    kit = injectedKit;
    if (!kit.$("grad-c1")) return;
    ["grad-c1", "grad-c2", "grad-angle", "grad-type"].forEach(function (id) {
      var el = kit.$(id);
      scope.on(el, "input", kit.guarded(scope, function () {
        if (id === "grad-angle") { var n = kit.$("grad-angle-num"); if (n) n.value = el.value; }
        runGradient();
      }));
      scope.on(el, "change", kit.guarded(scope, runGradient));
    });
    scope.on(kit.$("grad-random"), "click", kit.guarded(scope, function () {
      kit.$("grad-c1").value = kit.P.randomHex();
      kit.$("grad-c2").value = kit.P.randomHex();
      runGradient();
    }));
    scope.on(kit.$("grad-swap"), "click", kit.guarded(scope, function () {
      var a = kit.$("grad-c1"), b = kit.$("grad-c2");
      var t = a.value; a.value = b.value; b.value = t; runGradient();
    }));
    runGradient();
  }
