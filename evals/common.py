"""Shared Langfuse + Ragas setup for the evals in this directory.

Judge model is OpenAI (not Claude) on purpose — grading a Claude-generated
response with a Claude judge is more prone to self-favoring bias than an
independent model family. OPENAI_API_KEY already exists in this stack for
embeddings.ts, so no new credential is introduced.
"""
import os
from openai import AsyncOpenAI
from ragas.llms.base import llm_factory
from ragas.embeddings.base import embedding_factory
from langfuse import Langfuse

JUDGE_MODEL = os.environ.get("RAGAS_JUDGE_MODEL", "gpt-4o-mini")


def get_langfuse() -> Langfuse:
    return Langfuse(
        public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
        secret_key=os.environ["LANGFUSE_SECRET_KEY"],
        host=os.environ.get("LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com"),
    )


def get_judge_llm():
    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return llm_factory(JUDGE_MODEL, client=client)


def get_judge_embeddings():
    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return embedding_factory("openai", model="text-embedding-3-small", client=client)


def matches_function_id(obs_name: str, function_id: str) -> bool:
    """True if a Langfuse observation's name was produced by this functionId.

    LangfuseSpanProcessor names AI SDK generations
    "{functionId}:ai.generateText.doGenerate" (confirmed empirically against a
    real trace, e.g. "selfaudit.smokeTest:ai.generateText.doGenerate") rather
    than the bare functionId, so an exact-equality check silently matches
    nothing against real traffic.
    """
    if obs_name is None:
        return False
    return obs_name == function_id or obs_name.startswith(function_id + ":")


def extract_text(io_value) -> str:
    if io_value is None:
        return ""
    if isinstance(io_value, str):
        return io_value
    if isinstance(io_value, dict):
        for key in ("text", "prompt", "content"):
            if key in io_value and isinstance(io_value[key], str):
                return io_value[key]
        return str(io_value)
    return str(io_value)
