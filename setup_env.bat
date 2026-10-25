@echo off
REM ============================================================
REM setup_env.bat —— 一键环境初始化（Windows 双击运行）
REM 作用：检查 Node 版本 → 补齐依赖 → 生成密钥模板 → 构建产物目录 → 提示跑回归
REM ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ==^> [1/5] 检查 Node.js 版本（要求 ^>= 20）
where node >nul 2>&1
if errorlevel 1 (
  echo [X] 未检测到 Node.js，请先安装：https://nodejs.org/（推荐 LTS 20+）
  pause
  exit /b 1
)
for /f "tokens=1,2,3 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if "!NODE_MAJOR!"=="" (
  for /f "delims=" %%v in ('node -v') do (
    set NV=%%v
    set NV=!NV:v=!
    for /f "tokens=1 delims=." %%m in ("!NV!") do set NODE_MAJOR=%%m
  )
)
if !NODE_MAJOR! LSS 20 (
  echo [X] Node.js 版本过低，本项目要求 ^>= 20
  pause
  exit /b 1
)
echo     [OK] Node 版本符合要求

echo ==^> [2/5] 安装依赖（仅 playwright，用于 E2E 测试）
if exist package.json (
  call npm install --no-audit --no-fund
) else (
  echo     未找到 package.json，跳过
)

echo ==^> [3/5] 生成密钥模板（不会写入任何真实密钥）
if not exist .env (
  if exist .env.example (
    copy /Y .env.example .env >nul
    echo     [OK] 已由 .env.example 生成 .env（请填入真实值）
  ) else (
    echo     缺少 .env.example，跳过
  )
) else (
  echo     .env 已存在，保持不动
)

echo ==^> [4/5] 构建产物目录加固（dist / public / build）
if exist scripts\build-pages.mjs (
  node scripts\build-pages.mjs
) else (
  echo     缺少构建脚本，跳过
)

echo ==^> [5/5] 完成
echo.
echo 环境就绪。下一步：
echo   npm test        全量回归（21 个套件，500+ 断言）
echo   npm run build   手动构建产物目录
echo   git log --oneline -20   查看完整提交历史
echo.
echo 部署到 Cloudflare Pages：
echo   Build command:           npm run build
echo   Build output directory:  /（脚本已兼容 /dist /public /build）
echo   环境变量/Secret：        参考 .env.example，只填在 CF Dashboard
echo.
echo 提醒：发布前请把 sw.js 的 CACHE_VERSION +1，否则用户停留在旧缓存。
echo.
pause
