# Tests: two layers

Co's tests are split by what they cost.

| | Layer 1: logic tests | Layer 2: live evals |
|---|---|---|
| What | Routing, parsing, state, guards, prompts' shape, who may be contacted | Does the real model still do the right thing |
| Model | **Fully stubbed. No real call, ever.** | Real calls, **Haiku for everything**, **Sonnet only to grade** |
| Cost | **$0, zero tokens** | A few cents to ~$0.25 a run, capped |
| When | Every change, every push, every PR (`npm test`) | Nightly, or when you ask. Never on a commit |
| List | `evals/layer1.json` | `evals/live.json` |
| Runner | `evals/runLayer1.mjs` | `evals/runLayer2.mjs` (the set), `evals/runLive.mjs` (one script) |

## Layer 1: `npm test`

Typechecks, then runs every file in `evals/layer1.json` under `evals/lib/modelGuard.mjs`. The guard answers a model call with a canned
one-word stub (a zero vector for embeddings) and **refuses every other outside call**. A test that needs a model's answer must inject
its own fake (see `setJevGatewayForTests`); it must not depend on the stub. The summary line says how many calls were stubbed and
by which tests, so a test leaning on the stub is visible.

To add a logic test: write the file, add it to `evals/layer1.json`.

## Layer 2: `npm run evals:nightly`

Runs the suites in `evals/live.json`, a small sample of each (`sample`), the highest-signal cases first: the ones that missed
in the last recorded run, then an even spread (`sampleCases` in `evals/lib.ts`). Under `evals/lib/meter.mjs`:

- **Haiku for everything.** Every request is rewritten to Haiku (Sonnet and Opus ids included).
- **Sonnet only to grade.** A grading call sets `headers: GRADER_HEADERS` (`src/models.ts`); that, and nothing else, runs as Sonnet.
- **A hard cap per run**, in tokens and dollars (default 500,000 tokens / $1.00; `--cap-tokens`, `--cap-usd`). A call that could pass the
  cap is refused before it is made, so the run stops instead of overshooting.
- **The cost is printed at the end, every time**: `EVAL COST: $0.20 | 62 model calls ... | cap ...`.
- No web search tool, no voice, mail or other outside host.

A hard failure in layer 2 ran on Haiku, so it is a tripwire, not the production score. To confirm one the way production runs it:
`EVAL_REAL_MODELS=1 npm run eval:live -- evals/<suite>/<file>.ts` (workers on Sonnet, still capped and priced).

One script, metered (probes, replays, anything with real calls): `npm run eval:live -- evals/<suite>/<file>.ts [args]`.
Options: `--only router,intro`, `--sample 3`. Caps by env: `EVAL_TOKEN_CAP`, `EVAL_COST_CAP_USD`.

## Golden cases: `npm run evals:golden`

The required `golden` check on a PR into co-test replays committed recordings of the model's answers (`evals/golden/recordings`):
no key, no network, $0. Recording (`npm run evals:golden:record -- --only <case>`) and the live drift check (`evals:golden:live`, or
the `golden-live` job on a manual dispatch) are the only golden runs that call a model. See `evals/golden/README.md`.

## The rule that keeps it this way

Every script under `evals/` that is not in layer 1 must `import "…/lib/requireMeter.js"` first (or be a listed harness/data module in
`evals/lib/harness.json`), so it refuses to run unmetered. A script can reach a model through a service it imports, so this is
structural, not a text search. `evals/lib/rules.ts` (a layer 1 test) pins it, along with the meter's Haiku rewrite, the grader
exception, the cap, the cost line, that no commit-time job runs a live eval, and that the morning email stays off.
