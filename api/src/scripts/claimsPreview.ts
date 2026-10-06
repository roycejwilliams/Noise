// Read-only: the real 9/29 note through the rebuilt labels. No writes, no model call (the claim a model would propose is written by hand).
import "dotenv/config";
import pool from "../db/db.js";
import { finishClaims, theirWordsOf, renderRecap } from "../services/claims.js";
import { isLive } from "../services/factLabels.js";
const { rows: host } = await pool.query(`SELECT current_database() AS db`);
if (host[0].db !== "railway" || !/localhost:55432/.test(process.env.DATABASE_URL ?? "")) { console.log("not the dev tunnel: stopping"); process.exit(1); }
await pool.query("BEGIN READ ONLY");
const { rows } = await pool.query(`SELECT content, created_at FROM co_memories WHERE content ILIKE '%pitching investors Friday%' AND content LIKE 'User said:%' ORDER BY created_at ASC LIMIT 1`);
const note = theirWordsOf(rows);
console.log("NOTE (stored, verbatim):", JSON.stringify(note[0]));
const q = /pitching investors Friday/i.exec(note[0].text)![0];
const [c] = finishClaims([{ text: "They are pitching investors Friday.", provenance: "user_said", kind: "deadline", quote: q }], note, "2026-10-06");
console.log("LABELS:", JSON.stringify({ provenance: c.provenance, kind: c.kind, lifetime: "ephemeral", saidOn: c.saidOn, expiresOn: c.expiresOn }));
for (const d of ["2026-10-02", "2026-10-03", "2026-10-06"]) console.log(`live on ${d}?`, isLive(c, new Date(`${d}T20:00:00Z`)));
const [inf] = finishClaims([{ text: "They seem to be preparing a pitch.", provenance: "co_inferred", kind: "plan" }], note, "2026-10-06");
console.log("Co-inferred example:", JSON.stringify({ provenance: inf.provenance, quote: inf.quote, expiresOn: inf.expiresOn }));
console.log("RECAP on 10/1:\n" + renderRecap([c], new Date("2026-10-01T20:00:00Z")));
console.log("RECAP on 10/6:\n" + (renderRecap([c], new Date("2026-10-06T20:00:00Z")) || "(empty: the pitch is gone)"));
await pool.query("ROLLBACK"); await pool.end();
