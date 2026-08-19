"""
Answer relevancy scoring for Co's outbound reply-generation calls.

Complements eval_faithfulness.py: faithfulness checks whether a reply is
grounded in what it was given (not hallucinating), this checks whether a
reply actually addresses what the user said — a reply can be perfectly
grounded and still miss the point. Same candidate set, same
Langfuse-write-back pattern.

Confirmed against a real trace: this metric runs low (~0.2) on replies that
are genuinely good but conversational rather than Q&A-shaped — it works by
reverse-engineering questions from the response and comparing them to the
original message via embedding similarity, so a reply that asks its own
follow-up question back (Co's normal style) scores worse than a reply that
just directly answers, even when the follow-up is the better reply. Read a
low score here alongside the actual reply text before treating it as a real
quality signal — it isn't as trustworthy as faithfulness for Co's
conversational tone.

Usage:
    python evals/eval_answer_relevancy.py [--limit 20] [--name <functionId>]

Setup:
    cd evals
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    # export LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY / LANGFUSE_BASE_URL / OPENAI_API_KEY
"""
import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))
from common import get_langfuse, get_judge_llm, get_judge_embeddings, extract_text, fetch_reply_candidates
from ragas.metrics.collections import AnswerRelevancy


async def score_one(metric, langfuse, obs):
    prompt = extract_text(obs.input)
    response = extract_text(obs.output)
    if not prompt or not response:
        return None

    result = await metric.ascore(user_input=prompt, response=response)

    langfuse.create_score(
        name="ragas_answer_relevancy",
        value=result.value,
        trace_id=obs.trace_id,
        observation_id=obs.id,
        data_type="NUMERIC",
        comment=getattr(result, "reason", None),
    )
    return result.value


async def main(limit: int, name_filter):
    load_dotenv()
    langfuse = get_langfuse()
    llm = get_judge_llm()
    embeddings = get_judge_embeddings()
    metric = AnswerRelevancy(llm=llm, embeddings=embeddings)

    candidates = fetch_reply_candidates(langfuse, limit, name_filter)

    if not candidates:
        print("No matching generation traces found — check LANGFUSE_* env vars, that the "
              "reply functionIds in common.REPLY_FUNCTION_IDS have recent traffic, and that "
              "--limit is large enough to reach them in the fetched page.")
        return

    scored = 0
    total = 0.0
    for obs in candidates:
        score = await score_one(metric, langfuse, obs)
        if score is not None:
            scored += 1
            total += score
            print(f"{obs.name}  {obs.id}  answer_relevancy={score:.2f}")

    if scored:
        print(f"\n{scored} traces scored. Average answer relevancy: {total / scored:.3f}")
    else:
        print("Matching traces were found but none had both a prompt and a response to score.")

    # create_score queues client-side and sends async — without flushing before
    # exit, scores are silently dropped and never reach the Langfuse backend.
    langfuse.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=20, help="Max traces to score")
    parser.add_argument("--name", type=str, default=None, help="Score only this one functionId instead of the full list")
    args = parser.parse_args()
    asyncio.run(main(args.limit, args.name))
