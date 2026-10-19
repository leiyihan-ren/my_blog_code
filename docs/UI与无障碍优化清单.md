# UI 与无障碍优化清单（第二阶段 · 步骤 2）

> 项目：my-blog 个人博客（Cloudflare Pages + KV 单 Worker）
> 范围：步骤 2「UI 细节 / 响应式 / a11y 深度打磨」全部整改记录
> 约束：只做"减法"与"优化"，不改变核心布局逻辑、不新增页面
> 提交链：`a47fed3`（2.1 令牌化）→ `538b62f`（2.2 响应式）→ `bd6889a`（2.3 交互态）→ `78dc7d0`（2.4a 对比度）→ `44f8bb5`（2.4b 无障碍）

---

## 总览

| 子阶段 | 主题 | 改动量 | 验证结论 |
|--------|------|--------|----------|
| 2.1 | 视觉一致性与 CSS 净化 | 10 文件 +575/−217 | 令牌定义/使用交叉校验 0 悬空 |
| 2.2 | 响应式死角 | 9 文件 +14/−20 | 375/768/1440 三档 9 页零横向溢出 |
| 2.3 | 交互体验 | 10 文件 +277/−167 | 交互态审计 9 页 0 缺口 |
| 2.4a | WCAG AA 对比度 | 10 文件 +111/−100 | 604 元素 × 双模式 × 双视口，29 处不达标 → **0** |
| 2.4b | 核心 a11y | 10 文件 +142/−77 | 结构校验 0 错误；键盘运行时测试 **21/21**；视觉回归 0 漂移 |

---

## 2.1 视觉一致性与 CSS 净化（commit `a47fed3`）

### 问题与修复明细

| # | 问题 | 文件 | 修复方案 |
|---|------|------|----------|
| 1 | 散落硬编码色值（`#667eea`、`#764ba2`、`rgba(102,126,234,…)` 等）遍布 9 页 + `music-player.js`，改色需全文搜索 | 全部 10 文件 | 提取 **33 个全局语义 Design Tokens** 至各页 `:root`，全部替换为 `var(--token)` |
| 2 | 品牌渐变写死两处（CSS + JS fallback），易漂移 | 9 页 + music-player.js | `--brand-from` / `--brand-to` / `--brand-rgb` / `--grad-brand` 四令牌统一，JS fallback 同步 |
| 3 | 成功/警告/危险色在各页重复定义且深浅不一 | 9 页 | `--success` / `--warning` / `--danger` 三组语义令牌（含 `-bg` / `-text` 变体）+ `--danger-solid` |
| 4 | 圆角、悬浮主色、禁用态等魔法值散落 | 9 页 | `--radius-pill` / `--primary-hover` / `--primary-disabled` / `--on-accent` 等令牌 |
| 5 | 暗色模式需为每个硬编码值补一份暗色值 | 9 页 | 令牌方案下只需在 `body.dark` 覆写 **10 个变体**，一处生效全站 |
| 6 | 冗余 CSS 死代码（重复规则、失效选择器） | 9 页 | 逐页人工审查清理，规则去重 |

### Design Tokens 清单（核心 33 个）

```css
:root {
  /* 品牌 */
  --primary-rgb: 79, 70, 229;   --primary: #4f46e5;
  --accent-rgb: 236, 72, 153;   --accent:  #ec4899;
  --brand-from: #5a67d8;        --brand-to:   #764ba2;
  --brand-rgb: 90, 103, 216;    --brand-deep: #4c51bf;
  --grad-brand: linear-gradient(135deg, var(--brand-from), var(--brand-to));
  /* 语义色（各含 -bg/-text 变体） */
  --success: #10b981;  --warning: #f59e0b;  --danger: #ef4444;
  --danger-solid: #dc2626;  --warning-strong: #d97706;
  /* 中性 */
  --on-accent: #ffffff;  --radius-pill: 999px;
  --primary-hover: #4338ca;  --primary-disabled: #a5b4fc;
  /* 文字专用主色（2.4a 新增，见下） */
  --primary-text: #4f46e5;
}
body.dark { /* 10 个暗色变体覆写 */ }
```

---

## 2.2 响应式死角（commit `538b62f`）

### 问题与修复明细

| # | 问题 | 文件 | 修复方案 | 代码片段 |
|---|------|------|----------|----------|
| 1 | 长英文单词 / URL / 代码串在 375px 撑破卡片导致整页横向滚动 | 9 页 | 全局 `overflow-wrap` 兜底 | `body { overflow-wrap: break-word; word-break: break-word; }` |
| 2 | flex 头部子项默认 `min-width:auto`，长标题把导航挤出屏幕 | index/blog/links/guestbook/timeline 等 | flex 项补 `min-width: 0` | `.header-inner > * { min-width: 0; }` |
| 3 | admin 后台宽表格 375px 溢出 | admin.html | 表格容器横向滚动隔离 | `.table-wrap { overflow-x: auto; }` |
| 4 | 音乐播放器窄屏控件拥挤 | music-player.js（模板） | 375px 断点压缩内边距与字号 | `@media (max-width: 480px) { .mp-info { padding: 0 10px; } }` |

**验证方法**：Playwright 三档视口（375/768/1440）× 9 页逐页断言 `document.scrollingElement.scrollWidth <= innerWidth`，全部通过。

---

## 2.3 交互体验（commit `bd6889a`）

### 问题与修复明细

| # | 问题 | 文件 | 修复方案 |
|---|------|------|----------|
| 1 | `.logo` 无 hover 反馈，点击无感知 | 8 页 | 补 `transition: opacity .2s var(--ease)` + hover 透明度 |
| 2 | index 资料卡邮箱 mailto 链接无 hover 态 | index.html | `.info-card .value a:hover` 变色 + 过渡 |
| 3 | 文章卡片标题链接无 hover 反馈 | index/blog/post | `.post-card h2 a:hover` / `h3 a:hover` 主色 + 过渡 |
| 4 | games 移动端菜单链接无 hover | games/links | `.mobile-menu a:hover` 主色 + 浅底 |
| 5 | album 重试按钮未挂样式类，hover 缺失 | album.html | 挂 `class="album-retry"` 并清理 `var(--primary,var(--primary))` 自指 fallback |
| 6 | admin 返回链接无 hover | admin.html | `.back-link:hover` 变色 + 下划线 |
| 7 | 过渡曲线散落 `ease`/`ease-in-out`/`linear` 混用 | 9 页 | 统一 `var(--ease)`（cubic-bezier 平滑曲线） |
| 8 | 部分按钮缺 `:active` 按压反馈 | games 等 | 补 `transform: scale(.97)` 按压态 |

**验证方法**：`interact-audit2.mjs` 遍历 9 页全部可交互元素，断言 `:hover/:active/:focus-visible` 计算样式非 none，0 缺口。

---

## 2.4a WCAG AA 对比度整改（commit `78dc7d0`）

### 问题与修复明细

| # | 问题 | 影响面 | 根因 | 修复方案 |
|---|------|--------|------|----------|
| 1 | 暗色模式主色文字对比度 2.49~3.16:1 不达标 | 9 页全部主色文字 | `--primary: #4f46e5` 为**背景色**设计（配白字 6.3:1 达标），直接用作暗底文字色则不足 | 新增**文字专用令牌** `--primary-text`：亮 `#4f46e5` / 暗 `#818cf8`（暗底 5.4:1）；73 处文字用途切换，背景/边框用途不动 |
| 2 | 品牌渐变按钮白字 4.29:1 不达标 | 全部 `.btn-primary` / hero 渐变 | 渐变浅端 `#667eea` 亮度偏高 | 浅端调深 `#667eea → #5a67d8`，`--brand-rgb` 同步 `102,126,234 → 90,103,216`（JS fallback 同步） |

### 像素级审计方法（避免 DOM 解析误判）

DOM 读取只能得到渐变区间（保守估计），真实背景采用**元素级截图 + PIL 非文字像素众数颜色**：

```python
# contrast-pixels.py 核心逻辑
img = Image.open(shot).convert("RGB")
px = list(img.getdata())
# 量化到 8 级取众数 = 文字背后主导背景色（footer 内含回顶按钮时众数即文字背景）
bg = Counter((r//32*32, g//32*32, b//32*32) for r, g, b in px).most_common(1)[0][0]
ratio = contrast(text_luminance, bg_luminance)  # WCAG 相对亮度公式
```

**审计规模**：604 个文本元素 × 亮/暗 × 1440/375 双视口；整改前 29 处真实不达标 → 整改后 **0**。视觉回归 457 条差异全部为预期（暗色文字 218 + 品牌渐变 56 + 品牌阴影 24 + hero 渐变 2），零意外漂移。

---

## 2.4b 核心 a11y 整改（commit `44f8bb5`）

### 4.1 语义化 HTML

| # | 问题 | 文件 | 修复方案 | 代码片段 |
|---|------|------|----------|----------|
| 1 | 9 个 tab 用 `div` 承载，键盘不可聚焦、不可 Enter 触发 | admin.html | 改为原生 `<button type="button">`，CSS 补 `font-family:inherit; background:none; border:none` 继承外观 | `<button type="button" class="tab" onclick="switchTab('posts')">文章管理</button>` |
| 2 | 4 个模态无对话框语义 | admin.html | 补 `role="dialog" aria-modal="true" aria-labelledby="…-title"` | `<div class="modal-overlay" id="post-modal" role="dialog" aria-modal="true" aria-labelledby="post-modal-title">` |
| 3 | 灯箱无对话框语义、图标按钮无可访问名 | album.html | `role/aria-modal/aria-label` + 三个图标按钮 `aria-label` + caption `aria-live="polite"` | `<button class="lightbox-close" aria-label="关闭照片查看器">✕</button>` |
| 4 | 游戏覆盖层标题 h3 跳级（h1→h3） | games.html | h3→h2（全局 reset 已保 `margin:0`，视觉等效） | `<h2 id="overlay-title">准备好了吗？</h2>` |
| 5 | 文章错误态标题 h2 与正文 h2 平级 | post.html | 错误态升为 h1，`.not-found h2` 选择器同步（视觉零漂移） | `<h1>😕 文章不存在</h1>` |
| 6 | admin 无 main 地标 | admin.html | `<div class="container">` → `<main class="container">` | — |
| 7 | 标题层级跳跃审计 | 9 页 | 逐页检查 h1→h2→h3 无跳级 | — |

### 4.2 键盘完全可用

| # | 问题 | 文件 | 修复方案 |
|---|------|------|----------|
| 1 | 模态打开焦点原地不动，Tab 跑到背景页面 | admin.html | 注入 `focusModal(id)`：打开时聚焦首个可交互元素 |
| 2 | 模态内 Tab 可跳出到背景（焦点陷阱缺失） | admin.html | 文档级 keydown：`.modal-overlay.active` 内 Tab/Shift+Tab 首尾循环 |
| 3 | Esc 无法关闭模态 | admin.html | keydown 监听 Escape，移除 active 态并归还焦点 |
| 4 | 模态关闭后焦点丢失回文档头 | admin.html | `restoreModalFocus()`：`modalLastFocus` 记录触发元素并归还 |
| 5 | 灯箱同样缺焦点管理 | album.html | `lightboxLastFocus` + Tab 陷阱 + Esc 关闭 + 焦点归还 |

```js
// admin.html 模态键盘支持（2.4b 注入）
let modalLastFocus = null;
function focusModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modalLastFocus = document.activeElement;
  const first = modal.querySelector("input, textarea, select, button");
  if (first) first.focus();
}
function restoreModalFocus() {
  if (modalLastFocus && modalLastFocus.focus) modalLastFocus.focus();
  modalLastFocus = null;
}
document.addEventListener("keydown", e => {
  const active = document.querySelector(".modal-overlay.active");
  if (!active) return;
  if (e.key === "Escape") { active.classList.remove("active"); restoreModalFocus(); return; }
  if (e.key === "Tab") { /* 首尾循环焦点陷阱 */ }
});
```

### 4.3 屏幕阅读器友好

| # | 问题 | 文件 | 修复方案 |
|---|------|------|----------|
| 1 | 32 个 `<label>` 无 `for` 关联，屏幕阅读器不读字段名 | admin.html | 全部补 `for="对应输入 id"` |
| 2 | 管理密码输入仅 placeholder | admin.html | 补 `aria-label="管理密码"` |
| 3 | 备份文件输入隐藏无可访问名 | admin.html | 补 `aria-label="选择备份文件"` |
| 4 | 头像颜色 label 未关联 | admin.html | `<label>头像颜色</label>` → `<label for="site-avatarBg">` |
| 5 | 博客搜索框无可访问名 | blog.html | 补 `aria-label="搜索文章"` |
| 6 | 装饰 emoji 被读成字面名（"🎵"→"musical note"） | index/links/music-player.js/games | `aria-hidden="true"`：资料卡 icon、空状态 ico、播放器封面、stage-icon |
| 7 | 主题按钮可访问名依赖 emoji 文本 | 8 页 + admin JS | 补 `aria-label="切换主题"`（aria-label 优先于文本内容） |
| 8 | 搜索框等动态区域 | blog 等 | 已有 `aria-live` 区域保留 |

---

## 验证矩阵（步骤 2 收官）

| 验证项 | 工具 | 规模 | 结果 |
|--------|------|------|------|
| HTML 标签栈平衡 | Python html.parser（跳过 script） | 9 页 | **0 错误** |
| a11y 静态审计 | a11y-audit.mjs（地标/标题/alt/图标按钮/emoji/表单标签/可交互 div） | 9 页 × 1440 | 6 页全净；index/blog 仅余渐进增强 div（见决策）；admin 仅余信息项（见决策） |
| 键盘运行时测试 | kbd-runtime.mjs（焦点移入/陷阱/Esc/归还） | 灯箱 + 4 模态 | **21/21 通过** |
| 归一化视觉回归 | visreg-norm.mjs（路径剥离标签名） | 9 页 × 亮/暗 × 1440 | **0 真实差异 / 0 增删** |
| UI 冒烟 | smoke-ui.mjs（配对/FOUC/对比度/溢出/JS 错误） | 9 页 | 全过 |
| 路由冒烟 | smoke-routes.mjs（互通/SEO/关键元素/主题） | 9 页 | 全过 |
| 游戏冒烟 | smoke-games.mjs（2048/扫雷/记忆翻牌核心逻辑） | 3 游戏 | 8/8 通过，0 JS 错误 |
| 游戏压力 | stress-games.mjs（连点/spam/暂停恢复） | 5 游戏 8 场景 | 全过 |
| 播放器压力 | stress-music.mjs（拖动/键盘/切后台/灯箱抢占） | 9 场景 | 全过 |

---

## 已记录的决策（审计残留项说明）

以下项目审计工具会标记，但经评估为**合理设计**，不做修改：

| 项目 | 工具报告 | 决策理由 |
|--------|----------|----------|
| `div.post-card` 可点击无 role/tabindex | div 可点击 | 渐进增强：卡片内嵌完整 `<a>` 链接，键盘用户走链接路径可达；role=button 反而丢失链接语义 |
| admin 双 h1 | h1 数量=2 | 登录态/管理态为**互斥视图**（display 切换），各持一个 h1，符合"每视图唯一 h1" |
| admin 无 nav/footer | 缺地标 | 独立后台工具页，已具备 main 地标；WCAG 未强制 nav/footer，强行添加反臃肿 |
| breakout.js Canvas 绘制常量 | 魔法值 | Canvas 绘图上下文尺寸（粒度、寿命），非 UI 主题值，令牌化无收益 |
| 组件内圆角字面值 | 魔法值 | 圆角随组件上下文尺寸（卡片 16px / 按钮 8px），已有 `--radius-*` 系列覆盖通用值 |
| 播放器 375px 标题省略号 | 截断 | 窄屏单行省略是播放器通行标准行为，非缺陷 |
| keyframe 内 ease-out/ease-in-out | 曲线不统一 | 2.3 统一范围限定 transition；keyframe 内部时序曲线属动画语法范畴 |
| theme-btn / lightbox-close emoji | emoji 未 aria-hidden | 均已有 `aria-label` 提供可访问名，emoji 文本被覆盖，等效达标 |

---

*文档生成于第二阶段步骤 2 收官；配套测试脚本位于 `/tmp/`（visreg-norm.mjs / a11y-audit.mjs / kbd-runtime.mjs / smoke-*.mjs / stress-*.mjs），可复跑复现全部结论。*
