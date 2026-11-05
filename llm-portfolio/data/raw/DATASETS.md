# 公开数据集与许可证记录

> PLAN 要求：调研下载公开数据集时**记录 license**。下载前请先确认条款，只把数据放进 `data/raw/`，不要提交到公开仓库。

| 数据集 | 用途 | 规模 | License | 备注 |
|---|---|---|---|---|
| Spider | 跨库 Text-to-SQL | ~10k 条 / 200 库 | CC BY-SA 4.0 | Yale；需自行下载，SQL 为 SQLite 方言，最易接入 |
| CSpider | 中文 Text-to-SQL | ~9k 条 | CC BY-SA 4.0（沿用 Spider） | 中文问题 + 英文 schema，适合中文指令 |
| BIRD | 真实业务库 + 外部知识 | ~12.7k 条 | BIRD 官方 License（研究用途） | 带脏数据与外部知识，更贴近数仓，但口径需对齐 |
| 自建种子样本 | 数仓口径（本仓库 `seed_samples.jsonl`） | 50 条 | self-authored | 时间口径 / 分区 / 去重 / 指标定义，本项目自有 |

## 接入方式

把下载后的数据整理成 `data/raw/<name>.jsonl`，字段见 `data/SCHEMA.md`。
`pipeline/clean.py` 会自动识别 Spider 风格字段（`query` → `sql`）并统一 schema。

## 注意

- **评测集只用自建种子样本 + 本项目独立标注**，不与公开训练语料混用，避免数据泄漏争议。
- 公开数据集的 schema 与本项目 `warehouse.db` 不一致时，gold SQL 无法在测试库执行，会被 `clean.py` 的「可执行性校验」丢弃；保留其 `question` 用于数据增强需另行改写 SQL。
- 12/31 冻结评测集后，新增语料只能进训练集。
