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
   │ /api/github/*    │ stale-while-revalidate：图片代理走     │
   │ （图片/不可变）   │ 缓存秒开（worker 侧已 1 天 TTL）       │
   ├──────────────────┼──────────────────────────────────────┤
   │ /api/* GET       │ network-first：在线保证最新，          │
   │ （JSON 数据读）   │ 断网回退缓存（离线仍可看旧数据）       │
   ├──────────────────┼──────────────────────────────────────┤
   │ 带 Authorization  │ 不走缓存直传网络：管理面数据           │
   │ 的 /api/* GET    │ （发布/删除后必须立即最新；同时避免    │
   │                  │  带凭证响应进共享 Cache）              │
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
// v3.4.0：v8.0 全生态重塑——新增全局 UI 组件库 components/ui.js（对话框/Toast 收拢），
//         预缓存清单同步纳入；drive 页新增 vendor/jszip.min.js 本地化依赖（见下）。
// v3.5.0：P0 止血——drive.html 的 fmtBytes 兜底修复 + _worker.js 凭据硬编码清除。
//         必须 +1 的原因是：老客户端的静态缓存里可能仍是旧版 /utils/blog-utils.js
//         （无 fmtBytes）与旧 drive.html，不换缓存名它们不会被重新拉取。
const CACHE_VERSION = "v3.5.0";
const STATIC_CACHE = `my-blog-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = "my-blog-runtime-v1";
const OFFLINE_URL = "/index.html";
const RUNTIME_MAX_ENTRIES = 80; // 运行时缓存（音乐/图片）上限，超出按插入序淘汰

/* 预缓存清单：全站外壳 —— 断网可直接打开，小游戏/播放器/云盘离线可运行
 * v7.0：资源已下沉 pages/ styles/ utils/ services/ components/ 目录，
 * 但对外 URL 全部保持根级（_worker.js 重写层映射到物理文件），
 * 故本清单仍按「浏览器实际请求的 URL」罗列，无需关心物理路径。 */
const PRECACHE_URLS = [
  "/index.html",
  "/blog.html",
  "/games.html",
  "/album.html",
  "/links.html",
  "/timeline.html",
  "/guestbook.html",
  "/post.html",
  "/admin.html",
  "/drive.html",
  "/styles/common.css",
  "/styles/drive.css",
  "/utils/common.js",
  "/utils/blog-utils.js",
  "/components/ui.js",
  "/vendor/jszip.min.js",
  "/services/request.js",
  "/services/uploadService.js",
  "/components/music-player.js",
  "/components/game-core.js",
  "/components/games/breakout.js",
  "/components/games/g2048.js",
  "/components/games/hanoi.js",
  "/components/games/memory.js",
  "/components/games/mines.js",
  "/components/games/reaction.js",
  "/components/games/snake.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon.svg",
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

  // 1.5) 云盘 API 实时接口：不走 SWR 缓存，直传网络。
  // 原因：/api/drive/list 是管理面数据，上传/删除后必须立即反映最新列表；
  // stale-while-revalidate 会先返回旧缓存，导致「删了还在、传了不显示」。
  // 写方法（POST/PUT/DELETE）本就在 146 行被放行，不受影响。
  if (url.pathname.startsWith("/api/drive/")) {
    event.respondWith(fetch(req));
    return;
  }

  // 1.6) P0 修复：带 Authorization 的管理面 API GET，不走任何缓存，直传网络。
  // 根因：管理后台（发布/编辑/删除文章等）的列表请求曾落入 /api/* 的
  // stale-while-revalidate 分支——写操作成功后 SW 先把旧缓存当新鲜数据返回，
  // 用户看到「文章已删除但列表还在、已发布但列表不更新」，即「删不掉」假象。
  // 同时避免把带凭证的响应写入共享 Cache（安全隐患）。
  // 注：POST/PUT/DELETE 写方法已在前面被放行，不受影响。
  if (url.pathname.startsWith("/api/") && req.method === "GET" && req.headers.get("authorization")) {
    event.respondWith(fetch(req));
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

  // 2) /api/* GET（公共 JSON 数据读）：network-first，断网回退缓存。
  // P0 修复：与 1.6 配套——公开读（不带鉴权，如博客列表页拉文章列表）
  // 在线时也必须拿最新数据（旧 SWR 会让所有人看到旧文章列表）；
  // 断网时回退到运行时缓存里的旧数据，保证离线仍可浏览。
  // /api/github/*（图片代理，不可变）除外，继续走 SWR 秒开。
  if (url.pathname.startsWith("/api/") && req.method === "GET" && !url.pathname.startsWith("/api/github/")) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (isCacheableResponse(fresh)) {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(req, fresh.clone());
            trimCache(cache);
          }
          return fresh;
        } catch (e) {
          const hit = await caches.open(RUNTIME_CACHE).then((c) => c.match(req));
          if (hit) return hit;
          return new Response(JSON.stringify({ error: "离线且无缓存" }), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
      })()
    );
    return;
  }

  // 3) 同源静态资源：stale-while-revalidate（秒开，后台静默更新）
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      let hit = await cache.match(req);
      if (!hit) {
        // 预缓存资产兜底：懒加载资源（如按需注入的游戏脚本 games/*.js）在 install 期
        // 已进入 STATIC_CACHE，但未经运行时缓存；离线时从这里命中，保证断网可玩。
        hit = await caches.open(STATIC_CACHE).then((c) => c.match(req));
      }
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
