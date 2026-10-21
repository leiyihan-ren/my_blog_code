// ============================================================
// 测试共享辅助：仓库根目录解析 + worker 导入
// 所有测试文件通过本模块获取 ROOT 与 worker，
// 避免硬编码绝对路径，使测试可在任意机器/CI 环境运行。
// ============================================================
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/** 仓库根目录（tests/ 的上一级），由本文件位置推导 */
export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** _worker.js 的 file:// URL（含 worker 默认导出） */
const workerUrl = pathToFileURL(path.join(ROOT, "_worker.js")).href;

/** worker 默认导出（fetch 处理器） */
const workerModule = await import(workerUrl);
export default workerModule.default;

/** 启动 Chromium 的公共参数：优先使用 CHROMIUM_PATH 指定的可执行文件 */
export const CHROMIUM_LAUNCH_OPTIONS = {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
};
