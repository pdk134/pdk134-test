// 图片资源加载与处理（微信小游戏：wx.createImage / 离屏 Canvas）
// 用法：把图片放到项目根目录 assets/ 下，按名字加载；
// 未加载完成时实体回退到矢量绘制，不会白屏。
const loader = {
  images: {},
  sheets: {},

  // —— 云存储：自动发现存储桶前缀 ——
  // 上传一个探针文件换取 fileID，从里面解析出 bucket（如 cloud://env.bucket/），
  // 结果缓存到本地存储，下次启动直接用；探针文件随即删除。
  _cloudPrefix() {
    if (this._prefix) return Promise.resolve(this._prefix)
    let cached = ''
    try { cached = wx.getStorageSync('tcb_prefix') || '' } catch (e) { cached = '' }
    if (cached) { this._prefix = cached; return Promise.resolve(cached) }
    return new Promise((resolve) => {
      if (!wx.cloud) { resolve(''); return }
      wx.cloud.uploadFile({
        cloudPath: '__probe__.txt',
        fileContent: new Uint8Array([1]).buffer,
        success: (r) => {
          const fid = (r && r.fileID) || ''
          const i = fid.lastIndexOf('/')
          const prefix = i > 0 ? fid.slice(0, i + 1) : ''
          if (prefix) {
            this._prefix = prefix
            console.log('[assets] 自动探测到云存储前缀:', prefix)
            try { wx.setStorageSync('tcb_prefix', prefix) } catch (e) { /* 忽略 */ }
            try { wx.cloud.deleteFile({ fileList: [fid], fail: () => {} }) } catch (e) { /* 忽略 */ }
          }
          resolve(prefix)
        },
        fail: (err) => {
          console.warn('[assets] 探针上传失败，无法自动探测前缀:', err && (err.errMsg || err))
          resolve('')
        }
      })
    })
  },

  // 加载单图，三种来源自动识别：
  //   cloud://auto/xxx → 云存储：自动发现桶前缀后下载（无需配 downloadFile 合法域名）
  //   cloud://xxx     → 云存储：指定 fileID 前缀直接下载
  //   http(s)://      → 普通 CDN（需配 downloadFile 合法域名）
  //   其他（相对路径） → 本地 assets/ 直接加载
  load(name, src) {
    return new Promise((resolve) => {
      // 把图片真正读出来（本地路径 / 临时文件路径均可）
      const done = (finalSrc) => {
        try {
          const img = wx.createImage()
          img.onload = () => { this.images[name] = img; resolve(img) }
          img.onerror = () => {
            console.warn('[assets] 图片解码失败:', name, finalSrc)
            resolve(null)
          }
          img.src = finalSrc
        } catch (e) {
          console.warn('[assets] 创建图片失败:', name, e)
          resolve(null)
        }
      }
      if (/^cloud:\/\//.test(src)) {
        if (!wx.cloud) { resolve(null); return }
        const dl = (fileID, next) => {
          wx.cloud.downloadFile({
            fileID,
            success: (r) => done(r.tempFilePath || fileID),
            fail: (err) => {
              console.warn('[assets] 云存储下载失败:', name, fileID, err && (err.errMsg || err))
              if (next) next(); else resolve(null)
            }
          })
        }
        if (src.indexOf('cloud://auto/') === 0) {
          this._cloudPrefix().then((prefix) => {
            if (!prefix) { resolve(null); return }
            const rest = src.slice('cloud://auto/'.length)
            // 依次尝试：桶根目录 → game 子目录（图片传到子文件夹也能找到）
            dl(prefix + rest, () => dl(prefix + 'game/' + rest, null))
          })
        } else {
          dl(src, null)
        }
      } else if (/^https?:\/\//.test(src)) {
        wx.downloadFile({
          url: src,
          success: (r) => done(r.tempFilePath || src),
          fail: () => resolve(null)
        })
      } else {
        done(src)
      }
    })
  },

  // 单图：去背景（+可选清区域去水印），缓存为透明底 canvas
  loadProcessed(name, src, opts) {
    opts = opts || {}
    return this.load(name, src).then((img) => {
      if (!img) return null
      try {
        const cv = this._removeBg(img, opts)
        this.images[name] = cv
        return cv
      } catch (e) {
        this.images[name] = img
        return img
      }
    })
  },

  // 精灵表（横向 frames 帧一条）
  // opts.raw = true：图片已是透明底（离线烘焙），跳过去背景直接使用
  loadSheet(name, src, frames, opts) {
    opts = opts || {}
    return this.load(name + '@raw', src).then((img) => {
      if (!img) return null
      try {
        const cv = opts.raw ? img : this._removeBg(img, opts)
        this.sheets[name] = { canvas: cv, frames, frameW: cv.width / frames, frameH: cv.height }
        return this.sheets[name]
      } catch (e) {
        return null
      }
    })
  },

  // 网格精灵表（AI 生成的多格图）：按列切片 → 每格内容自动裁剪 → 底对齐拼成标准横条
  // opts: { cols, useCols, cropTop, cropBottom, inset, bgTolerance, clearRects }
  loadSheetGrid(name, src, opts) {
    opts = opts || {}
    return this.load(name + '@raw', src).then((img) => {
      if (!img) return null
      try {
        const w = img.width
        const h = img.height
        const cv = this._removeBg(img, opts)
        const px = cv.getContext('2d').getImageData(0, 0, w, h).data

        const cols = opts.cols || 4
        const cellW = w / cols
        const useCols = opts.useCols || null
        const inset = opts.inset != null ? opts.inset : 8
        const y0 = Math.round((opts.cropTop || 0) * h)
        const y1 = Math.round((opts.cropBottom != null ? opts.cropBottom : 1) * h)

        const list = []
        for (let c = 0; c < cols; c++) {
          if (useCols && useCols.indexOf(c) < 0) continue
          const x0 = Math.round(c * cellW) + inset
          const cw = Math.round(cellW) - inset * 2
          const b = this._bbox(px, w, x0, y0, cw, y1 - y0)
          if (b) list.push(b)
        }
        if (!list.length) return null

        let mw = 0, mh = 0
        for (const b of list) { if (b.w > mw) mw = b.w; if (b.h > mh) mh = b.h }

        const out = wx.createCanvas()
        out.width = mw * list.length
        out.height = mh
        const ox = out.getContext('2d')
        list.forEach((b, i) => {
          // 底对齐（脚踩同一基线），水平居中
          ox.drawImage(cv, b.x, b.y, b.w, b.h, i * mw + (mw - b.w) / 2, mh - b.h, b.w, b.h)
        })

        this.sheets[name] = { canvas: out, frames: list.length, frameW: mw, frameH: mh }
        return this.sheets[name]
      } catch (e) {
        return null
      }
    })
  },

  // 去背景（自适应泛洪，容忍背景渐变/暗角/最外圈暗边）：
  // - 亮度下限：深色描边/头发/靴子不算背景
  // - 红绿判据：偏绿（浅绿外套/霉斑）不算背景，防止把角色吃掉
  // - 与已接受邻居逐像素比较色差后扩散：跟着背景渐变走
  _removeBg(img, opts) {
    const w = img.width
    const h = img.height
    const cv = wx.createCanvas()
    cv.width = w
    cv.height = h
    const cx = cv.getContext('2d')
    cx.drawImage(img, 0, 0)
    if (opts.clearRects) {
      for (const r of opts.clearRects) {
        cx.clearRect(r.x * w, r.y * h, r.w * w, r.h * h)
      }
    }
    const data = cx.getImageData(0, 0, w, h)
    const px = data.data
    const step = opts.edgeTol || 16       // 相邻像素色差阈值
    const lumFloor = opts.lumFloor || 120 // 亮度下限
    const bound = opts.bgBound || 110     // 与边缘均值参考色的安全上限

    // 参考色：向内缩 2-3px 的边缘均值（避开最外圈暗边）
    let br = 0, bgc = 0, bb = 0, bn = 0
    const edgeColor = (x, y) => {
      const i = (y * w + x) * 4
      if (px[i + 3] === 0) return
      br += px[i]; bgc += px[i + 1]; bb += px[i + 2]; bn++
    }
    for (let x = 4; x < w - 4; x++) {
      edgeColor(x, 2); edgeColor(x, 3); edgeColor(x, h - 4); edgeColor(x, h - 3)
    }
    for (let y = 4; y < h - 4; y++) {
      edgeColor(2, y); edgeColor(3, y); edgeColor(w - 4, y); edgeColor(w - 3, y)
    }
    if (bn > 0) { br /= bn; bgc /= bn; bb /= bn }

    const ok = (idx) => {
      const i = idx * 4
      if (px[i + 3] === 0) return false
      const r = px[i], g = px[i + 1], b = px[i + 2]
      if (0.299 * r + 0.587 * g + 0.114 * b < lumFloor) return false
      // 绿色主导判据（饱和度）：丧尸皮肤/浅绿外套 G 明显最高；
      // 米色底 R 最高、蓝灰底 B 最高，均不会触发
      if (g - r > 8 && g - b > 8) return false
      const dr = r - br, dg = g - bgc, db = b - bb
      return (dr * dr + dg * dg + db * db) <= bound * bound
    }

    const visited = new Uint8Array(w * h)
    const stack = []
    const seed = (x, y) => {
      const idx = y * w + x
      if (!visited[idx] && ok(idx)) { visited[idx] = 1; stack.push(idx) }
    }
    for (let x = 0; x < w; x++) {
      seed(x, 2); seed(x, 3); seed(x, h - 4); seed(x, h - 3)
    }
    for (let y = 0; y < h; y++) {
      seed(2, y); seed(3, y); seed(w - 4, y); seed(w - 3, y)
    }

    while (stack.length) {
      const idx = stack.pop()
      px[idx * 4 + 3] = 0
      const x = idx % w
      const y = (idx - x) / w
      const i = idx * 4
      const r = px[i], g = px[i + 1], b = px[i + 2]
      const trySpread = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
        const nIdx = ny * w + nx
        if (visited[nIdx] || !ok(nIdx)) return
        const ni = nIdx * 4
        const dr = px[ni] - r, dg = px[ni + 1] - g, db = px[ni + 2] - b
        if (dr * dr + dg * dg + db * db < step * step) {
          visited[nIdx] = 1
          stack.push(nIdx)
        }
      }
      trySpread(x - 1, y); trySpread(x + 1, y); trySpread(x, y - 1); trySpread(x, y + 1)
    }

    cx.putImageData(data, 0, 0)

    // 健全性检查：透明比例过低说明去背景失败
    let clear = 0
    for (let i = 3; i < px.length; i += 4) { if (px[i] === 0) clear++ }
    const ratio = clear / (w * h)
    if (ratio < 0.3) {
      console.warn('[assets] 去背景可能失败，透明比例仅', ratio.toFixed(2))
    }
    return cv
  },

  // 在指定区域内求非透明像素包围盒
  _bbox(px, w, x0, y0, cw, ch) {
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
    const xEnd = x0 + cw
    const yEnd = y0 + ch
    for (let y = y0; y < yEnd; y++) {
      const row = y * w
      for (let x = x0; x < xEnd; x++) {
        if (px[(row + x) * 4 + 3] > 20) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return null
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
  },

  getSheet(name) {
    return this.sheets[name] || null
  },

  get(name) {
    return this.images[name] || null
  },

  loadAll(map) {
    return Promise.all(Object.keys(map).map(k => this.load(k, map[k])))
  }
}

module.exports = loader
