// ============================================================
// v9.2 步骤 18：大文件安全重命名端点专项测试（Node 直测 worker）
//   POST /api/drive/rename 只改 manifest 的 name 字段，一次 PUT，
//   分片内容零搬运。覆盖：正常改名 / 字段保全 / sha 覆盖更新 /
//   路径白名单 / 名称校验 / PIN 闸门 / 损坏清单 / 子目录 / UTF-8 中文名。
// 运行：node tests/step18-drive-rename.mjs
// ============================================================
import path from "node:path";
import { pathToFileURL } from "node:url";

const OLD = {
  uploadId: "abc123", name: "旧影片.dat", size: 99999999,
  total: 12, chunkBytes: 8388608, createdAt: "2026-01-01T00:00:00Z",
};
let metaContent = Buffer.from(JSON.stringify(OLD), "utf8").toString("base64");
let metaStatus = 200;
const calls = [];

globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input.url;
  const method = (init && init.method) || "GET";
  let body = null;
  if (init && init.body) {
    try { body = JSON.parse(init.body); } catch (e) { body = String(init.body); }
  }
  calls.push({ u, method, body });
  if (u.includes("rate_limit")) {
    return new Response(JSON.stringify({ rate: { remaining: 5000 } }), { status: 200 });
  }
  const mm = u.match(/\/contents\/(drive\/[^?]+)\?ref=/);
  if (mm && method === "GET") {
    if (metaStatus !== 200) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: metaStatus });
    }
    return new Response(JSON.stringify({
      type: "file", name: "m", path: mm[1], sha: "sha-m",
      content: metaContent, encoding: "base64",
    }), { status: 200 });
  }
  if (u.includes("/contents/") && method === "PUT") {
    return new Response(JSON.stringify({
      content: { sha: "new-sha" }, commit: { sha: "commit-sha" },
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ message: "unexpected " + u }), { status: 500 });
};

const ROOT = path.resolve(import.meta.dirname, "..");
const worker = (await import(pathToFileURL(path.join(ROOT, "_worker.js")).href)).default;
const ENV = { GITHUB_TOKEN: "test-token", DRIVE_PIN: "1234" };
const CTX = { waitUntil: () => {} };

async function call(body, pin = "1234") {
  const res = await worker.fetch(new Request("https://blog.local/api/drive/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-drive-pin": pin },
    body: JSON.stringify(body),
  }), ENV, CTX);
  let j = null;
  try { j = JSON.parse(await res.text()); } catch (e) { /* 非 JSON */ }
  return { status: res.status, j };
}
function writtenManifest() {
  const put = calls.filter((c) => c.method === "PUT").pop();
  if (!put || !put.body || !put.body.content) return null;
  return JSON.parse(Buffer.from(put.body.content, "base64").toString("utf8"));
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
}

console.log("== R 组：v9.2 大文件安全重命名端点 ==");
let r = await call({ path: "drive/.m-abc123.json", name: "新名字.bin" });
check("R1 正常重命名返回 200", r.status === 200, JSON.stringify(r));
const w = writtenManifest();
check("R2 manifest.name 已更新", !!w && w.name === "新名字.bin", w && w.name);
check("R3 total/uploadId/chunkBytes 原样保留（分片零改动）",
  !!w && w.total === 12 && w.uploadId === "abc123" && w.chunkBytes === 8388608,
  JSON.stringify(w));
check("R4 PUT 带 sha（覆盖更新而非新建）",
  calls.some((c) => c.method === "PUT" && c.body && c.body.sha === "sha-m"));

calls.length = 0;
r = await call({ path: "drive/普通文件.txt", name: "x.bin" });
check("R5 普通文件路径被拒（防止覆写任意文件）", r.status === 400, JSON.stringify(r));
r = await call({ path: "drive/.m-abc123.json", name: "../evil" });
check("R6 含路径符号的名称被拒", r.status === 400, JSON.stringify(r));
r = await call({ path: "drive/.m-abc123.json", name: ".hidden" });
check("R7 点开头的名称被拒", r.status === 400, JSON.stringify(r));
r = await call({ path: "drive/.m-abc123.json" });
check("R8 缺 name 参数被拒", r.status === 400, JSON.stringify(r));
r = await call({ path: "drive/.m-abc123.json", name: "中文 名.bin" }, "wrong-pin");
check("R9 错误口令被 401 拦下（复用既有 PIN 闸门）", r.status === 401, JSON.stringify(r));

metaContent = "!!!not-base64!!!";
r = await call({ path: "drive/.m-abc123.json", name: "x.bin" });
check("R10 损坏清单返回 422 而非 500", r.status === 422, JSON.stringify(r));

metaContent = Buffer.from(JSON.stringify(OLD), "utf8").toString("base64");
calls.length = 0;
r = await call({ path: "drive/album/2026/.m-abc123.json", name: "中文名字.bin" });
check("R11 子目录清单可重命名", r.status === 200, JSON.stringify(r));
const w2 = writtenManifest();
check("R12 中文名 UTF-8 无损（未乱码）", !!w2 && w2.name === "中文名字.bin", w2 && w2.name);

console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
