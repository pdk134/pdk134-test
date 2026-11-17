// 程序化特效（粒子/闪电/震屏/顿帧）+ 烘焙贴图闪电帧（bolt1-4.png，缺失自动跳过）
// 全部用 canvas 加色混合(lighter)绘制，配合暗色背景出炫光感
const loader = require('./assets.js')
const LIGHTNING = '#bfe9ff'

class Effects {
  constructor() {
    this.particles = []   // 电火花 / 碎块
    this.bolts = []       // 锯齿闪电线段
    this.rings = []       // 范围爆发扩散圈
    this.flashes = []     // 贴图闪电冲击帧
    this.shake = { t: 0, dur: 0, mag: 0 }
    this.hitStop = 0      // 命中顿帧计时(s)
  }

  // 电火花 / 碎片
  spark(x, y, color, opts) {
    opts = opts || {}
    const n = opts.count || 10
    const spd = opts.speed || 170
    const life = opts.life || 0.4
    const size = opts.size || 3
    const grav = opts.gravity != null ? opts.gravity : 0
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const s = spd * (0.4 + Math.random() * 0.8)
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: life * (0.6 + Math.random() * 0.6), maxLife: life,
        color, size: size * (0.6 + Math.random() * 0.8),
        gravity: grav
      })
    }
  }

  // 敌人死亡碎裂：主体绿块 + 青白电火花
  burst(x, y, color) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 80 + Math.random() * 210
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40,
        life: 0.5 + Math.random() * 0.4, maxLife: 0.8,
        color: Math.random() < 0.5 ? color : LIGHTNING,
        size: 3 + Math.random() * 4, gravity: 540
      })
    }
    this.spark(x, y, LIGHTNING, { count: 18, speed: 240, life: 0.4 })
  }

  // 锯齿闪电折线（从 a 到 b），自带辉光，短暂淡出
  bolt(ax, ay, bx, by, color, opts) {
    opts = opts || {}
    const segs = opts.segs || 6
    const jitter = opts.jitter || 20
    const life = opts.life || 0.14
    const nx = -(by - ay), ny = (bx - ax)
    const len = Math.hypot(nx, ny) || 1
    const pts = []
    for (let i = 0; i <= segs; i++) {
      const t = i / segs
      const x = ax + (bx - ax) * t
      const y = ay + (by - ay) * t
      if (i > 0 && i < segs) {
        const off = (Math.random() - 0.5) * jitter * 2
        pts.push({ x: x + nx / len * off, y: y + ny / len * off })
      } else {
        pts.push({ x, y })
      }
    }
    this.bolts.push({ pts, color: color || LIGHTNING, life, maxLife: life, width: opts.width || 3 })
  }

  // 范围爆发扩散圈（如雷暴特化的 AoE 落点）
  ring(x, y, r, color, opts) {
    opts = opts || {}
    this.rings.push({
      x, y, rMax: r,
      life: opts.life || 0.28, maxLife: opts.life || 0.28,
      color: color || LIGHTNING, width: opts.width || 3
    })
  }

  // 贴图闪电冲击帧（随机 4 帧之一，随机翻转/微旋转），无资源时静默跳过
  flash(x, y, scale, opts) {
    opts = opts || {}
    const img = loader.get('bolt' + (1 + Math.floor(Math.random() * 4)))
    if (!img) return
    const life = opts.life || 0.16
    this.flashes.push({
      x, y, img, life, maxLife: life,
      scale: scale || 0.45,
      rot: (Math.random() - 0.5) * 0.5,
      flip: Math.random() < 0.5
    })
  }

  shakeAdd(mag, dur) {
    if (mag > this.shake.mag || this.shake.t <= 0) {
      this.shake.mag = mag; this.shake.dur = dur; this.shake.t = dur
    }
  }

  hitStopAdd(d) { this.hitStop = Math.max(this.hitStop, d) }

  shakeOffset() {
    if (this.shake.t <= 0) return { x: 0, y: 0 }
    const k = this.shake.t / this.shake.dur
    const m = this.shake.mag * k
    return { x: (Math.random() - 0.5) * 2 * m, y: (Math.random() - 0.5) * 2 * m }
  }

  update(dt) {
    if (this.shake.t > 0) this.shake.t -= dt
    const ps = this.particles
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]
      p.life -= dt
      if (p.life <= 0) { ps.splice(i, 1); continue }
      p.vy += p.gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
    const bs = this.bolts
    for (let i = bs.length - 1; i >= 0; i--) {
      bs[i].life -= dt
      if (bs[i].life <= 0) bs.splice(i, 1)
    }
    const rs = this.rings
    for (let i = rs.length - 1; i >= 0; i--) {
      rs[i].life -= dt
      if (rs[i].life <= 0) rs.splice(i, 1)
    }
    const fs = this.flashes
    for (let i = fs.length - 1; i >= 0; i--) {
      fs[i].life -= dt
      if (fs[i].life <= 0) fs.splice(i, 1)
    }
  }

  draw(ctx) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // 闪电：先粗辉光后亮白芯
    for (const b of this.bolts) {
      const a = b.life / b.maxLife
      ctx.strokeStyle = b.color
      ctx.globalAlpha = a
      ctx.lineJoin = 'round'
      ctx.shadowColor = b.color
      ctx.shadowBlur = 10
      ctx.lineWidth = b.width + 6
      this._stroke(ctx, b.pts)
      ctx.shadowBlur = 0
      ctx.lineWidth = b.width
      ctx.strokeStyle = '#ffffff'
      ctx.globalAlpha = 1
      this._stroke(ctx, b.pts)
    }
    // 范围爆发扩散圈：从中心向外扩张并淡出
    for (const r of this.rings) {
      const k = 1 - r.life / r.maxLife
      const rad = r.rMax * k
      ctx.globalAlpha = r.life / r.maxLife
      ctx.strokeStyle = r.color
      ctx.lineWidth = r.width
      ctx.beginPath()
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 贴图闪电冲击帧：底部锚定命中点，加色发光
    for (const f of this.flashes) {
      const a = Math.max(0, f.life / f.maxLife)
      const w = f.img.width * f.scale
      const h = f.img.height * f.scale
      ctx.globalAlpha = a
      ctx.save()
      ctx.translate(f.x, f.y)
      ctx.rotate(f.rot)
      if (f.flip) ctx.scale(-1, 1)
      ctx.drawImage(f.img, -w / 2, -h * 0.78, w, h)
      ctx.restore()
    }

    // 粒子：加色发光（无 shadowBlur，用双层圆伪造辉光，性能友好）
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.maxLife)
      ctx.fillStyle = p.color
      ctx.globalAlpha = a * 0.35
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size * 2.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = a
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
  }

  _stroke(ctx, pts) {
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
  }
}

module.exports = Effects
