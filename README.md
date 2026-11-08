# Noise

**Cue is a companion that gets to know you, then connects you with the right people.**

Noise helps people through life's transitions: a new city, a new job, a new chapter. Members talk to Cue by text or phone.
Cue keeps track of what they're in the middle of, what they're looking for and what they can offer. It uses that to find the
right people and the right rooms, both at events and in between them.

- **A conversation, not a form.** Cue learns by talking, and the member never has to fill in a profile.
- **Connections, not feeds.** Every introduction is double opt-in, and a weak match is never forced.
- **Memory you can see.** Members can see everything Cue knows about them, correct it or have Cue forget it.

This repo holds Cue's backend, the test environment and the iOS app.

## Repository

```
api/        backend (TypeScript, Node 20)
  src/        server code
  evals/      tests
  prompts/    prompt sources
co-test/    test-environment server and tester dashboard
app/        iOS app (Expo)
```

## Getting started

```sh
git clone https://github.com/roycejwilliams/Noise.git
cd Noise
npm --prefix api install
npm --prefix co-test install
git config core.hooksPath .githooks
```

```sh
npm --prefix api run dev                 # backend
cd app && npm install && npx expo start  # app
```

## Testing

```sh
npm --prefix api test                    # logic tests, model stubbed
npm --prefix api run evals:golden        # recorded conversations, replayed
```

Neither one calls a model. The pre-push hook runs the first.

## Workflow

- `test` is the working branch, and it deploys to the test environment. `main` is production.
- Make a branch for each change and open a pull request into `test`.
- A pull request merges after its tests pass and it has been reviewed.
