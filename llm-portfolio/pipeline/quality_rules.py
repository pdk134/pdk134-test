"""数据质检规则。

PLAN 里 #4 JD 明确要求「能发现数据错误、不一致及潜在偏差」，
所以质检不是过场：每条规则带严重级别，产出可归档的质检报告。
"""
import re
import sqlite3
from collections import Counter

from common.paths import DB_PATH
from common.schema import build_input
from common.sqlnorm import normalize_sql

_SEVERITY = {'error': '丢弃', 'warn': '保留但标记'}


def _conn(db_path=None):
    return sqlite3.connect(str(db_path or DB_PATH))


class Rule:
    def __init__(self, code, severity, desc, fn):
        self.code, self.severity, self.desc, self.fn = code, severity, desc, fn

    def check(self, row, ctx):
        hit, detail = self.fn(row, ctx)
        return (self.code, self.severity, self.desc, detail) if hit else None


def _empty_fields(r, ctx):
    missing = [k for k in ('id', 'question', 'sql') if not str(r.get(k, '')).strip()]
    return bool(missing), '缺失字段: ' + ','.join(missing) if missing else ''


def _not_sql(r, ctx):
    s = normalize_sql(r.get('sql', ''))
    return (not s.startswith('select')) and (not s.startswith('with')), \
        '非 SELECT/CTE 语句（含 DML 风险）' if not (s.startswith('select') or s.startswith('with')) else ''


def _not_executable(r, ctx):
    try:
        ctx['conn'].execute(r['sql']).fetchall()
        return False, ''
    except Exception as e:
        return True, 'SQL 不可执行: ' + str(e)[:160]


def _no_partition(r, ctx):
    s = normalize_sql(r.get('sql', ''))
    has_fact = any(t in s for t in ('fact_order', 'fact_pay', 'fact_visit'))
    return has_fact and 'dt' not in s and 'date_key' not in s, \
        '事实表查询未带分区/日期条件（全表扫描）' if has_fact and 'dt' not in s and 'date_key' not in s else ''


def _placeholder(r, ctx):
    # 只认 ${...} / <bizdate> 这类真占位符；不能用 <[^>]+>，
    # 否则 "dt < '2024-04-01' ... amount > 100" 会被误判
    hit = bool(re.search(r'\$\{[^}]*\}|\b(?:TODO|PLACEHOLDER)\b|(?<![<>=])<[A-Za-z_][A-Za-z0-9_]*>',
                         r.get('sql', ''), re.I))
    return hit, 'SQL 含未替换占位符' if hit else ''


def _answer_leak(r, ctx):
    """问题里直接抄了答案 SQL，属于标注污染。"""
    q = r.get('question', '')
    hit = bool(re.search(r'\bSELECT\b', q, re.I))
    return hit, '问题文本疑似夹带 SQL' if hit else ''


def _sql_text_mismatch(r, ctx):
    """问题要求按日期/分组，但 SQL 无对应结构（口径不一致的粗筛）。"""
    q, s = r.get('question', ''), normalize_sql(r.get('sql', ''))
    if ('各' in q or '按' in q) and 'group by' not in s and 'partition by' not in s:
        return True, '问题含分组语义但 SQL 无 GROUP BY'
    return False, ''


def _too_long(r, ctx):
    inp = build_input(r.get('question', ''))
    est = (len(inp) + len(r.get('sql', ''))) // 3
    return est > ctx.get('max_tokens', 2048), f'估算 token {est} 超上限'


RULES = [
    Rule('E001', 'error', '必填字段缺失', _empty_fields),
    Rule('E002', 'error', '非查询语句', _not_sql),
    Rule('E003', 'error', 'gold SQL 不可执行', _not_executable),
    Rule('E004', 'error', '未替换占位符', _placeholder),
    Rule('W001', 'warn', '事实表未做分区裁剪', _no_partition),
    Rule('W002', 'warn', '问题夹带答案 SQL', _answer_leak),
    Rule('W003', 'warn', '问题与 SQL 结构不一致', _sql_text_mismatch),
    Rule('W004', 'warn', '样本超长', _too_long),
]


def run_quality(rows, db_path=None, max_tokens=2048):
    """返回 (通过的记录, 报告 dict)。error 级命中即丢弃。"""
    conn = _conn(db_path)
    ctx = {'conn': conn, 'max_tokens': max_tokens}
    kept, issues = [], []
    try:
        for r in rows:
            bad, warns = [], []
            for rule in RULES:
                try:
                    hit = rule.check(r, ctx)
                except Exception as e:
                    hit = (rule.code, 'error', '规则执行异常', str(e))
                if hit:
                    rec = {'id': r.get('id'), 'code': hit[0], 'severity': hit[1],
                           'rule': hit[2], 'detail': hit[3], 'action': _SEVERITY[hit[1]]}
                    if hit[1] == 'error':
                        bad.append(rec)
                    else:
                        warns.append(rec)
            issues.extend(bad + warns)
            if not bad:
                r['_warnings'] = [w['code'] for w in warns]
                kept.append(r)
    finally:
        conn.close()

    counter = Counter(i['code'] for i in issues)
    report = {
        'input': len(rows), 'kept': len(kept), 'dropped': len(rows) - len(kept),
        'by_code': dict(counter),
        'warning_rate': round(sum(1 for r in kept if r.get('_warnings')) / max(1, len(kept)), 4),
        'issues': issues
    }
    return kept, report


def report_markdown(report):
    lines = ['# 数据质检报告', '',
             f"- 输入 {report['input']} 条，保留 {report['kept']} 条，丢弃 {report['dropped']} 条",
             f"- 带警告样本占比 {report['warning_rate']:.2%}", '',
             '| 规则 | 命中数 | 级别 | 说明 |', '|---|---|---|---|']
    desc = {r.code: (r.severity, r.desc) for r in RULES}
    for code, n in sorted(report['by_code'].items()):
        sev, text = desc.get(code, ('?', '?'))
        lines.append(f'| {code} | {n} | {sev} | {text} |')
    return '\n'.join(lines) + '\n'
