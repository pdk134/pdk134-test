"""共享工具：路径 / IO / SQL 归一化 / SFT schema / 模型生成接口。"""
from common.env import load_env

# 任何入口（uvicorn / run_eval / smoke_test）导入 common.* 时都会自动读 .env
load_env()
