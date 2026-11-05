"""集中管理路径，避免各脚本各写一份相对路径。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

DATA = ROOT / 'data'
RAW = DATA / 'raw'
PROCESSED = DATA / 'processed'
DB_PATH = DATA / 'warehouse.db'
SCHEMA_SQL = DATA / 'warehouse_schema.sql'
TRAIN_JSONL = DATA / 'train.jsonl'
EVAL_JSONL = DATA / 'eval.jsonl'
EVAL_HASH = DATA / 'eval.jsonl.sha256'

RAG_DOCS = ROOT / 'rag' / 'docs'
RAG_INDEX = ROOT / 'rag' / 'index'
EVAL_RESULTS = ROOT / 'eval' / 'results'
REPORT_MD = ROOT / 'eval' / 'report.md'

for _d in (PROCESSED, RAG_INDEX, EVAL_RESULTS):
    _d.mkdir(parents=True, exist_ok=True)
