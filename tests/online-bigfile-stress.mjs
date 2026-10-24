// ============================================================
// 线上真实大文件全链路压测（v6.0 步骤4）
//   对象：生产环境 https://leiyihan.dpdns.org（Cloudflare Worker → GitHub Contents API）
//   文件：64MB 确定性随机内容（可算 SHA256 逐字节校验）
//   流程：status 断点查询 → 12 片全速 + 1 片弱网(limit-rate) → finish
//        → list 校验 → manifest+parts 重组 SHA256 比对 → 删除 → 三重确认
// 注意：会向生产仓库写入 13 个分片 commit + 1 个 manifest commit，最后全部删除。
//       手动运行：node tests/online-bigfile-stress.mjs
// ============================================================
import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const BASE = process.env.DRIVE_BASE || "https://leiyihan.dpdns.org";
const PIN = process.env.DRIVE_PIN || "8866";
const REPO = "leiyihan-ren/Blog";
const BRANCH = "main";

const CHUNK = 5 * 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024; // 64MB → 13 片（12×5MB + 1×2MB）
const NAME = "stress-64mb.bin";
const WEAK_INDEX = 12; // 最后一片走弱网限速上传
const WEAK_RATE = "150k"; // curl --limit-rate
const WEAK_TIMEOUT_MS = 120000;

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
};

/* ---------- 64MB 确定性随机内容（mulberry32，跨端可复现） ---------- */
function genBuffer(size) {
  const buf = Buffer.allocUnsafe(size);
  let s = 0x9e3779b9;
  const rnd = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < size; i += 4) {
    const v = Math.floor(rnd() * 4294967296);
    buf.writeUInt32LE(v >>> 0, i);
  }
  return buf;
}

async function api(path, opts = {}) {
  const headers = { "x-drive-pin": PIN, ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, data, text };
}

async function curlLimitRatePart(uploadId, index, contentB64) {
  // 真·弱网：curl --limit-rate 限速上传单个分片
  // 注意：body ~6.7MB，超过 Linux 单参数 128KB 限制，必须落临时文件走 @file
  const tmp = `/tmp/weak-part-${uploadId}-${index}.json`;
  fs.writeFileSync(tmp, JSON.stringify({ uploadId, index, content: contentB64 }));
  try {
    const { stdout } = await pexec("curl", [
      "-sS", "-X", "POST",
      "-H", `x-drive-pin: ${PIN}`,
      "-H", "Content-Type: application/json",
      "--limit-rate", WEAK_RATE,
      "--max-time", String(Math.ceil(WEAK_TIMEOUT_MS / 1000)),
      "-w", "\n%{http_code} %{time_total}",
      "--data-binary", `@${tmp}`,
      `${BASE}/api/drive/upload/part`,
    ], { maxBuffer: 32 * 1024 * 1024, encoding: "utf-8" });
    const m = /(\d{3}) ([\d.]+)\s*$/.exec(stdout.trim());
    return { http: m ? Number(m[1]) : 0, secs: m ? Number(m[2]) : 0 };
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function main() {
  console.log("== 线上 64MB 真实文件全链路压测 ==\n");
  console.log(`  目标：${BASE}  仓库：${REPO}@${BRANCH}`);

  /* ---- 0. 生成文件与指纹 ---- */
  const t0 = Date.now();
  const file = genBuffer(TOTAL_BYTES);
  const sha = crypto.createHash("sha256").update(file).digest("hex");
  const parts = [];
  for (let i = 0; i * CHUNK < TOTAL_BYTES; i++) {
    parts.push(file.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, TOTAL_BYTES)));
  }
  console.log(`  文件：${NAME} ${(TOTAL_BYTES / 1048576).toFixed(0)}MB / ${parts.length} 片 / sha256=${sha.slice(0, 16)}…`);
  check("S0 文件与分片切分正确（12×5MB + 1×4MB）",
    parts.length === 13 && parts.slice(0, 12).every((p) => p.length === CHUNK) && parts[12].length === 4 * 1024 * 1024,
    `parts=${parts.length} last=${parts[12].length}`);

  const uploadId = "stress" + Date.now().toString(36);
  console.log(`  uploadId=${uploadId}\n`);

  /* ---- 1. 断点查询：应为空 ---- */
  const st = await api(`/api/drive/upload/status?uploadId=${uploadId}`);
  check("S1 断点查询 ok 且 parts 为空（新上传）",
    st.status === 200 && st.data && st.data.ok && Array.isArray(st.data.parts) && st.data.parts.length === 0,
    JSON.stringify(st.data));

  /* ---- 2. 分片上传：index 0-11 全速，index 12 弱网 ---- */
  console.log("  —— 分片上传（0-11 全速 / 12 弱网限速）——");
  const upStart = Date.now();
  for (let i = 0; i < parts.length; i++) {
    const b64 = parts[i].toString("base64");
    if (i === WEAK_INDEX) {
      const weak = await curlLimitRatePart(uploadId, i, b64);
      // curl 输出已丢弃，用 status 复核该片确实落库
      const mid = await api(`/api/drive/upload/status?uploadId=${uploadId}`);
      const has = mid.data && mid.data.parts && mid.data.parts.includes(i);
      check(`S2 弱网分片 ${i} 限速 ${WEAK_RATE} 上传成功`, has && weak.http === 200, `parts=${JSON.stringify(mid.data && mid.data.parts)} http=${weak.http}`);
      // 5MB @150KB/s ≈ 34s 起；低于该值说明限速没生效
      check(`S2 弱网限速真实生效（耗时 ${weak.secs}s ≥ 5MB/150KB/s≈34s）`, weak.secs >= 30, `secs=${weak.secs}`);
    } else {
      const r = await api("/api/drive/upload/part", {
        method: "POST",
        body: { uploadId, index: i, content: b64 },
      });
      if (r.status !== 200 && r.status !== 201) {
        check(`S2 分片 ${i} 上传`, false, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
        throw new Error("分片上传失败，中止");
      }
    }
    process.stdout.write(`    片 ${String(i).padStart(2, "0")}/12 ✓\n`);
  }
  const upSecs = ((Date.now() - upStart) / 1000).toFixed(1);
  const st2 = await api(`/api/drive/upload/status?uploadId=${uploadId}`);
  check("S2 全部 13 片落库（status 复核）",
    st2.status === 200 && st2.data.parts.length === 13 &&
      st2.data.parts.every((v, i) => v === i),
    `parts=${JSON.stringify(st2.data.parts)} 用时=${upSecs}s`);

  /* ---- 3. finish 写 manifest ---- */
  const fin = await api("/api/drive/upload/finish", {
    method: "POST",
    body: { uploadId, total: parts.length, name: NAME, size: TOTAL_BYTES, chunkBytes: CHUNK },
  });
  check("S3 finish 写 manifest ok", fin.status === 200 && fin.data && fin.data.ok, JSON.stringify(fin.data).slice(0, 160));

  /* ---- 4. 列表出现大文件条目 ---- */
  const list = await api("/api/drive/list");
  const item = list.data && list.data.files && list.data.files.find((f) => f.name === NAME);
  check("S4a 列表出现 🧩 大文件条目",
    !!item && item.storage === "chunked" && item.uploadId === uploadId,
    item ? `${item.name} ${item.storage} ${item.size}B` : "未找到");
  check("S4b 条目 size/uploadId 正确", !!item && item.size === TOTAL_BYTES && item.uploadId === uploadId, `size=${item && item.size}`);
  check("S4c 大文件无单文件直链（downloadUrl=null，走重组）", !!item && item.downloadUrl === null);

  /* ---- 5. 重组校验：manifest + 13 片逐字节 SHA256 ---- */
  const rawManifest = await fetch(`${BASE}/api/github/raw/${REPO}/${BRANCH}/drive/.m-${uploadId}.json`);
  check("S5a manifest 直链 200", rawManifest.status === 200);
  const manifest = await rawManifest.json();
  check("S5b manifest 元数据正确（total/size/uploadId）",
    manifest.total === 13 && manifest.size === TOTAL_BYTES && manifest.uploadId === uploadId && manifest.name === NAME,
    JSON.stringify({ total: manifest.total, size: manifest.size, name: manifest.name }));

  // 4 路并发拉分片，重组后比对
  const chunks = new Array(13);
  let next = 0, fetchErr = null;
  async function pump() {
    const batch = [];
    while (next < 13 && batch.length < 4) batch.push(next++);
    if (!batch.length) return;
    await Promise.all(batch.map(async (i) => {
      const pad = String(i).padStart(5, "0");
      const r = await fetch(`${BASE}/api/github/raw/${REPO}/${BRANCH}/drive/.parts/${uploadId}/part-${pad}`);
      if (!r.ok) { fetchErr = `分片 ${i} HTTP ${r.status}`; return; }
      chunks[i] = Buffer.from(await r.arrayBuffer());
    }));
    if (!fetchErr) return pump();
  }
  const dlStart = Date.now();
  await pump();
  const dlSecs = ((Date.now() - dlStart) / 1000).toFixed(1);
  check("S5c 13 个分片直链全部 200", !fetchErr && chunks.every((c) => c && c.length > 0), fetchErr || `用时=${dlSecs}s`);
  const rejoined = Buffer.concat(chunks);
  const reSha = crypto.createHash("sha256").update(rejoined).digest("hex");
  check("S5d 重组后总字节 = 64MB", rejoined.length === TOTAL_BYTES, `len=${rejoined.length}`);
  check("S5e 重组后 SHA256 与源文件逐字节一致", reSha === sha, `${reSha.slice(0, 16)}… vs ${sha.slice(0, 16)}…`);

  /* ---- 6. 删除 ---- */
  const del = await api("/api/drive/delete", { method: "DELETE", body: { path: `drive/.m-${uploadId}.json` } });
  check("S6a 删除 ok 且报告删除 13 个分片",
    del.status === 200 && del.data && del.data.ok && del.data.removedParts === 13,
    JSON.stringify(del.data).slice(0, 160));

  /* ---- 7. 三重确认 ---- */
  const list2 = await api("/api/drive/list");
  check("S7a 确认①：列表已无该文件",
    list2.data.files.every((f) => f.name !== NAME), `files=${list2.data.files.length}`);
  const rawGone = await fetch(`${BASE}/api/github/raw/${REPO}/${BRANCH}/drive/.m-${uploadId}.json`);
  check("S7b 确认②：manifest raw 直链 404", rawGone.status === 404, `HTTP ${rawGone.status}`);
  // 确认③：直接问 GitHub API（绕过本地缓存）
  const gh = await pexec("gh", [
    "api", `repos/${REPO}/contents/drive/.m-${uploadId}.json?ref=${BRANCH}`, "--include",
  ]).then(() => "200").catch((e) => {
    const m = /HTTP (\d{3})/.exec(String(e.stderr || e.message || ""));
    return m ? m[1] : "err";
  });
  check("S7c 确认③：GitHub Contents API 404", gh === "404", `HTTP ${gh}`);

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n结果：${passed} 通过 / ${failed} 失败（总耗时 ${secs}s）`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("压测异常：", e); process.exit(1); });
