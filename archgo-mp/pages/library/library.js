/**
 * 词库页：中英日搜索 + 分类 / 状态筛选 + 术语详情弹窗。
 * 筛选与展示逻辑与 Web 纯净版 renderLibrary 一致（命中范围：中文名 / 英文 / 日文 / 释义）。
 */
const C = require('../../libs/common.js');
const Store = C.Store;
const SRS = C.SRS;

Page({
  data: {
    theme: 'dark',
    q: '',
    cat: 'all',
    status: 'all',
    cats: [{ key: 'all', name: '全部' }],
    statuses: [
      { key: 'all', name: '全部' },
      { key: 'new', name: '未学习' },
      { key: 'learning', name: '学习中' },
      { key: 'mastered', name: '已掌握' }
    ],
    list: [],
    count: 0,
    modal: { visible: false, term: null }
  },

  onLoad: function () {
    var cats = [{ key: 'all', name: '全部' }];
    C.CATS.forEach(function (c) { cats.push({ key: c, name: c }); });
    this.setData({ cats: cats });
    this.render();
  },

  onShow: function () {
    C.syncTheme(this);
    this.render(); // 学习进度可能已在其它页发生变化，刷新状态徽标
  },

  onSearch: function (e) {
    this.setData({ q: e.detail.value });
    this.render();
  },

  onClearQ: function () {
    this.setData({ q: '' });
    this.render();
  },

  onCat: function (e) {
    this.setData({ cat: e.currentTarget.dataset.k });
    this.render();
  },

  onStatus: function (e) {
    this.setData({ status: e.currentTarget.dataset.k });
    this.render();
  },

  render: function () {
    var self = this;
    var q = this.data.q.trim().toLowerCase();
    var cat = this.data.cat, status = this.data.status;
    var list = C.TERMS.filter(function (t) {
      if (cat !== 'all' && t.c !== cat) return false;
      if (status !== 'all' && SRS.statusOf(Store.raw(t.t)) !== status) return false;
      if (!q) return true;
      var hay = (t.t + ' ' + (t.en || '') + ' ' + (t.ja || '') + ' ' + (t.d || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    }).map(function (t) {
      var s = C.statusLabel(t.t);
      return {
        id: t.t, t: t.t, en: t.en || '', ja: t.ja || '', d: t.d || '', c: t.c || '',
        badge: s.text, cls: s.cls
      };
    });
    this.setData({ list: list, count: list.length });
  },

  onItemTap: function (e) {
    this.setData({ modal: { visible: true, term: C.byId[e.currentTarget.dataset.id] || null } });
  },
  onModalClose: function () { this.setData({ 'modal.visible': false }); },
  onModalGoto: function (e) {
    this.setData({ 'modal.term': C.byId[e.detail.name] || null });
  }
});
