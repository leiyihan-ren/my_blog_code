// ============================================================
// v6.0 步骤 8：GitHub 云盘大文件分片协议 API 测试
//   背景：>8MB 文件走「前端切片 → Worker 透传 → GitHub 逐片落库」
//   的分片协议（status / part / finish），下载时浏览器端重组。
//   本测试用带内存存储的 GitHub mock（比静态响应更接近真实行为：
//   PUT 真写、DELETE 真删、sha 真变），覆盖断点查询、幂等重传、
//   finish 校验、manifest 合并列表、manifest 批量删除。
// 运行：node tests/step8-drive-chunked.mjs
// ============================================================

/* ---------- 带内存存储的 GitHub API mock ---------- */
// store: path → { sha, content(base64), size, type }
const store = new Map();
const ghCalls = [];
// 409 注入：模拟 GitHub 读副本滞后（目录列表里的 sha 过期）
const delete409Once = new Set();   // path → 下次 DELETE 返回 409 一次（自愈后应成功）
const delete409Always = new Set(); // path → DELETE 永远 409（验证有界重试后明确报错）

function shaOf(path, content) {
  // 简化 sha：路径+内容长度（测试只关心「有没有 sha、sha 是否变化」）
  return `sha-${path}-${(content || "").length}-${store.size}`;
}

function listDir(prefix) {
  const items = [];
  const seenDirs = new Set();
  for (const [p, v] of store) {
    if (!p.startsWith(prefix + "/")) continue;
    const rest = p.slice(prefix.length + 1);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const dirName = rest.slice(0, slash);
      if (!seenDirs.has(dirName)) {
        seenDirs.add(dirName);
        items.push({ type: "dir", name: dirName, path: `${prefix}/${dirName}` });
      }
    } else {
      items.push({ type: "file", name: rest, path: p, size: v.size, sha: v.sha });
    }
  }
  return items;
}

function installStoreMock() {
  globalThis.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input.url;
    const method = (init && init.method) || "GET";
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { /* raw */ }
    ghCalls.push({ url: u, method, body });

    const metaMatch = u.match(/\/contents\/([^?]+)\?ref=/);
    if (method === "GET" && metaMatch) {
      const p = decodeURIComponent(metaMatch[1]);
      if (store.has(p)) {
        const v = store.get(p);
        return new Response(
          JSON.stringify({ type: "file", name: p.split("/").pop(), path: p, size: v.size, sha: v.sha, content: v.content }),
          { status: 200 }
        );
      }
      // 目录：store 里有以其为前缀的条目
      const children = listDir(p);
      if (children.length) {
        return new Response(JSON.stringify(children), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (method === "PUT" && metaMatch) {
      const p = decodeURIComponent(metaMatch[1]);
      const existed = store.get(p);
      // sha 冲突模拟：更新时 sha 不匹配 → 409
      if (existed && body.sha && body.sha !== existed.sha) {
        return new Response(JSON.stringify({ message: "conflict" }), { status: 409 });
      }
      if (!existed && body.sha) {
        return new Response(JSON.stringify({ message: "sha given but not exists" }), { status: 409 });
      }
      const content = String(body.content || "");
      const sha = shaOf(p, content);
      store.set(p, { sha, content, size: Math.floor((content.length * 3) / 4) });
      return new Response(
        JSON.stringify({ content: { sha, path: p }, commit: { sha: "commit-" + sha } }),
        { status: 201 }
      );
    }
    if (method === "DELETE" && metaMatch) {
      const p = decodeURIComponent(metaMatch[1]);
      // 读副本滞后模拟：返回 409，同时把 store 里的 sha 轮换
      // （worker 自愈的 GET 会拿到与首次 DELETE 不同的新 sha → 触发刷新重删）
      if (delete409Once.has(p)) {
        delete409Once.delete(p);
        const v = store.get(p);
        if (v) v.sha = v.sha + "-rotated";
        return new Response(JSON.stringify({ message: "conflict" }), { status: 409 });
      }
      if (delete409Always.has(p)) {
        const v = store.get(p);
        if (v) v.sha = v.sha + "-rot" + Math.random().toString(36).slice(2, 6);
        return new Response(JSON.stringify({ message: "conflict" }), { status: 409 });
      }
      if (!store.has(p)) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      store.delete(p);
      return new Response(JSON.stringify({ commit: { sha: "del" } }), { status: 200 });
    }
    if (u.includes("/commits?path=") && method === "GET") {
      return new Response(
        JSON.stringify([{ commit: { committer: { date: "2026-10-24T09:00:00Z" } } }]),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ message: "unexpected " + u }), { status: 500 });
  };
}
installStoreMock();

/* ---------- worker 导入 ---------- */
const { pathToFileURL } = await import("node:url");
const path = await import("node:path");
const ROOT = path.resolve(import.meta.dirname, "..");
const worker = (await import(pathToFileURL(path.join(ROOT, "_worker.js")).href)).default;

const ENV = { GITHUB_TOKEN: "test-token", DRIVE_PIN: "1234" };
const CTX = { waitUntil: () => {} };

async function drive(method, sub, { body, pin, query } = {}) {
  const headers = {};
  if (pin !== null) headers["x-drive-pin"] = pin === undefined ? "1234" : pin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`https://blog.local/api/drive/${sub}${query || ""}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, ENV, CTX);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json, text };
}

/** 造一片确定内容的 Base64（长度可控） */
function chunkB64(seed, bytes) {
  return Buffer.alloc(bytes, seed & 0xff).toString("base64");
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`); }
}

console.log("== C 组：大文件分片协议 API 测试 ==");

const UID = "m5abc-xyz";
const TOTAL = 3;
const FILE_SIZE = 12 * 1024 * 1024; // 12MB → 3 片（5+5+2）

// C1 分片上传：3 片全部落库，路径符合 .parts/<uid>/part-NNNNN
{
  ghCalls.length = 0;
  for (let i = 0; i < TOTAL; i++) {
    const r = await drive("POST", "upload/part", {
      body: { uploadId: UID, index: i, content: chunkB64(65 + i, 1024) },
    });
    if (r.status !== 200) { check(`C1 第 ${i} 片上传 ok`, false, JSON.stringify(r.json)); break; }
    if (i === TOTAL - 1) check("C1a 3 片分片上传全部 ok", true);
  }
  const puts = ghCalls.filter((c) => c.method === "PUT");
  check(
    "C1b 分片路径为 drive/.parts/<uid>/part-NNNNN",
    puts.every((c) => /\/contents\/drive\/\.parts\/m5abc-xyz\/part-0000\d\?ref=/.test(c.url)),
    JSON.stringify(puts.map((c) => c.url))
  );
  check("C1c 每片一次独立 PUT（天然断点）", puts.length === TOTAL, `got ${puts.length}`);
  check("C1d 新分片 PUT 不带 sha", puts.every((c) => !c.body.sha));
}

// C2 断点查询：status 返回已传分片序号
{
  const r = await drive("GET", "upload/status", { query: `?uploadId=${UID}` });
  check("C2a status ok", r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  check(
    "C2b 已传分片 = [0,1,2]",
    JSON.stringify(r.json.parts) === JSON.stringify([0, 1, 2]),
    JSON.stringify(r.json.parts)
  );
}

// C2c 未开始的 uploadId → 空列表（不是 404）
{
  const r = await drive("GET", "upload/status", { query: "?uploadId=never-started" });
  check("C2c 未开始上传 → parts 为空数组", r.status === 200 && Array.isArray(r.json.parts) && r.json.parts.length === 0);
}

// C3 幂等重传：同一分片再传 → 带 sha 覆盖（重试安全）
{
  ghCalls.length = 0;
  const r = await drive("POST", "upload/part", {
    body: { uploadId: UID, index: 1, content: chunkB64(66, 1024) },
  });
  check("C3a 重传同一分片 ok（幂等）", r.status === 200 && r.json.existed === true, JSON.stringify(r.json));
  const put = ghCalls.find((c) => c.method === "PUT");
  check("C3b 重传 PUT 带 sha（覆盖分流）", !!put && !!put.body.sha, JSON.stringify(put && put.body));
}

// C4 finish 分片不齐 → 409
{
  const r = await drive("POST", "upload/finish", {
    body: { uploadId: "half-done", name: "half.bin", size: 1024, total: 5 },
  });
  check("C4 分片不齐 finish → 409", r.status === 409 && /不完整/.test(r.json.error), JSON.stringify(r.json));
}

// C5 finish 分片齐全 → 写 manifest（含 name/size/total，Base64 编码正确）
{
  ghCalls.length = 0;
  const r = await drive("POST", "upload/finish", {
    body: { uploadId: UID, name: "大文件.bin", size: FILE_SIZE, total: TOTAL },
  });
  check("C5a finish ok", r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  const put = ghCalls.find((c) => c.method === "PUT" && c.url.includes("/.m-"));
  check("C5b manifest 写入 drive/.m-<uid>.json", !!put, JSON.stringify(ghCalls.map((c) => c.url)));
  if (put) {
    const decoded = JSON.parse(Buffer.from(put.body.content, "base64").toString("utf-8"));
    check("C5c manifest 内容正确（UTF-8 中文名）", decoded.name === "大文件.bin" && decoded.size === FILE_SIZE && decoded.total === TOTAL && decoded.uploadId === UID, JSON.stringify(decoded));
  }
}

// C6 list 合并：manifest → chunked 条目；parts/内部目录不泄露
{
  const r = await drive("GET", "list");
  const files = (r.json && r.json.files) || [];
  const big = files.find((f) => f.storage === "chunked");
  check("C6a 列表含大文件条目", !!big, JSON.stringify(files));
  check(
    "C6b 大文件条目字段正确（name/size/storage/uploadId）",
    big && big.name === "大文件.bin" && big.size === FILE_SIZE && big.storage === "chunked" && big.uploadId === UID,
    JSON.stringify(big)
  );
  check("C6c 大文件无单文件直链（前端重组）", big && big.downloadUrl === null);
  check(
    "C6d parts 内部路径不泄露；.m- 仅作为大文件条目 path（不作为普通文件出现）",
    files.every((f) => !f.path.includes("/.parts/")) &&
      files.filter((f) => f.path.includes("/.m-")).every((f) => f.storage === "chunked"),
    JSON.stringify(files.map((f) => f.path))
  );
}

// C7 manifest 删除：删全部分片 + manifest
{
  ghCalls.length = 0;
  const r = await drive("DELETE", "delete", { body: { path: `drive/.m-${UID}.json` } });
  check("C7a manifest 删除 ok", r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  check("C7b 报告删除分片数 = 3", r.json.removedParts === TOTAL, JSON.stringify(r.json));
  const dels = ghCalls.filter((c) => c.method === "DELETE");
  check("C7c 依次删除 3 parts + 1 manifest", dels.length === TOTAL + 1, `got ${dels.length}`);
  check(
    "C7d 删除目标全部位于 drive/.parts 与 .m- 前缀文件",
    dels.every((c) => /drive\/\.(parts|m-)/.test(decodeURIComponent(c.url))),
    JSON.stringify(dels.map((c) => c.url))
  );
  // 删后 list 无残留
  const r2 = await drive("GET", "list");
  check("C7e 删后主列表干净（无 manifest/parts 残留）", r2.json.files.length === 0, JSON.stringify(r2.json.files));
}

// C13 删除 409 自愈（GitHub 读副本滞后）：刷新 sha 重删，有界重试，不死循环
{
  const uid = "m5abc-409";
  // 重建一套 3 片 + manifest
  for (let i = 0; i < 3; i++) {
    await drive("POST", "upload/part", { body: { uploadId: uid, index: i, content: chunkB64(70 + i, 1024) } });
  }
  await drive("POST", "upload/finish", { body: { uploadId: uid, total: 3, name: "conflict.bin", size: 1024 } });

  // C13a：part-00000 首次 DELETE 409（sha 轮换）→ 自愈刷新重删成功
  delete409Once.add(`drive/.parts/${uid}/part-00000`);
  ghCalls.length = 0;
  const r = await drive("DELETE", "delete", { body: { path: `drive/.m-${uid}.json` } });
  const partDels = ghCalls.filter((c) => c.method === "DELETE" && c.url.includes("part-00000"));
  check("C13a 409 自愈：删除成功且报告 3 片", r.status === 200 && r.json.ok && r.json.removedParts === 3, JSON.stringify(r.json));
  check("C13b 自愈路径：该片 DELETE 共 2 次（首次 409 + 刷新重删）", partDels.length === 2, `got ${partDels.length}`);
  const gone = await drive("GET", "upload/status", { query: `?uploadId=${uid}` });
  check("C13c 自愈后分片真删除（status 为空）", gone.json.parts.length === 0, JSON.stringify(gone.json));
}
{
  // C13d：持续 409 → 有界重试（最多 3 次）后明确报错，不死循环
  const uid = "m5abc-409b";
  for (let i = 0; i < 3; i++) {
    await drive("POST", "upload/part", { body: { uploadId: uid, index: i, content: chunkB64(80 + i, 1024) } });
  }
  await drive("POST", "upload/finish", { body: { uploadId: uid, total: 3, name: "conflict2.bin", size: 1024 } });
  delete409Always.add(`drive/.m-${uid}.json`);
  ghCalls.length = 0;
  const r = await drive("DELETE", "delete", { body: { path: `drive/.m-${uid}.json` } });
  const manDels = ghCalls.filter((c) => c.method === "DELETE" && c.url.includes(`.m-${uid}.json`));
  check("C13d 持续 409 → 返回 409 与友好提示（不崩溃）", r.status === 409 && /SHA 冲突/.test(r.json.error || ""), `got ${r.status} ${r.json && r.json.error}`);
  check("C13e 重试有界：manifest DELETE 恰好 4 次（1+3，无死循环）", manDels.length === 4, `got ${manDels.length}`);
  // 清理：解除注入后删干净，避免影响后续断言
  delete409Always.delete(`drive/.m-${uid}.json`);
  await drive("DELETE", "delete", { body: { path: `drive/.m-${uid}.json` } });
}

// C8 分片超 5MB → 413
{
  const big = chunkB64(1, Math.floor(5.2 * 1024 * 1024)); // 解码后 5.2MB > 5MB 分片上限
  const r = await drive("POST", "upload/part", {
    body: { uploadId: "toobig", index: 0, content: big },
  });
  check("C8 分片超 5MB → 413", r.status === 413 && /分片/.test(r.json.error), `got ${r.status} ${r.json && r.json.error}`);
}

// C9 非法 uploadId（路径穿越字符）→ 400
{
  const r1 = await drive("GET", "upload/status", { query: "?uploadId=../evil" });
  check("C9a status 非法 uploadId → 400", r1.status === 400, `got ${r1.status}`);
  const r2 = await drive("POST", "upload/part", {
    body: { uploadId: "../evil", index: 0, content: chunkB64(1, 16) },
  });
  check("C9b part 非法 uploadId → 400", r2.status === 400, `got ${r2.status}`);
  const r3 = await drive("POST", "upload/finish", {
    body: { uploadId: "a/b", name: "x", size: 1, total: 1 },
  });
  check("C9c finish 非法 uploadId → 400", r3.status === 400, `got ${r3.status}`);
}

// C10 分片序号非法 → 400
{
  const r1 = await drive("POST", "upload/part", {
    body: { uploadId: "ok-id", index: -1, content: chunkB64(1, 16) },
  });
  check("C10a 负序号 → 400", r1.status === 400, `got ${r1.status}`);
  const r2 = await drive("POST", "upload/part", {
    body: { uploadId: "ok-id", index: "abc", content: chunkB64(1, 16) },
  });
  check("C10b 非整数序号 → 400", r2.status === 400, `got ${r2.status}`);
}

// C11 小文件直传路径不受分片架构影响（回归）
{
  const r = await drive("POST", "upload", {
    body: { path: "drive/small.txt", content: Buffer.from("tiny").toString("base64") },
  });
  check("C11a 小文件直传 ok", r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  const r2 = await drive("DELETE", "delete", { body: { path: "drive/small.txt" } });
  check("C11b 小文件删除 ok", r2.status === 200, `got ${r2.status}`);
}

// C12 list 缓存隔离：分片写操作后列表缓存失效
{
  await drive("POST", "upload", {
    body: { path: "drive/visible.txt", content: Buffer.from("v").toString("base64") },
  });
  const r1 = await drive("GET", "list");
  check("C12a 上传后列表立即可见", (r1.json.files || []).some((f) => f.name === "visible.txt"), JSON.stringify(r1.json.files));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
