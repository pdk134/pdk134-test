"""轻量 .env 加载器（不引入额外依赖）。

优先级：真实环境变量 > .env 文件。也就是说你在终端 export 的值不会被文件覆盖，
方便临时换模型/换 key 测试。
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_env(path=None):
    """返回实际写入环境变量的条数。"""
    p = Path(path) if path else (ROOT / '.env')
    if not p.exists():
        return 0
    count = 0
    for line in p.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].strip()
        if '=' not in line:
            continue
        key, val = line.split('=', 1)
        key, val = key.strip(), val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        if key and key not in os.environ:
            os.environ[key] = val
            count += 1
    return count
