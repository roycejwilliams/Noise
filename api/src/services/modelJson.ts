// Shared parsing for model output that's supposed to be JSON. Models
// sometimes wrap it in code fences or add a sentence before or after, so
// every call site used to strip fences and match braces its own way (13
// copies). This does both once: strip fences, take the first balanced
// {...} object (string-aware), parse it.

export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (ch === "\\") escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Throws if there's no parseable object, so callers keep their existing
// try/catch fallbacks.
export function parseModelJson<T = any>(raw: string): T {
  const unfenced = raw.replace(/```(?:json)?/g, "").trim();
  return JSON.parse(extractFirstJsonObject(unfenced) ?? unfenced) as T;
}
