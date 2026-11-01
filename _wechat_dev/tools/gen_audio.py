# -*- coding: utf-8 -*-
# 合成游戏音效：16bit / 22050Hz / 单声道 WAV（仅用标准库，无需素材）
# 输出到项目 audio/ 目录（放进上传包，注意 assets/ 已被排除）
import wave, struct, math, random, os

SR = 22050
OUT = r'D:/gitProjects/wechat-minigame/audio'

random.seed(7)


def write(name, samples, vol=0.85):
    peak = max(1e-9, max(abs(s) for s in samples))
    frames = bytearray()
    for s in samples:
        v = int(max(-1.0, min(1.0, s / peak * vol)) * 32767)
        frames += struct.pack('<h', v)
    path = os.path.join(OUT, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(frames))
    print('%-14s %6.1f KB' % (name, os.path.getsize(path) / 1024))


def saw(ph):
    return ((ph % (2 * math.pi)) / (2 * math.pi)) * 2 - 1


def shoot(dur=0.12):
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 38)
        thump = math.sin(2 * math.pi * 150 * t) * math.exp(-t * 26) * 0.6
        out.append((random.uniform(-1, 1) * 0.9 + thump) * e)
    return out


def zap(dur=0.28):
    n = int(SR * dur); out = []
    ph = 0.0
    for i in range(n):
        t = i / SR
        f = 700 + 300 * math.sin(2 * math.pi * 37 * t) + random.uniform(-120, 120)
        ph += 2 * math.pi * f / SR
        crack = random.uniform(-1, 1) * 0.25 * math.exp(-t * 40)
        e = math.exp(-t * 9) * min(1, t * 90)
        out.append((saw(ph) * 0.6 + crack) * e)
    return out


def boom(dur=0.34):
    n = int(SR * dur); out = []
    last = 0.0
    for i in range(n):
        x = (i / SR) / dur
        k = 0.08 + 0.5 * math.sin(math.pi * x)
        v = random.uniform(-1, 1)
        last = last * (1 - k) + v * k
        out.append(last * (math.sin(math.pi * x) ** 1.6))
    return out


def hit(dur=0.10):
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 45)
        out.append((random.uniform(-1, 1) * 0.7 + math.sin(2 * math.pi * 320 * t) * 0.5) * e)
    return out


def die(dur=0.40):
    n = int(SR * dur); out = []
    ph = 0.0
    for i in range(n):
        t = i / SR
        f = 190 * math.exp(-t * 3.2) + 55
        ph += 2 * math.pi * f / SR
        g = random.uniform(-1, 1) * 0.18 * math.exp(-t * 9)
        e = math.exp(-t * 6.5) * min(1, t * 120)
        out.append((saw(ph) * 0.7 + g) * e)
    return out


def hurt(dur=0.28):
    n = int(SR * dur); out = []
    ph = 0.0
    for i in range(n):
        t = i / SR
        f = 420 * math.exp(-t * 5.0) + 90
        ph += 2 * math.pi * f / SR
        sq = 1 if (ph % (2 * math.pi)) / (2 * math.pi) < 0.5 else -1
        e = math.exp(-t * 7) * min(1, t * 150)
        out.append(sq * 0.6 * e)
    return out


def levelup(dur=0.60):
    notes = [523.25, 659.25, 783.99, 1046.5]
    step = 0.13
    n = int(SR * dur); out = [0.0] * n
    for k, f in enumerate(notes):
        start = int(SR * k * step)
        end = min(n, start + int(SR * 0.24))
        for i in range(start, end):
            t = (i - start) / SR
            e = math.exp(-t * 9) * min(1, t * 200)
            out[i] += math.sin(2 * math.pi * f * t) * e * 0.6
    return out


def loot(dur=0.45):
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 7)
        f = 880 if t < 0.09 else 1318.5
        out.append((math.sin(2 * math.pi * f * t) + 0.4 * math.sin(2 * math.pi * f * 2 * t)) * e)
    return out


def click(dur=0.05):
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 90)
        out.append((random.uniform(-1, 1) * 0.5 + math.sin(2 * math.pi * 1400 * t) * 0.5) * e)
    return out


def wave_sound(dur=0.65):
    n = int(SR * dur); out = []
    ph = 0.0
    for i in range(n):
        t = i / SR
        f = 330 if t < 0.28 else 494
        ph += 2 * math.pi * f / SR
        vib = 1 + 0.01 * math.sin(2 * math.pi * 6 * t)
        e = min(1, t * 60) * math.exp(-max(0, t - 0.3) * 6)
        out.append(saw(ph) * 0.5 * e * vib)
    return out


def boom_hit(dur=0.22):
    # 回旋镖命中：闷响 + 高频瞬态
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR
        e = math.exp(-t * 22)
        out.append((math.sin(2 * math.pi * 110 * t) * 0.8 + random.uniform(-1, 1) * 0.3 * math.exp(-t * 60)) * e)
    return out


os.makedirs(OUT, exist_ok=True)
write('shoot.wav', shoot())
write('zap.wav', zap())
write('boom.wav', boom())
write('boom_hit.wav', boom_hit())
write('hit.wav', hit())
write('die.wav', die())
write('hurt.wav', hurt())
write('levelup.wav', levelup())
write('loot.wav', loot())
write('click.wav', click())
write('wave.wav', wave_sound())
total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print('total: %.1f KB (%d files)' % (total / 1024, len(os.listdir(OUT))))
