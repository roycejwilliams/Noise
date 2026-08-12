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
from common import get_langfuse, get_judge_llm, extract_text, matches_function_id
from ragas.metrics.collections import Faithfulness

# functionIds considered "a reply Co sends to a user" — edit this list as new
# message-generation call sites are added. Classification/parsing generations
# (*.classify, *.parseTime, *.assess*) are deliberately excluded: they don't
# produce user-facing text, so faithfulness doesn't apply the same way.
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

    resp = langfuse.api.observations.get_many(type="GENERATION", limit=max(limit * 4, 100))
    candidates = [
        obs for obs in resp.data
        if obs.name and (
            (name_filter and matches_function_id(obs.name, name_filter))
            or (not name_filter and (
                any(matches_function_id(obs.name, fid) for fid in REPLY_FUNCTION_IDS)
                or any(obs.name.startswith(p) for p in REPLY_FUNCTION_ID_PREFIXES)
            ))
        )
    ][:limit]

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=20, help="Max traces to score")
    parser.add_argument("--name", type=str, default=None, help="Score only this one functionId instead of the full list")
    args = parser.parse_args()
    asyncio.run(main(args.limit, args.name))
