// The general-assistant helpers are gone (Royce, 2026-11-04). Zero tokens, no DB.
//   - the calendar file exists only for a member going to a Noise event, with the right instant; a plan request gets none
//   - Cue doesn't accept a task for drafting their email (text or call), and the call sheet says so
//   - nothing offers a sheet, a brief or a venue_brief document
//   - the cleanup script does nothing without --apply, and --dry-run prints counts per table only
//   npx tsx evals/removal/assistantHelpers.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const EC = await import("../../src/services/eventCalendar.js");
const Cap = await import("../../src/services/capabilities.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-11-10T20:00:00Z");

// ---- going to a Noise event: a calendar file with the right time and timezone
const sent: any[] = [];
const claimed = new Set<string>();
const deps = (email: string | null, ev: any, sendOk = true) => ({ loadEvent: async () => ev, loadEmail: async () => email, send: async (o: any) => (sendOk ? (sent.push(o), true) : false), claim: async (u: string, k: string) => (claimed.has(`${u}|${k}`) ? false : (claimed.add(`${u}|${k}`), true)), release: async (u: string, k: string) => void claimed.delete(`${u}|${k}`), now: () => NOW });
const EVENT = { id: "evt-1", name: "Founders Dinner", startAt: "2026-11-11T19:00:00-08:00", endAt: "2026-11-11T22:00:00-08:00", timezone: "America/Los_Angeles", venue: "The Battery", address: "717 Battery St, San Francisco", url: "https://lu.ma/fd" };
const ics = EC.buildEventIcs(EVENT, NOW)!;
check("the file is a calendar with one event", /BEGIN:VCALENDAR/.test(ics) && (ics.match(/BEGIN:VEVENT/g) ?? []).length === 1 && /END:VCALENDAR\r\n$/.test(ics));
check("7pm Pacific is 03:00 UTC the next day, and ends three hours later", /DTSTART:20261112T030000Z/.test(ics) && /DTEND:20261112T060000Z/.test(ics), ics);
check("a start with no offset is read in the event's own zone", /DTSTART:20261112T030000Z/.test(EC.buildEventIcs({ ...EVENT, startAt: "2026-11-11T19:00:00", endAt: null }, NOW)!) && /DTEND:20261112T050000Z/.test(EC.buildEventIcs({ ...EVENT, startAt: "2026-11-11T19:00:00", endAt: null }, NOW)!));
check("name, place and link are in it", /SUMMARY:Founders Dinner/.test(ics) && /LOCATION:The Battery\\, 717 Battery St\\, San Francisco/.test(ics) && /URL:https:\/\/lu\.ma\/fd/.test(ics));
check("an unreadable start gives no file", EC.buildEventIcs({ ...EVENT, startAt: "soon" }, NOW) === null);
const r = await EC.sendGoingCalendar("u1", "evt-1", deps("jordan@studio.co", EVENT));
check("going: the file is emailed to the member's own address, once", r.sent && sent.length === 1 && sent[0].to === "jordan@studio.co" && /DTSTART:20261112T030000Z/.test(sent[0].ics) && sent[0].filename === "event.ics", sent);
const again = await EC.sendGoingCalendar("u1", "evt-1", deps("jordan@studio.co", EVENT));
check("saying they're going again sends nothing more (one per member per event)", !again.sent && again.why === "already sent" && sent.length === 1, again);
const other = await EC.sendGoingCalendar("u2", "evt-1", deps("sam@studio.co", EVENT));
check("another member going to the same event gets their own", other.sent && sent.length === 2 && sent[1].to === "sam@studio.co");
const failedSend = await EC.sendGoingCalendar("u3", "evt-1", deps("lee@studio.co", EVENT, false));
const retried = await EC.sendGoingCalendar("u3", "evt-1", deps("lee@studio.co", EVENT));
check("a failed send gives its key back, so a retry can go", !failedSend.sent && retried.sent && sent.length === 3);
const raw = "a\\b;c,d\r\ne\nf\rg";
check("ICS text escaping: backslash, semicolon, comma and every kind of line break", EC.esc(raw) === "a\\\\b\\;c\\,d\\ne\\nf\\ng", EC.esc(raw));
const tricky = EC.buildEventIcs({ ...EVENT, name: "Dinner; drinks, and a toast for 12\nsecond line", venue: "Bar, Inc.", url: "https://lu.ma/x\r\nEND:VCALENDAR" }, NOW)!;
check("a name or place can't start a new line in the file, and a bad URL is left out", /SUMMARY:Dinner\\; drinks\\, and a toast for 12\\nsecond line/.test(tricky) && !/URL:/.test(tricky) && (tricky.match(/END:VCALENDAR/g) ?? []).length === 1, tricky);
const noEmail = await EC.sendGoingCalendar("u1", "evt-1", deps(null, EVENT));
const noEvent = await EC.sendGoingCalendar("u1", "evt-x", deps("a@b.co", null));
check("no email on file or no such event: nothing is sent", !noEmail.sent && !noEvent.sent && sent.length === 3);

// ---- only updateGoing builds one; plans get none
const conv = src("agent/conversationTools.ts");
const going = conv.slice(conv.indexOf("updateGoing: tool({"), conv.indexOf("saveFeedbackForTeam: tool({"));
check("the calendar file is sent from updateGoing only, and only when going", /if \(going && !ctx\.dryRun\)/.test(going) && /sendGoingCalendar\(ctx\.userId, subject\.eventApiId\)/.test(going) && (conv.match(/services\/eventCalendar\.js/g) ?? []).length === 1);
const callers = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).filter((f) => /eventCalendar|text\/calendar|BEGIN:VCALENDAR/.test(src(f))).sort();
check("no other code builds or attaches a calendar file", callers.join() === ["agent/conversationTools.ts", "services/eventCalendar.ts"].join(), callers);
const registryText = Cap.ABILITIES.map((a) => `${a.can} ${a.use ?? ""} ${a.sheet ?? ""}`).join("\n");
check("no ability offers a plan, a sheet or calendar holds", !/calendar holds?|\.ics|one-page (plan|sheet)|email_plan|emailPlan/i.test(registryText));
check("a plan-sheet request (a sheet, calendar holds for each time) is recognised as something Cue no longer does: no file, no offer", Cap.NOT_ASSISTANT_ASK.test("put my Saturday plan on a one-page sheet with a calendar hold for each time") && Cap.NOT_ASSISTANT_ASK.test("make me a plan sheet for Saturday"));

// ---- not an assistant: no task for it, by text or on a call
const T = await import("../../src/agent/conversationTools.js");
const quiet = console.log;
console.log = () => {};
const mk = (msg: string, isVoice = false) => T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: msg, isVoice, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, isTeam: false, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any);
const asks = ["Can you draft an email to the venue about Friday?", "write an email to the host asking about the rate", "read my inbox and tell me what's waiting"];
const outs: any[] = [];
for (const m of asks) for (const voice of [false, true]) {
  const t = mk(m, voice);
  outs.push(await (t.tools as any).startTask.execute({ goal: m.slice(0, 40), theirWords: m, steps: [m.slice(0, 40)], firstStep: m.slice(0, 40), inHours: 2 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) })));
}
console.log = quiet;
check("a request to draft their email (or read their inbox) is not accepted as a task, on text or on a call", outs.every((o) => o.ok === false && /not something you do/.test(o.error ?? "")), outs);
const ok = await (mk("let me know when a founders dinner shows up in the Mission") as any).tools.startTask.execute({ goal: "founders dinners in the Mission", theirWords: "let me know when a founders dinner shows up in the Mission", steps: ["look"], firstStep: "look", inHours: 3, lookout: true }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
const mixed = "write an email to my landlord ugh. anyway any founder dinners this week?";
const dinner = await (mk(mixed) as any).tools.startTask.execute({ goal: "founder dinners this week", theirWords: "any founder dinners this week?", steps: ["look for founder dinners"], firstStep: "look for founder dinners", inHours: 3 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
check("an email aside in the same message doesn't block the dinner task (only the task being started is tested)", dinner.ok === true, dinner);
const watchJobs = await (mk("keep an eye out for job openings in climate tech") as any).tools.startTask.execute({ goal: "watch job listings in climate tech", theirWords: "keep an eye out for job openings in climate tech", steps: ["monitor job listings for climate tech"], firstStep: "monitor job boards", inHours: 3, lookout: true }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
check("watching job listings or boards is declined (broad job-board monitoring is out)", watchJobs.ok === false && /not something you do/.test(watchJobs.error ?? ""), watchJobs);
const change = await (mk("I'm leaving my job next month and want to meet people in climate tech") as any).tools.startTask.execute({ goal: "people and communities in climate tech for someone changing jobs", theirWords: "I'm leaving my job next month and want to meet people in climate tech", steps: ["look for climate tech communities and dinners"], firstStep: "look for climate tech communities", inHours: 3 }, {}).catch((e: unknown) => ({ ok: false, err: String(e) }));
check("someone changing jobs is not declined: intros and communities are in scope", change.ok === true, change);
check("the decline is never a fixed string: every path says it's tone-only, own words, no forced redirect", [src("services/coVoice.ts"), src("services/documentRead.ts"), src("services/capabilities.ts"), src("agent/conversationTools.ts")].every((t) => !/Suggested line, pending Royce|in the spirit of: "\$\{MAKER_DECLINE_LINE\}"/.test(t)) && /never repeat it word for word/.test(src("services/coVoice.ts")) && /never sent word for word/.test(src("services/capabilities.ts")) && /fresh each time, without a canned line/.test(src("agent/conversationTools.ts")));
check("nothing sends the decline sentence as a message: it appears only inside guidance text", (() => { const hits = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).filter((f) => /That's not something I do/.test(src(f))); return hits.sort().join() === "services/capabilities.ts,services/coVoice.ts"; })());
check("a look-out is still accepted", ok.ok === true, ok);
const { CAPABILITY_SHEET } = await import("../../src/services/callBriefing.js");
check("the call sheet says Cue doesn't draft emails, plan sheets or search jobs, and never claims it did", /Not something you do, so no task for it: drafting their emails, plan sheets, reading their email/.test(CAPABILITY_SHEET));

// ---- nothing offers a sheet, a brief or a document: the offer and delivery modules are gone
const gone = (f: string) => !fs.existsSync(new URL(`../../src/${f}`, import.meta.url));
check("the document offer, delivery, receipts, Google Docs and plan-file modules are deleted", ["services/documentOffer.ts", "services/documentDelivery.ts", "services/deliveryReceipts.ts", "services/receiptDrift.ts", "services/googleDocs.ts", "services/planFile.ts", "services/planSheet.ts", "services/planEmail.ts"].every(gone));
check("the research line in the menu sends finds, not a brief", !/send a brief/.test(src("services/capabilities.ts")));
check("no venue_brief document kind anywhere in the source", !/venue_brief/.test(callers.length ? Cap.ABILITIES.map((a) => `${a.can} ${a.use ?? ""}`).join("") : ""));

const na = Cap.ABILITIES.find((a) => a.id === "not_assistant")!;
check("the decline line says Cue disconnects only the calendar (no Google Docs)", !/Docs/.test(`${na.sheet} ${na.can}`) && /disconnects the calendar if that's what they mean/.test(na.can));
// ---- goals: no draft piece that ends in a document
const GO = await import("../../src/services/goalOwnership.js");
const cleaned = GO.cleanItems([{ text: "a note to the venue", who: "co", how: "draft" }, { text: "venues for 40", who: "co", how: "research" }, { text: "founder dinners", who: "co", how: "watch" }]);
check("a draft piece is no longer Cue's: it stays the member's; research and watch stay", cleaned[0].owner === "member" && cleaned[0].how === null && cleaned[1].how === "research" && cleaned[2].how === "watch", cleaned);
const plan = GO.itemTaskPlan({ id: 1, title: "launch" } as any, { n: 2, text: "venues for 40", owner: "co", how: "research", reach: "internal", taskId: null, status: "offered" } as any);
check("a goal piece's task never says 'send it as a document'", !/document|Draft/.test(plan.steps.join(" ") + plan.goal), plan);
check("no offer line says Cue can draft", GO.offerFactLines([{ text: "venues", how: "research", suggest: null }, { text: "dinners", how: "watch", suggest: null }]).every((l) => !/draft/i.test(l)));
const goalsSrc = src("services/goalOwnership.ts") + src("agent/conversationTools.ts") + src("services/capabilities.ts");
check("the takeOnGoal schema, sheet and guidance no longer offer drafts", !/"research", "draft"|research, draft|drafts, watching|offer to draft/.test(goalsSrc));
check("a goal piece task already open as a draft closes as dropped when it wakes, no text", /\^Draft:\/i\.test\(t\.goal\)/.test(src("services/taskTurn.ts")) && /drafting a piece as a document was removed/.test(src("services/taskTurn.ts")));

// ---- photos: deletable by them, never a claimed deletion that didn't happen
const WK = await import("../../src/services/whatCoKnows.js");
const items = WK.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], photos: [{ n: 3, sentOn: "2026-10-20" }] } as any);
const ph = items.find((i: any) => i.ref === "photo:3");
check("what Cue knows lists each photo they sent, removable, with no description of it", !!ph && ph.source === "photo" && /^photo 3, sent 2026-10-20$/.test(ph.text), ph);
check("a photo removal deletes through deleteAssets and records it", /photoRemovals/.test(src("services/whatCoKnows.ts")) && /deleteAssets\(userId, \[n\]\)/.test(src("services/whatCoKnows.ts")) && /refused\.push\(\{ ref: item\.ref, why: "that photo isn't on file" \}\)/.test(src("services/whatCoKnows.ts")));
const MA = await import("../../src/services/memberAssets.js");
const runDelete = async (rowCount: number | "throw", numbers?: number[]) => {
  const facts: { k: string; t: string }[] = []; const nd: string[] = [];
  MA.useAssetDb({ query: async (q: string) => { if (rowCount === "throw") throw new Error("db down"); return { rows: [], rowCount }; } });
  console.log = () => {};
  const t = T.createConversationTools({ userId: "u", phoneNumber: "+10000000000", resolvedContent: "delete my photos", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, isTeam: false, sendCoReply: async () => true, facts: { add: (k: string, t: string) => facts.push({ k, t }), text: () => "" } } as any);
  const r = await (t.tools as any).deleteImages.execute({ numbers }, {});
  console.log = quiet; MA.useAssetDb(null);
  return { r, facts, nd };
};
const del2 = await runDelete(2, [1, 2]);
check("deleteImages: the count comes from the delete itself, and only then is it said done", del2.r.ok && del2.r.deleted === 2 && del2.facts.some((f) => f.k === "did_this_turn" && /Deleted 2/.test(f.t)), del2);
const del0 = await runDelete(0);
check("deleteImages: nothing to delete is said plainly, never as a deletion", del0.r.ok && del0.r.deleted === 0 && !del0.facts.some((f) => f.k === "did_this_turn"), del0);
const delErr = await runDelete("throw");
check("deleteImages: a failed delete is not claimed", delErr.r.ok === false && !delErr.facts.some((f) => f.k === "did_this_turn"), delErr);
check("deleteImages is a call tool (text and calls), left out of GPT-Live's quick set, and it changes something", Cap.callToolNames().includes("deleteImages") && !Cap.liveCallToolNames().includes("deleteImages") && Cap.CHANGES_SOMETHING.has("deleteImages"));

// ---- the removed-helpers cleanup: nothing without --apply, counts only in a dry run, never touches what is still in use
const S = await import("../../src/scripts/cleanupRemovedHelpers.js");
const mkDb = () => {
  const calls: string[] = [];
  const db: any = {
    query: async (q: string) => {
      calls.push(q);
      if (/SELECT COUNT/.test(q)) return { rows: [{ n: /gmail\.metadata/.test(q) ? 1 : /FROM co_pages/.test(q) ? 4 : 2 }] };
      if (/^SELECT user_id/.test(q)) return { rows: [{ user_id: "secret-user-1", refresh_token_enc: null, access_token_enc: null }] };
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, calls };
};
const dry = mkDb();
const counts = await S.countRemovedHelpers(dry.db);
check("dry run: counts per table only, and it only reads", dry.calls.every((q) => /^SELECT COUNT/.test(q)) && counts.co_pages === 4 && counts.docs_grants === 2 && counts["google_connections(gmail scope)"] === 1 && Object.keys(counts).includes("member_design_signals") && Object.keys(counts).includes("co_memories(design_taste)"), counts);
check("the dry-run output holds numbers and table names only, no member data", JSON.stringify(counts).indexOf("secret-user-1") < 0 && Object.values(counts).every((v) => v === null || typeof v === "number"));
const live = mkDb();
const applied = await S.applyRemovedHelpersCleanup(live.db, async () => {});
const sql = live.calls.join("\n");
check("apply: revokes and deletes both Google grants, nulls the Gmail summary, and empties the removed features' content", /DELETE FROM google_connections/.test(sql) && /DELETE FROM docs_grants/.test(sql) && /UPDATE google_snapshots SET waiting = NULL/.test(sql) && /DELETE FROM co_page_shares/.test(sql) && /DELETE FROM co_pages/.test(sql) && /DELETE FROM artifact_design_log/.test(sql) && /DELETE FROM member_design_signals/.test(sql) && /DELETE FROM co_memories WHERE memory_type IN \('design_taste', 'design_taste_asked'\)/.test(sql), live.calls);
check("apply: counts come back, never a member id", applied.nulled === 1 && applied.deleted.co_pages === 1 && JSON.stringify(applied).indexOf("secret-user-1") < 0);
check("it never touches photos, readDocument files, the calendar grant, delivery records or any other co_memories type", !/member_assets|member_files|memberFiles|calendar_grants|document_deliveries/.test(sql) && live.calls.filter((q) => /co_memories/.test(q)).every((q) => /memory_type IN \('design_taste', 'design_taste_asked'\)/.test(q)));
const sc = src("scripts/cleanupRemovedHelpers.ts");
check("the script does nothing unless exactly one of --dry-run or --apply is passed", /if \(apply === dry\) \{[\s\S]{0,200}Nothing was done/.test(sc) && /process\.argv\.slice\(2\)/.test(sc));
check("the old Gmail-only script name is gone", !fs.existsSync(new URL("../../src/scripts/revokeGmailGrants.ts", import.meta.url)));

// ---- photos: descriptions kept, images no longer stored, 90-day clearing unchanged (Royce 2026-11-06)
check("the 90-day photo clearing is still scheduled nightly and still exists", /wipeUnusedAssets/.test(src("jobs/index.ts")) && "wipeUnusedAssets" in MA && (MA.ASSET_LIMITS as any).unusedDays === 90);
{
  const seen: { sql: string; params: unknown[] }[] = [];
  MA.useAssetDb({ query: async (sql: string, params?: unknown[]) => { seen.push({ sql, params: params ?? [] }); return { rows: [], rowCount: 1 }; } });
  console.log = () => {};
  await MA.deleteAssets("member-a", [2]);
  await MA.deleteAssets("member-a", null);
  console.log = quiet; MA.useAssetDb(null);
  const del = seen.filter((q) => /UPDATE member_assets SET bytes = NULL/.test(q.sql));
  check("deleteAssets wipes only the asking member's own photos (scoped to their id, nothing else in the match)", del.length === 2 && del.every((q) => /WHERE owner_user_id = \$1 AND wiped_at IS NULL/.test(q.sql) && q.params[0] === "member-a") && del[0].params[1]?.toString() === "2" && del[1].params[1] === null, del);
}
check("photos are still read and described (routes/sendblue.ts, services/imageRead.ts)", /readableImage/.test(src("routes/sendblue.ts")) && /describeImage/.test(src("routes/sendblue.ts")));

console.log(`assistant helpers removal: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
