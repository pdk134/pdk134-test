"""SQL 归一化、难度特征、模板分桶与近似去重。

去重用「归一化后哈希」判精确重复，用 MinHash + Jaccard 判近似重复，
避免评测集里混入只改了表名/字面量的训练样本（数据泄漏）。
"""
import hashlib
import re

_LITERAL_STR = re.compile(r"'(?:[^']|'')*'")
_LITERAL_NUM = re.compile(r'\b\d+(?:\.\d+)?\b')
_LINE_COMMENT = re.compile(r'--[^\n]*')
_BLOCK_COMMENT = re.compile(r'/\*.*?\*/', re.S)
_WS = re.compile(r'\s+')

_KEYWORDS = {
    'select', 'from', 'where', 'group', 'by', 'order', 'having', 'join',
    'left', 'right', 'inner', 'outer', 'on', 'and', 'or', 'not', 'in',
    'as', 'with', 'union', 'all', 'case', 'when', 'then', 'else', 'end',
    'distinct', 'over', 'partition', 'limit', 'null', 'is', 'like',
    'between', 'exists', 'asc', 'desc', 'inner', 'cross'
}
_AGGS = re.compile(r'\b(count|sum|avg|min|max)\s*\(', re.I)


def normalize_sql(sql):
    """归一化：去注释 → 抹掉字面量 → 小写 → 压缩空白 → 去尾分号。"""
    if not sql:
        return ''
    s = _BLOCK_COMMENT.sub(' ', sql)
    s = _LINE_COMMENT.sub(' ', s)
    s = _LITERAL_STR.sub("'?'", s)
    s = _LITERAL_NUM.sub('?', s)
    s = s.lower().strip().rstrip(';').strip()
    s = _WS.sub(' ', s)
    s = re.sub(r'\s*([(),=<>+\-*/])\s*', r'\1', s)
    return s


def sql_hash(sql):
    return hashlib.sha1(normalize_sql(sql).encode('utf-8')).hexdigest()


def difficulty(sql):
    """难度特征：JOIN 数 / 聚合层数 / 条件数 / 子查询 / 窗口函数。"""
    s = normalize_sql(sql)
    return {
        'joins': len(re.findall(r'\bjoin\b', s)),
        'aggs': len(_AGGS.findall(s)),
        'conds': len(re.findall(r'\b(and|or)\b', s)) + (1 if 'where' in s else 0),
        'has_subquery': int(s.count('select') > 1),
        'has_window': int('over(' in s.replace(' ', '') or ' over ' in f' {s} '),
        'has_group_by': int('group by' in s),
        'has_distinct': int('distinct' in s),
        'has_cte': int(s.strip().startswith('with ')),
        'chars': len(s)
    }


def sql_template(sql):
    """SQL 模板分桶：用于多样性均衡采样。"""
    d = difficulty(sql)
    s = normalize_sql(sql)
    if d['has_cte'] or 'union' in s:
        return 'CTE/UNION'
    if d['has_window']:
        return 'WINDOW'
    if d['has_subquery']:
        return 'SUBQUERY'
    if d['joins'] >= 2:
        return 'MULTI_JOIN'
    if d['joins'] == 1:
        return 'JOIN_AGG' if d['aggs'] else 'JOIN_PLAIN'
    if d['has_group_by']:
        return 'GROUP_BY'
    if d['aggs']:
        return 'AGG_WHERE'
    return 'POINT_LOOKUP'


def difficulty_level(d):
    """三档难度：easy / medium / hard。"""
    score = d['joins'] * 2 + d['aggs'] + d['conds'] + d['has_subquery'] * 2 \
        + d['has_window'] * 2 + d['has_group_by'] + d['has_cte'] * 2
    if score <= 2:
        return 'easy'
    if score <= 6:
        return 'medium'
    return 'hard'


# ---- MinHash 近似去重（纯 Python，无需额外依赖）----

def _shingles(text, k=4):
    s = normalize_sql(text)
    if len(s) < k:
        return {s} if s else set()
    return {s[i:i + k] for i in range(len(s) - k + 1)}


def _h(sh, seed):
    return int.from_bytes(
        hashlib.blake2b(sh.encode('utf-8'), digest_size=8,
                        person=('mh%d' % seed).encode()).digest(), 'big'
    )


_MERSENNE = (1 << 61) - 1


def minhash(sql, n=48):
    shs = _shingles(sql)
    if not shs:
        return tuple([_MERSENNE] * n)
    sig = []
    for seed in range(n):
        sig.append(min((_h(sh, seed) ^ (seed * 0x9E3779B1)) & _MERSENNE for sh in shs))
    return tuple(sig)


def minhash_similarity(a, b):
    if len(a) != len(b):
        return 0.0
    return sum(1 for x, y in zip(a, b) if x == y) / len(a)


def mask_literals(sql):
    """只对字面量做掩码（保留结构），供错误归因里判断时间口径差异。"""
    s = _LITERAL_STR.sub("'?'", sql or '')
    return _LITERAL_NUM.sub('?', s)
