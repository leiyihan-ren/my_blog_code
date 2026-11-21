// ============================================================
// v23.0.1 步骤 34：图片 URL 指纹化（?v=<blob sha>）端到端验证
//   V1 相册照片/缩略图 URL 携带 ?v=<sha>（原图用自身 sha，缩略图优先自身 sha）
//   V2 【DoD 核心】替换图片（blob sha 变化）后，经云盘写操作联动失效
//      （KV gh_ 前缀 + gh-proxy 命名缓存 + API 边缘条目），刷新
//      /api/album/photos 立即拿到新 URL —— 旧新 URL 仅 ?v= 不同
//   V3 raw 代理 cacheKey 纳入查询串：?v=A 与 ?v=B 各自独立缓存条目；
//      同版本二次请求 HIT 零上游请求；?dl=1 不分裂条目（预览/下载共享）
//   V4 版本化响应 private+immutable 一年；无版本响应 max-age=300 兜底
//   V5 降级列表（无 sha，如 jsDelivr data API）→ URL 不加参数（兜底路径零回归）
//   V6 音乐 file/cover 指纹化；http(s) 外链原样保留不打指纹
// 运行：node tests/step34-image-version.mjs
// ============================================================
import http from "node:http";
import worker from "./_helpers.mjs";

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

const SITE = "http://127.0.0.1:9934";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000a49444154789c6300010000050001" +
  "0d0a2db40000000049454e44ae426082", "hex");

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_A2 = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
const SHA_THUMB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_SONG = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_COVER = "dddddddddddddddddddddddddddddddddddddddd";

/* ---------- 可变 mock 状态 ---------- */
const ghState = {
  coverSha: SHA_A,       // 被「替换」的照片：V2 中改为 SHA_A2
  withSha: true,         // V5 切到 false：列表条目无 sha（jsDelivr 降级形态）
  rawHits: 0,            // raw 上游命中计数（V3 用）
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
      store.set(typeof r === "string" ? r : r.url, { body: await resp.arrayBuffer(), headers: [...resp.headers], status: resp.status });
    },
    async delete(r) { return store.delete(typeof r === "string" ? r : r.url); },
    async keys() { return [...store.keys()].map((u) => new Request(u)); },
  };
  return { default: obj, async open() { return obj; }, __store: store };
}
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { return m.delete(k); },
    async list({ prefix, limit }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys: keys.slice(0, limit || 1000), list_complete: true };
    },
    __map: m,
  };
}

const SITE_SEED = JSON.stringify({
  title: "指纹化测试站", autoMode: true,
  githubRepo: "testowner/testrepo", githubBranch: "main",
  githubAlbumPath: "photos", githubMusicPath: "music",
  githubMusicListFile: "music.json", useCdn: false,
});

/* ---------- Mock GitHub 上游 ---------- */
const photoDir = () => ([
  { name: "cover.jpg", type: "file", size: 1024, ...(ghState.withSha ? { sha: ghState.coverSha } : {}) },
  { name: "thumbs", type: "dir", size: 0 },
]);
const thumbDir = () => ([
  { name: "cover.jpg", type: "file", size: 512, ...(ghState.withSha ? { sha: SHA_THUMB } : {}) },
]);
const musicDir = () => ([
  { name: "song.mp3", type: "file", size: 4096, sha: SHA_SONG },
  { name: "cover.jpg", type: "file", size: 2048, sha: SHA_COVER },
]);
const MUSIC_JSON = JSON.stringify([
  { id: "m1", title: "仓库歌曲", file: "song.mp3", coverFile: "cover.jpg" },
  { id: "m2", title: "外链歌曲", url: "https://example.com/ext.mp3", cover: "https://example.com/ext.jpg" },
]);

const rl = { "X-RateLimit-Remaining": "4999", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) };
const ghServer = http.createServer((req, res) => {
  const j = (obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", ...rl }); res.end(JSON.stringify(obj)); };
  const nf = () => j({ message: "Not Found" }, 404);
  const url = new URL(req.url, "http://gh.local");
  if (url.pathname === "/github/repos/testowner/testrepo/contents/photos") return j(photoDir());
  if (url.pathname === "/github/repos/testowner/testrepo/contents/photos/thumbs") return j(thumbDir());
  if (url.pathname === "/github/repos/testowner/testrepo/contents/music") return j(musicDir());
  if (url.pathname === "/raw/testowner/testrepo/main/music.json") {
    res.writeHead(200, { "Content-Type": "application/json", ...rl }); return res.end(MUSIC_JSON);
  }
  if (url.pathname.startsWith("/raw/")) {
    ghState.rawHits += 1;
    res.writeHead(200, { "Content-Type": "image/png", "ETag": '"w-etag"', ...rl });
    return res.end(PNG);
  }
  // 云盘写（CONFIG.drive.repo = leiyihan-ren/Blog）
  if (url.pathname === "/github/repos/leiyihan-ren/Blog/contents/drive/test.txt") {
    if (req.method === "GET") return nf();
    if (req.method === "PUT") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => j({ content: { sha: "f" + "0".repeat(39) }, commit: { sha: "c" + "0".repeat(39) } }));
      return;
    }
  }
  return nf();
});
await new Promise((r) => ghServer.listen(0, "127.0.0.1", r));
const GH_ORIGIN = `http://127.0.0.1:${ghServer.address().port}`;

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

// V1/V2 全程共用一个 KV（跨请求持久），才能证明「替换 + 联动失效」链路
const sharedKV = makeKV({ site: SITE_SEED });
const env = { SITE_DATA: sharedKV, GITHUB_TOKEN: "ghp_s34", DRIVE_PIN: "s34pin" };
const deferred = [];
const ctx = { waitUntil: (p) => deferred.push(Promise.resolve(p).catch(() => {})) };
const drain = async () => { const list = deferred.splice(0); await Promise.allSettled(list); };
const call = async (path, init) => {
  const r = await worker.fetch(new Request(SITE + path, init), env, ctx);
  await r.arrayBuffer(); // 消费 body，防止流未关闭
  await drain();
  return r;
};

console.log("\n═══ V1 相册 URL 指纹化（照片/缩略图各用自身 blob sha） ═══");
{
  const r = await call("/api/album/photos");
  const data = await r.clone ? await (await worker.fetch(new Request(SITE + "/api/album/photos"), env, ctx)).json() : null;
  const photos = data.photos || [];
  const cover = photos.find((p) => p.name === "cover.jpg");
  check("照片首镜像携带 ?v=<原图 sha>", !!cover && cover.mirrors[0] === `/api/github/raw/testowner/testrepo/main/photos/cover.jpg?v=${SHA_A}`, cover && cover.mirrors[0]);
  check("CDN 镜像同样打指纹", !!cover && cover.mirrors[1] === `https://cdn.jsdelivr.net/gh/testowner/testrepo@main/photos/cover.jpg?v=${SHA_A}`, cover && cover.mirrors[1]);
  check("缩略图优先用自身 sha（与原图指纹独立）", !!cover && cover.thumbs[0] === `/api/github/raw/testowner/testrepo/main/photos/thumbs/cover.jpg?v=${SHA_THUMB}`, cover && cover.thumbs[0]);
}

console.log("\n═══ V2 【DoD】替换图片 → 云盘写联动失效 → 刷新即见新 URL ═══");
{
  // KV 里应已有 gh_ 列表缓存（V1 写入）
  const ghBefore = [...sharedKV.__map.keys()].filter((k) => k.startsWith("gh_")).length;
  check("替换前：KV 已有 gh_ 列表缓存", ghBefore > 0, `gh_ keys=${ghBefore}`);

  // 模拟替换：cover.jpg 的 blob sha 变化
  ghState.coverSha = SHA_A2;

  // 不做任何清缓存动作直接刷新 → 旧 URL（KV 300s 新鲜期内）
  const stale = await call("/api/album/photos");
  const staleData = JSON.parse(await (await worker.fetch(new Request(SITE + "/api/album/photos"), env, ctx)).text());
  check("未失效前刷新：仍是旧 URL（缓存新鲜期内，证明确实存在缓存）",
    staleData.photos.find((p) => p.name === "cover.jpg").mirrors[0].endsWith(`?v=${SHA_A}`),
    staleData.photos.find((p) => p.name === "cover.jpg").mirrors[0]);

  // 云盘写操作（drive upload）→ 触发联动失效（KV gh_ + 命名缓存 + API 边缘）
  const up = await call("/api/drive/upload", {
    method: "POST",
    headers: { "content-type": "application/json", "x-drive-pin": "s34pin" },
    body: JSON.stringify({ path: "drive/test.txt", content: Buffer.from("hello").toString("base64"), message: "v23.0.1 test" }),
  });
  check("云盘写成功（200）", up.status === 200, `status=${up.status}`);
  const ghAfter = [...sharedKV.__map.keys()].filter((k) => k.startsWith("gh_")).length;
  check("写成功后：KV gh_ 前缀被联动清空", ghAfter === 0, `gh_ keys=${ghAfter}`);

  // 刷新 → 新 URL（新 sha）
  const fresh = await call("/api/album/photos");
  const freshData = JSON.parse(await (await worker.fetch(new Request(SITE + "/api/album/photos"), env, ctx)).text());
  const freshUrl = freshData.photos.find((p) => p.name === "cover.jpg").mirrors[0];
  check("刷新后：URL 自动变为新指纹", freshUrl.endsWith(`?v=${SHA_A2}`), freshUrl);
  check("旧新 URL 仅 ?v= 不同（路径稳定，缓存按版本隔离）",
    freshUrl.replace(`?v=${SHA_A2}`, "") === `/api/github/raw/testowner/testrepo/main/photos/cover.jpg`, freshUrl);
}

console.log("\n═══ V3 raw 代理 cacheKey 纳入查询串（双版本独立条目） ═══");
{
  // 先清命名缓存与上游计数
  await cachesMock.default.keys().then((ks) => Promise.all(ks.map((k) => cachesMock.default.delete(k))));
  ghState.rawHits = 0;
  const base = "/api/github/raw/testowner/testrepo/main/photos/x.jpg";

  const rA1 = await call(`${base}?v=${SHA_A}`);
  const rA2 = await call(`${base}?v=${SHA_A}`);
  const rB1 = await call(`${base}?v=${SHA_A2}`);
  const rB2 = await call(`${base}?v=${SHA_A2}`);
  const rDl = await call(`${base}?v=${SHA_A}&dl=1`);
  check("v=A 首次 MISS、二次 HIT", rA1.headers.get("x-cache") === "MISS" && rA2.headers.get("x-cache") === "HIT",
    `${rA1.headers.get("x-cache")}/${rA2.headers.get("x-cache")}`);
  check("v=B 首次 MISS、二次 HIT（与 v=A 互不串台）", rB1.headers.get("x-cache") === "MISS" && rB2.headers.get("x-cache") === "HIT",
    `${rB1.headers.get("x-cache")}/${rB2.headers.get("x-cache")}`);
  check("上游仅被拉取 2 次（每个版本一次）", ghState.rawHits === 2, `rawHits=${ghState.rawHits}`);
  check("?dl=1 命中同版本条目（不分裂缓存）", rDl.headers.get("x-cache") === "HIT" &&
    (rDl.headers.get("content-disposition") || "").includes("attachment"),
    `x-cache=${rDl.headers.get("x-cache")}`);
  const keyUrls = (await cachesMock.default.keys()).map((k) => k.url);
  check("命名缓存中 v=A / v=B 两条目并存（key 含查询串）",
    keyUrls.some((u) => u.includes(`?v=${SHA_A}`)) && keyUrls.some((u) => u.includes(`?v=${SHA_A2}`)),
    keyUrls.filter((u) => u.includes("x.jpg")).join(" | "));
}

console.log("\n═══ V4 响应头分级（版本化 immutable / 无版本 300s 兜底） ═══");
{
  const rv = await call(`/api/github/raw/testowner/testrepo/main/photos/y.jpg?v=${SHA_THUMB}`);
  const ccV = rv.headers.get("cache-control") || "";
  check("带 ?v=：private + max-age=31536000 + immutable",
    ccV.includes("private") && ccV.includes("max-age=31536000") && ccV.includes("immutable"), ccV);
  const rn = await call("/api/github/raw/testowner/testrepo/main/photos/y.jpg");
  const ccN = rn.headers.get("cache-control") || "";
  check("不带 ?v=：public + max-age=300 兜底", ccN.includes("public") && ccN.includes("max-age=300"), ccN);
}

console.log("\n═══ V5 降级列表（无 sha）→ URL 不加参数 ═══");
{
  ghState.withSha = false;
  // 重新播种 KV（清掉上一轮缓存，模拟全新环境）
  const freshKV = makeKV({ site: SITE_SEED });
  env.SITE_DATA = freshKV;
  const r = await worker.fetch(new Request(SITE + "/api/album/photos"), env, ctx);
  await drain();
  const data = await r.json();
  const cover = data.photos.find((p) => p.name === "cover.jpg");
  check("无 sha 时 URL 保持原样（不加 ?v=）",
    !!cover && cover.mirrors[0] === "/api/github/raw/testowner/testrepo/main/photos/cover.jpg", cover && cover.mirrors[0]);
  check("无 sha 时缩略图 URL 同样原样",
    !!cover && cover.thumbs[0] === "/api/github/raw/testowner/testrepo/main/photos/thumbs/cover.jpg", cover && cover.thumbs[0]);
  env.SITE_DATA = sharedKV;
}

console.log("\n═══ V6 音乐 file/cover 指纹化（外链原样） ═══");
{
  // 音乐走 KV 缓存，直接清空保证从 mock 拉取
  for (const k of [...sharedKV.__map.keys()]) if (k.startsWith("gh_")) sharedKV.__map.delete(k);
  const r = await worker.fetch(new Request(SITE + "/api/music"), env, ctx);
  await drain();
  const data = await r.json();
  const list = Array.isArray(data) ? data : data.music || [];
  const m1 = list.find((m) => m.id === "m1");
  const m2 = list.find((m) => m.id === "m2");
  check("仓库歌曲 url 打上音频 sha 指纹",
    !!m1 && m1.url === `/api/github/raw/testowner/testrepo/main/music/song.mp3?v=${SHA_SONG}`, m1 && m1.url);
  check("coverFile 打上封面 sha 指纹",
    !!m1 && m1.cover === `/api/github/raw/testowner/testrepo/main/music/cover.jpg?v=${SHA_COVER}`, m1 && m1.cover);
  check("外链歌曲 url/cover 原样保留（不注入指纹）",
    !!m2 && m2.url === "https://example.com/ext.mp3" && m2.cover === "https://example.com/ext.jpg",
    JSON.stringify(m2 && { url: m2.url, cover: m2.cover }));
}

console.log(`\n════════════════════════════════════`);
console.log(`v23.0.1 步骤34 图片指纹化: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
process.exit(fail ? 1 : 0);
