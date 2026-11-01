const Game = require('./game.js')
const loader = require('./assets.js')

// 预加载美术资源（缺失时回退矢量绘制）
// 丧尸美术已离线烘焙为透明 PNG（tools/_bake.py），运行时零像素处理，无白底风险
// 主链：6 帧走路表；缺失时回退静态透明图，最后矢量占位
loader.loadSheet('zombie', 'assets/zombie_walk.png', 6, { raw: true }).then((s) => {
  if (!s) return loader.load('zombie', 'assets/zombie.png')
})
// 主角/伙伴动画：walk 帧（hero_sheet.png / ally_sheet.png，移动时播放，待出图）
// idle 帧（hero_sheet_idle.png / ally_sheet_idle.png，站立待机保留）
// 没有 walk 帧时自动用 idle 帧；两者都没有则回退静态 hero.png / ally.png
loader.loadSheet('hero_walk', 'assets/hero_sheet.png', 6, { raw: true }).then((s) => {
  if (!s) return loader.load('hero', 'assets/hero.png')
})
loader.loadSheet('hero_idle', 'assets/hero_sheet_idle.png', 6, { raw: true }).then((s) => {
  if (!s) return loader.load('hero', 'assets/hero.png')
})
loader.loadSheet('ally_walk', 'assets/ally_sheet.png', 6, { raw: true }).then((s) => {
  if (!s) return loader.load('ally', 'assets/ally.png')
})
loader.loadSheet('ally_idle', 'assets/ally_sheet_idle.png', 6, { raw: true }).then((s) => {
  if (!s) return loader.load('ally', 'assets/ally.png')
})
// 场景：地面整图 / 标题背景 / 装饰贴花 / 闪电冲击帧（tools/_bake2.py 烘焙）
loader.load('floor', 'assets/floor.png')
loader.load('title', 'assets/title.png')
for (let i = 1; i <= 4; i++) {
  loader.load('decor' + i, 'assets/decor' + i + '.png')
  loader.load('bolt' + i, 'assets/bolt' + i + '.png')
}

// 创建主画布
const canvas = wx.createCanvas()
const ctx = canvas.getContext('2d')
const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync())
canvas.width = info.windowWidth
canvas.height = info.windowHeight

const game = new Game(canvas.width, canvas.height)

let last = Date.now()
function loop() {
  const now = Date.now()
  let dt = (now - last) / 1000
  last = now
  if (dt > 0.05) dt = 0.05 // 防止切后台回来后跳变
  game.update(dt)
  game.render(ctx)
  requestAnimationFrame(loop)
}

// 触摸分发（小游戏触点坐标为 clientX/clientY）
function pointOf(e) {
  const t = e.touches[0]
  if (!t) return null
  return { x: (t.x != null) ? t.x : t.clientX, y: (t.y != null) ? t.y : t.clientY }
}

wx.onTouchStart(e => {
  const p = pointOf(e)
  if (p) game.onTouch(p.x, p.y)
})

wx.onTouchMove(e => {
  const p = pointOf(e)
  if (p) game.onTouchMove(p.x, p.y)
})

loop()
