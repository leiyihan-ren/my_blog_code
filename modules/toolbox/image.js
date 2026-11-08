/* ============================================================
 * modules/toolbox/image.js —— Tab B 工具分片 10：图片转 Base64（Worker 解码压缩）
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

/** 当前已选图片的原始字节与元信息（模块级私有状态） */
var imgState = { buffer: null, type: "", name: "" };

  /* ============================================================
   * 10 图片转 Base64 —— Worker：ToolboxCompute("image") + 主线程降级
   * ============================================================ */
  function imageFallback() {
    // 主线程降级：FileReader（异步、不阻塞）+ <canvas> 等比压缩。
    // 不用 createObjectURL，避免 blob: URL 外泄与生命周期悬挂。
    return new Promise(function (resolve, reject) {
      if (!imgState.buffer) { reject(new Error("尚未选择图片")); return; }
      var blob = new Blob([imgState.buffer], { type: imgState.type || "image/png" });
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("文件读取失败")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("图片解码失败")); };
        img.onload = function () {
          var maxEdge = parseInt((kit.$("img-max-edge") || {}).value, 10) || kit.C.IMG_DEFAULT_MAX_EDGE;
          var quality = parseInt((kit.$("img-quality") || {}).value, 10) / 100 || kit.C.IMG_DEFAULT_QUALITY;
          var dim = kit.P.fitDimensions(img.naturalWidth, img.naturalHeight, maxEdge);
          var canvas = document.createElement("canvas");
          canvas.width = dim.w; canvas.height = dim.h;
          var ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("无法创建 2D 上下文")); return; }
          ctx.drawImage(img, 0, 0, dim.w, dim.h);
          var mime = imgState.type === "image/png" ? "image/png"
            : imgState.type === "image/webp" ? "image/webp" : "image/jpeg";
          var dataUrl = canvas.toDataURL(mime, quality);
          resolve({
            dataUrl: dataUrl, base64: dataUrl.split(",")[1], mime: mime,
            width: dim.w, height: dim.h, bytes: Math.round(dataUrl.split(",")[1].length * 3 / 4),
            sourceWidth: img.naturalWidth, sourceHeight: img.naturalHeight,
          });
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(blob);
    });
  }

  function renderImage(res) {
    var out = kit.$("img-output"), preview = kit.$("img-preview");
    if (!out) return;
    out.value = res.dataUrl;
    if (preview) { preview.src = res.dataUrl; preview.hidden = false; }
    kit.setStatus("img-status", true,
      "原图 " + res.sourceWidth + "×" + res.sourceHeight + " → 压缩 " + res.width + "×" + res.height +
      " · " + kit.P.formatBytes(res.bytes) + " · " + (res.engine === "worker" ? "Web Worker" : "主线程"));
    kit.text(kit.$("img-dims"), res.width + " × " + res.height);
  }

  function processImage(scope) {
    if (!imgState.buffer) return Promise.resolve();
    var payload = {
      buffer: imgState.buffer,
      type: imgState.type,
      maxEdge: parseInt((kit.$("img-max-edge") || {}).value, 10) || kit.C.IMG_DEFAULT_MAX_EDGE,
      quality: parseInt((kit.$("img-quality") || {}).value, 10) / 100 || kit.C.IMG_DEFAULT_QUALITY,
    };
    kit.setStatus("img-status", true, "处理中…");
    return kit.Compute.exec("image", payload, imageFallback)
      .then(function (res) {
        if (!scope.disposed() && !res.cancelled && res.ok !== false) renderImage(res);
      }, function (e) {
        if (!scope.disposed()) kit.setStatus("img-status", false, (e && e.message) || "图片处理失败");
      });
  }

  function acceptFile(scope, file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { kit.toast("请选择图片文件", "warn"); return; }
    if (file.size > kit.cfg.imgMaxFileBytes) {
      kit.toast("图片超过 " + kit.P.formatBytes(kit.cfg.imgMaxFileBytes) + " 上限", "warn");
      return;
    }
    file.arrayBuffer().then(function (buf) {
      if (scope.disposed()) return;
      imgState.buffer = buf; imgState.type = file.type; imgState.name = file.name;
      kit.text(kit.$("img-name"), file.name + " · " + kit.P.formatBytes(file.size));
      processImage(scope);
    }, function () { if (!scope.disposed()) kit.setStatus("img-status", false, "文件读取失败"); });
  }

  export function init(scope, injectedKit) {
    kit = injectedKit;
    var drop = kit.$("img-drop"), file = kit.$("img-file");
    if (!drop || !file) return;
    scope.on(drop, "click", kit.guarded(scope, function () { file.click(); }));
    scope.on(drop, "dragover", kit.guarded(scope, function (e) { e.preventDefault(); drop.classList.add("is-drag"); }));
    scope.on(drop, "dragleave", kit.guarded(scope, function () { drop.classList.remove("is-drag"); }));
    scope.on(drop, "drop", kit.guarded(scope, function (e) {
      e.preventDefault(); drop.classList.remove("is-drag");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      acceptFile(scope, f);
    }));
    scope.on(file, "change", kit.guarded(scope, function () { acceptFile(scope, file.files && file.files[0]); }));
    scope.on(kit.$("img-max-edge"), "input", kit.scopedDebounce(scope, function () {
      var n = kit.$("img-max-edge-num"); if (n) n.value = kit.$("img-max-edge").value;
      processImage(scope);
    }, kit.cfg.imageDebounceMs));
    scope.on(kit.$("img-quality"), "input", kit.scopedDebounce(scope, function () {
      var n = kit.$("img-quality-num"); if (n) n.value = kit.$("img-quality").value;
      processImage(scope);
    }, kit.cfg.imageDebounceMs));
    scope.on(kit.$("img-btn-clear"), "click", kit.guarded(scope, function () {
      imgState.buffer = null; imgState.type = ""; imgState.name = "";
      file.value = "";
      var out = kit.$("img-output"); if (out) out.value = "";
      var preview = kit.$("img-preview"); if (preview) { preview.removeAttribute("src"); preview.hidden = true; }
      kit.text(kit.$("img-name"), "未选择文件"); kit.text(kit.$("img-dims"), "—");
      kit.setStatus("img-status", true, "等待上传图片");
    }));
    kit.setStatus("img-status", true, "等待上传图片");
  }
