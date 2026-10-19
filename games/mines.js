/**
 * 扫雷（games/mines.js）
 * - 关键修复：原来 reset() 先布雷再等点击，第一下就可能踩雷（不符合扫雷惯例）
 *   → 改为「首击安全」：第一次翻开时才布雷，且保证首击格及其邻居无雷
 * - 关键修复：原来每次全量 innerHTML 重建棋盘，CSS 动画（翻开/插旗/爆炸）永远播不出来
 *   → 改为一次性建格 + 原地更新 class/text，动画正常播放
 * - 关键修复：计时器原来注册在 reset()，重开会叠加多个 interval
 *   → 移入 loop()，配合框架 start() 的 clearTimers，开始/暂停/恢复/重开都只有一个
 * - 死亡结算：插对的旗保持 🚩，插错的显示 ❌，未标记的雷显示 💣
 * - 输入：左键翻开、右键/长按插旗；键盘不便操作，保留键鼠 + 触屏长按
 */
(function () {
  "use strict";
  const { BaseGame, register } = window.GameCore;

  class MinesGame extends BaseGame {
    constructor() {
      super({
        name: "扫雷",
        scoreLabel: "分数",
        unit: "分",
      });
      this.rows = 9;
      this.cols = 9;
      this.mines = 10;
    }

    mount(root, api) {
      super.mount(root, api);
      this.board = document.createElement("div");
      this.board.className = "grid-board touch-none";
      this.board.style.gridTemplateColumns = `repeat(${this.cols}, 1fr)`;
      root.appendChild(this.board);

      // 一次性建格，之后只原地更新（保住 CSS 动画）
      this.cells = [];
      for (let r = 0; r < this.rows; r++) {
        this.cells.push([]);
        for (let c = 0; c < this.cols; c++) {
          const el = document.createElement("div");
          el.className = "mine-cell";
          el.dataset.r = r;
          el.dataset.c = c;
          this.cells[r].push(el);
          this.board.appendChild(el);
        }
      }

      this.on(this.board, "click", (e) => {
        const el = e.target.closest(".mine-cell");
        if (el) this.reveal(+el.dataset.r, +el.dataset.c);
      });
      this.on(this.board, "contextmenu", (e) => {
        e.preventDefault();
        const el = e.target.closest(".mine-cell");
        if (el) this.flag(+el.dataset.r, +el.dataset.c);
      });
      // 长按插旗（触屏）
      let timer = null, longFiredCell = null;
      this.on(this.board, "touchstart", (e) => {
        const el = e.target.closest(".mine-cell");
        if (!el) return;
        longFiredCell = null;
        timer = setTimeout(() => {
          longFiredCell = el; // 记录被长按的那一格
          this.flag(+el.dataset.r, +el.dataset.c);
          timer = null;
        }, 450);
      }, { passive: true });
      const cancelHold = () => { if (timer) { clearTimeout(timer); timer = null; } };
      this.on(this.board, "touchend", cancelHold, { passive: true });
      this.on(this.board, "touchmove", cancelHold, { passive: true });
      // 长按已插旗时，只阻止同一格上随后而来的 click 再翻开；
      // 不能无差别吞掉下一个 click，否则用户长按插旗后点别的格子会失灵
      this.on(this.board, "click", (e) => {
        if (longFiredCell && e.target === longFiredCell) {
          e.stopImmediatePropagation();
          longFiredCell = null;
        }
      }, true);
    }

    reset() {
      this.grid = Array.from({ length: this.rows }, () =>
        Array.from({ length: this.cols }, () => ({ mine: false, open: false, flag: false, n: 0 }))
      );
      this.planted = false;   // 是否已布雷（首击后才布雷）
      this.revealed = 0;
      this.flags = 0;
      this.dead = false;
      this.startTime = Date.now();
      this.setScore(0);
      this.render();
      this.drawStatus();
    }

    /** 每秒刷新用时（注册在 loop：start/resume 各一次，暂停/重开由框架清掉） */
    loop() {
      if (!this.running) return;
      this.every(1000, () => { if (this.running && !this.dead) this.drawStatus(); });
    }

    /** 首击时布雷：避开首击格及其全部邻居，保证第一下能展开 */
    plant(safeR, safeC) {
      const safe = new Set([`${safeR},${safeC}`]);
      for (const [nr, nc] of this.neighbors(safeR, safeC)) safe.add(`${nr},${nc}`);
      let placed = 0;
      while (placed < this.mines) {
        const r = Math.floor(Math.random() * this.rows);
        const c = Math.floor(Math.random() * this.cols);
        if (safe.has(`${r},${c}`) || this.grid[r][c].mine) continue;
        this.grid[r][c].mine = true;
        placed++;
      }
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          this.grid[r][c].n = this.neighbors(r, c).filter(([nr, nc]) => this.grid[nr][nc].mine).length;
        }
      }
      this.planted = true;
    }

    neighbors(r, c) {
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) out.push([nr, nc]);
        }
      }
      return out;
    }

    elapsed() { return Math.floor((Date.now() - this.startTime) / 1000); }

    drawStatus() {
      const left = Math.max(0, this.mines - this.flags);
      this.setScoreExtra(
        `<span>剩余雷数</span><b>${left}</b>` +
        `<span>用时</span><b>${this.elapsed()}s</b>`
      );
    }

    flag(r, c) {
      const cell = this.grid[r][c];
      if (cell.open || this.dead || !this.running) return;
      cell.flag = !cell.flag;
      this.flags += cell.flag ? 1 : -1;
      this.updateCell(r, c);
      this.drawStatus();
    }

    reveal(r, c) {
      const cell = this.grid[r][c];
      if (cell.open || cell.flag || this.dead || !this.running) return;
      if (!this.planted) this.plant(r, c); // 首击布雷
      if (cell.mine) {
        this.dead = true;
        this.render(); // 全部雷显形
        const boom = this.cells[r][c];
        if (boom) boom.classList.add("boom");
        return this.gameOver("踩到地雷了！");
      }
      this.flood(r, c);
      this.render();
      const safe = this.rows * this.cols - this.mines;
      if (this.revealed >= safe) {
        const timeBonus = Math.max(0, 300 - this.elapsed() * 5);
        this.setScore(500 + timeBonus - this.revealed * 2);
        this.gameOver("排雷成功！");
      }
    }

    flood(r, c) {
      const stack = [[r, c]];
      while (stack.length) {
        const [cr, cc] = stack.pop();
        const cell = this.grid[cr][cc];
        if (cell.open || cell.flag) continue;
        cell.open = true;
        this.revealed++;
        if (cell.n === 0) this.neighbors(cr, cc).forEach(([nr, nc]) => stack.push([nr, nc]));
      }
      this.setScore(this.revealed * 10); // 整片展开后只写一次计分板
      this.drawStatus();
    }

    /** 原地更新一个格子的 class 与文本（动画由此触发） */
    updateCell(r, c) {
      const cell = this.grid[r][c];
      const el = this.cells[r][c];
      let cls = "mine-cell", text = "";
      if (this.dead) {
        // 死亡结算：插对的旗保持、插错的打叉、未标记的雷显形
        if (cell.mine && cell.flag) { cls += " flag"; text = "🚩"; }
        else if (cell.mine) { cls += " open"; text = "💣"; }
        else if (cell.flag) { cls += " open wrong"; text = "❌"; }
        else if (cell.open && cell.n > 0) { cls += " open n" + cell.n; text = cell.n; }
        else if (cell.open) { cls += " open"; }
      } else if (cell.flag && !cell.open) {
        cls += " flag"; text = "🚩";
      } else if (cell.open) {
        cls += " open";
        if (cell.n > 0) { text = cell.n; cls += " n" + cell.n; }
      }
      el.className = cls;
      el.textContent = text;
    }

    render() {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) this.updateCell(r, c);
      }
    }
  }

  register("mines", {
    meta: {
      id: "mines",
      name: "扫雷",
      icon: "💣",
      desc: "避开所有地雷，用数字推理安全区",
      tips:
        "左键翻开格子，右键或长按插旗标记地雷。数字表示周围 8 格中的地雷数量，" +
        "全部安全格翻开即胜利。第一次点击永远是安全的。",
    },
    create: () => new MinesGame(),
  });
})();
