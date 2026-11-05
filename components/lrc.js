/**
 * lrc.js —— 轻量 LRC 歌词解析器（同源静态脚本，严格 CSP 友好）
 * ---------------------------------------------------------------
 * v12.0 战役一：锁屏歌词。Media Session 没有「歌词」字段，业界通用做法是把
 * 当前歌词行写进 MediaMetadata.title（artist 保留「歌名 · 歌手」），系统锁屏
 * 组件就会逐行刷新。本模块只负责「LRC 文本 → 时间轴」与按播放位置取当前行，
 * 零依赖、零网络、零 eval，可同时被主页面与 player.html 内核复用。
 *
 *   window.LrcParser.parse(text)      -> [{ t: 秒, text: "歌词行" }, ...]（已排序）
 *   window.LrcParser.at(lines, time)  -> 当前应显示的歌词行（无匹配返回 ""）
 *   window.LrcParser.lrcLine(...)     -> 供 MediaMetadata.title 使用的安全文本
 */
window.LrcParser = (function () {
  "use strict";

  var TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  /** 解析 LRC；支持一行多时间标签（[00:12.00][00:45.00]重复段落）与元信息行忽略 */
  function parse(text) {
    var out = [];
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var tags = [];
      var m;
      TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(line)) !== null) {
        // [mm:ss.xx] 的小数部分按「0.xx」处理，兼容 2 位与 3 位
        var frac = m[3] ? Number("0." + m[3]) : 0;
        var t = Number(m[1]) * 60 + Number(m[2]) + frac;
        if (isFinite(t) && t >= 0) tags.push(t);
      }
      if (!tags.length) return; // [ar:] / [ti:] 等元信息行
      var lyric = line.replace(TAG_RE, "").trim();
      tags.forEach(function (t) { out.push({ t: t, text: lyric }); });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /** 二分查找 time 之前最近的一行；空歌词行会向上回溯一行，避免锁屏闪烁空白 */
  function at(lines, time) {
    if (!lines || !lines.length) return "";
    var lo = 0, hi = lines.length - 1, ans = -1;
    var t = Number(time) || 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (ans < 0) return "";
    var text = lines[ans].text;
    if (!text && ans > 0) text = lines[ans - 1].text;
    return text;
  }

  /** 锁屏标题：优先当前歌词行；无歌词时回退到「歌名 · 歌手」由调用方决定 */
  function lrcLine(lines, time, fallback) {
    var s = at(lines, time);
    return s || String(fallback || "");
  }

  return { parse: parse, at: at, lrcLine: lrcLine };
})();
