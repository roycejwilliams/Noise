"""Shared Langfuse + Ragas setup for the evals in this directory.

Judge model is OpenAI (not Claude) on purpose — grading a Claude-generated
response with a Claude judge is more prone to self-favoring bias than an
independent model family. OPENAI_API_KEY already exists in this stack for
embeddings.ts, so no new credential is introduced.
"""
import json
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


# functionIds considered "a reply Co sends to a user" — edit this list as new
# message-generation call sites are added. Shared by every eval that scores
# reply quality (faithfulness, answer relevancy, ...) so a new call site only
# needs to be added once. Classification/parsing generations (*.classify,
# *.parseTime, *.assess*) are deliberately excluded: they don't produce
# user-facing text, so these metrics don't apply the same way.
REPLY_FUNCTION_IDS = [
    "sendblue.generateReply",
    "sendblue.momentResponseAck",
    "co.postCallFollowUp",
    "co.sendMissedCallFollowUp",
    "co.createMomentForCircle",
    "server.autoApproveCircle.placementMessage",
    "server.autoApproveCircle.vcardMessage",
    "circleApproval.activateCircle.vcardMessage",
    "circleInvite.generateWarmCircleInviteMessage",
    "booking.confirmMoment",
    "co-test.webhooks.generateReply",
    "co-test.webhooks.postCallFollowUp",
    "co-test.webhooks.venueRequest.holdMessage",
    "co-test.webhooks.venueRequest.introMessage",
    "co-test.recommendation.generate",
]
# co.message.* and co.circleMessage.* are dynamic (functionId includes the
# message_type), so they're matched by prefix instead of exact name below.
REPLY_FUNCTION_ID_PREFIXES = [
    "co.message.",
    "co.circleMessage.",
]


def fetch_reply_candidates(langfuse, limit: int, name_filter: str | None = None):
    """Fetch recent GENERATION observations that are a reply Co sent to a user.

    name_filter, if given, scores only that one functionId instead of the
    full REPLY_FUNCTION_IDS list — same override every reply-quality eval
    script exposes via --name.
    """
    # fields defaults to "core,basic" if unspecified — input/output are their
    # own field group ("io") and come back None without it, silently (no
    # error), which looks identical to "this trace really has no prompt or
    # response" downstream.
    resp = langfuse.api.observations.get_many(type="GENERATION", limit=max(limit * 4, 100), fields="core,basic,io")
    return [
        obs for obs in resp.data
        if obs.name and (
            (name_filter and matches_function_id(obs.name, name_filter))
            or (not name_filter and (
                any(matches_function_id(obs.name, fid) for fid in REPLY_FUNCTION_IDS)
                or any(obs.name.startswith(p) for p in REPLY_FUNCTION_ID_PREFIXES)
            ))
        )
    ][:limit]


def extract_text(io_value) -> str:
    """Pull plain text out of a Langfuse observation's input/output.

    The AI SDK's own telemetry stores these as JSON — sometimes already
    parsed into a list/dict by the SDK, sometimes still a raw JSON string
    (observed directly: obs.input came back as a Python str containing
    '[{"role":"user","content":[{"type":"text","text":"..."}]}]', not a
    parsed object) — so a naive `isinstance(..., str): return as-is` silently
    returns the whole JSON envelope, escaped newlines and all, instead of the
    actual prompt text. Always try to parse and recurse into the real
    message-array shape before treating a string as plain text.
    """
    if io_value is None:
        return ""
    if isinstance(io_value, str):
        stripped = io_value.strip()
        if stripped[:1] in "[{":
            try:
                io_value = json.loads(io_value)
            except json.JSONDecodeError:
                return io_value
        else:
            return io_value
    if isinstance(io_value, list):
        return "\n".join(t for t in (extract_text(item) for item in io_value) if t)
    if isinstance(io_value, dict):
        if isinstance(io_value.get("text"), str):
            return io_value["text"]
        for key in ("prompt", "content"):
            if key in io_value:
                extracted = extract_text(io_value[key])
                if extracted:
                    return extracted
        return ""
    return str(io_value)
