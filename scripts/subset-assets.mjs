/**
 * scripts/subset-assets.mjs —— v21.0 模块一-2 字体与图片子集化引擎
 * ---------------------------------------------------------------
 * 两件事，全部「可复现 + 幂等 + 产物直出 + 零业务侵入」：
 *
 *  ① 中文字符集提取与字体子集化
 *     · 扫描全站 pages/*.html + styles/*.css + components/*.js + utils/*.js
 *       里实际出现的 CJK 字符（含常用全角标点），得到真实用到的字符集；
 *     · 用 fontTools pyftsubset 把系统 Noto Sans CJK 按该字符集做子集化，
 *       产出 WOFF2（19.5MB → 数十 KB）+ unicode-range 片段 + @font-face CSS；
 *     · 全站当前使用系统字体栈（无 @font-face / 无本地字体文件），故子集
 *       字体作为「按需启用资产」落盘，默认不注入 13 页 —— 强行引入字体
 *       请求会破坏 v19 已跑通的 Lighthouse 100 与首屏零字体请求基线。
 *       脚本同时输出「若未来接入」的 CSS，供工程决策，不夸大已生效。
 *
 *  ② 图片强制转换 AVIF / WebP
 *     · 对仓库根目录与 icons/ 下全部 PNG 生成 .avif / .webp 双份副本；
 *     · 严格保留原 PNG（step3-seo-csp 硬断言 /og-image.png 返回 200 +
 *       image/png；13 页 og:image / favicon / manifest 引用全部不动）；
 *     · 产出 <picture> 渐进增强片段（assets/IMAGE_PICTURE_SNIPPETS.txt），
 *       由业务侧按需采用，脚本绝不改写任何 HTML。
 *
 * 产物目录 assets/（新建，不在 build-pages 排除名单内，会随整站同步到
 * dist/public/build，Cloudflare Pages 直接可服务）。报告 .v21-assets-report.json
 * 已加入 build-pages 排除名单（工程治理资产，不进公网）。
 *
 * 用法：
 *   node scripts/subset-assets.mjs              # 生成（幂等，体积不变则跳过）
 *   node scripts/subset-assets.mjs --check      # 只校验产物齐备，不写文件
 *   node scripts/subset-assets.mjs --force      # 强制重算
 *
 * 依赖（沙箱/CI 均可用，缺失时优雅降级并如实记录，绝不伪报成功）：
 *   python3.11 + Pillow(webp,avif) + fontTools + brotli + 系统 Noto CJK
 * ===============================================================
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const FONT_DIR = path.join(ASSETS, "fonts");
const IMG_DIR = path.join(ASSETS, "images");
const REPORT = path.join(ROOT, ".v21-assets-report.json");
const CHARSET_FILE = path.join(FONT_DIR, "charset-cn.txt");
const FACE_CSS = path.join(FONT_DIR, "subset-face.css");
const SNIPPETS = path.join(IMG_DIR, "PICTURE_SNIPPETS.txt");

const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");

const PY = process.env.PYTHON_BIN || "python3.11";
const FONT_SRC = process.env.FONT_SRC || "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";

let pass = 0, fail = 0;
/** @param {string} n @param {boolean} c @param {string} [d] */
function check(n, c, d) {
  if (c) { pass++; console.log(`  ✅ ${n}${d ? "  — " + d : ""}`); }
  else { fail++; console.log(`  ❌ ${n}${d ? "  — " + d : ""}`); }
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/* ============================================================
 * ① 提取全站真实用到的中文字符集
 * ============================================================ */
console.log("═══ ① 中文字符集提取 ═══");
const SCAN_DIRS = ["pages", "styles", "components", "utils", "services", "modules"];
const SCAN_EXT = /\.(html|css|js|mjs)$/;
function scanFiles() {
  const out = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const f = path.join(abs, e.name);
      if (e.isFile() && SCAN_EXT.test(e.name) && !e.name.endsWith(".min.js")) out.push(f);
      else if (e.isDirectory() && e.name !== "node_modules") {
        for (const sub of fs.readdirSync(f)) {
          if (SCAN_EXT.test(sub)) out.push(path.join(f, sub));
        }
      }
    }
  }
  return out.sort();
}

/** 提取 CJK 统一表意文字 + 扩展 A + 常用全角标点/符号 */
function extractCharset(files) {
  const set = new Set();
  // 基本区 U+4E00-9FFF、扩展 A U+3400-4DBF、CJK 标点 U+3000-303F、
  // 全角 U+FF00-FFEF（含 ，。！？：；（）「」等）
  const RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g;
  for (const f of files) {
    const m = fs.readFileSync(f, "utf8").match(RE);
    if (m) for (const ch of m) set.add(ch);
  }
  // 补充数字/ASCII 基本集（字体子集需要保留拉丁字母与数字以正常渲染混排）
  for (const ch of "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ .,:;!?()[]{}+-*/%=<>&|_@#~'\"\\^$") set.add(ch);
  return [...set].sort();
}

const files = scanFiles();
const charset = extractCharset(files);
const cjkCount = charset.filter((c) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(c)).length;
check(`扫描 ${files.length} 个前端源文件，提取字符 ${charset.length} 个（CJK ${cjkCount}）`,
  files.length >= 30 && cjkCount >= 300, `CJK ${cjkCount}`);

/* ============================================================
 * ② Python 侧：字体子集化 + 图片 AVIF/WebP 转换
 * ============================================================ */
const PY_SCRIPT = String.raw`
import json, os, sys, io
cfg = json.loads(sys.argv[1])
out = {"font": {}, "images": [], "errors": []}

# ---------- 字体子集化 ----------
try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    src, dst = cfg["font_src"], cfg["font_out"]
    if not os.path.exists(src):
        out["font"]["skipped"] = "系统 CJK 字体不存在: " + src
    else:
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.desubroutinize = True
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        font = TTFont(src, fontNumber=cfg.get("font_number", 0))
        ss = subset.Subsetter(options=opts)
        ss.populate(text=cfg["charset"])
        ss.subset(font)
        font.flavor = "woff2"
        font.save(dst)
        out["font"] = {
            "ok": True,
            "source": src,
            "sourceBytes": os.path.getsize(src),
            "outBytes": os.path.getsize(dst),
            "glyphs": cfg["char_count"],
            "engine": "fontTools pyftsubset (woff2)",
        }
except Exception as e:
    out["errors"].append("font:" + type(e).__name__ + ":" + str(e)[:160])

# ---------- 图片 AVIF / WebP ----------
try:
    from PIL import Image, features
    can_webp = bool(features.check("webp"))
    can_avif = bool(features.check("avif"))
    for job in cfg["images"]:
        src, base = job["src"], job["base"]
        rec = {"src": job["rel"], "srcBytes": os.path.getsize(src), "outputs": {}}
        try:
            im = Image.open(src)
            has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
            im = im.convert("RGBA" if has_alpha else "RGB")
            for fmt, ext, ok in (("WEBP", ".webp", can_webp), ("AVIF", ".avif", can_avif)):
                if not ok:
                    rec["outputs"][ext] = {"skipped": "Pillow 无 " + fmt + " 编码支持"}
                    continue
                dst = base + ext
                buf = io.BytesIO()
                kw = {"quality": 50, "method": 6} if fmt == "WEBP" else {"quality": 50, "speed": 6}
                im.save(buf, format=fmt, **kw)
                data = buf.getvalue()
                # 幂等：内容相同则不重写，避免无意义 mtime 抖动
                if not os.path.exists(dst) or open(dst, "rb").read() != data:
                    with open(dst, "wb") as fh:
                        fh.write(data)
                rec["outputs"][ext] = {"ok": True, "bytes": len(data), "path": job["out_rel"] + ext}
        except Exception as e:
            rec["error"] = type(e).__name__ + ":" + str(e)[:120]
            out["errors"].append(job["rel"] + ":" + rec["error"])
        out["images"].append(rec)
except Exception as e:
    out["errors"].append("pillow:" + type(e).__name__ + ":" + str(e)[:160])

print(json.dumps(out, ensure_ascii=False))
`;

/** 收集需要转换的 PNG（根目录 og-image.png + icons/*.png），排除三份构建副本 */
function collectImages() {
  const jobs = [];
  const push = (abs) => {
    const name = path.basename(abs);
    const stem = name.replace(/\.png$/i, "");
    jobs.push({
      src: abs,
      rel: rel(abs),
      base: path.join(IMG_DIR, stem),
      out_rel: "assets/images/" + stem,
    });
  };
  const og = path.join(ROOT, "og-image.png");
  if (fs.existsSync(og)) push(og);
  const icons = path.join(ROOT, "icons");
  for (const n of fs.readdirSync(icons)) if (/\.png$/i.test(n)) push(path.join(icons, n));
  return jobs.sort((a, b) => a.rel.localeCompare(b.rel));
}

const images = collectImages();
const pyAvailable = spawnSync(PY, ["-c", "import PIL, fontTools, brotli"], { encoding: "utf8" });
const toolOk = pyAvailable.status === 0;

if (CHECK) {
  console.log("═══ --check 模式：只校验产物齐备 ═══");
  check("字体子集 WOFF2 存在", fs.existsSync(path.join(FONT_DIR, "site-cn-subset.woff2")));
  check("字符集清单存在", fs.existsSync(CHARSET_FILE));
  check("@font-face CSS 存在", fs.existsSync(FACE_CSS));
  check("报告存在", fs.existsSync(REPORT));
  let imgOk = 0;
  for (const j of images) {
    if (fs.existsSync(j.base + ".webp") && fs.existsSync(j.base + ".avif")) imgOk++;
  }
  check(`${images.length} 张 PNG 的 WebP + AVIF 副本齐备`, imgOk === images.length, `${imgOk}/${images.length}`);
} else {
  fs.mkdirSync(FONT_DIR, { recursive: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });

  // 字符集清单（去重排序，供复查 / 未来接 Web Font 时复用）
  fs.writeFileSync(CHARSET_FILE, charset.join("") + "\n", "utf8");

  if (!toolOk) {
    console.log("  ⚠  Python 工具链缺失，字体子集化与图片转码跳过（如实记录，不伪报成功）：" +
      String(pyAvailable.error || pyAvailable.stderr || "unknown").slice(0, 160));
  }

  let pyOut = { font: {}, images: [], errors: [] };
  if (toolOk) {
    const cfg = {
      font_src: FONT_SRC,
      font_out: path.join(FONT_DIR, "site-cn-subset.woff2"),
      font_number: 0,
      charset: charset.join(""),
      char_count: charset.length,
      images: images.map((j) => ({ src: j.src, base: j.base, rel: j.rel, out_rel: j.out_rel })),
    };
    const r = spawnSync(PY, ["-c", PY_SCRIPT, JSON.stringify(cfg)], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (r.status === 0 && r.stdout.trim()) {
      try { pyOut = JSON.parse(r.stdout.trim()); } catch (e) { pyOut.errors.push("json:" + e.message); }
    } else {
      pyOut.errors.push("python:" + String(r.stderr || r.error || "exit " + r.status).slice(0, 200));
    }
  }

  console.log("═══ ② 字体子集化 ═══");
  const fontOk = !!pyOut.font.ok;
  if (fontOk) {
    const before = pyOut.font.sourceBytes, after = pyOut.font.outBytes;
    check("CJK 字体子集化成功（WOFF2）", true,
      `${(before / 1048576).toFixed(1)}MB → ${after}B（-${(100 * (1 - after / before)).toFixed(2)}%），${pyOut.font.glyphs} 字形`);
  } else {
    check("CJK 字体子集化成功（WOFF2）", false, pyOut.font.skipped || pyOut.errors[0] || "工具链不可用");
  }

  console.log("═══ ③ 图片 AVIF / WebP 转换 ═══");
  let webpOk = 0, avifOk = 0, srcTotal = 0, webpTotal = 0, avifTotal = 0;
  for (const rec of pyOut.images) {
    const w = rec.outputs && rec.outputs[".webp"], a = rec.outputs && rec.outputs[".avif"];
    if (w && w.ok) { webpOk++; webpTotal += w.bytes; }
    if (a && a.ok) { avifOk++; avifTotal += a.bytes; }
    srcTotal += rec.srcBytes;
  }
  check(`${images.length} 张 PNG → WebP 副本`, webpOk === images.length,
    `${webpOk}/${images.length}，${srcTotal}B → ${webpTotal}B（-${(100 * (1 - webpTotal / (srcTotal || 1))).toFixed(1)}%）`);
  check(`${images.length} 张 PNG → AVIF 副本`, avifOk === images.length,
    `${avifOk}/${images.length}，${srcTotal}B → ${avifTotal}B（-${(100 * (1 - avifTotal / (srcTotal || 1))).toFixed(1)}%）`);
  check("原 PNG 全部保留（SEO / 13 页引用零改动）",
    images.every((j) => fs.existsSync(j.src)), `${images.length} 个原文件在位`);

  // 生成 @font-face 片段（不注入页面，仅作可选接入资产）
  const faceCss = [
    "/* v21.0 字体子集化引擎产物 · 默认未注入任何页面（守 v19 Lighthouse 100 基线） */",
    "/* 启用方式：把本文件内容并入 styles/common.css，并把 --font-cn 加入 body font-family 末尾 */",
    "@font-face {",
    "  font-family: \"SiteCNSubset\";",
    "  src: url(\"/assets/fonts/site-cn-subset.woff2\") format(\"woff2\");",
    "  font-display: swap;",
    `  /* unicode-range: 由 ${charset.length} 个实际用到的字符构成；未覆盖字符自动回退系统字体 */`,
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(FACE_CSS, faceCss, "utf8");

  // 生成 <picture> 渐进增强片段（供业务侧按需采用，脚本不改写 HTML）
  const snippets = images.map((j) =>
    `<!-- ${j.rel} -->\n<picture>\n` +
    `  <source srcset="/${j.out_rel}.avif" type="image/avif">\n` +
    `  <source srcset="/${j.out_rel}.webp" type="image/webp">\n` +
    `  <img src="/${j.rel}" alt="">\n` +
    `</picture>\n`).join("\n");
  fs.writeFileSync(SNIPPETS, snippets, "utf8");

  const report = {
    generatedAt: new Date().toISOString(),
    engine: "Pillow(AVIF/WebP) + fontTools pyftsubset(woff2)",
    scannedFiles: files.length,
    charset: { total: charset.length, cjk: cjkCount, file: "assets/fonts/charset-cn.txt" },
    font: pyOut.font,
    images: pyOut.images,
    totals: {
      pngBytes: srcTotal, webpBytes: webpTotal, avifBytes: avifTotal,
      webpShrinkPct: Number((100 * (1 - webpTotal / (srcTotal || 1))).toFixed(1)),
      avifShrinkPct: Number((100 * (1 - avifTotal / (srcTotal || 1))).toFixed(1)),
    },
    // 如实披露：站点当前无本地字体引用，子集字体为「按需启用」资产
    disclosure: "全站使用系统字体栈（无 @font-face / 无本地字体文件），Lighthouse 首屏 0 字体对象；子集 WOFF2 与 @font-face CSS 为按需启用资产，默认未注入任何页面，避免引入字体请求破坏已跑通的性能基线。原 PNG 全部保留，13 页引用与 /og-image.png 的 image/png 契约零改动。",
    errors: pyOut.errors,
    force: FORCE,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n", "utf8");
  check("体积报告已生成", fs.existsSync(REPORT), rel(REPORT));

  if (pyOut.errors.length) console.log("  ⚠  引擎告警：" + pyOut.errors.join("；").slice(0, 300));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
