"""API 请求/响应模型（兼容 pydantic v1 / v2，不用版本相关校验器）。"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SQLRequest(BaseModel):
    question: str = Field(..., description='自然语言问题，含业务口径')
    context: Optional[str] = Field(None, description='额外口径资料，会拼进 Prompt')
    execute: bool = Field(False, description='是否在测试库执行生成的 SQL（仅开发调试用）')


class SQLResponse(BaseModel):
    sql: str
    generator: str
    executed: bool = False
    rows: Optional[List[Any]] = None
    columns: Optional[List[str]] = None
    error: Optional[str] = None


class RAGRequest(BaseModel):
    question: str
    k: int = Field(3, ge=1, le=8)
    show_prompt: bool = Field(False, description='返回拼好的 Prompt，便于调试')


class RAGHit(BaseModel):
    rank: int
    score: float
    title: str
    source: str
    text: str


class RAGResponse(BaseModel):
    answer: str
    generator: str
    citations: List[RAGHit] = []
    prompt: Optional[str] = None
    note: Optional[str] = None


class EvaluateItem(BaseModel):
    name: str
    generator: str
    official: bool
    result_accuracy: float
    execution_success: float
    exact_match: float
    eval_size: int


class EvaluateResponse(BaseModel):
    items: List[EvaluateItem]
    report_md: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    db_exists: bool
    eval_frozen: bool
    rag_index: bool
    generator: str
    note: str = ''
