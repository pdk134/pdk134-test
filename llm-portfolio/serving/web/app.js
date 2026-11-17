/* 数据开发助手工作台：原生 JS，无构建、无依赖 */
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const VIEWS = {
  sql: ['SQL 工作台', '用自然语言提问，生成可执行 SQL 并查看结果'],
  rag: ['指标口径问答', '检索数据字典与指标口径，生成带引用的回答'],
  eval: ['评测报告', '基座 / LoRA 各组在同一冻结评测集上的对比'],
  status: ['系统状态', '依赖就绪情况与系统链路']
}

const SQL_EXAMPLES = [
  '统计 2024-03 的 GMV（排除取消单）',
  '统计 2024-03 各品类销售额，从高到低',
  '统计 2024-03 每日 GMV，按日期升序',
  '计算 2024-03 的退款率',
  '找出复购用户（有效订单数 >= 2）及其订单数'
]
const RAG_EXAMPLES = [
  'GMV 要排除取消单吗？依据是什么',
  '事实表为什么要按 dt 分区裁剪',
  '支付流水重复了怎么算净支付额',
  'MTD 和 YTD 分别怎么界定'
]

function chips(containerId, items, targetId) {
  $(containerId).innerHTML = items.map(t =>
    `<button class="chip" data-text="${esc(t)}">${esc(t)}</button>`).join('')
  $(containerId).addEventListener('click', (e) => {
    const b = e.target.closest('.chip')
    if (!b) return
    $(targetId).value = b.dataset.text
    $(targetId).focus()
  })
}

function switchView(key) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === key))
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  $('view-' + key).classList.add('active')
  const [t, s] = VIEWS[key]
  $('viewTitle').textContent = t
  $('viewSubtitle').textContent = s
  if (key === 'eval') loadEval()
  if (key === 'status') loadStatus()
}

async function api(path, opts) {
  const r = await fetch(path, opts)
  if (!r.ok) throw new Error(`HTTP ${r.status} ` + (await r.text()).slice(0, 160))
  return r.json()
}

function busy(btn, on) {
  btn.disabled = on
  btn.querySelector('.spinner').hidden = !on
  btn.querySelector('.btn-label').textContent = on ? '处理中…' : (btn.id === 'sqlRun' ? '生成 SQL' : '检索并回答')
}

/* ---------------- 健康状态 ---------------- */
async function loadHealth() {
  try {
    const h = await api('/health')
    const ok = h.status === 'ok'
    const badge = $('modelBadge')
    const model = h.generator || '未配置'
    badge.className = 'badge' + (ok ? '' : ' off')
    badge.innerHTML = `<i class="dot"></i>${esc(model)}`
    $('sideMeta').textContent = `模型：${model} | 测试库：${h.db_exists ? '就绪' : '缺失'} | 评测集：${h.eval_frozen ? '已冻结' : '未冻结'} | 索引：${h.rag_index ? '就绪' : '缺失'}`
    window.__health = h
  } catch (e) {
    $('modelBadge').className = 'badge off'
    $('modelBadge').innerHTML = '<i class="dot"></i>服务未连接'
    $('sideMeta').textContent = '无法连接后端：' + e.message
  }
}

/* ---------------- SQL 工作台 ---------------- */
function renderRows(rows, columns) {
  if (!rows || !rows.length) return '<div class="empty">查询返回 0 行</div>'
  const cols = (columns && columns.length) ? columns : rows[0].map((_, i) => '列 ' + (i + 1))
  const head = '<tr><th>#</th>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>'
  const body = rows.map((r, i) =>
    '<tr><td style="color:#6f7d96">' + (i + 1) + '</td>' +
    r.map(v => `<td>${esc(v === null ? 'NULL' : (typeof v === 'number' ? +v.toFixed(4) : v))}</td>`).join('') + '</tr>'
  ).join('')
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
}

async function runSql() {
  const q = $('sqlQuestion').value.trim()
  if (!q) { $('sqlQuestion').focus(); return }
  const btn = $('sqlRun')
  busy(btn, true)
  $('sqlError').hidden = true
  $('sqlCode').innerHTML = '<span class="placeholder">生成中…</span>'
  $('sqlMeta').innerHTML = ''
  try {
    const r = await api('/sql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, execute: $('sqlExecute').checked })
    })
    $('sqlCode').textContent = r.sql || '（模型未返回 SQL）'
    $('copySql').disabled = !r.sql
    const pills = [`<span class="meta-pill">${esc(r.generator || 'api')}</span>`]
    if (r.executed) pills.push('<span class="meta-pill ok">已在测试库执行</span>')
    if (r.error) pills.push('<span class="meta-pill">有提示</span>')
    $('sqlMeta').innerHTML = pills.join('')
    if (r.error) { $('sqlError').textContent = r.error; $('sqlError').hidden = false }
    $('sqlTableWrap').innerHTML = r.executed
      ? renderRows(r.rows, r.columns)
      : '<div class="empty">未开启「在测试库执行」</div>'
    $('rowCount').textContent = r.executed ? `${(r.rows || []).length} 行` : '未执行'
  } catch (e) {
    $('sqlCode').innerHTML = '<span class="placeholder">请求失败</span>'
    $('sqlError').textContent = e.message
    $('sqlError').hidden = false
  } finally { busy(btn, false) }
}

/* ---------------- RAG ---------------- */
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[(\d+)\]/g, '<sup style="color:#5b8cff">[$1]</sup>')
}

async function runRag() {
  const q = $('ragQuestion').value.trim()
  if (!q) { $('ragQuestion').focus(); return }
  const btn = $('ragRun')
  busy(btn, true)
  $('ragNote').hidden = true
  $('ragAnswer').innerHTML = '<span class="placeholder">检索并生成中…</span>'
  try {
    const r = await api('/rag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, k: 3 })
    })
    $('ragAnswer').innerHTML = r.answer
      ? inlineMd(r.answer)
      : '<span class="placeholder">模型未生成答案（详见右侧提示）</span>'
    $('ragModel').textContent = r.generator || 'none'
    $('ragHitCount').textContent = (r.citations || []).length + ' 条'
    $('ragCites').innerHTML = (r.citations || []).length
      ? r.citations.map(c => `<div class="cite">
          <div class="cite-head"><span>[${c.rank}] ${esc(c.title)}</span><span>${esc(c.source)} · ${c.score}</span></div>
          <div class="cite-text">${esc(c.text.replace(/^##[^\n]*\n/, '').slice(0, 260))}</div>
        </div>`).join('')
      : '<div class="empty">没有检索到相关内容</div>'
    if (r.note) { $('ragNote').textContent = r.note; $('ragNote').hidden = false }
  } catch (e) {
    $('ragAnswer').textContent = '请求失败：' + e.message
  } finally { busy(btn, false) }
}

/* ---------------- 评测报告 ---------------- */
function metric(label, value, sub, cls) {
  return `<div class="metric ${cls || ''}"><div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div><div class="sub">${esc(sub || '')}</div></div>`
}

async function loadEval() {
  try {
    const r = await api('/evaluate')
    const items = r.items || []
    const official = items.filter(i => i.official)
    const shown = official.length ? official : items
    const latest = shown[shown.length - 1]
    if (latest) {
      $('evalMetrics').innerHTML =
        metric('结果准确率', (latest.result_accuracy * 100).toFixed(2) + '%', latest.name + ' · 最佳参考', 'good') +
        metric('SQL 可执行率', (latest.execution_success * 100).toFixed(2) + '%', '生成即可执行') +
        metric('精确匹配', (latest.exact_match * 100).toFixed(2) + '%', '归一化 SQL 一致') +
        metric('评测集规模', latest.eval_size, '独立冻结样本', 'warn')
    } else {
      $('evalMetrics').innerHTML = metric('暂无评测结果', '—', '先跑 eval/run_eval.py')
    }
    if (!items.length) {
      $('evalTableWrap').innerHTML = '<div class="empty">还没有任何评测结果</div>'
    } else {
      const head = '<tr><th>实验</th><th>生成器</th><th>正式</th><th>结果准确率</th><th>可执行率</th><th>精确匹配</th><th>样本数</th></tr>'
      const body = items.map(i => `<tr>
        <td>${esc(i.name)}</td><td>${esc(i.generator)}</td>
        <td>${i.official ? '是' : '<span style="color:#f5b544">否（自检）</span>'}</td>
        <td>${(i.result_accuracy * 100).toFixed(2)}%</td>
        <td>${(i.execution_success * 100).toFixed(2)}%</td>
        <td>${(i.exact_match * 100).toFixed(2)}%</td><td>${i.eval_size}</td>
      </tr>`).join('')
      $('evalTableWrap').innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
    }
    $('evalReport').textContent = r.report_md || '（尚无报告）'
    if (!official.length) {
      const note = '当前只有管道自检结果（debug_gold），按设计不计入对比表。正式数字需跑完 base / v1 / v2 三组。'
      $('evalTableWrap').insertAdjacentHTML('beforeend', `<div class="err-box" style="color:#f2cd87;background:rgba(245,181,68,.08);border-color:rgba(245,181,68,.25)">${note}</div>`)
    }
  } catch (e) {
    $('evalTableWrap').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`
  }
}

/* ---------------- 系统状态 ---------------- */
function statusCard(label, ok, sub) {
  return metric(label, ok ? '就绪' : '缺失', sub, ok ? 'good' : 'warn')
}
async function loadStatus() {
  try { window.__health = await api('/health') } catch (e) { window.__health = {} }
  const h = window.__health
  $('statusCards').innerHTML =
    statusCard('API 服务', h.status === 'ok', 'FastAPI / Uvicorn') +
    statusCard('数仓测试库', !!h.db_exists, 'data/warehouse.db') +
    statusCard('冻结评测集', !!h.eval_frozen, 'data/eval.jsonl') +
    statusCard('RAG 索引', !!h.rag_index, 'rag/index/') +
    statusCard('大模型', !!(h.generator && h.generator !== 'none'), h.generator || '未配置')
}

/* ---------------- 初始化 ---------------- */
document.getElementById('nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item')
  if (b) switchView(b.dataset.view)
})
chips('sqlChips', SQL_EXAMPLES, 'sqlQuestion')
chips('ragChips', RAG_EXAMPLES, 'ragQuestion')
$('sqlRun').addEventListener('click', runSql)
$('ragRun').addEventListener('click', runRag)
$('evalRefresh').addEventListener('click', loadEval)
$('sqlQuestion').addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') runSql() })
$('ragQuestion').addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') runRag() })
$('copySql').addEventListener('click', () => {
  navigator.clipboard.writeText($('sqlCode').textContent).then(() => {
    const b = $('copySql'); b.textContent = '已复制'; setTimeout(() => b.textContent = '复制', 1200)
  })
})
loadHealth()
