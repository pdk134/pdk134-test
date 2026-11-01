// 玩家进度存档：已通关次数 / 已拥有装备 / 已装备槽位
// 微信小游戏用 wx.getStorageSync / setStorageSync，带内存兜底（模拟器/异常时仍可运行）
const { EQUIP_POOL, getEquip, computeMods } = require('./equipment.js')

const KEY = 'zombie_survivor_progress_v1'

function defaultData() {
  return { cleared: 0, owned: [], equipped: { weapon: null, armor: null, trinket: null } }
}

const Progress = {
  data: defaultData(),

  // 启动时加载（清缓存/首次为默认）
  load() {
    try {
      const v = wx.getStorageSync(KEY)
      if (v && typeof v === 'object') {
        const d = defaultData()
        d.cleared = v.cleared || 0
        d.owned = Array.isArray(v.owned) ? v.owned.slice() : []
        d.equipped = Object.assign(d.equipped, v.equipped || {})
        this.data = d
      }
    } catch (e) { /* 兜底：保持默认 */ }
    return this
  },

  save() {
    try { wx.setStorageSync(KEY, this.data) } catch (e) { /* 忽略 */ }
  },

  has(id) { return this.data.owned.indexOf(id) >= 0 },

  addOwned(id) {
    if (id && !this.has(id)) { this.data.owned.push(id); this.save() }
  },

  // 装备/卸下同一槽位（再次点击已装备项即卸下）
  equip(slot, id) {
    if (this.data.equipped[slot] === id) this.data.equipped[slot] = null
    else this.data.equipped[slot] = id
    this.save()
  },

  unequip(slot) { this.data.equipped[slot] = null; this.save() },

  // 当前已装备物品的合计 mods（用于创建主角时套用）
  mods() { return computeMods(this.data.equipped) },

  // 当前武器类型：武器槽装备决定；未穿戴则默认机枪
  weaponType() {
    const it = getEquip(this.data.equipped.weapon)
    return (it && it.weapon) || 'gun'
  },

  // 战利品：随机抽取最多 3 件（优先未拥有），返回 id 数组
  rollLoot() {
    const unowned = EQUIP_POOL.filter(e => !this.has(e.id))
    const src = unowned.length ? unowned : EQUIP_POOL
    const shuffled = src.slice().sort(() => Math.random() - 0.5)
    return shuffled.slice(0, 3).map(e => e.id)
  }
}

module.exports = Progress
