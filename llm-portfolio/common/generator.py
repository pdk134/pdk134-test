"""统一的 SQL 生成接口。

评测、/sql、/rag 都通过它拿模型输出，切换「基座 / v1 / v2」只需换生成器配置，
不改动评测逻辑，保证对比实验公平。

  debug_gold  仅用于评测脚本自检（直接返回 gold SQL），**禁止用于产出任何对比数字**
  api         OpenAI 兼容 /chat/completions（可指向本地 vLLM / 云端）
  local       transformers + PEFT 加载 LoRA adapter
"""
import os
import re


class SQLGenerator:
    name = 'base'

    def generate(self, instruction, input_text, sample_id=None, question=None):
        raise NotImplementedError


def strip_sql(text):
    """从模型输出里剥出 SQL：去 markdown 围栏、取第一条语句。"""
    if not text:
        return ''
    s = re.sub(r'```(?:sql)?', '', text, flags=re.I).replace('```', '').strip()
    s = re.sub(r'^(sql\s*:)', '', s, flags=re.I).strip()
    parts = [p.strip() for p in s.split(';') if p.strip()]
    return (parts[0] + ';') if parts else ''


class DebugGoldGenerator(SQLGenerator):
    """⚠️ 只用于 run_eval.py 的管道自检，不用于任何正式实验数字。"""

    name = 'debug_gold'

    def __init__(self, gold_map):
        self.gold_map = gold_map

    def generate(self, instruction, input_text, sample_id=None, question=None):
        return self.gold_map.get(sample_id, '')


DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
DEEPSEEK_MODEL = 'deepseek-chat'


class APIGenerator(SQLGenerator):
    """OpenAI 兼容接口；环境变量 LLM_API_BASE / LLM_API_KEY / LLM_MODEL。

    便捷规则：只设了 DEEPSEEK_API_KEY（且没设 LLM_API_KEY）时，
    自动使用 DeepSeek 的 base / model，不用再配另外两个变量。
    """

    def __init__(self, base=None, api_key=None, model=None, timeout=60, temperature=0.0):
        # 8001 是给 vLLM / 模型服务留的；8000 是本项目的 FastAPI，别撞端口
        deepseek_key = os.getenv('DEEPSEEK_API_KEY') or ''
        use_deepseek = bool(deepseek_key) and not os.getenv('LLM_API_KEY') and not api_key
        self.base = (base or os.getenv('LLM_API_BASE')
                     or (DEEPSEEK_BASE if use_deepseek else 'http://127.0.0.1:8001/v1')).rstrip('/')
        self.api_key = (api_key or os.getenv('LLM_API_KEY')
                        or (deepseek_key if use_deepseek else 'EMPTY'))
        self.model = model or os.getenv('LLM_MODEL') or (DEEPSEEK_MODEL if use_deepseek else 'base-model')
        self.timeout = timeout
        self.temperature = temperature
        self.name = 'api:' + self.model

    def _chat(self, messages, max_tokens=512):
        import requests
        r = requests.post(
            self.base + '/chat/completions',
            headers={'Authorization': 'Bearer ' + self.api_key,
                     'Content-Type': 'application/json'},
            json={'model': self.model, 'messages': messages,
                  'temperature': self.temperature, 'max_tokens': max_tokens},
            timeout=self.timeout
        )
        r.raise_for_status()
        return r.json()['choices'][0]['message']['content']

    def generate(self, instruction, input_text, sample_id=None, question=None):
        content = self._chat([
            {'role': 'system', 'content': instruction},
            {'role': 'user', 'content': input_text}
        ])
        return strip_sql(content)

    def answer(self, instruction, context, question):
        """RAG 用：把检索到的内容拼进 Prompt 再让模型生成答案。"""
        return self._chat([
            {'role': 'system', 'content': instruction},
            {'role': 'user', 'content': context + '\n\n### 问题\n' + question}
        ], max_tokens=512)


class LocalLoRAGenerator(SQLGenerator):
    """本地加载 base + LoRA adapter（GPU；训练完成后用）。"""

    def __init__(self, base_model, adapter=None, max_new_tokens=512):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from peft import PeftModel
        import torch
        self.tok = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            base_model, torch_dtype=torch.bfloat16, device_map='auto',
            trust_remote_code=True
        )
        if adapter:
            model = PeftModel.from_pretrained(model, adapter)
        model.eval()
        self.model = model
        self.max_new_tokens = max_new_tokens
        self.name = 'local:' + (adapter or base_model)

    def generate(self, instruction, input_text, sample_id=None, question=None):
        import torch
        prompt = instruction + '\n\n' + input_text + '\n\n### SQL\n'
        ids = self.tok(prompt, return_tensors='pt').to(self.model.device)
        with torch.no_grad():
            out = self.model.generate(**ids, max_new_tokens=self.max_new_tokens,
                                     do_sample=False, pad_token_id=self.tok.eos_token_id)
        text = self.tok.decode(out[0][ids['input_ids'].shape[1]:], skip_special_tokens=True)
        return strip_sql(text)


def make_generator(kind, **kwargs):
    kind = (kind or 'api').lower()
    if kind == 'debug_gold':
        return DebugGoldGenerator(kwargs['gold_map'])
    if kind == 'api':
        return APIGenerator(**kwargs)
    if kind == 'local':
        return LocalLoRAGenerator(kwargs['base_model'], kwargs.get('adapter'))
    if kind == 'vllm':
        return APIGenerator(
            base=kwargs.get('base', os.getenv('VLLM_API_BASE', 'http://127.0.0.1:8000/v1')),
            model=kwargs.get('model') or os.getenv('VLLM_MODEL', 'lora-v1')
        )
    raise ValueError('未知生成器类型: ' + kind)
