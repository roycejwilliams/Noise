// Where a Luma sign-in or confirmation code comes from (Royce, 2026-11-09): authorized email access first, the member only when that
// can't. Pluggable, tried in order; the first code found is used once and never stored, logged or shown to a model.
//
// What exists on `test` today: NO email access. The general Gmail connection (gmail.metadata, which can't read a message body anyway)
// was removed (#388, 2026-11-04: services/googleAuth.ts; only the calendar free/busy grant remains). So authorizedEmail below always
// says "unavailable" and the member is asked. Reading a code would take a grant that can read a message body: Gmail's gmail.readonly
// (a restricted scope: Google's verification plus a CASA security assessment), narrowed in code to one search (from Luma's sending
// address, the last 10 minutes) and the code pattern. No new scope is added here.
export type CodeSource = { name: string; code(userId: string, since: Date): Promise<{ code: string } | { unavailable: string }> };

export const authorizedEmail: CodeSource = {
  name: "authorized email",
  code: async () => ({ unavailable: "no authorized email access exists for members (the Gmail connection was removed in #388; gmail.metadata never read bodies)" }),
};

export const DEFAULT_CODE_SOURCES: CodeSource[] = [authorizedEmail];

// The code from the first source that has one, or "ask the member" with why each source couldn't.
export async function codeFromSources(userId: string, since: Date, sources: CodeSource[] = DEFAULT_CODE_SOURCES): Promise<{ code: string; from: string } | { ask: true; why: string[] }> {
  const why: string[] = [];
  for (const s of sources) {
    const r = await s.code(userId, since).catch((e: any) => ({ unavailable: String(e?.message ?? e) }));
    if ("code" in r && r.code) return { code: r.code, from: s.name };
    why.push(`${s.name}: ${"unavailable" in r ? r.unavailable : "no code"}`);
  }
  return { ask: true, why };
}
