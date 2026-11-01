// 矢量精灵绘制（无图片资源时的占位）+ 真实 PNG 覆盖
const loader = require('./assets.js')

// 受击泛白叠层（加色混合，hitFlash 越大越亮）
function flashOverlay(ctx, e, x, y, rad) {
  if (!e.hitFlash || e.hitFlash <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = Math.min(1, e.hitFlash * 7) * 0.55
  ctx.fillStyle = '#e6f6ff'
  ctx.beginPath()
  ctx.arc(x, y, rad, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawX(ctx, x, y, s) {
  ctx.beginPath()
  ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s)
  ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s)
  ctx.stroke()
}

// 以中心 (x,y) 绘制一张正方形精灵图
function drawImageSprite(ctx, img, x, y, size) {
  ctx.drawImage(img, x - size / 2, y - size / 2, size, size)
}

// 绘制精灵表的一帧：保持宽高比（按帧高缩放）、faceLeft 水平翻转、
// sheet.seq 可自定义播放顺序（如 [0,1,2,3,2,1] 往返消除 4→1 跳变）、轻微上下起伏
function drawSheet(ctx, sheet, x, y, size, faceLeft, frameSeed) {
  const frameDur = 180 // 每帧毫秒（蹒跚感）
  const seq = sheet.seq || null
  const steps = seq ? seq.length : sheet.frames
  let f = Math.floor(Date.now() / frameDur + frameSeed) % steps
  if (f < 0) f += steps
  const frame = seq ? seq[f] : f
  // 宽高比修正：帧是长方形时不再压扁成方形
  const scale = size / sheet.frameH
  const w = sheet.frameW * scale
  // 走路起伏：与帧周期同步的上下浮动
  const period = frameDur * steps
  const bob = Math.abs(Math.sin((Date.now() % period) / period * Math.PI * 2 + frameSeed)) * size * 0.04
  ctx.save()
  ctx.translate(x, y)
  if (faceLeft) ctx.scale(-1, 1)
  ctx.drawImage(sheet.canvas, frame * sheet.frameW, 0, sheet.frameW, sheet.frameH, -w / 2, -size / 2 - bob, w, size)
  ctx.restore()
}

// 丧尸：优先用 PNG 精灵表（行走动画）> 静态图 > 矢量占位
function drawZombie(ctx, e) {
  const sheet = loader.getSheet('zombie')
  if (sheet) {
    // 4 帧旧表用往返播放消除姿态跳变；6 帧新表本身是闭环，直接正放循环
    if (!sheet.seq && sheet.frames === 4) sheet.seq = [0, 1, 2, 3, 2, 1]
    const size = e.radius * 3.6
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.beginPath()
    ctx.ellipse(e.x, e.y + size * 0.42, size * 0.26, size * 0.08, 0, 0, Math.PI * 2)
    ctx.fill()
    drawSheet(ctx, sheet, e.x, e.y, size, (e.faceX || 0) < 0, e.id)
    flashOverlay(ctx, e, e.x, e.y, size * 0.5)
    return
  }

  const img = loader.get('zombie')
  if (img) {
    const size = e.radius * 3.4
    // 地面阴影
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.beginPath()
    ctx.ellipse(e.x, e.y + size * 0.42, size * 0.26, size * 0.08, 0, 0, Math.PI * 2)
    ctx.fill()
    drawImageSprite(ctx, img, e.x, e.y, size)
    flashOverlay(ctx, e, e.x, e.y, size * 0.5)
    return
  }

  const r = e.radius
  const t = Date.now() / 1000
  const walk = Math.sin(t * 7 + e.id) * r * 0.18
  const fx = e.faceX || 0
  const fy = e.faceY || 1
  const px = -fy
  const py = fx

  ctx.save()
  ctx.translate(e.x, e.y)

  // 地面阴影
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.beginPath(); ctx.ellipse(0, r * 0.95, r * 0.9, r * 0.35, 0, 0, Math.PI * 2); ctx.fill()

  // 腿（走路摆动）
  ctx.strokeStyle = '#4e7d36'; ctx.lineWidth = r * 0.32; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(-r * 0.3, r * 0.5); ctx.lineTo(-r * 0.3 + walk, r * 1.05); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(r * 0.3, r * 0.5); ctx.lineTo(r * 0.3 - walk, r * 1.05); ctx.stroke()

  // 双臂前伸（朝移动方向）
  ctx.strokeStyle = '#6ab04c'; ctx.lineWidth = r * 0.4
  ctx.beginPath()
  ctx.moveTo(-px * r * 0.4, -py * r * 0.4); ctx.lineTo(fx * r * 1.25 - px * r * 0.4, fy * r * 1.25 - py * r * 0.4)
  ctx.moveTo(px * r * 0.4, py * r * 0.4); ctx.lineTo(fx * r * 1.25 + px * r * 0.4, fy * r * 1.25 + py * r * 0.4)
  ctx.stroke()

  // 身体 + 描边
  ctx.fillStyle = '#6ab04c'
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#2f5e22'; ctx.lineWidth = 2.5; ctx.stroke()

  // 破衣块
  ctx.fillStyle = '#3d6b2d'
  ctx.beginPath(); ctx.arc(0, r * 0.22, r * 0.5, 0, Math.PI * 2); ctx.fill()

  // 头
  ctx.fillStyle = '#7bc95f'
  ctx.beginPath(); ctx.arc(0, -r * 0.15, r * 0.55, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#2f5e22'; ctx.stroke()

  // 眼：一 X 一圆
  ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 1.6
  drawX(ctx, -r * 0.2, -r * 0.18, r * 0.12)
  ctx.fillStyle = '#1c1c1c'
  ctx.beginPath(); ctx.arc(r * 0.2, -r * 0.18, r * 0.08, 0, Math.PI * 2); ctx.fill()

  // 张嘴
  ctx.beginPath(); ctx.arc(0, r * 0.02, r * 0.14, 0, Math.PI, false); ctx.stroke()

  // 受击泛红
  if (e.hp < e.maxHp) {
    ctx.fillStyle = 'rgba(255,60,60,0.28)'
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill()
  }

  ctx.restore()
  flashOverlay(ctx, e, 0, 0, r * 1.1)
}

// 二次元 Q 版角色：双马尾、大眼、腮红、裙子；可覆盖 PNG / 精灵表
// walkName/idleName 分别为移动/待机精灵表；moving 为是否在移动；
// 优先用匹配状态的表，缺失时另一套兜底，再无则静态图，最后矢量占位
function drawChibi(ctx, x, y, r, hair, dress, walkName, idleName, moving, fallbackName) {
  const idle = idleName ? loader.getSheet(idleName) : null
  const walk = walkName ? loader.getSheet(walkName) : null
  const sheet = moving ? (walk || idle) : (idle || walk)
  if (sheet) { drawSheet(ctx, sheet, x, y, r * 2.6, false, 0); return }
  const img = fallbackName ? loader.get(fallbackName) : null
  if (img) { drawImageSprite(ctx, img, x, y, r * 2.6); return }

  ctx.save()
  ctx.translate(x, y)

  // 地面阴影
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.beginPath(); ctx.ellipse(0, r * 1.0, r * 0.8, r * 0.3, 0, 0, Math.PI * 2); ctx.fill()

  // 裙子/身体
  ctx.fillStyle = dress
  ctx.beginPath()
  ctx.moveTo(-r * 0.9, r * 1.0)
  ctx.lineTo(r * 0.9, r * 1.0)
  ctx.lineTo(0, -r * 0.1)
  ctx.closePath(); ctx.fill()

  // 头
  ctx.fillStyle = '#ffe0bd'
  ctx.beginPath(); ctx.arc(0, -r * 0.4, r * 0.78, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#e8b98f'; ctx.lineWidth = 1.5; ctx.stroke()

  // 双马尾
  ctx.fillStyle = hair
  ctx.beginPath(); ctx.ellipse(-r * 0.82, -r * 0.35, r * 0.32, r * 0.6, 0.3, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(r * 0.82, -r * 0.35, r * 0.32, r * 0.6, -0.3, 0, Math.PI * 2); ctx.fill()

  // 刘海
  ctx.beginPath(); ctx.arc(0, -r * 0.5, r * 0.82, Math.PI * 1.02, Math.PI * 1.98); ctx.fill()

  // 眼睛
  ctx.fillStyle = '#2d3436'
  ctx.beginPath(); ctx.arc(-r * 0.27, -r * 0.38, r * 0.13, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(r * 0.27, -r * 0.38, r * 0.13, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.beginPath(); ctx.arc(-r * 0.31, -r * 0.42, r * 0.045, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(r * 0.23, -r * 0.42, r * 0.045, 0, Math.PI * 2); ctx.fill()

  // 腮红
  ctx.fillStyle = '#ff7675'; ctx.globalAlpha = 0.55
  ctx.beginPath(); ctx.arc(-r * 0.45, -r * 0.18, r * 0.13, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(r * 0.45, -r * 0.18, r * 0.13, 0, Math.PI * 2); ctx.fill()
  ctx.globalAlpha = 1

  ctx.restore()
}

module.exports = { drawZombie, drawChibi }
