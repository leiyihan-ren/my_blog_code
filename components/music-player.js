// 音乐播放器组件 - 自动注入到页面底部
// 版本：v3（v7.0 性能重构：初始化推迟到浏览器空闲）
// ---------------------------------------------------------------
// v7.0 首屏性能压榨：播放器是「非关键 chrome 元素」——CSS 已在 body 预留
// 底部空间（无 CLS），首屏渲染不依赖它。把 36KB 的解析 + 执行 + 歌单 API
// 请求全部挪出关键路径：defer 脚本执行完毕后不立即跑 IIFE，而是等浏览器
// 空闲（requestIdleCallback，超时兜底 1.2s）再启动。
// 无页面内联脚本依赖播放器就绪（耦合点仅 window.showToast 可选复用），
// 故延迟初始化零行为风险；离线/弱网下 loadMusic 自身的降级逻辑不变。
// ---------------------------------------------------------------
var bootMusicPlayer = function() {
(function() {
  "use strict";

  // ===== CSS =====
  const css = `
  .mp-player {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    background: var(--nav-bg, rgba(255,255,255,0.95));
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-top: 1px solid var(--border, #eaecef);
    z-index: 999;
    padding: 10px 20px;
    display: flex;
    align-items: center;
    gap: 16px;
    transition: transform 0.35s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
    will-change: transform;
  }
  body.dark .mp-player {
    background: rgba(15,15,26,0.9);
  }
  .mp-player.mp-hidden {
    transform: translateY(calc(100% - 28px));
  }
  .mp-toggle-btn {
    position: absolute;
    top: -14px;
    left: 50%;
    transform: translateX(-50%);
    width: 56px;
    height: 20px;
    border-radius: 20px 20px 0 0;
    background: inherit;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--primary-text, #4f46e5);
    border-top: 1px solid var(--border, #eaecef);
    border-left: 1px solid var(--border, #eaecef);
    border-right: 1px solid var(--border, #eaecef);
    transition: background 0.2s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  }
  .mp-toggle-btn:hover {
    background: var(--primary, #4f46e5);
    color: var(--on-accent, #fff);
  }
  .mp-toggle-btn .mp-toggle-icon {
    transition: transform 0.3s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  }
  .mp-player.mp-hidden .mp-toggle-btn .mp-toggle-icon {
    transform: rotate(180deg);
  }
  .mp-cover {
    width: 48px; height: 48px;
    border-radius: 10px;
    background: var(--grad-brand, linear-gradient(135deg, #5a67d8, #764ba2));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
  }
  .mp-cover img {
    width: 100%; height: 100%;
    object-fit: cover;
    transition: transform 0.3s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  }
  /* 播放中封面轻微放大，提供"正在播放"的视觉反馈 */
  .mp-cover.mp-cover-playing img {
    animation: mpCoverPulse 2.4s ease-in-out infinite;
  }
  @keyframes mpCoverPulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.08); }
  }
  .mp-info {
    flex: 1;
    min-width: 0;
  }
  /* v12.0 战役一：当前歌词行（与锁屏 MediaMetadata.title 同步） */
  .mp-lyric {
    font-size: 11px;
    line-height: 1.35;
    color: var(--text-mute, #6b7280);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-height: 15px;
    margin-top: 2px;
    opacity: .85;
  }
  .mp-lyric:empty { display: none; }
  .mp-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
  }
  .mp-artist {
    font-size: 12px;
    color: var(--text-mute, #6b7280);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mp-progress-wrap {
    flex: 1;
    min-width: 90px;
    max-width: 200px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .mp-progress {
    width: 100%;
    height: 4px;
    background: var(--border, #eaecef);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
    transition: height 0.15s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
    touch-action: none; /* 让 pointer 事件接管拖动，不触发页面滚动 */
  }
  .mp-progress:hover, .mp-progress.mp-seeking {
    height: 6px;
  }
  /* 已缓冲部分 */
  .mp-progress-buffer {
    position: absolute;
    left: 0; top: 0;
    height: 100%;
    background: rgba(127,127,127,0.25);
    border-radius: 2px;
    width: 0%;
    pointer-events: none;
  }
  .mp-progress-bar {
    height: 100%;
    background: var(--primary, #4f46e5);
    border-radius: 2px;
    width: 0%;
    position: relative;
    pointer-events: none;
  }
  /* 拖动手柄 */
  .mp-progress-bar::after {
    content: "";
    position: absolute;
    right: -5px;
    top: 50%;
    transform: translateY(-50%) scale(0);
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--primary, #4f46e5);
    box-shadow: 0 1px 4px rgba(0,0,0,0.2);
    transition: transform 0.15s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
  }
  .mp-progress:hover .mp-progress-bar::after,
  .mp-progress.mp-seeking .mp-progress-bar::after {
    transform: translateY(-50%) scale(1);
  }
  .mp-time {
    font-size: 11px;
    color: var(--text-mute, #6b7280);
    display: flex;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .mp-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mp-btn {
    width: 36px; height: 36px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text, #333);
    cursor: pointer;
    font-size: 15px;
    transition: all 0.2s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
  }
  .mp-btn:hover {
    background: var(--primary, #4f46e5);
    color: var(--on-accent, #fff);
  }
  .mp-btn:active { transform: scale(0.92); }
  .mp-play {
    width: 40px; height: 40px;
    background: var(--primary, #4f46e5);
    color: var(--on-accent, #fff);
    font-size: 16px;
  }
  .mp-play:hover {
    background: var(--primary-hover, #4338ca);
  }
  /* 播放模式按钮激活态 */
  .mp-mode-btn.mp-mode-active {
    color: var(--primary-text, #4f46e5);
    background: rgba(var(--primary-rgb, 79,70,229),0.12);
  }
  .mp-volume {
    display: none;
    align-items: center;
    gap: 6px;
  }
  .mp-volume-btn { font-size: 15px; }
  .mp-volume-slider {
    width: 72px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--border, #eaecef);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .mp-volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--primary, #4f46e5);
    cursor: pointer;
  }
  .mp-volume-slider::-moz-range-thumb {
    width: 12px; height: 12px;
    border: none;
    border-radius: 50%;
    background: var(--primary, #4f46e5);
    cursor: pointer;
  }
  .mp-list-btn { display: none; }

  /* 播放列表弹窗 */
  .mp-playlist {
    position: fixed;
    bottom: 80px;
    right: 20px;
    width: 280px;
    max-height: 360px;
    background: var(--card-bg, #fff);
    border-radius: 14px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.15);
    border: 1px solid var(--border, #eaecef);
    z-index: 998;
    display: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    transform-origin: bottom right;
    animation: playlistIn 0.2s ease-out;
  }
  @keyframes playlistIn {
    from { opacity: 0; transform: translateY(10px) scale(0.95); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .mp-playlist.active { display: block; }
  .mp-playlist-header {
    padding: 14px 18px;
    font-weight: 600;
    font-size: 14px;
    border-bottom: 1px solid var(--border, #eaecef);
    color: var(--text, #333);
    position: sticky;
    top: 0;
    background: var(--card-bg, #fff);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .mp-playlist-count {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-mute, #6b7280);
  }
  .mp-playlist-item {
    padding: 12px 18px;
    cursor: pointer;
    transition: background 0.15s var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
    border-bottom: 1px solid var(--border, #eaecef);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mp-playlist-item:last-child { border-bottom: none; }
  .mp-playlist-item:hover { background: var(--item-bg, #f9fafb); }
  .mp-playlist-item.active {
    background: rgba(var(--primary-rgb, 79,70,229),0.1);
    color: var(--primary-text, #4f46e5);
  }
  .mp-playlist-item-eq {
    width: 16px;
    flex-shrink: 0;
    font-size: 11px;
    text-align: center;
  }
  .mp-playlist-item-body { flex: 1; min-width: 0; }
  .mp-playlist-item-title {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mp-src-badge {
    font-size: 11px;
    margin-left: 4px;
    opacity: 0.75;
    vertical-align: middle;
  }
  .mp-playlist-item-artist {
    font-size: 12px;
    color: var(--text-mute, #6b7280);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mp-playlist-item.active .mp-playlist-item-artist { color: var(--primary-text, #4f46e5); }
  /* 当前播放条目的均衡器跳动动画 */
  .mp-playlist-item.active .mp-eq-bar {
    display: inline-block;
    width: 2px;
    background: currentColor;
    border-radius: 1px;
    animation: mpEq 0.9s ease-in-out infinite;
  }
  .mp-playlist-item.active .mp-eq-bar:nth-child(1) { height: 6px; animation-delay: 0s; }
  .mp-playlist-item.active .mp-eq-bar:nth-child(2) { height: 10px; animation-delay: 0.2s; }
  .mp-playlist-item.active .mp-eq-bar:nth-child(3) { height: 4px; animation-delay: 0.4s; }
  @keyframes mpEq {
    0%, 100% { transform: scaleY(0.4); }
    50% { transform: scaleY(1); }
  }
  .mp-playlist-item:not(.active) .mp-eq-bar { display: none; }
  .mp-playlist-item-num {
    font-size: 11px;
    color: var(--text-mute, #6b7280);
    width: 16px;
    text-align: center;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  /* 给页面底部留空间（默认 padding-bottom 已在各页面静态 CSS 中声明，避免 CLS） */
  body.mp-body-hidden { padding-bottom: 28px; }

  /* ---- 响应式 ---- */
  @media (min-width: 1024px) {
    /* 桌面端：显示音量区（静音按钮 + 滑块）。
       基础样式 .mp-volume 为 display:none（移动端空间优先），
       此处按原设计意图在宽屏启用——修复压测发现的「音量控件全断点不可见」缺陷 */
    .mp-volume { display: flex; }
  }
  @media (max-width: 1023px) {
    /* 平板/手机：音量滑块隐藏，但保留静音按钮 */
    .mp-volume { display: flex; }
    .mp-volume-slider { display: none; }
  }
  @media (max-width: 640px) {
    .mp-player { padding: 8px 12px; gap: 10px; }
    .mp-cover { width: 40px; height: 40px; font-size: 17px; }
    .mp-btn { width: 32px; height: 32px; font-size: 13px; }
    .mp-play { width: 36px; height: 36px; font-size: 14px; }
    .mp-info { flex: 1 1 auto; }
    .mp-progress-wrap { max-width: none; min-width: 60px; }
    .mp-list-btn { display: flex; }
    .mp-playlist { width: calc(100vw - 24px); right: 12px; }

    /* v12.0 收尾：战役一新增 🌐 全局播放按钮后，窄屏控制条会溢出视口。
       .mp-btn 全部 flex-shrink:0，.mp-controls 无法自行收缩，因此按「渐进增强」
       收起两项桌面增强控件（播放模式、音量组），核心控制（上一首/播放/下一首/
       播放列表/全局播放）全部保留；移动端可用硬件音量键，且独立窗口播放内核在
       移动浏览器上体验有限，收起这两项不会造成功能缺失。 */
    .mp-controls { gap: 4px; flex: 0 0 auto; }
    .mp-mode-btn, .mp-volume { display: none; }
    .mp-progress-wrap { min-width: 48px; }
  }
  @media (max-width: 360px) {
    /* 极窄屏（320px 级）兜底：进度条让位给歌曲信息与控制条，保证零横向溢出 */
    .mp-progress-wrap { display: none; }
  }
  @media (min-width: 641px) {
    .mp-list-btn { display: flex; }
  }
  @media (prefers-reduced-motion: reduce) {
    .mp-cover.mp-cover-playing img { animation: none; }
    .mp-playlist-item.active .mp-eq-bar { animation: none; }
  }
  `;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ===== HTML =====
  const playerHTML = `
  <div class="mp-player" id="mpPlayer">
    <button class="mp-toggle-btn" id="mpToggle" title="收起/展开播放器" aria-label="收起或展开播放器">
      <span class="mp-toggle-icon">▾</span>
    </button>
    <div class="mp-cover" id="mpCover" aria-hidden="true">🎵</div>
    <div class="mp-info">
      <div class="mp-title" id="mpTitle">暂无歌曲</div>
      <div class="mp-artist" id="mpArtist">去管理后台添加音乐吧</div>
      <div class="mp-lyric" id="mpLyric"></div>
    </div>
    <div class="mp-progress-wrap" id="mpProgressWrap">
      <div class="mp-progress" id="mpProgress" role="slider" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
        <div class="mp-progress-buffer" id="mpProgressBuffer"></div>
        <div class="mp-progress-bar" id="mpProgressBar"></div>
      </div>
      <div class="mp-time">
        <span id="mpCurrent">0:00</span>
        <span id="mpDuration">0:00</span>
      </div>
    </div>
    <div class="mp-controls">
      <button class="mp-btn mp-mode-btn" id="mpMode" title="播放模式：列表循环" aria-label="切换播放模式">🔁</button>
      <button class="mp-btn" id="mpPrev" title="上一首" aria-label="上一首">⏮</button>
      <button class="mp-btn mp-play" id="mpPlay" title="播放" aria-label="播放或暂停">▶</button>
      <button class="mp-btn" id="mpNext" title="下一首" aria-label="下一首">⏭</button>
      <div class="mp-volume">
        <button class="mp-btn mp-volume-btn" id="mpMute" title="静音" aria-label="静音开关">🔊</button>
        <input type="range" class="mp-volume-slider" id="mpVolume" min="0" max="100" value="70" aria-label="音量">
      </div>
      <button class="mp-btn mp-list-btn" id="mpListBtn" title="播放列表" aria-label="播放列表">📋</button>
      <button class="mp-btn mp-global-btn" id="mpGlobal" title="开启全局播放（切页不断播）" aria-label="开启全局播放">🌐</button>
    </div>
  </div>
  <div class="mp-playlist" id="mpPlaylist" role="dialog" aria-label="播放列表">
    <div class="mp-playlist-header">
      <span>播放列表</span>
      <span class="mp-playlist-count" id="mpPlaylistCount"></span>
    </div>
    <div id="mpPlaylistItems"></div>
  </div>
  `;

  const container = document.createElement("div");
  container.innerHTML = playerHTML;
  while (container.firstElementChild) {
    document.body.appendChild(container.firstElementChild);
  }

  // ===== Logic =====
  const audio = new Audio();
  audio.preload = "metadata";

  /* ---------- v12.0 战役一：锁屏歌词 + 全局播放内核接管 ---------- */
  let lrcLines = [];
  let lastLrcLine = "";
  let globalHost = null;

  /* music-player.js 是 defer 脚本，与 components/lrc.js 的空闲加载存在时序竞争。
   * 这里保留一份等价的精简实现作兜底：共享模块已就绪则优先复用，否则用内置，
   * 保证「锁屏歌词」在任何加载顺序下都可用（歌词是增强项，绝不能拖垮播放）。 */
  var BUILTIN_LRC = (function () {
    var RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    return {
      parse: function (text) {
        var out = [];
        String(text || "").split(/\r?\n/).forEach(function (line) {
          var tags = [], m;
          RE.lastIndex = 0;
          while ((m = RE.exec(line)) !== null) {
            tags.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number("0." + m[3]) : 0));
          }
          if (!tags.length) return;
          var s = line.replace(RE, "").trim();
          tags.forEach(function (t) { if (isFinite(t) && t >= 0) out.push({ t: t, text: s }); });
        });
        out.sort(function (a, b) { return a.t - b.t; });
        return out;
      },
      at: function (lines, time) {
        if (!lines || !lines.length) return "";
        var lo = 0, hi = lines.length - 1, ans = -1, t = Number(time) || 0;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return ans < 0 ? "" : (lines[ans].text || (ans > 0 ? lines[ans - 1].text : ""));
      },
    };
  })();
  function lrcParser() { return window.LrcParser || BUILTIN_LRC; }

  function inRemote() { return !!(globalHost && globalHost.isAlive()); }

  /** 解析当前曲目的 LRC（内联 lrc 字符串优先，其次同源 lrcUrl 异步取） */
  function setLrc(song) {
    lastLrcLine = "";
    lrcLines = [];
    var el = $("mpLyric");
    if (el) el.textContent = "";
    if (!song) return;
    var P = lrcParser();
    if (typeof song.lrc === "string" && song.lrc) {
      lrcLines = P.parse(song.lrc);
      return;
    }
    var u = song.lrcUrl;
    if (typeof u === "string" && /^\/(?!\/)/.test(u)) {
      fetch(u).then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (t) { lrcLines = lrcParser().parse(t); })
        .catch(function () { /* 歌词是增强项，失败只显示歌名 */ });
    }
  }

  function baseMediaTitle() {
    var s = playlist[currentIdx] || {};
    return s.artist ? (s.title || "未知歌曲") + " · " + s.artist : (s.title || "我的博客");
  }

  /** 锁屏逐行歌词：Media Session 无 lyric 字段，把当前行写进 MediaMetadata.title */
  function applyLrcMetadata() {
    if (!lrcLines.length) return;
    var line = lrcParser().at(lrcLines, audio.currentTime);
    if (line === lastLrcLine) return;
    lastLrcLine = line;
    var el = $("mpLyric");
    if (el) el.textContent = line;
    if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
    var s = playlist[currentIdx] || {};
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: line || baseMediaTitle(),
        artist: line ? baseMediaTitle() : (s.artist || "我的博客"),
        album: "我的博客",
        artwork: s.cover && isHttpUrl(s.cover) && !isDeadSampleUrl(s.cover)
          ? [{ src: s.cover, sizes: "512x512", type: "image/jpeg" }] : [],
      });
    } catch (e) { /* 不支持则忽略 */ }
  }

  /** 远程模式：主页面播放器变成遥控器，本地 audio 保持暂停，杜绝双声 */
  function syncGlobalBtn() {
    var b = $("mpGlobal");
    if (!b) return;
    var on = inRemote();
    b.textContent = on ? "🛰" : "🌐";
    b.title = on ? "全局播放中：点击结束并回到本页播放" : "开启全局播放（切页不断播）";
    b.setAttribute("aria-label", b.title);
  }
  function hostPlaylist() {
    return playlist.map(function (s) {
      return {
        title: s.title || "未知歌曲", artist: s.artist || "",
        url: s.url || "", cover: s.cover || "", lrc: s.lrc || "",
      };
    });
  }
  function syncRemotePosition(st) {
    if (!st || !("mediaSession" in navigator) ||
        typeof navigator.mediaSession.setPositionState !== "function") return;
    if (!(st.duration > 0)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: st.duration,
        position: Math.min(Number(st.currentTime) || 0, st.duration),
        playbackRate: st.playbackRate || 1,
      });
    } catch (e) { /* 忽略 */ }
  }

  function toggleGlobal() {
    if (inRemote()) {
      globalHost.close();
      globalHost = null;
      syncGlobalBtn();
      showToast("已结束全局播放");
      return;
    }
    var Host = window.PlayerHost;
    if (!Host || !Host.supported()) { showToast("当前环境不支持全局播放", "err"); return; }
    // window.open 必须在用户手势的同步栈内触发，否则被弹窗拦截器挡下；
    // mount() 的 Promise executor 是同步执行的，此处仍在手势栈内。
    var p = Host.mount({ mode: "window" });
    showToast("正在启动全局播放窗口…");
    Promise.resolve(p).then(async function (h) {
      globalHost = h;
      await h.setPlaylist(hostPlaylist());
      await h.load(currentIdx, !audio.paused, Number(audio.currentTime) || 0);
      audio.pause(); // 本地让位
      h.on("trackchange", function (st) {
        if (st && typeof st.idx === "number") { currentIdx = st.idx; renderPlaylist(); }
      });
      h.on("timeupdate", syncRemotePosition);
      h.on("loadedmetadata", syncRemotePosition);
      h.on("pagehide", function () { globalHost = null; syncGlobalBtn(); });
      h.on("autoplay-blocked", function () { showToast("请在全局播放窗口点一下播放（浏览器策略）"); });
      syncGlobalBtn();
      showToast("全局播放已开启：切换页面不会中断音频");
    }).catch(function (e) {
      globalHost = null;
      syncGlobalBtn();
      showToast("全局播放启动失败：" + ((e && e.message) || "未知错误"), "err");
    });
  }

  /* ---------- v9.2 跨页续播 ----------
   * 本站是纯静态多页（MPA）：整份文档在跳转时卸载，<audio> 元素随之销毁，
   * 所以「同一个 Audio 实例跨页存活」在架构上做不到（那需要 SPA 化或
   * 常驻 frameset，两者都会破坏现有路由/SEO）。这里做的是 MPA 下能达到的
   * 最接近方案：把曲目序号 + 播放进度 + 播放态持续落盘，新页面 boot 时
   * 自动恢复到断点并请求续播；若浏览器拦截自动播放，音频已加载且已 seek，
   * 用户点一下播放键即从原位置继续，不会从头开始。
   * 只恢复 10 分钟内的会话，避免隔天打开突然出声。 */
  const MP_RESUME_KEY = "mp_resume_v1";
  let mpResumeSaveAt = 0;
  function mpSaveResume() {
    try {
      safeStorage.set(MP_RESUME_KEY, JSON.stringify({
        idx: currentIdx,
        t: Number(audio.currentTime) || 0,
        playing: !audio.paused && !audio.ended,
        at: Date.now(),
      }));
    } catch (e) { /* 隐私模式：降级为不续播，不影响播放 */ }
  }
  function mpReadResume() {
    try {
      const raw = safeStorage.get(MP_RESUME_KEY);
      if (!raw) return null;
      const r = JSON.parse(raw);
      if (!r || typeof r !== "object") return null;
      return r;
    } catch (e) { return null; }
  }
  audio.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - mpResumeSaveAt < 1500) return; // timeupdate 每 ~250ms 触发，节流写盘
    mpResumeSaveAt = now;
    mpSaveResume();
    // v11.0：同节流窗口内把精确断点广播给同站其他页面（跨页接力）
    mpChannelPost({ type: "progress", state: mpSnapshot() });
  });
  audio.addEventListener("play", mpSaveResume);
  audio.addEventListener("pause", mpSaveResume);
  audio.addEventListener("ended", mpSaveResume);
  /* v12.0 真实缺陷修复：旧逻辑在 pagehide 无条件写 mp_resume_v1。
   * 冷启动页面从未播放（autoplay=false 时 audio.src 为空），一次普通跳转也会
   * 落一条 {playing:false,t:0} 的续播状态，导致下一页误判为「切页接力」而
   * 立即启动播放器，直接抵消 v7.0「首屏关键路径零播放器成本」的优化。 */
  function hasPlayableSession() { return !!audio.src; }
  // pagehide 比 beforeunload 可靠（移动端 / BFCache 场景都会触发），同步落盘
  window.addEventListener("pagehide", () => {
    if (!hasPlayableSession()) return;
    mpSaveResume();
    // 切页瞬间再推一次最精确的进度，把新页面续播的 gap 压到最小
    mpChannelPost({ type: "progress", state: mpSnapshot() });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && hasPlayableSession()) mpSaveResume();
  });

  /* ---------- v11.0 战役三：跨页/跨标签播放仲裁（BroadcastChannel） ----------
   * 物理边界（诚实标注）：本站是纯 MPA，整页导航会卸载文档并销毁 <audio>，
   * 「同一个 Audio 实例跨页存活」在架构上做不到；隐藏 iframe 被本站点
   * X-Frame-Options: DENY + CSP frame-src 'none' / frame-ancestors 'none'
   * 明令禁止，SharedWorker / ServiceWorker 全局没有 HTMLMediaElement 更不能
   * 播放音频。字面意义的「零中断」只能 SPA 化或整站 iframe 外壳化，
   * 两者都违反「严禁推倒重来、在原有代码基础上优化」的底线。
   *
   * 因此在 MPA 约束下拿到三件实事：
   *  1) 单实例仲裁：任一页面开始播放，其他正在播放的页面立即让位，
   *     杜绝「开了 3 个标签同时响」——全局播放器的核心体验。
   *  2) 精确断点接力：播放页持续广播 {idx,t,playing,at}，其他页把它写入
   *     本地 resume；旧页被系统回收/崩溃时，新页仍能拿到 1.5s 内的精确
   *     断点，把续播 gap 压到最小（现有 localStorage 续播的增强，不替换）。
   *  3) Media Session 全动作（见 updateMediaSession）：锁屏/耳机可拖进度、
   *     快进快退、停止，OS 媒体中心完整接管。
   *
   * 全程能力探测 + try/catch：BroadcastChannel 不可用（隐私模式/旧浏览器/
   * 测试环境）时静默降级，绝不因增强功能让音乐播不出来。 */
  const MP_CHANNEL_NAME = "mp_global_v11";
  const MP_CLIENT_ID = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  let mpChannel = null;
  let mpSelfPlaying = false;

  function mpSnapshot() {
    // currentIdx / playlist 在下方初始化，但本函数只在事件回调里被调用，
    // 运行时早已就绪（不在模块顶层同步访问，无 TDZ 风险）。
    return { idx: currentIdx, t: Number(audio.currentTime) || 0, playing: mpSelfPlaying, at: Date.now() };
  }
  function mpChannelPost(msg) {
    if (!mpChannel) return;
    try { mpChannel.postMessage(Object.assign({ from: MP_CLIENT_ID }, msg)); } catch (e) { /* 通道已关闭 */ }
  }
  /** 采纳其它页面广播来的精确状态，落到本地断点（等价 mpSaveResume，数据更准） */
  function mpAdoptRemoteState(s) {
    if (!s || !Number.isInteger(s.idx) || s.idx < 0) return;
    try {
      safeStorage.set(MP_RESUME_KEY, JSON.stringify({
        idx: s.idx, t: Number(s.t) || 0, playing: !!s.playing, at: Number(s.at) || Date.now(),
      }));
    } catch (e) { /* 隐私模式 */ }
  }
  function initGlobalArbitration() {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      mpChannel = new BroadcastChannel(MP_CHANNEL_NAME);
      mpChannel.onmessage = (e) => {
        const m = e.data;
        if (!m || m.from === MP_CLIENT_ID) return; // 忽略自己（BroadcastChannel 本就不回派，双保险）
        if (m.type === "claim") {
          // 别的页面开始播放 → 本页让位，保证全站只有一个声音
          if (!audio.paused) {
            audio.pause();
            syncPlayUI();
            mpAdoptRemoteState(m.state);
          }
        } else if (m.type === "progress") {
          // 本页未在播放：帮播放页接力保存精确断点，不抢播、不改自身状态
          if (audio.paused) mpAdoptRemoteState(m.state);
        } else if (m.type === "hello" && !audio.paused) {
          // 新页面入场询问：告知它「已有实例在播」并附精确状态
          mpChannelPost({ type: "progress", state: mpSnapshot() });
        }
      };
    } catch (e) { mpChannel = null; }
    audio.addEventListener("play", () => {
      mpSelfPlaying = true;
      // 自动续播 / ended 自动切歌只发 progress，绝不发 claim：
      // 否则两个页面会因循环自动切歌互相抢播（真实浏览器复现过）。
      mpChannelPost({ type: "progress", state: mpSnapshot() });
    });
    audio.addEventListener("pause", () => { mpSelfPlaying = false; });
    // 本页入场：询问是否已有播放中的实例（有则它会回 progress，新页不抢播）
    mpChannelPost({ type: "hello" });
  }

  // ---- 状态 ----
  let playlist = [];
  let currentIdx = 0;
  let loadToken = 0;            // 切歌竞态防护
  let consecutiveErrors = 0;    // 连续加载失败计数，防止全部失效时无限切换
  let pendingSwitch = null;     // 加载失败后的"自动切下一首"定时器（手动切歌时取消）
  let seeking = false;          // 进度条拖动中（拖动期间忽略 timeupdate）
  let lastProgressUpdate = 0;
  let volumeBeforeMute = 0.7;   // 静音前音量，用于恢复
  let currentObjectUrl = null;  // 当前 Blob 对象 URL（切歌时 revoke 防泄漏）

  const { escapeHtml, safeStorage, $, formatTime, isHttpUrl, isDeadSampleUrl } = window.BlogUtils;

  // 播放模式：sequence 顺序播放 / listLoop 列表循环 / singleLoop 单曲循环 / shuffle 随机
  const MODES = ["listLoop", "singleLoop", "shuffle", "sequence"];
  const MODE_META = {
    listLoop:  { icon: "🔁", title: "列表循环" },
    singleLoop:{ icon: "🔂", title: "单曲循环" },
    shuffle:   { icon: "🔀", title: "随机播放" },
    sequence:  { icon: "➡️", title: "顺序播放" },
  };
  let playMode = "listLoop";
  let shuffleOrder = [];        // 随机模式下的播放顺序（索引数组）
  let shufflePos = 0;

  // ---- UI 同步 ----
  /** 同步播放/暂停按钮、封面态与系统媒体中心（锁屏/通知栏）状态 */
  function syncPlayUI(forcePlaying) {
    // v12.0：远程模式下本地 audio 恒为暂停，由全局窗口状态覆盖按钮文案
    const playing = typeof forcePlaying === "boolean"
      ? forcePlaying : (!audio.paused && !audio.ended);
    const playBtn = $("mpPlay");
    if (playBtn) {
      playBtn.textContent = playing ? "⏸" : "▶";
      playBtn.title = playing ? "暂停" : "播放";
      playBtn.setAttribute("aria-label", playing ? "暂停" : "播放");
    }
    const cover = $("mpCover");
    if (cover) cover.classList.toggle("mp-cover-playing", playing);
    // 同步系统媒体中心状态（锁屏/通知栏的播放状态图标）
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (e) { /* 忽略 */ }
    }
  }

  /** 同步进度条宽度、当前时间文字与 aria-valuenow（无障碍） */
  function syncProgressUI() {
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    const pct = dur > 0 ? (audio.currentTime / dur) * 100 : 0;
    $("mpProgressBar").style.width = pct + "%";
    $("mpCurrent").textContent = formatTime(audio.currentTime);
    const bar = $("mpProgress");
    bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  /** 同步缓冲进度条（audio.buffered 末端 / 总时长） */
  function syncBufferUI() {
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    if (dur <= 0 || !audio.buffered.length) return;
    const end = audio.buffered.end(audio.buffered.length - 1);
    $("mpProgressBuffer").style.width = Math.min(100, (end / dur) * 100) + "%";
  }

  /** 渲染播放模式按钮图标与 aria 标签 */
  function renderModeBtn() {
    const meta = MODE_META[playMode] || MODE_META.listLoop;
    const btn = $("mpMode");
    btn.textContent = meta.icon;
    btn.title = `播放模式：${meta.title}（点击切换）`;
    btn.setAttribute("aria-label", `播放模式：${meta.title}，点击切换`);
    btn.classList.add("mp-mode-active");
  }

  /** 循环切换四种播放模式并持久化 */
  function cycleMode() {
    const i = MODES.indexOf(playMode);
    playMode = MODES[(i + 1) % MODES.length];
    safeStorage.set("mp_mode", playMode);
    renderModeBtn();
    showToast(`播放模式：${MODE_META[playMode].title}`);
  }

  // ---- 轻提示 ----
  function showToast(msg) {
    // 轻提示：委托全站统一实现（js/utils.js），不再自管定时器
    window.BlogUtils.toast(msg);
    }

  // ---- 播放核心 ----
  /**
   * 加载并（可选）播放指定索引歌曲。
   * 音频管道：fetch → Blob → objectURL（绕过 <audio src> 不走 SW 的限制，
   * 断网可播）；跨域外链直连，避免无 CORS 头时必然失败。
   * loadToken 防止快速切歌时的旧回调覆盖新状态。
   */
  function loadSong(idx, autoplay) {
    if (!playlist.length) return;
    if (inRemote()) {
      // 远程模式：播放列表点击 → 让全局窗口切歌，本地 audio 保持暂停
      currentIdx = ((idx % playlist.length) + playlist.length) % playlist.length;
      globalHost.load(currentIdx, !!autoplay, 0).catch(function () {});
      renderPlaylist();
      return;
    }
    // 手动/自动切歌：取消尚未触发的"失败后自动切换"，避免连跳两首
    if (pendingSwitch) { clearTimeout(pendingSwitch); pendingSwitch = null; }
    const myToken = ++loadToken;
    currentIdx = ((idx % playlist.length) + playlist.length) % playlist.length;
    const song = playlist[currentIdx];
    if (!song) return;

    // 随机模式：把 shufflePos 对齐到当前歌曲位置
    if (playMode === "shuffle") {
      const p = shuffleOrder.indexOf(currentIdx);
      if (p >= 0) shufflePos = p;
    }

    // 音频加载管道：fetch → Blob → objectURL。
    // 为什么不能直接 audio.src = song.url：Chromium 的 <audio src> 媒体请求
    // 不经过 Service Worker，SW 缓存形同虚设、断网必挂；fetch 走 SW，
    // 同源或经 /api/github/raw/* 代理的资源可缓存、可离线播放。
    // 仅对同源资源走管道：跨域外链（无 CORS 头）fetch 必然失败，
    // 且 SW 也不缓存跨域资源，直连即可，避免每次切歌刷 CORS 报错。
    // autoplay=false 时不预下载（首屏不抢流量；用户点播放时走
    // togglePlay 的 !audio.src 分支以 autoplay=true 重新进入本函数）。
    let sameOrigin = false;
    try { sameOrigin = new URL(song.url, location.href).origin === location.origin; } catch (e) {}
    if (autoplay) {
      const playAfterLoad = () => {
        if (myToken !== loadToken) return;
        audio.play().then(syncPlayUI).catch(() => {
          if (myToken !== loadToken) return;
          syncPlayUI();
          $("mpArtist").textContent = "浏览器阻止了自动播放，请点击播放按钮";
        });
      };
      if (sameOrigin) {
        if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
        fetch(song.url)
          .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
          .then((blob) => {
            if (myToken !== loadToken) return;
            currentObjectUrl = URL.createObjectURL(blob);
            audio.src = currentObjectUrl;
            playAfterLoad();
          })
          .catch(() => {
            if (myToken !== loadToken) return;
            // 兜底：同源但网络异常/SW 未就绪时直连（在线可播）
            audio.src = song.url;
            playAfterLoad();
          });
      } else {
        // 跨域外链：直接赋值（在线可播；SW 不缓存跨域，无离线损失）
        audio.src = song.url;
        playAfterLoad();
      }
    }
    // 重置进度 UI，避免上一首的进度/时长残留
    $("mpProgressBar").style.width = "0%";
    $("mpProgressBuffer").style.width = "0%";
    $("mpCurrent").textContent = "0:00";
    $("mpDuration").textContent = "0:00";
    $("mpProgress").removeAttribute("data-ready");
    $("mpTitle").textContent = song.title || "未知歌曲";
    $("mpArtist").textContent = song.artist || "未知歌手";

    const coverEl = $("mpCover");
    /* v8.1：跳过 IANA 保留示例域名（example.com 等）。
     * 后台示例数据的封面常是 https://example.com/cover.jpg，请求必失败，
     * 实测每页白扔 600~1900ms。这类 URL 不必发请求，直接用音符图标降级。
     * 真实图片仍走 onerror → 🎵 的原有兜底，行为不变。 */
    if (song.cover && isHttpUrl(song.cover) && !isDeadSampleUrl(song.cover)) {
      const img = document.createElement("img");
      img.src = song.cover;
      img.alt = "";
      /* 封面有自己的降级（回退 🎵 图标），且占位图对封面无意义，
       * 因此标记让 utils/common.js 的全局兜底不要插手。 */
      img.dataset.noFallback = "1";
      img.onerror = function () {
        if (myToken !== loadToken) return;
        coverEl.innerHTML = "";
        coverEl.textContent = "🎵";
      };
      coverEl.innerHTML = "";
      coverEl.appendChild(img);
    } else {
      coverEl.innerHTML = "";
      coverEl.textContent = "🎵";
    }

    renderPlaylist();
    // v12.0：切歌时重置歌词轴；updateMediaSession 先写歌名，随后 timeupdate
    // 的 applyLrcMetadata() 会把当前歌词行写进锁屏标题
    setLrc(song);
    lastLrcLine = "";
    updateMediaSession(song);

    if (!autoplay) syncPlayUI(); // 音频未加载：仅刷新 UI，等用户点击播放
  }

  /** 播放/暂停切换 */
  function togglePlay() {
    if (!playlist.length) {
      showToast("播放列表为空，请先到后台添加音乐");
      return;
    }
    if (inRemote()) {
      globalHost.getState().then(function (s) {
        return s && s.paused ? globalHost.play() : globalHost.pause();
      }).then(function (s) { if (s) { syncPlayUI(!s.paused); syncRemotePosition(s); } })
        .catch(function () { showToast("全局播放窗口无响应", "err"); });
      return;
    }
    if (audio.paused) {
      // v11.0：用户主动点击播放 = 明确接管意图，广播 claim 让其他页面让位。
      // 只在用户手势路径发 claim（自动续播/自动切歌走 progress），杜绝抢播循环。
      mpChannelPost({ type: "claim", state: mpSnapshot() });
      if (!audio.src) { loadSong(currentIdx, true); return; }
      audio.play().then(syncPlayUI).catch(() => {
        syncPlayUI();
        $("mpArtist").textContent = songArtist() || "播放失败";
      });
    } else {
      audio.pause();
      syncPlayUI();
    }
  }
  /** 取当前歌曲艺术家（缺失时回退 "未知艺术家"） */
  function songArtist() {
    const s = playlist[currentIdx];
    return s ? (s.artist || "") : "";
  }

  /** 生成随机播放顺序索引数组 */
  function buildShuffleOrder() {
    shuffleOrder = playlist.map((_, i) => i).filter(i => i !== currentIdx);
    // Fisher-Yates 洗牌
    for (let i = shuffleOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]];
    }
    shufflePos = -1; // 下一次取 order[0]
  }

  // 返回下一个索引；无下一首返回 -1
  /** 按当前播放模式计算下一首索引 */
  function pickNextIndex() {
    if (playlist.length === 0) return -1;
    if (playlist.length === 1) return 0;
    switch (playMode) {
      case "singleLoop":
        return currentIdx;
      case "shuffle": {
        if (shufflePos + 1 < shuffleOrder.length) {
          shufflePos++;
        } else {
          buildShuffleOrder();
          shufflePos = 0;
        }
        return shuffleOrder[shufflePos];
      }
      case "sequence":
        return currentIdx + 1 < playlist.length ? currentIdx + 1 : -1;
      case "listLoop":
      default:
        return (currentIdx + 1) % playlist.length;
    }
  }

  /** 按当前播放模式计算上一首索引 */
  function pickPrevIndex() {
    if (playlist.length === 0) return -1;
    if (playlist.length === 1) return 0;
    switch (playMode) {
      case "singleLoop":
        return currentIdx;
      case "shuffle":
        if (shufflePos > 0) { shufflePos--; return shuffleOrder[shufflePos]; }
        return (currentIdx - 1 + playlist.length) % playlist.length;
      default:
        return (currentIdx - 1 + playlist.length) % playlist.length;
    }
  }

  function nextSong() {
    if (inRemote()) { globalHost.next().catch(function () {}); return; }
    const idx = pickNextIndex();
    if (idx < 0) { // 顺序播放到末尾：停止
      audio.pause();
      syncPlayUI();
      showToast("播放列表已播完");
      return;
    }
    loadSong(idx, true);
  }

  function prevSong() {
    if (inRemote()) { globalHost.prev().catch(function () {}); return; }
    const idx = pickPrevIndex();
    if (idx >= 0) loadSong(idx, true);
  }

  // ---- 系统媒体控制（锁屏 / 耳机按键 / 通知栏）----
  /**
   * v11.0 战役三：把锁屏控制从「4 个按钮」补全为「全动作 + 进度条」。
   * 逐条 setActionHandler 独立 try/catch：Safari/旧 Chromium 只支持部分动作，
   * 某个动作抛错不能让整块注册失败（历史 bug：一个 try 包全部动作，
   * 遇到不支持的 seekto 会连 play/pause 一起丢掉）。
   */
  function msAction(name, fn) {
    try {
      navigator.mediaSession.setActionHandler(name, function (d) {
        if (!inRemote()) return fn(d);
        // v12.0 远程模式：锁屏/耳机按键必须控制全局窗口，而不是已暂停的本地 audio
        var H = globalHost;
        switch (name) {
          case "play": return H.play().catch(function () {});
          case "pause": return H.pause();
          case "stop": return H.pause().then(function () { return H.seek(0); });
          case "previoustrack": return H.prev();
          case "nexttrack": return H.next();
          case "seekbackward":
            return H.getState().then(function (s) {
              return H.seek((Number(s.currentTime) || 0) - ((d && d.seekOffset) || 10));
            }).catch(function () {});
          case "seekforward":
            return H.getState().then(function (s) {
              return H.seek((Number(s.currentTime) || 0) + ((d && d.seekOffset) || 10));
            }).catch(function () {});
          case "seekto": return (d && typeof d.seekTime === "number") ? H.seek(d.seekTime) : null;
          default: return null;
        }
      });
    } catch (e) { /* 该动作不支持 */ }
  }
  /** 锁屏进度条：duration/position/playbackRate 三件套，拖动进度由 seekto 回写 */
  function syncMediaPosition() {
    if (inRemote()) return; // 远程模式由 syncRemotePosition(st) 接管
    if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    if (dur <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: Math.min(audio.currentTime || 0, dur),
        playbackRate: audio.playbackRate || 1,
      });
    } catch (e) { /* 部分实现要求 duration > position，忽略 */ }
  }
  /** 更新系统媒体中心元数据（标题/艺术家/封面，锁屏可见）+ 全部动作 */
  function updateMediaSession(song) {
    if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title || "未知歌曲",
        artist: song.artist || "未知歌手",
        album: "我的博客",
        // v8.1：artwork 同样会触发一次网络请求，示例域名一并跳过
        artwork: song.cover && isHttpUrl(song.cover) && !isDeadSampleUrl(song.cover)
          ? [{ src: song.cover, sizes: "512x512", type: "image/jpeg" }]
          : [],
      });
    } catch (e) { /* metadata 不支持 */ }
    msAction("play", () => audio.play().then(syncPlayUI));
    msAction("pause", () => { audio.pause(); syncPlayUI(); });
    msAction("previoustrack", prevSong);
    msAction("nexttrack", nextSong);
    msAction("stop", () => { audio.pause(); try { audio.currentTime = 0; } catch (e) {} syncPlayUI(); });
    msAction("seekbackward", (d) => seekBy(-((d && d.seekOffset) || 10)));
    msAction("seekforward", (d) => seekBy(((d && d.seekOffset) || 10)));
    msAction("seekto", (d) => {
      if (!d || typeof d.seekTime !== "number") return;
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      try { audio.currentTime = Math.max(0, Math.min(audio.duration, d.seekTime)); } catch (e) {}
      syncProgressUI();
      syncMediaPosition();
    });
    syncMediaPosition();
  }

  // ---- 播放列表 ----
  /** 渲染播放列表（当前曲高亮，点击切歌） */
  function renderPlaylist() {
    const el = $("mpPlaylistItems");
    $("mpPlaylistCount").textContent = playlist.length ? `${playlist.length} 首` : "";
    if (!playlist.length) {
      el.innerHTML = '<div style="padding:24px;text-align:center;color: var(--text-mute, #6b7280);font-size:13px">暂无歌曲</div>';
      return;
    }
    el.innerHTML = playlist.map((s, i) => `
      <div class="mp-playlist-item ${i === currentIdx ? "active" : ""}" data-idx="${i}" role="button" tabindex="0">
        <span class="mp-playlist-item-num">${i === currentIdx ? "" : i + 1}</span>
        <span class="mp-playlist-item-eq"><span class="mp-eq-bar"></span><span class="mp-eq-bar"></span><span class="mp-eq-bar"></span></span>
        <div class="mp-playlist-item-body">
          <div class="mp-playlist-item-title">${escapeHtml(s.title || "未知歌曲")}${s.source === "github" ? '<span class="mp-src-badge" title="来自 GitHub 仓库目录">🐙</span>' : ""}</div>
          <div class="mp-playlist-item-artist">${escapeHtml(s.artist || "")}</div>
        </div>
      </div>
    `).join("");
    // 当前项滚动到可见区域
    const active = el.querySelector(".mp-playlist-item.active");
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  // ---- 音量 / 静音 ----
  /** 渲染音量条与静音按钮状态 */
  function renderVolumeUI() {
    const vol = audio.volume;
    const muted = audio.muted || vol === 0;
    $("mpMute").textContent = muted ? "🔇" : (vol < 0.5 ? "🔉" : "🔊");
    $("mpMute").title = muted ? "取消静音" : "静音";
    if (!muted) volumeBeforeMute = vol;
    $("mpVolume").value = String(Math.round(vol * 100));
  }

  /** 静音切换（记住静音前音量便于恢复） */
  function toggleMute() {
    if (audio.muted || audio.volume === 0) {
      audio.muted = false;
      audio.volume = volumeBeforeMute || 0.7;
    } else {
      volumeBeforeMute = audio.volume;
      audio.muted = true;
    }
    safeStorage.set("mp_volume", String(audio.volume));
    renderVolumeUI();
  }

  // ---- 收起 / 展开 ----
  /** 播放器收起/展开（状态持久化） */
  function togglePlayer() {
    const player = $("mpPlayer");
    const hidden = player.classList.toggle("mp-hidden");
    document.body.classList.toggle("mp-body-hidden", hidden);
    safeStorage.set("mp_hidden", hidden ? "1" : "0");
  }

  // ---- 进度条拖动 ----
  function seekFromEvent(e) {
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    if (dur <= 0) return;
    const rect = $("mpProgress").getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    $("mpProgressBar").style.width = (pct * 100) + "%";
    $("mpCurrent").textContent = formatTime(pct * dur);
    return pct * dur;
  }

  // ===== 事件绑定 =====

  // audio 状态事件：以元素自身状态为准，避免竞态
  audio.addEventListener("play", syncPlayUI);
  audio.addEventListener("pause", syncPlayUI);
  // 真正开始播放即认为加载链路恢复：清零连续失败计数，
  // 否则手动切歌成功后残留计数会叠加，最终误判"全部失败"
  audio.addEventListener("playing", () => { consecutiveErrors = 0; });
  audio.addEventListener("ended", () => {
    consecutiveErrors = 0;
    if (playMode === "singleLoop") {
      audio.currentTime = 0;
      audio.play().then(syncPlayUI).catch(syncPlayUI);
      return;
    }
    nextSong();
  });

  audio.addEventListener("timeupdate", () => {
    if (seeking) return; // 拖动中不被覆盖
    const now = Date.now();
    if (now - lastProgressUpdate < 250) return;
    lastProgressUpdate = now;
    syncProgressUI();
    // v11.0：锁屏进度条跟随（已有 250ms 节流，不额外增加调用频率）
    syncMediaPosition();
    // v12.0：锁屏逐行歌词（同一节流窗口，不增加调用频率）
    applyLrcMetadata();
  });

  audio.addEventListener("progress", syncBufferUI);
  audio.addEventListener("loadedmetadata", () => {
    $("mpDuration").textContent = formatTime(audio.duration);
    $("mpProgress").setAttribute("data-ready", "1");
    syncBufferUI();
    // v11.0：元数据就绪后锁屏才能显示总时长/进度条
    syncMediaPosition();
  });
  audio.addEventListener("durationchange", () => {
    $("mpDuration").textContent = formatTime(audio.duration);
  });

  audio.addEventListener("error", () => {
    consecutiveErrors++;
    if (consecutiveErrors >= Math.max(2, playlist.length)) {
      // 全部歌曲都加载失败：停止切换，给出明确提示
      if (pendingSwitch) { clearTimeout(pendingSwitch); pendingSwitch = null; }
      audio.pause();
      syncPlayUI();
      $("mpArtist").textContent = "歌曲加载失败，请检查网络或后台音乐链接";
      showToast("所有歌曲加载失败");
      return;
    }
    $("mpArtist").textContent = `加载失败，自动切换下一首（${consecutiveErrors}/${playlist.length}）`;
    // 登记定时器：用户在此期间手动切歌/操作时取消，避免跳两首
    if (pendingSwitch) clearTimeout(pendingSwitch);
    pendingSwitch = setTimeout(() => {
      pendingSwitch = null;
      if (consecutiveErrors > 0) nextSong();
    }, 1500);
  });

  $("mpToggle").addEventListener("click", togglePlayer);
  $("mpPlay").addEventListener("click", togglePlay);
  $("mpPrev").addEventListener("click", prevSong);
  $("mpNext").addEventListener("click", nextSong);
  $("mpMode").addEventListener("click", cycleMode);
  $("mpMute").addEventListener("click", toggleMute);
  // v12.0 战役一：全局播放（独立窗口切页不断播 / 隐藏 iframe 解耦）
  $("mpGlobal").addEventListener("click", toggleGlobal);
  syncGlobalBtn();

  // 进度条：点击 + 拖动（pointer events，兼容触摸）
  const progressEl = $("mpProgress");
  let pendingSeek = null;      // null = 本次拖动尚未产生有效目标位置
  progressEl.addEventListener("pointerdown", (e) => {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    e.preventDefault();
    seeking = true;
    progressEl.classList.add("mp-seeking");
    try { progressEl.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无真实指针时忽略 */ }
    const t = seekFromEvent(e);
    if (t !== undefined) pendingSeek = t;
  });
  progressEl.addEventListener("pointermove", (e) => {
    if (!seeking) return;
    const t = seekFromEvent(e);
    if (t !== undefined) pendingSeek = t;
  });
  const endSeek = () => {
    if (!seeking) return;
    seeking = false;
    progressEl.classList.remove("mp-seeking");
    // 判 null 而非 > 0：允许拖到 0 秒（开头）
    if (pendingSeek !== null) {
      try { audio.currentTime = pendingSeek; } catch (e) {}
    }
    pendingSeek = null;
    syncProgressUI();
  };
  progressEl.addEventListener("pointerup", endSeek);
  progressEl.addEventListener("pointercancel", endSeek);

  $("mpVolume").addEventListener("input", (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    audio.volume = v / 100;
    audio.muted = false;
    safeStorage.set("mp_volume", String(audio.volume));
    renderVolumeUI();
  });

  $("mpListBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("mpPlaylist").classList.toggle("active");
  });

  // 播放列表点击（事件委托）
  $("mpPlaylistItems").addEventListener("click", (e) => {
    const item = e.target.closest(".mp-playlist-item");
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    if (isNaN(idx) || idx < 0 || idx >= playlist.length) return;
    loadSong(idx, true);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#mpPlaylist") && !e.target.closest("#mpListBtn")) {
      $("mpPlaylist").classList.remove("active");
    }
  });

  // 键盘快捷键（避开输入类元素与聚焦中的按钮；游戏进行中时让位给游戏；
  // 相册灯箱打开时让位给灯箱导航，否则方向键会同时切图和拖动音乐进度）
  document.addEventListener("keydown", (e) => {
    if (window.GameCore && window.GameCore.isGameRunning && window.GameCore.isGameRunning()) return;
    if (document.querySelector(".lightbox.active")) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
    if (e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.code) {
      case "Space":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        if (e.shiftKey) { e.preventDefault(); prevSong(); }
        else { seekBy(-5); }
        break;
      case "ArrowRight":
        if (e.shiftKey) { e.preventDefault(); nextSong(); }
        else { seekBy(5); }
        break;
      case "ArrowUp":
        e.preventDefault();
        audio.volume = Math.min(1, audio.volume + 0.05);
        audio.muted = false;
        safeStorage.set("mp_volume", String(audio.volume));
        renderVolumeUI();
        break;
      case "ArrowDown":
        e.preventDefault();
        audio.volume = Math.max(0, audio.volume - 0.05);
        safeStorage.set("mp_volume", String(audio.volume));
        renderVolumeUI();
        break;
      case "KeyM":
        toggleMute();
        break;
    }
  });

  /** 快进/快退 delta 秒 */
  function seekBy(delta) {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
    } catch (e) {}
    syncProgressUI();
  }

  // ---- 加载音乐列表 ----
  /** 拉取歌单（/api/music）并做 URL 三重校验，过滤坏链 */
  async function loadMusic() {
    try {
      const res = await fetch("/api/music");
      if (!res.ok) {
        $("mpArtist").textContent = "音乐列表加载失败";
        renderPlaylist();
        return;
      }
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      // 链接三重校验：http(s) 绝对外链、/ 开头同源相对路径（/api/github/raw/*
      // 代理资源，可经 SW 缓存离线播放）均接受；拒绝 data: 等伪协议
      /* v7.3 Clean Code：URL 协议校验复用 BlogUtils.isHttpUrl（相对路径放行供站内音乐） */
      const okUrl = (u) => {
        const s = String(u || "").trim();
        return isHttpUrl(s) || s.startsWith("/");
      };
      playlist = data.filter(s => s && s.url && okUrl(s.url));
      if (playlist.length) {
        const r = mpReadResume();
        const fresh = r && Date.now() - (Number(r.at) || 0) < 10 * 60 * 1000;
        if (r && r.playing && fresh && Number.isInteger(r.idx) && r.idx >= 0 && r.idx < playlist.length) {
          // 断点续播：音频元数据就绪后 seek 回原位置；loadSong 会请求自动播放，
          // 若被浏览器策略拦截，用户点播放键即从该位置继续（不会从头开始）。
          const seekTo = Math.max(0, Number(r.t) || 0);
          const seekOnce = () => {
            audio.removeEventListener("loadedmetadata", seekOnce);
            try { if (isFinite(audio.duration)) audio.currentTime = Math.min(seekTo, Math.max(0, audio.duration - 0.25)); }
            catch (e) { /* 元数据尚未就绪：忽略，下次交互自然继续 */ }
          };
          audio.addEventListener("loadedmetadata", seekOnce);
          loadSong(r.idx, true);
        } else {
          loadSong(0, false);
        }
      } else {
        $("mpTitle").textContent = "暂无歌曲";
        $("mpArtist").textContent = "去管理后台添加音乐吧";
        $("mpCover").textContent = "🎵";
        renderPlaylist();
      }
    } catch (e) {
      $("mpArtist").textContent = "音乐列表加载失败";
      renderPlaylist();
    }
  }

  // ---- 初始化 ----
  // 恢复播放模式
  const savedMode = safeStorage.get("mp_mode");
  if (savedMode && MODE_META[savedMode]) playMode = savedMode;
  renderModeBtn();

  // 恢复音量（默认 0.7）
  audio.volume = 0.7;
  const savedVol = safeStorage.get("mp_volume");
  if (savedVol !== null) {
    const v = parseFloat(savedVol);
    if (!isNaN(v) && v >= 0 && v <= 1) audio.volume = v;
  }
  renderVolumeUI();

  // 恢复收起状态
  if (safeStorage.get("mp_hidden") === "1") {
    $("mpPlayer").classList.add("mp-hidden");
    document.body.classList.add("mp-body-hidden");
  }

  renderPlaylist();
  syncPlayUI();
  loadMusic();
  // v11.0：最后启动跨页仲裁（能力探测降级，绝不阻断上面的既有初始化）
  try { initGlobalArbitration(); } catch (e) { /* 增强功能失败不影响播放 */ }
})();
};

/* v7.0 基线：冷启动走空闲，首屏关键路径零播放器成本。
 * v12.0 战役一「接力零感知化」：旧逻辑一律 requestIdleCallback(timeout 1200)，
 * 意味着 MPA 切页后最多要等 1.2s 才创建 <audio>、载入曲目并 seek 回断点，
 * 静默间隙肉眼可感。若本地存在 10 分钟内的续播状态，说明这次是「切页接力」
 * 而不是冷启动，改为 DOMContentLoaded 立即启动，把间隙压缩到首帧；
 * 冷启动行为逐字节不变。具体是否真的续播仍由 loadMusic() 的既有判定决定。 */
function hasRecentResume() {
  try {
    var raw = localStorage.getItem("mp_resume_v1");
    if (!raw) return false;
    var r = JSON.parse(raw);
    return !!r && typeof r === "object" && Date.now() - (Number(r.at) || 0) < 10 * 60 * 1000;
  } catch (e) { return false; }
}
if (hasRecentResume()) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootMusicPlayer, { once: true });
  } else {
    bootMusicPlayer();
  }
} else if (typeof requestIdleCallback === "function") {
  requestIdleCallback(bootMusicPlayer, { timeout: 1200 });
} else {
  setTimeout(bootMusicPlayer, 0);
}
