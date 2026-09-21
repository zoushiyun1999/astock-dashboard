#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/slice_image.py —— 长图切片器（Pillow）

为什么需要（2026-09-21 实测）：
  财经博主的长图动辄 4000~6000px 高（实测湖南人当日帖有 530x6157 与 760x4135 两张）。
  直接整张交给视觉模型会被等比压缩，表格里的股票名/代码/数字全部糊掉——
  实测直接把 530x6157 的「涨停原因分类表」丢进去，只能看出「有很多行」，完全无法转录。
  必须切成若干段并适度放大，才能读出内容。

策略：每段高度 ≤ max-height，段间保留 overlap 像素重叠（避免正好切断某一行），
      再按 scale 放大（让模型即使再做一次缩小仍保留细节）。

用法：
  python tools/slice_image.py <图片路径> <输出目录> [选项]
  python tools/slice_image.py <目录>     <输出目录> [选项]     # 批量处理目录下所有图片

选项：
  --max-height N   每段最大高度，默认 1200
  --overlap N      段间重叠像素，默认 80
  --scale F        放大倍数，默认 1.5

输出：stdout 打印 JSON
  {"ok":true, "slices":[{"src":"...", "parts":["...","..."], "size":[W,H], "segments":N}]}
  进度与错误一律走 stderr。

退出码：0 成功；1 参数或依赖错误；2 有图片无法读取（其余仍会处理并输出）。
"""

import sys
import os
import json
import glob

USAGE = __doc__.strip().split('\n')[-6] if False else (
    '用法：python tools/slice_image.py <图片或目录> <输出目录> '
    '[--max-height 1200] [--overlap 80] [--scale 1.5]'
)

EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif')


def parse_argv(argv):
    opts = {'max_height': 1200, 'overlap': 80, 'scale': 1.5}
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--max-height':
            opts['max_height'] = int(argv[i + 1]); i += 2
        elif a == '--overlap':
            opts['overlap'] = int(argv[i + 1]); i += 2
        elif a == '--scale':
            opts['scale'] = float(argv[i + 1]); i += 2
        else:
            rest.append(a); i += 1
    return rest, opts


def compute_segments(height, max_height, overlap):
    """返回 [(y0, y1), ...]，保证每段 ≤ max_height，段间重叠 overlap，无遗漏。"""
    if height <= max_height:
        return [(0, height)]
    segs = []
    y = 0
    while True:
        y1 = min(y + max_height, height)
        # 末段过短（< 1/3 段高）则并入前一段，避免浪费一次模型调用
        if y1 >= height and segs and (y1 - y) < max_height / 3:
            segs[-1] = (segs[-1][0], height)
            break
        segs.append((y, y1))
        if y1 >= height:
            break
        y = y1 - overlap
    return segs


def slice_one(path, outdir, opts, Image):
    im = Image.open(path)
    if im.mode not in ('RGB', 'L'):
        im = im.convert('RGB')
    W, H = im.size
    segs = compute_segments(H, opts['max_height'], opts['overlap'])
    base = os.path.splitext(os.path.basename(path))[0]
    parts = []
    for i, (y0, y1) in enumerate(segs):
        seg = im.crop((0, y0, W, y1))
        if opts['scale'] != 1.0:
            nw = max(1, int(seg.width * opts['scale']))
            nh = max(1, int(seg.height * opts['scale']))
            seg = seg.resize((nw, nh), Image.LANCZOS)
        out = os.path.join(outdir, '%s_p%02d.png' % (base, i + 1))
        seg.save(out, 'PNG')
        parts.append(out)
    return {'src': path, 'size': [W, H], 'segments': len(segs), 'parts': parts}


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ('-h', '--help'):
        print(USAGE)
        return 0

    rest, opts = parse_argv(argv)
    if len(rest) < 2:
        sys.stderr.write('✗ 需要两个位置参数：<图片或目录> <输出目录>\n' + USAGE + '\n')
        return 1
    src, outdir = rest[0], rest[1]

    try:
        from PIL import Image
    except ImportError:
        sys.stderr.write('✗ 缺少 Pillow。安装：pip install Pillow'
                         '（或 python -m pip install Pillow）\n')
        return 1

    if os.path.isdir(src):
        files = sorted(f for f in glob.glob(os.path.join(src, '*'))
                       if f.lower().endswith(EXTS))
    elif os.path.isfile(src):
        files = [src]
    else:
        sys.stderr.write('✗ 路径不存在：%s\n' % src)
        return 1

    if not files:
        sys.stderr.write('✗ 目录下没有可处理的图片：%s\n' % src)
        return 1

    os.makedirs(outdir, exist_ok=True)

    result = {'ok': True, 'slices': [], 'failed': []}
    for f in files:
        try:
            info = slice_one(f, outdir, opts, Image)
            result['slices'].append(info)
            sys.stderr.write('· %s  %dx%d → %d 段\n'
                             % (os.path.basename(f), info['size'][0], info['size'][1],
                                info['segments']))
        except Exception as e:
            result['failed'].append({'src': f, 'error': str(e)})
            sys.stderr.write('✗ %s 失败：%s\n' % (os.path.basename(f), e))

    if result['failed']:
        result['ok'] = False

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0 if result['failed'] else 0 if result['slices'] else 2


if __name__ == '__main__':
    sys.exit(main())
