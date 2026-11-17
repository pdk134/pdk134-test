const Game = require('./game.js')
const loader = require('./assets.js')
const { CONFIG } = require('./config.js')
const audio = require('./audio.js')

// 微信云开发：填了 CLOUD_ENV 就初始化（云存储下载无需配 downloadFile 合法域名）
if (CONFIG.CLOUD_ENV && wx.cloud) {
  wx.cloud.init({ env: CONFIG.CLOUD_ENV, traceUser: true }, (err) => {
    if (err) console.warn('[cloud] init 失败:', err.errMsg || err)
    else console.log('[cloud] init 成功, env =', CONFIG.CLOUD_ENV)
  })
} else {
  console.warn('[cloud] 未初始化：CLOUD_ENV=', CONFIG.CLOUD_ENV, ' wx.cloud=', !!wx.cloud)
}

// 资源路径前缀：云存储 > 普通 CDN > 本地 assets/
// （三种模式由前缀自动识别，见 assets.js 的 load）
const REMOTE_MODE = !!(CONFIG.CLOUD_BASE || CONFIG.REMOTE_BASE)
const BASE = CONFIG.CLOUD_BASE || CONFIG.REMOTE_BASE || 'assets/'
const A = (p) => BASE + p

// 预加载美术资源（缺失时回退矢量绘制）
// 丧尸美术已离线烘焙为透明 PNG（tools/_bake.py），运行时零像素处理，无白底风险
// 主链：6 帧走路表；缺失时回退静态透明图，最后矢量占位
let resLoaded = 0, resTotal = 0
const track = (p) => { resTotal++; return p.then(() => { resLoaded++ }) }
track(loader.loadSheet('zombie', A('zombie_walk.png'), 6, { raw: true }).then((s) => {
  if (!s) return loader.load('zombie', A('zombie.png'))
}))
// 主角/伙伴动画：walk 帧（hero_sheet.png / ally_sheet.png，移动时播放，待出图）
// idle 帧（hero_sheet_idle.png / ally_sheet_idle.png，站立待机保留）
// 没有 walk 帧时自动用 idle 帧；两者都没有则回退静态 hero.png / ally.png
track(loader.loadSheet('hero_walk', A('hero_sheet.png'), 6, { raw: true }).then((s) => {
  if (!s) return loader.load('hero', A('hero.png'))
}))
track(loader.loadSheet('hero_idle', A('hero_sheet_idle.png'), 6, { raw: true }).then((s) => {
  if (!s) return loader.load('hero', A('hero.png'))
}))
track(loader.loadSheet('ally_walk', A('ally_sheet.png'), 6, { raw: true }).then((s) => {
  if (!s) return loader.load('ally', A('ally.png'))
}))
track(loader.loadSheet('ally_idle', A('ally_sheet_idle.png'), 6, { raw: true }).then((s) => {
  if (!s) return loader.load('ally', A('ally.png'))
}))
// 场景：地面整图 / 标题背景 / 装饰贴花 / 闪电冲击帧（tools/_bake2.py 烘焙）
track(loader.load('floor', A('floor.png')))
track(loader.load('title', A('title.png')))
for (let i = 1; i <= 4; i++) {
  track(loader.load('decor' + i, A('decor' + i + '.png')))
  track(loader.load('bolt' + i, A('bolt' + i + '.png')))
}

// 创建主画布
const canvas = wx.createCanvas()
const ctx = canvas.getContext('2d')
const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync())
canvas.width = info.windowWidth
canvas.height = info.windowHeight

const game = new Game(canvas.width, canvas.height)
audio.init()   // 预建音效实例，开局即加载好

let last = Date.now()
function loop() {
  const now = Date.now()
  let dt = (now - last) / 1000
  last = now
  if (dt > 0.05) dt = 0.05 // 防止切后台回来后跳变
  game.update(dt)
  game.render(ctx)
  // 远程/云存储资源未就绪时显示加载进度（仅远程模式；本地模式不闪屏）
  if (REMOTE_MODE && resLoaded < resTotal) {
    ctx.fillStyle = '#0c0c14'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.font = `bold ${Math.floor(canvas.width * 0.06)}px sans-serif`
    ctx.fillText('资源加载中…', canvas.width / 2, canvas.height * 0.45)
    ctx.fillText(`${resLoaded} / ${resTotal}`, canvas.width / 2, canvas.height * 0.53)
    ctx.textAlign = 'left'
  }
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
