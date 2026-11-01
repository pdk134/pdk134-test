# -*- coding: utf-8 -*-
# 动画精灵表烘焙：6 格切分 + 泛洪去底 + 底对齐拼横条
# 输入 assets/raw/src_c/d/e.png(主角/伙伴三套候选) src_g.png(丧尸6帧)
# 输出 assets/hero_sheet_{a,b,c}.png / ally_sheet_{a,b,c}.png / zombie_walk.png
from PIL import Image, ImageFilter
import os
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'assets', 'raw')
OUT = os.path.join(ROOT, 'assets')
os.makedirs(OUT, exist_ok=True)

def d2(c, r, g, b):
    dr, dg, db = c[0] - r, c[1] - g, c[2] - b
    return dr * dr + dg * dg + db * db

def is_bg_row(im, y, x0, x1, tol=30, ref=None):
    px = im.load(); n = okn = 0
    for x in range(x0, x1, 2):
        n += 1
        if d2(ref, *px[x, y]) < tol * tol: okn += 1
    return okn / max(1, n) > 0.985

def is_bg_col(im, x, y0, y1, tol=30, ref=None):
    px = im.load(); n = okn = 0
    for y in range(y0, y1, 2):
        n += 1
        if d2(ref, *px[x, y]) < tol * tol: okn += 1
    return okn / max(1, n) > 0.985

def bands(im, x0, x1, y0, y1, ref, min_h=20):
    rows = [is_bg_row(im, y, x0, x1, ref=ref) for y in range(y0, y1)]
    out, s = [], None
    for i, b in enumerate(rows):
        if not b and s is None: s = i
        elif b and s is not None:
            if i - s >= min_h: out.append((y0 + s, y0 + i))
            s = None
    if s is not None and len(rows) - s >= min_h:
        out.append((y0 + s, y0 + len(rows)))
    return out

def cells(im, y0, y1, x0, x1, ref, min_w=20):
    cols = [is_bg_col(im, x, y0, y1, ref=ref) for x in range(x0, x1)]
    out, s = [], None
    for i, b in enumerate(cols):
        if not b and s is None: s = i
        elif b and s is not None:
            if i - s >= min_w: out.append((x0 + s, x0 + i))
            s = None
    if s is not None and len(cols) - s >= min_w:
        out.append((x0 + s, x0 + len(cols)))
    return out

def remove_bg(im, bound=115):
    """深蓝底泛洪去底：暗且蓝主导 = 背景；亮色/描边/非蓝暗色保留"""
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    br = bg_ = bb = n = 0
    for x in range(2, w - 2, 2):
        for y in (2, h - 3):
            c = px[x, y]; br += c[0]; bg_ += c[1]; bb += c[2]; n += 1
    for y in range(2, h - 2, 2):
        for x in (2, w - 3):
            c = px[x, y]; br += c[0]; bg_ += c[1]; bb += c[2]; n += 1
    ref = (br / n, bg_ / n, bb / n)

    def ok(x, y):
        r, g, b, a = px[x, y]
        if a == 0: return False
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum >= 100: return False
        if b - r < 12 or b - g < 6: return False
        return d2(ref, r, g, b) < bound * bound

    visited = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if ok(x, y) and not visited[y * w + x]:
                visited[y * w + x] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if ok(x, y) and not visited[y * w + x]:
                visited[y * w + x] = 1; q.append((x, y))
    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx] and ok(nx, ny):
                visited[ny * w + nx] = 1; q.append((nx, ny))
    a = im.getchannel('A').filter(ImageFilter.GaussianBlur(0.8))
    im.putalpha(a)
    return im

def trim(im, pad=2):
    b = im.getbbox()
    if b:
        im = im.crop((max(0, b[0]-pad), max(0, b[1]-pad),
                      min(im.width, b[2]+pad), min(im.height, b[3]+pad)))
    return im

def strip_from_band(img, y0, y1, ref):
    cs = cells(img, y0, y1, 2, img.width - 2, ref, min_w=30)
    assert len(cs) >= 2, '格数异常: %d' % len(cs)
    frames = [trim(remove_bg(img.crop((x0, y0, x1, y1)))) for x0, x1 in cs]
    mw = max(f.width for f in frames)
    mh = max(f.height for f in frames)
    strip = Image.new('RGBA', (mw * len(frames), mh), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        # 底对齐（脚踩同一基线）+ 水平居中
        strip.paste(f, (i * mw + (mw - f.width) // 2, mh - f.height), f)
    return strip, len(cs)

def save(im, name):
    im.save(os.path.join(OUT, name))
    print('saved', name, im.size)

def process_pair(src_name, tag):
    """上=主角 下=伙伴 → hero_sheet_tag / ally_sheet_tag"""
    img = Image.open(os.path.join(RAW, src_name)).convert('RGB')
    ref = img.getpixel((6, 6))
    bl = bands(img, 2, img.width - 2, 0, img.height, ref, min_h=40)
    print(src_name, 'bands:', bl)
    assert len(bl) == 2, '应为两行: %s' % src_name
    s, n = strip_from_band(img, bl[0][0], bl[0][1], ref)
    print('  hero frames:', n)
    save(s, 'hero_sheet_%s.png' % tag)
    s, n = strip_from_band(img, bl[1][0], bl[1][1], ref)
    print('  ally frames:', n)
    save(s, 'ally_sheet_%s.png' % tag)

def process_single(src_name, out_name):
    """单行多格（丧尸 6 帧）"""
    img = Image.open(os.path.join(RAW, src_name)).convert('RGB')
    ref = img.getpixel((6, 6))
    bl = bands(img, 2, img.width - 2, 0, img.height, ref, min_h=40)
    print(src_name, 'bands:', bl)
    assert len(bl) == 1, '应为单行: %s' % src_name
    s, n = strip_from_band(img, bl[0][0], bl[0][1], ref)
    print('  frames:', n)
    save(s, out_name)

# 三套主角/伙伴候选（各 2 行：上=主角 下=伙伴）
process_pair('src_c.png', 'a')
process_pair('src_d.png', 'b')
process_pair('src_e.png', 'c')
# 移动（walk）两套候选
process_pair('src_h.png', 'walk_a')
process_pair('src_i.png', 'walk_b')
# 丧尸 6 帧（覆盖旧 4 帧表）
process_single('src_g.png', 'zombie_walk.png')

# ---- 预览拼图（灰底目检）----
files = ['hero_sheet_a.png', 'ally_sheet_a.png',
         'hero_sheet_b.png', 'ally_sheet_b.png',
         'hero_sheet_c.png', 'ally_sheet_c.png',
         'hero_sheet_walk_a.png', 'ally_sheet_walk_a.png',
         'hero_sheet_walk_b.png', 'ally_sheet_walk_b.png',
         'zombie_walk.png']
PV = Image.new('RGB', (1200, 240 * len(files) + 20), (72, 72, 84))
for i, f in enumerate(files):
    p = os.path.join(OUT, f)
    if not os.path.exists(p):
        continue
    t = Image.open(p)
    t.thumbnail((1160, 220))
    PV.paste(t, (20, i * 240 + 10), t)
PV.save(os.path.join(ROOT, 'tools', 'preview3.png'))
print('preview saved')
