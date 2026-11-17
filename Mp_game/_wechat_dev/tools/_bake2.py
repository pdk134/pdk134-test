# -*- coding: utf-8 -*-
# 元宝生图离线烘焙：切片 + 去底（泛洪）+ 闪电辉光α + 水印修补
# 输入 assets/raw/src_b.png → 输出 assets/{hero,ally,floor,title,bolt1-4,decor1-4}.png
from PIL import Image, ImageFilter
import os
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'assets', 'raw', 'src_b.png')
OUT = os.path.join(ROOT, 'assets')
os.makedirs(OUT, exist_ok=True)

img = Image.open(RAW).convert('RGB')
W, H = img.size
BG = img.getpixel((6, 6))  # 背景参考色（角落深蓝）

def d2(c, r, g, b):
    dr, dg, db = c[0] - r, c[1] - g, c[2] - b
    return dr * dr + dg * dg + db * db

def is_bg_row(im, y, x0, x1, tol=30):
    px = im.load()
    n = okn = 0
    for x in range(x0, x1, 2):
        n += 1
        if d2(BG, *px[x, y]) < tol * tol:
            okn += 1
    return okn / max(1, n) > 0.985

def is_bg_col(im, x, y0, y1, tol=30):
    px = im.load()
    n = okn = 0
    for y in range(y0, y1, 2):
        n += 1
        if d2(BG, *px[x, y]) < tol * tol:
            okn += 1
    return okn / max(1, n) > 0.985

def bands(im, x0, x1, y0, y1, min_h=20):
    """按水平背景带切出内容行段 [(ys,ye), ...]"""
    rows = [is_bg_row(im, y, x0, x1) for y in range(y0, y1)]
    out, s = [], None
    for i, b in enumerate(rows):
        if not b and s is None:
            s = i
        elif b and s is not None:
            if i - s >= min_h:
                out.append((y0 + s, y0 + i))
            s = None
    if s is not None and len(rows) - s >= min_h:
        out.append((y0 + s, y0 + len(rows)))
    return out

def cells(im, y0, y1, x0, x1, min_w=20):
    """按垂直背景带切出内容列段 [(xs,xe), ...]"""
    cols = [is_bg_col(im, x, y0, y1) for x in range(x0, x1)]
    out, s = [], None
    for i, b in enumerate(cols):
        if not b and s is None:
            s = i
        elif b and s is not None:
            if i - s >= min_w:
                out.append((x0 + s, x0 + i))
            s = None
    if s is not None and len(cols) - s >= min_w:
        out.append((x0 + s, x0 + len(cols)))
    return out

def remove_bg(im, lum_floor=110, edge_tol=26, bound=115):
    """边缘泛洪去底：亮度下限保护深色描边，色差跟随背景渐变扩散"""
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    # 参考色：四边内缩均值
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
        if a == 0:
            return False
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        # 深蓝底判据：暗 且 蓝主导。亮色/描边/棕树干/绿草一律保留
        if lum >= 100:
            return False
        if b - r < 12 or b - g < 6:
            return False
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
    # 边缘羽化
    a = im.getchannel('A').filter(ImageFilter.GaussianBlur(0.8))
    im.putalpha(a)
    return im

def glowize(im, lo=42, hi=150):
    """闪电帧：亮度→α（暗底透明、辉光柔和），配合加色混合使用"""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            l = 0.299 * r + 0.587 * g + 0.114 * b
            a = (l - lo) / (hi - lo)
            a = 255 if a > 1 else (0 if a < 0 else int(a * 255))
            px[x, y] = (r, g, b, a)
    return im

def patch_watermark(im, fw=0.30, fh=0.12):
    """用左侧同高度区域盖掉右下水印"""
    w, h = im.size
    bw, bh = int(w * fw), int(h * fh)
    src = im.crop((w - bw * 2 - 4, h - bh, w - bw - 4, h)).filter(ImageFilter.GaussianBlur(0.6))
    im.paste(src, (w - bw, h - bh))
    return im

def trim(im, pad=3):
    b = im.getbbox()
    if b:
        im = im.crop((max(0, b[0]-pad), max(0, b[1]-pad),
                      min(im.width, b[2]+pad), min(im.height, b[3]+pad)))
    return im

def fit(im, m):
    """等比缩放使最大边长 = m（让不同装饰视觉体量一致）"""
    w, h = im.size
    s = m / max(w, h)
    if s >= 1:
        return im
    return im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)

def save(im, name):
    p = os.path.join(OUT, name)
    im.save(p)
    print('saved', name, im.size)

# ---- 布局探测 ----
RIGHT_X0, RIGHT_X1 = int(W * 0.50), W - 2
row_bands_right = bands(img, RIGHT_X0, RIGHT_X1, 0, H, min_h=30)
print('right bands:', row_bands_right)
assert len(row_bands_right) >= 3, '行带探测失败'

hero_band, bolt_band, prop_band = row_bands_right[0], row_bands_right[1], row_bands_right[2]
title_band = row_bands_right[-1]

# 左侧地面：左半区第一个内容带
left_bands = bands(img, 2, int(W * 0.48), 0, int(H * 0.7), min_h=60)
floor_band = left_bands[0]
floor = img.crop((int(W*0.012), floor_band[0]+2, int(W*0.478), floor_band[1]-2))
save(floor, 'floor.png')

# 主角 / 伙伴（卡片内再内缩去描边）
hc = cells(img, hero_band[0], hero_band[1], RIGHT_X0, RIGHT_X1, min_w=40)
print('hero band cells:', hc)
hx0, hx1 = hc[0]; ax0, ax1 = hc[1]
inset = 8
hero = remove_bg(img.crop((hx0+inset, hero_band[0]+inset, hx1-inset, hero_band[1]-inset)))
ally = remove_bg(img.crop((ax0+inset, hero_band[0]+inset, ax1-inset, hero_band[1]-inset)))
save(trim(hero), 'hero.png')
save(trim(ally), 'ally.png')

# 闪电 4 帧
bc = cells(img, bolt_band[0], bolt_band[1], RIGHT_X0, RIGHT_X1, min_w=30)
print('bolt cells:', bc)
for i, (x0, x1) in enumerate(bc[:4]):
    f = glowize(img.crop((x0, bolt_band[0], x1, bolt_band[1])))
    save(trim(f, pad=1), 'bolt%d.png' % (i + 1))

# 装饰 4 件（保留接地阴影，统一缩放到最大边长 84 让比例协调）
pc = cells(img, prop_band[0], prop_band[1], RIGHT_X0, RIGHT_X1, min_w=30)
print('prop cells:', pc)
for i, (x0, x1) in enumerate(pc[:4]):
    d = remove_bg(img.crop((x0, prop_band[0], x1, prop_band[1])), lum_floor=60, bound=130)
    save(fit(trim(d), 84), 'decor%d.png' % (i + 1))

# 标题背景（整宽 + 水印修补）
title = img.crop((int(W*0.005), title_band[0]+2, int(W*0.995), min(H, title_band[1]+6)))
patch_watermark(title)
save(title, 'title.png')

# ---- 预览拼图（灰底便于目检白边/黑边）----
files = ['hero.png','ally.png','decor1.png','decor2.png','decor3.png','decor4.png',
         'bolt1.png','bolt2.png','bolt3.png','bolt4.png']
PV = Image.new('RGB', (5 * 220, 3 * 260), (72, 72, 84))
for i, f in enumerate(files):
    p = os.path.join(OUT, f)
    if not os.path.exists(p):
        continue
    t = Image.open(p)
    t.thumbnail((200, 240))
    PV.paste(t, ((i % 5) * 220 + 10, (i // 5) * 260 + 10), t)
for i, f in enumerate(['floor.png', 'title.png']):
    t = Image.open(os.path.join(OUT, f))
    t.thumbnail((210, 240))
    PV.paste(t, (i * 220 + 10, 2 * 260 + 10))
PV.save(os.path.join(ROOT, 'tools', 'preview.png'))
print('preview saved')
