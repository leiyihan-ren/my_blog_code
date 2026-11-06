/**
 * components/global-search.js —— v11.0 战役四：全站本地搜索（ESM）
 * ---------------------------------------------------------------
 * 设计要点：
 *  1) 纯本地检索：MiniSearch 索引 + 数据快照存 IndexedDB，Ctrl+K 唤起后
 *     所有查询在内存完成，零网络请求，彻底摆脱接口延迟。
 *  2) 空闲期建索引：requestIdleCallback 触发，先读 IDB 快照秒开，再后台
 *     静默刷新数据（失败静默降级，绝不因搜索功能拖垮页面）。
 *  3) 拼音模糊匹配：utils/pinyin-gb2312.js 生成 py(全拼) / abbr(首字母)
 *     字段，配合中文单字+bigram 切分，支持「yjs」「云计算」「云」等输入。
 *  4) 严格 CSP 友好：MiniSearch 与拼音表均为同源静态文件，无 eval /
 *     无 CDN / 无内联脚本；本模块由 common.js 动态 import() 加载，
 *     script-src-elem 'self' 放行同源模块，无需 nonce。
 *  5) XSS 防线：所有结果文本一律 textContent 写入，高亮用 DOM 节点拼接，
 *     绝不拼 innerHTML。URL 走协议白名单。
 *
 * 数据源：/api/posts（文章）、/api/links（友链）、/api/album/photos（相册）、
 *         /api/music（音乐）、/api/timeline（时间线）。任一失败只跳过该源。
 * ===============================================================
 */
"use strict";

const DB_NAME = "site_search_v11";
const DB_VERSION = 1;
const STORE = "snapshot";
const SNAP_KEY = "index";
const MAX_AGE_MS = 30 * 60 * 1000; // 快照 30 分钟内视为新鲜，后台再刷新
const MAX_DOCS = 800;              // 索引文档上限，防止单页数据过大

/* ---------- IndexedDB 极小封装（不可用时全部静默降级为内存态） ---------- */
function openDb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      } catch (e) { /* ignore */ }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}
async function readSnapshot(db) {
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(SNAP_KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function writeSnapshot(db, snap) {
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(snap, SNAP_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (e) { resolve(); }
  });
}

/* ---------- v12.0 战役三：网盘索引的权限边界 ---------- */
/**
 * 云盘 PIN 由 drive.html 存进 sessionStorage：同一标签页跨页导航保留，
 * 但关闭标签即消失。用它作为「是否允许索引/展示私有文件名」的唯一闸门。
 */
function drivePin() {
  try { return sessionStorage.getItem("drive_pin") || ""; } catch (e) { return ""; }
}
function fmtSizeShort(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/* ---------- 数据源 ---------- */
const SOURCES = [
  { key: "posts", url: "/api/posts", type: "文章", fields: (x) => ({
    title: x.title || "无标题", body: stripMarkdown(x.content || x.summary || x.excerpt || ""),
    url: "/post.html?id=" + encodeURIComponent(x.id), date: x.date || x.createdAt || "",
  }) },
  { key: "links", url: "/api/links", type: "友链", fields: (x) => ({
    title: x.name || x.title || "友链", body: x.desc || x.description || x.url || "",
    url: safeUrl(x.url), date: "",
  }) },
  { key: "photos", url: "/api/album/photos", type: "相册", fields: (x) => ({
    title: x.title || x.name || "照片", body: x.desc || x.description || x.caption || "",
    url: "/album.html", date: x.date || "",
  }) },
  { key: "music", url: "/api/music", type: "音乐", fields: (x) => ({
    title: x.title || "歌曲", body: x.artist || "", url: "/index.html", date: "",
  }) },
  { key: "timeline", url: "/api/timeline", type: "时间线", fields: (x) => ({
    title: x.title || x.event || "记录", body: x.content || x.desc || "",
    url: "/timeline.html", date: x.date || "",
  }) },
  // v12.0：网盘列表。仅在已通过口令的会话中拉取；标记 private 后，
  // 无 PIN 的会话即使命中旧 IndexedDB 快照也不会展示这些私有文件名。
  { key: "drive", url: "/api/drive/list?path=drive", type: "网盘",
    private: true,
    enabled: () => drivePin() !== "",
    headers: () => ({ "x-drive-pin": drivePin() }),
    fields: (x) => ({
      title: x.name || "网盘文件",
      body: [String(x.path || "").replace(/^drive\//, ""),
        x.storage === "chunked" ? "大文件分片" : "",
        fmtSizeShort(x.size)].filter(Boolean).join(" · "),
      url: "/drive.html", date: x.latestAt || "",
    }) },
];

/** 去掉 Markdown 标记，让索引只留可读文本；同时截断防超大正文 */
function stripMarkdown(s) {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`_~|]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 1200);
}
/** URL 协议白名单：只放行 http(s) 与站内相对路径，杜绝 javascript: 注入 */
function safeUrl(u) {
  const s = String(u || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/(?!\/)/.test(s)) return s;
  return "";
}
function normalizeList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.items)) return raw.items;
  if (raw && Array.isArray(raw.posts)) return raw.posts;
  // v12.0：/api/drive/list 的条目在 files 字段（普通文件 + 大文件清单合并）
  if (raw && Array.isArray(raw.files)) return raw.files;
  return [];
}

/** 拉取全部数据源并构建文档（任一源失败只跳过，不影响其它） */
async function fetchDocs() {
  const docs = [];
  let id = 0;
  await Promise.all(SOURCES.map(async (src) => {
    try {
      // v12.0：私有数据源带权限闸门，未授权会话连请求都不发（不产生 401 噪音）
      if (src.enabled && !src.enabled()) return;
      const headers = { Accept: "application/json" };
      if (src.headers) Object.assign(headers, src.headers());
      // v14.0：全站请求 100% 收敛到 BlogApi 唯一出口（raw 为协议级透明
      // 直传，语义与原生 fetch 等价）。common.js 按需动态 import 本模块，
      // 所有加载 common.js 的页面均先加载 services/request.js，故
      // BlogApi.raw 必然可用；不再保留裸 fetch 降级。
      const res = await window.BlogApi.raw(src.url, { headers: headers });
      if (!res.ok) return;
      const data = await res.json();
      normalizeList(data).slice(0, MAX_DOCS).forEach((item) => {
        if (!item || typeof item !== "object") return;
        const f = src.fields(item);
        if (!f.title) return;
        id += 1;
        docs.push({
          id: id,
          title: String(f.title).slice(0, 160),
          body: String(f.body || "").slice(0, 600),
          type: src.type,
          // 空串是 safeUrl() 对非法协议（javascript:/data: 等）的明确拒绝信号，
          // 不能用 `|| "/index.html"` 兜底成首页——否则 go() 里的
          // `if (!u) return` 二次防线永远不触发，点恶意结果会跳首页。
          // 各数据源的 fields() 都已给出明确 url；缺省时保持空串（不可跳转）。
          url: typeof f.url === "string" ? f.url : "",
          date: String(f.date || ""),
          private: !!src.private,
        });
      });
    } catch (e) { /* 单源失败静默跳过 */ }
  }));
  return docs;
}

/* ---------- 索引构建 ---------- */
/** 把文档转成 MiniSearch 可检索字段：中文分词 + 拼音全拼 + 首字母 */
function indexDoc(d) {
  const P = window.PinyinGB2312;
  const text = d.title + " " + d.body;
  return {
    id: d.id,
    title: d.title,
    body: d.body,
    type: d.type,
    url: d.url,
    date: d.date,
    // 检索专用字段（storeFields 不含它们，不占结果对象）
    cn: P ? P.tokenize(text) : text,
    py: P ? P.full(text) : "",
    abbr: P ? P.abbr(d.title) : "",
  };
}
function buildIndex(docs) {
  const M = window.MiniSearch;
  if (!M) return null;
  const ms = new M({
    fields: ["title", "body", "cn", "py", "abbr"],
    storeFields: ["title", "body", "type", "url", "date"],
    searchOptions: { boost: { title: 4, abbr: 2, py: 1.5 }, prefix: true, fuzzy: 0.2 },
  });
  ms.addAll(docs.map(indexDoc));
  return ms;
}

/* ---------- 全局状态 ---------- */
let mini = null;
let docsById = new Map();
let panelReady = false;
let currentResults = [];
let activeIdx = 0;

function setDocs(docs) {
  docsById = new Map(docs.map((d) => [d.id, d]));
  mini = buildIndex(docs);
}

/** 执行搜索：返回按相关度排序的结果（最多 8 条） */
export function search(query) {
  let q = String(query || "").trim();
  // v12.0：type:网盘 / type:文章 精准筛选，可与关键词组合，也可单独浏览该类型
  let typeFilter = "";
  const tm = /^type[:：]\s*(\S+)\s*/.exec(q);
  if (tm) { typeFilter = tm[1]; q = q.slice(tm[0].length).trim(); }
  if (!q && typeFilter) {
    return [...docsById.values()].filter((d) => d.type === typeFilter).slice(0, 8)
      .map((d) => ({ title: d.title, body: d.body, type: d.type, url: d.url, date: d.date, score: 0 }));
  }
  if (!q || !mini) return [];
  try {
    const opts = { prefix: true, fuzzy: 0.2 };
    const hits = mini.search(q, Object.assign({ combineWith: "AND" }, opts));
    // AND 对中文/拼音混合输入过严，无结果时退回 OR 保证召回
    let list = hits.length ? hits : mini.search(q, Object.assign({ combineWith: "OR" }, opts));
    // 二次模糊兜底：较长查询拼写偏差大时提高容错再试一次，仍按相关度取前 8 条
    if (!list.length && q.length >= 3) {
      list = mini.search(q, { prefix: true, fuzzy: 0.35, combineWith: "OR" });
    }
    if (typeFilter) list = list.filter((h) => h.type === typeFilter);
    return list.slice(0, 8).map((h) => ({
      title: h.title, body: h.body, type: h.type, url: h.url, date: h.date, score: h.score,
    }));
  } catch (e) { return []; }
}

/* ---------- UI ---------- */
const STYLE_ID = "cx-global-search-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
  #cxSearchOverlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.48);
    backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;
    padding:12vh 16px 16px;opacity:0;pointer-events:none;transition:opacity .16s ease}
  #cxSearchOverlay.open{opacity:1;pointer-events:auto}
  #cxSearchBox{width:min(640px,100%);background:var(--card-bg,#fff);color:var(--text,#222);
    border:1px solid var(--border,#e2e8f0);border-radius:16px;overflow:hidden;
    box-shadow:0 24px 64px rgba(0,0,0,.28);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .cxs-input-wrap{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border,#e8edf3)}
  .cxs-input{flex:1;border:0;outline:0;background:transparent;color:inherit;font-size:16px;min-width:0}
  .cxs-kbd{font-size:11px;color:var(--text-mute,#8895a7);border:1px solid var(--border,#dde3ec);
    border-radius:6px;padding:2px 6px;white-space:nowrap}
  .cxs-list{max-height:52vh;overflow:auto;padding:6px;margin:0;list-style:none}
  .cxs-item{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border-radius:10px;cursor:pointer}
  .cxs-item.active,.cxs-item:hover{background:var(--hover,rgba(99,102,241,.10))}
  .cxs-badge{flex:none;font-size:11px;line-height:20px;padding:0 8px;border-radius:6px;
    background:var(--chip,rgba(99,102,241,.12));color:var(--accent,#4f46e5);white-space:nowrap}
  .cxs-main{flex:1;min-width:0}
  .cxs-title{font-size:14px;font-weight:600;line-height:1.4;word-break:break-all}
  .cxs-body{font-size:12px;color:var(--text-mute,#8895a7);margin-top:3px;line-height:1.45;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cxs-mark{background:rgba(255,213,79,.55);color:inherit;border-radius:2px}
  .cxs-empty{padding:28px 16px;text-align:center;color:var(--text-mute,#8895a7);font-size:13px}
  .cxs-foot{padding:8px 18px;border-top:1px solid var(--border,#e8edf3);font-size:11px;
    color:var(--text-mute,#8895a7);display:flex;gap:14px;flex-wrap:wrap}
  @media (prefers-reduced-motion:reduce){#cxSearchOverlay{transition:none}}
  `;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

/** 高亮：用 DOM 节点拼接，绝不拼 innerHTML */
function highlight(text, q) {
  const frag = document.createDocumentFragment();
  const s = String(text || "");
  if (!q) { frag.appendChild(document.createTextNode(s)); return frag; }
  const lower = s.toLowerCase(), needle = q.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const hit = lower.indexOf(needle, i);
    if (hit < 0) { frag.appendChild(document.createTextNode(s.slice(i))); break; }
    if (hit > i) frag.appendChild(document.createTextNode(s.slice(i, hit)));
    const mark = document.createElement("mark");
    mark.className = "cxs-mark";
    mark.textContent = s.slice(hit, hit + needle.length);
    frag.appendChild(mark);
    i = hit + needle.length;
  }
  return frag;
}

function buildPanel() {
  if (panelReady) return;
  if (!document.body) return;
  ensureStyle();
  const overlay = document.createElement("div");
  overlay.id = "cxSearchOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "全站搜索");
  const box = document.createElement("div");
  box.id = "cxSearchBox";
  const wrap = document.createElement("div");
  wrap.className = "cxs-input-wrap";
  const input = document.createElement("input");
  input.className = "cxs-input";
  input.type = "search";
  input.id = "cxSearchInput";
  input.placeholder = "搜索文章、友链、相册…（支持拼音，如 yjs / yunjisuan）";
  input.setAttribute("aria-label", "搜索关键词");
  input.autocomplete = "off";
  const kbd = document.createElement("span");
  kbd.className = "cxs-kbd";
  kbd.textContent = "ESC";
  wrap.appendChild(input); wrap.appendChild(kbd);
  const list = document.createElement("ul");
  list.className = "cxs-list";
  list.id = "cxSearchList";
  const foot = document.createElement("div");
  foot.className = "cxs-foot";
  ["↑↓ 选择", "Enter 打开", "Ctrl/⌘+K 唤起", "本地索引 · 零网络"].forEach((t) => {
    const s = document.createElement("span"); s.textContent = t; foot.appendChild(s);
  });
  box.appendChild(wrap); box.appendChild(list); box.appendChild(foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  panelReady = true;

  function open() {
    buildPanel();
    const ov = document.getElementById("cxSearchOverlay");
    const inp = document.getElementById("cxSearchInput");
    if (!ov || !inp) return;
    ov.classList.add("open");
    inp.value = "";
    currentResults = []; activeIdx = 0; renderList("");
    setTimeout(() => inp.focus(), 0);
  }
  function close() {
    const ov = document.getElementById("cxSearchOverlay");
    if (ov) ov.classList.remove("open");
  }
  function renderList(q) {
    const ul = document.getElementById("cxSearchList");
    if (!ul) return;
    ul.textContent = "";
    currentResults = search(q);
    activeIdx = 0;
    if (!currentResults.length) {
      const li = document.createElement("li");
      li.className = "cxs-empty";
      li.textContent = q ? (mini ? "没有匹配的结果，换个关键词试试" : "索引构建中，请稍候…") : "输入关键词开始搜索";
      ul.appendChild(li);
      return;
    }
    currentResults.forEach((r, idx) => {
      const li = document.createElement("li");
      li.className = "cxs-item" + (idx === 0 ? " active" : "");
      li.setAttribute("role", "option");
      li.dataset.idx = String(idx);
      const badge = document.createElement("span");
      badge.className = "cxs-badge"; badge.textContent = r.type;
      const main = document.createElement("div"); main.className = "cxs-main";
      const title = document.createElement("div"); title.className = "cxs-title";
      title.appendChild(highlight(r.title, q));
      const body = document.createElement("div"); body.className = "cxs-body";
      body.textContent = r.body || r.date || "";
      main.appendChild(title); main.appendChild(body);
      li.appendChild(badge); li.appendChild(main);
      li.addEventListener("mouseenter", () => setActive(idx));
      li.addEventListener("click", () => go(idx));
      ul.appendChild(li);
    });
  }
  function setActive(idx) {
    const ul = document.getElementById("cxSearchList");
    if (!ul) return;
    activeIdx = Math.max(0, Math.min(currentResults.length - 1, idx));
    [...ul.children].forEach((li, i) => li.classList.toggle("active", i === activeIdx));
    const el = ul.children[activeIdx];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }
  function go(idx) {
    const r = currentResults[idx];
    if (!r) return;
    const u = safeUrl(r.url);
    if (!u) return;
    close();
    // 同源站内跳转；外链另开标签（noopener 防反向控制）
    if (/^\/(?!\/)/.test(u)) window.location.assign(u);
    else window.open(u, "_blank", "noopener,noreferrer");
  }

  input.addEventListener("input", () => renderList(input.value.trim()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === "Enter") { e.preventDefault(); go(activeIdx); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => {
    const k = e.key && e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "k") { e.preventDefault(); open(); return; }
    if (e.key === "Escape") close();
    // 避免与页面已有 "/" 聚焦搜索框冲突：仅当焦点不在输入框时处理
    if (k === "/" && !/INPUT|TEXTAREA/.test((document.activeElement && document.activeElement.tagName) || "")) {
      const ov = document.getElementById("cxSearchOverlay");
      if (ov && !ov.classList.contains("open")) { e.preventDefault(); open(); }
    }
  });
  // 供测试与调试使用的只读句柄（不暴露内部可变状态）
  window.GlobalSearch = {
    open: open, close: close, search: search,
    isOpen: () => !!(document.getElementById("cxSearchOverlay") || {}).classList?.contains("open"),
    docCount: () => docsById.size,
    // v12.0：私有条目可观测、可清除（退出云盘口令后调用即可抹掉快照里的文件名）
    privateCount: () => [...docsById.values()].filter((d) => d.private).length,
    clearPrivate: async () => {
      const db = await openDb();
      const snap = await readSnapshot(db);
      if (!snap || !Array.isArray(snap.docs)) return 0;
      const n = snap.docs.filter((d) => d.private).length;
      await writeSnapshot(db, { docs: snap.docs.filter((d) => !d.private), at: Date.now() });
      return n;
    },
  };
}

/* ---------- 启动：空闲期建索引 + 快照持久化 ---------- */
async function boot() {
  // 依赖由 common.js 在 import 本模块前注入（同源静态脚本，严格 CSP 放行）
  const db = await openDb();
  const snap = await readSnapshot(db);
  if (snap && Array.isArray(snap.docs) && snap.docs.length && window.MiniSearch && window.PinyinGB2312) {
    // 命中快照：秒开，无需等网络。v12.0：私有（网盘）文档只在仍有 PIN 的
    // 会话中可见，避免上一个已登录会话留下的 IndexedDB 快照泄漏文件名。
    const pinOk = drivePin() !== "";
    const visible = snap.docs.filter((d) => !d.private || pinOk);
    if (visible.length) setDocs(visible);
  }
  try {
    const docs = await fetchDocs();
    if (docs.length) {
      setDocs(docs);
      await writeSnapshot(db, { docs: docs, at: Date.now() });
    }
  } catch (e) { /* 网络失败：保留旧快照，功能不中断 */ }
  // 面板结构在空闲时再建，不占首屏关键路径
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPanel, { once: true });
  } else buildPanel();
  window.GlobalSearchReady = true;
}

// 幂等启动（动态 import 只执行一次，双保险）
if (!window.__globalSearchBooted) {
  window.__globalSearchBooted = true;
  boot().catch(() => { window.GlobalSearchReady = false; });
}

export { boot as initSearch, fetchDocs, indexDoc };
