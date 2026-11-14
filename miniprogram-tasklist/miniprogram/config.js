/**
 * 任务清单小程序 - 云端配置
 *
 * 个人主体 + 微信云开发，不需要自己备案域名：
 *   - 云数据库集合 tasks，权限设为「仅创建者可读写」，_openid 由平台自动写入；
 *   - 客户端直接 wx.cloud.database() 读写，不必部署云函数也能跑；
 *   - cloudfunctions/login 只用于取 openid（本地缓存分键 / 以后做跨端账号绑定），
 *     没部署也会自动降级，不影响使用。
 *
 * 云开发环境：
 *   - 留空 = 使用云开发控制台里的「默认环境」，开通后无需改代码；
 *   - 如果有多个环境，把环境 ID 填到下面的 CLOUD_ENV 即可。
 *
 * 首次运行四步（详细见项目交付说明）：
 *   1) 微信开发者工具「导入项目」选本目录，把 project.config.json 的
 *      appid 从 touristappid 改成自己的小程序 AppID；
 *   2) 工具栏点「云开发」→ 开通，记下环境 ID（只有一个环境可不填）；
 *   3) 云开发控制台 → 数据库 → 新建集合 tasks，权限选「仅创建者可读写」；
 *   4) 可选：右键 cloudfunctions/login → 上传并部署，用于显示 openid。
 *   未开通云开发 / 集合未建时会自动降级为离线模式，界面仍可用。
 *
 * 上线前还需在微信公众平台完成：小程序备案、服务类目、用户隐私保护指引。
 * 个人主体不支持 web-view，所以网页版入口只能复制链接由浏览器打开。
 */

const CFG = {
  CLOUD_ENV: '',
  COLLECTION: 'tasks',
  PUSH_DELAY: 2500,
  STORAGE_PREFIX: 'taskList.mp.v1',
  SETTINGS_KEY: 'taskList.mp.settings',

  // 网页版地址（个人主体小程序不支持 web-view，也不支持直接跳外链，只能复制后用浏览器打开）
  WEB_TASKLIST_URL: 'https://pdk134.github.io/pdk134-test/tasklist/',
  WEB_MONTH_URL: 'https://pdk134.github.io/pdk134-test/period-tracker/'
};

module.exports = CFG;
