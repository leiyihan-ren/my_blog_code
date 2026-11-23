// ============================================================
// v23.1 步骤 35：图片内容哈希 KV 元数据（事项1）端到端验证
//   V1 图片上传（云盘小文件直传）→ KV 元数据即时写入 path→blob sha；
//      非图片文件不写元数据
//   V2 【DoD 核心】gh_ 列表缓存仍新鲜（旧 sha）时，渲染侧按「时间戳新者胜」
//      用元数据 sha 修正指纹 —— 替换完成即刻拿到新 URL，不被 immutable 钉死旧图
//   V3 时间戳仲裁边界：列表比元数据新 → 列表胜；元数据超信任窗口 → 列表胜
//   V4 代理写分支（/api/github/api/* contents PUT）图片替换 → 元数据写入
//      + v23.0.1 同款联动失效（gh_ 前缀清空）
//   V5 音乐封面同理：元数据新于列表 → /api/music 封面立即携带新指纹
//   V6 云盘写路径响应 sha 缺失 → 本地按 git blob 格式（"blob <len>\0"+内容）
//      计算 SHA-1 兜底，与 GitHub 算法一致
// 运行：node tests/step35-v231-sha-metadata.mjs
// ============================================================
import http from "node:http";
import crypto from "node:crypto";
import worker from "./_helpers.mjs";

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

const SITE = "http://127.0.0.1:9935";
const REPO = "testowner/testrepo";
const BRANCH = "main";
/** 云盘写仓库（CONFIG.drive.repo）——与相册站仓库不同，元数据键按各自仓库组织 */
const DRIVE_REPO = "leiyihan-ren/Blog";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_A2 = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
const SHA_COVER2 = "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
const SHA_COVER3 = "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3";

/** 与 _worker.js safeKvKey 同规则（[^a-zA-Z0-9_.:-] → _，连续 _ 折叠） */
const k = (s, max) => String(s).replace(/[^a-zA-Z0-9_.:-]/g, "_").replace(/_+/g, "_").slice(0, max || 500);
const shaMetaKey = (repo, dir) => `ghsha_${k(repo, 200)}_${k(BRANCH, 100)}_${k(dir, 200)}`;
const ghListKey = (path) => `gh_cache_${k(REPO, 200)}_${k(BRANCH, 100)}_${k(path, 200)}_raw`;
/** 与 _worker.js gitBlobShaFromBase64 同算法：sha1("blob <len>\0" + 内容) */
const expectedBlobSha = (buf) =>
  crypto.createHash("sha1").update(Buffer.concat([
    Buffer.from(`blob ${buf.byteLength}\0`), buf,
  ])).digest("hex");

/* ---------- 可变 mock 状态 ---------- */
const ghState = {
  drivePutWithSha: true,  // PUT 响应是否携带 content.sha（V6 切 false 走本地计算兜底）
  coverSha: SHA_A,        // photos/cover.jpg 的「最新 blob sha」
};

/* ---------- Mock Cache API / KV ---------- */
function makeCaches() {
  const store = new Map();
  const obj = {
    async match(r) {
      const e = store.get(typeof r === "string" ? r : r.url);
      return e ? new Response(e.body, { status: e.status, headers: new Headers(e.headers) }) : undefined;
    },
    async put(r, resp) {
      const url = typeof r === "string" ? r : r.url;
      const h = {};
      resp.headers.forEach((v, key) => { h[key] = v; });
      store.set(url, { status: resp.status, headers: h, body: await resp.clone().arrayBuffer() });
    },
    async delete(r) { return store.delete(typeof r === "string" ? r : r.url); },
    async keys() { return [...store.keys()].map((u) => new Request(u)); },
  };
  return { default: obj, __map: store };
}
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

const SITE_SEED = JSON.stringify({
  title: "哈希元数据测试站", autoMode: true,
  githubRepo: REPO, githubBranch: BRANCH,
  githubAlbumPath: "photos", githubMusicPath: "music",
  githubMusicListFile: "music.json", useCdn: false,
});

/* ---------- Mock GitHub 上游 ---------- */
const j = (obj, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
let res = null; // 当前请求的响应句柄（server 回调里赋值）

/** 云盘 PUT（driveSaveFile）固定响应：GitHub Contents API 形态 */
function drivePutResp(withSha, content) {
  const body = {
    commit: { sha: "c" + "0".repeat(39) },
    ...(withSha ? { content: { sha: "f" + "0".repeat(39), size: content.length } } : { content: { size: content.length } }),
  };
  return body;
}

const ghServer = http.createServer((req, res0) => {
  res = res0;
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    // 代理写分支：photos/cover.jpg 的 PUT（替换图片）
    if (req.method === "PUT" && p === `/github/repos/${REPO}/contents/photos/cover.jpg`) {
      const b = JSON.parse(body || "{}");
      const bytes = Buffer.from(b.content || "", "base64");
      // GitHub 语义：新 blob sha 只与内容有关（V4 里前端替换内容 → sha 相应变化）
      const blobSha = bytes.length ? expectedBlobSha(bytes) : SHA_A2;
      return j({ content: { sha: blobSha, path: "photos/cover.jpg" }, commit: { sha: "c" + "0".repeat(39) } });
    }
    // 云盘直传（driveSaveFile）
    if (req.method === "PUT" && p === `/github/repos/${DRIVE_REPO}/contents/drive/pic.jpg`) {
      const b = JSON.parse(body || "{}");
      return j(drivePutResp(ghState.drivePutWithSha, Buffer.from(b.content || "", "base64")));
    }
    // 云盘直传：非图片（V1 反例）
    if (req.method === "PUT" && p === `/github/repos/${DRIVE_REPO}/contents/drive/notes.txt`) {
      const b = JSON.parse(body || "{}");
      return j(drivePutResp(ghState.drivePutWithSha, Buffer.from(b.content || "", "base64")));
    }
    // 目录列表（contents 目录形态，getDirectory）：photos / thumbs / music
    if (req.method === "GET" && p === `/github/repos/${REPO}/contents/photos`) {
      return j([
        { name: "cover.jpg", type: "file", size: 1024, sha: ghState.coverSha },
        { name: "thumbs", type: "dir", size: 0 },
      ]);
    }
    if (req.method === "GET" && p === `/github/repos/${REPO}/contents/photos/thumbs`) {
      return j([
        { name: "cover.jpg", type: "file", size: 512, sha: SHA_A2 },
      ]);
    }
    if (req.method === "GET" && p === `/github/repos/${REPO}/contents/music`) {
      return j([
        { name: "song.mp3", type: "file", size: 4096, sha: SHA_A },
        { name: "cover.jpg", type: "file", size: 2048, sha: SHA_COVER2 },
      ]);
    }
    // music.json 列表文件（raw 形态，githubFetchRaw）
    if (req.method === "GET" && p === `/raw/${REPO}/main/music.json`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([{ id: "m1", title: "t", file: "song.mp3", coverFile: "cover.jpg" }]));
    }
    return j({ message: "Not Found" }, 404);
  });
});
await new Promise((r) => ghServer.listen(0, "127.0.0.1", r));
const GH_ORIGIN = `http://127.0.0.1:${ghServer.address().port}`;

/* ---------- fetch 重定向到 mock + Cache API mock ---------- */
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const map = [
    ["https://api.github.com", GH_ORIGIN + "/github"],
    ["https://raw.githubusercontent.com", GH_ORIGIN + "/raw"],
  ];
  for (const [from, to] of map) if (url.startsWith(from + "/")) return realFetch(url.replace(from, to), init);
  return realFetch(input, init);
};
const cachesMock = makeCaches();
globalThis.caches = cachesMock;

/* ---------- 请求辅助 ---------- */
const deferred = [];
const ctx = { waitUntil: (p) => deferred.push(Promise.resolve(p).catch(() => {})) };
const drain = async () => { const list = deferred.splice(0); await Promise.allSettled(list); };
const call = async (env, path, init) => {
  const r = await worker.fetch(new Request(SITE + path, init), env, ctx);
  await r.arrayBuffer(); // 消费 body，防止流未关闭
  await drain();
  return r;
};
const getJson = async (env, path) =>
  JSON.parse(await (await worker.fetch(new Request(SITE + path), env, ctx)).text());

const makeEnv = () => {
  const kv = makeKV({ site: SITE_SEED });
  return { SITE_DATA: kv, GITHUB_TOKEN: "ghp_s35", DRIVE_PIN: "s35pin" };
};

console.log("\n═══ V1 图片直传 → KV 元数据即时写入（非图片不写） ═══");
{
  const env = makeEnv();
  const content = Buffer.from("fake jpg bytes");
  const r = await call(env, "/api/drive/upload", {
    method: "POST",
    headers: { "content-type": "application/json", "x-drive-pin": "s35pin" },
    body: JSON.stringify({ path: "drive/pic.jpg", content: content.toString("base64"), message: "v23.1 test" }),
  });
  check("云盘图片直传成功（200）", r.status === 200, `status=${r.status}`);
  const meta = JSON.parse(env.SITE_DATA.__map.get(shaMetaKey(DRIVE_REPO, "drive")) || "null");
  check("KV 元数据已写入（ghsha_ 前缀）", !!meta && !!meta.shas,
    [...env.SITE_DATA.__map.keys()].filter((x) => x.startsWith("ghsha_")).join(","));
  check("元数据记录 GitHub 返回的 blob sha",
    !!meta && meta.shas["drive/pic.jpg"]?.sha === "f" + "0".repeat(39),
    JSON.stringify(meta && meta.shas));
  check("元数据带时间戳", !!meta && typeof meta.shas["drive/pic.jpg"]?.ts === "number");
  check("元数据键按顶层目录组织（ghsha_<repo>_<branch>_<dir>）",
    [...env.SITE_DATA.__map.keys()].filter((x) => x.startsWith("ghsha_")).every((x) => x === shaMetaKey(DRIVE_REPO, "drive")));

  const r2 = await call(env, "/api/drive/upload", {
    method: "POST",
    headers: { "content-type": "application/json", "x-drive-pin": "s35pin" },
    body: JSON.stringify({ path: "drive/notes.txt", content: Buffer.from("hello").toString("base64") }),
  });
  check("非图片上传成功（200）", r2.status === 200, `status=${r2.status}`);
  const meta2 = JSON.parse(env.SITE_DATA.__map.get(shaMetaKey(DRIVE_REPO, "drive")) || "{}");
  check("非图片不写入元数据", !meta2.shas?.["drive/notes.txt"], JSON.stringify(meta2.shas || {}));
}

console.log("\n═══ V2 【DoD】列表缓存新鲜但 sha 旧 → 元数据新者胜 → 新指纹 ═══");
cachesMock.__map.clear(); // 清上一块的边缘缓存，避免跨块串台
{
  const env = makeEnv();
  const now = Date.now();
  // 手工种下「新鲜但旧 sha」的 gh_ 列表缓存（time = 20s 前，TTL 300s 内 → 新鲜）
  env.SITE_DATA.__map.set(ghListKey("photos"), JSON.stringify({
    time: now - 20000,
    content: [
      { name: "cover.jpg", type: "file", size: 1024, sha: SHA_A },
      { name: "thumbs", type: "dir", size: 0 },
    ],
    etag: "",
  }));
  // 元数据：替换后写入的新 sha（ts = 10s 前，比列表抓取时间新）
  env.SITE_DATA.__map.set(shaMetaKey(REPO, "photos"), JSON.stringify({
    v: 1,
    shas: { "photos/cover.jpg": { sha: SHA_A2, ts: now - 10000 } },
  }));
  await call(env, "/api/album/photos");
  const d2 = await getJson(env, "/api/album/photos");
  const url2 = d2.photos.find((p) => p.name === "cover.jpg").mirrors[0];
  check("列表缓存新鲜（旧 sha）时仍立即给出新指纹", url2.endsWith(`?v=${SHA_A2}`), url2);
  check("旧新 URL 仅 ?v= 不同（路径稳定）", url2.startsWith("/api/github/raw/testowner/testrepo/main/photos/cover.jpg?v="), url2);
  const thumbUrl = d2.photos.find((p) => p.name === "cover.jpg").thumbs[0];
  check("缩略图不受元数据影响（thumbs 列表 sha 正常）", thumbUrl.endsWith(`?v=${SHA_A2}`), thumbUrl);
}

console.log("\n═══ V3 时间戳仲裁边界（列表新 → 列表胜；超信任窗 → 列表胜） ═══");
cachesMock.__map.clear();
{
  // a) 列表抓取时间比元数据新（列表已反映最新仓库状态）
  const envA = makeEnv();
  const now = Date.now();
  envA.SITE_DATA.__map.set(ghListKey("photos"), JSON.stringify({
    time: now - 5000,
    content: [{ name: "cover.jpg", type: "file", size: 1024, sha: SHA_A2 }, { name: "thumbs", type: "dir", size: 0 }],
    etag: "",
  }));
  envA.SITE_DATA.__map.set(shaMetaKey(REPO, "photos"), JSON.stringify({
    v: 1, shas: { "photos/cover.jpg": { sha: SHA_A, ts: now - 60000 } },
  }));
  await call(envA, "/api/album/photos");
  const aData = await getJson(envA, "/api/album/photos");
  check("列表比元数据新：用列表 sha（元数据不反杀）",
    aData.photos.find((p) => p.name === "cover.jpg").mirrors[0].endsWith(`?v=${SHA_A2}`),
    aData.photos.find((p) => p.name === "cover.jpg").mirrors[0]);

  // b) 元数据超出信任窗口（15min）：即使 ts 比列表新也不采纳
  const envB = makeEnv();
  envB.SITE_DATA.__map.set(ghListKey("photos"), JSON.stringify({
    time: now - 20 * 60 * 1000,
    content: [{ name: "cover.jpg", type: "file", size: 1024, sha: SHA_A2 }, { name: "thumbs", type: "dir", size: 0 }],
    etag: "",
  }));
  envB.SITE_DATA.__map.set(shaMetaKey(REPO, "photos"), JSON.stringify({
    v: 1, shas: { "photos/cover.jpg": { sha: SHA_A, ts: now - 16 * 60 * 1000 } },
  }));
  await call(envB, "/api/album/photos");
  const bData = await getJson(envB, "/api/album/photos");
  check("元数据超信任窗口：信列表（不把旧 sha 反杀成指纹）",
    bData.photos.find((p) => p.name === "cover.jpg").mirrors[0].endsWith(`?v=${SHA_A2}`),
    bData.photos.find((p) => p.name === "cover.jpg").mirrors[0]);
}

console.log("\n═══ V4 代理写分支：图片 PUT → 元数据写入 + gh_ 联动失效 ═══");
cachesMock.__map.clear();
{
  const env = makeEnv();
  await call(env, "/api/album/photos"); // 预热：写入 gh_ 列表缓存（旧 sha SHA_A）
  const ghBefore = [...env.SITE_DATA.__map.keys()].filter((x) => x.startsWith("gh_")).length;
  check("替换前：KV 已有 gh_ 列表缓存", ghBefore > 0, `gh_ keys=${ghBefore}`);

  // 经代理写分支替换图片（新内容 → 新 blob sha）
  const put = await call(env, `/api/github/api/repos/${REPO}/contents/photos/cover.jpg`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-drive-pin": "s35pin" },
    body: JSON.stringify({
      content: Buffer.from("replaced bytes").toString("base64"),
      branch: BRANCH, message: "v23.1 replace",
    }),
  });
  check("代理写分支 PUT 成功（200）", put.status === 200, `status=${put.status}`);

  const meta = JSON.parse(env.SITE_DATA.__map.get(shaMetaKey(REPO, "photos")) || "null");
  const expectedSha = expectedBlobSha(Buffer.from("replaced bytes"));
  check("代理写分支：新 blob sha 已写入 KV 元数据",
    !!meta && meta.shas["photos/cover.jpg"]?.sha === expectedSha,
    `got=${meta && meta.shas["photos/cover.jpg"]?.sha}`);
  const ghAfter = [...env.SITE_DATA.__map.keys()].filter((x) => x.startsWith("gh_")).length;
  check("v23.0.1 同款联动失效：gh_ 前缀已清空", ghAfter === 0, `gh_ keys=${ghAfter}`);

  // 刷新列表（缓存已失效 → 重新拉取，mock 返回新 sha SHA_A2）→ 立即新指纹
  ghState.coverSha = SHA_A2;
  await call(env, "/api/album/photos");
  const d = await getJson(env, "/api/album/photos");
  const url = d.photos.find((p) => p.name === "cover.jpg").mirrors[0];
  check("刷新即见新 URL（与 v23.0.1 行为一致）", url.endsWith(`?v=${SHA_A2}`), url);
}

console.log("\n═══ V5 音乐封面同理：元数据新于列表 → 新指纹 ═══");
cachesMock.__map.clear();
{
  const env = makeEnv();
  const now = Date.now();
  env.SITE_DATA.__map.set(ghListKey("music"), JSON.stringify({
    time: now - 20000,
    content: [
      { name: "song.mp3", type: "file", size: 4096, sha: SHA_A },
      { name: "cover.jpg", type: "file", size: 2048, sha: SHA_COVER2 },
    ],
    etag: "",
  }));
  env.SITE_DATA.__map.set(shaMetaKey(REPO, "music"), JSON.stringify({
    v: 1, shas: { "music/cover.jpg": { sha: SHA_COVER3, ts: now - 10000 } },
  }));
  await call(env, "/api/music");
  const dData = await getJson(env, "/api/music");
  const cover = dData.find((m) => m.id === "m1")?.cover || "";
  check("封面立即携带替换后的新指纹", cover.endsWith(`?v=${SHA_COVER3}`), cover);
  const songUrl = dData.find((m) => m.id === "m1")?.url || "";
  check("歌曲文件不受图片元数据影响（列表 sha）", songUrl.endsWith(`?v=${SHA_A}`), songUrl);
}

console.log("\n═══ V6 响应缺 sha → 本地按 git blob 格式计算兜底 ═══");
{
  const env = makeEnv();
  const content = Buffer.from("fallback sha bytes");
  ghState.drivePutWithSha = false; // PUT 响应不带 content.sha
  const r = await call(env, "/api/drive/upload", {
    method: "POST",
    headers: { "content-type": "application/json", "x-drive-pin": "s35pin" },
    body: JSON.stringify({ path: "drive/pic.jpg", content: content.toString("base64") }),
  });
  check("上传成功（200）", r.status === 200, `status=${r.status}`);
  const meta = JSON.parse(env.SITE_DATA.__map.get(shaMetaKey(DRIVE_REPO, "drive")) || "null");
  const expected = expectedBlobSha(content);
  check("本地计算 sha1(\"blob <len>\\0\"+内容) 写入元数据，与 GitHub 算法一致",
    !!meta && meta.shas["drive/pic.jpg"]?.sha === expected,
    `got=${meta && meta.shas["drive/pic.jpg"]?.sha} want=${expected}`);
  ghState.drivePutWithSha = true;
}

ghServer.close();
globalThis.fetch = realFetch;
console.log(`\n════════════════════════════════════
v23.1 步骤35 图片哈希元数据: ${pass} 通过 / ${fail} 失败
════════════════════════════════════`);
if (fail) {
  console.error("未通过项:\n" + findings.map((s) => "  - " + s).join("\n"));
  process.exit(1);
}
