// ============================================================
// v12.0 战役二：Web Worker 哈希与 ZIP 打包端到端验证
//   A. 标准增量 SHA-256 与 crypto.subtle 逐长度对照（含 padding 边界）
//   B. 大 Blob 分块流式哈希（跨 1MB 块边界）与整体 digest 一致
//   C. 120 文件 Worker 打包 + SHA256SUMS.txt 逐项校验 + 进度回传
//   D. 主线程零 JSZip 调用（CPU 确实在 Worker，不是伪实现）
//   E. rAF 帧间隔采样：打包期间主线程保持流畅（与主线程路径对照）
//   F. Worker 异常可降级 + 静态链路无 Base64 / 无 FileReader
//   G. 云盘页接线与 SW 预缓存回归
// 运行：CHROMIUM_PATH=/usr/bin/chromium node tests/step23-v12-compute.mjs
// ============================================================
import { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pkg from "playwright";
const { chromium } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " → " + detail : "")); }
}

const PAGE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>计算内核测试</title>
<script src="/services/computeClient.js"></script>
</head><body><h1>后台计算内核</h1><div id="out">ready</div>
<script>
window.loadJSZip = function () {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise(function (res, rej) {
    var s = document.createElement("script");
    s.src = "/vendor/jszip.min.js";
    s.onload = function () { res(window.JSZip); };
    s.onerror = function () { rej(new Error("JSZip 加载失败")); };
    document.head.appendChild(s);
  });
};
window.fillRandom = function (b) {
  // getRandomValues 单次上限 65536 字节，大数组必须分块填充
  for (var off = 0; off < b.length; off += 65536) {
    crypto.getRandomValues(b.subarray(off, Math.min(off + 65536, b.length)));
  }
  return b;
};
window.makeEntries = function (count, size) {
  var pool = window.fillRandom(new Uint8Array(size * count)); // 不可压缩，DEFLATE 真实耗 CPU
  var list = [];
  for (var i = 0; i < count; i++) {
    list.push({ name: "dir" + (i % 8) + "/file-" + String(i).padStart(3, "0") + ".bin",
      blob: new Blob([pool.slice(i * size, (i + 1) * size)]) });
  }
  return list;
};
window.startFrames = function () {
  window.__frames = []; window.__sampling = true;
  var last = performance.now();
  function tick(t) {
    window.__frames.push(t - last); last = t;
    if (window.__sampling) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
};
window.stopFrames = function () {
  window.__sampling = false;
  var f = (window.__frames || []).slice(2); // 丢掉启动瞬间的两帧
  if (!f.length) return { n: 0, long: 0, ratio: 0, max: 0 };
  var long = f.filter(function (d) { return d > 50; }).length;
  return { n: f.length, long: long, ratio: long / f.length, max: Math.max.apply(null, f) };
};
</script></body></html>`;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE_HTML);
  }
  const file = path.join(ROOT, p.replace(/^\//, ""));
  try {
    if (!file.startsWith(ROOT) || !fs.statSync(file).isFile()) throw new Error("404");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("404");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
const context = await browser.newContext();
const page = await context.newPage();
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(e.message));

try {
  await page.goto(ORIGIN + "/", { waitUntil: "load" });

  /* ============ A. 增量 SHA-256 正确性 ============ */
  console.log("\n═══ A. 标准 SHA-256 与 crypto.subtle 对照 ═══");
  const shaCases = await page.evaluate(async () => {
    const lens = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 65536];
    const out = [];
    for (const n of lens) {
      const b = new Uint8Array(n);
      if (n) crypto.getRandomValues(b);
      const mine = (await window.ComputeWorker.sha256(b.buffer)).hash;
      const refBuf = await crypto.subtle.digest("SHA-256", b.buffer);
      const ref = [...new Uint8Array(refBuf)].map((x) => x.toString(16).padStart(2, "0")).join("");
      out.push({ n, ok: mine === ref, mine: mine.slice(0, 12), ref: ref.slice(0, 12) });
    }
    return out;
  });
  check("A1 12 个长度（含 padding 边界 55/56/57/63/64/65）全部与标准 SHA-256 一致",
    shaCases.every((c) => c.ok), JSON.stringify(shaCases.filter((c) => !c.ok)));
  check("A2 空输入等于标准空串摘要", shaCases[0].ok && shaCases[0].mine === "e3b0c44298fc", JSON.stringify(shaCases[0]));

  /* ============ B. 大 Blob 分块流式哈希 ============ */
  console.log("\n═══ B. 大文件流式哈希 ═══");
  const bigHash = await page.evaluate(async () => {
    const chunks = [];
    for (let i = 0; i < 3; i++) {
      chunks.push(window.fillRandom(new Uint8Array(1024 * 1024)));
    }
    const blob = new Blob(chunks); // 3MB，跨 3 个 1MB 分块
    const prog = [];
    const r = await window.ComputeWorker.hashBlob(blob, (p) => prog.push(p.done));
    const refBuf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const ref = [...new Uint8Array(refBuf)].map((x) => x.toString(16).padStart(2, "0")).join("");
    return { hash: r.hash, ref, bytes: r.bytes, chunks: prog.length, size: blob.size };
  });
  check("B1 3MB 跨块哈希与整体 digest 完全一致", bigHash.hash === bigHash.ref, JSON.stringify(bigHash));
  check("B2 分块进度回传 3 次（确为流式而非一次性读入）", bigHash.chunks === 3, "chunks=" + bigHash.chunks);
  check("B3 字节数统计正确", bigHash.bytes === 3 * 1024 * 1024, "bytes=" + bigHash.bytes);

  /* ============ C. 120 文件 Worker 打包 ============ */
  console.log("\n═══ C. 120 文件后台打包 + 完整性清单 ═══");
  const zipResult = await page.evaluate(async () => {
    const entries = window.makeEntries(120, 24 * 1024);
    const progress = [];
    const r = await window.ComputeWorker.zip(entries, (p) => progress.push({ phase: p.phase, percent: Math.round(p.percent) }));
    window.__zipBuffer = r.buffer;
    return {
      bytes: r.bytes, sums: r.sums, bufLen: r.buffer.byteLength,
      phases: [...new Set(progress.map((p) => p.phase))],
      hashSteps: progress.filter((p) => p.phase === "hash").length,
      zipSteps: progress.filter((p) => p.phase === "zip").length,
      hasJSZipOnMain: typeof window.JSZip !== "undefined",
    };
  });
  check("C1 打包产出非空 ArrayBuffer 且字节数自洽", zipResult.bufLen > 100000 && zipResult.bufLen === zipResult.bytes, JSON.stringify({ b: zipResult.bufLen, r: zipResult.bytes }));
  check("C2 生成 120 条 SHA-256 校验和", zipResult.sums.length === 120, "n=" + zipResult.sums.length);
  check("C3 校验和格式合规（64 hex + 双空格 + 路径）", zipResult.sums.every((s) => /^[0-9a-f]{64}  \S+/.test(s)), zipResult.sums[0]);
  check("C4 进度覆盖 hash 与 zip 两个阶段", zipResult.phases.includes("hash") && zipResult.phases.includes("zip"), JSON.stringify(zipResult.phases));
  check("C5 逐文件进度 + 压缩进度均有回传", zipResult.hashSteps === 120 && zipResult.zipSteps >= 1, JSON.stringify({ h: zipResult.hashSteps, z: zipResult.zipSteps }));
  check("C6 【主线程零 JSZip】打包期间主线程从未加载 / 调用 JSZip", zipResult.hasJSZipOnMain === false, "hasJSZip=" + zipResult.hasJSZipOnMain);

  const unzip = await page.evaluate(async () => {
    const JSZip = await window.loadJSZip();
    const zip = await JSZip.loadAsync(window.__zipBuffer);
    // JSZip 会为 dir0/ … dir7/ 额外生成 8 个目录条目，统计时排除 .dir
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const sumsTxt = await zip.file("SHA256SUMS.txt").async("string");
    const f0 = await zip.file("dir0/file-000.bin").async("uint8array");
    return { count: names.length, dirs: Object.keys(zip.files).length - names.length,
      hasSums: names.includes("SHA256SUMS.txt"),
      lines: sumsTxt.trim().split("\n").length, f0len: f0.length,
      firstLine: sumsTxt.split("\n")[0] };
  });
  check("C7 zip 可正常解包，共 121 项（120 文件 + SHA256SUMS.txt）", unzip.count === 121 && unzip.hasSums, JSON.stringify(unzip));
  check("C8 SHA256SUMS.txt 恰含 120 行且格式正确", unzip.lines === 120 && /^[0-9a-f]{64}  /.test(unzip.firstLine), JSON.stringify({ n: unzip.lines, first: unzip.firstLine }));
  check("C9 打包内容无损（首个文件 24KB 原样还原）", unzip.f0len === 24 * 1024, "len=" + unzip.f0len);

  /* ============ D+E. 60fps 对照 ============ */
  console.log("\n═══ D+E. 打包期间主线程帧率 ═══");
  const perf = await page.evaluate(async () => {
    const entries = window.makeEntries(120, 24 * 1024);
    // Worker 路径
    window.startFrames();
    const t0 = performance.now();
    await window.ComputeWorker.zip(entries);
    const workerElapsed = performance.now() - t0;
    const workerFrames = window.stopFrames();
    // 主线程 JSZip 路径（对照组）
    await window.loadJSZip();
    window.startFrames();
    const t1 = performance.now();
    const zip = new window.JSZip();
    for (const e of entries) {
      const buf = await e.blob.arrayBuffer();
      zip.file(e.name, buf, { binary: true });
    }
    await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    const mainElapsed = performance.now() - t1;
    const mainFrames = window.stopFrames();
    return { workerFrames, mainFrames, workerElapsed, mainElapsed };
  });
  const wf = perf.workerFrames, mf = perf.mainFrames;
  console.log(`     Worker 帧: ${wf.n} 帧, 长帧 ${wf.long} (${(wf.ratio * 100).toFixed(1)}%), 最大 ${wf.max.toFixed(1)}ms, 打包耗时 ${perf.workerElapsed.toFixed(1)}ms`);
  console.log(`     主线程帧: ${mf.n} 帧, 长帧 ${mf.long} (${(mf.ratio * 100).toFixed(1)}%), 最大 ${mf.max.toFixed(1)}ms, 打包耗时 ${perf.mainElapsed.toFixed(1)}ms`);
  // v13.0.1：CI runner 比本地快得多，Worker 打包 120×24KB 只需约 116ms（7 帧），
  // 用绝对帧数 >= 10 会让「性能更好」反而判失败（CI 连续两次 n=7）。
  // 改为直接度量打包耗时 + 只要求帧采样有效：ZIP 产出正确性由 C1–C9 严格保证，
  // 主线程 60fps 由 E2/E3/E4 判定，判据语义不降级且与机器速度解耦。
  check("E1 Worker 路径打包确实持续了一段时间且帧采样有效",
    perf.workerElapsed >= 30 && wf.n >= 3,
    `elapsed=${perf.workerElapsed.toFixed(1)}ms, n=${wf.n}`);
  check("E2 Worker 路径长帧比例 < 10%（主线程保持 60fps）", wf.ratio < 0.10, `ratio=${wf.ratio.toFixed(3)}`);
  check("E3 Worker 路径最大帧间隔 < 100ms（无卡顿长任务）", wf.max < 100, "max=" + wf.max.toFixed(1));
  check("E4 Worker 路径长帧数不多于主线程路径（对照优势成立）", wf.long <= mf.long, `worker=${wf.long} main=${mf.long}`);

  /* ============ F. 降级与静态链路 ============ */
  console.log("\n═══ F. 异常降级与静态链路 ═══");
  const fallback = await page.evaluate(async () => {
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function () { throw new Error("模拟 Worker 崩溃"); };
    let rejected = false;
    try { await window.ComputeWorker.zip([{ name: "a.bin", blob: new Blob([new Uint8Array(8)]) }]); }
    catch (e) { rejected = true; }
    Worker.prototype.postMessage = orig;
    window.ComputeWorker.reset();
    const ping = await window.ComputeWorker.ping();
    return { rejected, pong: ping.pong, supported: window.ComputeWorker.supported() };
  });
  check("F1 Worker 异常正确 reject（调用方可据此回退主线程路径）", fallback.rejected === true, JSON.stringify(fallback));
  check("F2 reset() 后 Worker 可重建恢复", fallback.pong === true && fallback.supported === true, JSON.stringify(fallback));

  const cwSrc = fs.readFileSync(path.join(ROOT, "services/computeWorker.js"), "utf8");
  const ccSrc = fs.readFileSync(path.join(ROOT, "services/computeClient.js"), "utf8");
  const driveSrc = fs.readFileSync(path.join(ROOT, "pages/drive.html"), "utf8");
  const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  check("F3 全链路零 Base64 / 零 FileReader（Blob structured clone 直传）",
    !/btoa\(|readAsDataURL|readAsText/.test(cwSrc + ccSrc));
  check("F4 Worker 内使用本地 vendor JSZip（无 CDN / 无 eval）",
    /importScripts\("\/vendor\/jszip\.min\.js"\)/.test(cwSrc) && !/https?:\/\//.test(cwSrc.match(/importScripts\([^)]*\)/)?.[0] || ""));
  check("F5 ZIP 结果走 transferable 零拷贝回传", /\[out\]/.test(cwSrc));
  check("F6 云盘页已接入 ComputeClient 且保留 Legacy 降级",
    /computeClient\.js/.test(driveSrc) && /batchZipWorker/.test(driveSrc) &&
    /batchZipLegacy/.test(driveSrc) && /usedWorker/.test(driveSrc));
  check("F7 SW 预缓存纳入两个新计算文件",
    /\/services\/computeWorker\.js/.test(swSrc) && /\/services\/computeClient\.js/.test(swSrc));

  check("Z 全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | ") || "无");
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
