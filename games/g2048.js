/**
 * 2048（games/g2048.js）
 * - 修复：棋盘缺 touch-action:none，移动端滑动会连带滚动页面 → 框架 bindSwipe + CSS 双保险
 * - 视觉：新落下的方块播放 .new 弹出动画，合并产生的方块播放 .merge 脉冲，
 *   未变化的方块不播放动画（移动前位置快照 diff 区分）
 * - 计分逻辑保持验证过的实现（合并加分，无变化不加分）
 */
(function () {
  "use strict";
  const { BaseGame, register } = window.GameCore;

  class Game2048 extends BaseGame {
    constructor() {
      super({
        name: "2048",
        scoreLabel: "分数",
        unit: "分",
      });
      this.size = 4;
    }

    mount(root, api) {
      super.mount(root, api);
      this.board = document.createElement("div");
      this.board.className = "grid-board touch-none";
      this.board.style.gridTemplateColumns = `repeat(${this.size}, 1fr)`;
      root.appendChild(this.board);

      const move = (dir) => { if (this.running) this.move(dir); };
      this.bindKeys({
        ArrowUp: () => move("up"),
        ArrowDown: () => move("down"),
        ArrowLeft: () => move("left"),
        ArrowRight: () => move("right"),
        w: () => move("up"),
        s: () => move("down"),
        a: () => move("left"),
        d: () => move("right"),
      });
      this.bindSwipe(this.board, (dir) => move(dir));
    }

    reset() {
      this.grid = Array.from({ length: this.size }, () => Array(this.size).fill(0));
      this.lastNew = null; // 本步新落下方块的位置（用于 .new 动画）
      this.addTile();
      this.addTile();
      this.setScore(0);
      this.render(null);
    }

    addTile() {
      this.lastNew = null;
      const empty = [];
      for (let r = 0; r < this.size; r++) {
        for (let c = 0; c < this.size; c++) {
          if (!this.grid[r][c]) empty.push([r, c]);
        }
      }
      if (!empty.length) return;
      const [r, c] = empty[Math.floor(Math.random() * empty.length)];
      this.grid[r][c] = Math.random() < 0.9 ? 2 : 4;
      this.lastNew = { r, c };
    }

    move(dir) {
      const before = this.grid.map((row) => row.slice());
      this.mergedCells = new Set(); // 本步真实发生合并的格子 "r,c"
      // line 的方向 → 把线性索引 j 映射回棋盘坐标 [r, c]
      const idxOf = {
        left: (i, j) => [i, j],
        right: (i, j) => [i, this.size - 1 - j],
        up: (i, j) => [j, i],
        down: (i, j) => [this.size - 1 - j, i],
      }[dir];
      const line = (get, set) => {
        for (let i = 0; i < this.size; i++) {
          const cells = [];
          for (let j = 0; j < this.size; j++) cells.push(get(i, j));
          const { values, merged } = this.merge(cells);
          for (let j = 0; j < this.size; j++) {
            set(i, j, values[j]);
            if (merged[j]) {
              const [r, c] = idxOf(i, j);
              this.mergedCells.add(r + "," + c);
            }
          }
        }
      };
      if (dir === "left") line((r, c) => this.grid[r][c], (r, c, v) => { this.grid[r][c] = v; });
      if (dir === "right") line((r, c) => this.grid[r][this.size - 1 - c], (r, c, v) => { this.grid[r][this.size - 1 - c] = v; });
      if (dir === "up") line((c, r) => this.grid[r][c], (c, r, v) => { this.grid[r][c] = v; });
      if (dir === "down") line((c, r) => this.grid[this.size - 1 - r][c], (c, r, v) => { this.grid[this.size - 1 - r][c] = v; });

      const changed = this.grid.some((row, r) => row.some((v, c) => v !== before[r][c]));
      if (!changed) return;
      this.addTile();
      this.render(before);
      if (this.grid.some((row) => row.includes(2048))) return this.gameOver("达成 2048！");
      if (this.isOver()) this.gameOver("无处可走了！");
    }

    /**
     * 合并一行/一列。返回 { values, merged }：
     * - values：合并后的值序列
     * - merged：与 values 等长的布尔序列，标记哪些位置发生了真实合并
     *   （供渲染做脉冲动画，避免把"滑入的更高值格子"误标为合并）
     */
    merge(cells) {
      const filtered = cells.filter((v) => v);
      const out = [];
      const merged = [];
      for (let i = 0; i < filtered.length; i++) {
        if (filtered[i] === filtered[i + 1]) {
          out.push(filtered[i] * 2);
          merged.push(true);
          this.setScore(this.score + filtered[i] * 2);
          i++;
        } else {
          out.push(filtered[i]);
          merged.push(false);
        }
      }
      while (out.length < this.size) {
        out.push(0);
        merged.push(false);
      }
      return { values: out, merged };
    }

    isOver() {
      for (let r = 0; r < this.size; r++) {
        for (let c = 0; c < this.size; c++) {
          if (!this.grid[r][c]) return false;
          if (c + 1 < this.size && this.grid[r][c] === this.grid[r][c + 1]) return false;
          if (r + 1 < this.size && this.grid[r][c] === this.grid[r + 1][c]) return false;
        }
      }
      return true;
    }

    /**
     * 渲染。before 为移动前的棋盘快照：
     * - 本步新落下的方块 → .new（弹出）
     * - 本步真实合并的方块（mergedCells 记录的位置）→ .merge（脉冲）
     * - 其余方块无动画类，避免每次移动整板乱跳
     */
    render(before) {
      const cls = (v) => (v === 0 ? "" : v <= 2048 ? `v${v}` : "vbig");
      this.board.innerHTML = this.grid
        .flat()
        .map((v, idx) => {
          const r = Math.floor(idx / this.size), c = idx % this.size;
          let anim = "";
          if (before) {
            if (this.lastNew && this.lastNew.r === r && this.lastNew.c === c) anim = "new";
            else if (this.mergedCells && this.mergedCells.has(r + "," + c)) anim = "merge";
          } else {
            anim = "new"; // 初始/重开：整板轻轻弹出
          }
          return `<div class="tile${anim ? " " + anim : ""} ${cls(v)}">${v || ""}</div>`;
        })
        .join("");
    }
  }

  register("2048", {
    meta: {
      id: "2048",
      name: "2048",
      icon: "🔢",
      desc: "滑动合并数字，挑战 2048 方块",
      tips: "方向键或滑动屏幕移动全部方块，相同数字相撞会合并，目标凑出 <b>2048</b>。",
    },
    create: () => new Game2048(),
  });
})();
