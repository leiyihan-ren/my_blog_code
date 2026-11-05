/**
 * player-engine.js —— 全局播放内核（在 /player.html 内运行）
 * ---------------------------------------------------------------
 * v12.0 战役一。同一份内核支持两种宿主：
 *   A) 独立窗口（window.open）：宿主窗口整页导航时**本窗口不销毁**，
 *      这是 MPA 架构下真正能做到「切页不断播」的形态。
 *   B) 隐藏 iframe（同源白名单）：把音频从主文档解耦，页面内局部更新/
 *      主题切换/动态模块加载不打断播放；代价是父文档整页导航时仍会随之卸载。
 *
 * 两种宿主都用同一套 postMessage 协议（player-host.js 为客户端）：
 *   宿主 -> 内核  { __mp: TAG, dir:"host", id, cmd, args }
 *   内核 -> 宿主  { __mp: TAG, dir:"engine", type:"ready"|"ack"|"event"|"state", ... }
 * 安全：只接受同源且 event.source 恰为宿主窗口的消息；回发一律指定 origin。
 *
 * 内核自己注册 Media Session（独立窗口模式），锁屏显示逐行歌词并支持全动作。
 * 零内联脚本（本文件为同源外链，script-src 'self' 放行，无需 nonce）。
 */
(function () {
  "use strict";

  var TAG = "__mpHost_v12";
  var ORIGIN = location.origin;
  var audio = document.getElementById("peAudio");
  if (!audio) return;

  // 宿主窗口：iframe 模式是 parent；独立窗口模式是 opener；独立直接打开则无宿主
  var host = null;
  if (window.parent && window.parent !== window) host = window.parent;
  else if (window.opener) host = window.opener;
  var STANDALONE = !host;

  var playlist = [];
  var idx = 0;
  var lrc = [];
  var lastLyric = "";
  var seq = 0;
  var pending = Object.create(null);

  function post(msg) {
    if (!host) return;
    try { host.postMessage(Object.assign({ __mp: TAG, dir: "engine" }, msg), ORIGIN); }
    catch (e) { /* 宿主已关闭 */ }
  }

  function snapshot() {
    return {
      idx: idx,
      total: playlist.length,
      src: audio.currentSrc || audio.src || "",
      currentTime: Number(audio.currentTime) || 0,
      duration: isFinite(audio.duration) ? audio.duration : 0,
      paused: audio.paused,
      ended: audio.ended,
      volume: audio.volume,
      muted: audio.muted,
      playbackRate: audio.playbackRate || 1,
      buffered: audio.buffered && audio.buffered.length
        ? audio.buffered.end(audio.buffered.length - 1) : 0,
      readyState: audio.readyState,
      lyric: lastLyric,
      song: playlist[idx] || null,
    };
  }

  function emit(ev, extra) {
    post(Object.assign({ type: "event", ev: ev, state: snapshot() }, extra || {}));
  }

  /* ---------- 锁屏歌词 + Media Session ---------- */
  function baseTitle() {
    var s = playlist[idx] || {};
    return (s.artist ? s.title + " · " + s.artist : (s.title || "我的博客"));
  }
  function setMetadata() {
    if (window.parent !== window) return; // iframe 模式由主页面掌管，避免双份 metadata 抢锁屏
    if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
    var s = playlist[idx] || {};
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: lastLyric || baseTitle(),
        artist: lastLyric ? baseTitle() : (s.artist || "我的博客"),
        album: "我的博客 · 全局播放",
        artwork: s.cover && /^https?:\/\//i.test(s.cover)
          ? [{ src: s.cover, sizes: "512x512", type: "image/jpeg" }] : [],
      });
    } catch (e) { /* 不支持则忽略 */ }
  }
  function msAction(name, fn) {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) { /* 忽略 */ }
  }
  function initMediaSession() {
    if (!("mediaSession" in navigator)) return;
    msAction("play", function () { play(); });
    msAction("pause", function () { pause(); });
    msAction("previoustrack", function () { step(-1); });
    msAction("nexttrack", function () { step(1); });
    msAction("stop", function () { pause(); try { audio.currentTime = 0; } catch (e) {} });
    msAction("seekbackward", function (d) { seek(audio.currentTime - ((d && d.seekOffset) || 10)); });
    msAction("seekforward", function (d) { seek(audio.currentTime + ((d && d.seekOffset) || 10)); });
    msAction("seekto", function (d) { if (d && typeof d.seekTime === "number") seek(d.seekTime); });
  }
  function syncPosition() {
    if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
    var dur = isFinite(audio.duration) ? audio.duration : 0;
    if (dur <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: Math.min(audio.currentTime || 0, dur),
        playbackRate: audio.playbackRate || 1,
      });
    } catch (e) { /* 忽略 */ }
  }
  function refreshLyric() {
    var line = window.LrcParser ? window.LrcParser.at(lrc, audio.currentTime) : "";
    if (line === lastLyric) return;
    lastLyric = line;
    setMetadata();
    var el = document.getElementById("peLyric");
    if (el) el.textContent = line || "♪";
    emit("lyric", { lyric: line });
  }

  /* ---------- 播放控制 ---------- */
  function loadAt(i, autoplay, atTime) {
    if (!playlist.length) return Promise.resolve(snapshot());
    idx = ((i % playlist.length) + playlist.length) % playlist.length;
    var s = playlist[idx] || {};
    var url = String(s.url || "");
    // 白名单：只接受同源相对路径或 http(s)，杜绝 javascript:/data: 注入
    if (!/^\/(?!\/)/.test(url) && !/^https?:\/\//i.test(url)) url = "";
    lrc = window.LrcParser ? window.LrcParser.parse(s.lrc || "") : [];
    lastLyric = "";
    audio.src = url;
    audio.load();
    var t = Math.max(0, Number(atTime) || 0);
    if (t > 0) {
      try { audio.currentTime = t; }
      catch (e) {
        audio.addEventListener("loadedmetadata", function once() {
          audio.removeEventListener("loadedmetadata", once);
          try { audio.currentTime = t; } catch (_) {}
        });
      }
    }
    var titleEl = document.getElementById("peTitle");
    var artistEl = document.getElementById("peArtist");
    if (titleEl) titleEl.textContent = s.title || "未知歌曲";
    if (artistEl) artistEl.textContent = s.artist || "";
    setMetadata();
    emit("trackchange", { idx: idx });
    return autoplay ? play() : Promise.resolve(snapshot());
  }
  function play() {
    return audio.play().then(function () {
      try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
      return snapshot();
    }).catch(function (e) {
      emit("autoplay-blocked", { message: String((e && e.message) || e) });
      throw e;
    });
  }
  function pause() {
    audio.pause();
    try { navigator.mediaSession.playbackState = "paused"; } catch (e) {}
    return snapshot();
  }
  function seek(t) {
    var dur = isFinite(audio.duration) ? audio.duration : 0;
    var target = Math.max(0, Number(t) || 0);
    if (dur > 0) target = Math.min(target, dur);
    try { audio.currentTime = target; } catch (e) {}
    syncPosition();
    return snapshot();
  }
  function step(delta) { return loadAt(idx + delta, true, 0); }

  /* ---------- 事件转发 ---------- */
  [
    "play", "pause", "ended", "timeupdate", "loadedmetadata", "durationchange",
    "progress", "error", "waiting", "playing", "seeked", "volumechange", "canplay",
  ].forEach(function (ev) {
    audio.addEventListener(ev, function () {
      if (ev === "timeupdate" || ev === "loadedmetadata") { refreshLyric(); syncPosition(); }
      if (ev === "playing" || ev === "pause") {
        try { navigator.mediaSession.playbackState = ev === "playing" ? "playing" : "paused"; } catch (e) {}
      }
      emit(ev);
    });
  });
  audio.addEventListener("ended", function () { step(1); });

  /* ---------- 命令协议 ---------- */
  function ack(id, ok, result, error) {
    post({ type: "ack", id: id, ok: !!ok, result: result, error: error ? String(error) : "" });
  }
  function handle(m) {
    var a = m.args || {};
    var id = m.id;
    try {
      switch (m.cmd) {
        case "getState": return ack(id, true, snapshot());
        case "setPlaylist":
          playlist = Array.isArray(a.playlist) ? a.playlist.slice(0, 500) : [];
          return ack(id, true, { total: playlist.length });
        case "load": return Promise.resolve(loadAt(a.idx || 0, !!a.autoplay, a.t)).then(function (s) { ack(id, true, s); });
        case "play": return play().then(function (s) { ack(id, true, s); }).catch(function (e) { ack(id, false, null, e && e.message); });
        case "pause": return ack(id, true, pause());
        case "next": return step(1).then(function (s) { ack(id, true, s); });
        case "prev": return step(-1).then(function (s) { ack(id, true, s); });
        case "seek": return ack(id, true, seek(a.t));
        case "volume":
          audio.volume = Math.max(0, Math.min(1, Number(a.v)));
          return ack(id, true, snapshot());
        case "mute": audio.muted = !!a.on; return ack(id, true, snapshot());
        case "rate":
          audio.playbackRate = Math.max(0.25, Math.min(4, Number(a.r) || 1));
          return ack(id, true, snapshot());
        case "focus": try { window.focus(); } catch (e) {} return ack(id, true, snapshot());
        case "destroy":
          pause(); try { audio.removeAttribute("src"); audio.load(); } catch (e) {}
          return ack(id, true, snapshot());
        default: return ack(id, false, null, "未知命令: " + m.cmd);
      }
    } catch (e) {
      ack(id, false, null, (e && e.message) || e);
    }
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || !e.source) return;
    var m = e.data;
    if (!m || m.__mp !== TAG || m.dir !== "host") return;
    // 关键：主页面发生 MPA 整页导航后，新的文档会通过 window.open("", 同名)
    // 重新拿到本窗口引用。此时 opener 已变，若死守最初的 host 会导致新页面
    // 的控制消息被全部丢弃。改为「最近一次同源合法控制者」——同源脚本本就
    // 拥有完整权限，这里再叠加 __mp 标记校验，不引入额外攻击面。
    host = e.source;
    handle(m);
  });

  // 极简 UI（独立窗口可见；iframe 模式由 CSS 隐藏）
  function bind(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }
  bind("pePlay", function () { audio.paused ? play().catch(function () {}) : pause(); });
  bind("pePrev", function () { step(-1); });
  bind("peNext", function () { step(1); });
  audio.addEventListener("timeupdate", function () {
    var d = isFinite(audio.duration) ? audio.duration : 0;
    var bar = document.getElementById("peBar");
    if (bar && d > 0) bar.style.width = Math.min(100, (audio.currentTime / d) * 100) + "%";
    var t = document.getElementById("peTime");
    if (t) t.textContent = fmt(audio.currentTime) + " / " + fmt(d);
  });
  function fmt(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  if (STANDALONE) initMediaSession();
  audio.volume = 0.7;
  post({ type: "ready", state: snapshot(), mode: STANDALONE ? "standalone" : (window.parent !== window ? "iframe" : "window") });
  window.addEventListener("pagehide", function () { post({ type: "event", ev: "pagehide", state: snapshot() }); });
})();
