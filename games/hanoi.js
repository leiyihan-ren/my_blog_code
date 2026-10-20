/**
 * 汉诺塔大师（games/hanoi.js）—— 策略/休闲类
 * - 经典汉诺塔：把全部盘子从最左柱移到最右柱，每次只能动一根、大不压小
 * - 3~6 阶难度可选；点柱拾起/放下，非法移动有抖动与提示
 * - 计分按最优步数（2^N-1）评分：完美 +1000 基础（随阶数提升），每多一步 -20
 * - 撤销上一步（撤销也计 1 步，杜绝暴力试错刷满分）
 * - 输入：鼠标/触屏点柱、键盘 1/2/3 选柱；柱即原生 button，Tab+回车亦可
 */
(function () {
  "use strict";
  const { BaseGame, register } = window.GameCore;

  const DISK_OPTIONS = [3, 4, 5, 6];
  /** 盘子配色（按尺寸取模，与站点色板一致） */
  const DISK_COLORS = ["#8b5cf6", "#3b82f6", "#06b6d4", "#22c55e", "#f97316", "#ef4444"];

  class HanoiGame extends BaseGame {
    constructor() {
      super({
        name: "汉诺塔大师",
        scoreLabel: "分数",
        unit: "分",
      });
      this.diskCount = 4;
      this.rods = [[], [], []];
      this.picked = -1; // 已拾起盘子所在的柱；-1 未拾起
      this.moves = 0;
      this.history = []; // [from, to]
      this.won = false;
    }

    mount(root, api) {
      super.mount(root, api);

      // 难度选择 + 撤销（注入舞台侧栏）
      const box = document.createElement("div");
      box.className = "opt-box";
      box.innerHTML =
        `<div class="opt-title">🗼 难度（盘子数）</div><div class="opt-row" id="hanoi-count-row"></div>` +
        `<div class="opt-title" style="margin-top:12px">操作</div><div class="opt-row"><button type="button" class="opt-btn" id="hanoi-undo">↩ 撤销上一步</button></div>`;
      api.extra.appendChild(box);
      const row = box.querySelector("#hanoi-count-row");
      for (const n of DISK_OPTIONS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "opt-btn" + (n === this.diskCount ? " active" : "");
        b.textContent = `${n} 阶`;
        b.dataset.n = String(n);
        b.addEventListener("click", () => {
          this.diskCount = n;
          row.querySelectorAll(".opt-btn").forEach((x) => x.classList.toggle("active", x === b));
          this.api.toast(`难度：${n} 阶（最优 ${this.par()} 步）`);
          b.blur();
          if (this.running) this.restart();
        });
        row.appendChild(b);
      }
      box.querySelector("#hanoi-undo").addEventListener("click", (e) => {
        this.undo();
        e.currentTarget.blur();
      });

      // 三根柱
      this.board = document.createElement("div");
      this.board.className = "hn-board";
      this.board.setAttribute("role", "group");
      this.board.setAttribute("aria-label", "汉诺塔三根柱");
      for (let i = 0; i < 3; i++) {
        const rod = document.createElement("button");
        rod.type = "button";
        rod.className = "hn-rod";
        rod.dataset.rod = String(i);
        rod.innerHTML = `<span class="hn-pole"></span><span class="hn-disks"></span><span class="hn-base"></span><span class="hn-tag">${i + 1}</span>`;
        rod.addEventListener("click", () => this.rodAction(i));
        this.board.appendChild(rod);
      }
      root.appendChild(this.board);

      // 键盘 1/2/3 选柱
      this.bindKeys({
        "1": () => this.rodAction(0),
        "2": () => this.rodAction(1),
        "3": () => this.rodAction(2),
      });
    }

    par() { return 2 ** this.diskCount - 1; }

    /* ---------- 生命周期 ---------- */

    reset() {
      this.rods = [Array.from({ length: this.diskCount }, (_, i) => this.diskCount - i), [], []];
      this.picked = -1;
      this.moves = 0;
      this.history = [];
      this.won = false;
      this.setScore(0);
      this.renderRods();
      this.renderExtra();
    }

    rodAction(i) {
      if (!this.running || this.won) return;
      if (this.picked === i) {
        this.picked = -1; // 再点一次取消拾起
        this.renderRods();
        return;
      }
      if (this.picked === -1) {
        if (this.rods[i].length === 0) {
          this.shakeRod(i);
          this.api.toast("这根柱是空的");
          return;
        }
        this.picked = i;
        this.renderRods();
        return;
      }
      // 已有拾起：尝试放到第 i 柱
      const disk = this.rods[this.picked][this.rods[this.picked].length - 1];
      const target = this.rods[i];
      if (target.length && target[target.length - 1] < disk) {
        this.shakeRod(i);
        this.api.toast("不能把大盘子放到小盘子上面");
        return;
      }
      const from = this.picked;
      this.rods[from].pop();
      target.push(disk);
      this.history.push([from, i]);
      this.picked = -1;
      this.moves += 1;
      this.renderRods();
      this.renderExtra();
      if (this.rods[2].length === this.diskCount) this.win();
    }

    undo() {
      if (!this.running || this.won || this.picked !== -1 || this.history.length === 0) return;
      const [from, to] = this.history.pop();
      const disk = this.rods[to].pop();
      this.rods[from].push(disk);
      this.moves += 1; // 撤销也计步：防止暴力试错
      this.renderRods();
      this.renderExtra();
    }

    win() {
      this.won = true;
      const par = this.par();
      const extra = Math.max(0, this.moves - par);
      const score = Math.max(100, (this.diskCount - 2) * 250 + 1000 - extra * 20);
      this.setScore(score);
      this.renderExtra(); // setScore 会重写计分板，补回步数/最优显示
      this.gameOver(extra === 0 ? `🎉 完美！${par} 步一步不多` : `通关！比最优多走了 ${extra} 步`);
    }

    /* ---------- 渲染 ---------- */

    renderRods() {
      for (let i = 0; i < 3; i++) {
        const rod = this.board.children[i];
        const stack = rod.querySelector(".hn-disks");
        const disks = this.rods[i];
        stack.innerHTML = disks
          .map((d, idx) => {
            const lifted = this.picked === i && idx === disks.length - 1;
            const color = DISK_COLORS[(d - 1) % DISK_COLORS.length];
            // 宽度按尺寸线性分布：最小 26%，最大 92%
            const w = 26 + ((d - 1) / Math.max(1, this.diskCount - 1)) * 66;
            return `<span class="hn-disk${lifted ? " lift" : ""}" style="width:${w.toFixed(1)}%;background:${color}">${d}</span>`;
          })
          .join("");
        rod.classList.toggle("picked", this.picked === i);
        rod.setAttribute("aria-label", `第 ${i + 1} 柱，${disks.length} 个盘子${this.picked === i ? "，已拾起顶盘" : ""}`);
      }
    }

    renderExtra() {
      this.setScoreExtra(
        `<span>步数</span><b>${this.moves}</b><span>最优</span><b>${this.par()}</b>`
      );
    }

    shakeRod(i) {
      const rod = this.board.children[i];
      if (!rod) return;
      rod.classList.remove("shake");
      // 强制回流：让同一格上快速连续的非法移动都能重新触发动画
      void rod.offsetWidth;
      rod.classList.add("shake");
      this.after(400, () => rod.classList.remove("shake"));
    }
  }

  register("hanoi", {
    meta: {
      id: "hanoi",
      name: "汉诺塔大师",
      icon: "🗼",
      desc: "经典汉诺塔：大不压小，用最优步数完成挑战",
      tips:
        "把全部盘子从最左柱移到最右柱。点击柱子拾起顶盘，再点击目标柱放下；" +
        "键盘 <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 选择对应柱。每次只能移动一根盘子，不能把大盘子压到小盘子上。" +
        "步数越接近最优（2^N-1）得分越高，撤销也会计 1 步。",
    },
    create: () => new HanoiGame(),
  });
})();
