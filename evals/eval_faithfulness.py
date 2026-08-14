"""
Faithfulness scoring for Co's outbound reply-generation calls.

Pulls real generateText traces from Langfuse (already instrumented via
experimental_telemetry across api/ and co-test/), scores each with Ragas
against the exact prompt Co was given, and writes the scores back onto the
same Langfuse trace.

Usage:
    python evals/eval_faithfulness.py [--limit 20] [--name <functionId>]

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
from common import get_langfuse, get_judge_llm, extract_text, fetch_reply_candidates
from ragas.metrics.collections import Faithfulness


async def score_one(metric, langfuse, obs):
    prompt = extract_text(obs.input)
    response = extract_text(obs.output)
    if not prompt or not response:
        return None

    result = await metric.ascore(
        user_input=prompt,
        response=response,
        retrieved_contexts=[prompt],
    )

    langfuse.create_score(
        name="ragas_faithfulness",
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
    metric = Faithfulness(llm=llm)

    candidates = fetch_reply_candidates(langfuse, limit, name_filter)

    if not candidates:
        print("No matching generation traces found — check LANGFUSE_* env vars, that the "
              "reply functionIds in REPLY_FUNCTION_IDS have recent traffic, and that --limit "
              "is large enough to reach them in the fetched page.")
        return

    scored = 0
    total = 0.0
    for obs in candidates:
        score = await score_one(metric, langfuse, obs)
        if score is not None:
            scored += 1
            total += score
            print(f"{obs.name}  {obs.id}  faithfulness={score:.2f}")

    if scored:
        print(f"\n{scored} traces scored. Average faithfulness: {total / scored:.3f}")
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
