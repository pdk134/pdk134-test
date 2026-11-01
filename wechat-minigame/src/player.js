const { CONFIG } = require('./config.js')
const { clamp, dist } = require('./utils.js')
const { drawChibi } = require('./sprites.js')
const { Projectile, Boomerang } = require('./projectile.js')

// 主角：自动移动（绕最近敌人走位）+ 自动攻击
class Player {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.x = w / 2
    this.y = h / 2
    Object.assign(this, JSON.parse(JSON.stringify(CONFIG.player)))
    this.hp = this.maxHp
    this.level = 1
    this.xp = 0
    this.xpNeeded = CONFIG.level.base
    this.attackTimer = 0
    this.moving = false
    this.weapon = 'gun'        // gun(机枪) | staff(法杖) | boomerang(回旋镖)，默认机枪
  }

  // 套用装备数值（mods 的键名与 CONFIG.player 一致，直接相加）
  applyMods(mods) {
    if (!mods) return
    for (const k in mods) {
      if (typeof this[k] === 'number') this[k] += mods[k]
    }
    if (this.attackInterval < 0.12) this.attackInterval = 0.12
    if (this.maxHp < 1) this.maxHp = 1
    if (this.moveSpeed < 40) this.moveSpeed = 40
  }

  // 设定武器类型并套用该武器的攻击基底（在 applyMods 之前调用，装备 mods 再叠加其上）
  applyWeapon(type) {
    this.weapon = type || 'gun'
    if (this.weapon === 'gun') {
      this.attackInterval *= 0.32          // 高射速
      this.damage *= 0.6                    // 单发偏弱
      this.projectileCount = 1
      this.pierce = 0
      this.projectileSpeed = 380
      this.range = 260
    } else if (this.weapon === 'boomerang') {
      this.attackInterval *= 0.9
      this.damage *= 0.9
      this.range = 240
      this.boomSize = 14
      this.boomDist = 240
      this.boomSpeed = 320
      this.boomCount = 1
    }
    // staff(法杖)：沿用基础（雷电链）配置
  }

  update(dt, game) {
    const target = game.nearestEnemy(this.x, this.y)

    // 移动：仅由玩家触摸控制，点哪走到哪（拖动实时跟随），到达后停止
    if (game.moveTarget) {
      const dx = game.moveTarget.x - this.x
      const dy = game.moveTarget.y - this.y
      const len = Math.hypot(dx, dy) || 1
      if (len > 6) {
        this.x = clamp(this.x + (dx / len) * this.moveSpeed * dt, this.radius, this.w - this.radius)
        this.y = clamp(this.y + (dy / len) * this.moveSpeed * dt, this.radius, this.h - this.radius)
      } else {
        game.moveTarget = null // 到达目标点，停止（再次点击可重新指定）
      }
    }
    this.moving = !!game.moveTarget

    // 技能自动释放（按武器类型分发）
    if (target) {
      this.attackTimer -= dt
      if (this.attackTimer <= 0) {
        this.attackTimer = this.attackInterval
        if (this.weapon === 'gun') this.castGun(game, target)
        else if (this.weapon === 'boomerang') this.castBoomerang(game, target)
        else this.castLightning(game, target)
      }
    }
  }

  draw(ctx) {
    drawChibi(ctx, this.x, this.y, this.radius, '#5f27cd', '#ff9ff3', 'hero_walk', 'hero_idle', this.moving, 'hero')
  }

  // 雷电链：锁定最近敌人，向周围连续跳跃，每跳锯齿闪电 + 电火花 + 伤害衰减
  // 受技能特化影响：暴击 / 感电(减速) / 雷暴(范围爆发) / 分叉(一跳多目标) / 汲取(吸血)
  castLightning(game, first) {
    const fx = game.effects
    let prev = { x: this.x, y: this.y }
    const hit = new Set()
    let dmg = this.damage
    let reach = this.range
    let healed = 0
    const forkN = this.fork || 0

    for (let k = 0; k < this.chainCount; k++) {
      // 本跳可命中 1 + forkN 个目标（分叉特化）
      const pool = game.enemies
        .filter(e => !e.dead && !hit.has(e.id))
        .map(e => ({ e, d: dist(prev.x, prev.y, e.x, e.y) }))
        .sort((a, b) => a.d - b.d)
      const targets = []
      for (const o of pool) {
        if (o.d > reach) break
        targets.push(o.e)
        if (targets.length >= 1 + forkN) break
      }
      if (!targets.length) break

      for (const best of targets) {
        hit.add(best.id)
        // 暴击特化
        let d = dmg
        let crit = false
        if (this.critChance && Math.random() < this.critChance) {
          d *= this.critMult
          crit = true
        }
        fx.bolt(prev.x, prev.y, best.x, best.y, '#bfe9ff', { segs: 7, jitter: 22, width: crit ? 4 : 3 })
        fx.flash(best.x, best.y, crit ? 0.6 : 0.45)
        fx.spark(best.x, best.y, '#bfe9ff', { count: crit ? 22 : 14, speed: crit ? 260 : 200, life: 0.4, size: crit ? 4 : 3 })
        if (crit) fx.spark(best.x, best.y, '#ffffff', { count: 8, speed: 120, life: 0.3 })
        best.hurt(d, game)
        healed += d * (this.leech || 0)

        // 感电特化：减速
        if (this.slowOnHit) {
          best.slowT = Math.max(best.slowT || 0, this.slowOnHit)
          best.slowF = this.slowFactor
        }
        // 雷暴特化：范围爆发
        if (this.aoeOnHit) {
          fx.ring(best.x, best.y, this.aoeOnHit, '#bfe9ff', { width: 3 })
          const aoeD = d * this.aoeMult
          for (const o of game.enemies) {
            if (o.dead || hit.has(o.id)) continue
            if (dist(best.x, best.y, o.x, o.y) <= this.aoeOnHit) {
              o.hurt(aoeD, game)
              fx.spark(o.x, o.y, '#bfe9ff', { count: 6, speed: 160, life: 0.3 })
            }
          }
        }
        prev = best
      }
      reach = this.chainRange
      dmg *= this.chainFalloff
    }

    if (healed > 0) this.hp = Math.min(this.maxHp, this.hp + healed)
    if (hit.size > 0) {
      fx.shakeAdd(5, 0.12)
      fx.hitStopAdd(0.02)
    }
  }

  // 机枪：朝目标连射子弹（支持多发/穿透/暴击）
  castGun(game, target) {
    const fx = game.effects
    const baseA = Math.atan2(target.y - this.y, target.x - this.x)
    const n = this.projectileCount || 1
    const spread = 0.1
    for (let i = 0; i < n; i++) {
      const a = baseA + (n > 1 ? (i - (n - 1) / 2) * spread : 0)
      let d = this.damage
      if (this.critChance && Math.random() < this.critChance) d *= this.critMult
      game.projectiles.push(new Projectile(
        this.x, this.y,
        Math.cos(a) * this.projectileSpeed,
        Math.sin(a) * this.projectileSpeed,
        d, (this.pierce || 0) + 1
      ))
    }
    fx.spark(this.x, this.y, '#FFD166', { count: 4, speed: 130, life: 0.2, size: 3 })
  }

  // 回旋镖：投出后飞到最大距离再飞回，沿途命中敌人
  castBoomerang(game, target) {
    const fx = game.effects
    const baseA = Math.atan2(target.y - this.y, target.x - this.x)
    const n = this.boomCount || 1
    const spread = 0.25
    for (let i = 0; i < n; i++) {
      const a = baseA + (n > 1 ? (i - (n - 1) / 2) * spread : 0)
      let d = this.damage
      if (this.critChance && Math.random() < this.critChance) d *= this.critMult
      game.boomerangs.push(new Boomerang(this.x, this.y, a, d, this.boomDist, this.boomSpeed, this.boomSize))
    }
    fx.spark(this.x, this.y, '#80ED99', { count: 5, speed: 140, life: 0.25 })
  }
}

module.exports = Player
