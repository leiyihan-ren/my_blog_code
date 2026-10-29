#!/usr/bin/env python3
"""相册缩略图批量生成器（v8.1 性能攻坚配套工具）

背景
----
相册列表页原先直接加载原图。实测单张 2456×1600 的 JPEG 有 549KB，
经 Worker 代理拉取要 2.3s，直接把列表页 LCP 钉死在 3~4s。

为什么不在边缘实时压缩：
  * 免费计划没有 Cloudflare Image Resizing（/cdn-cgi/image/... 实测 404）；
  * 它对需要鉴权的 Worker 代理路径也取不到源（401）；
  * Worker 运行时没有图像库，做不了实时缩放。
因此改为「仓库内预生成缩略图」，列表页只加载 9KB 的缩略图（原图的 1.7%）。

本脚本做的事
------------
1. 读取内容仓库（默认 leiyihan-ren/Blog）相册目录里的所有图片；
2. 对还没有缩略图的，下载原图 → 缩放 → 压成渐进式 JPEG；
3. 通过 GitHub Contents API 提交到 <相册目录>/thumbs/<同名文件>。

幂等：已有缩略图且内容一致则跳过，重复执行安全。

用法
----
    export GITHUB_TOKEN=ghp_xxx
    python3 scripts/gen-album-thumbs.py                 # 处理缺失的缩略图
    python3 scripts/gen-album-thumbs.py --dry-run       # 只看会做什么，不提交
    python3 scripts/gen-album-thumbs.py --force         # 全部重新生成
    python3 scripts/gen-album-thumbs.py --width 640     # 自定义缩略图宽度

依赖：pip install pillow requests
"""

import argparse
import base64
import io
import sys

try:
    import requests
    from PIL import Image
except ImportError:
    sys.exit("缺少依赖，请先执行：pip install pillow requests")

API = "https://api.github.com"
IMG_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")
THUMB_DIR = "thumbs"  # 必须与 _worker.js 里的 THUMB_DIR 保持一致


class GhClient:
    """GitHub Contents API 的最小封装"""

    def __init__(self, token, repo, branch="main"):
        self.repo, self.branch = repo, branch
        self.h = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _url(self, path):
        return f"{API}/repos/{self.repo}/contents/{path}?ref={self.branch}"

    def list_dir(self, path):
        r = requests.get(self._url(path), headers=self.h, timeout=60)
        if r.status_code == 404:
            return []
        if r.status_code != 200:
            sys.exit(f"读取目录失败 {path} {r.status_code}: {r.text[:200]}")
        return r.json()

    def put_file(self, path, data: bytes, message: str):
        body = base64.b64encode(data).decode()
        cur = requests.get(self._url(path), headers=self.h, timeout=60)
        if cur.status_code == 200:
            if cur.json().get("content", "").replace("\n", "") == body:
                return "skip"  # 内容一致，无需重复提交
            sha = cur.json()["sha"]
        elif cur.status_code == 404:
            sha = None
        else:
            return f"读取失败 {cur.status_code}"
        payload = {"message": message, "content": body, "branch": self.branch}
        if sha:
            payload["sha"] = sha
        r = requests.put(self._url(path).split("?")[0], headers=self.h, json=payload, timeout=180)
        if r.status_code not in (200, 201):
            return f"提交失败 {r.status_code}: {r.text[:160]}"
        return "ok"


def collect_images(client, root, prefix=""):
    """递归收集相册目录里的图片，返回 [(仓库内相对路径, 下载 URL)]"""
    out = []
    for item in client.list_dir(f"{root}/{prefix}".strip("/")):
        name, typ = item["name"], item["type"]
        rel = f"{prefix}/{name}" if prefix else name
        if typ == "dir":
            if name == THUMB_DIR:
                continue  # 缩略图目录不是照片，跳过
            out += collect_images(client, root, rel)
        elif typ == "file" and name.lower().endswith(IMG_EXTS):
            out.append((rel, item.get("download_url") or ""))
    return out


def make_thumb(raw: bytes, width: int, quality: int) -> bytes:
    """把原图字节缩放为渐进式 JPEG 缩略图"""
    im = Image.open(io.BytesIO(raw))
    if im.width <= width:
        # 原图本身就不大：只重编码，不放大
        h = im.height
    else:
        h = round(im.height * width / im.width)
        im = im.resize((width, h), Image.LANCZOS)
    # 统一转 RGB：PNG/GIF 带 alpha 或调色板时无法直接存 JPEG
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGB")
    elif im.mode != "RGB":
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="leiyihan-ren/Blog", help="内容仓库 owner/name")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--album-path", default="photos", help="仓库内相册目录")
    ap.add_argument("--width", type=int, default=480, help="缩略图宽度（像素）")
    ap.add_argument("--quality", type=int, default=72, help="JPEG 质量 1-95")
    ap.add_argument("--raw-prefix", default="https://raw.githubusercontent.com",
                    help="下载原图用的镜像前缀")
    ap.add_argument("--force", action="store_true", help="已存在也重新生成")
    ap.add_argument("--dry-run", action="store_true", help="只汇报，不提交")
    args = ap.parse_args()

    import os
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("请先设置环境变量 GITHUB_TOKEN")

    client = GhClient(token, args.repo, args.branch)
    print(f"仓库：{args.repo}@{args.branch}  相册目录：{args.album_path}")
    print("扫描图片…")
    images = collect_images(client, args.album_path)
    print(f"发现 {len(images)} 张照片\n")

    existing = set()
    if not args.force:
        # 一次性列出现有缩略图，避免为每张照片都发一次 API 请求
        for item in client.list_dir(f"{args.album_path}/{THUMB_DIR}"):
            if item["type"] == "file":
                existing.add(item["name"])
        print(f"已有缩略图 {len(existing)} 张，跳过这些照片\n")

    stats = {"ok": 0, "skip": 0, "fail": 0}
    for rel, dl in images:
        fname = rel.split("/")[-1]
        if not args.force and fname in existing:
            stats["skip"] += 1
            print(f"  ⏭  跳过（已有缩略图） {rel}")
            continue

        url = dl or f"{args.raw_prefix}/{args.repo}/{args.branch}/{args.album_path}/{rel}"
        try:
            r = requests.get(url, timeout=120)
            if r.status_code != 200:
                print(f"  ❌ 下载失败 {rel} HTTP {r.status_code}")
                stats["fail"] += 1
                continue
            raw = r.content
            thumb = make_thumb(raw, args.width, args.quality)
        except Exception as e:
            print(f"  ❌ 处理失败 {rel}: {e}")
            stats["fail"] += 1
            continue

        ratio = len(thumb) / len(raw) * 100 if raw else 0
        print(f"  📐 {rel}: {len(raw)/1024:.0f}KB → {len(thumb)/1024:.1f}KB ({ratio:.1f}%)")
        if args.dry_run:
            print("     （dry-run，未提交）")
            stats["skip"] += 1
            continue
        res = client.put_file(
            f"{args.album_path}/{THUMB_DIR}/{fname}", thumb,
            f"perf: 生成相册缩略图 {fname}（{len(thumb)//1024}KB）",
        )
        if res == "ok":
            stats["ok"] += 1
        else:
            print(f"     ⚠️  {res}")
            stats["fail"] += 1

    print(f"\n完成：新增 {stats['ok']} 张，跳过 {stats['skip']} 张，失败 {stats['fail']} 张")
    if stats["fail"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
