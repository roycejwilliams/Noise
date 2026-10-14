# Golden cases: recorded once, replayed on every PR

Scripted member exchanges and discovery steps run through Co's real code path (`cases/*.ts`). The model's answers are recorded
once and committed under `recordings/`, so CI checks Co's code against them without calling a model.

Royce, 2026-10-14: "golden cases must not hit the live API on every CI run. Record real API responses once as committed fixtures
and have CI run the harness against the recordings. Live API runs only on a deliberate manual trigger."

| Command | What it does | Cost |
|---|---|---|
| `npm run evals:golden` | **Replay** (CI, the required `golden` check). Every model call is answered from `recordings/`. No key, no network. | $0 |
| `npm run evals:golden:record -- --only <case>` | **Record**. Real calls through the meter ($4 cap, cost printed). Rewrites the case's recordings. | ~$0.05 a case |
| `npm run evals:golden:record -- --missing` | Record only the cases whose replay misses: a new case, or one whose prompts changed. | the same, for those cases |
| `npm run evals:golden:live` | **Live**. Real calls, nothing written. A manual drift check (also the `golden-live` job: Actions, run workflow, tick `golden_live`). | ~$0.55 for all |

`--only` takes ids or numbers, comma-separated (`--only 1,status-check`).

Record and live need the real key, from the environment (no golden run reads `api/.env`). From `api/`, with only the keys passed
in, so no database or other co-test secret reaches the run (add `-p 769e31e2-f831-4ed9-a158-4536cc3556bc` outside the linked checkout):

```
railway run -s co-test -e 5cac359e-1dc3-411f-b4b1-9949610041d2 -- sh -c 'exec env -i PATH="$PATH" HOME="$HOME" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" OPENAI_API_KEY="$OPENAI_API_KEY" GOOGLE_PLACES_API_KEY=ci ELEVENLABS_API_KEY=ci npm run -s evals:golden:record -- --only <case>'
```

The required `golden` check can't go green without recordings: a case that makes a model call with none fails it. A PR author
without the key asks Royce (or someone with Railway access to co-test) to record the case, then commits the recordings.

## Adding a case

1. Write it in `cases/<file>.ts` (a new file works too: every file in `cases/` that exports `CASES` is run). Use the next free number and a
   unique id.
2. Record it: `npm run evals:golden:record -- --only <id>` (or `--missing` for every new case at once).
3. Replay it with no key: `npm run evals:golden -- --only <id>`. It must pass, three runs in a row.
4. Commit the case and its `recordings/<id>/` folder together.

## When to re-record

Re-record a case when its replay says `FAIL(no recording)`. That means the request changed: a prompt, a model id, a tool list, a
max_tokens, or the case itself. The failure names the call, shows where it first differs from the nearest recording, and gives the
command. Re-record after any intended change to a prompt or model, and commit the new recordings in the same PR. A recording that
replay no longer uses is listed as unused; re-recording that case drops it.

Recording a case that misses writes the miss: replay then fails the same way until the case is green and re-recorded. Read the
recorded answer (`recordings/<id>/*.json`, `responses[].text`) before committing it.

## How it works

`evals/lib/goldenReplay.mjs` is preloaded after the meter and wraps `fetch`, the one seam every model client here uses (the ai SDK,
the Anthropic and OpenAI clients).

- **Key.** A hash of the request as Co's code made it: host and path, the whole JSON body with keys sorted (model, system, messages,
  tools, max_tokens, temperature, thinking, effort...), the grader marker and any `anthropic-beta` header. `body.metadata` is left out.
- **Recording.** `recordings/<case-id>/<hash>.json`: the request (a readable summary plus the full body, for the miss diff), and each
  answer in order (text, usage, model, the raw body or stream events), with `recorded_at`.
- **Replay.** A call with a recording gets its answer. A call without one, or asked more times than it was recorded, throws and fails
  the run even if the code caught the error. Misses are counted for the whole run: one that lands after its case returned (a timer, a
  queue, a worker an earlier case started) or outside any case is caught when the runner settles before exiting, named with the case
  it was billed to.
  Replay never calls the network, for any host. The script also sets a placeholder key, a zero cap and no `.env`, so nothing can spend.
- **Same path in every mode.** Golden cases reach models and nothing else; any other host is refused in record, live and replay.
- **Pinned clock.** `Date` reads 2026-10-13T21:00:00Z (the incident day, 2pm in LA) and the zone is UTC, in every mode. A case
  that needs "now" gets it from `new Date()` or luxon and sees the same moment on every run. Don't read real time into a prompt.
- **Each call belongs to its case** (AsyncLocalStorage), including late or background calls, and a retried attempt replaces the
  earlier attempt's recordings.
- Replay is deterministic, so it never retries. Record and live keep the one retry for model variance (reported as flaky).
