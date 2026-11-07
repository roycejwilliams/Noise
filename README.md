# Noise

Noise helps people through life transitions. Its agent, **Cue**, is a companion over text and calls that gets to know each
member and connects them with the right people, at events and between them.

The member is the customer. Hosts get room-level signal only, never member-level detail without that member's consent.

## Repository layout

| Path | What it is |
|---|---|
| `api/` | Cue's backend (TypeScript, Node): texting (Sendblue), calls (ElevenLabs and others), matching, the member picture, jobs |
| `api/src/` | Source: `routes/`, `services/`, `harness/`, `agent/`, `jobs/`, `db/` |
| `api/evals/` | Tests: layer 1 logic tests (model stubbed) and golden cases (recorded model answers, replayed) |
| `api/prompts/` | Prompt sources |
| `co-test/` | The dev/QA service. It mounts the real `api/src` routes and adds a tester dashboard |
| `app/` | The iOS app (Expo) |
| `evals/` | Older Python retrieval evals |
| `.githooks/` | The pre-push hook that runs layer 1 |

## Branches and deploys

- **`test`**: the working branch. Every backend change lands here first and deploys to the **co-test** service (Railway, `dev`).
  Members test there.
- **`main`**: production, which deploys to the production services. It is promoted from `test` deliberately, never directly.
- Feature work happens on its own branch, with a pull request into `test`.

## Merge gate (local, no paid CI)

Every pull request into `test` must pass all of these before it merges:

1. **Layer 1**: `TZ=UTC npm --prefix api run evals:code`. Typecheck, the voice check and every logic test, with the model stubbed. $0.
2. **Golden replay**: `npm --prefix api run evals:golden`. Every model call is answered from `api/evals/golden/recordings/`. No key, no network, $0.
3. **Typecheck** for `api`, `co-test` and `api/evals/tsconfig.golden.json`.
4. **An independent review** of the change.

Golden recordings change only by a deliberate, capped recording run (`evals:golden:record -- --missing`). A recording is never
used to paper over a failing expectation. See `api/evals/golden/README.md`.

Turn on the pre-push hook once per clone:

```sh
git config core.hooksPath .githooks
```

## Rules the code holds to

- **No cross-member leaks.** One member's details, match status or even existence never reach another member.
- **Forgetting is real.** Anything a member removes stays out of every reader. Corrections beat older assumptions.
- **Never assume.** Attendance needs evidence, silence is never a fact, and guesses stay tentative.
- **Matching is double opt-in**, and a thin room never lowers the bar.
- **Model judgment decides; code guards.** Checks protect members and never veto ordinary speech.
- **Text and calls get the same rules.**

## Secrets

Secrets live in Railway variables and local `.env` files (git-ignored). Never commit a key. The `.env.example` files list
the names only.
