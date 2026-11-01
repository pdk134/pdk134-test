// 升级卡牌池：新技能 / 强化现有技能，每级三选一
// apply 接收 { player, game }
// weapon 字段：'all' = 通用；否则仅当 player.weapon 匹配时出现在该武器的特化路线中
const CARD_POOL = [
  // —— 通用（所有武器共享）——
  { id: 'ats', weapon: 'all', name: '急速射击', desc: '攻击速度 +18%', weight: 1,
    apply(c) { c.player.attackInterval *= 0.82 } },
  { id: 'dmg', weapon: 'all', name: '伤害提升', desc: '伤害 +25%', weight: 1,
    apply(c) { c.player.damage *= 1.25 } },
  { id: 'hp', weapon: 'all', name: '强健体魄', desc: '最大生命 +25 并治疗', weight: 1,
    apply(c) { c.player.maxHp += 25; c.player.hp = Math.min(c.player.maxHp, c.player.hp + 25) } },
  { id: 'spd', weapon: 'all', name: '疾步', desc: '移动速度 +12%', weight: 1,
    apply(c) { c.player.moveSpeed *= 1.12 } },
  { id: 'xp', weapon: 'all', name: '经验精通', desc: '经验获取 +20%', weight: 1,
    apply(c) { c.player.xpMult *= 1.2 } },
  { id: 'crit', weapon: 'all', name: '暴击', desc: '暴击率 +10%（暴击伤害 ×2）', weight: 1,
    apply(c) { c.player.critChance = Math.min(0.9, c.player.critChance + 0.1) } },
  { id: 'ally', weapon: 'all', name: '召唤伙伴', desc: '获得 1 名 NPC 伙伴助战', weight: 1,
    apply(c) { c.game.addCompanion() } },

  // —— 法杖（雷电链）专属 ——
  { id: 'multi', weapon: 'staff', name: '连锁闪电', desc: '雷电链可多跳跃 1 个敌人（最多8）', weight: 1,
    apply(c) { c.player.chainCount = Math.min(c.player.chainCount + 1, 8) } },
  { id: 'prc', weapon: 'staff', name: '电弧扩散', desc: '雷电链每跳链长 +25%', weight: 1,
    apply(c) { c.player.chainRange *= 1.25 } },
  { id: 'shock', weapon: 'staff', name: '感电', desc: '雷电命中的敌人减速 60%（可叠加时长）', weight: 1,
    apply(c) { c.player.slowOnHit = Math.min(3, (c.player.slowOnHit || 0) + 0.6) } },
  { id: 'storm', weapon: 'staff', name: '雷暴', desc: '雷电落点引发范围爆发（伤害 50%）', weight: 1,
    apply(c) { c.player.aoeOnHit = c.player.aoeOnHit > 0 ? c.player.aoeOnHit + 30 : 64 } },
  { id: 'fork', weapon: 'staff', name: '分叉', desc: '每跳额外同时锁定 1 个敌人', weight: 1,
    apply(c) { c.player.fork = (c.player.fork || 0) + 1 } },
  { id: 'leech', weapon: 'staff', name: '汲取', desc: '雷电造成伤害的 12% 转化为生命', weight: 1,
    apply(c) { c.player.leech = Math.min(0.6, (c.player.leech || 0) + 0.12) } },

  // —— 机枪专属 ——
  { id: 'rapid', weapon: 'gun', name: '弹幕倾泻', desc: '机枪射速再 +22%', weight: 1,
    apply(c) { c.player.attackInterval *= 0.78 } },
  { id: 'multishot', weapon: 'gun', name: '多重射击', desc: '每次额外发射 1 发子弹', weight: 1,
    apply(c) { c.player.projectileCount = (c.player.projectileCount || 1) + 1 } },
  { id: 'pierce', weapon: 'gun', name: '穿甲', desc: '子弹可额外穿透 1 个敌人', weight: 1,
    apply(c) { c.player.pierce = (c.player.pierce || 0) + 1 } },
  { id: 'bspd', weapon: 'gun', name: '高速弹头', desc: '子弹飞行速度 +25%', weight: 1,
    apply(c) { c.player.projectileSpeed *= 1.25 } },

  // —— 回旋镖专属 ——
  { id: 'bsize', weapon: 'boomerang', name: '巨型飞镖', desc: '回旋镖变大，伤害 +20%', weight: 1,
    apply(c) { c.player.boomSize += 4; c.player.damage *= 1.2 } },
  { id: 'bcount', weapon: 'boomerang', name: '双重飞镖', desc: '每次额外投出 1 个回旋镖', weight: 1,
    apply(c) { c.player.boomCount = (c.player.boomCount || 1) + 1 } },
  { id: 'brange', weapon: 'boomerang', name: '远投', desc: '回旋镖投掷距离 +30%', weight: 1,
    apply(c) { c.player.boomDist *= 1.3 } },
  { id: 'breturn', weapon: 'boomerang', name: '极速回旋', desc: '回旋镖往返速度 +25%', weight: 1,
    apply(c) { c.player.boomSpeed *= 1.25 } }
]

module.exports = { CARD_POOL }
