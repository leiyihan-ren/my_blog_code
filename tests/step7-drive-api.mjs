// ============================================================
// v5.0 步骤 7：GitHub 云盘（文件管理器）API 单元测试
//   背景：drive.html 的读写全部经 /api/drive/* 代理转发 GitHub
//   Contents API，Token 只在 Worker 内注入。本测试在 Node 中
//   直接 import worker，mock global fetch 模拟 GitHub 响应，
//   覆盖 PIN 鉴权、SHA 逻辑、大小限制、路径穿越、错误映射。
// 运行：node tests/step7-drive-api.mjs
// ============================================================
import http from "node:http";

/* ---------- GitHub API mock ---------- */
const ghCalls = [];
let ghBehavior = {
  // contents/drive 目录列表（GET /repos/:repo/contents/drive）
  contentsList: () => [
    { type: "file", name: "hello.txt", path: "drive/hello.txt", size: 12, sha: "sha-hello" },
    { type: "file", name: "pic.png", path: "drive/pic.png", size: 2048, sha: "sha-pic" },
  ],
  // 单文件元数据（GET /repos/:repo/contents/drive/<name>）
  contentsMeta: (path) =>
    path.endsWith("hello.txt")
      ? { type: "file", name: "hello.txt", path, size: 12, sha: "sha-hello" }
      : null, // null → 404
  // 最近 commit（GET /repos/:repo/commits?path=...）
  commitTime: () => [{ commit: { committer: { date: "2026-10-23T10:00:00Z" } } }],
  putStatus: 201, // PUT /contents 响应码
  deleteStatus: 200,
};

const realFetch = globalThis.fetch;

/** 安装 GitHub mock（可重复安装/恢复） */
function installGhMock() {
  globalThis.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    ghCalls.push({ url: u, method, body: init && init.body ? JSON.parse(init.body) : null });

    if (u.includes("api.github.com/repos/") && u.includes("/contents/drive") && method === "GET" && !u.match(/\/contents\/drive\/[^?]/)) {
      return new Response(JSON.stringify(ghBehavior.contentsList()), { status: 200 });
    }
    const metaMatch = u.match(/\/contents\/(drive\/[^?]+)\?ref=/);
    if (metaMatch && method === "GET") {
      const meta = ghBehavior.contentsMeta(metaMatch[1]);
      return meta
        ? new Response(JSON.stringify(meta), { status: 200 })
        : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (u.includes("/commits?path=") && method === "GET") {
      return new Response(JSON.stringify(ghBehavior.commitTime()), { status: 200 });
    }
    if (u.includes("/contents/") && method === "PUT") {
      return new Response(
        JSON.stringify({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } }),
        { status: ghBehavior.putStatus }
      );
    }
    if (u.includes("/contents/") && method === "DELETE") {
      return new Response(JSON.stringify({ commit: { sha: "del-sha" } }), { status: ghBehavior.deleteStatus });
    }
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
  };
}
installGhMock();

/* ---------- worker 导入（mock 之后） ---------- */
const { pathToFileURL } = await import("node:url");
const path = await import("node:path");
const ROOT = path.resolve(import.meta.dirname, "..");
const worker = (await import(pathToFileURL(path.join(ROOT, "_worker.js")).href)).default;

const ENV = { GITHUB_TOKEN: "test-token", DRIVE_PIN: "1234" };
const CTX = { waitUntil: () => {} };

async function drive(method, sub, { body, pin, env, query } = {}) {
  const headers = {};
  if (pin !== null) headers["x-drive-pin"] = pin === undefined ? "1234" : pin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const url = `https://blog.local/api/drive/${sub}${query || ""}`;
  const req = new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env || ENV, CTX);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json, text };
}

/* ---------- 断言工具 ---------- */
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
}

console.log("== D 组：云盘 API 单元测试（Node 直测 worker） ==");

// D1 无 PIN → 401
{
  const r = await drive("GET", "list", { pin: null });
  check("D1 无 PIN 读列表 → 401", r.status === 401, `got ${r.status}`);
}

// D2 错 PIN → 401
{
  const r = await drive("GET", "list", { pin: "9999" });
  check("D2 错误 PIN → 401", r.status === 401, `got ${r.status}`);
}

// D3 列表：文件 + 上传时间 + 目录级最新时间
{
  ghCalls.length = 0;
  const r = await drive("GET", "list");
  check("D3a 列表 ok", r.status === 200 && r.json && r.json.ok === true);
  check("D3b 返回 2 个文件", r.json && r.json.files.length === 2, JSON.stringify(r.json && r.json.files));
  check(
    "D3c 每文件带 sha/downloadUrl",
    r.json.files.every((f) => f.sha && f.downloadUrl.includes("/api/github/raw/leiyihan-ren/Blog/main/"))
  );
  check(
    "D3d 每文件带 uploadedAt（commits 查询）",
    r.json.files.every((f) => f.uploadedAt === "2026-10-23T10:00:00Z"),
    JSON.stringify(r.json.files.map((f) => f.uploadedAt))
  );
  check("D3e latestAt 汇总", r.json.latestAt === "2026-10-23T10:00:00Z");
  const putCalls = ghCalls.filter((c) => c.method === "PUT" || c.method === "DELETE");
  check("D3f 列表零写调用", putCalls.length === 0);
}

// D4 空目录（GitHub 404）→ empty。用子路径绕过 isolate 列表缓存（与 D3 的 key 不同）
{
  globalThis.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input.url;
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
  const r = await drive("GET", "list", { query: "?path=drive/sub" });
  check("D4 目录不存在 → empty:true", r.status === 200 && r.json.empty === true, JSON.stringify(r.json));
  installGhMock(); // 恢复标准 mock
}

// D5 上传新文件（元数据 404）→ PUT 不带 sha
{
  ghCalls.length = 0;
  const content = Buffer.from("hello world").toString("base64");
  const r = await drive("POST", "upload", { body: { path: "drive/new.txt", content } });
  check("D5a 上传 ok", r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  check("D5b 返回新 sha/commit", r.json.sha === "new-sha" && r.json.commit === "commit-sha");
  const put = ghCalls.find((c) => c.method === "PUT");
  check("D5c 新文件 PUT 不带 sha", !!put && !put.body.sha, JSON.stringify(put && put.body));
  check("D5d 上传前先 GET 探测存在性", ghCalls.some((c) => c.method === "GET" && c.url.includes("/contents/drive/new.txt")));
  check("D5e updated=false", r.json.updated === false);
}

// D6 上传已存在文件（元数据 200）→ PUT 带 sha（覆盖分流）
{
  ghCalls.length = 0;
  const content = Buffer.from("hello v2").toString("base64");
  const r = await drive("POST", "upload", { body: { path: "drive/hello.txt", content } });
  check("D6a 覆盖上传 ok", r.status === 200 && r.json.ok === true);
  const put = ghCalls.find((c) => c.method === "PUT");
  check("D6b 已存在文件 PUT 带 sha", !!put && put.body.sha === "sha-hello", JSON.stringify(put && put.body));
  check("D6c updated=true", r.json.updated === true);
}

// D7 更新不存在的文件 → 404
{
  const content = Buffer.from("x").toString("base64");
  const r = await drive("PUT", "update", { body: { path: "drive/ghost.txt", content } });
  check("D7 更新不存在文件 → 404", r.status === 404 && /不存在/.test(r.json.error), JSON.stringify(r.json));
}

// D8 删除：先 GET sha 再 DELETE
{
  ghCalls.length = 0;
  const r = await drive("DELETE", "delete", { body: { path: "drive/hello.txt" } });
  check("D8a 删除 ok", r.status === 200 && r.json.ok === true);
  const del = ghCalls.find((c) => c.method === "DELETE");
  check("D8b DELETE body 带 sha", !!del && del.body.sha === "sha-hello", JSON.stringify(del && del.body));
  check("D8c 删除前有 GET 元数据", ghCalls.some((c) => c.method === "GET" && c.url.includes("/contents/drive/hello.txt")));
}

// D9 删除不存在文件 → 404
{
  const r = await drive("DELETE", "delete", { body: { path: "drive/ghost.txt" } });
  check("D9 删除不存在文件 → 404", r.status === 404, `got ${r.status}`);
}

// D10 GitHub 403（Token 权限不足）→ 友好 403
{
  ghBehavior.putStatus = 403;
  const content = Buffer.from("x").toString("base64");
  const r = await drive("POST", "upload", { body: { path: "drive/hello.txt", content } });
  check("D10a GitHub 403 → 友好错误", r.status === 403 && /权限不足/.test(r.json.error), JSON.stringify(r.json));
  ghBehavior.putStatus = 201;
}

// D11 GitHub 409（SHA 冲突）→ 友好 409
{
  ghBehavior.putStatus = 409;
  const content = Buffer.from("x").toString("base64");
  const r = await drive("POST", "upload", { body: { path: "drive/hello.txt", content } });
  check("D11 GitHub 409 → SHA 冲突提示", r.status === 409 && /SHA 冲突/.test(r.json.error), JSON.stringify(r.json));
  ghBehavior.putStatus = 201;
}

// D12 超大文件（>8MB 直传上限）→ 413 提示走分片
{
  const big = "A".repeat(11_184_820); // 解码后 8388615 B > 8MB（8388608）
  const r = await drive("POST", "upload", { body: { path: "drive/big.bin", content: big } });
  check("D12 超 8MB 直传 → 413 并提示分片", r.status === 413 && /分片/.test(r.json.error), `got ${r.status} ${r.json && r.json.error}`);
}

// D13 路径穿越 → 400
{
  const content = Buffer.from("x").toString("base64");
  const r1 = await drive("POST", "upload", { body: { path: "drive/../etc/passwd", content } });
  check("D13a ../ 穿越 → 400", r1.status === 400, `got ${r1.status}`);
  const r2 = await drive("POST", "upload", { body: { path: "posts/evil.txt", content } });
  check("D13b 非云盘目录 → 400", r2.status === 400, `got ${r2.status}`);
}

// D14 非法 Base64 → 400
{
  const r = await drive("POST", "upload", { body: { path: "drive/a.txt", content: "!!!not-base64!!!" } });
  check("D14 非法 Base64 → 400", r.status === 400, `got ${r.status}`);
}

// D15 /api/github/ 写透传：PIN 保护 + 转发
{
  const r1 = await worker.fetch(
    new Request("https://blog.local/api/github/api/repos/leiyihan-ren/Blog/contents/drive/a.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "m", content: "eA==" }),
    }),
    ENV,
    CTX
  );
  check("D15a /api/github/ PUT 无 PIN → 401", r1.status === 401, `got ${r1.status}`);

  ghCalls.length = 0;
  const r2 = await worker.fetch(
    new Request("https://blog.local/api/github/api/repos/leiyihan-ren/Blog/contents/drive/a.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-drive-pin": "1234" },
      body: JSON.stringify({ message: "m", content: "eA==" }),
    }),
    ENV,
    CTX
  );
  check("D15b /api/github/ PUT 带 PIN → 透传 GitHub", r2.status === 201, `got ${r2.status}`);
  const put = ghCalls.find((c) => c.method === "PUT");
  check("D15c 透传目标为 api.github.com", !!put && put.url.includes("api.github.com/repos/leiyihan-ren/Blog/contents/"));
}

// D16 DRIVE_PIN 环境变量覆盖默认值
{
  const r = await drive("GET", "list", { pin: "1234", env: { GITHUB_TOKEN: "t", DRIVE_PIN: "8888" } });
  check("D16 env.DRIVE_PIN 覆盖默认 → 旧 PIN 失效", r.status === 401, `got ${r.status}`);
}

// D17 默认 PIN 兜底（env 无 DRIVE_PIN）
{
  const r = await drive("GET", "list", { pin: "8866", env: { GITHUB_TOKEN: "t" } });
  check("D17 未配 env.DRIVE_PIN 时默认 PIN 生效", r.status === 200, `got ${r.status}`);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
