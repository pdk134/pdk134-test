// 通用工具
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by)
}

function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v)
}

function rand(a, b) {
  return a + Math.random() * (b - a)
}

function randInt(a, b) {
  return Math.floor(rand(a, b + 1))
}

// 圆角矩形路径
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// 程序化生成可平铺的暗色废墟地面纹理（离屏 canvas，无需任何图片资源）
// 返回一张 size×size 的 tile，绘制时横向/纵向平铺即可；自适应任意屏幕尺寸
function makeFloorTile(size, base) {
  base = base || '#15151f'
  const cv = wx.createCanvas()
  cv.width = size; cv.height = size
  const c = cv.getContext('2d')
  c.fillStyle = base
  c.fillRect(0, 0, size, size)
  // 大块斑驳（暗色污渍），避开边缘以减少平铺接缝
  const m = size * 0.06
  for (let i = 0; i < size * size / 360; i++) {
    const x = m + Math.random() * (size - 2 * m)
    const y = m + Math.random() * (size - 2 * m)
    const r = 8 + Math.random() * 26
    const r0 = 18 + (Math.random() * 22 | 0)
    const g0 = 18 + (Math.random() * 22 | 0)
    const b0 = 28 + (Math.random() * 26 | 0)
    c.fillStyle = `rgba(${r0},${g0},${b0},0.45)`
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill()
  }
  // 细噪点（亮/暗各半，质感）
  for (let i = 0; i < size * size / 7; i++) {
    const x = Math.random() * size, y = Math.random() * size
    c.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)'
    c.fillRect(x, y, 1, 1)
  }
  // 裂纹
  c.strokeStyle = 'rgba(0,0,0,0.22)'
  c.lineWidth = 1
  for (let i = 0; i < 9; i++) {
    c.beginPath()
    let x = m + Math.random() * (size - 2 * m)
    let y = m + Math.random() * (size - 2 * m)
    c.moveTo(x, y)
    for (let j = 0; j < 4; j++) {
      x += (Math.random() - 0.5) * 40
      y += (Math.random() - 0.5) * 40
      c.lineTo(x, y)
    }
    c.stroke()
  }
  return cv
}

module.exports = { dist, clamp, rand, randInt, roundRect, makeFloorTile }
