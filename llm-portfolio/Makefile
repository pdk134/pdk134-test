.PHONY: help init pipeline smoke train-eval rag serve test clean frozen

help:
	@echo "make init      构建 SQLite 测试库"
	@echo "make pipeline  跑完整数据流水线（清洗→去重→采样→冻结）"
	@echo "make smoke     全流程自检（无需 GPU / 网络）"
	@echo "make rag       重建 RAG 索引"
	@echo "make serve     启动 FastAPI"
	@echo "make test      跑 pytest"
	@echo "make frozen    校验冻结评测集完整性"

init:
	python scripts/init_db.py

pipeline:
	python pipeline/clean.py
	python pipeline/dedup.py
	python pipeline/sample.py --target 1200
	python pipeline/build_sft.py --eval-size 200

smoke:
	python scripts/smoke_test.py

rag:
	python rag/ingest.py

serve:
	uvicorn serving.app:app --port 8000

test:
	python -m pytest -q

frozen:
	python -c "from common.io import sha256_file; from common.paths import EVAL_JSONL,EVAL_HASH; a=sha256_file(EVAL_JSONL); b=EVAL_HASH.read_text().split()[0]; print('OK 冻结有效', a[:12]) if a==b else exit('ERROR 校验和不匹配')"

clean:
	@echo "仅清理中间产物，不会动 data/raw / eval.jsonl / eval.jsonl.sha256"
	python -c "import shutil,pathlib; [shutil.rmtree(p,ignore_errors=True) for p in [pathlib.Path('data/processed')]]"
