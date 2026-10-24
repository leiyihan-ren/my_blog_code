/**
 * 贪吃蛇（games/snake.js）
 * - 三档速度：悠闲 / 标准 / 竞速，默认「悠闲」，随得分缓慢加速且有下限
 * - 输入：键盘方向键/WASD、触屏滑动、虚拟方向键（长按连续移动）
 * - 桌面修复：事件监听统一走框架（不再劫持 document.onkeydown）；
 *   切后台自动暂停；转向输入缓冲，杜绝快速连按下的自杀转向
 * - 视觉：高分屏适配、渐变蛇身、发光食物、蛇头眼睛、网格暗纹
 */
(function () {
  "use strict";
  const { BaseGame, register, fitCanvas } = window.GameCore;

  /** 速度档位：初始每步毫秒 → 加速下限毫秒 */
  const SPEEDS = {
    relaxed: { name: "悠闲", start: 260, min: 150 },
    normal: { name: "标准", start: 170, min: 100 },
    rush: { name: "竞速", start: 110, min: 70 },
  };

  class SnakeGame extends BaseGame {
    constructor() {
      super({
        name: "贪吃蛇",
        scoreLabel: "分数",
        unit: "分",
      });
      this.cell = 20;
      this.cols = 20;
      this.rows = 20;
      this.speedKey = "relaxed";
      this.dir = { x: 1, y: 0 };
      this.snake = [];
      this.food = null;
      this.speed = SPEEDS.relaxed.start;
      this.pendingDirs = []; // 转向缓冲：快速连按也不丢、不乱
      this.dead = false;
    }

    mount(root, api) {
      super.mount(root, api);

      // 速度档位选择器（注入舞台侧栏）
      const box = document.createElement("div");
      box.className = "opt-box";
      box.innerHTML = `<div class="opt-title">🐍 速度档位</div><div class="opt-row" id="snake-speed-row"></div>`;
      api.extra.appendChild(box);
      const row = box.querySelector("#snake-speed-row");
      for (const [key, s] of Object.entries(SPEEDS)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "opt-btn" + (key === this.speedKey ? " active" : "");
        b.textContent = s.name;
        b.dataset.key = key;
        b.addEventListener("click", () => {
          this.speedKey = key;
          this.speed = SPEEDS[key].start;
          row.querySelectorAll(".opt-btn").forEach((x) => x.classList.toggle("active", x === b));
          if (this.running) this.restart();
          this.api.toast(`速度：${s.name}`);
          b.blur(); // 防止随后按空格再次触发
        });
        row.appendChild(b);
      }

      // 画布（高分屏适配）
      this.w = this.cols * this.cell;
      this.h = this.rows * this.cell;
      this.canvas = document.createElement("canvas");
      this.canvas.className = "game-canvas";
      root.appendChild(this.canvas);
      this.ctx = fitCanvas(this.canvas, this.w, this.h);

      // 虚拟方向键（触屏 / 鼠标点击均可，长按连续移动）
      root.appendChild(this.buildDpad((dir) => this.setDir(dir)));

      // 键盘
      this.bindKeys({
        ArrowUp: () => this.setDir("up"),
        ArrowDown: () => this.setDir("down"),
        ArrowLeft: () => this.setDir("left"),
        ArrowRight: () => this.setDir("right"),
        w: () => this.setDir("up"),
        s: () => this.setDir("down"),
        a: () => this.setDir("left"),
        d: () => this.setDir("right"),
      });

      // 触屏滑动
      this.bindSwipe(this.canvas, (dir) => this.setDir(dir));
    }

    /** 转向：与缓冲队列中最后一个方向比较，杜绝“连续按键掉头自杀” */
    setDir(dir) {
      const vec = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[dir];
      if (!vec) return;
      const last = this.pendingDirs.length ? this.pendingDirs[this.pendingDirs.length - 1] : this.dir;
      if (last.x === -vec.x && last.y === -vec.y) return; // 不能反向
      if (last.x === vec.x && last.y === vec.y) return;   // 同向忽略
      if (this.pendingDirs.length < 3) this.pendingDirs.push(vec);
    }

    reset() {
      this.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
      this.dir = { x: 1, y: 0 };
      this.pendingDirs = [];
      this.dead = false;
      this.speed = SPEEDS[this.speedKey].start;
      this.setScore(0);
      this.placeFood();
      this.draw();
    }

    /**
     * 放置食物。
     * 旧实现用 do...while 随机重试：蛇占满全部格子时永远找不到空格，
     * 主线程死循环把整个标签页卡死。改为先收集空格再随机取，
     * 无空格时判定通关。
     */
    placeFood() {
      const occupied = new Set(this.snake.map((s) => s.y * this.cols + s.x));
      const empty = [];
      for (let i = 0; i < this.cols * this.rows; i++) {
        if (!occupied.has(i)) empty.push(i);
      }
      if (empty.length === 0) {
        this.food = null;
        this.dead = true;
        this.draw();
        return this.gameOver("恭喜通关！🎉");
      }
      const idx = empty[Math.floor(Math.random() * empty.length)];
      this.food = { x: idx % this.cols, y: Math.floor(idx / this.cols) };
    }

    loop() {
      if (!this.running) return;
      this.after(this.speed, () => {
        this.step();
        this.loop();
      });
    }

    step() {
      // 每步最多应用一个缓冲转向：转向不丢、不乱序
      if (this.pendingDirs.length) this.dir = this.pendingDirs.shift();
      const head = { x: this.snake[0].x + this.dir.x, y: this.snake[0].y + this.dir.y };
      if (head.x < 0 || head.y < 0 || head.x >= this.cols || head.y >= this.rows) {
        this.dead = true;
        this.draw();
        return this.gameOver("撞墙了！");
      }
      // 自撞判定：未进食时尾格会在本回合让出，蛇头追入是合法移动，
      // 必须先把尾格排除，否则盘成一团追尾时会被误判"咬到自己"
      const willGrow = this.food && head.x === this.food.x && head.y === this.food.y;
      const body = willGrow ? this.snake : this.snake.slice(0, -1);
      if (body.some((s) => s.x === head.x && s.y === head.y)) {
        this.dead = true;
        this.draw();
        return this.gameOver("咬到自己了！");
      }
      this.snake.unshift(head);
      if (willGrow) {
        this.setScore(this.score + 10);
        this.placeFood();
        const min = SPEEDS[this.speedKey].min;
        if (this.speed > min) this.speed = Math.max(min, this.speed - 4);
      } else {
        this.snake.pop();
      }
      this.draw();
    }

    /* ---------- 渲染 ---------- */
    draw() {
      const c = this.ctx, s = this.cell, dark = document.body.classList.contains("dark");

      // 背景
      const bg = c.createLinearGradient(0, 0, this.w, this.h);
      if (dark) { bg.addColorStop(0, "#16162a"); bg.addColorStop(1, "#101020"); }
      else { bg.addColorStop(0, "#f4f5fb"); bg.addColorStop(1, "#eceef8"); }
      c.fillStyle = bg;
      c.fillRect(0, 0, this.w, this.h);

      // 网格暗纹
      c.strokeStyle = dark ? "rgba(255,255,255,0.045)" : "rgba(79,70,229,0.06)";
      c.lineWidth = 1;
      for (let i = 0; i <= this.cols; i++) { c.beginPath(); c.moveTo(i * s, 0); c.lineTo(i * s, this.h); c.stroke(); }
      for (let i = 0; i <= this.rows; i++) { c.beginPath(); c.moveTo(0, i * s); c.lineTo(this.w, i * s); c.stroke(); }

      // 食物（发光 + 呼吸脉冲）；通关时 food 为 null，跳过绘制
      if (this.food) {
        const fx = this.food.x * s + s / 2, fy = this.food.y * s + s / 2;
        const pulse = 1 + Math.sin(Date.now() / 180) * 0.08;
        c.save();
        c.shadowColor = "rgba(239,68,68,0.65)";
        c.shadowBlur = 14;
        c.font = `${(s - 2) * pulse}px serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText("🍎", fx, fy + 1);
        c.restore();
      }

      // 蛇身（头亮尾透的渐变圆角段）
      const n = this.snake.length;
      this.snake.forEach((seg, i) => {
        const t = i / Math.max(1, n - 1);
        const pad = i === 0 ? 1 : 2;
        const size = s - pad * 2;
        c.fillStyle = this.dead && i === 0
          ? "#ef4444"
          : i === 0 ? "#4f46e5" : `rgba(99,102,241,${(1 - t * 0.72).toFixed(3)})`;
        this.roundRect(seg.x * s + pad, seg.y * s + pad, size, size, i === 0 ? 7 : 5);
        c.fill();
      });

      // 蛇头眼睛（按朝向）
      const head = this.snake[0];
      const hx = head.x * s, hy = head.y * s;
      const eyeR = Math.max(1.6, s * 0.09);
      let e1, e2;
      if (this.dir.x === 1) { e1 = [hx + s * 0.62, hy + s * 0.34]; e2 = [hx + s * 0.62, hy + s * 0.66]; }
      else if (this.dir.x === -1) { e1 = [hx + s * 0.38, hy + s * 0.34]; e2 = [hx + s * 0.38, hy + s * 0.66]; }
      else if (this.dir.y === -1) { e1 = [hx + s * 0.34, hy + s * 0.38]; e2 = [hx + s * 0.66, hy + s * 0.38]; }
      else { e1 = [hx + s * 0.34, hy + s * 0.62]; e2 = [hx + s * 0.66, hy + s * 0.62]; }
      c.fillStyle = "#fff";
      for (const [ex, ey] of [e1, e2]) {
        c.beginPath();
        c.arc(ex, ey, eyeR, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = "#1e1b4b";
      for (const [ex, ey] of [e1, e2]) {
        c.beginPath();
        c.arc(ex + this.dir.x * eyeR * 0.35, ey + this.dir.y * eyeR * 0.35, eyeR * 0.5, 0, Math.PI * 2);
        c.fill();
      }
    }

    roundRect(x, y, w, h, r) {
      const c = this.ctx;
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }
  }

  register("snake", {
    meta: {
      id: "snake",
      name: "贪吃蛇",
      icon: "🐍",
      desc: "吃掉食物变长，别撞墙也别咬到自己，三档速度任选",
      tips:
        '方向键 <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 或 <kbd>WASD</kbd> 控制方向；' +
        "触屏可滑动屏幕或使用虚拟方向键（长按连续移动）。吃到食物 +10 分，速度随得分缓慢加快。",
    },
    create: () => new SnakeGame(),
  });
})();
