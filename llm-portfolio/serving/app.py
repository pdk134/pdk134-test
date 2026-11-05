"""FastAPI 服务：/（工作台） /sql /rag /evaluate /health /docs（API 文档）

启动：
  uvicorn serving.app:app --port 8000
  配置见 .env（DEEPSEEK_API_KEY 或 LLM_API_BASE / LLM_API_KEY / LLM_MODEL）。

注意 /sql 的 execute 只用于本地调试，生产环境必须关闭，避免任意 SQL 执行。
"""
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from common.generator import APIGenerator  # noqa: E402
from common.paths import DB_PATH, EVAL_HASH, EVAL_JSONL, EVAL_RESULTS, RAG_INDEX, REPORT_MD  # noqa: E402
from common.schema import INSTRUCTION, build_input  # noqa: E402
from serving.schemas import (EvaluateItem, EvaluateResponse, HealthResponse,  # noqa: E402
                             RAGRequest, RAGResponse, SQLRequest, SQLResponse)

app = FastAPI(title='数据开发助手', version='0.1.0',
              description='LoRA-SFT + RAG 的 Text-to-SQL 与指标口径问答系统')

WEB_DIR = Path(__file__).with_name('web')
app.mount('/static', StaticFiles(directory=str(WEB_DIR)), name='static')


@app.get('/', include_in_schema=False)
def index():
    """面向用户的工作台首页（Swagger 仍在 /docs）。"""
    return FileResponse(WEB_DIR / 'index.html')


def generator():
    return APIGenerator()


def _rows_to_list(rows):
    return [list(r) for r in rows]


@app.get('/health', response_model=HealthResponse)
def health():
    frozen = EVAL_JSONL.exists() and EVAL_HASH.exists()
    return HealthResponse(
        status='ok',
        db_exists=DB_PATH.exists(),
        eval_frozen=frozen,
        rag_index=(RAG_INDEX / 'meta.json').exists(),
        generator=generator().model,
        note='db 缺失时先跑 python scripts/init_db.py；索引缺失时先跑 python rag/ingest.py'
    )


@app.post('/sql', response_model=SQLResponse)
def text_to_sql(req: SQLRequest):
    inp = build_input(req.question, context=req.context)
    try:
        sql = generator().generate(INSTRUCTION, inp)
    except Exception as e:
        return SQLResponse(sql='', generator='api', error=f'模型调用失败: {e}')
    if not sql:
        return SQLResponse(sql='', generator='api', error='模型未返回 SQL')
    out = SQLResponse(sql=sql, generator=generator().name)
    if req.execute:
        if not DB_PATH.exists():
            out.error = '测试库不存在，先跑 python scripts/init_db.py'
            return out
        try:
            conn = sqlite3.connect(str(DB_PATH))
            try:
                cur = conn.execute(sql)
                out.columns = [d[0] for d in cur.description] if cur.description else []
                rows = cur.fetchmany(50)
            finally:
                conn.close()
            out.executed = True
            out.rows = _rows_to_list(rows)
        except Exception as e:
            out.error = 'SQL 执行失败: ' + str(e)
    return out


@app.post('/rag', response_model=RAGResponse)
def rag_answer(req: RAGRequest):
    try:
        from rag.retriever import Retriever, build_rag_prompt
        retriever = Retriever()
    except Exception as e:
        raise HTTPException(503, f'RAG 索引不可用，先跑 python rag/ingest.py：{e}')

    built = build_rag_prompt(retriever, req.question, req.k)
    prompt = built['instruction'] + '\n\n' + built['context'] + '\n\n### 问题\n' + req.question
    try:
        gen = generator()
        answer = gen.answer(built['instruction'], built['context'], req.question)
        return RAGResponse(answer=answer, generator=gen.name,
                           citations=built['hits'],
                           prompt=prompt if req.show_prompt else None)
    except Exception as e:
        # 不假装成 RAG：明确返回失败并附上拼好的 Prompt 供排查
        return RAGResponse(
            answer='',
            generator='none',
            citations=built['hits'],
            prompt=prompt,
            note=f'LLM 未就绪，未生成答案（RAG 要求把检索内容塞进 Prompt 并由模型生成）：{e}'
        )


@app.get('/evaluate', response_model=EvaluateResponse)
def evaluate():
    items = []
    for f in sorted(EVAL_RESULTS.glob('*.json')):
        try:
            r = json.loads(f.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            continue
        m = r.get('metrics', {})
        items.append(EvaluateItem(
            name=r.get('name', f.stem), generator=r.get('generator', ''),
            official=bool(r.get('official')),
            result_accuracy=m.get('result_accuracy', 0),
            execution_success=m.get('execution_success', 0),
            exact_match=m.get('exact_match', 0),
            eval_size=r.get('eval_size', 0)
        ))
    report = REPORT_MD.read_text(encoding='utf-8') if REPORT_MD.exists() else None
    return EvaluateResponse(items=items, report_md=report)
