// 音效：微信小游戏 InnerAudioContext
// 每个音效一个实例（懒创建，创建即预载 wav，首次播放不卡壳）
// minGap 用于限流：同一音效在极短时间内重复触发时只播一次，避免糊成噪音
const { CONFIG } = require('./config.js')

const cache = {}      // name -> InnerAudioContext
const lastPlay = {}   // name -> 上次播放时间戳

const audio = {
  enabled: true,

  // 预建常用音效实例，提前把 wav 读进来
  init() {
    if (!this.enabled) return
    for (const n of ['shoot', 'zap', 'hit', 'boom']) this._ctx(n)
  },

  _ctx(name) {
    if (cache[name]) return cache[name]
    try {
      const a = wx.createInnerAudioContext()
      a.src = 'audio/' + name + '.wav'
      a.volume = 0
      a.onError((err) => {
        console.warn('[audio] 音效播放失败:', name, err && (err.errMsg || err))
      })
      cache[name] = a
      return a
    } catch (e) {
      console.warn('[audio] 创建音频实例失败:', name, e)
      return null
    }
  },

  // play('shoot', { volume: 0.5, rate: 1.0, minGap: 0.04 })
  play(name, opts) {
    if (!this.enabled) return
    opts = opts || {}
    const minGap = opts.minGap || 0
    const now = Date.now()
    if (minGap > 0 && now - (lastPlay[name] || 0) < minGap * 1000) return
    lastPlay[name] = now

    const a = this._ctx(name)
    if (!a) return
    try {
      const cfgVol = (CONFIG.sound && CONFIG.sound.volume != null) ? CONFIG.sound.volume : 0.7
      a.stop()
      a.volume = (opts.volume != null) ? opts.volume : cfgVol
      if (opts.rate) a.rate = opts.rate
      a.play()
    } catch (e) {
      // 音效失败不影响游戏
    }
  }
}

module.exports = audio
