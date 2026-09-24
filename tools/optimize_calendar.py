#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
投资日历图片优化器 —— 在「保持可读性」的前提下把原图体积压下来。

背景与实测数据（2026-09-12，本机 Pillow 12.3）：
  dashboard/calendar/ 里的日历是 2008x20640 / 2008x23960 的**长图**，
  单张 PNG 原图 4.9MB / 5.9MB，合计 11MB。手机端要解码 41.4 兆像素（约 166MB 位图内存）。

  实测各方案（两张主图合计）：
    原图                      10.77 MB
    原尺寸 + 量化256色 + PNG    4.06 MB   ← 本脚本采用（不缩放，文字零损失）
    缩放至16383高 + WebP q85    4.48 MB
    缩放至12000高 + WebP q85    3.13 MB（但宽度被压到 1006px，缩放看会糊）

  结论：这类「扁平色块 + 文字」的图表，**量化调色板 + PNG** 比 WebP 更划算 ——
  不缩放、体积更小、扩展名不变（data.js 无需改路径），且耗时只有 WebP 的 1/20。

判定策略（绝不静默降质）：
  量化前后按 PSNR 打分（抽样计算，全图计算太慢）。
    · PSNR ≥ 阈值（默认 32dB）→ 认定为"肉眼无损"，写回原地
    · PSNR 低于阈值（说明图里有照片/渐变）→ **不动原图**，只打印告警，提示改走 WebP
    · 优化后反而变大 → 不写回

幂等：输出一定是 P 模式（调色板）PNG，所以再次运行会被"已是调色板"规则跳过。

用法：
  python tools/optimize_calendar.py               # 优化 dashboard/calendar/ 下所有未优化的图
  python tools/optimize_calendar.py --dry-run     # 只报告，不写文件
  python tools/optimize_calendar.py --quiet       # 安静模式（供 bump_version.sh 调用）

依赖：Pillow（本机在 ~/.workbuddy/binaries/python/envs/default 里已装）。缺依赖时退出码 0，不阻塞发布。
"""
import argparse
import io
import math
import os
import sys

try:
    from PIL import Image
    import numpy as np
except ImportError as e:
    print('[optimize_calendar] 跳过：缺少依赖（%s）。仅在需要压缩日历图时才有影响。' % e)
    sys.exit(0)

Image.MAX_IMAGE_PIXELS = None  # 长图会触发 Pillow 的解压炸弹保护，这里明确关掉

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CAL_DIR = os.path.join(ROOT, 'dashboard', 'calendar')

# 单边像素上限：**默认不缩放**。
#
# 踩过的坑：一开始想缩放到 16383（因为 WebP 编码器有这条硬限制），结果发现
#   ① LANCZOS 缩放会插出一堆中间色 → 量化后压缩率反而变差（1594x16383 只有 2.89MB，
#      而**原尺寸**量化后是 1.86MB，又小又清晰）
#   ② PNG 没有 16383 这条限制，缩放纯属多余
#   ③ 这两张图在生产环境已经渲染了半个月，浏览器没有渲染不出来
# 所以保持原分辨率。只有真正离谱大的图（超过下面这个软上限）才缩放并告警。
SOFT_MAX_SIDE = 30000
MAX_COLORS = 256
SKIP_BELOW_BYTES = 300 * 1024   # 小于 300KB 的图不值得优化
SAMPLE_STRIDE = 3               # PSNR 抽样步长（全图算太慢，抽样足够代表）

# ── 预览图（2026-09-24）：内嵌「折叠全图」用，点开即读不进全屏查看器 ──
# 原图 2008 宽对手机太重（1.5~2.2MB + 48MP 解码 ≈184MB 位图）。
# 实测（img1 主图，2008x23960）：
#   PNG 900宽量化160色 = 1115KB（长图上 PNG 量化不划算）
#   WebP 900/q80       =  904KB
#   WebP 720/q72       =  598KB  ← 采用：体积 1/3.7，解码 6.2MP≈25MB（1/7.5）
#   720/q60 只再省 8% 但文字明显糊，不值。
# 小字要细看时仍走「查看原图」（原分辨率 + 双指缩放）。
PREVIEW_WIDTH = 720
PREVIEW_KW = dict(quality=72, method=6)
PREVIEW_SUFFIX = '_prev.webp'


def sample_rgb(im, stride=SAMPLE_STRIDE):
    """抽样取 RGB 数组。调色板图按索引查色，避免为对比再造一张全尺寸 RGB（省内存）。"""
    if im.mode == 'P':
        idx = np.asarray(im, dtype=np.int32)[::stride, ::stride]
        pal = np.array(im.getpalette(), dtype=np.int16).reshape(-1, 3)
        return pal[idx]
    return np.asarray(im.convert('RGB'), dtype=np.int16)[::stride, ::stride]


def psnr(a, b, stride=SAMPLE_STRIDE):
    """抽样 PSNR（dB）。越高越接近原图。"""
    x = sample_rgb(a, stride)
    y = sample_rgb(b, stride)
    mse = float(np.mean((x - y) ** 2))
    if mse == 0:
        return float('inf')
    return 10 * math.log10((255.0 ** 2) / mse)


def encode_png(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True, compress_level=9)
    return buf.getvalue()


def encode_webp(im):
    buf = io.BytesIO()
    im.save(buf, 'WEBP', **PREVIEW_KW)
    return buf.getvalue()


def human(n):
    return '%.2fMB' % (n / 1048576.0)


def generate_previews(files, say):
    """为每张日历原图生成/刷新 _prev.webp（宽 PREVIEW_WIDTH，WebP 有损）。

    幂等：预览已存在且比源图新 → 跳过。失败只告警不抛（预览缺失时前端自动回退原图）。
    """
    made = 0
    for name in files:
        if '_prev.' in name or not name.lower().endswith('.png'):
            continue
        src = os.path.join(CAL_DIR, name)
        dst = os.path.join(CAL_DIR, name.rsplit('.', 1)[0] + PREVIEW_SUFFIX)
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            continue
        try:
            with Image.open(src) as im:
                w, h = im.size
                if w <= PREVIEW_WIDTH:
                    continue                      # 本来就小，无需预览
                nh = round(h * PREVIEW_WIDTH / float(w))
                prev = im.convert('RGB').resize((PREVIEW_WIDTH, nh), Image.LANCZOS)
                data = encode_webp(prev)
            with open(dst, 'wb') as f:
                f.write(data)
            made += 1
            say('[preview] %s → %s（%dx%d，%s）' % (name, os.path.basename(dst), PREVIEW_WIDTH, nh, human(len(data))))
        except Exception as e:    # noqa: BLE001 —— 预览是增强，失败不阻塞发布
            print('⚠️ [preview] %s 生成失败：%s（前端将回退原图）' % (name, e))
    if made:
        say('✓ 预览图：新生成 %d 张' % made)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--min-psnr', type=float, default=32.0)
    args = ap.parse_args()

    def say(s):
        if not args.quiet:
            print(s)

    if not os.path.isdir(CAL_DIR):
        say('（dashboard/calendar/ 不存在，跳过）')
        return

    files = sorted(f for f in os.listdir(CAL_DIR)
                   if os.path.isfile(os.path.join(CAL_DIR, f)))
    if not files:
        say('（calendar/ 为空，跳过）')
        return

    scanned = optimized = skipped = warned = 0
    total_before = total_after = 0
    rows = []

    for name in files:
        path = os.path.join(CAL_DIR, name)
        size = os.path.getsize(path)
        total_before += size

        if not name.lower().endswith(('.png', '.jpg', '.jpeg')):
            total_after += size
            continue

        with Image.open(path) as probe:
            fmt, mode = probe.format, probe.mode
            w, h = probe.size

        # 幂等：已是调色板 PNG（本脚本的产物）直接跳过
        if fmt == 'PNG' and mode == 'P':
            skipped += 1
            total_after += size
            continue
        if size < SKIP_BELOW_BYTES:
            skipped += 1
            total_after += size
            continue

        scanned += 1
        with Image.open(path) as im:
            raw = im.convert('RGB')

            resized = False
            if max(raw.size) > SOFT_MAX_SIDE:
                s = SOFT_MAX_SIDE / float(max(raw.size))
                raw = raw.resize((round(raw.width * s), round(raw.height * s)), Image.LANCZOS)
                resized = True

            quant = raw.quantize(colors=MAX_COLORS, method=Image.MEDIANCUT, dither=Image.NONE)
            score = psnr(raw, quant)
            data = encode_png(quant)

        if score < args.min_psnr:
            warned += 1
            total_after += size
            print('⚠️  %s：色彩丰富（PSNR %.1fdB < %.0fdB），保持原图不动。'
                  '这类图建议改走 WebP（需同步更新 data.js 路径）。'
                  % (name, score, args.min_psnr))
            continue

        if len(data) >= size:
            skipped += 1
            total_after += size
            rows.append((name, size, size, score, resized, '未变小，保持原样'))
            continue

        if not args.dry_run:
            tmp = path + '.tmp'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, path)

        optimized += 1
        total_after += len(data)
        rows.append((name, size, len(data), score, resized,
                     'dry-run' if args.dry_run else '已优化'))

    if rows:
        say('')
        say('  文件                             优化前    优化后   降幅   PSNR    备注')
        say('  ' + '-' * 82)
        for name, b, a, sc, rs, note in rows:
            say('  %-32s %8s %8s %5.0f%%  %5.1fdB  %s'
                % (name[:32], human(b), human(a), 100 - a * 100.0 / b, sc,
                   note + (' [已缩放]' if rs else '')))

    say('')
    generate_previews(files, say)
    say('')
    if scanned == 0 and optimized == 0 and warned == 0:
        say('✓ calendar/ 无需优化（%d 个文件，%s，全部已是最优状态）' % (len(files), human(total_before)))
    else:
        say('✓ 扫描 %d 个待优化图 → 优化 %d 个，跳过 %d 个，告警 %d 个；'
            'calendar/ %s → %s'
            % (scanned, optimized, skipped, warned, human(total_before), human(total_after)))


if __name__ == '__main__':
    main()
