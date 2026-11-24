// ============================================================
// v23.1 步骤 36：后台操作日志（事项2）端到端验证
//   V1 管理员发文成功 → KV oplog_recent 记录 { t, op, obj }
//   V2 /api/oplogs 鉴权：未授权 401、错误口令 401、正确口令 200
//   V3 最新在前 + 失败写不记录（错口令发文不产生日志）
//   V4 【DoD】上限 50 条截断：预置 55 条旧日志 + 1 次新写 → 恰好 50 条、最旧被淘汰
//   V5 云盘写操作记录（upload）；分片 upload/part 不记录（避免刷屏）
//   V6 GitHub 代理写方法（PUT contents）记录：op=方法+路径，obj=repo/branch/path
//   V7 查询参数边界：n=2 截取、n=999 钳到上限 50
// 运行：node tests/step36-v231-oplog.mjs
// ============================================================
import http from "node:http";
import worker from "./_helpers.mjs";

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

const SITE = "http://127.0.0.1:9936";
const REPO = "testowner/testrepo";
const BRANCH = "main";
/** 云盘写仓库（CONFIG.drive.repo） */
const DRIVE_REPO = "leiyihan-ren/Blog";

const ADMIN_PWD = "oplog-test-pwd";
const DRIVE_PIN = "oplog-pin";
const AUTH = { Authorization: `Bearer ${ADMIN_PWD}` };
const OPLOG_KEY = "oplog_recent";

/* ---------- Mock KV / Cache API ---------- */
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    async get(key) { return m.has(key) ? m.get(key) : null; },
    async put(key, value) { m.set(key, String(value)); },
    async delete(key) { return m.delete(key); },
    async list({ prefix, limit }) {
      const keys = [...m.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name }));
      return { keys: keys.slice(0, limit || 1000), list_complete: true };
    },
    __map: m,
  };
}
function makeCaches() {
  const store = new Map();
  return {
    default: {
      async match(r) { const e = store.get(typeof r === "string" ? r : r.url); return e ? new Response(e.body, { status: e.status, headers: new Headers(e.headers) }) : undefined; },
      async put(r, resp) { const u = typeof r === "string" ? r : r.url; store.set(u, { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: await resp.clone().arrayBuffer() }); },
      async delete(r) { return store.delete(typeof r === "string" ? r : r.url); },
      async keys() { return [...store.keys()].map((u) => new Request(u)); },
    },
    __map: store,
  };
}

/* ---------- Mock GitHub 上游（写路径只需 PUT 通用应答） ---------- */
const ghServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method === "PUT" && url.pathname.startsWith(`/github/repos/${DRIVE_REPO}/contents/`)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ commit: { sha: "c" + "0".repeat(39) }, content: { sha: "f" + "0".repeat(39), size: 1 } }));
    }
    if (req.method === "PUT" && url.pathname.startsWith(`/github/repos/${REPO}/contents/`)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ commit: { sha: "c" + "0".repeat(39) }, content: { sha: "a" + "0".repeat(39), path: "photos/x.jpg" } }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });
});
await new Promise((r) => ghServer.listen(0, "127.0.0.1", r));
const GH_ORIGIN = `http://127.0.0.1:${ghServer.address().port}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://api.github.com/")) return realFetch(url.replace("https://api.github.com/", GH_ORIGIN + "/github/"), init);
  if (url.startsWith("https://raw.githubusercontent.com/")) return realFetch(url.replace("https://raw.githubusercontent.com/", GH_ORIGIN + "/raw/"), init);
  return realFetch(input, init);
};
globalThis.caches = makeCaches();

/* ---------- 请求辅助 ---------- */
const deferred = [];
const ctx = { waitUntil: (p) => deferred.push(Promise.resolve(p).catch(() => {})) };
const drain = async () => { const list = deferred.splice(0); await Promise.allSettled(list); };
const makeEnv = () => ({ SITE_DATA: makeKV(), GITHUB_TOKEN: "ghp_s36", ADMIN_PASSWORD: ADMIN_PWD, DRIVE_PIN });

const call = async (env, path, init = {}) => {
  const r = await worker.fetch(new Request(SITE + path, init), env, ctx);
  const text = await r.text();
  await drain();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json, headers: r.headers, text };
};
const getOplogs = async (env, query = "") =>
  call(env, `/api/oplogs${query}`, { headers: AUTH });
const oplogOf = (env) => JSON.parse(env.SITE_DATA.__map.get(OPLOG_KEY) || "[]");

const seedSite = JSON.stringify({ title: "操作日志测试站", autoMode: false });

/* ================= V1 管理员发文成功 → 记录 { t, op, obj } ================= */
console.log("\n═══ V1 管理员发文成功 → KV 记录 { t, op, obj } ═══");
{
  const env = makeEnv();
  env.SITE_DATA.__map.set("site", seedSite);
  const r = await call(env, "/api/posts", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
    body: JSON.stringify({ title: "操作日志第一篇", content: "验证发文写入操作日志。", date: "2026-11-24", desc: "oplog" }),
  });
  check("发文成功（200）", r.status === 200, `status=${r.status} ${r.text && r.text.slice(0, 120)}`);
  const logs = oplogOf(env);
  check("oplog_recent 恰好新增 1 条", logs.length === 1, `len=${logs.length}`);
  const e = logs[0] || {};
  check("条目含 t（ISO 时间）", typeof e.t === "string" && !Number.isNaN(Date.parse(e.t)), e.t);
  check("条目 op=/api/posts", e.op === "/api/posts", e.op);
  check("条目 obj=文章标题", e.obj === "操作日志第一篇", e.obj);
}

/* ================= V2 查询接口鉴权 ================= */
console.log("\n═══ V2 /api/oplogs 鉴权 ═══");
{
  const env = makeEnv();
  const noAuth = await call(env, "/api/oplogs");
  check("未授权查询 → 401", noAuth.status === 401, `status=${noAuth.status}`);
  const badAuth = await call(env, "/api/oplogs", { headers: { Authorization: "Bearer wrong-pwd" } });
  check("错误口令查询 → 401", badAuth.status === 401, `status=${badAuth.status}`);
  const good = await getOplogs(env);
  check("正确口令查询 → 200 且结构完整", good.status === 200 && Array.isArray(good.json?.logs) && good.json.count === 0,
    `status=${good.status} json=${JSON.stringify(good.json)}`);
  check("响应 no-store（防缓存层串台）", (good.headers.get("cache-control") || "").includes("no-store"),
    good.headers.get("cache-control"));
}

/* ================= V3 最新在前 + 失败写不记录 ================= */
console.log("\n═══ V3 最新在前 + 失败写不记录 ═══");
{
  const env = makeEnv();
  env.SITE_DATA.__map.set("site", seedSite);
  await call(env, "/api/posts", {
    method: "POST", headers: { ...AUTH, "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
    body: JSON.stringify({ title: "第一篇", content: "c1", date: "2026-11-24" }),
  });
  const del = await call(env, "/api/post/delete/p-delfail", { method: "POST", headers: { ...AUTH, "CF-Connecting-IP": "1.2.3.4" } });
  check("删除不存在的文章 → 404（业务失败）", del.status === 404, `status=${del.status}`);
  check("失败的写操作不记录日志", oplogOf(env).length === 1, `len=${oplogOf(env).length}`);
  const bad = await call(env, "/api/posts", {
    method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
    body: JSON.stringify({ title: "不该出现的文章", content: "x", date: "2026-11-24" }),
  });
  check("错口令发文 → 401", bad.status === 401, `status=${bad.status}`);
  check("鉴权失败的写不记录日志", oplogOf(env).length === 1, `len=${oplogOf(env).length}`);
  const q = await getOplogs(env);
  check("查询返回 1 条", q.json?.count === 1, `count=${q.json?.count}`);
  check("最新记录是发文操作", q.json?.logs?.[0]?.op === "/api/posts" && q.json?.logs?.[0]?.obj === "第一篇",
    JSON.stringify(q.json?.logs?.[0]));
}

/* ================= V4 【DoD】上限 50 条截断 ================= */
console.log("\n═══ V4 上限 50 条截断：55 条旧日志 + 1 次新写 ═══");
{
  const env = makeEnv();
  env.SITE_DATA.__map.set("site", seedSite);
  // 预置 55 条旧日志（旧在前），第 55 条是最旧的
  const old = Array.from({ length: 55 }, (_, i) => ({
    t: new Date(Date.now() - (60 + i) * 1000).toISOString(),
    op: `/api/old-${i}`,
    obj: `旧条目-${i}`,
  })).reverse(); // unshift 语义：数组头是最新 → 旧数组按时间正序存放后逐条 unshift
  env.SITE_DATA.__map.set(OPLOG_KEY, JSON.stringify(old));
  await call(env, "/api/posts", {
    method: "POST", headers: { ...AUTH, "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
    body: JSON.stringify({ title: "第 56 条", content: "触发截断", date: "2026-11-24" }),
  });
  const logs = oplogOf(env);
  check("KV 内恰好 50 条", logs.length === 50, `len=${logs.length}`);
  check("最新条目在最前", logs[0]?.obj === "第 56 条", JSON.stringify(logs[0]));
  check("最旧的 5 条被淘汰（旧-54 仍在，旧-59 类不存在）",
    logs.some((x) => x.op === "/api/old-54") && !logs.some((x) => x.op === "/api/old-0"),
    `has54=${logs.some((x) => x.op === "/api/old-54")}`);
  const q = await getOplogs(env);
  check("查询默认恰好 50 条", q.json?.count === 50, `count=${q.json?.count}`);
}

/* ================= V5 云盘写操作记录 + 分片不记 ================= */
console.log("\n═══ V5 云盘写操作记录（upload 记 / part 不记） ═══");
{
  const env = makeEnv();
  env.SITE_DATA.__map.set("site", seedSite);
  const part = await call(env, "/api/drive/upload/part", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-drive-pin": DRIVE_PIN },
    body: JSON.stringify({ uploadId: "upid-s36", index: 0, content: Buffer.from("part-bytes").toString("base64") }),
  });
  check("分片上传成功（200）", part.status === 200, `status=${part.status} ${part.text.slice(0, 100)}`);
  check("分片上传不产生操作日志", oplogOf(env).length === 0, `len=${oplogOf(env).length}`);

  const up = await call(env, "/api/drive/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-drive-pin": DRIVE_PIN },
    body: JSON.stringify({ path: "drive/pic-s36.jpg", content: Buffer.from("fake jpg").toString("base64"), message: "oplog test" }),
  });
  check("小文件直传成功（200）", up.status === 200, `status=${up.status} ${up.text.slice(0, 100)}`);
  const logs = oplogOf(env);
  check("直传产生 1 条日志", logs.length === 1, `len=${logs.length}`);
  check("op=/api/drive/upload", logs[0]?.op === "/api/drive/upload", logs[0]?.op);
  check("obj=上传路径", logs[0]?.obj === "drive/pic-s36.jpg", logs[0]?.obj);
}

/* ================= V6 GitHub 代理写记录 ================= */
console.log("\n═══ V6 GitHub 代理写方法（PUT contents）记录 ═══");
{
  const env = makeEnv();
  env.SITE_DATA.__map.set("site", seedSite);
  const r = await call(env, `/api/github/api/repos/${REPO}/contents/photos/x-s36.jpg`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-drive-pin": DRIVE_PIN },
    body: JSON.stringify({ branch: BRANCH, message: "oplog test", content: Buffer.from("img-bytes").toString("base64") }),
  });
  check("代理 PUT 成功（200）", r.status === 200, `status=${r.status} ${r.text.slice(0, 100)}`);
  const logs = oplogOf(env);
  check("代理写产生 1 条日志", logs.length === 1, `len=${logs.length}`);
  check(`op=PUT /api/github/api/repos/...`, typeof logs[0]?.op === "string" && logs[0].op.startsWith("PUT /api/github/api/repos/"), logs[0]?.op);
  check("obj=repo/branch/path", logs[0]?.obj === `${REPO}/${BRANCH}/photos/x-s36.jpg`, logs[0]?.obj);
  const bad = await call(env, `/api/github/api/repos/${REPO}/contents/photos/y.jpg`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-drive-pin": "wrong-pin" },
    body: JSON.stringify({ branch: BRANCH, message: "x", content: "" }),
  });
  check("错误口令的代理写被拒绝", bad.status === 401, `status=${bad.status}`);
  check("被拒绝的写不记录", oplogOf(env).length === 1, `len=${oplogOf(env).length}`);
}

/* ================= V7 查询参数边界 ================= */
console.log("\n═══ V7 查询参数边界 ═══");
{
  const env = makeEnv();
  const logs = Array.from({ length: 50 }, (_, i) => ({
    t: new Date(Date.now() - i * 1000).toISOString(), op: `/api/n-${i}`, obj: `n${i}`,
  }));
  env.SITE_DATA.__map.set(OPLOG_KEY, JSON.stringify(logs));
  const q2 = await getOplogs(env, "?n=2");
  check("n=2 只返回 2 条", q2.json?.count === 2 && q2.json.logs.length === 2, `count=${q2.json?.count}`);
  check("n=2 返回的是最新 2 条", q2.json?.logs?.[0]?.obj === "n0" && q2.json?.logs?.[1]?.obj === "n1",
    JSON.stringify(q2.json?.logs));
  const qBig = await getOplogs(env, "?n=999");
  check("n=999 钳到上限 50", qBig.json?.count === 50, `count=${qBig.json?.count}`);
  const qBad = await getOplogs(env, "?n=abc");
  check("n=非法值回退默认 50", qBad.json?.count === 50, `count=${qBad.json?.count}`);
}

/* ---------- 汇总 ---------- */
console.log(`\n通过 ${pass}/${pass + fail}`);
if (fail > 0) {
  console.log("失败项：\n- " + findings.join("\n- "));
  process.exit(1);
}
console.log("🎉 step36 全部通过");
