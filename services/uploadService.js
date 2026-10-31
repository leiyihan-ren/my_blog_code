/**
 * services/uploadService.js —— 云盘上传/下载引擎（v7.0 从 drive.html 剥离；v7.1 状态机重构）
 * ---------------------------------------------------------------
 * 分层职责（v7.0 架构重构核心）：
 *   本文件 = 纯「状态与传输」层：分片切割、断点续传、重试退避、并发队列、
 *   暂停/恢复/取消、下载重组。不碰任何业务 DOM（唯一例外由 hooks.saveBlob 交还页面）。
 *   drive.html = 纯「渲染」层：只读 UploadService.tasks() 画界面。
 *   两者通过 init(hooks) 注入的回调通信，彻底消除「上传逻辑改一行、
 *   渲染代码崩一片」的耦合（v6.0 及以前的痛）。
 *
 * 状态机（v7.1 显式化，全部流转集中在本文件，UI 只读不写）：
 *   pending ──┬─→ reading ──→ uploading ──→ finishing ──→ done      （小文件直传/分片收尾）
 *             ├─→ checking ─→ uploading ──→ finishing ──→ done      （大文件分片主链）
 *             └─→（任意活动态）──pause()──→ paused ──resume()──→ pending（断点续传）
 *   任意活动态 ──失败（重试耗尽）──→ failed ──retry()/online 自动恢复──→ pending
 *   任意活动态 ──cancel()──→ canceled（出队；服务端已传分片保留供续传）
 *   ACTIVE_STATES 占并发槽；paused/failed/done/canceled 均不占槽。
 *
 * 崩溃恢复（v7.2，强关浏览器不断点）：
 *   未完成的分片任务元数据（uploadId/已传分片表）防抖持久化到 localStorage；
 *   页面重开 restore() 将其恢复为「等待文件」态，用户重新选择同名文件即续传。
 *
 * 协议（与 _worker.js CONFIG.drive 一致，改动需两边同步 + 跑 step7/8/9/11）：
 *   小文件 ≤8MB：FileReader 整读 → Base64 → 单次 POST /api/drive/upload
 *   大文件 >8MB：File.slice(5MB) 逐片读 → 逐片 POST part → finish 写 manifest
 *   峰值内存：小文件 ≤8MB；大文件每片 ≤5MB（Base64 后 ~7MB），
 *   绝不把整个文件读进内存——浏览器 OOM 从根上消除。
 *
 * 对外 API：
 *   UploadService.init(hooks)     注入宿主能力（getPin/toast/onChange/onAllDone/findChunkedId/saveBlob）
 *   UploadService.addFiles(list)  入队（含合规校验：>2GB 拦截、空文件拦截）
 *   UploadService.retry(task)     失败任务重试（断点续传）
 *   UploadService.restore()       页面加载时恢复上次未完成的分片任务（等待文件态）
 *   UploadService.flushPersist()  同步落盘崩溃恢复数据（beforeunload/pagehide 用）
 *   UploadService.pause(task)     暂停任务（abort 在途 XHR，释放并发槽）
 *   UploadService.resume(task)    恢复暂停任务（从断点继续）
 *   UploadService.pauseAll()      暂停全部活动任务（返回暂停个数）
 *   UploadService.resumeAll()     恢复全部暂停任务
 *   UploadService.cancel(task)    取消任务（出队；已传分片保留在服务端）
 *   UploadService.tasks()         任务数组（渲染层唯一数据源）
 *   UploadService.isUploading(n)  删除锁：该文件名是否处于上传中
 *   UploadService.isBusy()        是否有任何活动任务（beforeunload 防误关用）
 *   UploadService.downloadChunked(f, btn)  大文件重组下载
 *   UploadService.constants()     当前策略常量（测试/调试用）
 *   UploadService.STATE           状态枚举（渲染层映射状态文案用）
 * ---------------------------------------------------------------
 * 加载方式：<script src="/services/uploadService.js"> 置于页面内联脚本之前
 * （页面启动即调用 init，依赖同步可用）。
 * ===============================================================
 */
window.UploadService = (function () {
  "use strict";

  /* ---------- 大小与并发策略（与 Worker CONFIG.drive 保持一致） ---------- */
  var SMALL_LIMIT = 8 * 1024 * 1024; // ≤8MB 直传（Contents API 单次 PUT）
  // v8.2 分片调优：5MB → 8MB。
  //   权衡：片越大请求越少（握手/排队/TLS 开销摊薄），但单片超时与内存风险上升。
  //   8MB 处在「请求数 × 单片耗时」的谷底：100MB 文件由 20 片降到 13 片，
  //   Base64 后单片请求体约 10.7MB，仍在 CF 100MB body 上限与写超时内的安全区。
  // ⚠️ 改动必须与 _worker.js 的 CONFIG.drive.chunkSize / maxPartBodyBytes 同步。
  var CHUNK_SIZE = 8 * 1024 * 1024; // 分片大小 8MB
  var MAX_TOTAL = 2 * 1024 * 1024 * 1024; // 单文件产品级上限 2GB
  var MAX_CONCURRENT = 3; // 同时上传的文件数上限（v7.1：2→3，step9 V5 / step11 S5 守护）
  var PART_PARALLEL = 3; // v8.2：单文件内并行上传的分片数（与文件间并发相乘为总并发上限）
  var PART_RETRY = 3; // 单片失败自动重试次数
  var DL_PART_RETRY = 2; // v8.2：下载单片失败重试次数（GitHub raw 突发限流自愈）
  var DOWNLOAD_CONCURRENT = 4; // 下载重组并发拉片路数

  /* ---------- 状态机（v7.1）：值保持既有字符串，UI/测试零破坏 ---------- */
  var STATE = {
    PENDING: "pending",       // 排队中（占并发槽）
    READING: "reading",       // 小文件整读中
    CHECKING: "checking",     // 分片模式：断点查询中
    UPLOADING: "uploading",   // 传输中
    FINISHING: "finishing",   // 分片收尾：写 manifest
    PAUSED: "paused",         // 用户暂停（释放并发槽，保留断点）
    FAILED: "failed",         // 失败终态（重试耗尽；可重试/可自动恢复）
    DONE: "done",             // 成功终态
    CANCELED: "canceled",     // 已取消（出队）
  };
  var ACTIVE_STATES = [STATE.PENDING, STATE.READING, STATE.CHECKING, STATE.UPLOADING, STATE.FINISHING];
  var RESUMABLE_STATES = [STATE.PAUSED, STATE.FAILED]; // 可进入 pending 的状态

  /** 暂停哨兵：abort/暂停检查统一抛出，各 catch 依 task.status 判读，绝不误报失败 */
  var PAUSE_SENTINEL = { __paused: true };

  /** 活动态守卫：暂停/取消后，读取或发送前必须检查，杜绝「暂停了还在传」 */
  function throwIfPaused(task) {
    if (task.status === STATE.PAUSED || task.status === STATE.CANCELED) throw PAUSE_SENTINEL;
  }

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

  /** 统一通知：状态变化 → 页面重渲染 + 崩溃恢复持久化（防抖 400ms 合并高频进度 tick） */
  function notify() {
    hooks.onChange();
    schedulePersist();
  }

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

  /** 字节单位常量（与 BlogUtils.fmtBytes 同值；服务层不依赖页面全局，私有一份） */
  var BYTES_PER_KB = 1024;
  var BYTES_PER_MB = BYTES_PER_KB * 1024;
  var BYTES_PER_GB = BYTES_PER_MB * 1024;

  /** 字节数人类可读（拦截提示用，与页面 fmtBytes 行为一致） */
  function fmtBytes(n) {
    if (n < BYTES_PER_KB) return n + " B";
    if (n < BYTES_PER_MB) return (n / BYTES_PER_KB).toFixed(1) + " KB";
    if (n < BYTES_PER_GB) return (n / BYTES_PER_MB).toFixed(2) + " MB";
    return (n / BYTES_PER_GB).toFixed(2) + " GB";
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

  /**
   * 分片读取（v8.2 提速关键）：改走原生 FileReader.readAsDataURL。
   * 旧实现是 ArrayBuffer → JS 循环 String.fromCharCode 拼串 → btoa：
   * 8MB 分片要在主线程拼出约 16MB 字符串，还要再复制一次给 btoa——
   * 这正是「点了上传先卡一下」的来源，且随分片变大急剧恶化。
   * readAsDataURL 的编码在浏览器原生层完成，快一个数量级且不占 JS 堆。
   * ⚠️ 协议约束：GitHub Contents API 只接受 Base64 文本，
   * 故 Base64 无法彻底丢弃，只能把编码成本从 JS 移到原生层。
   */
  function readChunkBase64(blob) {
    return readAsBase64(blob);
  }

  /* ---------- XHR 上传助手（统一重试/进度/超时逻辑） ----------
   * task 传入时登记 task._abort：暂停/取消可在传输途中立即掐断 XHR，
   * onabort 抛出 PAUSE_SENTINEL——各层 catch 依 status 判读，不误报失败。
   *
   * v8.2 多槽修复：分片并发后，同一任务会同时存在 PART_PARALLEL 个在途 XHR。
   *   旧实现 `task._abort = fn` 是**单槽**——后发起的请求会覆盖前一个，
   *   暂停/取消时只能掐断最后一个，其余并发片照常传完并落库。
   *   后果：所有片都落库后 failedParts 为空 → 流程继续走到 finish →
   *   被取消的文件静默写进 manifest、混入云盘列表（S5d 守护点）。
   *   改为把每次请求的 abort 登记进 task._aborts 数组，_abort 掐断全部。 */
  function xhrUpload(method, path, payload, onProgress, timeoutMs, task) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var settled = false;
      var abortFn = function () { try { xhr.abort(); } catch (e) { /* 已终态 */ } };
      function clearAbort() {
        if (!task || !task._aborts) return;
        var i = task._aborts.indexOf(abortFn);
        if (i >= 0) task._aborts.splice(i, 1);
      }
      if (task) {
        if (!task._aborts) task._aborts = [];
        task._aborts.push(abortFn);
        // 覆盖式赋值：每次新请求都把入口指向最新数组，掐断时遍历全部在途请求
        task._abort = function () {
          (task._aborts || []).slice().forEach(function (fn) {
            try { fn(); } catch (e) { /* 已终态 */ }
          });
        };
      }
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
        settled = true;
        clearAbort();
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          resolve(data);
        } else {
          reject(new Error((data && data.error) || ("上传失败（HTTP " + xhr.status + "）")));
        }
      };
      xhr.onerror = function () {
        if (settled) return;
        settled = true;
        clearAbort();
        reject(new Error("网络错误：上传中断，请检查网络后重试"));
      };
      xhr.ontimeout = function () {
        if (settled) return;
        settled = true;
        clearAbort();
        reject(new Error("上传超时，请重试"));
      };
      xhr.onabort = function () {
        if (settled) return;
        settled = true;
        clearAbort();
        reject(PAUSE_SENTINEL); // 暂停/取消：由上层按 status 分流
      };
      xhr.send(payload === undefined ? undefined : JSON.stringify(payload));
    });
  }

  /* ---------- 小文件直传 ---------- */
  function uploadOne(task) {
    task.status = STATE.READING;
    notify();
    return readAsBase64(task.file).then(function (b64) {
      throwIfPaused(task); // 读取期间被暂停：不再发送
      task.status = STATE.UPLOADING;
      notify();
      return xhrUpload("POST", "/api/drive/upload", {
        // v8.0：__driveDir 为「drive/ 之下」的相对子目录（folder 上传/进入子目录上传时由
        // 渲染层打在 File 对象上；缺省为空 = 根目录，旧行为逐字节不变）
        path: "drive/" + (task.file.__driveDir ? task.file.__driveDir + "/" : "") + task.file.name,
        content: b64,
        message: "drive: upload " + task.file.name
      }, function (loaded, total) {
        task.progress = Math.round((loaded / total) * 100);
        notify();
      }, 60000, task);
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
      }, null, 60000, task).catch(function (e) {
        if (e === PAUSE_SENTINEL) throw e; // 暂停/取消：不退避不重试，直接上交
        attempt += 1;
        if (attempt > PART_RETRY) throw e;
        var wait = Math.pow(2, attempt - 1) * 1000;
        task.hint = "第 " + (index + 1) + " 片失败，" + (wait / 1000) + "s 后第 " + attempt + " 次重试…";
        notify();
        return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
          throwIfPaused(task); // 退避等待期间被暂停：不再发送
          return fire();
        });
      });
    }
    return fire();
  }

  /**
   * 断点 status 查询：同样享受指数退避重试（v7.1 补齐的缺口——
   * 弱网/断网从入队就开始时，首个请求往往就是这个 GET，
   * 无重试会直接误判失败。GET 幂等，重试零副作用）。
   */
  function uploadStatusWithRetry(task) {
    var attempt = 0;
    function fire() {
      return xhrUpload("GET", "/api/drive/upload/status?uploadId=" + encodeURIComponent(task.uploadId), undefined, null, 60000, task)
        .catch(function (e) {
          if (e === PAUSE_SENTINEL) throw e;
          attempt += 1;
          if (attempt > PART_RETRY) throw e;
          var wait = Math.pow(2, attempt - 1) * 1000;
          task.hint = "检查断点失败，" + (wait / 1000) + "s 后第 " + attempt + " 次重试…";
          notify();
          return new Promise(function (r) { setTimeout(r, wait); }).then(function () {
            throwIfPaused(task);
            return fire();
          });
        });
    }
    return fire();
  }

  /**
   * 大文件分片上传：
   * 1) 先问服务端已有哪些分片（断点续传，重试/继续时跳过已传片）
   * 2) 并行传缺失分片（v8.2：串行 → PART_PARALLEL 路并发；每片独立 commit，
   *    天然断点，并发不改变幂等性——重传同一片仍是覆盖同一个 part 文件）
   * 3) 全部到位 → finish 写 manifest
   * 任何失败：保留 task.doneBytes，「继续上传」从断点接着来
   */
  function uploadChunked(task) {
    var file = task.file;
    var total = Math.ceil(file.size / CHUNK_SIZE);
    task.total = total;
    task.status = STATE.CHECKING;
    task.hint = "检查断点…";
    notify();

    // 1) 断点查询：服务端已落库分片（合并前端本地记录；GET 幂等，带退避重试）
    return uploadStatusWithRetry(task)
      .then(function (data) {
        throwIfPaused(task);
        var serverParts = (data && data.parts) || [];
        serverParts.forEach(function (i) { task.done[i] = true; });
        task.bytesDone = Object.keys(task.done).reduce(function (s, k) {
          return s + chunkLen(file.size, Number(k));
        }, 0);
        task.progress = Math.round((task.bytesDone / file.size) * 100);
        task.status = STATE.UPLOADING;
        notify();

        // 2) 并行传缺失分片。
        // 单片彻底失败不中断后续片（弱网稳定性核心）：收集失败序号，
        // 全部跑完后统一进入失败态——已传分片保留，「继续上传」只补失败的。
        // v8.2：原实现逐片串行（每片「读+传」串行排队），大文件的总耗时 = 片数 ×
        // 单片往返，而单片大部分时间是空等上游（Worker→GitHub 的 RTT），并发可把
        // 这段空等重叠掉。并发数取 3：Worker 侧有写限流守卫兜底，不会打爆配额。
        var failedParts = [];
        var queue = [];
        for (var i = 0; i < total; i += 1) {
          if (!task.done[i]) queue.push(i);
        }
        var parallel = Math.min(PART_PARALLEL, queue.length);
        var workers = [];
        for (var w = 0; w < parallel; w += 1) {
          workers.push(
            (function () {
              function next() {
                if (task.status === STATE.FAILED || task.status === STATE.CANCELED ||
                    task.status === STATE.PAUSED) return Promise.resolve();
                if (!queue.length) return Promise.resolve();
                var idx = queue.shift();
                task.hint = "第 " + (idx + 1) + "/" + total + " 片（并发 " + parallel + "）";
                notify();
                // v8.2 闸门 A：取消/暂停可能恰好落在「取片」这一刻——此时本片
                //   连 XHR 都还没建立（无 abort 可掐）。若不拦，切片与编码
                //   照做，读完后仍会把请求发出去。这里先确认状态再动手。
                try {
                  throwIfPaused(task);
                } catch (e) {
                  queue.unshift(idx); // 归还队列，保持断点完整
                  return Promise.resolve();
                }
                var blob = file.slice(idx * CHUNK_SIZE, Math.min((idx + 1) * CHUNK_SIZE, file.size));
                return readChunkBase64(blob)
                  .then(function (b64) {
                    // 闸门 B：读片（8MB 编码，耗时可达数十毫秒）期间被取消时，
                    //   这里再确认一次，避免把已编码的分片真的发出去。
                    throwIfPaused(task);
                    return uploadPartWithRetry(task, idx, b64);
                  })
                  .then(function () {
                    task.done[idx] = true;
                    task.bytesDone += chunkLen(file.size, idx);
                    task.progress = Math.round((task.bytesDone / file.size) * 100);
                    task.hint = "";
                    notify();
                  }, function () {
                    failedParts.push(idx);
                    task.hint = "第 " + (idx + 1) + " 片失败，继续传后续片…";
                    notify();
                  })
                  .then(next);
              }
              return next();
            })()
          );
        }
        return Promise.all(workers).then(function () {
          if (failedParts.length) {
            throw new Error("分片 " + failedParts.map(function (i) { return i + 1; }).join("、") + " 上传失败");
          }
        });
      })
      .then(function () {
        // 3) 收尾：写 manifest
        // 🚨 竞态闸门（v8.1）：最后一片返回的瞬间用户点了取消/暂停时，在途 XHR
        //    已完成、abort 打不到它，若不拦就仍会把 manifest 写上去——被取消的
        //    文件会静默混入云盘列表（S5d 守卫点）。抛哨兵后由下方 catch 按
        //    task.status 静默收场，绝不误报 failed；断点仍在，可续传。
        throwIfPaused(task);
        task.status = STATE.FINISHING;
        task.hint = "写入清单…";
        notify();
        return xhrUpload("POST", "/api/drive/upload/finish", {
          uploadId: task.uploadId,
          name: file.name,
          size: file.size,
          total: total,
          dir: task.file.__driveDir || "" // v8.0：manifest 与上传目标目录保持一致
        }, null, 60000, task);
      })
      .then(function () {
        task.progress = 100;
        task.status = STATE.DONE;
        task.hint = "";
        notify();
      })
      .catch(function (e) {
        // 暂停/取消：静默收场，绝不误报 failed（断点已保留，恢复即续传）
        if (task.status === STATE.CANCELED || task.status === STATE.PAUSED) return;
        task.status = STATE.FAILED;
        task.error = e.message || "上传失败";
        task.hint = "已传 " + Object.keys(task.done).length + "/" + total + " 片，可继续上传";
        notify();
        throw e;
      });
  }

  /* ---------- 并发队列：最多 MAX_CONCURRENT 个文件同时上传 ----------
   * 拖入 10 个大文件也只跑 3 个，其余排队——浏览器不卡死。
   * 暂停的任务 abort 在途 XHR 后经本队列释放并发槽，恢复时重新入队。 */
  function startTask(task) {
    task.status = task.mode === "chunked" ? STATE.CHECKING : STATE.READING;
    notify();
    var job = task.mode === "chunked" ? uploadChunked(task) : uploadOne(task);
    return job.then(function () {
      if (task.status !== STATE.CANCELED && task.status !== STATE.PAUSED) task.status = STATE.DONE;
      notify();
    }).catch(function (e) {
      // 暂停/取消：静默（断点已保留）；其余落 failed 并Toast——单点失败不拖垮队列
      if (task.status !== STATE.CANCELED && task.status !== STATE.PAUSED) {
        task.status = STATE.FAILED;
        task.error = (e && e.message) || "上传失败";
        hooks.toast("「" + task.file.name + "」上传失败：" + task.error, "err");
      }
      notify();
    });
  }

  function retryTask(t) {
    if (RESUMABLE_STATES.indexOf(t.status) < 0) return false;
    if (t.awaitingFile) {
      // 无 File 句柄：提醒用户重新选择同名文件（addFiles 会自动装配并续传）
      hooks.toast("请重新选择「" + t.file.name + "」以继续上传", "err");
      return false;
    }
    t.status = STATE.PENDING;
    t.error = "";
    t.hint = "";
    notify();
    pumpQueue();
    return true;
  }

  /** 暂停：仅活动态可暂；先置状态再 abort——abort 的 reject 到层按 paused 静默分流 */
  function pauseTask(t) {
    if (ACTIVE_STATES.indexOf(t.status) < 0) return false;
    t.status = STATE.PAUSED;
    t.hint = "已暂停";
    notify();
    if (t._abort) { try { t._abort(); } catch (e) { /* 已终态 */ } }
    return true;
  }

  function resumeTask(t) {
    return retryTask(t); // 语义一致：paused → pending，断点续传
  }

  function pauseAll() {
    var n = 0;
    uploadTasks.forEach(function (t) { if (pauseTask(t)) n += 1; });
    return n;
  }

  function resumeAll() {
    var n = 0;
    uploadTasks.forEach(function (t) {
      if (t.status === STATE.PAUSED) { retryTask(t); n += 1; }
    });
    return n;
  }

  /** 取消：abort 在途 XHR 并出队（服务端已传分片保留，同名再传自动续） */
  function cancelTask(t) {
    t.status = STATE.CANCELED;
    t.hint = "已取消";
    if (t._abort) { try { t._abort(); } catch (e) { /* 已终态 */ } }
    var i = uploadTasks.indexOf(t);
    if (i >= 0) uploadTasks.splice(i, 1);
    notify();
    return true;
  }

  /**
   * 清除已完成的任务（v7.3 传输面板「清除已完成」按钮）。
   * 纯列表卫生：只移除 DONE 终态任务，不影响任何在途/暂停/失败任务，
   * 更不触碰分片算法与状态机流转。返回移除个数。
   */
  function clearFinished() {
    var removed = 0;
    for (var i = uploadTasks.length - 1; i >= 0; i--) {
      if (uploadTasks[i].status === STATE.DONE) { uploadTasks.splice(i, 1); removed += 1; }
    }
    if (removed) notify();
    return removed;
  }

  function pumpQueue() {
    while (activeCount < MAX_CONCURRENT) {
      var next = uploadTasks.find(function (t) { return t.status === STATE.PENDING; });
      if (!next) {
        // 全部结束（无活动任务且无等待）：有成功则刷新列表
        if (activeCount === 0 && uploadTasks.some(function (t) { return t.status === STATE.DONE; })) {
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
   * Blob 由浏览器磁盘承载，不全量进 JS 堆；保存动作经 hooks.saveBlob 交还页面。
   *
   * v8.2 提速：单片失败指数退避重试 2 次（GitHub raw 对突发并发会限流 429，
   *   旧实现一次失败即整单失败，大文件下载成功率随片数指数下降）。
   *
   * ⚠️ 「下载变预览」的根治点在 downloadFile()：只要走 fetch→Blob→<a download>，
   *    浏览器必定唤起系统下载器（服务端 Content-Disposition 只在直接导航时生效）。
   *    拉片 URL 保持纯净（不加查询参数），避免破坏缓存键与测试 mock 匹配；
   *    Worker 侧仍保留 ?dl=1 兜底，供「直接拿链接下载」的场景使用。
   */
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
        /** 单片拉取：429/5xx/网络错误退避重试，最多 DL_PART_RETRY 次 */
        function fetchPart(idx) {
          var pad = String(idx).padStart(5, "0");
          var url = base + pad;
          var attempt = 0;
          function fire() {
            // v8.3：同 downloadFile——拉片走 Worker 代理须带口令，否则 401
            return fetch(url, { headers: { "x-drive-pin": hooks.getPin() } }).then(function (r) {
              if (r.ok) return r.blob();
              var retryable = r.status === 429 || r.status >= 500;
              if (!retryable) throw new Error("分片 " + (idx + 1) + " 拉取失败（HTTP " + r.status + "）");
              attempt += 1;
              if (attempt > DL_PART_RETRY) throw new Error("分片 " + (idx + 1) + " 拉取失败（HTTP " + r.status + "）");
              var wait = Math.pow(2, attempt - 1) * 500;
              return new Promise(function (res) { setTimeout(res, wait); }).then(fire);
            });
          }
          return fire().then(function (b) { parts[idx] = b; });
        }
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
          return Promise.all(batch.map(fetchPart)).then(function () {
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

  /**
   * 下载统一入口（v8.2 修复「点击下载变成网页内预览」）：
   * 不论大小文件，一律 fetch → Blob → <a download> 触发系统下载器，
   * 绝不用 window.location.href / <a target=_blank> 让浏览器按 MIME 自行决定
   * （txt/png/pdf 等会被内联预览，用户以为点了没反应）。
   * @param {object} f    文件条目（storage: "contents" | "chunked"）
   * @param {HTMLElement} btn 触发按钮（用于禁用与文案回显，可空）
   */
  function downloadFile(f, btn) {
    if (f && f.storage === "chunked") return downloadChunked(f, btn);
    var url = f && f.downloadUrl;
    if (!url) {
      hooks.toast("该文件没有可用的下载地址", "err");
      return Promise.resolve();
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳ 下载中…";
    }
    // v8.3 修复「点击下载报错」：/api/github/raw/ 走 Worker 的 GitHub 代理，
    //   该路径要求 x-drive-pin。fetch 与 <img src> 不同——后者由浏览器自动带上
    //   同源凭据，前者不会，缺头即被 Worker 挡回 401，前端表现为「下载失败」。
    return fetch(url, { headers: { "x-drive-pin": hooks.getPin() } })
      .then(function (r) {
        if (!r.ok) throw new Error("下载失败（HTTP " + r.status + "）");
        return r.blob();
      })
      .then(function (blob) {
        hooks.saveBlob(blob, (f && f.name) || "download");
        hooks.toast("已下载 " + ((f && f.name) || "download"), "ok");
      })
      .catch(function (e) {
        hooks.toast(e.message || "下载失败", "err");
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "⬇️ 下载";
        }
      });
  }

  /* ---------- 崩溃恢复：未完成分片任务的本地持久化（v7.2 强关浏览器不断点） ----------
   * File 对象无法持久化，但 uploadId + 已传分片表可以：
   *   崩溃/误关 → 重开页面 → restore() 把未完成任务恢复为「等待文件」态
   *   （paused + awaitingFile，hint 提示重新选择同名文件）
   *   用户再次选入同名同尺寸文件 → 装配 File 句柄 → 断点续传（服务端分片复用）。
   * 直传小文件无断点概念，不持久化。localStorage 不可用（隐私模式）时静默降级。 */
  var RESUME_KEY = "drive_upload_resume";
  var persistTimer = null;

  function safeLocalStorage() {
    try { if (typeof localStorage !== "undefined") return localStorage; } catch (e) { /* 隐私模式 */ }
    return null;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () { persistTimer = null; persistTasks(); }, 400);
  }

  /** 持久化条件：分片模式 + 非终态（活动/暂停/失败/等待文件都记住） */
  function needsPersist(t) {
    return t.mode === "chunked" && t.status !== STATE.DONE && t.status !== STATE.CANCELED;
  }

  function persistTasks() {
    var ls = safeLocalStorage();
    if (!ls) return;
    var records = uploadTasks.filter(needsPersist).map(function (t) {
      return {
        uploadId: t.uploadId,
        name: t.file.name,
        size: t.file.size,
        total: t.total || Math.ceil(t.file.size / CHUNK_SIZE),
        done: Object.keys(t.done || {}).map(Number),
        dir: t.file.__driveDir || "", // v8.0：子目录归属随断点一起持久化
      };
    });
    try {
      if (records.length) ls.setItem(RESUME_KEY, JSON.stringify(records));
      else ls.removeItem(RESUME_KEY);
    } catch (e) { /* 配额满等：恢复是尽力而为，不阻断上传 */ }
  }

  /** 同步落盘：beforeunload/pagehide 时调用，堵死「防抖 400ms 内强关丢状态」的窗口 */
  function flushPersist() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistTasks();
  }

  /** 恢复：页面加载时调用，把上次未完成的分片任务以「等待文件」态放回队列 */
  function restoreTasks() {
    var ls = safeLocalStorage();
    if (!ls) return 0;
    var records = [];
    try { records = JSON.parse(ls.getItem(RESUME_KEY) || "[]"); } catch (e) { records = []; }
    if (!Array.isArray(records)) records = [];
    var restored = 0;
    records.forEach(function (r) {
      if (!r || !r.uploadId || !r.name || !r.size) return;
      if (uploadTasks.some(function (t) { return t.uploadId === r.uploadId; })) return; // 已在队列
      var doneMap = {};
      (r.done || []).forEach(function (i) { doneMap[i] = true; });
      var total = r.total || Math.ceil(r.size / CHUNK_SIZE);
      var bytesDone = Object.keys(doneMap).reduce(function (s, k) {
        return s + chunkLen(r.size, Number(k));
      }, 0);
      uploadTasks.push({
        file: { name: r.name, size: r.size, __driveDir: r.dir || "" }, // 无 File 句柄：等用户重新选择
        mode: "chunked",
        uploadId: r.uploadId,
        total: total,
        done: doneMap,
        bytesDone: bytesDone,
        progress: Math.round((bytesDone / r.size) * 100),
        status: STATE.PAUSED,
        error: "",
        hint: "已传 " + Object.keys(doneMap).length + "/" + total + " 片，重新选择「" + r.name + "」即可续传",
        _abort: null,
        awaitingFile: true,
      });
      restored += 1;
    });
    if (restored) notify();
    return restored;
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
        // 崩溃恢复装配：同名同尺寸同目录的「等待文件」任务 → 装上 File 句柄从断点继续
        var pendingRestore = null;
        for (var i = 0; i < uploadTasks.length; i++) {
          var t = uploadTasks[i];
          if (t.awaitingFile && t.file.name === f.name && t.file.size === f.size &&
              (t.file.__driveDir || "") === (f.__driveDir || "")) { pendingRestore = t; break; }
        }
        if (pendingRestore) {
          pendingRestore.file = f;
          pendingRestore.awaitingFile = false;
          pendingRestore.status = STATE.PENDING;
          pendingRestore.hint = "";
          return; // 不新入队，继续遍历其余文件
        }
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
          status: STATE.PENDING,
          error: "",
          hint: "",
          _abort: null,
        });
      } else {
        // 小文件：直传模式（原路径）
        uploadTasks.push({
          file: f,
          mode: "direct",
          progress: 0,
          status: STATE.PENDING,
          error: "",
          hint: "",
          _abort: null,
        });
      }
    });
    if (rejected.length) {
      hooks.toast("已拦截不合规文件：" + rejected.join("；"), "err");
    }
    notify();
    pumpQueue();
  }

  /** 删除锁：该文件名是否处于上传中（含排队/读取/检查断点/上传中/收尾） */
  function isUploading(name) {
    return uploadTasks.some(function (t) {
      return t.file.name === name && ACTIVE_STATES.indexOf(t.status) >= 0;
    });
  }

  /** beforeunload 防误关：是否有任何活动任务（暂停/失败/完成均不拦） */
  function isBusy() {
    return uploadTasks.some(function (t) { return ACTIVE_STATES.indexOf(t.status) >= 0; });
  }

  /* ---------- 弱网/断网重连：online 事件自动续跑失败任务 ----------
   * 断网时 XHR onerror → 单片退避重试 ×3 → 仍失败则整体 failed（断点保留）。
   * 网络恢复瞬间自动 resume：分片模式按 status 查询只补缺失片（幂等），
   * 直传模式整文件覆盖写（幂等）——两端都保证不会重复落库。 */
  var onlineBound = false;
  function bindNetworkEvents() {
    if (onlineBound) return;
    if (typeof window === "undefined" || !window.addEventListener) return;
    onlineBound = true;
    window.addEventListener("online", function () {
      var failed = uploadTasks.filter(function (t) { return t.status === STATE.FAILED; });
      if (!failed.length) return;
      hooks.toast("网络已恢复，自动继续 " + failed.length + " 个失败任务", "ok");
      failed.forEach(function (t) { retryTask(t); });
    });
  }

  function init(h) {
    if (!h) return;
    Object.keys(h).forEach(function (k) {
      if (typeof h[k] === "function") hooks[k] = h[k];
    });
    bindNetworkEvents();
  }

  return {
    init: init,
    _hooks: hooks, // v8.0：暴露 hook 表只读引用——批量下载需临时替换 saveBlob 捕获 Blob（不触碰分片/重试内核）
    addFiles: addFiles,
    retry: retryTask,
    restore: restoreTasks,
    flushPersist: flushPersist,
    pause: pauseTask,
    resume: resumeTask,
    pauseAll: pauseAll,
    resumeAll: resumeAll,
    cancel: cancelTask,
    clearFinished: clearFinished,
    tasks: function () { return uploadTasks; },
    isUploading: isUploading,
    isBusy: isBusy,
    downloadChunked: downloadChunked,
    downloadFile: downloadFile,
    STATE: STATE,
    constants: function () {
      return {
        SMALL_LIMIT: SMALL_LIMIT,
        CHUNK_SIZE: CHUNK_SIZE,
        MAX_TOTAL: MAX_TOTAL,
        MAX_CONCURRENT: MAX_CONCURRENT,
        PART_PARALLEL: PART_PARALLEL,
        PART_RETRY: PART_RETRY,
        DL_PART_RETRY: DL_PART_RETRY,
        DOWNLOAD_CONCURRENT: DOWNLOAD_CONCURRENT,
      };
    },
  };
})();
