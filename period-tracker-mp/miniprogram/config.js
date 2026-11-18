/**
 * 任务清单 + 月记 小程序 - 云端配置
 *
 * 个人主体 + 微信云开发，不需要自己备案域名。两个模块各用一个集合：
 *   - tasks       任务清单，一条任务一个文档
 *   - period_data 月记，一个用户一份数据（整包收发、按字段时间戳合并）
 *   两者权限都要设为「仅创建者可读写」，_openid 由平台自动写入；
 *   客户端直接 wx.cloud.database() 读写，不必部署云函数也能跑；
 *   cloudfunctions/login 只用于取 openid（本地缓存分键 / 以后做跨端账号绑定），
 *   没部署也会自动降级，不影响使用。
 *
 * 云开发环境：
 *   - CLOUD_ENV 填环境 ID = 代码里明确指定使用该环境（推荐，多个环境时不会选错）；
 *   - 留空 = 使用云开发控制台里的「默认环境」，开通后无需改代码。
 *
 * 首次运行：
 *   1) 微信开发者工具「导入项目」选本目录，把 project.config.json 的
 *      appid 从 touristappid 改成自己的小程序 AppID；
 *   2) 工具栏点「云开发」→ 开通，记下环境 ID（只有一个环境可不填）；
 *   3) 云开发控制台 → 数据库 → 新建集合 tasks 和 period_data，
 *      两个都把权限选「仅创建者可读写」；
 *      再建一个 remind_log，用来存提醒发送记录（由云函数写入，客户端无需读）；
 *   4) 可选：右键 cloudfunctions/login → 上传并部署，用于显示 openid；
 *   5) 要用提醒：右键 cloudfunctions/remind →「上传并部署：云端安装依赖」，
 *      config.json 里的定时触发器（每分钟）会随之上传，上传后确认触发器已生效。
 *   未开通云开发 / 集合未建时会自动降级为离线模式，界面仍可用。
 *
 * 上线前还需在微信公众平台完成：小程序备案、服务类目、用户隐私保护指引。
 * 月记已内置为小程序板块，与网页版（Supabase 账号）数据暂不互通。
 */

const CFG = {
  CLOUD_ENV: 'cloud1-d9go64jy3cbbddd85',
  COLLECTION: 'tasks',
  PUSH_DELAY: 2500,
  STORAGE_PREFIX: 'taskList.mp.v1',
  SETTINGS_KEY: 'taskList.mp.settings',

  // 月记
  PERIOD_COLLECTION: 'period_data',
  PERIOD_STORAGE_PREFIX: 'periodTracker.mp.v1',
  PERIOD_SCOPE_KEY: 'periodTracker.mp.scope',

  // 关于页展示信息（发布新版本时改这里；线上版本会优先取微信的版本号）
  APP_NAME: '清单月记',
  APP_DESC: '把待办清单和经期记录放在一起的轻量小工具',
  APP_VERSION: '1.0.0',

  // 待办提醒（微信一次性订阅消息）
  // 模板 ID 来自：mp.weixin.qq.com → 功能 → 订阅消息 → 我的模板；每个小程序唯一
  // 设了具体时间的任务按 remind_at 到点提醒；没设时间的任务每天 8:00 汇总当天+次日。
  // 定时频率、模板字段名、日志集合等配置在 cloudfunctions/remind/index.js 顶部，
  // 触发器在 cloudfunctions/remind/config.json；发送记录写入云数据库 remind_log 集合
  REMIND_TMPL_ID: 'EPvaF7BUcvy5Pg5bseZBDFLWE2jxNaMNYUz70YrfJsw'
};

module.exports = CFG;
