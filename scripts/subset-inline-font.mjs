#!/usr/bin/env node
/**
 * v22.0 模块二：关键字符极小子集 + 内联 @font-face 资产生成器
 *
 * 背景：全站 14 页使用系统字体栈，首屏 0 个字体请求，Lighthouse 100 分。
 * v21 已产出 1386 字符的完整子集（435KB WOFF2）；但「内联」435KB 会
 * 让 HTML/CSS 膨胀约 580KB，反而摧毁 LCP。因此本脚本只提取 UI 高频
 * 关键字符（导航/按钮/状态词），产出几 KB 的 WOFF2，并生成可直接
 * data-URI 内联的 @font-face CSS 资产。
 *
 * 该资产默认**不注入任何页面**：是否启用由 Lighthouse A/B 实测决定，
 * 详见《网页线·通宵工程战报.md》模块二决策记录。
 *
 * 用法：node scripts/subset-inline-font.mjs [--check]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
const OUT_WOFF2 = path.join(ROOT, "assets/fonts/site-cn-critical.woff2");
const OUT_CSS = path.join(ROOT, "assets/fonts/subset-inline.css");
const OUT_REPORT = path.join(ROOT, ".v22-inline-font-report.json");
const CHECK = process.argv.includes("--check");

// UI 高频关键字符（导航、按钮、状态提示、通用动词），刻意保持极小。
const CRITICAL =
  "我的个人博客全站数据大屏极客工具箱网盘相册音乐播放器游戏留言时间线文章管理后台首页" +
  "搜索登录设置保存取消确定删除编辑返回上一页下一页加载中暂无数据错误成功提示警告" +
  "主题深色浅色模式分享复制链接下载上传新建刷新关闭打开更多详情列表卡片标签" +
  "访问次数使用频率已用空间统计趋势今日本周本月总计年月日时分秒个项条百分比" +
  "纯本地离线可用正在处理完成失败重试网络异常服务不可用请稍后再次尝试" +
  "标题内容名称大小类型状态操作时间作者分类备注说明备注确认提交重置清空" +
  "欢迎使用功能介绍关于我联系友情链接订阅版权所有保留权利隐私政策";

const PY = String.raw`
import sys, json, io, base64
from fontTools import subset
from fontTools.ttLib import TTFont
cfg = json.loads(sys.argv[1])
opts = subset.Options()
opts.flavor = "woff2"
opts.layout_features = ["*"]
opts.name_IDs = ["*"]
opts.notdef_outline = True
font = TTFont(cfg["source"], fontNumber=0)
ss = subset.Subsetter(options=opts)
ss.populate(text=cfg["text"])
ss.subset(font)
font.flavor = "woff2"
font.save(cfg["out"])
print(json.dumps({"ok": True}))
`;

if (CHECK) {
  const ok =
    fs.existsSync(OUT_WOFF2) &&
    fs.existsSync(OUT_CSS) &&
    fs.existsSync(OUT_REPORT) &&
    /data:font\/woff2;base64,/.test(fs.readFileSync(OUT_CSS, "utf8"));
  console.log(`[subset-inline] check: ${ok ? "资产齐备" : "资产缺失"}`);
  process.exit(ok ? 0 : 1);
}

if (!fs.existsSync(SRC)) {
  console.error(`[subset-inline] 字体源不存在: ${SRC}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT_WOFF2), { recursive: true });

const res = spawnSync(
  process.env.PYTHON || "python3.11",
  ["-c", PY, JSON.stringify({ source: SRC, out: OUT_WOFF2, text: CRITICAL })],
  { encoding: "utf8" }
);
if (res.status !== 0) {
  console.error(`[subset-inline] fontTools 失败: ${res.stderr || res.stdout}`);
  process.exit(1);
}

const woff2 = fs.readFileSync(OUT_WOFF2);
const b64 = woff2.toString("base64");
const chars = Array.from(new Set(Array.from(CRITICAL)));
const css = `/* v22.0 关键字符内联子集（${chars.length} 字符 / ${woff2.length} B WOFF2）
 * 由 scripts/subset-inline-font.mjs 生成。默认**不注入任何页面**：
 * 全站系统字体栈首屏 0 字体请求，注入会引入字体对象并改变首屏渲染路径。
 * 业务侧确需启用时再引入本文件，并先重跑 Lighthouse 守住 100 分基线。
 */
@font-face {
  font-family: "SiteCNCritical";
  src: url(data:font/woff2;base64,${b64}) format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}
`;
fs.writeFileSync(OUT_CSS, css);

const report = {
  generatedAt: new Date().toISOString(),
  engine: "fontTools pyftsubset (woff2) + base64 data-URI",
  source: SRC,
  criticalChars: chars.length,
  woff2Bytes: woff2.length,
  base64Bytes: b64.length,
  cssBytes: Buffer.byteLength(css),
  outputs: {
    woff2: "assets/fonts/site-cn-critical.woff2",
    css: "assets/fonts/subset-inline.css",
  },
  vsFullSubset: {
    fullChars: 1386,
    fullWoff2Bytes: 435716,
    criticalRatioPct: Number(((woff2.length / 435716) * 100).toFixed(2)),
  },
  disclosure:
    "该 CSS 为可选资产，默认未注入任何页面。全站使用系统字体栈、首屏 0 字体请求，" +
    "即「字体加载损耗」已为零；任何注入都是新增字体对象的负优化，故以不注入为上策。" +
    "是否启用需以 Lighthouse A/B 实测为依据。",
};
fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2) + "\n");

console.log(
  `[subset-inline] 关键字符 ${chars.length} → WOFF2 ${woff2.length} B / base64 ${b64.length} B / CSS ${Buffer.byteLength(css)} B`
);
console.log(`[subset-inline] 占完整子集体积 ${report.vsFullSubset.criticalRatioPct}%`);
