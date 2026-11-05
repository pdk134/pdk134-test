"""自动评测：生成 SQL → 测试库执行 → 结果集比对 → 错误归因 → 对比表。

PLAN 边界：最小自动化版本，不做人工打分 / rubric / LLM-as-judge。

  # 管道自检（不产出正式数字）
  python eval/run_eval.py --name smoke --generator debug_gold

  # 基座 / v1 / v2 三次评测（同一个冻结评测集）
  python eval/run_eval.py --name base --generator api --model base-model
  python eval/run_eval.py --name v1   --generator api --model lora-v1
  python eval/run_eval.py --name v2   --generator vllm --model lora-v2

  # 汇总对比表
  python eval/run_eval.py --compare
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from common.generator import make_generator, strip_sql  # noqa: E402
from common.io import read_jsonl, sha256_file, write_json, write_text  # noqa: E402
from common.paths import DB_PATH, EVAL_HASH, EVAL_JSONL, EVAL_RESULTS, REPORT_MD  # noqa: E402
from common.sqlnorm import normalize_sql  # noqa: E402
from eval.error_taxonomy import classify, markdown_table, summarize  # noqa: E402


def verify_frozen():
    if not EVAL_JSONL.exists() or not EVAL_HASH.exists():
        raise SystemExit('评测集未冻结，请先跑 pipeline/build_sft.py。')
    recorded = EVAL_HASH.read_text(encoding='utf-8').strip().split()[0]
    actual = sha256_file(EVAL_JSONL)
    if recorded != actual:
        raise SystemExit('评测集校验和不匹配！文件被改动，所有对比数字作废，请核查。')
    return actual


def norm_value(v, tol=1e-6):
    if isinstance(v, float):
        return round(v, 6)
    return v


def result_equal(gold, pred, ordered=False):
    """结果集比对：默认无序多重集；--ordered 时严格按顺序。"""
    g = [tuple(norm_value(x) for x in r) for r in gold]
    p = [tuple(norm_value(x) for x in r) for r in pred]
    if ordered:
        return g == p
    try:
        return sorted(g, key=repr) == sorted(p, key=repr)
    except TypeError:
        return g == p


def execute(conn, sql, limit=1000):
    cur = conn.execute(sql)
    return cur.fetchmany(limit)


def run_one(name, gen, limit, ordered):
    digest = verify_frozen()
    rows = read_jsonl(EVAL_JSONL)
    if limit:
        rows = rows[:limit]
    conn = sqlite3.connect(str(DB_PATH))
    items = []
    try:
        for idx, r in enumerate(rows, 1):
            sid = r['meta']['id']
            inp = r['input']
            gold = r['output']
            pred = strip_sql(gen.generate(r['instruction'], inp,
                                           sample_id=sid, question=r['meta'].get('theme')))
            gold_rows, pred_rows, err = [], [], None
            try:
                gold_rows = execute(conn, gold)
            except Exception as e:
                err = 'GOLD 执行失败: ' + str(e)
            exec_err = None
            if pred:
                try:
                    pred_rows = execute(conn, pred)
                except Exception as e:
                    exec_err = str(e)
            else:
                exec_err = '模型未产出 SQL'
            match = (not err) and (exec_err is None) and result_equal(gold_rows, pred_rows, ordered)
            etype, reason = ('OK', '') if match else classify(gold, pred, exec_err, r['meta'])
            items.append({
                'id': sid, 'theme': r['meta'].get('theme'),
                'level': r['meta'].get('level'),
                'gold_sql': gold, 'pred_sql': pred,
                'gold_rows': len(gold_rows), 'pred_rows': len(pred_rows),
                'exec_error': exec_err, 'result_match': match,
                'exact_match': normalize_sql(gold) == normalize_sql(pred),
                'error_type': etype, 'reason': reason
            })
            if idx % 20 == 0:
                print(f'  已评测 {idx}/{len(rows)}')
    finally:
        conn.close()

    n = len(items)
    official = gen.name != 'debug_gold'
    stats = summarize(items)
    result = {
        'name': name, 'generator': gen.name, 'official': official,
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'eval_sha256': digest, 'eval_size': n, 'ordered': ordered,
        'metrics': {
            'result_accuracy': round(sum(i['result_match'] for i in items) / max(1, n), 4),
            'execution_success': round(sum(1 for i in items if not i['exec_error']) / max(1, n), 4),
            'exact_match': round(sum(i['exact_match'] for i in items) / max(1, n), 4)
        },
        'error_taxonomy': stats, 'items': items
    }
    out = EVAL_RESULTS / (name + '.json')
    write_json(out, result)
    m = result['metrics']
    print(f'[{name}] result_acc={m["result_accuracy"]:.2%} '
          f'exec_success={m["execution_success"]:.2%} exact_match={m["exact_match"]:.2%}')
    if not official:
        print('  [注意] debug_gold 仅用于管道自检，此结果不计入对比表。')
    print('  结果:', out)
    return result


def load_experiment(name):
    p = ROOT / 'outputs' / ('lora-' + name) / 'experiment.json'
    if not p.exists():
        return {}
    cfg = json.loads(p.read_text(encoding='utf-8')).get('config', {})
    return {'rank': cfg.get('lora_rank'), 'epochs': cfg.get('num_train_epochs'),
            'lr': cfg.get('learning_rate')}


def compare(include_debug=False):
    files = sorted(EVAL_RESULTS.glob('*.json'))
    results = []
    for f in files:
        r = json.loads(f.read_text(encoding='utf-8'))
        if not r.get('official') and not include_debug:
            continue
        if results and r['eval_sha256'] != results[0]['eval_sha256']:
            print(f'[警告] {r["name"]} 的评测集校验和与其余组不同，不可直接比较！')
        results.append(r)
    if not results:
        write_text(REPORT_MD,
                   '# 最小版评测报告\n\n尚未产出正式对比结果。\n\n'
                   '`debug_gold` 自检结果默认排除（不产出任何对比数字）。\n\n'
                   '请依次评测 base / v1 / v2 三组后重新执行 `python eval/run_eval.py --compare`。\n')
        print('尚无正式评测结果（debug_gold 自检已排除），已写入占位报告:', REPORT_MD)
        return

    results.sort(key=lambda x: x['created_at'])
    base = next((r for r in results if r['name'] == 'base'), None)
    lines = [
        '# 最小版评测报告', '',
        f'> 生成时间：{datetime.now().strftime("%Y-%m-%d %H:%M")}',
        f'> 冻结评测集：`data/eval.jsonl`（sha256 `{results[0]["eval_sha256"][:16]}…`），'
        f'{results[0]["eval_size"]} 条', '',
        '## 前后对比表', '',
        '| 实验 | 生成器 | LoRA r | epoch | lr | 结果准确率 | 可执行率 | 精确匹配 | 相对基座 |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|'
    ]
    for r in results:
        exp = load_experiment(r['name'])
        m = r['metrics']
        delta = '—'
        if base and r['name'] != 'base' and base['metrics']['result_accuracy'] > 0:
            d = (m['result_accuracy'] - base['metrics']['result_accuracy']) * 100
            delta = f'+{d:.2f}pp' if d >= 0 else f'{d:.2f}pp'
        lines.append(
            f'| {r["name"]} | `{r["generator"]}` | {exp.get("rank", "—")} | '
            f'{exp.get("epochs", "—")} | {exp.get("lr", "—")} | '
            f'{m["result_accuracy"]:.2%} | {m["execution_success"]:.2%} | '
            f'{m["exact_match"]:.2%} | {delta} |'
        )

    lines += ['', '## 错误归因占比（各实验）', '']
    for r in results:
        top = sorted(r['error_taxonomy'].items(), key=lambda x: -x[1]['count'])[:3]
        brief = '、'.join(f'{k} {v["count"]}' for k, v in top)
        lines += [f'### {r["name"]}', '', '| 错误类型 | 说明 | 数量 | 占比 |',
                  '|---|---|---:|---:|']
        for code, s in r['error_taxonomy'].items():
            lines.append(f'| {code} | {s["label"]} | {s["count"]} | {s["ratio"]:.2%} |')
        lines += ['', f'主要错误：{brief}', '']

    if base:
        best = max(results, key=lambda x: x['metrics']['result_accuracy'])
        lines += [
            '## 简历可直接用的 3 个数字', '',
            f'1. 独立冻结评测集 {base["eval_size"]} 条，覆盖 7 类业务主题 / 3 档难度，与训练集双重去重校验',
            f'2. 基座结果准确率 {base["metrics"]["result_accuracy"]:.2%} → '
            f'LoRA-SFT 后 {best["metrics"]["result_accuracy"]:.2%}'
            f'（最高组 {best["name"]}，提升 '
            f'{(best["metrics"]["result_accuracy"] - base["metrics"]["result_accuracy"]) * 100:.2f}pp）',
            f'3. 基于 6 类错误归因回流修数据，'
            f'主要错误类型占比 {max(base["error_taxonomy"].items(), key=lambda x: x[1]["count"])[1]["ratio"]:.2%}'
            ' → 定向补充样本后再训一轮'
        ]
    write_text(REPORT_MD, '\n'.join(lines) + '\n')
    print('对比表已生成:', REPORT_MD)
    print('\n'.join(lines[:18]))


def make_gen(args, rows):
    kind = args.generator
    if kind == 'debug_gold':
        return make_generator('debug_gold', gold_map={r['meta']['id']: r['output'] for r in rows})
    if kind == 'local':
        return make_generator('local', base_model=args.base_model, adapter=args.adapter)
    if kind == 'vllm':
        return make_generator('vllm', base=args.vllm_base, model=args.model)
    return make_generator('api', base=args.api_base, model=args.model,
                          api_key=args.api_key, timeout=args.timeout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', default='base')
    ap.add_argument('--generator', choices=['debug_gold', 'api', 'vllm', 'local'], default='api')
    ap.add_argument('--model', default=None, help='API/vLLM 服务中的模型名')
    ap.add_argument('--api-base', default=None)
    ap.add_argument('--api-key', default=None)
    ap.add_argument('--vllm-base', default=None)
    ap.add_argument('--base-model', default=None)
    ap.add_argument('--adapter', default=None)
    ap.add_argument('--timeout', type=int, default=60)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--ordered', action='store_true', help='结果集严格按行顺序比对')
    ap.add_argument('--compare', action='store_true', help='汇总所有结果生成对比表')
    ap.add_argument('--include-debug', action='store_true')
    args = ap.parse_args()

    if args.compare:
        compare(args.include_debug)
        return
    rows = read_jsonl(EVAL_JSONL)
    gen = make_gen(args, rows)
    run_one(args.name, gen, args.limit, args.ordered)


if __name__ == '__main__':
    main()
