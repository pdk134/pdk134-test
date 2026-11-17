"""SFT 样本的 instruction/input/output/meta schema 与 Prompt 构造。

统一在这里构造，保证训练、评测、线上推理三处的 Prompt 完全一致
（Prompt 不一致是 Text-to-SQL 微调最常见的隐性掉分原因）。
"""
from common.paths import SCHEMA_SQL

INSTRUCTION = (
    '你是数据仓库 SQL 助手。根据给定的表结构、业务口径与问题，'
    '生成一条可在 SQLite 执行的 SQL 查询。只输出 SQL，不要解释、不要 markdown 代码块。'
)


def schema_prompt():
    """直接读 warehouse_schema.sql，避免手写 prompt 与真实 DDL 漂移。"""
    return SCHEMA_SQL.read_text(encoding='utf-8').strip()


def build_input(question, schema_text=None, context=None):
    parts = ['### 表结构（SQLite）', '```sql', schema_text or schema_prompt(), '```']
    if context:
        parts += ['### 业务口径 / 检索到的参考资料', context.strip()]
    parts += ['### 问题', question.strip()]
    return '\n'.join(parts)


def make_sft(row, split='train', tokenizer=None):
    """把清洗后的中间记录转成最终 SFT 样本。"""
    question = row['question'].strip()
    inp = build_input(question, context=row.get('context'))
    out = row['sql'].strip().rstrip(';').strip() + ';'
    text = inp + '\n' + out
    meta = {
        'id': row['id'],
        'source': row.get('source', 'unknown'),
        'license': row.get('license', 'unknown'),
        'db_id': row.get('db_id', 'warehouse'),
        'theme': row.get('theme', '未分类'),
        'sql_template': row.get('sql_template', 'POINT_LOOKUP'),
        'difficulty': row.get('difficulty', {}),
        'level': row.get('level', 'easy'),
        'split': split,
        'tokens': len(tokenizer.encode(text)) if tokenizer else max(1, len(text) // 3)
    }
    return {'instruction': INSTRUCTION, 'input': inp, 'output': out, 'meta': meta}
