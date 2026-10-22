// ============================================================
// v3.0 步骤 6：边缘缓存回归（DevOps 3.1 配套）
//   背景：生产环境 gh-proxy 缓存的 HIT 路径曾因
//   cache.match() 返回 immutable headers guard 的响应，
//   withXCache 直接 headers.set() 抛 TypeError → 500。
//   本地测试此前从未覆盖 HIT 路径（Node 无 caches 全局）。
//   E1 immutable 模拟下的 HIT 回归（核心）
//   E2 STALE 路径（过期缓存续期 + 后台重验语义）
//   E3 /api/github/* 的 Cache-Control：api s-maxage=3600 / raw s-maxage=86400
//      + stale-while-revalidate=86400
//   E4 站点 API TTL 上调（/api/site max-age=300）
//   E5 上游 404 → 502 语义保持
// 运行：node tests/step6-edge-cache.mjs
// ============================================================
import http from "node:http";

/* ---------- immutable Headers：模拟 Cloudflare cache.match() 的 guard ---------- */
class ImmutableHeaders extends Headers {
  set() { throw new TypeError("Headers is immutable"); }
  append() { throw new TypeError("Headers is immutable"); }
  delete() { throw new TypeError("Headers is immutable"); }
}

/* ---------- 内存 CacheStorage：match 返回 immutable headers 响应（对齐 CF 行为） ---------- */
class MemCache {
  constructor(name) { this.name = name; this.map = new Map(); }
  async put(req, res) {
    const key = typeof req === "string" ? req : req.url;
    this.map.set(key, res.clone());
  }
  async match(req) {
    const key = typeof req === "string" ? req : req.url;
    const stored = this.map.get(key);
    if (!stored) return undefined;
    const out = stored.clone();
    // 遮蔽 headers 为不可变 guard——旧代码在此处 headers.set() 会抛 TypeError
    Object.defineProperty(out, "headers", {
      value: new ImmutableHeaders(out.headers), configurable: true,
    });
    return out;
  }
  async delete(req) { return this.map.delete(typeof req === "string" ? req : req.url); }
  async keys() { return [...this.map.keys()].map((u) => new Request(u)); }
}

// 先安装全局 mock，再动态导入 worker（避免任何导入期捕获）
const realFetch = globalThis.fetch;
globalThis.caches = {
  _c: new Map(),
  async open(name) {
    if (!this._c.has(name)) this._c.set(name, new MemCache(name));
    return this._c.get(name);
  },
  get default() { return this.open("default"); },
};
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input.url;
  if (u.includes("raw.githubusercontent.com")) {
    return new Response(new Uint8Array(2048).fill(66), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "ETag": 'W/"raw-etag"' },
    });
  }
  if (u.includes("api.github.com")) {
    const remaining = u.includes("quota-ok") ? "4999" : "4998";
    return new Response(JSON.stringify([{ name: "a.jpg", type: "file" }]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "ETag": 'W/"api-etag"',
        "X-RateLimit-Remaining": remaining,
        "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  }
  return realFetch(input, init);
};

const { default: worker } = await import("./_helpers.mjs");

/* ---------- Mock KV ---------- */
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys: keys.slice(0, limit || 1000), list_complete: true };
    },
  };
}
const SITE_SEED = JSON.stringify({
  title: "边缘缓存测试站", footer: "E6 Test", autoMode: false, githubRepo: "", useCdn: false,
});
const envFor = () => ({ SITE_DATA: makeKV({ site: SITE_SEED }), GITHUB_TOKEN: "ghp_test" });
const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };

let pass = 0, fail = 0;
const findings = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; findings.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
};

const SITE = "http://localhost:8899";
const gh = (p) => `${SITE}/api/github/${p}`;

console.log("\n═══ E1 immutable headers 下的 HIT 路径回归 ═══");
{
  const url = gh("raw/owner/repo/main/photos/hit-test.jpg");
  const r1 = await worker.fetch(new Request(url), envFor(), ctx);
  const b1 = { status: r1.status, xcache: r1.headers.get("x-cache") };
  check("冷请求：200 + X-Cache: MISS", r1.status === 200 && b1.xcache === "MISS", JSON.stringify(b1));

  // 回归点：cache.match() 命中（immutable headers）→ 旧代码在此 500
  const r2 = await worker.fetch(new Request(url), envFor(), ctx);
  check("命中请求：200（不因 immutable headers 抛错）", r2.status === 200, `status=${r2.status}`);
  check("命中请求：X-Cache: HIT", r2.headers.get("x-cache") === "HIT", r2.headers.get("x-cache") || "无");
  const hitBody = await r2.text();
  check("命中响应体完整（缓存内容正确返回）", hitBody.length === 2048, `len=${hitBody.length}`);
}

console.log("\n═══ E2 STALE 路径（过期缓存续期） ═══");
{
  // 预置一条已过期的缓存（X-Cache-Time 设为 2 天前——raw 路径 TTL 为 1 天）
  const upstream = "https://raw.githubusercontent.com/owner/repo/main/photos/stale-test.jpg";
  const cache = await caches.open("gh-proxy-v1");
  await cache.put(new Request(upstream, { method: "GET" }), new Response("stale-body", {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400",
      "X-Cache-Time": String(Date.now() - 2 * 86400 * 1000),
    },
  }));
  const r = await worker.fetch(new Request(gh("raw/owner/repo/main/photos/stale-test.jpg")), envFor(), ctx);
  check("过期缓存：200 + X-Cache: STALE", r.status === 200 && r.headers.get("x-cache") === "STALE",
    `status=${r.status} x-cache=${r.headers.get("x-cache")}`);
}

console.log("\n═══ E3 /api/github/* Cache-Control（DevOps 3.1） ═══");
{
  const raw = await worker.fetch(new Request(gh("raw/owner/repo/main/photos/cc-raw.jpg")), envFor(), ctx);
  const ccRaw = raw.headers.get("cache-control") || "";
  check("raw 路径：s-maxage=86400 + stale-while-revalidate=86400",
    ccRaw.includes("s-maxage=86400") && ccRaw.includes("stale-while-revalidate=86400"), ccRaw);

  const api = await worker.fetch(new Request(gh("api/repos/owner/repo/contents/photos?ref=main")), envFor(), ctx);
  const ccApi = api.headers.get("cache-control") || "";
  check("api 路径：s-maxage=3600 + stale-while-revalidate=86400",
    ccApi.includes("s-maxage=3600") && ccApi.includes("stale-while-revalidate=86400"), ccApi);
  check("api 路径：max-age=300（缓存 API 新鲜期）", ccApi.includes("max-age=300"), ccApi);
}

console.log("\n═══ E4 站点 API TTL 上调 ═══");
{
  const site = await worker.fetch(new Request(`${SITE}/api/site`), envFor(), ctx);
  const cc = site.headers.get("cache-control") || "";
  check("/api/site：max-age=300（原 60）", cc.includes("max-age=300"), cc);
  check("/api/site：stale-while-revalidate=1200", cc.includes("stale-while-revalidate=1200"), cc);
}

console.log("\n═══ E5 上游 404 → 502 语义 ═══");
{
  globalThis.fetch = async (input) => {
    const u = typeof input === "string" ? input : input.url;
    if (u.includes("raw.githubusercontent.com")) {
      return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }
    return realFetch(input);
  };
  const r = await worker.fetch(new Request(gh("raw/owner/repo/main/photos/nonexistent.jpg")), envFor(), ctx);
  check("上游 404 → 502 + 明确错误信息", r.status === 502, `status=${r.status}`);
  const body = await r.json().catch(() => ({}));
  check("502 响应体含上游状态码", String(body.error || "").includes("404"), JSON.stringify(body));
  // 恢复 fetch mock
  globalThis.fetch = async (input) => {
    const u = typeof input === "string" ? input : input.url;
    if (u.includes("raw.githubusercontent.com")) {
      return new Response(new Uint8Array(2048).fill(66), {
        status: 200, headers: { "Content-Type": "image/jpeg", "ETag": 'W/"raw-etag"' },
      });
    }
    if (u.includes("api.github.com")) {
      return new Response(JSON.stringify([{ name: "a.jpg" }]), {
        status: 200,
        headers: {
          "Content-Type": "application/json", "ETag": 'W/"api-etag"',
          "X-RateLimit-Remaining": "4998", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    }
    return realFetch(input);
  };
}

console.log(`\n════════════════════════════════════`);
console.log(`v3.0 步骤6 边缘缓存回归: ${pass} 通过 / ${fail} 失败`);
if (findings.length) {
  console.log(`\n待整改清单:`);
  findings.forEach((f) => console.log(`  - ${f}`));
}
console.log(`════════════════════════════════════`);
process.exit(fail ? 1 : 0);
