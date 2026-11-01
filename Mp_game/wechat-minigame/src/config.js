// 游戏全局配置（俯视生存竞技场 / 升级选卡）
const CONFIG = {
  // 远程资源基址：留空 '' 则使用本地 assets/（当前行为不变）。
  // 填你的 CDN/云存储地址（结尾带 /），例如 'https://cdn.example.com/game/'，
  // 所有图片将改为远程下载，主包仅剩代码，彻底绕开 4MB 限制。
  REMOTE_BASE: '',
  // —— 微信云开发（云存储）模式 ——
  // CLOUD_ENV：云开发环境 ID（如 'my-env-1'），需在 main.js 里 wx.cloud.init
  // CLOUD_BASE：云存储中图片文件的公共前缀（结尾带 /），如 'cloud://env-xxx.bucket/game/'
  // 填了 CLOUD_BASE 就走 wx.cloud.downloadFile，**不需要配 downloadFile 合法域名**
  CLOUD_ENV: 'akk-d9gj1v4nt926432f5',
  // 云存储文件前缀（来自控制台真实文件 ID）
  // 注意：上传文件夹时本地目录名 _cloud_game 成了云端路径，所以前缀要带 /_cloud_game/
  CLOUD_BASE: 'cloud://akk-d9gj1v4nt926432f5.616b-akk-d9gj1v4nt926432f5-1522500102/_cloud_game/',
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
    baseHp: 40,          // ← 怪的数据 ×2（原 20）
    hpPerWave: 28,       // 每波（难度档）敌人生命增量（原 14）
    speed: 52,
    speedPerWave: 5,      // 每波敌人速度增量
    damage: 16,          // ← 怪的数据 ×2（原 8）
    contactCd: 0.5,
    xp: 6                // ← 怪的数据 ×2（原 3）
  },
  sound: {
    enabled: true,       // 总开关
    volume: 0.7          // 默认音量
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
