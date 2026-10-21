/* ============================================================
   sw.js —— 个人博客 PWA Service Worker（v3.0 新增）
   ------------------------------------------------------------
   缓存策略总览：
   ┌──────────────────┬──────────────────────────────────────┐
   │ HTML 导航请求     │ network-first：优先网络保证最新，      │
   │                  │ 断网回退缓存（含 index.html 兜底）     │
   ├──────────────────┼──────────────────────────────────────┤
   │ 同源静态资源      │ stale-while-revalidate：先返回缓存    │
   │ (JS/CSS/图标)     │ 秒开，后台静默更新，下次即最新         │
   ├──────────────────┼──────────────────────────────────────┤
   │ /api/* GET        │ stale-while-revalidate：同上          │
   │ （POST 不拦截）   │                                      │
   ├──────────────────┼──────────────────────────────────────┤
   │ Range/206 音频    │ 缓存完整版后按 Range 切片返回 206，     │
   │                  │ 保证音频离线/拖动均可播                │
   └──────────────────┴──────────────────────────────────────┘
   版本更新机制（防止用户永远看旧页面）：
   1. CACHE_VERSION 每次发布 +1（本文件头部唯一常量）
   2. install 后立即 skipWaiting()，activate 清理旧版本缓存
   3. 页面注册脚本监听 controllerchange：若是「旧→新」接管
      而非首次注册，自动 location.reload() 一次
   4. sw.js 在 _worker.js 中以 max-age=0, must-revalidate 响应，
      浏览器每次访问都会重新验证脚本本身
   ============================================================ */
"use strict";

/* ⚠️ 每次发布新版本时必须 +1，否则用户可能停留在旧缓存 */
const CACHE_VERSION = "v3.0.1";
const STATIC_CACHE = `my-blog-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = "my-blog-runtime-v1";
const OFFLINE_URL = "./index.html";
const RUNTIME_MAX_ENTRIES = 80; // 运行时缓存（音乐/图片）上限，超出按插入序淘汰

/* 预缓存清单：全站外壳 —— 断网可直接打开，小游戏/播放器离线可运行 */
const PRECACHE_URLS = [
  "./index.html",
  "./blog.html",
  "./games.html",
  "./album.html",
  "./links.html",
  "./timeline.html",
  "./guestbook.html",
  "./post.html",
  "./admin.html",
  "./common.css",
  "./common.js",
  "./js/utils.js",
  "./js/request.js",
  "./music-player.js",
  "./game-core.js",
  "./games/breakout.js",
  "./games/g2048.js",
  "./games/hanoi.js",
  "./games/memory.js",
  "./games/mines.js",
  "./games/reaction.js",
  "./games/snake.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.svg",
];

/* ---------- install：预缓存外壳（单项失败不拖垮整体） ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch (e) {
            console.warn("[sw] precache miss:", url, e && e.message);
          }
        })
      );
      await self.skipWaiting(); // 新 SW 立即接管，配合页面 controllerchange 刷新
    })()
  );
});

/* ---------- activate：清理旧版本缓存 + 接管客户端 ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("my-blog-static-") && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* ---------- 工具：缓存体积控制（超出上限按插入序淘汰最旧） ---------- */
async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= RUNTIME_MAX_ENTRIES) return;
  await cache.delete(keys.slice(0, keys.length - RUNTIME_MAX_ENTRIES));
}

/* ---------- 可缓存性判定 ---------- */
function isCacheableResponse(resp) {
  return resp && resp.status === 200 && resp.type === "basic";
}

/* ---------- fetch：分策略派发 ---------- */
/* ---------- Range 分片请求（音频/视频拖动）：缓存完整版后按需切片 ---------- */
async function sliceRange(fullBuf, req, contentType) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  if (!m) return null;
  const total = fullBuf.byteLength;
  let start = m[1] === "" ? null : parseInt(m[1], 10);
  let end = m[2] === "" ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, total - end);
    end = total - 1;
  } else {
    end = end === null ? total - 1 : Math.min(end, total - 1);
  }
  if (start > end || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
    });
  }
  const slice = fullBuf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(slice.byteLength),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST（登录/留言/写操作）一律不拦截

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return; // 只接管同源；外链由浏览器直连

  // Range 分片请求：优先按缓存完整版切片（保证音频离线可播），
  // 未命中则拉取完整版入库后再切片；彻底失败才透传网络
  if (req.headers.has("range")) {
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(RUNTIME_CACHE);
          let hit = await cache.match(req);
          if (!hit) {
            const full = await fetch(new Request(req.url, { method: "GET" }));
            if (isCacheableResponse(full)) {
              // 注意：cache.put 的 key Request 不能带 Range 头（规范要求 Range 请求
              // 只能配 206 响应），否则 put 抛 TypeError。用无 Range 头的同 URL
              // Request 作 key，后续带 Range 的 match 仍能命中（key 只看 URL）。
              await cache.put(new Request(req.url, { method: "GET" }), full.clone());
              hit = full;
            }
          }
          if (hit) {
            const buf = new Uint8Array(await hit.clone().arrayBuffer());
            const sliced = await sliceRange(buf, req, hit.headers.get("Content-Type") || "application/octet-stream");
            if (sliced) return sliced;
          }
        } catch (e) {
          /* 落入透传分支 */
        }
        return fetch(req);
      })()
    );
    return;
  }

  // 1) HTML 导航：network-first，断网回退缓存（离线可打开站点）
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (isCacheableResponse(fresh)) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch (e) {
          const cache = await caches.open(RUNTIME_CACHE);
          const hit = (await cache.match(req)) || (await cache.match(OFFLINE_URL));
          if (hit) return hit;
          return new Response(
            "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='UTF-8'>" +
              "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
              "<title>离线中 - 我的博客</title></head><body style='font-family:sans-serif;" +
              "display:flex;align-items:center;justify-content:center;min-height:100vh;" +
              "margin:0;background:#4f46e5;color:#fff;text-align:center;padding:24px'>" +
              "<div><h1>当前处于离线状态</h1><p>页面尚未缓存完成，请连接网络后重试。</p></div>" +
              "</body></html>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
      })()
    );
    return;
  }

  // 2) 同源静态资源与 /api/* GET：stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then(async (fresh) => {
          if (isCacheableResponse(fresh)) {
            (await caches.open(RUNTIME_CACHE)).put(req, fresh.clone());
            trimCache(await caches.open(RUNTIME_CACHE));
          }
          return fresh;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(network); // 后台静默更新，不影响本次响应速度
        return hit;
      }
      const fresh = await network;
      if (fresh) return fresh;
      return new Response(JSON.stringify({ error: "离线且无缓存" }), {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    })()
  );
});

/* ---------- 手动触发立即更新（保留命令式入口） ---------- */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
