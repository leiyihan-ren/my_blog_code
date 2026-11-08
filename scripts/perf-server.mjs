/**
 * scripts/perf-server.mjs —— v19.0 可复现 Lighthouse 基线服务器
 * ---------------------------------------------------------------
 * 目标：在不依赖线上部署、不依赖 Cloudflare 边缘的前提下，用与生产一致的
 * 「路由重写 + 缓存头 + 压缩」行为托管整站，让 Lighthouse 的 Performance
 * 分数可以跨版本复现、做严格的前后对比（同一进程 / 同一机器 / 同一口径）。
 *
 * 与生产 _worker.js 的对齐点：
 *   - 页面 URL → 物理路径：复用 scripts/route-map.mjs 的 staticFilePath()
 *     （与 _worker.js 的 PAGE_REWRITES 由 step10 断言保证一致）
 *   - HTML：Cache-Control: public, max-age=0, must-revalidate
 *   - 静态资产：长缓存 + immutable 语义（对齐 staticCacheControl）
 *   - Content-Type：按扩展名精确映射
 *   - 压缩：Accept-Encoding 含 gzip 时对文本资源 gzip（对齐 CF 边缘压缩）
 *   - /api/*：返回稳定的最小 mock，避免外部网络抖动污染性能测量
 *
 * 明确的不对齐（不影响 Performance 类别，写在这里避免误读）：
 *   - 不下发 CSP/nonce（本地无 Worker 注入链路；Lighthouse 仅测 performance）
 *   - 无 HTTP/2、无 Brotli、无边缘 RTT（本地 loopback，所有版本口径一致）
 *
 * 运行：node scripts/perf-server.mjs [port]
 *   port 默认 8899；就绪后 stdout 打印 PERF_SERVER_READY。
 * ===============================================================
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { staticFilePath } from "./route-map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PERF_PORT || 8899);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
const COMPRESSIBLE = /\.(?:html|js|mjs|css|json|svg|txt|webmanifest)$/;

/** 与生产 staticCacheControl() 同语义的缓存策略 */
function cacheControl(pathname) {
  if (/\.html$/.test(pathname) || pathname === "/") {
    return "public, max-age=0, must-revalidate";
  }
  if (/\?v=/.test(pathname)) return "public, max-age=31536000, immutable";
  if (/\.(?:js|mjs|css|woff2?|png|jpg|jpeg|webp|avif|svg|ico)$/.test(pathname)) {
    return "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000";
  }
  return "public, max-age=3600";
}

/** 首页 / 各页在初始化时探测的接口，返回稳定最小结构，避免 console 噪声 */
function apiMock(pathname) {
  if (/\/api\/posts(?:\/|$)/.test(pathname)) return { ok: true, data: [], posts: [] };
  if (/\/api\/popular/.test(pathname)) return { ok: true, data: [] };
  if (/\/api\/stats/.test(pathname)) return { ok: true, data: { posts: 0, views: 0 } };
  if (/\/api\/site/.test(pathname)) return { ok: true, data: {}, site: {} };
  if (/\/api\/music/.test(pathname)) return [];
  if (/\/api\/album/.test(pathname)) return { ok: true, data: [] };
  return { ok: true, data: [] };
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(u.pathname);

    if (pathname.startsWith("/api/")) {
      const body = Buffer.from(JSON.stringify(apiMock(pathname)));
      res.writeHead(200, {
        "Content-Type": MIME[".json"],
        "Cache-Control": "no-store",
        "Content-Length": body.length,
      });
      return res.end(body);
    }

    const rel = staticFilePath(pathname);
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end("Not Found");
    }

    let buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cacheControl(req.url),
      "Vary": "Accept-Encoding",
      "X-Content-Type-Options": "nosniff",
    };

    const ae = req.headers["accept-encoding"] || "";
    if (COMPRESSIBLE.test(ext) && /\bgzip\b/.test(ae) && buf.length > 256) {
      buf = zlib.gzipSync(buf, { level: 6 });
      headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = buf.length;
    res.writeHead(200, headers);
    return res.end(req.method === "HEAD" ? undefined : buf);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(String(e));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PERF_SERVER_READY http://127.0.0.1:${PORT}/ (root=${ROOT})`);
});
