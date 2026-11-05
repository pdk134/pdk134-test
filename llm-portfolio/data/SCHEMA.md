# 样本 Schema（冻结版）

## 原始记录（`data/raw/*.jsonl`）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | str | ✅ | 全局唯一，前缀标明来源（如 `seed_001` / `spider_0001`） |
| `question` | str | ✅ | 自然语言问题，含业务口径描述 |
| `sql` | str | ✅ | 可在 `data/warehouse.db` 执行的 gold SQL |
| `db_id` | str | ✅ | 数据库标识，本项目统一 `warehouse` |
| `theme` | str | ✅ | 业务主题：时间口径 / 分区裁剪 / 去重逻辑 / JOIN聚合 / 子查询 / 窗口函数 / 指标口径 |
| `source` | str | ✅ | `seed`（自写）/ `spider` / `bird` / `cspider` |
| `license` | str | ✅ | 许可证标识，见 `data/raw/DATASETS.md` |
| `tags` | list[str] | ⬜ | 便于错误归因的细标签 |

公开数据集格式不同（Spider 为 `question` / `query` / `db_id`），由 `pipeline/clean.py` 统一适配到上述字段。

## 中间记录（`data/processed/*.jsonl`）

在原始字段基础上，由流水线补齐：

| 字段 | 来源 | 说明 |
|---|---|---|
| `sql_template` | `sqlnorm.sql_template()` | 结构分桶，用于多样性均衡采样 |
| `difficulty` | `sqlnorm.difficulty()` | `joins/aggs/conds/has_subquery/...` |
| `level` | `sqlnorm.difficulty_level()` | `easy` / `medium` / `hard` |
| `sql_sha1` | `sqlnorm.sql_hash()` | 归一化后哈希，判精确重复 |
| `minhash` | `sqlnorm.minhash()` | 48 维签名，判近似重复 |
| `tokens` | tokenizer 或长度估算 | Prompt + Answer 的 token 数，用于截断 |

## SFT 样本（`data/train.jsonl` / `data/eval.jsonl`）

采用 LLaMA-Factory 的 `alpaca` 格式：

```json
{
  "instruction": "你是数据仓库 SQL 助手。根据给定的表结构、业务口径与问题，生成一条可在 SQLite 执行的 SQL 查询。只输出 SQL，不要解释、不要 markdown 代码块。",
  "input": "### 表结构（SQLite）\n```sql\nCREATE TABLE ...\n```\n### 问题\n统计 2024-03 的 GMV",
  "output": "SELECT SUM(amount) ...;",
  "meta": {
    "id": "seed_001",
    "source": "seed",
    "license": "self-authored",
    "db_id": "warehouse",
    "theme": "时间口径",
    "sql_template": "AGG_WHERE",
    "difficulty": {"joins": 0, "aggs": 1, "conds": 2},
    "level": "easy",
    "split": "train",
    "tokens": 412
  }
}
```

**关键点**

- `input` 里必须带表结构，训练/评测/线上三处统一由 `common/schema.py::build_input()` 构造，禁止各写一份。
- SFT 只对 `output` 算 loss，`instruction` + `input` 被 mask（由 LLaMA-Factory `train_on_prompt: false` 保证）。
- `meta` 不参与训练，仅用于分层、去重校验、质检与错误归因。
- `eval.jsonl` **12/31 冻结**，配套 `eval.jsonl.sha256`。`build_sft.py` 检测到校验和存在时拒绝覆盖，除非显式 `--force`。
- 评测集按 `level × theme × sql_template` 分层抽取，且与训练集做精确哈希 + MinHash 近似去重校验。
