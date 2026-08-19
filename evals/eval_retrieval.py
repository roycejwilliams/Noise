"""
Retrieval-quality scoring for matching.ts's stated-ask filter
(filterByStatedAsk / fetchTopMemoryPerCandidate).

For each candidate line in a filterByStatedAsk trace, this asks Ragas'
reference-free Context Precision metric: given the stated ask, was what we
knew about this candidate (their profile facts + the one memory pulled by
embedding search) actually relevant context for the yes/no verdict Co reached?

This scores the whole "what got retrieved" step (structured profile fields +
fetchTopMemoryPerCandidate's embedding search), not the embedding search in
isolation — there's no separate trace of memory-only relevance to score
against.

Usage:
    python evals/eval_retrieval.py [--limit 10]
"""
import argparse
import asyncio
import json
import os
import re
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))
from common import get_langfuse, get_judge_llm, extract_text, matches_function_id
from ragas.metrics.collections import ContextPrecisionWithoutReference

FUNCTION_IDS = ["matching.filterByStatedAsk", "co-test.matching.filterByStatedAsk"]

ASK_RE = re.compile(r'match this: "(.*)"\n\nHere is what', re.S)
DIGEST_RE = re.compile(r'one per line:\n(.*)\n\nWhich candidate numbers', re.S)
LINE_RE = re.compile(r'^(\d+)\.\s(.*)$')


def parse_prompt(prompt: str):
    ask_match = ASK_RE.search(prompt)
    digest_match = DIGEST_RE.search(prompt)
    if not ask_match or not digest_match:
        return None, []
    ask_text = ask_match.group(1)
    lines = []
    for line in digest_match.group(1).splitlines():
        m = LINE_RE.match(line.strip())
        if m:
            lines.append((int(m.group(1)), m.group(2)))
    return ask_text, lines


def parse_response(raw: str):
    clean = re.sub(r"```json|```", "", raw).strip()
    try:
        parsed = json.loads(clean)
        indices = parsed.get("matching_indices", [])
        return set(i for i in indices if isinstance(i, int))
    except (json.JSONDecodeError, AttributeError):
        return set()


async def score_trace(metric, langfuse, obs):
    ask_text, lines = parse_prompt(extract_text(obs.input))
    matching = parse_response(extract_text(obs.output))
    if not ask_text or not lines:
        return []

    results = []
    for idx, context_line in lines:
        if context_line == "(nothing on file)":
            continue
        verdict = "Candidate satisfies the criteria." if idx in matching else "Candidate does not satisfy the criteria."
        result = await metric.ascore(
            user_input=ask_text,
            response=verdict,
            retrieved_contexts=[context_line],
        )
        langfuse.create_score(
            name="ragas_context_precision",
            value=result.value,
            trace_id=obs.trace_id,
            observation_id=obs.id,
            data_type="NUMERIC",
            comment=f"candidate {idx}: {getattr(result, 'reason', '') or ''}",
        )
        results.append(result.value)
    return results


async def main(limit: int):
    load_dotenv()
    langfuse = get_langfuse()
    llm = get_judge_llm()
    metric = ContextPrecisionWithoutReference(llm=llm)

    # fields defaults to "core,basic" if unspecified — input/output need the
    # "io" field group explicitly or come back None (see common.py's
    # fetch_reply_candidates for the same fix).
    resp = langfuse.api.observations.get_many(type="GENERATION", limit=max(limit * 4, 100), fields="core,basic,io")
    candidates = [
        obs for obs in resp.data
        if obs.name and any(matches_function_id(obs.name, fid) for fid in FUNCTION_IDS)
    ][:limit]

    if not candidates:
        print("No filterByStatedAsk traces found — check LANGFUSE_* env vars and that "
              "circles with a stated ask have actually run recently.")
        return

    all_scores = []
    for obs in candidates:
        scores = await score_trace(metric, langfuse, obs)
        all_scores.extend(scores)
        if scores:
            print(f"{obs.name}  {obs.id}  {len(scores)} candidates scored, avg={sum(scores)/len(scores):.2f}")

    if all_scores:
        print(f"\n{len(all_scores)} candidate judgments scored across {len(candidates)} traces. "
              f"Average context precision: {sum(all_scores)/len(all_scores):.3f}")
    else:
        print("Matching traces were found but none had a parseable prompt/response.")

    # create_score queues client-side and sends async — without flushing before
    # exit, scores are silently dropped and never reach the Langfuse backend.
    langfuse.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=10, help="Max filterByStatedAsk traces to score")
    args = parser.parse_args()
    asyncio.run(main(args.limit))
