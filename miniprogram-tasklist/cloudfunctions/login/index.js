const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 取当前微信用户的 openid。
 * 这个云函数是可选的：不部署也能用任务清单（云数据库 _openid 会自动隔离数据），
 * 部署后小程序能显示用户标识，并为以后做「小程序 ↔ 网页版」账号绑定留好入口。
 */
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  return {
    openid: wxContext.OPENID,
    appid: wxContext.APPID,
    unionid: wxContext.UNIONID || ''
  };
};
