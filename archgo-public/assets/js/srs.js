/**
 * 间隔重复（Spaced Repetition）调度器
 * box 为记忆等级，对应 STEPS 中的复习间隔；rating：0 不认识 / 1 模糊 / 2 认识
 */
window.SRS = (function () {
  var MIN = 60000, DAY = 86400000;

  // 各记忆等级的复习间隔（天），box 0 为「当天重来」
  var STEPS = [0, 1, 2, 4, 7, 15, 30, 60, 120];
  var MASTER_BOX = 4; // box >= 4 视为已掌握

  function statusOf(c) {
    if (!c || c.reps === 0) return 'new';
    if (c.box >= MASTER_BOX) return 'mastered';
    return 'learning';
  }

  /** 依据评分计算下一次复习时间，直接修改并返回卡片 */
  function schedule(c, rating) {
    var now = Date.now();
    if (rating === 0) {
      c.box = 0;
      c.iv = 0;
      c.ease = Math.max(1.3, +(c.ease - 0.2).toFixed(2));
      c.lapses++;
      c.due = now + 10 * MIN; // 10 分钟后重来
    } else if (rating === 1) {
      c.ease = Math.max(1.3, +(c.ease - 0.15).toFixed(2));
      c.box = Math.max(1, c.box);
      c.iv = Math.max(1, Math.round(STEPS[c.box] * c.ease / 2.5));
      c.due = now + c.iv * DAY;
    } else {
      c.ease = Math.min(3.0, +(c.ease + 0.1).toFixed(2));
      c.box = Math.min(STEPS.length - 1, c.box + 1);
      c.iv = Math.max(1, Math.round(STEPS[c.box] * c.ease / 2.5));
      c.due = now + c.iv * DAY;
    }
    c.reps++;
    c.last = now;
    return c;
  }

  /** 距离下次复习的可读文本 */
  function dueText(c) {
    if (statusOf(c) === 'new') return '未学习';
    var delta = c.due - Date.now();
    if (delta <= 0) return '待复习';
    if (delta < 3600000) return Math.round(delta / 60000) + ' 分钟后';
    if (delta < DAY) return Math.round(delta / 3600000) + ' 小时后';
    return Math.round(delta / DAY) + ' 天后';
  }

  return { schedule: schedule, statusOf: statusOf, dueText: dueText, MASTER_BOX: MASTER_BOX };
})();
