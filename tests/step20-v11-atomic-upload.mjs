// ============================================================
// v11.0 战役五：Git Data API 原子上传 —— 端到端极限压测
// ------------------------------------------------------------
// A 段（协议层，Node 直测 Worker）：能力探测、裸二进制分片、
//     Base64 只在 Worker→GitHub 边界、Blobs/Trees/Commits/refs
//     单次原子 commit、清单校验、越权与参数攻击防护。
// B 段（浏览器层，真实 Chromium）：驱动 services/uploadWorker.js
//     在后台线程切片并算 SHA-256，验证 transferable ArrayBuffer、
//     前端裸二进制网络请求、静态链路断言（无 btoa / 全链路回退）。
//
// 端口 listen(0)，不与其它套件冲突；A 段结束还原 fetch/caches 全局。
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import worker, { ROOT, CHROMIUM_LAUNCH_OPTIONS } from "./_helpers.mjs";
import pw from "playwright";

const { chromium } = pw;
const sha256 = (buf) => createHash("sha256").update(Buffer.from(buf)).digest("hex");
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  ✅ " + n); }
  else { fail++; console.log("  ❌ " + n + (d ? " → " + d : "")); }
};

/* ================= A 段：Worker Git Data API 端点 ================= */
const savedFetch = globalThis.fetch;
const savedCaches = globalThis.caches;
const calls = [];
let refSha = "PARENT0";
const blobStore = new Map();
let shaSeq = 0;
const sha = () => "abcdef0123456789".repeat(2) + String(shaSeq++).padStart(8, "0");

globalThis.caches = {
  open: async () => ({ async match() { return undefined; }, async put() {}, async keys() { return []; }, async delete() {} }),
};
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input.url;
  const method = (init && init.method) || "GET";
  let body = null;
  if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = init.body; } }
  calls.push({ u, method, body });
  const j = (o, s = 200) => new Response(JSON.stringify(o), {
    status: s, headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "5000" },
  });
  if (u.includes("rate_limit")) return j({ rate: { remaining: 5000 } });
  if (u.endsWith("/git/ref/heads/main") && method === "GET") return j({ object: { sha: refSha } });
  if (u.includes("/git/commits/PARENT") && method === "GET") return j({ tree: { sha: "BASETREE" } });
  if (u.endsWith("/git/blobs") && method === "POST") {
    const s = sha(); blobStore.set(s, body.content); return j({ sha: s }, 201);
  }
  if (u.endsWith("/git/trees") && method === "POST") return j({ sha: "NEWTREE" }, 201);
  if (u.endsWith("/git/commits") && method === "POST") return j({ sha: "NEWCOMMIT" }, 201);
  if (u.includes("/git/refs/heads/main") && method === "PATCH") { refSha = body.sha; return j({ object: { sha: body.sha } }); }
  return j({ message: "unexpected " + u }, 500);
};

const ENV = { GITHUB_TOKEN: "t", DRIVE_PIN: "1234" };
const CTX = { waitUntil: () => {} };
const BASE = "https://blog.local/api/drive";
const call = (sub, opts) => worker.fetch(new Request(`${BASE}/${sub}`,
  Object.assign({ method: "POST", headers: { "x-drive-pin": "1234" } }, opts || {})), ENV, CTX);
const json = async (r) => { try { return JSON.parse(await r.text()); } catch (e) { return null; } };

console.log("== A 段：Git Data API 原子批量提交端点 ==");
let r = await worker.fetch(new Request(`${BASE}/upload/capability`, { headers: { "x-drive-pin": "1234" } }), ENV, CTX);
let j = await json(r);
check("B1 能力探测 200 且 atomicBatch=true", r.status === 200 && j.atomicBatch === true, JSON.stringify(j));
check("B2 能力探测声明 binaryBody 与 chunkSize", j.binaryBody === true && j.chunkSize === 8388608);
check("B3 能力探测访问的是 Git ref 只读端点", calls.some((c) => /\/git\/ref\/heads\/main$/.test(c.u)));
r = await worker.fetch(new Request(`${BASE}/upload/capability`, { headers: {} }), ENV, CTX);
check("B4 能力探测同样受 PIN 保护", r.status === 401, "status=" + r.status);

const raw = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
r = await call("upload/blob", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/octet-stream", "x-drive-upload-id": "uid-1", "x-drive-index": "0" },
  body: raw,
});
j = await json(r);
check("B5 裸二进制分片 200 且返回 sha", r.status === 200 && /^[a-f0-9]{40}$/.test(j.sha || ""), JSON.stringify(j));
const blobCall = calls.filter((c) => c.u.endsWith("/git/blobs") && c.method === "POST").pop();
check("B6 边界按官方协议转 Base64 (encoding=base64)", blobCall.body.encoding === "base64");
check("B7 Base64 解码与原始字节一致", Buffer.from(blobCall.body.content, "base64").equals(Buffer.from(raw)));

r = await call("upload/blob", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/json", "x-drive-upload-id": "uid-1", "x-drive-index": "0" },
  body: new Uint8Array([1]),
});
check("B8 非 octet-stream 返回 415", r.status === 415, "status=" + r.status);
r = await call("upload/blob", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/octet-stream", "x-drive-upload-id": "../evil", "x-drive-index": "0" },
  body: new Uint8Array([1]),
});
check("B9 uploadId 路径穿越被拒", r.status === 400, "status=" + r.status);
r = await call("upload/blob", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/octet-stream", "x-drive-upload-id": "uid-1", "x-drive-index": "0" },
  body: new Uint8Array(0),
});
check("B10 空分片被拒", r.status === 400, "status=" + r.status);

calls.length = 0;
const parts = [
  { index: 0, sha: "a".repeat(40) },
  { index: 1, sha: "b".repeat(40) },
  { index: 2, sha: "c".repeat(40) },
];
r = await call("upload/finish-atomic", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/json" },
  body: JSON.stringify({ uploadId: "uid-atomic", name: "电影.mkv", size: 20000000, total: 3, parts, dir: "videos" }),
});
j = await json(r);
check("B11 原子提交 200 且 atomic=true", r.status === 200 && j.atomic === true, JSON.stringify(j));
check("B12 返回单点 commit sha", j.commit === "NEWCOMMIT");
check("B13 ref 被更新到新 commit（唯一对外可见的一步）", refSha === "NEWCOMMIT");
const treeCall = calls.find((c) => c.u.endsWith("/git/trees"));
check("B14 tree 用 base_tree 增量提交", treeCall.body.base_tree === "BASETREE");
check("B15 一次 tree 含 3 个 part + 1 个 manifest", treeCall.body.tree.length === 4);
check("B16 part 路径符合既有 drive/.parts 协议", treeCall.body.tree.slice(0, 3).every((t) => /^drive\/\.parts\/uid-atomic\/part-\d{5}$/.test(t.path)));
check("B17 manifest 落在指定子目录", treeCall.body.tree[3].path === "drive/videos/.m-uid-atomic.json");
check("B18 整个批次只有 1 次 commit 创建", calls.filter((c) => c.u.endsWith("/git/commits") && c.method === "POST").length === 1);
const mContent = blobStore.get(treeCall.body.tree[3].sha);
const manifest = mContent ? JSON.parse(Buffer.from(mContent, "base64").toString("utf8")) : null;
check("B19 manifest 中文名 UTF-8 无损", manifest && manifest.name === "电影.mkv", JSON.stringify(manifest));
check("B20 manifest 标记 atomic 且 total 正确", manifest && manifest.storage === "atomic" && manifest.total === 3);

calls.length = 0;
r = await call("upload/finish-atomic", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/json" },
  body: JSON.stringify({ uploadId: "uid-x", name: "x", total: 3, parts: [parts[0], parts[0], parts[1]] }),
});
check("B21 序号重复被拒且不触发任何 GitHub 写", r.status === 400 && calls.length === 0, "status=" + r.status + " calls=" + calls.length);
r = await call("upload/finish-atomic", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/json" },
  body: JSON.stringify({ uploadId: "uid-x", name: "x", total: 2, parts: [parts[0]] }),
});
check("B22 分片数量与 total 不符被拒", r.status === 400);
r = await call("upload/finish-atomic", {
  headers: { "x-drive-pin": "1234", "Content-Type": "application/json" },
  body: JSON.stringify({ uploadId: "uid-x", name: "x", total: 1, parts: [{ index: 0, sha: "not-a-sha" }] }),
});
check("B23 非法 sha 被拒", r.status === 400);
r = await call("upload/finish-atomic", {
  headers: { "x-drive-pin": "wrong", "Content-Type": "application/json" },
  body: JSON.stringify({ uploadId: "uid-x", name: "x", total: 1, parts: [{ index: 0, sha: "a".repeat(40) }] }),
});
check("B24 原子提交错误口令被 401", r.status === 401);

globalThis.fetch = savedFetch;
if (savedCaches === undefined) delete globalThis.caches;
else globalThis.caches = savedCaches;

/* ================= B 段：真实 Chromium Web Worker 切片 ================= */
console.log("== B 段：Chromium 驱动 uploadWorker 与裸二进制链路 ==");
const FILE_SIZE = 2 * 1024 * 1024 + 77;
const SRC = new Uint8Array(FILE_SIZE);
for (let i = 0; i < FILE_SIZE; i++) SRC[i] = (i * 13 + 29) % 251;
const CUTS = [[0, 1048576], [1048576, 2097152], [2097152, FILE_SIZE]];
const EXPECT = CUTS.map(([s, e]) => ({ start: s, end: e, bytes: e - s, sha: sha256(SRC.subarray(s, e)) }));

const TEST_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>upload e2e</title></head><body></body></html>`;
let netCalls = [];
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/" || p === "/index.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(TEST_HTML); }
  if (p === "/sw.js") { res.writeHead(404); return res.end("no sw"); }
  if (p === "/services/uploadWorker.js") {
    const f = path.join(ROOT, "services", "uploadWorker.js");
    res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(fs.readFileSync(f));
  }
  if (p === "/api/drive/upload/blob" && req.method === "POST") {
    const bufs = [];
    for await (const c of req) bufs.push(c);
    const body = Buffer.concat(bufs);
    netCalls.push({
      bytes: [...body],
      len: body.length,
      ct: req.headers["content-type"],
      uid: req.headers["x-drive-upload-id"],
      idx: req.headers["x-drive-index"],
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ sha: "a".repeat(40), ok: true }));
  }
  res.writeHead(404); res.end("nf");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  await page.goto(ORIGIN, { waitUntil: "load" });

  const sliceResults = await page.evaluate(async ({ size, cuts }) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 13 + 29) % 251;
    const file = new File([bytes], "e2e.bin", { type: "application/octet-stream" });
    const w = new Worker("/services/uploadWorker.js");
    const pending = new Map();
    w.onmessage = (e) => {
      const d = e.data;
      const p = pending.get(d.index);
      if (p) { pending.delete(d.index); p(d); }
    };
    const jobs = cuts.map(([start, end], index) => new Promise((resolve) => {
      pending.set(index, resolve);
      w.postMessage({ cmd: "slice", file, index, start, end });
    }));
    const all = await Promise.all(jobs);
    const invalid = await new Promise((resolve) => {
      pending.set(999, resolve);
      w.postMessage({ cmd: "slice", file: null, index: 999, start: 0, end: 10 });
    });
    const mapped = all.map((d) => ({
      ok: d.ok, index: d.index, bytes: d.bytes, sha256: d.sha256,
      isArrayBuffer: d.buffer instanceof ArrayBuffer,
      head: d.buffer ? [...new Uint8Array(d.buffer).slice(0, 8)] : [],
    }));
    w.terminate();
    return { mapped, invalid: { ok: invalid.ok, error: invalid.error || "" }, created: !!w };
  }, { size: FILE_SIZE, cuts: CUTS });

  const { mapped, invalid } = sliceResults;
  check("F1 后台 Worker 成功创建并响应 3 个分片", mapped.length === 3 && mapped.every((x) => x.ok === true), JSON.stringify(mapped.map((x) => x.ok)));
  check("F2 分片 index 与派发顺序一致", mapped.map((x) => x.index).join(",") === "0,1,2");
  check("F3 每片字节数与请求区间一致", mapped.every((x, i) => x.bytes === EXPECT[i].bytes), JSON.stringify(mapped.map((x) => x.bytes)));
  check("F4 每片 SHA-256 与源文件对应区间完全一致",
    mapped.every((x, i) => x.sha256 === EXPECT[i].sha),
    JSON.stringify(mapped.map((x) => x.sha256.slice(0, 12))));
  check("F5 回传的是 transferable ArrayBuffer（非 Base64 字符串）",
    mapped.every((x) => x.isArrayBuffer && x.head.length === 8));
  check("F6 分片内容确为源文件对应偏移",
    mapped.every((x, i) => x.head.every((b, k) => b === SRC[EXPECT[i].start + k])));
  check("F7 无效 File 返回 ok:false 且带错误信息", invalid.ok === false && invalid.error.length > 0, JSON.stringify(invalid));

  // 前端裸二进制网络行为：模拟 uploadBlobPart 的真实 fetch
  netCalls = [];
  await page.evaluate(async () => {
    await fetch("/api/drive/upload/blob", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-drive-upload-id": "e2e", "x-drive-index": "0" },
      body: new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]),
    });
  });
  const nc = netCalls[0];
  check("F8 裸 ArrayBuffer 请求体逐字节到达服务端（9 字节，非 Base64 膨胀）",
    !!nc && nc.len === 9 && nc.bytes.join(",") === "0,1,2,250,251,252,253,254,255",
    nc ? `len=${nc.len} bytes=${nc.bytes.join(",")}` : "无请求");
  check("F9 请求头为 application/octet-stream 且透传 uploadId/index",
    !!nc && nc.ct === "application/octet-stream" && nc.uid === "e2e" && nc.idx === "0",
    nc ? `${nc.ct} ${nc.uid}/${nc.idx}` : "无请求");

  // 静态链路断言：防止后来者把 Base64 膨胀重新引入主线程
  const svc = fs.readFileSync(path.join(ROOT, "services", "uploadService.js"), "utf8");
  const wk = fs.readFileSync(path.join(ROOT, "_worker.js"), "utf8");
  check("F10 前端以 body: buffer 发送裸二进制 + octet-stream + Worker 切片",
    /body:\s*buffer/.test(svc) && /application\/octet-stream/.test(svc) &&
    /new Worker\("\/services\/uploadWorker\.js"\)/.test(svc));
  check("F11 前端不存在 btoa / Base64 编码调用（主线程零膨胀）", !/btoa\s*\(/.test(svc));
  check("F12 能力探测失败或异常时全链路回退 Legacy",
    /probeAtomic\(\)/.test(svc) && /uploadChunkedLegacy\(task\)/.test(svc));
  check("F13 Worker 用 getReader() 流式读取请求体并串行化 ref 更新",
    /request\.body\.getReader\(\)/.test(wk) && /withWriteLock\("drive:atomic-ref"/.test(wk));
  check("F14 Base64 转换只发生在 Worker→GitHub 的 /git/blobs 边界",
    /content:\s*bytesToBase64\(bytes\),\s*encoding:\s*"base64"/.test(wk));
  check("F15 全程零 JS 错误", jsErrors.length === 0, jsErrors.join(" | "));

  await ctx.close();
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
