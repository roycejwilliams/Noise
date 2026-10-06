// Import this first in any eval that makes real model calls (layer 2). Without the meter a real call has no cap, no model
// policy and no cost line, so the script refuses to start:
//
//   npm run eval:live -- evals/<suite>/<file>.ts [args]     one script, metered
//   npm run evals:nightly                                    the sampled nightly set
if (!(globalThis as { __EVAL_METER__?: boolean }).__EVAL_METER__) {
  console.error(
    "\nThis eval makes REAL model calls, so it must run through the meter (Haiku only, a hard token cap, and the cost printed):\n\n" +
      "  npm run eval:live -- " + (process.argv[1] ?? "evals/<suite>/<file>.ts").replace(/^.*\/api\//, "") + "\n",
  );
  process.exit(2);
}
export {};
