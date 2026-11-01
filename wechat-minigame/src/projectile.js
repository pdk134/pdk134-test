const audio = require('./audio.js')

// 子弹
class Projectile {
  constructor(x, y, vx, vy, damage, hits) {
    this.x = x
    this.y = y
    this.vx = vx
    this.vy = vy
    this.damage = damage
    this.hits = hits        // 可命中的敌人数量（pierce+1）
    this.radius = 5
    this.life = 2.2
    this.dead = false
    this.hit = new Set()    // 已命中的敌人，避免重复结算
  }

  update(dt, game) {
    this.x += this.vx * dt
    this.y += this.vy * dt
    this.life -= dt
    if (this.life <= 0 || this.x < -30 || this.x > game.w + 30 || this.y < -30 || this.y > game.h + 30) {
      this.dead = true
      return
    }
    for (const e of game.enemies) {
      if (e.dead || this.hit.has(e.id)) continue
      if (Math.hypot(this.x - e.x, this.y - e.y) < this.radius + e.radius) {
        e.hurt(this.damage, game)
        this.hit.add(e.id)
        this.hits--
        if (this.hits <= 0) { this.dead = true; break }
      }
    }
  }
}

// 回旋镖：先沿方向飞出到最大距离，再飞回主角；来回都能命中敌人
class Boomerang {
  constructor(x, y, dir, damage, maxDist, speed, size) {
    this.x = x
    this.y = y
    this.dir = dir
    this.damage = damage
    this.maxDist = maxDist
    this.speed = speed
    this.size = size
    this.traveled = 0
    this.phase = 'out'
    this.hit = new Set()    // 同一趟命中过的敌人不再重复结算
    this.dead = false
    this.spin = 0
  }

  update(dt, game) {
    const step = this.speed * dt
    if (this.phase === 'out') {
      this.x += Math.cos(this.dir) * step
      this.y += Math.sin(this.dir) * step
      this.traveled += step
      if (this.traveled >= this.maxDist) this.phase = 'back'
    } else {
      const a = Math.atan2(game.player.y - this.y, game.player.x - this.x)
      this.x += Math.cos(a) * step
      this.y += Math.sin(a) * step
      if (Math.hypot(game.player.x - this.x, game.player.y - this.y) < game.player.radius + this.size) {
        this.dead = true
      }
    }
    this.spin += dt * 14
    for (const e of game.enemies) {
      if (e.dead || this.hit.has(e.id)) continue
      if (Math.hypot(this.x - e.x, this.y - e.y) < this.size + e.radius) {
        e.hurt(this.damage, game)
        this.hit.add(e.id)
        game.effects.spark(e.x, e.y, '#80ED99', { count: 6, speed: 140, life: 0.3 })
        audio.play('boom_hit', { volume: 0.4, minGap: 0.05 })
      }
    }
    if (this.x < -40 || this.x > game.w + 40 || this.y < -40 || this.y > game.h + 40) this.dead = true
  }
}

module.exports = { Projectile, Boomerang }
