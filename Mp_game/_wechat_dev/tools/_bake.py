# -*- coding: utf-8 -*-
# 离线烘焙：把 AI 生成的 JPEG 处理成透明 PNG 精灵表，运行时零像素处理
from PIL import Image
from collections import deque
import math, os

ASSETS = 'd:/gitProjects/wechat-minigame/assets/'

def remove_bg(im, clear_rects):
    w, h = im.size
    src = im.load()
    cleared = bytearray(w * h)
    for rx, ry, rw, rh in clear_rects:
        for y in range(int(ry * h), int((ry + rh) * h)):
            for x in range(int(rx * w), int((rx + rw) * w)):
                cleared[y * w + x] = 1
    bs = []
    for x in range(4, w - 4):
        for y in (2, 3, h - 4, h - 3):
            if not cleared[y * w + x]: bs.append(src[x, y])
    for y in range(4, h - 4):
        for x in (2, 3, w - 4, w - 3):
            if not cleared[y * w + x]: bs.append(src[x, y])
    br = sum(c[0] for c in bs) // len(bs)
    bg = sum(c[1] for c in bs) // len(bs)
    bb = sum(c[2] for c in bs) // len(bs)

    def ok(x, y):
        if cleared[y * w + x]: return False
        r, g, b = src[x, y]
        if 0.299 * r + 0.587 * g + 0.114 * b < 120: return False
        if g - r > 8 and g - b > 8: return False
        dr, dg, db = r - br, g - bg, b - bb
        return dr * dr + dg * dg + db * db <= 110 * 110

    visited = bytearray(w * h)
    q = deque()

    def seed(x, y):
        i = y * w + x
        if not visited[i] and ok(x, y):
            visited[i] = 1
            q.append(i)

    for x in range(w):
        for d in (2, 3):
            seed(x, d); seed(x, h - 1 - d)
    for y in range(h):
        for d in (2, 3):
            seed(d, y); seed(w - 1 - d, y)

    while q:
        i = q.popleft()
        x = i % w; y = i // w
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if visited[j] or not ok(nx, ny): continue
                c1 = src[nx, ny]; c2 = src[x, y]
                if math.sqrt(sum((c1[k] - c2[k]) ** 2 for k in range(3))) < 16:
                    visited[j] = 1
                    q.append(j)

    # 后处理 1：全局色键，清除被深色阴影/轮廓包围的封闭残留口袋
    # （手臂与躯干之间、两腿之间等泛洪进不去的区域）
    # 实测：口袋色距 0-40，白背心最近 58，皮肤 250+，容差 45 安全分离
    for y in range(h):
        base = y * w
        for x in range(w):
            i = base + x
            if visited[i] or cleared[i]:
                continue
            r, g, b = src[x, y]
            if 0.299 * r + 0.587 * g + 0.114 * b < 140: continue
            if g - r > 8 and g - b > 8: continue
            dr, dg, db = r - br, g - bg, b - bb
            if dr * dr + dg * dg + db * db <= 45 * 45:
                visited[i] = 1

    # 后处理 2：从已移除边界向内侵蚀，清理口袋边缘的过渡色
    # 条件：邻接已移除区 + 亮度足够 + 与参考色接近 + 非绿色主导（保护外套/皮肤）
    for _ in range(60):
        grow = []
        for y in range(1, h - 1):
            base = y * w
            for x in range(1, w - 1):
                i = base + x
                if visited[i] or cleared[i]:
                    continue
                r, g, b = src[x, y]
                if 0.299 * r + 0.587 * g + 0.114 * b < 105: continue
                if g - r > 8 and g - b > 8: continue
                dr, dg, db = r - br, g - bg, b - bb
                if dr * dr + dg * dg + db * db > 60 * 60: continue
                if visited[i - 1] or visited[i + 1] or visited[i - w] or visited[i + w]:
                    grow.append(i)
        if not grow:
            break
        for i in grow:
            visited[i] = 1
    return visited, cleared

def opaque_ratio(visited, w, h):
    return sum(1 for i in range(w * h) if not visited[i]) / (w * h)

# ---- 1) 走路表：4 列切片 → 包围盒 → 底对齐拼条 → 半分辨率 PNG ----
im = Image.open('C:/Users/admin/AppData/Local/Temp/3.jpeg').convert('RGB')
w, h = im.size
visited, cleared = remove_bg(im, [(0.8, 0.84, 0.2, 0.16)])
ratio = opaque_ratio(visited, w, h)
print('walk opaque ratio', round(ratio, 3))
assert ratio < 0.45, 'walk 去背景异常'

y0, y1 = round(0.3 * h), round(0.82 * h)
boxes = []
for c in range(4):
    x0 = round(c * w / 4) + 8
    x1 = round((c + 1) * w / 4) - 8
    mnx, mny, mxx, mxy = 10 ** 9, 10 ** 9, -1, -1
    for y in range(y0, y1):
        for x in range(x0, x1):
            if not visited[y * w + x] and not cleared[y * w + x]:
                mnx = min(mnx, x); mxx = max(mxx, x)
                mny = min(mny, y); mxy = max(mxy, y)
    boxes.append((mnx, mny, mxx, mxy))
mw = max(b[2] - b[0] + 1 for b in boxes)
mh = max(b[3] - b[1] + 1 for b in boxes)
strip = Image.new('RGBA', (mw * 4, mh), (0, 0, 0, 0))
sp = strip.load()
for i, (mnx, mny, mxx, mxy) in enumerate(boxes):
    bw, bh = mxx - mnx + 1, mxy - mny + 1
    for y in range(bh):
        for x in range(bw):
            if not visited[(mny + y) * w + mnx + x] and not cleared[(mny + y) * w + mnx + x]:
                r, g, b = im.getpixel((mnx + x, mny + y))
                sp[i * mw + (mw - bw) // 2 + x, mh - bh + y] = (r, g, b, 255)
strip = strip.resize((strip.width // 2, strip.height // 2), Image.LANCZOS)
strip.save(ASSETS + 'zombie_walk.png', optimize=True)
print('walk strip', strip.size)

# ---- 2) 静态兜底：单体图去底 + 裁剪 ----
im2 = Image.open('C:/Users/admin/AppData/Local/CodeBuddyExtension/Data/f1f15494-7709-43d1-b576-d40ec1893c1d/CodeBuddyIDE/f1f15494-7709-43d1-b576-d40ec1893c1d/history/796173bf7dd1d0e8dcf6a632b9b46171/67de6527e15e4451b414acacd4fd4fc8/assets/1.8d42ef6e2a.jpeg').convert('RGB')
w2, h2 = im2.size
visited2, cleared2 = remove_bg(im2, [(0.68, 0.85, 0.32, 0.15)])
print('static opaque ratio', round(opaque_ratio(visited2, w2, h2), 3))
mnx, mny, mxx, mxy = 10 ** 9, 10 ** 9, -1, -1
for y in range(h2):
    for x in range(w2):
        if not visited2[y * w2 + x] and not cleared2[y * w2 + x]:
            mnx = min(mnx, x); mxx = max(mxx, x)
            mny = min(mny, y); mxy = max(mxy, y)
out = Image.new('RGBA', (mxx - mnx + 1, mxy - mny + 1), (0, 0, 0, 0))
op = out.load()
for y in range(mxy - mny + 1):
    for x in range(mxx - mnx + 1):
        if not visited2[(mny + y) * w2 + mnx + x] and not cleared2[(mny + y) * w2 + mnx + x]:
            r, g, b = im2.getpixel((mnx + x, mny + y))
            op[x, y] = (r, g, b, 255)
out = out.resize((out.width // 2, out.height // 2), Image.LANCZOS)
out.save(ASSETS + 'zombie.png', optimize=True)
print('static', out.size)
