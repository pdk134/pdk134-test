/**
 * 任务清单 - Supabase 云端配置（开发 / 生产双环境）
 *
 * 与「架构术语学习通」「月记」共用两个 Supabase 项目和同一套账号体系
 * （用户名确定性拼成 `用户名@archgo-user.invalid`）。
 *
 * 环境怎么切：
 *   - 本文件同时保存两套配置，唯一开关是下面的 window.TASK_SUPABASE_ENV；
 *   - 部署 release 时，流水线会用 sed 把它替换成 'prod'（见 .github/workflows/pages.yml）；
 *   - 本地开发、dev 分支、任何没走到替换的场景，保持默认 'dev'
 *     （默认落在开发库，万一替换失效也绝不会把生产数据写坏）。
 *
 * 安全说明：
 *   - url / anonKey 是 Supabase 的公开信息，anon key 只代表「未登录匿名角色」；
 *     真正的边界是 task_items 表的 RLS 策略（每人只能读写自己的行）。
 *   - 千万不要把 service_role key 写进前端。
 */

window.TASK_SUPABASE_ENVS = {
  prod: {
    url: 'https://wyuhxtnchkndkrsfknlh.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5dWh4dG5jaGtuZGtyc2ZrbmxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyNTI3NDYsImV4cCI6MjEwNjgyODc0Nn0.XUzq6y9IfC6HTdGXY6UrXI2Jb2tGbbzZ8yeRfIpUUyQ',
    table: 'task_items'
  },
  dev: {
    url: 'https://jyytfphsldxmmxqltqvp.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp5eXRmcGhzbGR4bW14cWx0cXZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMTEwMjEsImV4cCI6MjEwNzg4NzAyMX0.-XMvA5peX95a11gccCxoSZAn94FFssRWmrdSaL5fhkA',
    table: 'task_items'
  }
};

// ↓↓↓ 构建时唯一会被改写的一行；部署 release 时替换成 'prod'，其余情况保持 'dev' ↓↓↓
window.TASK_SUPABASE_ENV = 'dev';
// ↑↑↑ 请保留上面的写法（等号两侧可有空格），替换脚本依赖这个正则 ↑↑↑

window.TASK_SUPABASE_CONFIG =
  window.TASK_SUPABASE_ENVS[window.TASK_SUPABASE_ENV] || window.TASK_SUPABASE_ENVS.dev;

/**
 * 「用户名登录」用的合成邮箱域名，与学习通 / 月记保持一致。
 * ⚠️ 一旦上线不要再改，改了等于所有用户名账号集体失联。
 */
window.TASK_USERNAME_DOMAIN = 'archgo-user.invalid';
