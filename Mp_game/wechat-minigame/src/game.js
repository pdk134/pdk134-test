const { CONFIG } = require('./config.js')
const { dist, clamp, roundRect, makeFloorTile } = require('./utils.js')
const Player = require('./player.js')
const Enemy = require('./enemy.js')
const Companion = require('./companion.js')
const { CARD_POOL } = require('./skills.js')
const Effects = require('./effects.js')
const loader = require('./assets.js')
const Progress = require('./progress.js')
const { EQUIP_SLOTS, getEquip, slotName } = require('./equipment.js')
const { drawChibi } = require('./sprites.js')
const { WEAPONS } = require('./weapons.js')
const audio = require('./audio.js')

function inRect(x, y, r) {
  return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

// 游戏主体：状态机 + 刷怪 + 升级选卡 + 渲染 + 触摸分发
class Game {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.progress = Progress.load()   // 单例：已通关/拥有/装备
    this.effects = new Effects()      // 大厅/物品栏也要能安全跑特效老化
    this.floorTile = makeFloorTile(256) // 程序化地面纹理（大厅绘制兜底）
    this.exitConfirm = false         // 战斗中返回大厅的二次确认
    this.state = 'lobby'              // lobby | inventory | playing | levelup | win | lose
  }

  // 从大厅进入关卡（点击「开始关卡」）
  beginGame() {
    this.player = new Player(this.w, this.h)
    this.player.applyWeapon(this.progress.weaponType())  // 设定武器类型（未穿戴默认机枪）
    this.player.applyMods(this.progress.mods())  // 套用已装备物品数值
    this.player.hp = this.player.maxHp
    this.enemies = []
    this.projectiles = []
    this.boomerangs = []
    this.companions = []
    this.effects = new Effects()  // 程序化特效（雷电/粒子/震屏/顿帧）
    this.floorTile = makeFloorTile(256)  // 程序化地面纹理（无图片资源）
    this.wave = 1
    this.waveTimer = CONFIG.wave.duration
    this.waveBannerT = 1.6  // 波次开场提示计时
    this.spawnTimer = 0.5
    this.score = 0
    this.state = 'playing'       // playing | levelup | win | lose
    this.exitConfirm = false
    this.cardChoices = []
    this.cardRects = []
    this.pendingLevelUps = 0
    this.moveTarget = null       // 手动移动目标（触摸/拖拽时设置）

    // 随机摆放装饰贴花（非碰撞，纯氛围）
    this.decor = []
    for (let i = 0; i < 7; i++) {
      const x = 60 + Math.random() * (this.w - 120)
      const y = 100 + Math.random() * (this.h - 180)
      if (Math.hypot(x - this.w / 2, y - this.h * 0.55) < 150) continue // 避开出生区
      this.decor.push({
        name: 'decor' + (1 + Math.floor(Math.random() * 4)),
        x, y,
        s: 0.85 + Math.random() * 0.35,
        flip: Math.random() < 0.5
      })
    }
    this.state = 'playing'
  }

  // ---- 查询 ----
  nearestEnemy(x, y) {
    let best = null
    let bestD = Infinity
    for (const e of this.enemies) {
      if (e.dead) continue
      const d = dist(x, y, e.x, e.y)
      if (d < bestD) { bestD = d; best = e }
    }
    return best
  }

  addCompanion() {
    if (this.companions.length < CONFIG.wave.maxCompanions) {
      this.companions.push(new Companion(this))
    }
  }

  // ---- 经验 / 升级 ----
  gainXp(amount) {
    this.player.xp += amount * this.player.xpMult
  }

  openCards() {
    this.cardChoices = this.rollCards()
    this.cardRects = []
    this.state = 'levelup'
  }

  rollCards() {
    const w = this.player ? this.player.weapon : 'gun'
    const pool = CARD_POOL.filter(c => {
      if (c.id === 'ally' && this.companions.length >= CONFIG.wave.maxCompanions) return false
      // 仅取「通用卡」或「当前武器专属卡」，形成每把武器的特化路线
      if (c.weapon && c.weapon !== 'all' && c.weapon !== w) return false
      return true
    })
    const chosen = []
    const bag = pool.slice()
    while (chosen.length < 3 && bag.length > 0) {
      const total = bag.reduce((s, c) => s + c.weight, 0)
      let r = Math.random() * total
      let idx = 0
      for (let i = 0; i < bag.length; i++) {
        r -= bag[i].weight
        if (r <= 0) { idx = i; break }
      }
      chosen.push(bag[idx])
      bag.splice(idx, 1)
    }
    return chosen
  }

  chooseCard(i) {
    const card = this.cardChoices[i]
    if (!card) return
    card.apply({ player: this.player, game: this })
    this.pendingLevelUps--
    if (this.pendingLevelUps > 0) {
      this.openCards()
    } else {
      this.state = 'playing'
    }
  }

  // ---- 波次推进 ----
  nextWave() {
    this.wave++
    if (this.wave > CONFIG.wave.count) {
      this.state = 'win'
      this.progress.data.cleared++      // 通关计数 +1
      this.progress.save()
      this.loot = Progress.rollLoot()    // 抽取战利品（3 选 1）
      return
    }
    this.waveTimer = CONFIG.wave.duration
    this.waveBannerT = 1.6
    audio.play('wave', { volume: 0.5 })
    // 中后期波次自动获得 1 名伙伴
    if (this.wave >= CONFIG.wave.companionFromWave && this.companions.length < CONFIG.wave.maxCompanions) {
      this.addCompanion()
    }
  }

  // ---- 主更新 ----
  update(dt) {
    // 非战斗状态也让特效继续老化（闪电/粒子淡出）
    if (this.state !== 'playing') { this.effects.update(dt); return }
    // 命中顿帧：冻结实体、保留特效动画，强化打击感
    if (this.effects.hitStop > 0) {
      this.effects.hitStop -= dt
      this.effects.update(dt)
      return
    }

    // 刷怪
    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      const interval = Math.max(
        CONFIG.spawn.minInterval,
        CONFIG.spawn.baseInterval - (this.wave - 1) * CONFIG.spawn.perWaveReduce
      )
      this.spawnTimer = interval
      for (let i = 0; i < CONFIG.spawn.burst; i++) this.spawnEnemy()
    }

    // 波次计时
    this.waveTimer -= dt
    if (this.waveTimer <= 0) this.nextWave()
    if (this.waveBannerT > 0) this.waveBannerT -= dt

    this.player.update(dt, this)
    for (const c of this.companions) c.update(dt, this)
    for (const e of this.enemies) e.update(dt, this)
    for (const p of this.projectiles) p.update(dt, this)
    for (const b of this.boomerangs) b.update(dt, this)

    // 清理死亡敌人并结算经验
    const alive = []
    for (const e of this.enemies) {
      if (e.dead) {
        this.effects.burst(e.x, e.y, '#6ab04c') // 死亡碎裂特效
        this.gainXp(e.xp)
        this.score++
      } else {
        alive.push(e)
      }
    }
    this.enemies = alive
    this.projectiles = this.projectiles.filter(p => !p.dead)
    this.boomerangs = this.boomerangs.filter(b => !b.dead)
    this.effects.update(dt)

    // 升级检测
    if (this.player.xp >= this.player.xpNeeded) {
      this.player.level++
      this.player.xp -= this.player.xpNeeded
      this.player.xpNeeded = Math.floor(CONFIG.level.base * Math.pow(CONFIG.level.ratio, this.player.level - 1))
      this.pendingLevelUps++
      this.openCards()
      audio.play('levelup', { volume: 0.55 })
    }

    // 失败检测
    if (this.player.hp <= 0) {
      this.player.hp = 0
      this.state = 'lose'
      audio.play('hurt', { volume: 0.7 })
    }
  }

  spawnEnemy() {
    // 从屏幕四边随机生成
    const edge = Math.floor(Math.random() * 4)
    let x, y
    if (edge === 0) { x = Math.random() * this.w; y = -20 }
    else if (edge === 1) { x = this.w + 20; y = Math.random() * this.h }
    else if (edge === 2) { x = Math.random() * this.w; y = this.h + 20 }
    else { x = -20; y = Math.random() * this.h }
    this.enemies.push(new Enemy(x, y, this.wave))
  }

  // ---- 触摸 ----
  onTouch(x, y) {
    // —— 大厅 ——
    if (this.state === 'lobby') {
      if (inRect(x, y, this.lobbyStartRect)) { audio.play('click'); this.beginGame() }
      else if (inRect(x, y, this.lobbyInvRect)) { audio.play('click'); this.state = 'inventory' }
      return
    }
    // —— 物品栏 ——
    if (this.state === 'inventory') {
      for (const s of EQUIP_SLOTS) {
        if (inRect(x, y, this.invSlotRects[s.key])) { audio.play('click'); this.progress.unequip(s.key); return }
      }
      for (const r of this.invItemRects) {
        if (inRect(x, y, r)) { audio.play('click'); this.progress.equip(r.slot, r.id); return }
      }
      if (inRect(x, y, this.invBackRect)) { audio.play('click'); this.state = 'lobby' }
      return
    }
    // —— 升级选卡 ——
    if (this.state === 'levelup') {
      for (let i = 0; i < this.cardRects.length; i++) {
        const r = this.cardRects[i]
        if (inRect(x, y, r)) { audio.play('click'); this.chooseCard(i); return }
      }
    } else if (this.state === 'win') {
      // 战利品 3 选 1
      for (let i = 0; i < this.endCardRects.length; i++) {
        const r = this.endCardRects[i]
        if (inRect(x, y, r)) {
          audio.play('loot')
          this.progress.addOwned(this.loot[i]); this.state = 'lobby'; return
        }
      }
      if (inRect(x, y, this.endSkipRect)) { audio.play('click'); this.state = 'lobby' }
    } else if (this.state === 'lose') {
      if (inRect(x, y, this.endSkipRect)) { audio.play('click'); this.state = 'lobby' }
    } else if (this.state === 'playing') {
      if (this.exitConfirm) {
        if (inRect(x, y, this.exitConfirmRect)) { audio.play('click'); this.exitConfirm = false; this.state = 'lobby'; return }
        if (inRect(x, y, this.exitCancelRect)) { audio.play('click'); this.exitConfirm = false; return }
        this.exitConfirm = false  // 点弹窗外区域 = 取消
        return
      }
      if (inRect(x, y, this.exitRect)) { this.exitConfirm = true; return }  // 第一次点：弹出确认
      this.moveTarget = { x, y }
    }
  }

  onTouchMove(x, y) {
    if (this.state === 'playing') this.moveTarget = { x, y }
  }

  // 地面：优先手绘整图（cover 适配屏幕），缺失时回退程序化平铺纹理
  drawFloor(ctx) {
    const f = loader.get('floor')
    if (f) {
      const s = Math.max(this.w / f.width, this.h / f.height)
      const fw = f.width * s, fh = f.height * s
      ctx.drawImage(f, (this.w - fw) / 2, (this.h - fh) / 2, fw, fh)
      return
    }
    const t = this.floorTile
    const ts = t.width
    for (let y = 0; y < this.h; y += ts) {
      for (let x = 0; x < this.w; x += ts) {
        ctx.drawImage(t, x, y)
      }
    }
  }

  // ---- 渲染 ----
  render(ctx) {
    // 大厅 / 物品栏是独立界面，不与战斗世界层混用
    if (this.state === 'lobby') { this.renderLobby(ctx); return }
    if (this.state === 'inventory') { this.renderInventory(ctx); return }

    ctx.fillStyle = CONFIG.colors.bg
    ctx.fillRect(0, 0, this.w, this.h)
    this.drawFloor(ctx)  // 平铺地面纹理（静态，不随震屏抖动）

    // 装饰贴花（静态层，不随震屏抖动，位于地面之上、实体之下）
    for (const d of this.decor) {
      const img = loader.get(d.name)
      if (!img) continue
      const iw = img.width * d.s, ih = img.height * d.s
      ctx.save()
      ctx.translate(d.x, d.y)
      if (d.flip) ctx.scale(-1, 1)
      ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih)
      ctx.restore()
    }

    // 世界层（受屏幕震动影响）
    const s = this.effects.shakeOffset()
    ctx.save()
    ctx.translate(s.x, s.y)

    // 敌人（丧尸）
    for (const e of this.enemies) e.draw(ctx)

    // 子弹
    ctx.fillStyle = CONFIG.colors.projectile
    for (const p of this.projectiles) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
      ctx.fill()
    }

    // 回旋镖（旋转十字）
    for (const b of this.boomerangs) {
      ctx.save()
      ctx.translate(b.x, b.y)
      ctx.rotate(b.spin)
      ctx.fillStyle = '#80ED99'
      roundRect(ctx, -b.size, -b.size * 0.3, b.size * 2, b.size * 0.6, b.size * 0.3); ctx.fill()
      ctx.fillStyle = '#d6ffe0'
      roundRect(ctx, -b.size * 0.3, -b.size, b.size * 0.6, b.size * 2, b.size * 0.3); ctx.fill()
      ctx.restore()
    }

    // 伙伴（二次元）
    for (const c of this.companions) c.draw(ctx)

    // 主角（二次元）
    this.player.draw(ctx)

    // 手动移动目标指示
    if (this.moveTarget) {
      ctx.strokeStyle = '#ffffff88'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(this.moveTarget.x, this.moveTarget.y, 18, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 特效层（加色发光：闪电 + 粒子），盖在世界之上
    this.effects.draw(ctx)

    ctx.restore()

    this.renderHUD(ctx)

    if (this.state === 'levelup') this.renderCards(ctx)
    else if (this.state === 'win' || this.state === 'lose') this.renderEnd(ctx)
  }

  renderHUD(ctx) {
    const pad = this.w * 0.04
    // 返回大厅按钮（左上角）
    const bw = this.w * 0.16, bh = Math.floor(this.w * 0.052), bx = pad, by = pad
    this.exitRect = { x: bx, y: by, w: bw, h: bh }
    ctx.fillStyle = (this.exitConfirm ? '#F4595F' : 'rgba(0,0,0,0.45)')
    roundRect(ctx, bx, by, bw, bh, bh * 0.3); ctx.fill()
    ctx.strokeStyle = '#9fb3c8'; ctx.lineWidth = 1.5
    roundRect(ctx, bx, by, bw, bh, bh * 0.3); ctx.stroke()
    ctx.fillStyle = '#dfe7f0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = `${Math.floor(bh * 0.46)}px sans-serif`
    ctx.fillText(this.exitConfirm ? '确认退出？' : '返回大厅', bx + bw / 2, by + bh / 2)
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'

    // 状态条整体下移，避开左上角按钮
    const top = pad + bh + 6
    // 血条
    ctx.fillStyle = '#00000055'
    ctx.fillRect(pad, top, this.w - pad * 2, 14)
    ctx.fillStyle = CONFIG.colors.hp
    ctx.fillRect(pad, top, (this.w - pad * 2) * clamp(this.player.hp / this.player.maxHp, 0, 1), 14)
    // 经验条
    ctx.fillStyle = '#00000055'
    ctx.fillRect(pad, top + 18, this.w - pad * 2, 8)
    ctx.fillStyle = CONFIG.colors.xp
    ctx.fillRect(pad, top + 18, (this.w - pad * 2) * clamp(this.player.xp / this.player.xpNeeded, 0, 1), 8)

    // 文本信息
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${Math.floor(this.w * 0.04)}px sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText(`Lv.${this.player.level}  ${WEAPONS[this.player.weapon].name}`, pad, top + 50)
    ctx.textAlign = 'center'
    ctx.fillText(`第 ${this.wave}/${CONFIG.wave.count} 波`, this.w / 2, top + 50)
    ctx.textAlign = 'right'
    ctx.fillText(`伙伴 ${this.companions.length}  击杀 ${this.score}`, this.w - pad, top + 50)
    ctx.textAlign = 'left'

    // 波次开场提示（淡出大字）
    if (this.waveBannerT > 0) {
      const a = clamp(this.waveBannerT / 1.6, 0, 1)
      ctx.globalAlpha = a
      ctx.fillStyle = '#fff'
      ctx.font = `bold ${Math.floor(this.w * 0.09)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(`第 ${this.wave} 波`, this.w / 2, this.h * 0.33)
      ctx.globalAlpha = 1
      ctx.textAlign = 'left'
    }

    // 二次确认弹窗（仅战斗中）
    if (this.state === 'playing' && this.exitConfirm) this.renderExitConfirm(ctx)
  }

  renderExitConfirm(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(0, 0, this.w, this.h)
    const mw = this.w * 0.72, mh = this.h * 0.24, mx = (this.w - mw) / 2, my = (this.h - mh) / 2
    ctx.fillStyle = '#2a2a40'
    roundRect(ctx, mx, my, mw, mh, 14); ctx.fill()
    ctx.strokeStyle = CONFIG.colors.cardBorder; ctx.lineWidth = 2
    roundRect(ctx, mx, my, mw, mh, 14); ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${Math.floor(this.w * 0.05)}px sans-serif`
    ctx.fillText('确定返回大厅？', this.w / 2, my + mh * 0.32)
    ctx.fillStyle = '#cfd3e0'
    ctx.font = `${Math.floor(this.w * 0.034)}px sans-serif`
    ctx.fillText('当前本局进度将不会保存', this.w / 2, my + mh * 0.52)
    const bw2 = this.w * 0.26, bh2 = this.h * 0.075, by2 = my + mh * 0.66
    const yesX = this.w / 2 - bw2 - this.w * 0.03, noX = this.w / 2 + this.w * 0.03
    this.exitConfirmRect = { x: yesX, y: by2, w: bw2, h: bh2 }
    this.exitCancelRect = { x: noX, y: by2, w: bw2, h: bh2 }
    this.drawButton(ctx, '确定', this.exitConfirmRect, '#F4595F')
    this.drawButton(ctx, '取消', this.exitCancelRect, '#888')
    ctx.textAlign = 'left'
  }

  renderCards(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.62)'
    ctx.fillRect(0, 0, this.w, this.h)

    ctx.fillStyle = '#fff'
    ctx.font = `bold ${Math.floor(this.w * 0.06)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText('升级！选择一张卡牌', this.w / 2, this.h * 0.16)
    ctx.textAlign = 'left'

    const m = this.w * 0.08
    const bw = this.w - m * 2
    const bh = this.h * 0.16
    const gap = this.h * 0.03
    const startY = this.h * 0.24
    this.cardRects = []
    for (let i = 0; i < this.cardChoices.length; i++) {
      const y = startY + i * (bh + gap)
      const card = this.cardChoices[i]
      ctx.fillStyle = CONFIG.colors.card
      roundRect(ctx, m, y, bw, bh, 12)
      ctx.fill()
      ctx.strokeStyle = CONFIG.colors.cardBorder
      ctx.lineWidth = 2
      roundRect(ctx, m, y, bw, bh, 12)
      ctx.stroke()

      ctx.fillStyle = CONFIG.colors.cardBorder
      ctx.font = `bold ${Math.floor(this.w * 0.05)}px sans-serif`
      ctx.fillText(card.name, m + 18, y + bh * 0.42)
      ctx.fillStyle = '#cfd3e0'
      ctx.font = `${Math.floor(this.w * 0.038)}px sans-serif`
      ctx.fillText(card.desc, m + 18, y + bh * 0.74)
      this.cardRects.push({ x: m, y, w: bw, h: bh })
    }
  }

  renderEnd(ctx) {
    // 标题背景图（cover 铺屏 + 压暗），缺失回退纯色遮罩
    const t = loader.get('title')
    if (t) {
      const s = Math.max(this.w / t.width, this.h / t.height)
      const tw = t.width * s, th = t.height * s
      ctx.drawImage(t, (this.w - tw) / 2, (this.h - th) / 2, tw, th)
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, 0, this.w, this.h)
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.7)'
      ctx.fillRect(0, 0, this.w, this.h)
    }
    const cx = this.w / 2
    ctx.textAlign = 'center'

    if (this.state === 'win') {
      ctx.fillStyle = CONFIG.colors.companion
      ctx.font = `bold ${Math.floor(this.w * 0.08)}px sans-serif`
      ctx.fillText('通关胜利！', cx, this.h * 0.16)
      ctx.fillStyle = '#fff'
      ctx.font = `${Math.floor(this.w * 0.042)}px sans-serif`
      ctx.fillText(`到达第 ${this.wave} 波 · 击杀 ${this.score}`, cx, this.h * 0.23)

      // 战利品 3 选 1
      ctx.fillStyle = '#FFD166'
      ctx.font = `bold ${Math.floor(this.w * 0.045)}px sans-serif`
      ctx.fillText('选择一件战利品', cx, this.h * 0.31)
      const m = this.w * 0.08
      const bw = this.w - m * 2, bh = this.h * 0.13, gap = this.h * 0.025
      const startY = this.h * 0.35
      this.endCardRects = []
      for (let i = 0; i < this.loot.length; i++) {
        const it = getEquip(this.loot[i])
        const y = startY + i * (bh + gap)
        ctx.fillStyle = CONFIG.colors.card
        roundRect(ctx, m, y, bw, bh, 12); ctx.fill()
        ctx.strokeStyle = CONFIG.colors.cardBorder; ctx.lineWidth = 2
        roundRect(ctx, m, y, bw, bh, 12); ctx.stroke()
        ctx.fillStyle = CONFIG.colors.cardBorder
        ctx.font = `bold ${Math.floor(this.w * 0.05)}px sans-serif`
        ctx.textAlign = 'left'
        ctx.fillText(it.name, m + 18, y + bh * 0.42)
        ctx.fillStyle = '#cfd3e0'
        ctx.font = `${Math.floor(this.w * 0.036)}px sans-serif`
        ctx.fillText(it.desc, m + 18, y + bh * 0.76)
        this.endCardRects.push({ x: m, y, w: bw, h: bh })
      }
      // 放弃奖励
      const sw = this.w * 0.4, sh = this.h * 0.06, sx = cx - sw / 2, sy = startY + this.loot.length * (bh + gap) + this.h * 0.01
      this.endSkipRect = { x: sx, y: sy, w: sw, h: sh }
      this.drawButton(ctx, '放弃奖励', this.endSkipRect, '#888')
      ctx.textAlign = 'left'
    } else {
      ctx.fillStyle = CONFIG.colors.enemy
      ctx.font = `bold ${Math.floor(this.w * 0.08)}px sans-serif`
      ctx.fillText('挑战失败', cx, this.h * 0.36)
      ctx.fillStyle = '#fff'
      ctx.font = `${Math.floor(this.w * 0.045)}px sans-serif`
      ctx.fillText(`到达第 ${this.wave} 波 · 击杀 ${this.score}`, cx, this.h * 0.45)
      const bw = this.w * 0.5, bh = this.h * 0.07, bx = cx - bw / 2, by = this.h * 0.55
      this.endSkipRect = { x: bx, y: by, w: bw, h: bh }
      this.drawButton(ctx, '返回大厅', this.endSkipRect, '#4CC9F0')
      ctx.textAlign = 'left'
    }
  }

  // 通用按钮
  drawButton(ctx, label, r, color) {
    ctx.fillStyle = color
    roundRect(ctx, r.x, r.y, r.w, r.h, r.h * 0.3); ctx.fill()
    ctx.fillStyle = '#0c0c14'
    ctx.font = `bold ${Math.floor(r.h * 0.42)}px sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2)
    ctx.textBaseline = 'alphabetic'
  }

  // ---- 大厅 ----
  renderLobby(ctx) {
    this.drawFloor(ctx)
    ctx.fillStyle = 'rgba(10,10,20,0.55)'
    ctx.fillRect(0, 0, this.w, this.h)
    const cx = this.w / 2

    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'
    ctx.font = `bold ${Math.floor(this.w * 0.09)}px sans-serif`
    ctx.fillText('丧尸幸存者', cx, this.h * 0.13)
    ctx.fillStyle = '#9fb3c8'
    ctx.font = `${Math.floor(this.w * 0.04)}px sans-serif`
    ctx.fillText('雷电链 · 生存竞技场', cx, this.h * 0.19)

    // 主角预览（待机帧）
    const r = Math.min(this.w, this.h) * 0.11
    drawChibi(ctx, cx, this.h * 0.40, r, '#5f27cd', '#ff9ff3', 'hero_walk', 'hero_idle', false, 'hero')

    // 进度 & 装备摘要
    ctx.fillStyle = '#cfe'
    ctx.font = `${Math.floor(this.w * 0.04)}px sans-serif`
    ctx.fillText(`已通关 ${this.progress.data.cleared} 次   拥有装备 ${this.progress.data.owned.length} 件`, cx, this.h * 0.56)
    this.renderEquipSummary(ctx, cx, this.h * 0.60)

    // 按钮：开始关卡 / 物品栏
    const bw = this.w * 0.6, bh = this.h * 0.075, bx = cx - bw / 2, by = this.h * 0.80
    this.lobbyStartRect = { x: bx, y: by, w: bw, h: bh }
    this.drawButton(ctx, '▶ 开始关卡', this.lobbyStartRect, '#4CC9F0')
    const iw = this.w * 0.4, ih = bh, ix = cx - iw / 2, iy = by + bh + this.h * 0.02
    this.lobbyInvRect = { x: ix, y: iy, w: iw, h: ih }
    this.drawButton(ctx, '🎒 物品栏', this.lobbyInvRect, '#80ED99')
    ctx.textAlign = 'left'
  }

  renderEquipSummary(ctx, cx, y) {
    ctx.font = `${Math.floor(this.w * 0.036)}px sans-serif`
    ctx.fillStyle = '#cbd5e1'
    ctx.textAlign = 'center'
    let yy = y
    for (const s of EQUIP_SLOTS) {
      const it = getEquip(this.progress.data.equipped[s.key])
      ctx.fillText(`${s.name}：${it ? it.name : '空'}`, cx, yy)
      yy += this.h * 0.036
    }
    ctx.textAlign = 'left'
  }

  // ---- 物品栏 ----
  renderInventory(ctx) {
    ctx.fillStyle = CONFIG.colors.bg
    ctx.fillRect(0, 0, this.w, this.h)
    const cx = this.w / 2
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'
    ctx.font = `bold ${Math.floor(this.w * 0.07)}px sans-serif`
    ctx.fillText('物品栏', cx, this.h * 0.10)

    // 三个装备槽（点击卸下）
    this.invSlotRects = {}
    const slotW = this.w * 0.8, slotH = this.h * 0.085, sx = cx - slotW / 2
    let y = this.h * 0.15
    for (const s of EQUIP_SLOTS) {
      const r = { x: sx, y, w: slotW, h: slotH }
      this.invSlotRects[s.key] = r
      const it = getEquip(this.progress.data.equipped[s.key])
      ctx.fillStyle = '#23233a'
      roundRect(ctx, r.x, r.y, r.w, r.h, 10); ctx.fill()
      ctx.strokeStyle = '#FFD166'; ctx.lineWidth = 2
      roundRect(ctx, r.x, r.y, r.w, r.h, 10); ctx.stroke()
      ctx.fillStyle = '#FFD166'; ctx.textAlign = 'left'
      ctx.font = `bold ${Math.floor(this.w * 0.044)}px sans-serif`
      ctx.fillText(`${s.name}：${it ? it.name : '（空 · 点击卸下）'}`, r.x + 16, r.y + r.h * 0.45)
      if (it) {
        ctx.fillStyle = '#cbd5e1'
        ctx.font = `${Math.floor(this.w * 0.033)}px sans-serif`
        ctx.fillText(it.desc, r.x + 16, r.y + r.h * 0.8)
      }
      y += slotH + this.h * 0.015
    }

    // 拥有装备列表（点击装备到对应槽）
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'
    ctx.font = `${Math.floor(this.w * 0.042)}px sans-serif`
    ctx.fillText('点击装备到对应槽位', cx, y + this.h * 0.01)
    y += this.h * 0.035
    this.invItemRects = []
    const owned = this.progress.data.owned
    if (!owned.length) {
      ctx.fillStyle = '#9fb3c8'
      ctx.fillText('暂无装备，通关关卡可获得', cx, y + this.h * 0.04)
    } else {
      const iw = this.w * 0.86, ih = this.h * 0.06, ix = cx - iw / 2
      for (const id of owned) {
        const it = getEquip(id)
        const equipped = this.progress.data.equipped[it.slot] === id
        const r = { x: ix, y, w: iw, h: ih, slot: it.slot, id }
        this.invItemRects.push(r)
        ctx.fillStyle = equipped ? '#1d3a2a' : '#2a2a40'
        roundRect(ctx, r.x, r.y, r.w, r.h, 8); ctx.fill()
        ctx.fillStyle = equipped ? '#80ED99' : '#fff'
        ctx.textAlign = 'left'
        ctx.font = `bold ${Math.floor(this.w * 0.04)}px sans-serif`
        ctx.fillText(`${it.name}（${slotName(it.slot)}）`, r.x + 14, r.y + r.h * 0.42)
        ctx.fillStyle = '#cbd5e1'
        ctx.font = `${Math.floor(this.w * 0.032)}px sans-serif`
        ctx.fillText(it.desc, r.x + 14, r.y + r.h * 0.8)
        y += ih + this.h * 0.012
      }
    }

    // 返回大厅
    const bw = this.w * 0.5, bh = this.h * 0.07, bx = cx - bw / 2, by = this.h * 0.92
    this.invBackRect = { x: bx, y: by, w: bw, h: bh }
    this.drawButton(ctx, '返回大厅', this.invBackRect, '#4CC9F0')
    ctx.textAlign = 'left'
  }
}

module.exports = Game
