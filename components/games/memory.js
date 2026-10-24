/**
 * 记忆翻牌（games/memory.js）
 * - 卡片正面 emoji 常驻 DOM，显隐完全由 3D 旋转控制（不再手动清空文本）
 * - 翻回计时改用框架 after()，销毁/暂停时自动取消；
 *   暂停时立即翻回正在对比的两张卡，避免恢复后 busy 卡死
 * - 计分：基础分随步数递减；全部配对后按剩余步数加成
 */
(function () {
  "use strict";
  const { BaseGame, register } = window.GameCore;

  class MemoryGame extends BaseGame {
    constructor() {
      super({
        name: "记忆翻牌",
        scoreLabel: "分数",
        unit: "分",
      });
      this.emojis = ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼"];
    }

    mount(root, api) {
      super.mount(root, api);
      this.board = document.createElement("div");
      this.board.className = "grid-board touch-none";
      this.board.style.gridTemplateColumns = "repeat(4, 1fr)";
      root.appendChild(this.board);
      this.on(this.board, "click", (e) => {
        const el = e.target.closest(".mem-card");
        if (el) this.flip(el);
      });
      // 键盘操作：方向键移动焦点（roving tabindex），Enter/空格翻牌
      this.bindKeys({
        ArrowUp: () => this.moveFocus(-4),
        ArrowDown: () => this.moveFocus(4),
        ArrowLeft: () => this.moveFocus(-1),
        ArrowRight: () => this.moveFocus(1),
        Enter: () => this.flipFocused(),
        " ": () => this.flipFocused(),
      });
    }

    /** 4x4 网格内移动焦点（不循环出界），同步 roving tabindex */
    moveFocus(delta) {
      if (!this.running) return;
      const n = this.cards.length;
      const next = Math.min(n - 1, Math.max(0, this.focusIdx + delta));
      if (next === this.focusIdx) return;
      this.focusIdx = next;
      this.syncFocus();
    }

    flipFocused() {
      if (!this.running) return;
      const el = this.board.children[this.focusIdx];
      if (el) this.flip(el);
    }

    /** roving tabindex：只有当前焦点卡可 Tab 进入，其余 -1 */
    syncFocus() {
      const cards = this.board.children;
      for (let i = 0; i < cards.length; i++) {
        cards[i].tabIndex = i === this.focusIdx ? 0 : -1;
      }
      const el = cards[this.focusIdx];
      if (el) el.focus();
    }

    reset() {
      this.moves = 0;
      this.matched = 0;
      this.busy = false;
      this.first = null;
      this.pair = null;
      this.focusIdx = 0;
      this.cards = [...this.emojis, ...this.emojis]
        .map((v) => ({ v, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map((o, i) => ({ ...o, id: i }));
      this.setScore(0);
      this.setScoreExtra(`<span>步数</span><b>0</b>`);
      this.render();
    }

    render() {
      // span 常驻 emoji：未翻面时被 rotateY(180deg)+backface-visibility 隐藏，
      // 翻面/配对后自然显示，无需任何文本操作
      this.board.innerHTML = this.cards
        .map((c, i) => `<div class="mem-card" data-id="${c.id}" data-v="${c.v}" tabindex="${i === this.focusIdx ? 0 : -1}" role="button" aria-label="卡片 ${i + 1}"><span>${c.v}</span></div>`)
        .join("");
    }

    flip(el) {
      if (this.busy || !this.running) return;
      if (el.classList.contains("flipped") || el.classList.contains("done")) return;
      el.classList.add("flipped");

      if (!this.first) { this.first = el; return; }
      this.moves++;
      this.setScoreExtra(`<span>步数</span><b>${this.moves}</b>`);
      this.busy = true;
      const a = this.first, b = el;
      this.first = null;
      this.pair = [a, b];
      if (a.dataset.v === b.dataset.v) {
        a.classList.add("done");
        b.classList.add("done");
        this.matched += 2;
        this.setScore(Math.max(0, 200 - this.moves * 8));
        this.busy = false;
        this.pair = null;
        if (this.matched === this.cards.length) this.gameOver("全部配对成功！");
      } else {
        this.after(650, () => this.flipBack());
      }
    }

    /** 翻回正在对比的两张卡（超时 / 暂停 / 重开共用） */
    flipBack() {
      const pair = this.pair;
      this.pair = null;
      this.busy = false;
      if (pair) for (const el of pair) { if (el) el.classList.remove("flipped"); }
    }

    /** 暂停：若正处于对比翻回倒计时中，立即翻回，防止恢复后点击全部失效 */
    pause() {
      if (this.running && this.busy) this.flipBack();
      super.pause();
    }
  }

  register("memory", {
    meta: {
      id: "memory",
      name: "记忆翻牌",
      icon: "🃏",
      desc: "翻开卡片找出全部配对，步数越少越好",
      tips: "点击卡片翻面，找出两张相同的即可消除。步数越少、用时越短，得分越高。",
    },
    create: () => new MemoryGame(),
  });
})();
