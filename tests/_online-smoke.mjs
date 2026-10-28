// 线上冒烟验证：打开 /drive.html，输入 PIN，确认无 JS 错误且列表/文章接口正常
import { chromium } from "playwright";

const BASE = "https://leiyihan.pages.dev";
const PIN = process.env.DRIVE_PIN;
const ADMIN_PWD = process.env.ADMIN_PASSWORD;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " → " + detail : ""}`);
  ok ? pass++ : fail++;
};

// ---------- 1. 云盘页 ----------
{
  const page = await browser.newPage();
  const errors = [];
  const notFound = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });

  await page.goto(`${BASE}/drive.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 云盘用自定义模态输入口令（#pinModal/#pinInput/#btnPinOk），非原生 prompt
  await page.waitForSelector("#pinModal.show", { timeout: 20000 });
  await page.fill("#pinInput", PIN);
  await page.click("#btnPinOk");
  await page.waitForTimeout(5000);

  const rows = await page.locator("#fileTbody tr").count();
  if (notFound.length) console.log("   （404 资源：" + notFound.slice(0, 3).join(", ") + "）");
  check("云盘页加载零 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("文件列表已渲染（#fileTbody 行数 > 0）", rows > 0, `rows=${rows}`);
  const fmtOk = await page.evaluate(() => {
    const el = document.querySelector("#fileTbody tr td:nth-child(3)");
    return !!el && !/undefined|NaN|is not a function/.test(el.textContent || "");
  });
  check("大小列已由 fmtBytes 正确格式化", fmtOk);
  await page.close();
}

// ---------- 2. 文章 / 音乐 / 时间线 ----------
{
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  for (const p of ["/index.html", "/blog.html"]) {
    await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
  }
  check("首页/博客页零 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
}

// ---------- 3. 接口数据 ----------
{
  const posts = await (await fetch(`${BASE}/api/posts`)).json();
  const list = Array.isArray(posts) ? posts : posts.data || [];
  check("文章接口正常", Array.isArray(list) && list.length > 0, `条数=${list.length}`);
  check("文章列表不再包含 README", !list.some((p) => /^readme$/i.test(String(p.id || p.title || ""))),
    list.map((p) => p.id).join(",").slice(0, 80));

  const music = await (await fetch(`${BASE}/api/music`)).json();
  const ml = Array.isArray(music) ? music : music.data || [];
  check("音乐接口返回数据源", ml.length > 0 && !(ml.length === 1 && ml[0].title === "示例歌曲"),
    JSON.stringify(ml[0] || {}).slice(0, 90));

  const tl = await (await fetch(`${BASE}/api/timeline`)).json();
  const tll = Array.isArray(tl) ? tl : tl.data || [];
  check("时间线接口返回数据源", tll.length > 0 && !(tll.length === 1 && tll[0].title === "升入七年级"),
    JSON.stringify(tll[0] || {}).slice(0, 90));
}

// ---------- 4. 登录 ----------
{
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PWD }),
  });
  check("后台登录可用（新密钥生效）", r.status === 200, `HTTP ${r.status}`);
  const r2 = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-pwd-probe" }),
  });
  check("错误密码被拒（401，非 500）", r2.status === 401, `HTTP ${r2.status}`);
}

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
