/**
 * services/uploadService.js —— 云盘上传/下载引擎（v7.0 从 drive.html 剥离）
 * ---------------------------------------------------------------
 * 分层职责（v7.0 架构重构核心）：
 *   本文件 = 纯「状态与传输」层：分片切割、断点续传、重试退避、并发队列、
 *   下载重组。不碰任何业务 DOM（唯一例外由 hooks.saveBlob 交还页面）。
 *   drive.html = 纯「渲染」层：只读 UploadService.tasks() 画界面。
 *   两者通过 init(hooks) 注入的回调通信，彻底消除「上传逻辑改一行、
 *   渲染代码崩一片」的耦合（v6.0 及以前的痛）。
 *
 * 协议（与 _worker.js CONFIG.drive 一致，改动需两边同步 + 跑 step7/8/9）：
 *   小文件 ≤8MB：FileReader 整读 → Base64 → 单次 POST /api/drive/upload
 *   大文件 >8MB：File.slice(5MB) 逐片读 → 逐片 POST part → finish 写 manifest
 *   峰值内存：小文件 ≤8MB；大文件每片 ≤5MB（Base64 后 ~7MB），
 *   绝不把整个文件读进内存——浏览器 OOM 从根上消除。
 *
 * 对外 API：
 *   UploadService.init(hooks)     注入宿主能力（getPin/toast/onChange/onAllDone/findChunkedId/saveBlob）
 *   UploadService.addFiles(list)  入队（含合规校验：>2GB 拦截、空文件拦截）
 *   UploadService.retry(task)     失败任务重试（断点续传）
 *   UploadService.tasks()         任务数组（渲染层唯一数据源）
 *   UploadService.isUploading(n)  删除锁：该文件名是否处于上传中
 *   UploadService.downloadChunked(f, btn)  大文件重组下载
 *   UploadService.constants()     当前策略常量（测试/调试用）
 * ---------------------------------------------------------------
 * 加载方式：<script src="/services/uploadService.js"> 置于页面内联脚本之前
 * （页面启动即调用 init，依赖同步可用）。
 * ===============================================================
 */
window.UploadService = (function () {
  "use strict";

  /* ---------- 大小与并发策略（与 Worker CONFIG.drive 保持一致） ---------- */
  var SMALL_LIMIT = 8 * 1024 * 1024; // ≤8MB 直传（Contents API 单次 PUT）
  var CHUNK_SIZE = 5 * 1024 * 1024; // 分片大小 5MB
  var MAX_TOTAL = 2 * 1024 * 1024 * 1024; // 单文件产品级上限 2GB
  var MAX_CONCURRENT = 2; // 同时上传的文件数上限（防浏览器卡死）
  var PART_RETRY = 3; // 单片失败自动重试次数
  var DOWNLOAD_CONCURRENT = 4; // 下载重组并发拉片路数

  /* ---------- 宿主 hooks（页面 init 时注入，缺省安全兜底） ---------- */
  var hooks = {
    getPin: function () { return ""; },
    toast: function () { /* msg, type */ },
    onChange: function () { /* 任务状态变化 → 页面重渲染队列 */ },
    onAllDone: function () { /* 队列全部结束 → 页面刷新文件列表 */ },
    findChunkedId: function () { return ""; }, // 同名已存在大文件的 uploadId（覆盖复用）
    saveBlob: function () { /* blob, name → 页面触发浏览器保存 */ },
  };

  var uploadTasks = [];
  var activeCount = 0; // 当前上传中的任务数（并发上限 MAX_CONCURRENT）

  /* ---------- 工具 ---------- */

  /** 路径编码：逐段 encodeURIComponent 后拼回（保留 "/"），与 Worker 端实现一致 */
  function encodePathSegments(p) {
    return String(p)
      .split("/")
      .map(function (s) { return encodeURIComponent(s); })
      .join("/");
  }

  function genUploadId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /** 某分片的真实字节数（最后一片可能不足 CHUNK_SIZE） */
  function chunkLen(fileSize, index) {
    return Math.min((index + 1) * CHUNK_SIZE, fileSize) - index * CHUNK_SIZE;
  }

  /** 字节数人类可读（拦截提示用，与页面 fmtBytes 行为一致） */
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(2) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  /* ---------- 读取：薄片进内存，绝不整读大文件 ---------- */

  function readAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || "");
        var idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = function () { reject(new Error("文件读取失败")); };
      reader.readAsDataURL(file);
    });
  }

  /** 分片读取：只把 5MB 薄片读进内存，ArrayBuffer → Base64 */
  function readChunkBase64(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var bin = "";
      // 分块拼接避免 String.fromCharCode.apply 的爆栈问题
      var STEP = 0x8000;
      for (var i = 0; i < bytes.length; i += STEP) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
      }
      return btoa(bin);
    });
  }

  /* ---------- XHR 上传助手（统一重试/进度/超时逻辑） ---------- */
  function xhrUpload(method, path, payload, onProgress, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, path);
      xhr.setRequestHeader("x-drive-pin", hooks.getPin());
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.timeout = timeoutMs || 60000;
      if (onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
      }
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          resolve(data);
        } else {
          reject(new Error((data && data.error) || ("上传失败（HTTP " + xhr.status + "）")));
        }
      };
      xhr.onerror = function () { reject(new Error("网络错误：上传中断，请检查网络后重试")); };
      xhr.ontimeout = function () { reject(new Error("上传超时，请重试")); };
      xhr.send(payload === undefined ? undefined : JSON.stringify(payload));
    });
  }

  /* ---------- 小文件直传 ---------- */
  function uploadOne(task) {
    task.status = "reading";
    hooks.onChange();
    return readAsBase64(task.file).then(function (b64) {
      task.status = "uploading";
      hooks.onChange();
      return xhrUpload("POST", "/api/drive/upload", {
        path: "drive/" + task.file.name,
        content: b64,
        message: "drive: upload " + task.file.name
      }, function (loaded, total) {
        task.progress = Math.round((loaded / total) * 100);
        hooks.onChange();
      });
    }).then(function (data) {
      task.progress = 100;
      return data;
    });
  }

  /** 单片上传：自动重试 PART_RETRY 次（指数退避 1s/2s/4s），弱网稳定性的核心 */
  function uploadPartWithRetry(task, index, b64) {
    var attempt = 0;
    function fire() {
      return xhrUpload("POST", "/api/drive/upload/part", {
        uploadId: task.uploadId,
        index: index,
        content: b64
      }, null, 60000).catch(function (e) {
        attempt += 1;
        if (attempt > PART_RETRY) throw e;
        var wait = Math.pow(2, attempt - 1) * 1000;
        task.hint = "第 " + (index + 1) + " 片失败，" + (wait / 1000) + "s 后第 " + attempt + " 次重试…";
        hooks.onChange();
        return new Promise(function (r) { setTimeout(r, wait); }).then(fire);
      });
    }
    return fire();
  }

  /**
   * 大文件分片上传：
   * 1) 先问服务端已有哪些分片（断点续传，重试/继续时跳过已传片）
   * 2) 串行传缺失分片（每片独立 commit，天然断点）
   * 3) 全部到位 → finish 写 manifest
   * 任何失败：保留 task.doneBytes，「继续上传」从断点接着来
   */
  function uploadChunked(task) {
    var file = task.file;
    var total = Math.ceil(file.size / CHUNK_SIZE);
    task.total = total;
    task.status = "checking";
    task.hint = "检查断点…";
    hooks.onChange();

    // 1) 断点查询：服务端已落库分片（合并前端本地记录）
    return xhrUpload("GET", "/api/drive/upload/status?uploadId=" + encodeURIComponent(task.uploadId))
      .then(function (data) {
        var serverParts = (data && data.parts) || [];
        serverParts.forEach(function (i) { task.done[i] = true; });
        task.bytesDone = Object.keys(task.done).reduce(function (s, k) {
          return s + chunkLen(file.size, Number(k));
        }, 0);
        task.progress = Math.round((task.bytesDone / file.size) * 100);
        task.status = "uploading";
        hooks.onChange();

        // 2) 串行传缺失分片。
        // 单片彻底失败不中断后续片（弱网稳定性核心）：收集失败序号，
        // 全部跑完后统一进入失败态——已传分片保留，「继续上传」只补失败的。
        var failedParts = [];
        var chain = Promise.resolve();
        for (var i = 0; i < total; i++) {
          if (task.done[i]) continue;
          (function (idx) {
            chain = chain.then(function () {
              if (task.status === "failed" || task.status === "canceled") return;
              task.hint = "第 " + (idx + 1) + "/" + total + " 片";
              hooks.onChange();
              var blob = file.slice(idx * CHUNK_SIZE, Math.min((idx + 1) * CHUNK_SIZE, file.size));
              return readChunkBase64(blob).then(function (b64) {
                return uploadPartWithRetry(task, idx, b64);
              }).then(function () {
                task.done[idx] = true;
                task.bytesDone += chunkLen(file.size, idx);
                task.progress = Math.round((task.bytesDone / file.size) * 100);
                task.hint = "";
                hooks.onChange();
              }, function () {
                failedParts.push(idx);
                task.hint = "第 " + (idx + 1) + " 片失败，继续传后续片…";
                hooks.onChange();
              });
            });
          })(i);
        }
        return chain.then(function () {
          if (failedParts.length) {
            throw new Error("分片 " + failedParts.map(function (i) { return i + 1; }).join("、") + " 上传失败");
          }
        });
      })
      .then(function () {
        // 3) 收尾：写 manifest
        task.status = "finishing";
        task.hint = "写入清单…";
        hooks.onChange();
        return xhrUpload("POST", "/api/drive/upload/finish", {
          uploadId: task.uploadId,
          name: file.name,
          size: file.size,
          total: total
        });
      })
      .then(function () {
        task.progress = 100;
        task.status = "done";
        task.hint = "";
        hooks.onChange();
      })
      .catch(function (e) {
        if (task.status === "canceled") return;
        task.status = "failed";
        task.error = e.message || "上传失败";
        task.hint = "已传 " + Object.keys(task.done).length + "/" + total + " 片，可继续上传";
        hooks.onChange();
        throw e;
      });
  }

  /* ---------- 并发队列：最多 MAX_CONCURRENT 个文件同时上传 ----------
   * 拖入 10 个大文件也只跑 2 个，其余排队——浏览器不卡死。 */
  function startTask(task) {
    task.status = task.mode === "chunked" ? "checking" : "reading";
    hooks.onChange();
    var job = task.mode === "chunked" ? uploadChunked(task) : uploadOne(task);
    return job.then(function () {
      if (task.status !== "canceled") task.status = "done";
      hooks.onChange();
    }).catch(function (e) {
      if (task.status !== "canceled") {
        task.status = "failed";
        task.error = e.message || "上传失败";
      }
      hooks.onChange();
      if (task.status === "failed") {
        hooks.toast("「" + task.file.name + "」上传失败：" + task.error, "err");
      }
    });
  }

  function retryTask(t) {
    t.status = "pending";
    t.error = "";
    hooks.onChange();
    pumpQueue();
  }

  function pumpQueue() {
    while (activeCount < MAX_CONCURRENT) {
      var next = uploadTasks.find(function (t) { return t.status === "pending"; });
      if (!next) {
        // 全部结束（无活动任务且无等待）：有成功则刷新列表
        if (activeCount === 0 && uploadTasks.some(function (t) { return t.status === "done"; })) {
          hooks.onAllDone();
        }
        return;
      }
      activeCount += 1;
      startTask(next).then(function () {
        activeCount -= 1;
        pumpQueue();
      });
    }
  }

  /* ---------- 大文件重组下载 ----------
   * GitHub 无多 blob 拼接 API，下载只能在浏览器端完成——
   * 读 manifest → 并发 DOWNLOAD_CONCURRENT 路拉分片 raw → Blob 顺序重组。
   * Blob 由浏览器磁盘承载，不全量进 JS 堆；保存动作经 hooks.saveBlob 交还页面。 */
  function downloadChunked(f, btn) {
    var repo = "leiyihan-ren/Blog";
    btn.disabled = true;
    btn.textContent = "⏳ 准备中…";
    return fetch("/api/github/raw/" + repo + "/main/" + encodePathSegments(f.path))
      .then(function (r) {
        if (!r.ok) throw new Error("清单读取失败（HTTP " + r.status + "）");
        return r.json();
      })
      .then(function (manifest) {
        var total = manifest.total || 0;
        var parts = [];
        var next = 0;
        var base = "/api/github/raw/" + repo + "/main/drive/.parts/" + manifest.uploadId + "/part-";
        function pump() {
          var batch = [];
          while (next < total && batch.length < DOWNLOAD_CONCURRENT) { batch.push(next); next += 1; }
          if (!batch.length) {
            var blob = new Blob(parts, { type: "application/octet-stream" });
            btn.disabled = false;
            btn.textContent = "⬇️ 下载";
            hooks.saveBlob(blob, manifest.name || f.name);
            hooks.toast("已重组下载 " + (manifest.name || f.name), "ok");
            return;
          }
          return Promise.all(batch.map(function (idx) {
            var pad = String(idx).padStart(5, "0");
            return fetch(base + pad).then(function (r) {
              if (!r.ok) throw new Error("分片 " + idx + " 拉取失败（HTTP " + r.status + "）");
              return r.blob();
            }).then(function (b) { parts[idx] = b; });
          })).then(function () {
            btn.textContent = "⏳ 重组 " + Math.min(next, total) + "/" + total;
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = "⬇️ 下载";
        hooks.toast(e.message || "重组下载失败", "err");
      });
  }

  /* ---------- 对外 API ---------- */

  /** 入队（原 handleFiles）：合规校验 + 按大小分流直传/分片 */
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var rejected = [];
    files.forEach(function (f) {
      if (f.size > MAX_TOTAL) {
        rejected.push(f.name + "（" + fmtBytes(f.size) + "，超过 2GB 上限）");
      } else if (f.size === 0) {
        rejected.push(f.name + "（空文件）");
      } else if (f.size > SMALL_LIMIT) {
        // 大文件：分片模式（5MB/片，断点续传）
        // 同名覆盖：复用列表中已有条目的 uploadId（parts 与 manifest 覆盖同一处，
        // 避免重复条目；列表中没有则是新文件，生成新 uploadId）
        var existId = hooks.findChunkedId(f.name);
        uploadTasks.push({
          file: f,
          mode: "chunked",
          uploadId: existId || genUploadId(),
          total: Math.ceil(f.size / CHUNK_SIZE),
          done: {}, // 已成功分片序号表
          bytesDone: 0,
          progress: 0,
          status: "pending",
          error: "",
          hint: ""
        });
      } else {
        // 小文件：直传模式（原路径）
        uploadTasks.push({
          file: f,
          mode: "direct",
          progress: 0,
          status: "pending",
          error: "",
          hint: ""
        });
      }
    });
    if (rejected.length) {
      hooks.toast("已拦截不合规文件：" + rejected.join("；"), "err");
    }
    hooks.onChange();
    pumpQueue();
  }

  /** 删除锁：该文件名是否处于上传中（含排队/读取/检查断点/上传中/收尾） */
  function isUploading(name) {
    return uploadTasks.some(function (t) {
      return t.file.name === name &&
        (t.status === "pending" || t.status === "reading" || t.status === "checking" ||
          t.status === "uploading" || t.status === "finishing");
    });
  }

  function init(h) {
    if (!h) return;
    Object.keys(h).forEach(function (k) {
      if (typeof h[k] === "function") hooks[k] = h[k];
    });
  }

  return {
    init: init,
    addFiles: addFiles,
    retry: retryTask,
    tasks: function () { return uploadTasks; },
    isUploading: isUploading,
    downloadChunked: downloadChunked,
    constants: function () {
      return {
        SMALL_LIMIT: SMALL_LIMIT,
        CHUNK_SIZE: CHUNK_SIZE,
        MAX_TOTAL: MAX_TOTAL,
        MAX_CONCURRENT: MAX_CONCURRENT,
        PART_RETRY: PART_RETRY,
        DOWNLOAD_CONCURRENT: DOWNLOAD_CONCURRENT,
      };
    },
  };
})();
