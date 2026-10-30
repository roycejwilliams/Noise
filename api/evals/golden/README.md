# Golden cases: recorded once, replayed on every PR

Scripted member exchanges and discovery steps run through Cue's real code path (`cases/*.ts`). The model's answers are recorded
once and committed under `recordings/`, so the merge gate checks Cue's code against them without calling a model.

Royce, 2026-10-14: "golden cases must not hit the live API on every CI run. Record real API responses once as committed fixtures
and have CI run the harness against the recordings. Live API runs only on a deliberate manual trigger."
Royce, 2026-10-29 (the rework): code checks the hard rules on every run; the merge gate no longer needs a re-record for a
tone-only rewording of an allowlisted literal (with a ledger entry, review of #318); the model judge moves to a scheduled quality run, three samples a case, scored by majority.

| Command | What it does | Cost |
|---|---|---|
| `npm run evals:golden` | **Replay: the merge gate** (`merge-gated.sh`, the CI `golden` check). Every model call answered from `recordings/` by its exact request; only a ledgered tone-only move of an allowlisted literal may replay on its old answer ("prompt moved"). Every reply through the hard rules. No key, no network. | $0 |
| `npm run evals:golden -- --ledger <PR>` | Replay that writes a `moved-ledger.json` entry for each tone move it sees (commit it with the PR). | $0 |
| `npm run evals:golden:quality` | **Quality run.** Each case 3 times with real calls; an attempt passes on the case's own checks, the hard rules and the rubric judge; the case is scored by majority. Reports pass rate per case, flaky cases and cost. Manual, or a local cron (below). Never part of the gate. | ~$8.80 for all 45: run it as `EVAL_COST_CAP_USD=10 npm run evals:golden:quality` |
| `npm run evals:golden:record -- --only <case>` | **Record.** Real calls through the meter, the case's recordings rewritten and stamped. | ~$0.05-0.20 a case |
| `npm run evals:golden:record -- --missing` | Record only the cases whose replay misses: a new case, or one whose behavior changed. `--moved` also records the cases that replayed on a moved prompt. | the same, for those cases |
| `npm run evals:golden:live` | **Live**: real calls, nothing written, one sample (a quick drift check; also the `golden-live` job on a manual dispatch). | ~$1.95 for all |
| `npm run evals:golden -- --estimate` | What a quality run would cost, case by case, from the recordings. No call. | $0 |
| `npm run evals:golden:stamp` | Replay that writes each recording's skeleton stamp (exact matches only). Needed once after the wording registry changes. | $0 |

`--only` takes ids or numbers, comma-separated (`--only 1,status-check`). `--runs N` (or `GOLDEN_RUNS`) sets the quality run's samples.

**Caps.** Record, live and quality are capped by the meter at `EVAL_COST_CAP_USD` (default $4) and `EVAL_TOKEN_CAP`; an env value wins
over the default (`EVAL_COST_CAP_USD=10 npm run evals:golden:quality`). The cap always holds: a call that could pass it is refused before
it is made. The quality run also refuses to start when its estimate is over the cap, and says what to set.

Record, live and quality need the real keys, from the environment (no golden run reads `api/.env`). From `api/`, with only the keys passed
in, so no database or other co-test secret reaches the run (add `-p 769e31e2-f831-4ed9-a158-4536cc3556bc` outside the linked checkout):

```
railway run -s co-test -e 5cac359e-1dc3-411f-b4b1-9949610041d2 -- sh -c 'exec env -i PATH="$PATH" HOME="$HOME" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" OPENAI_API_KEY="$OPENAI_API_KEY" GOOGLE_PLACES_API_KEY=ci ELEVENLABS_API_KEY=ci EVAL_COST_CAP_USD=4 npm run -s evals:golden:record -- --only <case>'
```

## What the merge gate guarantees

Replay (`npm run evals:golden`, no key, $0) fails the merge when:

- a live case's own assertions miss: its regexes, its code checks and its judge, run on the recorded answers;
- **any reply breaks a hard rule** (`evals/lib/hardRules.ts`, code, free): a name, place, time, number or link nothing in the turn gave it
  (list markers, advice ranges like "20-30 min" and date arithmetic from a date it was given are not claims); a status line on a check-in;
  a stock empathy phrase (`harness/stockLines.ts`); machinery narration (systems, tools, errors, retries, "on my end"); quoting Cue's own
  earlier line back (a span the member said first is theirs); a find's link without its caption, or inside prose; more than one reply text
  a turn (unless a tool brought something new);
- a model call's exact request isn't recorded. Strict by default: a fact, the member's words, a tool (name, description or schema), the
  model, a parameter, or any prompt literal outside the allowlist changed, and the case needs a re-record;
- an allowlisted tone literal moved without its ledger entry, under an entry older than 14 days, or for the second time on the same
  recording; or its move changed a rule (its guard terms: numbers, tool names, never/always/only, call, offer, question, safe, member,
  share, invent...) or an output format;
- a miss lands late (a timer or worker), or outside any case.

The one thing a merge may skip: a **ledgered, tone-only** rewording of an allowlisted literal. The case is tagged `ok(moved)`, the summary
line starts with `MOVED:` (so `merge-gated.sh`'s 50-character summary shows it), a `PROMPT MOVED` line names the cases, and on GitHub each
is a warning. Its code paths ran on the recorded answers; how the model answers the new words is the quality run's (or a re-record's).
`GOLDEN_STRICT=1` turns off even that.

## Wording vs behavior

The allowlist is `WORDING_ALLOWLIST` in `evals/golden/wording.ts`, pinned by `harnessTest.ts`; the skeleton is
`evals/lib/goldenSkeleton.mjs`.

- **Wording** (may move with a ledger entry): the literals of `MESSAGE_RHYTHM`, `COACHING_STYLE` (textRhythm.ts), `VOICE_TONE`,
  `VOICE_STYLE` (coVoice.ts), `SHARE_TONE`, `SHARE_TONE_2` and `FEEDBACK_TONE` (connectDots.ts). Tone and style only. The mixed prompts were
  split in the source so their rules sit in their own declarations (`CO_VOICE`, `COACHING`, `SHARING_GUIDE` and `FEEDBACK_GUIDE` assemble to
  exactly the text they were; the replay proves it, every hash unchanged).
- **Behavior** (strict, a re-record): everything else. Safety (`CO_SAFETY`, `COACHING_SAFETY`), member safety and privacy
  (`CO_MEMBER_SAFETY`), grounding and never-invent (`CO_GROUNDING`, `SHARE_GROUNDING`, `FEEDBACK_HONEST`, `VOICE_RULES`), who Cue is and what
  it owns (`VOICE_WHO`), the scope overrides (`SHARE_SCOPE`, `FEEDBACK_SCOPE`), the reply prompt and its gesture and tool-turn rules, the
  call-offer and other checker prompts whose answers code reads, `LOOP_GUIDE` (its lines are tool use), every fact and conversation line,
  every tool whole (description and schema), the model and every parameter.

Adding to the allowlist is a deliberate change to `wording.ts` and `harnessTest.ts`; split a mixed literal first so no rule rides along.
Changing the list changes the registry's signature: run `npm run evals:golden:stamp` on the code BEFORE the wording change and commit the
stamps with it.

## The moved ledger

`evals/golden/moved-ledger.json`, read by `evals/golden/ledger.ts`. One entry per move: `{ chunk, from, to, pr, date }` (the literal's id
and its text hash before and after). To reword an allowlisted literal without re-recording: make the change, run
`npm run evals:golden -- --ledger <PR>`, commit the ledger with the PR. Within 14 days, re-record the moved cases
(`npm run evals:golden:record -- --moved`) and drop the entry (replay lists entries nothing uses any more). A second rewording of the same
literal before the re-record fails: the recording would be two moves behind.

## The quality run

`npm run evals:golden:quality` runs each live case, and each pending case that makes model calls, 3 times. An attempt passes when:
the case's own assertions pass, every reply passes the hard rules, and the rubric judge (`evals/lib/replyRubric.ts`, Sonnet as grader)
passes every criterion that applies to the turn: specific; depth fits the moment (no length cap on a share or feedback turn, a short warm
line on a complete one, 1-2 sentences on a check-in or a casual turn); questions fit (several are fine on a share when they are one
continuous thought, at most one elsewhere); contributes rather than mirrors (no restating opener, no quoting itself); one idea a
paragraph; a real position; honest (no invented detail); a check-in is presence plus one item or an open question, never status; feedback
is owned in a few words, then shown. The case passes by majority (2 of 3). The report: per case `passes/runs`, `flaky` when the runs
disagree, the attempts passing each layer (own checks, hard rules, rubric) and the case's cost; the whole run's cost against the cap;
detail in `evals/golden/quality.local.json`. Exit 1 when a live case fails by majority (for a cron to alert on), 3 when the cap stopped it.

Cost: `npm run evals:golden -- --estimate` prices the recordings the way the meter would (about $2.94 a pass over all 45 cases, $8.82 for
three, with the 7 unrecorded cases counted at the median reply case). Cache reads on the 2nd and 3rd passes usually bring it lower. The
default $4 cap is under that on purpose: run it as `EVAL_COST_CAP_USD=10 npm run evals:golden:quality`. The run refuses to start when
its estimate is over the cap, and the meter stops it at the cap whatever happens.

A suggested schedule, local and not wired to CI (no paid CI, Royce 2026-10-14), weekly on Monday at 7am, capped:

```
0 7 * * 1  cd <a checkout tracking co-test>/api && git pull -q --ff-only && railway run -s co-test -e 5cac359e-1dc3-411f-b4b1-9949610041d2 -- sh -c 'exec env -i PATH="$PATH" HOME="$HOME" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" OPENAI_API_KEY="$OPENAI_API_KEY" GOOGLE_PLACES_API_KEY=ci ELEVENLABS_API_KEY=ci EVAL_COST_CAP_USD=10 npm run -s evals:golden:quality' >> ~/golden-quality.log 2>&1
```

## Adding a case

1. Write it in `cases/<file>.ts` (a new file works too: every file in `cases/` that exports `CASES` is run). Use the next free number and a
   unique id. Run its reply turns through a shared helper (`cases/checkins.ts` `reply()`, which notes each reply for the hard rules).
   Invented members, high-end club tone.
2. Until it is recorded, give it `status: { live: false, until: "its first recording ...", why }` (`AWAITING_RECORDING` in `types.ts`):
   replay reports it `pend(not recorded)` and never fails on it, and the quality run covers it.
3. Record it: `npm run evals:golden:record -- --only <id>` (or `--missing` for every new case at once). Read the recorded answer
   (`recordings/<id>/*.json`, `responses[].text`) before committing it.
4. Replay it with no key: `npm run evals:golden -- --only <id>`. It must pass, three runs in a row. Then make it live.
5. Commit the case and its `recordings/<id>/` folder together.

The cases waiting on their first recording (2026-10-29, `cases/moments.ts`): `share-good-news`, `share-heavy-news`, `feedback-kinda-dry`,
`feedback-cue-mistake`, `dry-thread` (three turns), `continuous-follow-up`, `complete-moment`. To record all seven (about $0.80 from the recorded cases' median, cap $2):

```
railway run -s co-test -e 5cac359e-1dc3-411f-b4b1-9949610041d2 -- sh -c 'exec env -i PATH="$PATH" HOME="$HOME" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" OPENAI_API_KEY="$OPENAI_API_KEY" GOOGLE_PLACES_API_KEY=ci ELEVENLABS_API_KEY=ci EVAL_COST_CAP_USD=2 npm run -s evals:golden:record -- --missing'
```

## When to re-record

Re-record a case when its replay says `FAIL(no recording)`: its behavior changed (a fact, a tool, a model, a parameter, an instruction
added or dropped, any prompt literal off the allowlist, the case itself). The failure names the call, says why the skeleton didn't fit
either, shows where it first differs from the nearest recording, and gives the command. A case that replays `ok(moved)` on a ledger
entry has 14 days to be re-recorded (`-- --moved`).

Recording a case that misses writes the miss: replay then fails the same way until the case is green and re-recorded.

## How it works

`evals/lib/goldenReplay.mjs` is preloaded after the meter and wraps `fetch`, the one seam every model client here uses (the ai SDK,
the Anthropic and OpenAI clients).

- **Key.** A hash of the request as Cue's code made it: host and path, the whole JSON body with keys sorted (model, system, messages,
  tools, max_tokens, temperature, thinking, effort...), the grader marker and any `anthropic-beta` header. `body.metadata` is left out.
- **Skeleton.** When the key misses, the request's skeleton (allowlisted wording masked, above) is matched against each recording's
  stamp (`structure`: the skeleton hash, each allowlisted literal's text hash and guard-term hash): exactly one match answers the call,
  reported as moved with each literal's from/to hashes, and the runner checks the ledger.
- **Recording.** `recordings/<case-id>/<hash>.json`: the request (a readable summary plus the full body, for the miss diff), each answer
  in order (text, usage, model, the raw body or stream events), `recorded_at`, and the skeleton stamp.
- **Replay.** A call with a recording gets its answer. A call without one, or asked more times than it was recorded, throws and fails
  the run even if the code caught the error. Misses are counted for the whole run: one that lands after its case returned (a timer, a
  queue, a worker an earlier case started) or outside any case is caught when the runner settles before exiting, named with the case
  it was billed to. Replay never calls the network, for any host. The script also sets a placeholder key, a zero cap and no `.env`.
- **Hard rules.** The reply helpers note each turn (`replies.ts`) with what it stood on (the rendered facts, the thread, their words);
  the runner checks them after each attempt, in every mode.
- **Same path in every mode.** Golden cases reach models and nothing else; any other host is refused in record, live and replay.
- **Pinned clock.** `Date` reads 2026-10-13T21:00:00Z (the incident day, 2pm in LA) and the zone is UTC, in every mode.
- **Each call belongs to its case** (AsyncLocalStorage), including late or background calls, and a retried attempt replaces the
  earlier attempt's recordings.
- Replay is deterministic, so it never retries. Live keeps one retry for model variance (reported as flaky); the quality run never
  retries: it samples three times and reports the majority.
