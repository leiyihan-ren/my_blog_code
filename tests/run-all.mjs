// ============================================================
// 全链路测试总runner：顺序执行 15 个测试套件，汇总通过/失败
// 任一失败 → 进程退出码 1（CI 直接判红）
// 用法：node tests/run-all.mjs
// 环境变量：CHROMIUM_PATH 指定 Chromium 可执行文件路径
// ============================================================
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 套件清单：顺序执行（端口 8899/8602 固定，禁止并行） */
const SUITES = [
  { name: "PWA 离线与更新", file: "step1-pwa-verify.mjs" },
  { name: "音乐动态化", file: "step2-music-dynamic.mjs" },
  { name: "相册动态化", file: "step2-album-dynamic.mjs" },
  { name: "SEO 与 CSP", file: "step3-seo-csp.mjs" },
  { name: "UI 极限压测", file: "step3-ui-stress.mjs" },
  { name: "a11y 与响应式", file: "step4-a11y-audit.mjs" },
  { name: "灯箱焦点陷阱", file: "step4-lightbox-trap.mjs" },
  { name: "common.js 交互回归", file: "step5-common-verify.mjs" },
  { name: "边缘缓存回归", file: "step6-edge-cache.mjs" },
  { name: "GitHub 云盘 API", file: "step7-drive-api.mjs" },
  { name: "云盘页面端到端", file: "step7-drive-ui.mjs" },
  { name: "大文件分片协议 API", file: "step8-drive-chunked.mjs" },
  { name: "大文件分片端到端", file: "step9-drive-chunked-ui.mjs" },
  { name: "云盘状态机（v7.1）", file: "step11-drive-state-machine.mjs" },
  { name: "路由重写与链接守护", file: "step10-routes-verify.mjs" },
];

function runSuite(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(TESTS_DIR, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      resolve({ code, ms: Date.now() - started, out });
    });
  });
}

const results = [];
for (const suite of SUITES) {
  process.stdout.write(`\n${"=".repeat(60)}\n▶ ${suite.name}（${suite.file}）\n${"=".repeat(60)}\n`);
  const r = await runSuite(suite.file);
  // 透传套件自身输出（最后 40 行，避免日志爆炸）
  const lines = r.out.trimEnd().split("\n");
  const tail = lines.slice(-40).join("\n");
  process.stdout.write(tail + "\n");
  // 从输出中解析通过数（各套件末尾打印形如 "通过 X/Y" 或 "X 项通过"）
  const passMatch = r.out.match(/(?:通过|passed)\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/i)
    || r.out.match(/(\d+)\s*(?:项)?(?:全部)?通过/i);
  const passed = passMatch ? Number(passMatch[1]) : null;
  const total = passMatch && passMatch[2] ? Number(passMatch[2]) : null;
  results.push({ ...suite, ok: r.code === 0, ms: r.ms, passed, total });
  console.log(`  ${r.code === 0 ? "✅" : "❌"} ${suite.name} 退出码=${r.code} 耗时=${(r.ms / 1000).toFixed(1)}s`);
}

// ---------- 汇总 ----------
console.log(`\n${"=".repeat(60)}\n测试汇总\n${"=".repeat(60)}`);
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  const detail = r.passed !== null && r.total !== null ? `（${r.passed}/${r.total} 项通过）` : "";
  console.log(`${r.ok ? "✅" : "❌"} ${r.name.padEnd(12, "　")} ${(r.ms / 1000).toFixed(1).padStart(6)}s ${detail}`);
}
console.log(`\n总计：${results.length - failed.length}/${results.length} 个套件通过，总耗时 ${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s`);
if (failed.length > 0) {
  console.log(`失败套件：${failed.map((f) => f.name).join("、")}`);
  process.exit(1);
}
console.log("🎉 全部套件通过");
