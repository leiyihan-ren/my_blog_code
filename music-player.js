// 音乐播放器组件 - 自动注入到页面底部
// 版本：v2（播放模式 / 拖动进度 / 系统媒体控制 / 状态机重构）
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
    transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
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
    color: var(--primary, #4f46e5);
    border-top: 1px solid var(--border, #eaecef);
    border-left: 1px solid var(--border, #eaecef);
    border-right: 1px solid var(--border, #eaecef);
    transition: background 0.2s;
  }
  .mp-toggle-btn:hover {
    background: var(--primary, #4f46e5);
    color: white;
  }
  .mp-toggle-btn .mp-toggle-icon {
    transition: transform 0.3s;
  }
  .mp-player.mp-hidden .mp-toggle-btn .mp-toggle-icon {
    transform: rotate(180deg);
  }
  .mp-cover {
    width: 48px; height: 48px;
    border-radius: 10px;
    background: linear-gradient(135deg, #667eea, #764ba2);
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
    transition: transform 0.3s;
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
    color: var(--text-mute, #999);
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
    transition: height 0.15s;
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
    transition: transform 0.15s;
  }
  .mp-progress:hover .mp-progress-bar::after,
  .mp-progress.mp-seeking .mp-progress-bar::after {
    transform: translateY(-50%) scale(1);
  }
  .mp-time {
    font-size: 11px;
    color: var(--text-mute, #999);
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
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
  }
  .mp-btn:hover {
    background: var(--primary, #4f46e5);
    color: white;
  }
  .mp-btn:active { transform: scale(0.92); }
  .mp-play {
    width: 40px; height: 40px;
    background: var(--primary, #4f46e5);
    color: white;
    font-size: 16px;
  }
  .mp-play:hover {
    background: #4338ca;
  }
  /* 播放模式按钮激活态 */
  .mp-mode-btn.mp-mode-active {
    color: var(--primary, #4f46e5);
    background: rgba(79,70,229,0.12);
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
    color: var(--text-mute, #999);
  }
  .mp-playlist-item {
    padding: 12px 18px;
    cursor: pointer;
    transition: background 0.15s;
    border-bottom: 1px solid var(--border, #eaecef);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mp-playlist-item:last-child { border-bottom: none; }
  .mp-playlist-item:hover { background: var(--item-bg, #f9fafb); }
  .mp-playlist-item.active {
    background: rgba(79,70,229,0.1);
    color: var(--primary, #4f46e5);
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
  .mp-playlist-item-artist {
    font-size: 12px;
    color: var(--text-mute, #999);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mp-playlist-item.active .mp-playlist-item-artist { color: var(--primary, #4f46e5); }
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
    color: var(--text-mute, #999);
    width: 16px;
    text-align: center;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  /* 给页面底部留空间（默认 padding-bottom 已在各页面静态 CSS 中声明，避免 CLS） */
  body.mp-body-hidden { padding-bottom: 28px; }

  /* ---- 响应式 ---- */
  @media (max-width: 1023px) {
    /* 平板/手机：音量滑块隐藏，但保留静音按钮 */
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
    <div class="mp-cover" id="mpCover">🎵</div>
    <div class="mp-info">
      <div class="mp-title" id="mpTitle">暂无歌曲</div>
      <div class="mp-artist" id="mpArtist">去管理后台添加音乐吧</div>
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

  // ---- 状态 ----
  let playlist = [];
  let currentIdx = 0;
  let loadToken = 0;            // 切歌竞态防护
  let consecutiveErrors = 0;    // 连续加载失败计数，防止全部失效时无限切换
  let pendingSwitch = null;     // 加载失败后的"自动切下一首"定时器（手动切歌时取消）
  let seeking = false;          // 进度条拖动中（拖动期间忽略 timeupdate）
  let lastProgressUpdate = 0;
  let volumeBeforeMute = 0.7;   // 静音前音量，用于恢复

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

  const $ = id => document.getElementById(id);

  // 安全的 localStorage 读写（隐私模式下不抛错）
  const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} },
  };

  function formatTime(s) {
    if (!isFinite(s) || isNaN(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  // HTML 转义：同时转义引号，属性位置也安全
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML.replace(/"/g, "&quot;");
  }

  // ---- UI 同步 ----
  function syncPlayUI() {
    const playing = !audio.paused && !audio.ended;
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

  function syncProgressUI() {
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    const pct = dur > 0 ? (audio.currentTime / dur) * 100 : 0;
    $("mpProgressBar").style.width = pct + "%";
    $("mpCurrent").textContent = formatTime(audio.currentTime);
    const bar = $("mpProgress");
    bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  function syncBufferUI() {
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    if (dur <= 0 || !audio.buffered.length) return;
    const end = audio.buffered.end(audio.buffered.length - 1);
    $("mpProgressBuffer").style.width = Math.min(100, (end / dur) * 100) + "%";
  }

  function renderModeBtn() {
    const meta = MODE_META[playMode] || MODE_META.listLoop;
    const btn = $("mpMode");
    btn.textContent = meta.icon;
    btn.title = `播放模式：${meta.title}（点击切换）`;
    btn.setAttribute("aria-label", `播放模式：${meta.title}，点击切换`);
    btn.classList.add("mp-mode-active");
  }

  function cycleMode() {
    const i = MODES.indexOf(playMode);
    playMode = MODES[(i + 1) % MODES.length];
    safeStorage.set("mp_mode", playMode);
    renderModeBtn();
    showToast(`播放模式：${MODE_META[playMode].title}`);
  }

  // ---- 轻提示（复用各页面 toast 则降级为控制台）----
  function showToast(msg) {
    const toast = $("toast");
    if (toast && typeof window.showToast === "function") {
      window.showToast(msg);
    } else if (toast) {
      toast.textContent = msg;
      toast.classList.add("show");
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => toast.classList.remove("show"), 2000);
    }
  }

  // ---- 播放核心 ----
  function loadSong(idx, autoplay) {
    if (!playlist.length) return;
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

    audio.src = song.url;
    // 重置进度 UI，避免上一首的进度/时长残留
    $("mpProgressBar").style.width = "0%";
    $("mpProgressBuffer").style.width = "0%";
    $("mpCurrent").textContent = "0:00";
    $("mpDuration").textContent = "0:00";
    $("mpProgress").removeAttribute("data-ready");
    $("mpTitle").textContent = song.title || "未知歌曲";
    $("mpArtist").textContent = song.artist || "未知歌手";

    const coverEl = $("mpCover");
    if (song.cover && /^https?:\/\//i.test(song.cover)) {
      const img = document.createElement("img");
      img.src = song.cover;
      img.alt = "";
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
    updateMediaSession(song);

    if (autoplay) {
      audio.play().then(syncPlayUI).catch(() => {
        if (myToken !== loadToken) return;
        syncPlayUI();
        $("mpArtist").textContent = "浏览器阻止了自动播放，请点击播放按钮";
      });
    } else {
      syncPlayUI();
    }
  }

  function togglePlay() {
    if (!playlist.length) {
      showToast("播放列表为空，请先到后台添加音乐");
      return;
    }
    if (audio.paused) {
      if (!audio.src) { loadSong(currentIdx, true); return; }
      audio.play().then(syncPlayUI).catch(() => {
        syncPlayUI();
        $("mpArtist").textContent = song_artist() || "播放失败";
      });
    } else {
      audio.pause();
      syncPlayUI();
    }
  }
  function song_artist() {
    const s = playlist[currentIdx];
    return s ? (s.artist || "") : "";
  }

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
    const idx = pickPrevIndex();
    if (idx >= 0) loadSong(idx, true);
  }

  // ---- 系统媒体控制（锁屏 / 耳机按键 / 通知栏）----
  function updateMediaSession(song) {
    if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title || "未知歌曲",
        artist: song.artist || "未知歌手",
        album: "我的博客",
        artwork: song.cover && /^https?:\/\//i.test(song.cover)
          ? [{ src: song.cover, sizes: "512x512", type: "image/jpeg" }]
          : [],
      });
      navigator.mediaSession.setActionHandler("play", () => audio.play().then(syncPlayUI));
      navigator.mediaSession.setActionHandler("pause", () => { audio.pause(); syncPlayUI(); });
      navigator.mediaSession.setActionHandler("previoustrack", prevSong);
      navigator.mediaSession.setActionHandler("nexttrack", nextSong);
    } catch (e) { /* 部分浏览器不支持 */ }
  }

  // ---- 播放列表 ----
  function renderPlaylist() {
    const el = $("mpPlaylistItems");
    $("mpPlaylistCount").textContent = playlist.length ? `${playlist.length} 首` : "";
    if (!playlist.length) {
      el.innerHTML = '<div style="padding:24px;text-align:center;color:#999;font-size:13px">暂无歌曲</div>';
      return;
    }
    el.innerHTML = playlist.map((s, i) => `
      <div class="mp-playlist-item ${i === currentIdx ? "active" : ""}" data-idx="${i}" role="button" tabindex="0">
        <span class="mp-playlist-item-num">${i === currentIdx ? "" : i + 1}</span>
        <span class="mp-playlist-item-eq"><span class="mp-eq-bar"></span><span class="mp-eq-bar"></span><span class="mp-eq-bar"></span></span>
        <div class="mp-playlist-item-body">
          <div class="mp-playlist-item-title">${escapeHtml(s.title || "未知歌曲")}</div>
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
  function renderVolumeUI() {
    const vol = audio.volume;
    const muted = audio.muted || vol === 0;
    $("mpMute").textContent = muted ? "🔇" : (vol < 0.5 ? "🔉" : "🔊");
    $("mpMute").title = muted ? "取消静音" : "静音";
    if (!muted) volumeBeforeMute = vol;
    $("mpVolume").value = String(Math.round(vol * 100));
  }

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
  });

  audio.addEventListener("progress", syncBufferUI);
  audio.addEventListener("loadedmetadata", () => {
    $("mpDuration").textContent = formatTime(audio.duration);
    $("mpProgress").setAttribute("data-ready", "1");
    syncBufferUI();
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

  function seekBy(delta) {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
    } catch (e) {}
    syncProgressUI();
  }

  // ---- 加载音乐列表 ----
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
      playlist = data.filter(s => s && s.url && String(s.url).trim() && /^https?:\/\//i.test(String(s.url).trim()));
      if (playlist.length) {
        loadSong(0, false);
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
})();
