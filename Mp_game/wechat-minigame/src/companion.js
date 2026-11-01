const { CONFIG } = require('./config.js')
const { Projectile } = require('./projectile.js')
const { drawChibi } = require('./sprites.js')

// NPC 伙伴：环绕主角、自动攻击敌人（后期关卡解锁）
class Companion {
  constructor(game) {
    this.x = game.player.x
    this.y = game.player.y
    this.radius = 14
    this.damage = 9
    this.attackInterval = 0.8
    this.range = 210
    this.projectileSpeed = 310
    this.attackTimer = 0
    this.angle = Math.random() * Math.PI * 2
    this.orbitR = 64
    this.hair = '#00cec9'   // 伙伴发色（区分主角）
    this.dress = '#81ecec'
    this.moving = false
  }

  update(dt, game) {
    const p = game.player
    this.angle += dt * 1.4
    const tx = clampPos(p.x + Math.cos(this.angle) * this.orbitR, this.radius, game.w)
    const ty = clampPos(p.y + Math.sin(this.angle) * this.orbitR, this.radius, game.h)
    this.moving = Math.hypot(tx - this.x, ty - this.y) > 0.5
    this.x += (tx - this.x) * Math.min(1, dt * 5)
    this.y += (ty - this.y) * Math.min(1, dt * 5)

    const target = game.nearestEnemy(this.x, this.y)
    this.attackTimer -= dt
    if (this.attackTimer <= 0 && target) {
      this.attackTimer = this.attackInterval
      const a = Math.atan2(target.y - this.y, target.x - this.x)
      game.projectiles.push(new Projectile(
        this.x, this.y,
        Math.cos(a) * this.projectileSpeed,
        Math.sin(a) * this.projectileSpeed,
        this.damage, 1
      ))
    }
  }

  draw(ctx) {
    drawChibi(ctx, this.x, this.y, this.radius, this.hair, this.dress, 'ally_walk', 'ally_idle', this.moving, 'ally')
  }
}

function clampPos(v, r, max) {
  return v < r ? r : (v > max - r ? max - r : v)
}

module.exports = Companion
