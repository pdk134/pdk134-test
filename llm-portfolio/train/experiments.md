# 对比实验记录（PLAN 1/15–1/28）

**铁律**：三组实验必须跑**同一个冻结的 `data/eval.jsonl`**，评测命令除模型地址外完全一致。
任何一组改了评测集，对比表作废。

| 组 | 变量 | 训练集 | 命令 |
|---|---|---|---|
| base | 未微调基座 | — | `python eval/run_eval.py --name base --generator api --model Qwen/Qwen2.5-7B-Instruct` |
| v1 | 全量数据，`r=16` / `alpha=32` / 3 epoch / lr 1e-4 | `data/train.jsonl` | `python train/train.py --name v1` 后评测 |
| v2 | 均衡采样训练集，`r=16` / 2 epoch / lr 1e-4 | `data/processed/sample_balanced.jsonl` | `python pipeline/sample.py --target 800 --out data/processed/sample_balanced.jsonl` → `build_sft.py --in ... --force` ⚠️重建评测集会让对比作废，正确做法是只换训练集 |

> ⚠️ 第 3 组「全量 vs 均衡采样」应**只换训练集、不重建评测集**。
> 正确操作：先冻结评测集，再用 `pipeline/sample.py` 生成不同训练集，
> 用 `train/train.py --name v2` 分别训练，评测始终指向同一个 `eval.jsonl`。

| 组 | 变量 | 命令 |
|---|---|---|
| v3 | `r=8` vs `r=16` | `python train/train.py --name v3 --rank 8` |
| v4 | epoch / lr | `python train/train.py --name v4 --epochs 2 --lr 5e-5` |

每组跑完执行：

```bash
python eval/run_eval.py --name <组名> --generator api --model <服务里的模型名>
python eval/run_eval.py --compare        # 汇总所有结果生成对比表
```

`train/train.py` 会自动在 `outputs/<组名>/experiment.json` 记录超参快照，
对比表会读取它，避免「分数和参数对不上」。
