// 游戏全局配置（俯视生存竞技场 / 升级选卡）
const CONFIG = {
  player: {
    radius: 16,
    maxHp: 100,
    moveSpeed: 130,     // px/s
    damage: 10,
    attackInterval: 0.6, // s 技能冷却
    range: 230,         // 主目标锁定射程
    chainCount: 4,      // 雷电链最多跳跃数
    chainRange: 180,    // 每跳可命中周围敌人的半径
    chainFalloff: 0.82, // 每跳伤害衰减
    // —— 技能特化（由升级卡解锁，初始均为“未特化”状态）——
    slowOnHit: 0,       // 雷电命中使敌人减速的时长(s)，0=不减速
    slowFactor: 0.5,    // 减速后速度系数（0.5=半速）
    aoeOnHit: 0,        // 雷电命中触发范围爆发的半径，0=不触发
    aoeMult: 0.5,       // 范围爆发伤害占主伤害的比例
    fork: 0,            // 每跳额外同时锁定的目标数（分叉）
    leech: 0,           // 雷电吸血比例（造成伤害的一部分回血）
    projectileSpeed: 340,
    projectileCount: 1, // 一次发射弹丸数
    pierce: 0,          // 额外穿透数
    critChance: 0,
    critMult: 2,
    xpMult: 1
  },
  enemy: {
    radius: 14,
    baseHp: 20,
    hpPerWave: 14,       // 每波（难度档）敌人生命增量
    speed: 52,
    speedPerWave: 5,      // 每波敌人速度增量
    damage: 8,
    contactCd: 0.5,
    xp: 3
  },
  level: {
    base: 40,      // 升到第 2 级所需经验
    ratio: 1.35    // 每级所需经验递增比率（梯度上升：base * ratio^(等级-1)）
  },
  spawn: {
    baseInterval: 1.2,    // 第1波刷怪间隔(s)
    minInterval: 0.25,
    perWaveReduce: 0.14,  // 每波缩短
    burst: 1              // 每次刷几只
  },
  wave: {
    count: 5,             // 单关总波次
    duration: 25,         // 每波时长(s)
    companionFromWave: 3, // 第3波起自动获得1名NPC伙伴
    maxCompanions: 3
  },
  colors: {
    bg: '#1b1b2b',
    player: '#4CC9F0',
    companion: '#80ED99',
    enemy: '#F4595F',
    projectile: '#FFD166',
    hp: '#F4595F',
    xp: '#4CC9F0',
    card: '#2a2a40',
    cardBorder: '#FFD166'
  }
}

module.exports = { CONFIG }
