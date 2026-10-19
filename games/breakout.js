/**
 * 打砖块（games/breakout.js）
 * - 修复：球击中挡板正中被锁死在垂直弹跳（无水平分量）→ 强制最小水平/垂直分量
 * - 修复：球从侧面撞挡板会穿透 → 侧面碰撞改为水平反弹
 * - 视觉：高分屏适配、球体拖尾、砖块碎裂粒子、渐变挡板
 * - 输入：鼠标移动 / 触屏拖动 / 方向键
 */
(function () {
  "use strict";
  const { BaseGame, register, fitCanvas } = window.GameCore;

  class BreakoutGame extends BaseGame {
    constructor() {
      super({
        name: "打砖块",
        scoreLabel: "分数",
        unit: "分",
      });
      this.w = 420;
      this.h = 380;
      this.lives = 3;
      this.keys = { left: false, right: false };
      this.particles = [];
      this.trail = [];
    }

    mount(root, api) {
      super.mount(root, api);
      this.canvas = document.createElement("canvas");
      this.canvas.className = "game-canvas";
      root.appendChild(this.canvas);
      this.ctx = fitCanvas(this.canvas, this.w, this.h);

      this.paddle = { w: 70, h: 10, x: this.w / 2 - 35, y: this.h - 24 };

      const move = (clientX) => {
        const r = this.canvas.getBoundingClientRect();
        const x = (clientX - r.left) * (this.w / r.width);
        this.paddle.x = Math.max(0, Math.min(this.w - this.paddle.w, x - this.paddle.w / 2));
      };
      this.on(this.canvas, "mousemove", (e) => move(e.clientX));
      this.on(this.canvas, "touchmove", (e) => {
        e.preventDefault();
        move(e.touches[0].clientX);
      }, { passive: false });

      this.bindKeys({
        ArrowLeft: () => { this.keys.left = true; },
        ArrowRight: () => { this.keys.right = true; },
      });
      this.on(document, "keyup", (e) => {
        if (e.key === "ArrowLeft") this.keys.left = false;
        if (e.key === "ArrowRight") this.keys.right = false;
      });
    }

    reset() {
      this.lives = 3;
      this.keys.left = this.keys.right = false;
      this.particles = [];
      this.trail = [];
      this.bricks = [];
      const rows = 5, cols = 8, bw = 44, bh = 16, gap = 6, offX = 18, offY = 40;
      const colors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6"];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          this.bricks.push({ x: offX + c * (bw + gap), y: offY + r * (bh + gap), w: bw, h: bh, color: colors[r], alive: true });
        }
      }
      this.paddle.x = this.w / 2 - this.paddle.w / 2;
      this.resetBall();
      this.setScore(0);
      this.drawLives();
      this.draw();
    }

    resetBall() {
      this.ball = { x: this.w / 2, y: this.h - 40, r: 6, dx: 2.6, dy: -2.6 };
      this.trail = [];
    }

    loop() {
      this.rafLoop(() => {
        this.update();
        this.draw();
      });
    }

    update() {
      const p = this.paddle;
      if (this.keys.left) p.x -= 5;
      if (this.keys.right) p.x += 5;
      p.x = Math.max(0, Math.min(this.w - p.w, p.x));

      const b = this.ball;
      b.x += b.dx;
      b.y += b.dy;

      // 拖尾记录
      this.trail.push({ x: b.x, y: b.y });
      if (this.trail.length > 10) this.trail.shift();

      // 墙壁
      if (b.x - b.r < 0) { b.x = b.r; b.dx = Math.abs(b.dx); }
      if (b.x + b.r > this.w) { b.x = this.w - b.r; b.dx = -Math.abs(b.dx); }
      if (b.y - b.r < 0) { b.y = b.r; b.dy = Math.abs(b.dy); }

      // 挡板碰撞
      const overlapY = b.y + b.r >= p.y && b.y - b.r <= p.y + p.h;
      const overlapX = b.x >= p.x - b.r && b.x <= p.x + p.w + b.r;
      if (overlapY && overlapX && b.dy > 0) {
        const hit = Math.max(-1, Math.min(1, (b.x - (p.x + p.w / 2)) / (p.w / 2)));
        const angle = hit * (Math.PI / 3); // 最大 60°
        let speed = Math.min(5.5, Math.hypot(b.dx, b.dy) + 0.06);
        b.dx = Math.sin(angle) * speed;
        b.dy = -Math.cos(angle) * speed;
        // 防“水平死循环”：保证足够的垂直分量
        if (Math.abs(b.dy) < speed * 0.35) {
          b.dy = -speed * 0.35;
          b.dx = Math.sign(b.dx || 1) * Math.sqrt(Math.max(0.01, speed * speed - b.dy * b.dy));
        }
        b.y = p.y - b.r;
      }

      // 砖块
      for (const br of this.bricks) {
        if (!br.alive) continue;
        if (b.x + b.r > br.x && b.x - b.r < br.x + br.w && b.y + b.r > br.y && b.y - b.r < br.y + br.h) {
          br.alive = false;
          const fromSide = b.x < br.x || b.x > br.x + br.w;
          if (fromSide) b.dx *= -1; else b.dy *= -1;
          this.setScore(this.score + 15);
          this.drawLives();
          this.burst(br);
          if (this.bricks.every((x) => !x.alive)) return this.gameOver("全部击碎！");
        }
      }

      // 粒子
      this.particles = this.particles.filter((pt) => {
        pt.x += pt.vx; pt.y += pt.vy;
        pt.vy += 0.12;
        pt.life -= 1;
        return pt.life > 0;
      });

      // 掉落
      if (b.y - b.r > this.h) {
        this.lives--;
        if (this.lives <= 0) return this.gameOver("球用完了！");
        this.drawLives();
        this.resetBall();
      }
    }

    /** 砖块碎裂粒子 */
    burst(br) {
      for (let i = 0; i < 10; i++) {
        this.particles.push({
          x: br.x + br.w / 2,
          y: br.y + br.h / 2,
          vx: (Math.random() - 0.5) * 4,
          vy: (Math.random() - 0.7) * 3,
          size: 2 + Math.random() * 3,
          color: br.color,
          life: 22 + Math.random() * 14,
        });
      }
    }

    drawLives() {
      this.setScoreExtra(`<span>生命</span><b>${"❤️".repeat(this.lives)}</b>`);
    }

    draw() {
      const c = this.ctx, dark = document.body.classList.contains("dark");

      // 背景
      const bg = c.createLinearGradient(0, 0, 0, this.h);
      if (dark) { bg.addColorStop(0, "#16162a"); bg.addColorStop(1, "#101020"); }
      else { bg.addColorStop(0, "#f4f5fb"); bg.addColorStop(1, "#eceef8"); }
      c.fillStyle = bg;
      c.fillRect(0, 0, this.w, this.h);

      // 砖块（圆角 + 顶部高光）
      this.bricks.forEach((br) => {
        if (!br.alive) return;
        this.roundRect(br.x, br.y, br.w, br.h, 4);
        c.fillStyle = br.color;
        c.fill();
        c.fillStyle = "rgba(255,255,255,0.28)";
        c.fillRect(br.x + 2, br.y + 2, br.w - 4, 3);
      });

      // 挡板（渐变 + 圆角）
      const pg = c.createLinearGradient(this.paddle.x, 0, this.paddle.x + this.paddle.w, 0);
      pg.addColorStop(0, "#4f46e5");
      pg.addColorStop(1, "#7c3aed");
      this.roundRect(this.paddle.x, this.paddle.y, this.paddle.w, this.paddle.h, 5);
      c.fillStyle = pg;
      c.fill();

      // 球体拖尾
      this.trail.forEach((t, i) => {
        const a = (i / this.trail.length) * 0.28;
        c.beginPath();
        c.arc(t.x, t.y, this.ball.r * (0.4 + (i / this.trail.length) * 0.5), 0, Math.PI * 2);
        c.fillStyle = `rgba(79,70,229,${a.toFixed(3)})`;
        c.fill();
      });

      // 球（带高光）
      const b = this.ball;
      c.save();
      c.shadowColor = "rgba(79,70,229,0.5)";
      c.shadowBlur = 10;
      c.beginPath();
      c.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      c.fillStyle = dark ? "#e5e7eb" : "#312e81";
      c.fill();
      c.restore();
      c.beginPath();
      c.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.35, 0, Math.PI * 2);
      c.fillStyle = "rgba(255,255,255,0.75)";
      c.fill();

      // 粒子
      this.particles.forEach((pt) => {
        c.globalAlpha = Math.max(0, pt.life / 30);
        c.fillStyle = pt.color;
        c.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
      });
      c.globalAlpha = 1;
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

  register("breakout", {
    meta: {
      id: "breakout",
      name: "打砖块",
      icon: "🧱",
      desc: "弹球击碎所有砖块，别让球掉下去",
      tips:
        "移动鼠标或触屏拖动控制挡板，也可用 <kbd>←</kbd><kbd>→</kbd>。球落到底部失去一条命，共 3 条命，击碎全部砖块过关。",
    },
    create: () => new BreakoutGame(),
  });
})();
