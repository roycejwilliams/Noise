// Cue's contact card by version, and its reissue (utils/vcard.ts, services/cardReissue.ts, 2026-11-02). Layer 1, zero tokens, no DB,
// nothing sent: the push runs against fake deps. Checks: the live card is byte-for-byte what was served before until Royce approves
// a version; one UID across versions; the approved mark used as-is; no send without Royce's approval record AND the matching flag;
// nobody gets a version twice; a retry tries only the members it didn't reach; every exclusion; and the reissue decision (a contact
// change is a basis, a feature release alone never is). Members are invented (Jordan, Noor, Ellis).
//
//   npx tsx evals/delivery/contactCard.ts
import fs from "node:fs";
import { createHash } from "node:crypto";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const VC = await import("../../src/utils/vcard.js");
const CR = await import("../../src/services/cardReissue.js");
const { CO_ICON_PNG_BASE64 } = await import("../../src/assets/coIcon.js");
const { CUE_MARK_JPEG_BASE64, CUE_MARK_JPEG_SHA256 } = await import("../../src/assets/cueMark.js");
const { serveVersionedVCard } = await import("../../src/routes/contactCard.js");
const { PROACTIVE_PURPOSE } = await import("../../src/harness/proactivePurpose.js");

const TEXT = "+14155550100", CALLS = "+14155550101";
const phones = { SENDBLUE_PHONE_NUMBER: TEXT, TWILIO_PHONE_NUMBER: CALLS };
const unfold = (s: string) => s.replace(/\r\n /g, "");
const lines = (s: string) => unfold(s).split("\r\n");

// ---------------------------------------------------------------- 1. versions and the UID

// The card exactly as it was served before versions (the old buildCoVCard body, copied verbatim).
function oldCard(phone: string): string {
  const fold = (line: string, limit = 75) => {
    if (line.length <= limit) return line;
    const parts = [line.slice(0, limit)];
    let rest = line.slice(limit);
    while (rest.length > 0) { parts.push(" " + rest.slice(0, limit - 1)); rest = rest.slice(limit - 1); }
    return parts.join("\r\n");
  };
  return ["BEGIN:VCARD", "VERSION:3.0", "FN:Cue", `TEL:${phone}`, "URL:https://app.copatible.com", "EMAIL:support@copatible.com", "NOTE:A personal AI that gets to know you and helps you move forward with what matters most.", `PHOTO;ENCODING=b;TYPE=PNG:${CO_ICON_PNG_BASE64}`, "END:VCARD"].map((l) => fold(l)).join("\r\n");
}
check("live: version 2, approved by Royce Williams (2026-11-03), its approval matching its content", VC.liveVersion().version === 2 && VC.isApproved(VC.V2) && VC.V2.approval !== "legacy" && VC.V2.approval?.by === "Royce Williams" && VC.V2.approval?.on === "2026-11-03");
check("/co.vcf serves version 2", VC.buildCoVCard(TEXT, CALLS) === VC.renderCard(VC.V2, phones));
check("version 1 still renders byte-for-byte the card served before", VC.renderCard(VC.V1, phones) === oldCard(TEXT));
check("an unapproved or unknown version is never served on its own URL", VC.buildVersionedVCard(9, phones) === null && VC.buildVersionedVCard(2, phones) === VC.renderCard(VC.V2, phones));
{
  const unapproved = { ...VC.V2, approval: null };
  check("an unapproved version is never live", VC.liveVersion([VC.V1, unapproved]).version === 1);
}
check("version 2 renders the same every time (same content hash)", VC.renderCard(VC.V2, phones) === VC.renderCard(VC.V2, phones) && VC.cardSha(VC.V2) === VC.cardSha(VC.V2));
check("one UID, a fixed urn:uuid", /^urn:uuid:[0-9a-f-]{36}$/.test(VC.CARD_UID) && VC.V2.fields.uid === VC.CARD_UID);
check("the UID is on the card as written", lines(VC.renderCard(VC.V2, phones)).includes(`UID:${VC.CARD_UID}`));
check("REV is the revision's date-time", lines(VC.renderCard(VC.V2, phones)).includes("REV:2026-11-03T00:00:00Z"));
const truth = { ...VC.V2.fields, phones: VC.V2.fields.phones };
const v3 = CR.prepareRevision(VC.V2, { ...truth, email: "hello@example.test" }, [{ kind: "contact", field: "EMAIL", detail: "x" }]);
check("a prepared revision keeps the same UID, takes the next number", !!v3 && v3.version.fields.uid === VC.CARD_UID && v3.version.version === 3);
const v2Lines = lines(VC.renderCard(VC.V2, phones));
check("v2: vCard 3.0 with the N it requires, FN, ORG", v2Lines[0] === "BEGIN:VCARD" && v2Lines[1] === "VERSION:3.0" && v2Lines.includes("N:;Cue;;;") && v2Lines.includes("FN:Cue") && v2Lines.includes("ORG:Noise") && v2Lines.at(-1) === "END:VCARD");
check("v2: never a TITLE (Cue is never introduced by a role)", !v2Lines.some((l) => /^TITLE/i.test(l)) && !/\bmatchmak|\bassistant\b|\bconcierge\b|noise'?s ai/i.test(VC.renderCard(VC.V2, phones)));
check("v2: the texting number and the calling line, labelled", v2Lines.includes(`item1.TEL;type=CELL;type=pref:${TEXT}`) && v2Lines.includes("item1.X-ABLabel:Texts") && v2Lines.includes(`item2.TEL;type=VOICE:${CALLS}`) && v2Lines.includes("item2.X-ABLabel:Calls"));
check("v2: no calling line on file, no blank TEL", !lines(VC.renderCard(VC.V2, { SENDBLUE_PHONE_NUMBER: TEXT, TWILIO_PHONE_NUMBER: null })).some((l) => /TEL[^:]*:$/.test(l) || /Calls/.test(l)));
check("v2: NOTE escaped as vCard text", v2Lines.includes("NOTE:Knowing what you're in the middle of\\, and finding the person worth meeting for it."));
check("every physical line is at most 75 octets", VC.renderCard(VC.V2, phones).split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
check("the numbers are never in code: read from the env names", !/\+1\d{10}/.test(src("utils/vcard.ts")) && /SENDBLUE_PHONE_NUMBER/.test(src("utils/vcard.ts")) && /TWILIO_PHONE_NUMBER/.test(src("utils/vcard.ts")));

// ---------------------------------------------------------------- 2. the approved mark, as-is

const jpg = fs.readFileSync(new URL("../../src/assets/cue-mark-cream-512.jpg", import.meta.url));
check("the committed mark is the approved JPEG (its hash)", createHash("sha256").update(jpg).digest("hex") === CUE_MARK_JPEG_SHA256);
check("the base64 module is those exact bytes (never re-encoded)", Buffer.from(CUE_MARK_JPEG_BASE64, "base64").equals(jpg));
check("it's a 512x512 JPEG", jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.includes(Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x02, 0x00])) || jpg.includes(Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x00, 0x02, 0x00])));
const photoLine = v2Lines.find((l) => l.startsWith("PHOTO;"))!;
check("v2's PHOTO is that JPEG inline, base64", photoLine === `PHOTO;ENCODING=b;TYPE=JPEG:${CUE_MARK_JPEG_BASE64}`);
const size = Buffer.byteLength(VC.renderCard(VC.V2, phones));
check("the card stays small: under 300 KB, the low end of carrier MMS limits (Sendblue allows 5 MB on SMS)", size < 300_000, size);

// ---------------------------------------------------------------- 3. approval before any send

type Row = import("../../src/services/cardReissue.js").AudienceRow;
const row = (id: string, more: Partial<Row> = {}): Row => ({ id, phone_number: "+12125550200", created_at: "2026-09-01T00:00:00Z", archived_at: null, sms_opted_out: false, identity_captured: true, bot_blocked: false, safety_hold: false, sent: false, attempt: null, ...more });
function fakeDeps(rows: Row[], o: { fail?: Set<string>; hold?: Set<string>; phones?: Record<string, string | null> } = {}) {
  const sentTo: string[] = [];
  const records: { id: string; status: string }[] = [];
  const ledger = new Set<string>();
  const deps: import("../../src/services/cardReissue.js").PushDeps = {
    phones: o.phones ?? phones,
    log: () => {},
    liveSince: async () => null,
    rows: async () => rows.map((r) => ({ ...r })),
    sendOne: async (r) => {
      if (o.fail?.has(r.id)) throw new Error("sendblue 500");
      if (o.hold?.has(r.id)) return { status: "held", reason: "held: spacing" };
      // The ledger key: once per member per version, whatever the caller does.
      if (ledger.has(r.id)) return { status: "sent" };
      ledger.add(r.id);
      sentTo.push(r.id);
      return { status: "sent" };
    },
    record: async (id, _v, out) => {
      records.push({ id, status: out.status });
      const r = rows.find((x) => x.id === id)!;
      if (out.status === "sent") { r.sent = true; r.attempt = null; } else r.attempt = out.status;
    },
  };
  return { deps, sentTo, records };
}
// A version 2 Royce approved (a test copy: the real one stays null until he signs it).
const approve = (v: typeof VC.V2, more: Partial<import("../../src/utils/vcard.js").CardApproval> = {}) => ({ ...v, approval: { by: "Royce Williams" as const, on: "2026-11-03", contentSha: VC.cardSha(v), telLast4: { SENDBLUE_PHONE_NUMBER: "0100", TWILIO_PHONE_NUMBER: "0101" }, ref: "test", ...more } });
const A2 = approve(VC.V2);
const versionsApproved = [VC.V1, A2];

{
  const f = fakeDeps([row("jordan"), row("noor")]);
  const r = await CR.runPush({ version: 2, mode: "send", flag: null }, f.deps);
  check("the real v2 (card approved, send not): nothing sent without the --approved flag", f.sentTo.length === 0 && !!r.refused?.includes("no --approved flag"), r.refused);
  const r2 = await CR.runPush({ version: 2, mode: "send", flag: CR.approvalFlag(VC.V2) }, f.deps);
  check("the real v2 with the flag, but not the numbers it was approved with: nothing sent", f.sentTo.length === 0 && !!r2.refused?.some((w) => /number it was approved with/.test(w)), r2.refused);
  const unapproved = { ...VC.V2, approval: null };
  const r3 = await CR.runPush({ version: 2, mode: "send", flag: CR.approvalFlag(unapproved), versions: [VC.V1, unapproved] }, f.deps);
  check("a version with no approval record: nothing sent, even with the right flag", f.sentTo.length === 0 && !!r3.refused?.some((w) => /no approval record/.test(w)), r3.refused);
}
{
  const f = fakeDeps([row("jordan")]);
  const r = await CR.runPush({ version: 2, mode: "send", flag: null, versions: versionsApproved }, f.deps);
  check("approved, but no --approved flag: nothing sent", f.sentTo.length === 0 && !!r.refused?.includes("no --approved flag"));
  const r2 = await CR.runPush({ version: 2, mode: "send", flag: "v2:000000000000", versions: versionsApproved }, f.deps);
  check("approved, wrong flag: nothing sent", f.sentTo.length === 0 && !!r2.refused?.some((w) => /doesn't match/.test(w)));
}
{
  const edited = { ...A2, memberNote: A2.memberNote + " Edited after approval." };
  const f = fakeDeps([row("jordan")]);
  const r = await CR.runPush({ version: 2, mode: "send", flag: CR.approvalFlag(edited), versions: [VC.V1, edited] }, f.deps);
  check("words changed after approval: the approval is void, nothing sent", f.sentTo.length === 0 && !VC.isApproved(edited) && !!r.refused?.some((w) => /doesn't match its content/.test(w)));
}
{
  const f = fakeDeps([row("jordan")], { phones: { SENDBLUE_PHONE_NUMBER: "+14155550177", TWILIO_PHONE_NUMBER: CALLS } });
  const r = await CR.runPush({ version: 2, mode: "send", flag: CR.approvalFlag(A2), versions: versionsApproved }, f.deps);
  check("the texting number changed since approval: nothing sent", f.sentTo.length === 0 && !!r.refused?.some((w) => /number it was approved with/.test(w)));
}
{
  const f = fakeDeps([row("jordan")]);
  const r = await CR.runPush({ version: 1, mode: "send", flag: CR.approvalFlag(VC.V1) }, f.deps);
  check("the legacy card is never pushed", f.sentTo.length === 0 && !!r.refused?.some((w) => /legacy/.test(w)));
}
{
  const f = fakeDeps([row("jordan"), row("noor")]);
  const r = await CR.runPush({ version: 2, mode: "dry_run", flag: CR.approvalFlag(A2), versions: versionsApproved }, f.deps);
  check("dry run: coverage, and nothing sent or recorded, even when approved", f.sentTo.length === 0 && f.records.length === 0 && r.coverage.eligible === 2 && r.tried === 0);
}
{
  const f = fakeDeps([row("jordan"), row("noor")]);
  const r = await CR.runPush({ version: 2, mode: "send", flag: CR.approvalFlag(A2), versions: versionsApproved }, f.deps);
  check("approved + the matching flag + the same numbers: it sends", f.sentTo.length === 2 && r.sent === 2 && !r.refused, r);
}
check("approval is a code record, never an env switch", !/process\.env\.[A-Z_]*(APPROV|ENABLE|PUSH|SEND_CARD)/.test(src("services/cardReissue.ts") + src("utils/vcard.ts") + src("scripts/cardReissue.ts")));
check("the send flag is never stored in code: only Royce passes it", !/--approved v2:[0-9a-f]{12}/.test(src("utils/vcard.ts") + src("services/cardReissue.ts") + src("scripts/cardReissue.ts")) && !src("services/cardReissue.ts").includes(CR.approvalFlag(VC.V2)));

// ---------------------------------------------------------------- 4. never twice; retry only who it missed

{
  const rows = [row("jordan"), row("noor"), row("ellis")];
  const f = fakeDeps(rows, { fail: new Set(["noor"]), hold: new Set(["ellis"]) });
  const first = await CR.runPush({ version: 2, mode: "send", flag: CR.approvalFlag(A2), versions: versionsApproved }, f.deps);
  check("first run: one sent, one failed, one held", first.sent === 1 && first.failed === 1 && first.held === 1, first);
  const again = await CR.runPush({ version: 2, mode: "send", flag: CR.approvalFlag(A2), versions: versionsApproved }, f.deps);
  check("a second send run tries nobody (everyone was tried once)", again.tried === 0 && f.sentTo.length === 1, again);
  const retry = fakeDeps(rows);
  const r = await CR.runPush({ version: 2, mode: "retry", flag: CR.approvalFlag(A2), versions: versionsApproved }, { ...retry.deps, rows: f.deps.rows });
  check("retry tries only the failed and the held member, never the one it reached", r.tried === 2 && retry.sentTo.sort().join() === "ellis,noor", { r, sent: retry.sentTo });
  const after = await CR.runPush({ version: 2, mode: "retry", flag: CR.approvalFlag(A2), versions: versionsApproved }, { ...retry.deps, rows: f.deps.rows });
  check("once everyone is reached, a retry tries nobody", after.tried === 0);
  check("every member got it exactly once", [...f.sentTo, ...retry.sentTo].sort().join() === "ellis,jordan,noor");
}
check("a member already sent this version is excluded", CR.classify(row("jordan", { sent: true }), { liveSince: null }) === "already_sent");
check("the ledger key is per version", CR.cardTargetKey(2) === "contact_card:v2" && CR.cardTargetKey(3) !== CR.cardTargetKey(2));
check("the ledger refuses a key twice (sendExempt: unique user_id + target_key)", /INSERT INTO proactive_sends \(user_id, type, target_key, topic_key, message, exempt, kind[^)]*\)[\s\S]{0,160}ON CONFLICT \(user_id, target_key\) DO NOTHING RETURNING id/.test(src("harness/proactive.ts")));
check("the record is one row per member per version", /PRIMARY KEY \(user_id, version\)/.test(src("db/migrations.ts")));

// ---------------------------------------------------------------- 5. exclusions

const L = { liveSince: new Date("2026-11-03T00:00:00Z") };
const cases: [string, Row, string][] = [
  ["archived", row("a", { archived_at: "2026-10-01" }), "archived"],
  ["no phone", row("b", { phone_number: null }), "no_phone"],
  ["an archive placeholder number", row("c", { phone_number: "+15035550130#a8" }), "unsendable_number"],
  ["a fictional 555-01xx test number", row("d", { phone_number: "+14155550142" }), "test_number"],
  ["a sender blocked as automated", row("e", { bot_blocked: true, identity_captured: false }), "bot_blocked"],
  ["never finished joining", row("f", { identity_captured: false }), "not_a_member_yet"],
  ["opted out (STOP)", row("g", { sms_opted_out: true }), "opted_out"],
  ["a safety hold", row("h", { safety_hold: true }), "safety_hold"],
  ["joined after this version went live (got it at onboarding)", row("i", { created_at: "2026-11-04T00:00:00Z" }), "joined_after_live"],
  ["already sent", row("j", { sent: true }), "already_sent"],
  ["a member", row("k"), "eligible"],
];
for (const [label, r, want] of cases) check(`exclusion: ${label}`, CR.classify(r, L) === want, CR.classify(r, L));
const cov = CR.coverage(cases.map((c) => c[1]), L);
check("coverage counts each reason once", cov.eligible === 1 && Object.values(cov.excluded).reduce((a, b) => a + b, 0) === cases.length - 1 && cov.excluded.test_number === 1);
check("an excluded member is never tried, in any mode", ["send", "retry"].every((m) => CR.targets(cases.map((c) => ({ ...c[1], attempt: c[2] === "eligible" ? null : ("failed" as const) })), m as any, L).every((r) => r.id === "k")));
const realSend = src("services/cardReissue.ts");
check("the real send waits on the member's holds: safety, a hard day, a hold or space they asked for", /safetyHold\) return \{ status: "held"/.test(realSend) && /heldForMood\(s\.state\)/.test(realSend) && /holdUntil/.test(realSend) && /spaceUntil/.test(realSend));
check("the real send goes through sendExempt with local hours and the gates of any text Cue starts", /P\.sendExempt\(\{[\s\S]*type: "contact_card"[\s\S]*respectHours: true,[\s\S]*coInitiated: \{ kind: null \}/.test(realSend));
check("sendExempt attaches media only when asked", /\.\.\.\(opts\.mediaUrl \? \{ media_url: opts\.mediaUrl \} : \{\}\)/.test(src("harness/proactive.ts")));
check("the card type has a purpose (ops)", PROACTIVE_PURPOSE.contact_card === "ops");
check("the push links its exact version, ending in .vcf", CR.versionedCardUrl("https://test.example/co.vcf", 2) === "https://test.example/cards/v2/Cue.vcf" && CR.versionedCardUrl(undefined, 2) === null);
{
  let status = 200;
  const res: any = { status(s: number) { status = s; return this; }, send() { return this; }, setHeader() {} };
  serveVersionedVCard({ params: { version: "v9" } } as any, res);
  check("the route 404s a version that isn't approved", status === 404);
}

// ---------------------------------------------------------------- 6. when to reissue

const held = { fields: VC.V2.fields, numbersCurrent: true };
check("nothing changed: no revision", !CR.decideReissue(CR.detectChanges(held, VC.V2.fields)).revise);
check("the texting number changed: revise, on contact", (() => { const d = CR.decideReissue(CR.detectChanges({ ...held, numbersCurrent: false }, VC.V2.fields)); return d.revise && d.basis.every((s) => s.kind === "contact"); })());
check("the email changed: revise, on contact", CR.decideReissue(CR.detectChanges(held, { ...VC.V2.fields, email: "hello@example.test" })).basis.some((s) => s.kind === "contact" && s.field === "EMAIL"));
check("the photo changed: revise, on branding", CR.decideReissue(CR.detectChanges({ fields: VC.V1.fields, numbersCurrent: true }, { ...VC.V1.fields, photo: "cue_mark_jpeg" })).basis.some((s) => s.kind === "branding"));
check("the company changed: revise, on identity", CR.decideReissue(CR.detectChanges(held, { ...VC.V2.fields, org: "Another Co" })).basis.some((s) => s.kind === "identity"));
check("a description naming an old identity: revise, on description", CR.decideReissue(CR.detectChanges({ fields: { ...VC.V2.fields, note: "Co helps you" }, numbersCurrent: true }, { ...VC.V2.fields, note: "Co helps you" })).basis.some((s) => s.kind === "description"));
{
  const d = CR.decideReissue([{ kind: "feature_release", detail: "a big feature release" }]);
  check("a feature release alone: no revision", !d.revise && d.notABasis.length === 1);
  check("a feature release alone prepares nothing", CR.prepareRevision(VC.V2, VC.V2.fields, [{ kind: "feature_release", detail: "x" }]) === null);
  check("fixes and internal changes alone: no revision", !CR.decideReissue([{ kind: "fix", detail: "x" }, { kind: "internal", detail: "y" }]).revise);
}
{
  const p = CR.prepareRevision(VC.V2, { ...VC.V2.fields, url: "https://example.test" }, [{ kind: "contact", field: "URL", detail: "x" }]);
  check("deciding a revision never approves it, and never writes member words", !!p && p.version.approval === null && p.version.memberNote === null && !VC.isApproved(p.version));
  check("a prepared revision shows its diff", !!p && p.diff.some((d) => d.field === "URL" && d.changed) && p.diff.filter((d) => d.changed).length === 1);
  const f = fakeDeps([row("jordan")]);
  const versions = [VC.V1, A2, p!.version];
  const r = await CR.runPush({ version: 3, mode: "send", flag: CR.approvalFlag(p!.version), versions }, f.deps);
  check("a prepared revision can't be sent until Royce approves it", f.sentTo.length === 0 && !!r.refused?.length);
}
// The approved numbers' last four (the env's real numbers are never here): fake numbers ending the same.
const sameNumbers = { SENDBLUE_PHONE_NUMBER: "+14155558080", TWILIO_PHONE_NUMBER: "+14155551762" };
const today = CR.reissueCheck(sameNumbers);
check("today: v2 is the card, nothing waits, no revision needed", today.held.version === 2 && today.waiting === null && !today.decision.revise, today.decision);
check("today, if the texting number changed: a revision is needed, on contact", (() => { const d = CR.reissueCheck({ ...sameNumbers, SENDBLUE_PHONE_NUMBER: "+14155550199" }).decision; return d.revise && d.basis.every((s) => s.kind === "contact"); })());
const v1to2 = CR.decideReissue(CR.detectChanges({ fields: VC.V1.fields, numbersCurrent: true }, VC.V2.fields));
check("v1 to v2 was on identity, contact, branding and description", ["identity", "contact", "branding", "description"].every((k) => v1to2.basis.some((s) => s.kind === k)));
check("v2 has no EMAIL or URL (not set up yet)", !/^(EMAIL|URL)/m.test(unfold(VC.renderCard(VC.V2, phones))) && VC.V2.fields.email === undefined && VC.V2.fields.url === undefined);

// ---------------------------------------------------------------- 7. the proposed note (for Royce)

const note = VC.V2.memberNote ?? "";
check("note: short, one text, no question, no exclamation, no emoji", note.length > 0 && note.length <= 160 && !/[?!]/.test(note) && !/\p{Extended_Pictographic}/u.test(note));
check("note: never 'Noise's AI', never a role, never a changelog", !/noise'?s ai|\bmatchmak|\bassistant\b|\bconcierge\b|\bfeature|\bversion|\bshipp|\bupdate/i.test(note));
check("note: never claims it updates their contacts by itself", !/automatic|already (saved|updated)|updated your/i.test(note) && /Tap it/.test(note));

console.log(`contactCard: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
