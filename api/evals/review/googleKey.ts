// The Google key's name (Royce, 2026-10-28: GOOGLE_API_KEY, "We're going to stick with that"). co-test sets GOOGLE_API_KEY; the code read
// GOOGLE_PLACES_API_KEY, so every geocode was refused. Layer 1, zero tokens.
//   npx tsx evals/review/googleKey.ts
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async () => ({ rows: [] });
const G = await import("../../src/services/geocoding.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail)}` : ""}`); } };
check("GOOGLE_API_KEY is the key", G.googleKey({ GOOGLE_API_KEY: "a" } as any) === "a");
check("it wins over the old name where both are set", G.googleKey({ GOOGLE_API_KEY: "a", GOOGLE_PLACES_API_KEY: "b" } as any) === "a");
check("the old name still works where only it is set (production)", G.googleKey({ GOOGLE_PLACES_API_KEY: "b" } as any) === "b");
check("neither set: empty, never undefined", G.googleKey({} as any) === "");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
check("every Google call reads the one key", !/process\.env\.GOOGLE_PLACES_API_KEY!/.test(src("services/geocoding.ts")) && (src("services/geocoding.ts").match(/key: googleKey\(\)/g) ?? []).length === 2);
console.log(`google key: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
