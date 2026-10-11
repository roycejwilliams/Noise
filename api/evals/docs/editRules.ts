// Royce's document rules (2026-10-11), the parts Co's documents didn't meet. Layer 1: fake Google, fake Sendblue, receipts in memory.
//   Rule 3: a change to a Google Doc Co made goes into that same Doc (same link), and only the change line is texted.
//   Rule 4: every new version says what changed: never a bare "Here's the updated X".
//   Rule 6: if the same Doc can't be updated (gone), a new one is made and the text says why; a grant or setup problem is said plainly.
//   npx tsx evals/docs/editRules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const GD = await import("../../src/services/googleDocs.js");
const X = await import("../../src/services/documentDelivery.js");
const R = await import("../../src/services/deliveryReceipts.js");
const D = await import("../../src/services/documentSheet.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const PAIR = ["11111111-1111-4111-8111-111111111111"];
process.env.GOOGLE_DOCS_TEST_USERS = PAIR.join(",");
const v1 = D.resolveDocument({ title: "Venue brief for the Mission dinner", note: "", kind: "venue_brief", sections: [{ heading: "The room", bullets: ["Alder and Ash, about 40 seated, Friday dinner."] }], suggestions: [] });
const v2 = D.resolveDocument({ title: "Venue brief for the Mission dinner", note: "", kind: "venue_brief", sections: [{ heading: "The room", bullets: ["Mesa Verde, about 40 seated, Saturday dinner."] }], suggestions: [] });
const to = { userId: PAIR[0], firstName: "Jordan", phone: "+15550100001", zone: "America/Los_Angeles", now: new Date("2026-10-11T18:00:00Z") };

// ---------------------------------------------------------------- the Drive call
{
  const seen: { url: string; method: string }[] = [];
  const f = (status: number, body: any): any => async (url: string, init: any) => { seen.push({ url, method: init.method }); return { ok: status < 300, status, json: async () => body }; };
  const ok = await GD.updateGoogleDoc("tok", "F1", "<p>x</p>", f(200, { id: "F1", webViewLink: "https://docs.google.com/document/d/F1/edit" }));
  check("an update writes into the same file (PATCH the upload endpoint for that id)", ok.ok && seen[0].method === "PATCH" && /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/F1\?uploadType=multipart/.test(seen[0].url));
  const gone = await GD.updateGoogleDoc("tok", "F1", "<p>x</p>", f(404, {}));
  check("a Doc they deleted is 'gone'", !gone.ok && (gone as any).cause === "gone");
  const orig = console.error; console.error = () => {};
  const cfg = await GD.updateGoogleDoc("tok", "F1", "<p>x</p>", f(403, { error: { errors: [{ reason: "accessNotConfigured" }], message: "Drive API has not been used in project 1" } }));
  console.error = orig;
  check("our setup is ours (same split as uploads, #141)", !cfg.ok && (cfg as any).cause === "our_config" && /ours to fix/.test(cfg.why));
}

// ---------------------------------------------------------------- rules 3, 4, 6 through deliverAndRecord
const run = async (o: { update?: any } = {}) => {
  const texts: string[] = [];
  const uploads: string[] = [];
  const updates: string[] = [];
  let n = 0;
  const deps: any = {
    render: async () => Buffer.alloc(2000, 1), cache: () => "https://x.test/f.pdf", send: async (m: any) => { texts.push(m.content); return {}; }, from: "+1",
    googleToken: async () => "tok",
    uploadDoc: async (_t: string, name: string) => { uploads.push(name); n++; return { ok: true, id: `F${n}`, link: `https://docs.google.com/document/d/F${n}/edit` }; },
    shareDoc: async () => ({ ok: true }),
    updateDoc: async (_t: string, id: string) => { updates.push(id); return o.update ?? { ok: true, id, link: `https://docs.google.com/document/d/${id}/edit` }; },
  };
  const receipts = R.memoryReceipts();
  const deliver = (d: any, t: any, target: any) => X.deliverDocument(d, t, target, deps);
  const first = await X.deliverAndRecord(v1, { ...to, line: "Here's the venue brief." }, { saveTo: "google_doc", askedForGoogle: true, source: "reply" }, { deliver, receipts, log: async () => null });
  texts.length = 0;
  const rid = first.receipts[0]?.id;
  const second = await X.deliverAndRecord(v2, to, { askedForGoogle: false, source: "reply", revises: rid, changed: "swapped Friday at Alder and Ash for Saturday at Mesa Verde" }, { deliver, receipts, log: async () => null });
  return { first, second, texts, uploads, updates, receipts };
};
{
  const r = await run();
  const rec = r.receipts.all.at(-1)!;
  check("rule 3: the change goes into the same Doc (no new upload), even though they didn't say 'Google' this time", r.updates.join() === "F1" && r.uploads.length === 1 && r.second.sentOk[0]?.via === "google_docs" && (r.second.sentOk[0] as any).updatedInPlace === true, r);
  check("rule 3: only the change line is texted (no link, no whole document)", r.texts.length === 1 && /^Swapped Friday at Alder and Ash for Saturday at Mesa Verde\.$/.test(r.texts[0]), r.texts);
  check("the new version's receipt keeps the same link and file", rec.version === 2 && rec.link === "https://docs.google.com/document/d/F1/edit" && rec.driveFileId === "F1");
}
{
  const r = await run({ update: { ok: false, cause: "gone", why: "the Doc isn't in their Drive anymore" } });
  check("rule 6: the Doc is gone, so a new one is made and the text says why, with the new link", r.updates.join() === "F1" && r.uploads.length === 2 && /The earlier Doc isn't in your Drive anymore, so this is a new one\./.test(r.texts[0] ?? "") && /docs\.google\.com\/document\/d\/F2/.test(r.texts[0] ?? ""), r.texts);
}
{
  const r = await run({ update: { ok: false, cause: "reconnect", why: "Google didn't allow it (they need to reconnect Google and allow Docs)" } });
  check("rule 6: a grant problem is said plainly, never swapped for a new Doc silently", r.uploads.length === 1 && r.second.sentOk.length === 0 && /reconnect Google/.test((r.second.results[0] as any).why ?? ""), r.second.results);
}
{
  // Rule 4: a new version without saying what changed is refused, with or without revises; asking for it again still sends.
  const receipts = R.memoryReceipts();
  const deps: any = { render: async () => Buffer.alloc(2000, 1), cache: () => "https://x.test/f.pdf", send: async () => ({}), from: "+1" };
  const deliver = (d: any, t: any, target: any) => X.deliverDocument(d, t, target, deps);
  await X.deliverAndRecord(v1, to, { askedForGoogle: false, source: "reply" }, { deliver, receipts, log: async () => null });
  const bare = await X.deliverAndRecord(v2, to, { askedForGoogle: false, source: "reply" }, { deliver, receipts, log: async () => null });
  check("rule 4: a new version that doesn't say what changed doesn't go", bare.sentOk.length === 0 && /needs a short note of what changed/.test((bare.results[0] as any).why ?? ""), bare.results);
  const named = await X.deliverAndRecord(v2, to, { askedForGoogle: false, source: "reply", changed: "moved it to Saturday" }, { deliver, receipts, log: async () => null });
  check("rule 4: with what changed, it goes with that line", named.sentOk.length === 1 && named.line === "Moved it to Saturday.");
  const again = await X.deliverAndRecord(v2, to, { askedForGoogle: false, source: "reply", resend: true }, { deliver, receipts, log: async () => null });
  check("asking for it again still sends the version they have", again.sentOk.length === 1);
}

console.log(`document edit rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
