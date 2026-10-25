#!/usr/bin/env bash
# ============================================================
# setup_env.sh —— 一键环境初始化（Linux / macOS）
# 双击或在终端执行：bash setup_env.sh
# 作用：检查 Node 版本 → 补齐依赖 → 生成密钥模板 → 构建产物目录 → 提示跑回归
# ============================================================
set -e
cd "$(dirname "$0")"

echo "==> [1/5] 检查 Node.js 版本（要求 >= 20）"
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装：https://nodejs.org/（推荐 LTS 20+）"
  exit 1
fi
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js 版本过低（$(node -v)），本项目要求 >= 20（package.json engines）"
  exit 1
fi
echo "    ✅ Node $(node -v) / npm $(npm -v)"

echo "==> [2/5] 安装依赖（仅 playwright，用于 E2E 测试）"
if [ -f package.json ]; then
  npm install --no-audit --no-fund || echo "    ⚠️  npm install 失败（离线环境可跳过，仅影响测试）"
else
  echo "    ⚠️  未找到 package.json，跳过"
fi

echo "==> [3/5] 生成密钥模板（不会写入任何真实密钥）"
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "    ✅ 已由 .env.example 生成 .env（请填入真实值；.env 已在 .gitignore 中）"
  else
    echo "    ⚠️  缺少 .env.example，跳过"
  fi
else
  echo "    ℹ️  .env 已存在，保持不动（绝不覆盖密钥文件）"
fi

echo "==> [4/5] 构建产物目录加固（dist / public / build）"
if [ -f scripts/build-pages.mjs ]; then
  node scripts/build-pages.mjs || echo "    ⚠️  构建脚本执行失败（不影响本地开发）"
else
  echo "    ⚠️  缺少构建脚本，跳过"
fi

echo "==> [5/5] 完成"
cat <<'TIP'

环境就绪。下一步：
  npm test         # 全量回归（21 个套件，500+ 断言）
  npm run build    # 需要时手动构建产物目录
  git log --oneline -20   # 查看完整提交历史

部署到 Cloudflare Pages：
  Build command:           npm run build
  Build output directory:  /（脚本已兼容 /dist /public /build）
  环境变量/Secret：        参考 .env.example，只填在 CF Dashboard

⚠️ 提醒：发布前请把 sw.js 的 CACHE_VERSION +1，否则用户停留在旧缓存。
TIP
