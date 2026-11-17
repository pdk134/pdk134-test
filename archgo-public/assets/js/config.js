/**
 * Supabase 云端配置 —— 开发 / 生产双环境
 *
 * 为什么要两个项目而不是同项目不同表：
 *   同步采用「只升不降」的合并策略（box/reps 取大、错题取并集，全程不做删除），
 *   一旦开发和生产共用一张表，测试数据会被合并进去，且**无法通过正常同步再清除**。
 *   分成两个项目后 Auth 用户表也一并隔离，dev 上注册测试账号不会污染生产。
 *
 * 环境怎么切换（日常不需要手动改任何东西）：
 *   - config.js 里同时保存 prod / dev 两套配置；
 *   - 唯一的开关是下面的 window.SUPABASE_ENV；
 *   - 部署流水线构建 main 时会用 sed 把它替换成 'prod'（见 .github/workflows/pages.yml）；
 *   - 本地开发、或任何没走到替换步骤的场景，保持默认的 'dev'。
 *
 * 关键设计：**默认落在 dev**。万一替换步骤失效，线上顶多连到开发库，
 * 绝不会反过来把生产数据写进开发库 —— 这个方向的错误代价小得多。
 *
 * 说明：
 * - url / anonKey 是 Supabase 项目的公开信息，anon key 只代表「未登录匿名角色」，
 *   设计上就放在前端代码里；真正的安全边界是 progress 表的 RLS 策略（每人只能读写自己那一行）。
 * - 千万不要填 service_role / secret keys，那类 key 会绕过 RLS，泄露后任何人可读写全表。
 * - 想确认当前实际连的是哪个环境：开发环境页面顶部有黄黑警示条；
 *   生产环境不显示任何痕迹，在网址后加 ?env 可临时强制查看。
 */

window.SUPABASE_ENVS = {
  prod: {    // 生产（软考备考正式使用）
    url: 'https://wyuhxtnchkndkrsfknlh.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5dWh4dG5jaGtuZGtyc2ZrbmxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyNTI3NDYsImV4cCI6MjEwNjgyODc0Nn0.XUzq6y9IfC6HTdGXY6UrXI2Jb2tGbbzZ8yeRfIpUUyQ',
    table: 'progress'
  },
  dev: {     // 开发（nanana 分支，日常调试与试验都在这里）
    url: 'https://jyytfphsldxmmxqltqvp.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp5eXRmcGhzbGR4bW14cWx0cXZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMTEwMjEsImV4cCI6MjEwNzg4NzAyMX0.-XMvA5peX95a11gccCxoSZAn94FFssRWmrdSaL5fhkA',
    table: 'progress'
  }
};

// ↓↓↓ 构建时唯一会被改写的一行；部署 main 时流水线替换成 'prod'，其余情况保持 'dev' ↓↓↓
window.SUPABASE_ENV = 'dev';
// ↑↑↑ 请保留上面的写法（等号两侧可有空格），替换脚本依赖这个正则 ↑↑↑

window.SUPABASE_CONFIG = window.SUPABASE_ENVS[window.SUPABASE_ENV] || window.SUPABASE_ENVS.dev;

/**
 * 「用户名登录」用的合成邮箱域名。
 *
 * Supabase Auth 只认邮箱，所以用户填用户名时，会确定性地拼成 `用户名@该域名`
 * 再交给它。用 `.invalid` 结尾是因为它是 RFC 2606 保留域名，保证解析不到、
 * 不会有真实邮件投递出去（已实测 Supabase 接受这种地址）。
 *
 * ⚠️ 这个域名一旦上线就不要再改：改了等于所有用户名账号集体失联（登录会算成另一个邮箱）。
 */
window.SUPABASE_USERNAME_DOMAIN = 'archgo-user.invalid';