/* ============================================================
 * modules/toolbox/qrcode.js —— Tab B 工具分片 09：二维码生成器（本地 vendor 引擎）
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

/** 最近一次成功生成的二维码矩阵，供下载按钮复用（模块级私有状态） */
var lastQr = null;

  /* ============================================================
   * 09 二维码生成器 —— 纯函数层：ToolboxPure.qrMatrix + vendor/qrcode.js
   * ============================================================ */
  function drawQr(canvas, cells, size) {
    var px = kit.C.QR_MODULE_PX, margin = kit.C.QR_MARGIN_MODULES;
    var side = (size + margin * 2) * px;
    canvas.width = side; canvas.height = side;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = kit.C.QR_BG;
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = kit.C.QR_FG;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (cells[r][c]) ctx.fillRect((c + margin) * px, (r + margin) * px, px, px);
      }
    }
  }

  function runQr() {
    var input = kit.$("qr-text"), ecc = kit.$("qr-ecc"), canvas = kit.$("qr-canvas");
    if (!input || !canvas) return;
    var res = kit.P.qrMatrix(input.value, ecc ? ecc.value : kit.C.QR_DEFAULT_ECC, window.qrcode);
    lastQr = res.ok ? res : null;
    if (!res.ok) {
      var ctx = canvas.getContext("2d");
      if (ctx) { canvas.width = 1; canvas.height = 1; ctx.clearRect(0, 0, 1, 1); }
      kit.setStatus("qr-status", false, res.error);
      kit.text(kit.$("qr-meta"), "—");
      return;
    }
    drawQr(canvas, res.cells, res.size);
    kit.setStatus("qr-status", true, "生成成功 · " + res.size + " × " + res.size + " 模块");
    kit.text(kit.$("qr-meta"), "版本自动选型 · " + res.size + "×" + res.size + " · 纠错 " + (ecc ? ecc.value : kit.C.QR_DEFAULT_ECC));
  }

  function downloadQr() {
    var canvas = kit.$("qr-canvas");
    if (!canvas || !lastQr) { kit.toast("请先生成二维码", "warn"); return; }
    var a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "toolbox-qrcode.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    kit.toast("二维码已开始下载", "success");
  }

  export function init(scope, injectedKit) {
    kit = injectedKit;
    if (!kit.$("qr-text")) return;
    var auto = kit.scopedDebounce(scope, runQr, kit.cfg.qrcodeDebounceMs);
    scope.on(kit.$("qr-text"), "input", auto);
    scope.on(kit.$("qr-ecc"), "change", kit.guarded(scope, runQr));
    scope.on(kit.$("qr-download"), "click", kit.guarded(scope, downloadQr));
    runQr();
  }
