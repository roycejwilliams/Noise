import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
// The call's voice layer (prompts/co-system-prompt.md). Since 2026-10-08 it
// holds only what is different on the phone; who Co is, how it listens, what's
// true and the safety rules are Co's shared core (services/coCore.ts), which the
// text reply and the call prompt (services/elevenLabsCalls.ts) both
// import. Texts don't read this file.
//
// Read once and cached for the life of the process.
let cachedPrompt: string | null = null;

// The raw prompt returned by getCoPersonaPrompt() below still contains
// {{first_name}}/{{context_summary}} template tokens — the call agent fills
// those itself at call time (services/elevenLabsCalls.ts's variables), but
// nothing does that for this text-channel reuse. Left unfilled, the model is
// literally told "here's the context_summary: {{context_summary}}" and,
// correctly, reports it doesn't have one instead of writing real output —
// confirmed live (a post-call follow-up text leaked exactly that reasoning
// to a real user). Always render through this before handing the prompt to
// a model; never pass getCoPersonaPrompt()'s raw text to one directly.
export async function renderCoPersonaPrompt(
  firstName: string,
  contextSummary: string,
): Promise<string | null> {
  const raw = await getCoPersonaPrompt();
  if (!raw) return raw;
  return raw
    .replace(/\{\{first_name\}\}/g, firstName)
    .replace(/\{\{context_summary\}\}/g, contextSummary);
}

// The call prompt file (api/prompts/co-system-prompt.md) is the source of
// truth (scripts/pushElevenLabsAgent.ts pushes it to the call agent),
// so read it directly (2026-10-03): Hume, which this used to fetch from,
// ends on 2026-11-13. co-test's image copies api/prompts (co-test/Dockerfile);
// a few places are tried since the process runs from api/ or co-test/.
export function promptFileCandidates(cwd = process.cwd(), here = fileURLToPath(new URL(".", import.meta.url))): string[] {
  return [
    resolve(cwd, "prompts/co-system-prompt.md"),
    resolve(cwd, "api/prompts/co-system-prompt.md"),
    resolve(cwd, "../api/prompts/co-system-prompt.md"),
    resolve(here, "../../prompts/co-system-prompt.md"),
    resolve(here, "../../../prompts/co-system-prompt.md"),
    resolve(here, "../../../../api/prompts/co-system-prompt.md"),
  ];
}

function readPromptFile(): string | null {
  for (const p of promptFileCandidates()) {
    try {
      if (existsSync(p)) {
        const text = readFileSync(p, "utf-8");
        if (text.trim()) return text;
      }
    } catch {}
  }
  return null;
}

export async function getCoPersonaPrompt(): Promise<string | null> {
  if (cachedPrompt) return cachedPrompt;
  const fromFile = readPromptFile();
  if (fromFile) {
    cachedPrompt = fromFile;
    return fromFile;
  }
  console.error("coPersona: prompts/co-system-prompt.md not found (non-fatal, falling back to a thinner default)");
  return null;
}
