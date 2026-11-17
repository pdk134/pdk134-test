const { CONFIG } = require('./config.js')
const { dist, clamp } = require('./utils.js')
const { drawZombie } = require('./sprites.js')
const audio = require('./audio.js')

let NEXT_ID = 1

// 敌人：从四周生成，向主角移动，接触造成伤害
class Enemy {
  constructor(x, y, wave) {
    this.id = NEXT_ID++
    this.x = x
    this.y = y
    this.radius = CONFIG.enemy.radius
    this.maxHp = CONFIG.enemy.baseHp + (wave - 1) * CONFIG.enemy.hpPerWave
    this.hp = this.maxHp
    this.speed = CONFIG.enemy.speed + (wave - 1) * CONFIG.enemy.speedPerWave
    this.damage = CONFIG.enemy.damage
    this.xp = CONFIG.enemy.xp
    this.dead = false
    this.contactTimer = 0
    this.faceX = 0
    this.faceY = 1
    this.hitFlash = 0       // 受击泛白计时
    this.stun = 0          // 雷电链短暂停顿
    this.slowT = 0         // 减速剩余时长
    this.slowF = 1         // 减速系数（<1）
  }

  update(dt, game) {
    const p = game.player
    if (this.hitFlash > 0) this.hitFlash -= dt
    if (this.stun > 0) this.stun -= dt
    if (this.slowT > 0) this.slowT -= dt
    if (p.hp <= 0) return
    const dx = p.x - this.x
    const dy = p.y - this.y
    const len = Math.hypot(dx, dy) || 1
    this.faceX = dx / len
    this.faceY = dy / len
    if (this.stun <= 0) {
      const sf = this.slowT > 0 ? this.slowF : 1
      this.x += this.faceX * this.speed * sf * dt
      this.y += this.faceY * this.speed * sf * dt
    }

    this.contactTimer -= dt
    if (len < this.radius + p.radius && this.contactTimer <= 0) {
      p.hp -= this.damage
      this.contactTimer = CONFIG.enemy.contactCd
      audio.play('hurt', { volume: 0.5, minGap: 0.15 })
    }
  }

  hurt(d, game) {
    this.hp -= d
    this.hitFlash = 0.14
    this.stun = 0.12
    if (game && game.effects) {
      game.effects.spark(this.x, this.y, '#bfe9ff', { count: 6, speed: 150, life: 0.3, size: 2.5 })
    }
    audio.play('hit', { volume: 0.35, minGap: 0.04 })
    if (this.hp <= 0) {
      this.dead = true
      audio.play('die', { volume: 0.45, minGap: 0.08 })
    }
  }

  draw(ctx) {
    drawZombie(ctx, this)
  }
}

module.exports = Enemy
