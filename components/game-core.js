/**
 * 游戏大厅公共框架（game-core.js）
 * ---------------------------------------------------------------
 * 职责：
 *   1. BaseGame     —— 游戏基类：生命周期（开始/暂停/恢复/结束/销毁）、
 *                      统一计时器管理（setTimeout/setInterval/rAF 全部登记，
 *                      切游戏或重开时一次清干净，杜绝野回调与内存泄漏）
 *   2. Input        —— 输入适配层：键盘（addEventListener + 自动清理，
 *                      避开输入框、阻止默认滚动）、滑动手势、虚拟方向键、
 *                      点按；桌面键鼠与触屏共用一套 API
 *   3. Stage        —— 舞台控制器：打开游戏、开始/暂停/重开、覆盖层、
 *                      计分板、操作说明、个人最佳
 *   4. Rank         —— 全站排行榜：加载 / 渲染 / 提交
 *   5. Registry     —— 游戏注册表：各游戏文件自注册，core 不关心具体游戏
 *
 * 每个游戏一个文件（games/*.js），通过 GameCore.register 注册：
 *   GameCore.register("snake", {
 *     meta: { id, name, icon, desc, tips, scoreLabel },
 *     create: () => new SnakeGame(),
 *   });
 * ===============================================================
 */
window.GameCore = (function () {
  "use strict";

  const { escapeHtml, escapeAttr } = window.BlogUtils;
  const $ = (id) => document.getElementById(id);

  /* ---- Toast（页面级提示）：委托全站统一实现（js/utils.js） ---- */
  function toast(msg) { window.BlogUtils.toast(msg); }

  /* =========================================================
   * BaseGame —— 游戏基类
   * =======================================================*/
  class BaseGame {
    /**
     * @param {object} meta 游戏元数据（name/tips/scoreLabel/unit 等）
     */
    constructor(meta) {
      this.meta = meta || {};
      this.score = 0;
      this.lastScore = 0;
      this.running = false;
      this._timers = new Set();      // setTimeout
      this._intervals = new Set();   // setInterval
      this._rafs = new Set();        // requestAnimationFrame
      this._listeners = [];          // [target, type, fn, options]
    }

    /* ---------- 生命周期（由 Stage 调用，子类一般只需重写 reset） ---------- */

    /** 挂载：创建棋盘/DOM，绑定输入。子类重写时务必先 super.mount() */
    mount(root, api) {
      this.root = root;
      this.api = api;
      this.scoreEl = api.score;
      // 切到后台自动暂停，避免回来时“莫名其妙输了”
      this.on(document, "visibilitychange", () => {
        if (document.hidden && this.running) this.pause();
      });
    }

    start() {
      this.api.onStart();
      this.running = true;
      // 重开时必须先清掉上一局的计时器：否则贪吃蛇会出现双循环（速度翻倍）、
      // 扫雷会叠加多个秒表 interval，且暂停/销毁后仍有野回调
      this.clearTimers();
      this.api.overlay.classList.remove("show");
      this.reset();
      this.loop();
    }

    restart() { this.start(); }

    pause() {
      if (!this.running) return;
      this.running = false;
      this.clearTimers();
      this.api.onPause();
      this.api.overlayTitle.textContent = "已暂停";
      this.api.overlayScore.textContent = this.scoreText();
      this.api.overlayText.textContent = "点击继续按钮恢复游戏";
      this.api.overlayBtn.textContent = "继续";
      this.api.overlay.classList.add("show");
    }

    resume() {
      if (this.running) return;
      this.running = true;
      this.api.onResume();
      this.api.overlay.classList.remove("show");
      this.loop();
    }

    gameOver(text) {
      // 已结束时防止重复触发（重复触发会重置覆盖层文案、重复弹新纪录提示）
      if (!this.running && this.lastScore === this.score) return;
      this.running = false;
      this.clearTimers();
      this.lastScore = this.score;
      this.api.onGameOver(this.score);
      this.api.onStop();
      this.api.overlayTitle.textContent = text || "游戏结束";
      this.api.overlayScore.textContent = this.scoreText();
      this.api.overlayText.textContent = "点击开始再来一局";
      this.api.overlayBtn.textContent = "再来一局";
      this.api.overlay.classList.add("show");
    }

    /** 销毁：清理计时器与全部事件监听（换游戏 / 离开页面时调用） */
    destroy() {
      this.running = false;
      this.clearTimers();
      this.offAll();
    }

    /** 重开一局：子类在自己的 reset() 里重置状态即可，框架负责清计时器 */
    reset() {}
    loop() {}

    /* ---------- 计时器（统一登记，pause/destroy 自动清理） ---------- */

    after(ms, fn) {
      const id = setTimeout(() => { this._timers.delete(id); fn(); }, ms);
      this._timers.add(id);
      return id;
    }
    every(ms, fn) {
      const id = setInterval(fn, ms);
      this._intervals.add(id);
      return id;
    }
    /** 请求动画帧循环：每帧自动续排，直到 running=false */
    rafLoop(fn) {
      const step = (t) => {
        if (!this.running) return;
        fn(t);
        if (this.running) this.raf(step);
      };
      this.raf(step);
    }
    raf(fn) {
      const id = requestAnimationFrame((t) => { this._rafs.delete(id); fn(t); });
      this._rafs.add(id);
      return id;
    }
    clearTimers() {
      this._timers.forEach(clearTimeout);
      this._intervals.forEach(clearInterval);
      this._rafs.forEach(cancelAnimationFrame);
      this._timers.clear();
      this._intervals.clear();
      this._rafs.clear();
    }

    /* ---------- 事件监听（统一登记，destroy 自动解绑） ---------- */

    on(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      this._listeners.push([target, type, fn, options]);
      return fn;
    }
    offAll() {
      this._listeners.forEach(([t, type, fn, opts]) => t.removeEventListener(type, fn, opts));
      this._listeners = [];
    }

    /* ---------- 输入适配层 ---------- */

    /**
     * 绑定键盘。map: { "ArrowUp": fn, "w": fn, ... }
     * - 忽略输入类元素中的按键（不抢用户打字）
     * - 对已映射的键 preventDefault，防止方向键滚动页面
     * - 用 addEventListener 而非 onkeydown 赋值，避免与其他组件（音乐播放器）互相覆盖
     * - 不忽略 BUTTON：否则用鼠标点过"开始"后按钮保持焦点，方向键会被 focus 吞掉
     */
    bindKeys(map) {
      this.on(document, "keydown", (e) => {
        const tag = e.target && e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target && e.target.isContentEditable) return;
        const fn = map[e.key] || map[String(e.key).toLowerCase()];
        if (fn) { e.preventDefault(); fn(e); }
      });
    }

    /**
     * 滑动手势：在 el 上滑动超过 threshold 像素时回调 handler(dir, dx, dy)
     * dir ∈ "up" | "down" | "left" | "right"。需配合 CSS touch-action:none。
     */
    bindSwipe(el, handler, threshold = 24) {
      let sx = 0, sy = 0, tracking = false;
      this.on(el, "touchstart", (e) => {
        const t = e.changedTouches[0];
        sx = t.clientX; sy = t.clientY; tracking = true;
      }, { passive: true });
      this.on(el, "touchend", (e) => {
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        handler(dir, dx, dy);
      }, { passive: true });
      this.on(el, "touchcancel", () => { tracking = false; }, { passive: true });
    }

    /**
     * 构建虚拟方向键（触屏 / 鼠标点击均可）。
     * handler(dir) dir ∈ "up"|"down"|"left"|"right"。
     * 返回 DOM 元素，由调用方插入舞台。
     */
    buildDpad(handler) {
      const wrap = document.createElement("div");
      wrap.className = "dpad";
      const dirs = [
        { dir: "up", label: "▲", area: "up" },
        { dir: "left", label: "◀", area: "left" },
        { dir: "right", label: "▶", area: "right" },
        { dir: "down", label: "▼", area: "down" },
      ];
      for (const d of dirs) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dpad-btn";
        b.dataset.dir = d.dir;
        b.textContent = d.label;
        b.setAttribute("aria-label", d.dir);
        const fire = (e) => { e.preventDefault(); handler(d.dir); };
        b.addEventListener("click", fire);
        // 长按连续移动（贪吃蛇/俄罗斯方块手感）
        // 计时器必须登记到框架（this.after/this.every）：否则切游戏/销毁后
        // 仍会向已废弃的实例派发方向，出现"幽灵操作"
        let holdTimer = null, repeatTimer = null;
        b.addEventListener("touchstart", (e) => {
          e.preventDefault();
          handler(d.dir);
          holdTimer = this.after(300, () => {
            repeatTimer = this.every(120, () => handler(d.dir));
          });
        }, { passive: false });
        const stopHold = () => {
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
        };
        b.addEventListener("touchend", stopHold);
        b.addEventListener("touchcancel", stopHold);
        wrap.appendChild(b);
      }
      return wrap;
    }

    /** 点按（鼠标 + 触屏统一） */
    bindTap(el, handler) {
      this.on(el, "click", (e) => {
        const target = e.target.closest("[data-tap]");
        if (target) handler(target.dataset.tap, target, e);
      });
    }

    /* ---------- 计分板 ---------- */

    /** 分数文字（子类可覆盖，如扫雷显示“剩余雷数”） */
    scoreText() { return this.score + " " + (this.meta.unit || "分"); }
    setScore(v) {
      this.score = v;
      this.scoreEl.innerHTML = `<span>${this.meta.scoreLabel || "分数"}</span><b>${v}</b>`;
    }
    /** 附加显示项（生命、步数、时间等），拼在主分数后面 */
    setScoreExtra(html) {
      this.scoreEl.innerHTML =
        `<span>${this.meta.scoreLabel || "分数"}</span><b>${this.score}</b>` + (html || "");
    }
  }

  /* =========================================================
   * 画布工具：高分屏适配（DPR 缩放），逻辑坐标仍是 CSS 像素
   * max-width:100% + height:auto 让画布在窄屏（手机）上按比例缩小，
   * 指针映射用 getBoundingClientRect 换算，缩放后依然准确
   * =======================================================*/
  function fitCanvas(canvas, w, h) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.maxWidth = "100%";
    canvas.style.height = "auto";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  /* =========================================================
   * 注册表
   * 注意两点：
   *   1. 用 Map 而非普通对象——游戏 id 含 "2048" 这类纯数字键，
   *      普通对象的整数键在枚举时会被排到最前面，导致卡片/排行榜顺序错乱
   *   2. 把 meta 拍平到条目上（name/icon/desc/tips/unit），
   *      渲染层直接读 g.name / g.icon，不再层层 .meta
   * =======================================================*/
  const registry = new Map();
  function register(id, def) {
    registry.set(id, Object.assign({ id }, def.meta || {}, { create: def.create }));
  }
  function allGames() { return Array.from(registry.values()); }
  function getGame(id) { return registry.get(id) || null; }

  /* ---------- 懒加载（2.3 代码分割）----------
   * 重型游戏代码按需注入：首次打开某游戏时才加载对应 games/<id>.js，
   * 之后缓存复用；并发点击同一游戏共享同一个加载 Promise，避免重复请求。 */
  const gameScriptPromises = new Map();
  function loadGameScript(id, src) {
    if (gameScriptPromises.has(id)) return gameScriptPromises.get(id);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => {
        gameScriptPromises.delete(id);
        reject(new Error("script load failed: " + src));
      };
      document.head.appendChild(s);
    });
    gameScriptPromises.set(id, p);
    return p;
  }

  /* =========================================================
   * 舞台控制
   * =======================================================*/
  let current = null;       // 当前游戏实例
  let currentMeta = null;   // 当前游戏元数据

  async function openGame(id) {
    let def = getGame(id);
    if (!def) return;
    // 懒加载：占位注册带 src，首次打开才注入重型游戏代码，加载后重新取真实 def
    if (def.src) {
      try {
        await loadGameScript(id, def.src);
      } catch (e) {
        toast("⚠️ 游戏加载失败，请刷新重试");
        return;
      }
      def = getGame(id);
    }
    if (!def || typeof def.create !== "function") return;
    if (current && current.destroy) current.destroy();

    currentMeta = def;
    current = def.create();
    $("stage").classList.add("open");
    $("stage-icon").textContent = def.icon;
    $("stage-name").textContent = def.name;
    $("board").innerHTML = "";
    $("stage-score").innerHTML = ""; // 清空上一局计分板，避免残留旧分数/生命值
    $("stage-extra").innerHTML = ""; // 各游戏自定义控件（如贪吃蛇速度档位）
    $("overlay").classList.add("show");
    $("overlay-title").textContent = def.name;
    $("overlay-score").textContent = "";
    $("overlay-text").textContent = "点击下方按钮开始游戏";
    $("overlay-btn").textContent = "开始游戏";
    $("btn-start").textContent = "▶ 开始";
    $("btn-pause").disabled = true;
    $("btn-pause").textContent = "⏸ 暂停";
    $("btn-submit").disabled = true;
    document.querySelectorAll(".game-card").forEach((c) =>
      c.classList.toggle("active", c.dataset.id === id)
    );

    current.mount($("board"), {
      overlay: $("overlay"),
      overlayTitle: $("overlay-title"),
      overlayScore: $("overlay-score"),
      overlayText: $("overlay-text"),
      overlayBtn: $("overlay-btn"),
      score: $("stage-score"),
      extra: $("stage-extra"),
      tips: $("tips"),
      onStart: () => { $("btn-start").textContent = "▶ 进行中"; $("btn-pause").disabled = false; },
      onPause: () => { $("btn-pause").textContent = "▶ 继续"; },
      onResume: () => { $("btn-pause").textContent = "⏸ 暂停"; },
      onStop: () => {
        $("btn-start").textContent = "▶ 开始";
        $("btn-pause").disabled = true;
        $("btn-pause").textContent = "⏸ 暂停";
      },
      onGameOver: (score) => {
        $("btn-start").textContent = "▶ 开始";
        $("btn-pause").disabled = true;
        $("btn-pause").textContent = "⏸ 暂停";
        $("btn-submit").disabled = false;
        if (score > getBest(id)) {
          setBest(id, score);
          renderGameGrid();
          toast(`🎉 新纪录：${score} ${def.unit || "分"}`);
        }
        $("overlay").classList.add("show");
      },
      toast,
    });
    $("tips").innerHTML = `<b>操作说明</b><br>${def.tips}`;
    $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- 个人最佳 ---------- */
  const LS_BEST = "game-best-";
  const LS_NICK = "game-nickname";
  // 安全的 localStorage 读写（隐私模式/存储被禁用的浏览器不抛错，否则会中断游戏循环）
  const safeLS = {
    get(key) { try { return localStorage.getItem(key); } catch(e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch(e) {} }
  };
  function getBest(id) { return parseInt(safeLS.get(LS_BEST + id) || "0", 10) || 0; }
  function setBest(id, v) { safeLS.set(LS_BEST + id, String(v)); }
  function getNick() { return safeLS.get(LS_NICK) || ""; }

  function renderGameGrid() {
    $("game-grid").innerHTML = allGames().map((g) => `
      <div class="game-card${currentMeta && currentMeta.id === g.id ? " active" : ""}" data-id="${escapeAttr(g.id)}" tabindex="0" role="button" aria-label="${escapeHtml(g.name)}">
        <div class="game-icon">${g.icon}</div>
        <div class="game-name">${escapeHtml(g.name)}</div>
        <div class="game-desc">${escapeHtml(g.desc)}</div>
        <div class="game-best"><span>个人最佳</span><b>${getBest(g.id)}</b></div>
      </div>`).join("");
    $("game-grid").querySelectorAll(".game-card").forEach((c) => {
      const open = () => openGame(c.dataset.id);
      c.addEventListener("click", open);
      c.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  }

  /* ---------- 排行榜 ---------- */
  let rankData = {};
  let rankTab = null;

  async function loadRanks() {
    try {
      const res = await fetch("/api/game/scores");
      if (res.headers.get("content-type")?.includes("json")) rankData = await res.json();
    } catch (e) { /* 忽略 */ }
    if (!rankTab || !getGame(rankTab)) rankTab = allGames()[0] ? allGames()[0].id : null;
    renderRankTabs();
    renderRankBody();
  }

  function renderRankTabs() {
    $("rank-tabs").innerHTML = allGames().map((g) =>
      `<button class="rank-tab ${rankTab === g.id ? "active" : ""}" data-id="${escapeAttr(g.id)}">${g.icon} ${escapeHtml(g.name)}</button>`
    ).join("");
    $("rank-tabs").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => { rankTab = b.dataset.id; renderRankTabs(); renderRankBody(); })
    );
  }

  function renderRankBody() {
    const list = (rankData && rankData[rankTab]) || [];
    if (list.length === 0) {
      $("rank-body").innerHTML = `<div class="rank-empty">还没有人上榜，快去挑战第一名！</div>`;
      return;
    }
    const medals = ["🥇", "🥈", "🥉"];
    $("rank-body").innerHTML = `
      <table class="rank-table">
        <thead><tr><th style="width:56px">名次</th><th>玩家</th><th>日期</th><th>分数</th></tr></thead>
        <tbody>
          ${list.map((s, i) => `
            <tr>
              <td class="rank-medal">${medals[i] || (i + 1)}</td>
              <td>${escapeHtml(s.name)}</td>
              <td style="color:var(--text-mute);font-size:13px">${escapeHtml((s.date || "").slice(0, 10))}</td>
              <td><b>${s.score}</b></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  async function submitScore(gameId, score) {
    if (score <= 0) { toast("本次没有得分，无法提交"); return; }
    let nick = getNick();
    if (!nick) {
      nick = (await promptDialog({
        title: "🏆 排行榜昵称",
        message: "输入排行榜昵称（1-12 字）：",
        placeholder: "昵称",
        maxLength: 12,
      }) || "").trim();
      if (!nick) { toast("已取消提交"); return; }
      if (nick.length > 12) { toast("昵称最长 12 字"); return; }
      safeLS.set(LS_NICK, nick);
    }
    try {
      const res = await fetch(`/api/game/score/${encodeURIComponent(gameId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nick, score }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        toast(`成绩已提交，当前排名第 ${data.rank} 名 🎉`);
        loadRanks();
      } else {
        toast(data.error || "提交失败，请稍后再试");
      }
    } catch (e) {
      toast("网络错误，提交失败");
    }
  }

  /* ---------- 舞台按钮绑定 ---------- */
  function bindStageButtons() {
    // 点击后移除焦点：否则按钮保留 focus 时，按空格/回车会再次触发按钮
    const blur = (fn) => (e) => { fn(e); if (e.currentTarget && e.currentTarget.blur) e.currentTarget.blur(); };
    $("btn-start").addEventListener("click", blur(() => { if (current) current.start(); }));
    $("btn-restart").addEventListener("click", blur(() => { if (current) current.restart(); }));
    $("btn-pause").addEventListener("click", blur(() => {
      if (!current) return;
      if (current.running) current.pause();
      else current.resume();
    }));
    $("overlay-btn").addEventListener("click", blur(() => { if (current) current.start(); }));
    $("btn-submit").addEventListener("click", blur(() => {
      if (current) submitScore(currentMeta.id, current.lastScore || 0);
    }));
    $("btn-nickname").addEventListener("click", async () => {
      const v = (await promptDialog({
        title: "✏️ 修改昵称",
        message: "修改排行榜昵称（1-12 字）：",
        defaultValue: getNick(),
        placeholder: "昵称",
        maxLength: 12,
      }) || "").trim();
      if (!v) return;
      if (v.length > 12) { toast("昵称最长 12 字"); return; }
      safeLS.set(LS_NICK, v);
      toast("昵称已更新");
    });
  }

  /** 供音乐播放器等组件查询：游戏进行中时禁用其键盘快捷键，避免按键冲突 */
  function isGameRunning() { return !!(current && current.running); }

  /** 测试/调试用：返回当前游戏实例（只读，勿在业务代码中依赖） */
  function currentGame() { return current; }

  /* =========================================================
   * 导出
   * =======================================================*/
  return {
    $, escapeHtml, toast, fitCanvas,
    BaseGame, register, allGames, getGame,
    openGame, renderGameGrid, loadRanks, submitScore,
    getBest, setBest, getNick, isGameRunning,
    bindStageButtons, currentGame,
  };
})();
