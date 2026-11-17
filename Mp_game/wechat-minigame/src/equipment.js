// 装备定义与数值汇总
// 槽位：weapon(武器) / armor(护甲) / trinket(饰品)
// mods 的键名与 CONFIG.player 中的字段一致，applyMods 时直接相加
const EQUIP_POOL = [
  // —— 武器：决定攻击方式与特化路线（不穿戴则默认机枪）——
  { id: 'w1', name: '雷霆法杖', slot: 'weapon', weapon: 'staff', desc: '法杖：伤害 +6，攻速略升', mods: { damage: 6, attackInterval: -0.05 } },
  { id: 'w2', name: '回旋飞镖', slot: 'weapon', weapon: 'boomerang', desc: '回旋镖：移速 +20，伤害 +4', mods: { moveSpeed: 20, damage: 4 } },
  { id: 'w3', name: '速射机枪', slot: 'weapon', weapon: 'gun', desc: '机枪：攻速提升，伤害 +3', mods: { attackInterval: -0.04, damage: 3 } },
  // —— 护甲：强化生存/机动 ——
  { id: 'a1', name: '守护胸甲', slot: 'armor', desc: '生命上限 +40', mods: { maxHp: 40 } },
  { id: 'a2', name: '荆棘铠', slot: 'armor', desc: '生命 +20，伤害 +4', mods: { maxHp: 20, damage: 4 } },
  { id: 'a3', name: '疾风披风', slot: 'armor', desc: '移动速度 +30', mods: { moveSpeed: 30 } },
  // —— 饰品：功能性增益 ——
  { id: 't1', name: '汲取宝石', slot: 'trinket', desc: '雷电吸血 +12%', mods: { leech: 0.12 } },
  { id: 't2', name: '范围罗盘', slot: 'trinket', desc: '雷电命中有概率范围爆发', mods: { aoeOnHit: 40 } },
  { id: 't3', name: '过载电池', slot: 'trinket', desc: '经验获取 +30%', mods: { xpMult: 0.3 } }
]

const EQUIP_SLOTS = [
  { key: 'weapon', name: '武器' },
  { key: 'armor', name: '护甲' },
  { key: 'trinket', name: '饰品' }
]

function getEquip(id) {
  if (!id) return null
  return EQUIP_POOL.find(e => e.id === id) || null
}

function slotName(key) {
  const s = EQUIP_SLOTS.find(s => s.key === key)
  return s ? s.name : key
}

// 汇总当前已装备物品的 mods（同槽位仅一件）
function computeMods(equipped) {
  const m = {}
  for (const slot in equipped) {
    const it = getEquip(equipped[slot])
    if (!it) continue
    for (const k in it.mods) m[k] = (m[k] || 0) + it.mods[k]
  }
  return m
}

module.exports = { EQUIP_POOL, EQUIP_SLOTS, getEquip, slotName, computeMods }
