"""6 类错误归因（启发式规则，不依赖人工打分 / LLM-as-judge）。

PLAN 边界：只做自动脚本，不做 rubric、不做人工测评。
归因目的是「回流修数据」——看哪类错占比高就补哪类训练样本。
"""
import re
from collections import Counter

from common.sqlnorm import difficulty, mask_literals, normalize_sql

CATEGORIES = [
    ('EXEC_ERROR', 'SQL 语法/执行失败'),
    ('SCHEMA_ERROR', '表名/字段/函数用错'),
    ('TIME_SCOPE_ERROR', '时间窗口或分区口径错'),
    ('JOIN_AGG_ERROR', '关联或聚合粒度错'),
    ('DEDUP_ERROR', '去重逻辑缺失'),
    ('OTHER_RESULT_ERROR', '结果不一致（其他）')
]
LABELS = dict(CATEGORIES)

_SCHEMA_HINT = re.compile(
    r'no such (table|column|function)|unknown (column|table)|misuse of aggregate|'
    r'ambiguous column|has no column named', re.I)
_DATE_LIT = re.compile(r"'?\d{4}-\d{2}-\d{2}'?|\b20\d{6}\b")
_NUM_LIT = re.compile(r'\b\d+(?:\.\d+)?\b')


def literals(sql):
    return set(_DATE_LIT.findall(sql or '')) | set(_NUM_LIT.findall(sql or ''))


def classify(gold_sql, pred_sql, exec_error=None, meta=None):
    """返回 (类别码, 归因说明)。"""
    if exec_error:
        msg = str(exec_error)
        if _SCHEMA_HINT.search(msg):
            return 'SCHEMA_ERROR', 'schema 对象不存在: ' + msg[:100]
        return 'EXEC_ERROR', '执行失败: ' + msg[:100]

    g, p = difficulty(gold_sql), difficulty(pred_sql)
    gmask, pmask = mask_literals(gold_sql), mask_literals(pred_sql)

    # 去重 / 聚合粒度：结构差异优先于字面量差异
    if g['has_distinct'] and not p['has_distinct']:
        return 'DEDUP_ERROR', 'gold 含 DISTINCT，预测未去重'
    if 'group by' in normalize_sql(gold_sql) and 'group by' not in normalize_sql(pred_sql):
        return 'JOIN_AGG_ERROR', 'gold 有分组，预测缺少 GROUP BY'
    if g['joins'] != p['joins'] or g['aggs'] != p['aggs'] or g['has_window'] != p['has_window']:
        return 'JOIN_AGG_ERROR', f"结构不同(join {g['joins']}→{p['joins']}, agg {g['aggs']}→{p['aggs']})"
    if normalize_sql(gmask) == normalize_sql(pmask) and literals(gold_sql) != literals(pred_sql):
        return 'TIME_SCOPE_ERROR', '结构一致但时间/阈值字面量不同'
    return 'OTHER_RESULT_ERROR', '结构相近但结果集不同'


def summarize(items):
    c = Counter(i['error_type'] for i in items if not i['result_match'])
    total = max(1, sum(c.values()))
    return {code: {'count': c.get(code, 0), 'ratio': round(c.get(code, 0) / total, 4),
                   'label': label}
            for code, label in CATEGORIES}


def markdown_table(stats):
    lines = ['| 错误类型 | 说明 | 数量 | 占比 |', '|---|---|---:|---:|']
    for code, label in CATEGORIES:
        s = stats[code]
        lines.append(f'| {code} | {label} | {s["count"]} | {s["ratio"]:.2%} |')
    return '\n'.join(lines)
