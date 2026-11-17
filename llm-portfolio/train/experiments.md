# 对比实验记录（PLAN 1/15–1/28）

**铁律**：三组实验必须跑**同一个冻结的 `data/eval.jsonl`**，评测命令除模型地址外完全一致。
任何一组改了评测集，对比表作废。

## 0. 前置条件（照抄命令前先看）

`--generator api` **不会自己加载模型**，它只是调一个 OpenAI 兼容的 HTTP 服务。
没有 7B 推理服务（GPU + vLLM）时，`base` 这一组跑不了，这不是代码问题。

### 起基座服务

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct --served-model-name Qwen/Qwen2.5-7B-Instruct --port 8001
```

- `8001` 是模型服务预留端口；`8000` 是本项目 FastAPI，别撞。
- `--model` 是**服务里注册的模型名**，不是 HuggingFace 路径；只有服务端用 `--served-model-name` 注册了同名模型，这个名字才有效。
- `--generator vllm` 默认连 `http://127.0.0.1:8000/v1`（`common/generator.py` 的 `VLLM_API_BASE`），会和 FastAPI 冲突，故本文档统一用 `--generator api` + 显式 `--api-base`。

### 别让 `DEEPSEEK_API_KEY` 改写端点

`APIGenerator` 有条便捷规则：检测到 `DEEPSEEK_API_KEY`、且没设 `LLM_API_KEY`、也没传 `--api-key` 时，自动把 base 切到 `https://api.deepseek.com/v1`；**但它不会同步改 `--model`**，于是出现「DeepSeek 端点 + Qwen 模型名」→ HTTP 400。显式传 `--api-key` 即可压掉这条规则（或在新终端里干脆别设 key）：

```bash
python eval/run_eval.py --name base --generator api --api-base http://127.0.0.1:8001/v1 --api-key EMPTY --model Qwen/Qwen2.5-7B-Instruct
```

> PowerShell 的 `$env:DEEPSEEK_API_KEY=...` 只在当前窗口有效，换窗口要重设；也别把它写进全局环境变量再跑正式实验。

### 联调结果不算正式实验

`run_eval.py` 里 `official = gen.name != 'debug_gold'`，**只看生成器名字，不看模型是不是 7B 基座**。用 `deepseek-chat` 或任何非 7B 模型跑出的结果会被标 `official=true`、写进 `eval/results/<name>.json`，并被 `--compare` 纳入对比表，导致 base 基线失真、对比表作废。

只想验证 API 链路是否通时：

```bash
python eval/run_eval.py --name debug_api --generator api --model deepseek-chat --limit 3
del eval\results\debug_api.json
```

要点：用 `debug_api` 之类的临时名 + `--limit 3` + **跑完删结果文件**，绝不叫 `--name base`。失败不会污染项目——`run_one()` 抛异常时尚未写文件，`eval/results/` 只会保留已有的结果。

### 当前状态（2026-11-07）

本机无 GPU（`nvidia-smi` 不可用）、8001/8000 无服务、未设 `LLM_API_BASE`；`eval/results/` 只有 `smoke.json`（`debug_gold` / `official=false`），`report.md` 仍是占位。**base / v1 / v2 三组均未开始**，冻结评测集 sha256 `d34342d8f12e…`。

### 已知限制

`pipeline/build_sft.py` 目前会同时写 `train.jsonl` 和 `eval.jsonl`，**没有「只重建训练集」的开关**。所以 v2 那行的 `--force` 不可照抄：它会重建评测集、让此前对比数字作废。需给脚本补 `--train-only`（或另行生成 `train.jsonl`）后，v2 流程才可执行。

| 组 | 变量 | 训练集 | 命令 |
|---|---|---|---|
| base | 未微调基座 | — | `python eval/run_eval.py --name base --generator api --api-base http://127.0.0.1:8001/v1 --api-key EMPTY --model Qwen/Qwen2.5-7B-Instruct`（需先起 vLLM，见第 0 节） |
| v1 | 全量数据，`r=16` / `alpha=32` / 3 epoch / lr 1e-4 | `data/train.jsonl` | `python train/train.py --name v1` 后评测 |
| v2 | 均衡采样训练集，`r=16` / 2 epoch / lr 1e-4 | `data/processed/sample_balanced.jsonl` | `python pipeline/sample.py --target 800 --out data/processed/sample_balanced.jsonl` → 生成新 `train.jsonl`；⚠️ **不要** `build_sft.py --force`，见第 0 节「已知限制」 |

> ⚠️ 第 3 组「全量 vs 均衡采样」应**只换训练集、不重建评测集**。
> 正确操作：先冻结评测集，再用 `pipeline/sample.py` 生成不同训练集，
> 用 `train/train.py --name v2` 分别训练，评测始终指向同一个 `eval.jsonl`。

| 组 | 变量 | 命令 |
|---|---|---|
| v3 | `r=8` vs `r=16` | `python train/train.py --name v3 --rank 8` |
| v4 | epoch / lr | `python train/train.py --name v4 --epochs 2 --lr 5e-5` |

每组跑完执行：

```bash
python eval/run_eval.py --name <组名> --generator api --api-base http://127.0.0.1:8001/v1 --api-key EMPTY --model <服务里的模型名>
python eval/run_eval.py --compare        # 汇总所有结果生成对比表
```

`train/train.py` 会自动在 `outputs/<组名>/experiment.json` 记录超参快照，
对比表会读取它，避免「分数和参数对不上」。
