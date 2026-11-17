/**
 * 统计页：掌握率环形图 + 近 7 日学习量 + 分类进度 + 难词本。
 * 口径与 Web 纯净版 renderStats 一致；环形图/柱状图由 SVG 改为 canvas type="2d"。
 */
const C = require('../../libs/common.js');
const Store = C.Store;
const SRS = C.SRS;

function dpr() {
  try { return (wx.getWindowInfoSync ? wx.getWindowInfoSync() : wx.getSystemInfoSync()).pixelRatio || 2; }
  catch (e) { return 2; }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

Page({
  data: {
    theme: 'dark',
    total: 0,
    learned: 0,
    mastered: 0,
    due: 0,
    pct: 0,
    legend: [],
    cats: [],
    hard: [],
    modal: { visible: false, term: null }
  },

  onShow: function () {
    C.syncTheme(this);
    this.render();
  },

  render: function () {
    var r = C.countStatus();
    var pct = r.total ? Math.round(r.mastered / r.total * 100) : 0;

    this.setData({
      total: r.total,
      learned: r.learned,
      mastered: r.mastered,
      due: r.due,
      pct: pct,
      legend: [
        { label: '已掌握 ' + r.mastered, color: '#3ecf8e' },
        { label: '学习中 ' + (r.learned - r.mastered), color: '#f5b14c' },
        { label: '未学习 ' + r.new, color: Store.data.settings.theme === 'light' ? '#dbe2ec' : '#262f3d' }
      ],
      cats: C.CATS.map(function (cat) {
        var all = C.TERMS.filter(function (t) { return t.c === cat; });
        var m = all.filter(function (t) { return SRS.statusOf(Store.raw(t.t)) === 'mastered'; }).length;
        return {
          cat: cat, m: m, n: all.length,
          p: all.length ? Math.round(m / all.length * 100) : 0
        };
      }),
      hard: C.TERMS.filter(function (t) {
        var c = Store.raw(t.t);
        return c && (c.lapses > 0 || c.wrong > 0);
      }).sort(function (a, b) {
        var ca = Store.raw(a.t), cb = Store.raw(b.t);
        return (cb.lapses + cb.wrong) - (ca.lapses + ca.wrong);
      }).map(function (t) {
        var c = Store.raw(t.t);
        return { id: t.t, t: t.t, d: t.d || '', lapses: c.lapses, wrong: c.wrong };
      })
    });

    this.drawDonut(pct);
    this.drawBars();
  },

  /* 环形图：底环 + 渐变进度弧，中心文案由 WXML 覆盖层渲染 */
  drawDonut: function (pct) {
    var light = Store.data.settings.theme === 'light';
    var track = light ? '#e3e8f0' : '#1d2430';
    wx.createSelectorQuery().select('#donut').fields({ node: true, size: true }).exec(function (res) {
      var box = res && res[0];
      if (!box || !box.node) return;
      var canvas = box.node;
      var ratio = dpr();
      var w = box.width, h = box.height;
      canvas.width = w * ratio;
      canvas.height = h * ratio;
      var ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, w, h);

      var cx = w / 2, cy = h / 2;
      var lw = 18;
      var r = Math.min(w, h) / 2 - lw / 2 - 4;

      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.strokeStyle = track;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      var frac = pct / 100;
      if (frac > 0) {
        var grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#3ecf8e');
        grad.addColorStop(1, '#5b8cff');
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.stroke();
      }
    });
  },

  /* 近 7 日学习量柱状图（新学 + 复习） */
  drawBars: function () {
    var days = Store.last7();
    var light = Store.data.settings.theme === 'light';
    var cEmpty = light ? '#dbe2ec' : '#262f3d';
    var cLabel = light ? '#6b7a92' : '#93a1b5';
    var cValue = light ? '#1a2230' : '#e6edf6';
    wx.createSelectorQuery().select('#bars').fields({ node: true, size: true }).exec(function (res) {
      var box = res && res[0];
      if (!box || !box.node) return;
      var canvas = box.node;
      var ratio = dpr();
      var w = box.width, h = box.height;
      canvas.width = w * ratio;
      canvas.height = h * ratio;
      var ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, w, h);

      var max = 1;
      days.forEach(function (d) { if (d.total > max) max = d.total; });

      var padT = 26, padB = 36;
      var n = days.length;
      var gap = 14;
      var bw = (w - gap * (n + 1)) / n;
      var base = h - padB;

      days.forEach(function (d, i) {
        var bh = d.total > 0 ? Math.max(6, Math.round(d.total / max * (base - padT))) : 3;
        var x = gap + i * (bw + gap);
        var y = base - bh;

        if (d.total > 0) {
          var grad = ctx.createLinearGradient(0, y, 0, base);
          grad.addColorStop(0, '#5b8cff');
          grad.addColorStop(1, '#7b5bff');
          ctx.fillStyle = grad;
          roundRect(ctx, x, y, bw, bh, 6);
          ctx.fill();
          ctx.fillStyle = cValue;
          ctx.font = '20px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(d.total), x + bw / 2, y - 8);
        } else {
          ctx.fillStyle = cEmpty;
          roundRect(ctx, x, base - 3, bw, 3, 2);
          ctx.fill();
        }

        ctx.fillStyle = cLabel;
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(d.label, x + bw / 2, h - 10);
      });
    });
  },

  onHardTap: function (e) {
    this.setData({ modal: { visible: true, term: C.byId[e.currentTarget.dataset.id] || null } });
  },
  onModalClose: function () { this.setData({ 'modal.visible': false }); },
  onModalGoto: function (e) {
    this.setData({ 'modal.term': C.byId[e.detail.name] || null });
  }
});
