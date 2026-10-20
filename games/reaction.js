/**
 * 闪电靶场（games/reaction.js）—— 反应类
 * - 3x3 靶格：目标随机点亮，点击/按数字键 1-9 击中
 * - 反应越快分越高（速度加成），连击有倍率；点错格清空连击
 * - 目标超时未击中扣 1 条命，3 条命用完结束；每 8 击升一级（目标存活更短、刷新更快）
 * - 输入：鼠标/触屏点按、键盘 1-9 直击；格子即原生 button，Tab+回车亦可操作
 * - 切后台自动暂停（框架 visibilitychange）；暂停时撤回当前目标，恢复后重新刷新
 */
(function () {
  "use strict";
  const { BaseGame, register } = window.GameCore;

  /** 关卡参数：目标存活毫秒 → 随等级递减的下限；刷新间隔 → 随等级递减的下限 */
  const CFG = {
    cols: 3,
    lives: 3,
    lifeStart: 1500, // 1 级目标存活时间
    lifeMin: 650,
    lifeStep: 65, // 每级减少
    gapStart: 1000, // 1 级刷新间隔
    gapMin: 380,
    gapStep: 55,
    hitsPerLevel: 8,
  };

  class ReactionGame extends BaseGame {
    constructor() {
      super({
        name: "闪电靶场",
        scoreLabel: "分数",
        unit: "分",
      });
      this.level = 1;
      this.lives = CFG.lives;
      this.combo = 0;
      this.bestCombo = 0;
      this.hits = 0;
      this.activeCell = -1; // 当前目标格；-1 无
      this.spentCell = -1; // 本回合已击穿的格（连点不再惩罚）
      this.spawnTimer = null;
      this.expireTimer = null;
      this._expireAt = 0;
      this.respawnAfterResume = false;
    }

    mount(root, api) {
      super.mount(root, api);
      this.board = document.createElement("div");
      this.board.className = "rt-board";
      root.appendChild(this.board);

      // 9 个靶格即原生 button：鼠标/触屏/键盘（Tab+Enter）全通
      for (let i = 0; i < CFG.cols * CFG.cols; i++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rt-cell";
        b.dataset.idx = String(i);
        b.setAttribute("aria-label", `靶格 ${i + 1}`);
        b.addEventListener("click", () => this.hit(i));
        this.board.appendChild(b);
      }

      // 数字键 1-9 直击（反应速度的核心输入）
      const keyMap = {};
      for (let i = 0; i < 9; i++) keyMap[String(i + 1)] = () => this.hit(i);
      this.bindKeys(keyMap);
    }

    /* ---------- 生命周期 ---------- */

    reset() {
      this.level = 1;
      this.lives = CFG.lives;
      this.combo = 0;
      this.bestCombo = 0;
      this.hits = 0;
      this.activeCell = -1;
      this.spentCell = -1;
      this.respawnAfterResume = false;
      this.setScore(0);
      this.renderExtra();
      this.clearCellStates();
    }

    loop() {
      this.scheduleSpawn(600); // 开局给 0.6 秒准备时间
    }

    /** 关卡参数：存活时间与刷新间隔随等级递减（有下限） */
    get lifetime() { return Math.max(CFG.lifeMin, CFG.lifeStart - (this.level - 1) * CFG.lifeStep); }
    get gap() { return Math.max(CFG.gapMin, CFG.gapStart - (this.level - 1) * CFG.gapStep); }

    scheduleSpawn(delay) {
      this.spawnTimer = this.after(delay, () => this.spawn());
    }

    spawn() {
      if (!this.running) return;
      this.spentCell = -1;
      // 不与上一目标同格：避免"原地连点"作弊
      let idx;
      do { idx = Math.floor(Math.random() * 9); } while (idx === this.activeCell);
      this.activeCell = idx;
      const el = this.cellEl(idx);
      if (el) el.classList.add("target");
      this._expireAt = Date.now() + this.lifetime; // 记录截止时刻，供反应时间估算
      this.expireTimer = this.after(this.lifetime, () => this.expire());
    }

    /** 目标超时：扣命 + 清连击，进入下一轮刷新 */
    expire() {
      if (this.activeCell < 0) return;
      this.flash(this.activeCell, "expire");
      this.activeCell = -1;
      this.lives -= 1;
      this.combo = 0;
      this.renderExtra();
      if (this.lives <= 0) {
        return this.gameOver("靶场失守！");
      }
      this.scheduleSpawn(this.gap);
    }

    /** 击中/点空：idx 为玩家操作的格 */
    hit(idx) {
      if (!this.running) return;
      if (idx === this.spentCell) return; // 已击穿格的连点：忽略，不惩罚
      if (idx === this.activeCell) {
        const rt = this.lifetime - this.remaining(); // 反应时间 ≈ 存活时间 - 剩余
        this.flash(idx, "hit");
        this.activeCell = -1;
        this.spentCell = idx;
        this.hits += 1;
        this.combo += 1;
        this.bestCombo = Math.max(this.bestCombo, this.combo);
        // 速度加成：越快越高（10~120）；连击倍率：每层 +5%，上限 +100%
        const speedBonus = Math.min(120, Math.max(10, Math.round((1 - rt / this.lifetime) * 120)));
        const comboMult = 1 + Math.min(this.combo - 1, 20) * 0.05;
        this.setScore(this.score + Math.round((100 + speedBonus) * comboMult));
        if (this.hits % CFG.hitsPerLevel === 0) {
          this.level += 1;
          this.api.toast(`⚡ 进入 ${this.level} 级！目标更快了`);
        }
        this.renderExtra();
        this.scheduleSpawn(this.gap);
      } else if (this.activeCell >= 0) {
        // 目标存在时点错格：清连击（不扣命，降低挫败感）
        this.combo = 0;
        this.flash(idx, "wrong");
        this.renderExtra();
      }
      // 无目标时点空格：忽略
    }

    /** 当前目标的剩余存活毫秒（用于反应时间估算） */
    remaining() {
      if (this.activeCell < 0) return 0;
      return Math.max(0, (this._expireAt || 0) - Date.now());
    }

    flash(idx, cls) {
      const el = this.cellEl(idx);
      if (!el) return;
      el.classList.remove("target");
      el.classList.add(cls);
      this.after(cls === "hit" ? 220 : 300, () => el.classList.remove(cls));
    }

    clearCellStates() {
      for (const el of this.board.children) {
        el.classList.remove("target", "hit", "wrong", "expire");
      }
    }

    cellEl(idx) { return this.board.children[idx] || null; }

    renderExtra() {
      this.setScoreExtra(
        `<span>生命</span><b>${"❤️".repeat(Math.max(0, this.lives)) || "—"}</b>` +
        `<span>连击</span><b>x${this.combo}</b>` +
        `<span>等级</span><b>${this.level}</b>`
      );
    }

    /** 暂停：撤回当前目标（其过期计时器已被框架清除），恢复后重新刷新 */
    pause() {
      if (this.running && this.activeCell >= 0) {
        this.flash(this.activeCell, "expire");
        this.activeCell = -1;
        this.respawnAfterResume = true;
      }
      super.pause();
    }

    resume() {
      if (this.running) return;
      super.resume();
      if (this.respawnAfterResume) {
        this.respawnAfterResume = false;
        this.scheduleSpawn(500);
      } else {
        this.scheduleSpawn(this.gap);
      }
    }
  }

  register("reaction", {
    meta: {
      id: "reaction",
      name: "闪电靶场",
      icon: "⚡",
      desc: "目标稍纵即逝，比拼反应与连击",
      tips:
        "目标点亮后立刻点击，或用数字键 <kbd>1</kbd>~<kbd>9</kbd> 直击对应靶格。" +
        "反应越快速度加成越高，连续击中触发连击倍率；点错格会清空连击，目标超时未击中扣 1 条命。" +
        "每 8 击升一级，目标存活更短、刷新更快。",
    },
    create: () => new ReactionGame(),
  });
})();
