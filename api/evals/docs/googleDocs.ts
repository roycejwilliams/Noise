// Saving a document as a Google Doc (services/googleDocs.ts, documentDelivery.ts google_docs, agent/loopTools.ts saveTo).
// Layer 1: fake Google, fake Sendblue; no network.   npx tsx evals/docs/googleDocs.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const GD = await import("../../src/services/googleDocs.js");
const GA = await import("../../src/services/googleAuth.js");
const CG = await import("../../src/services/cueGrants.js");
const X = await import("../../src/services/documentDelivery.js");
const D = await import("../../src/services/documentSheet.js");
const L = await import("../../src/agent/loopTools.js");
const Cap = await import("../../src/services/capabilities.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

const doc = D.resolveDocument({ title: "Cue: Product positioning & scaling", note: "From today.", kind: "partnership_plan", sections: [{ heading: "What separates us", bullets: ["We match inside the event.", "<b>bold</b> stays text"] }], suggestions: ["An idea of Cue's."] });
const PAIR = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
process.env.GOOGLE_DOCS_TEST_USERS = PAIR.join(",");

// ---- the scope: the narrowest Drive scope, and only it, on its own grant (Royce, 2026-10-15: "drive.file gets its own grant in the
// published project, same pattern as the calendar split")
check("the Docs grant asks for drive.file and nothing wider in Drive (never drive, drive.readonly or documents)", JSON.stringify(CG.DOCS_SCOPES) === JSON.stringify([GD.DRIVE_FILE_SCOPE]) && new URL(CG.grantAuthUrl("docs", "st", "ch")).searchParams.get("scope") === GD.DRIVE_FILE_SCOPE);
check("a Docs grant of exactly drive.file is kept; anything wider or else is refused", CG.scopeOnly("docs", GD.DRIVE_FILE_SCOPE) && !CG.scopeOnly("docs", `${GD.DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive`) && !CG.scopeOnly("docs", "https://www.googleapis.com/auth/calendar.freebusy") && !CG.scopeOnly("docs", ""));
// ---- the Doc
const html = GD.docsHtml(doc, { firstName: "Royce", date: "October 8, 2026" });
check("the Doc carries the title, who and when, the sections as headings and bullets", /<h1>Cue: Product positioning &amp; scaling<\/h1>/.test(html) && /Prepared for Royce, October 8, 2026/.test(html) && /<h2>What separates us<\/h2><ul><li>We match inside the event\.<\/li>/.test(html));
check("Cue's suggestions are under their own heading, apart from the member's points", /<h2>Cue's suggestions<\/h2><ul><li>An idea of Cue&#39;s\.<\/li><\/ul>/.test(html) && html.indexOf("suggestions") > html.indexOf("What separates us"));
check("nothing from the text becomes markup", !/<b>bold/.test(html) && /&lt;b&gt;bold/.test(html));
const body = GD.multipartBody("Co-Product-2026-10-08", html, "BND");
check("the upload is one multipart body: metadata asking for a Google Doc, then the HTML", /^--BND\r\nContent-Type: application\/json/.test(body) && /"mimeType":"application\/vnd.google-apps.document"/.test(body) && /\r\n--BND\r\nContent-Type: text\/html/.test(body) && body.endsWith("--BND--"));
{
  let seen: any = null;
  const okFetch: any = async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ id: "abc123", webViewLink: "https://docs.google.com/document/d/abc123/edit" }) }; };
  const up = await GD.uploadGoogleDoc("tok", "Name", "<p>x</p>", okFetch);
  check("upload: to Drive's multipart endpoint, with their token, returning the Doc's link", up.ok && up.link.endsWith("/abc123/edit") && /upload\/drive\/v3\/files\?uploadType=multipart/.test(seen.url) && seen.init.headers.Authorization === "Bearer tok" && /multipart\/related; boundary=/.test(seen.init.headers["Content-Type"]));
  const denied: any = async () => ({ ok: false, status: 403, json: async () => ({ error: {} }) });
  const d = await GD.uploadGoogleDoc("tok", "Name", "<p>x</p>", denied);
  check("upload: a refusal says to reconnect and allow Docs", !d.ok && /reconnect Google and allow Docs/.test((d as any).why));
  let shareSeen: any = null;
  const shareOk: any = async (url: string, init: any) => { shareSeen = { url, init }; return { ok: true, status: 200, json: async () => ({ id: "anyoneWithLink" }) }; };
  const sh = await GD.shareWithLink("tok", "abc123", shareOk);
  const shareBody = JSON.parse(shareSeen.init.body);
  check("share: one permission on that file only, anyone with the link as an editor, never discoverable in search", sh.ok && /drive\/v3\/files\/abc123\/permissions/.test(shareSeen.url) && shareSeen.init.method === "POST" && shareBody.role === "writer" && shareBody.type === "anyone" && shareBody.allowFileDiscovery === false && shareSeen.init.headers.Authorization === "Bearer tok");
  const shareNo: any = async () => ({ ok: false, status: 403, json: async () => ({}) });
  check("share: a Workspace refusal is a plain failure", (await GD.shareWithLink("tok", "abc123", shareNo)).ok === false);
  const boom: any = async () => { throw new Error("net"); };
  check("upload: no answer is a plain failure", (await GD.uploadGoogleDoc("tok", "Name", "<p>x</p>", boom)).ok === false);
}

// ---- delivery
{
  const texts: any[] = [];
  const deps = (o: { token?: string | null; up?: any; share?: any } = {}): any => ({
    render: async () => Buffer.alloc(2000, 1),
    cache: (_b: Buffer, n?: string) => `https://x.test/plan-file/abc/${n}`,
    send: async (m: any) => { texts.push(m); return {}; },
    from: "+15550000000",
    googleToken: async () => (o.token === undefined ? "tok" : o.token),
    uploadDoc: async (_t: string, name: string) => { uploads.push(name); return o.up ?? { ok: true, id: "abc", link: `https://docs.google.com/document/d/abc/edit#${name}` }; },
    shareDoc: async (_t: string, id: string) => { shares.push(id); return o.share ?? { ok: true }; },
  });
  const uploads: string[] = [];
  const shares: string[] = [];
  // They asked to share it (security review, 2026-10-11: link sharing needs their words; evals/security/reviewFixes.ts covers the private default).
  const to = { userId: PAIR[0], firstName: "Royce", phone: "+15550100001", zone: "America/Los_Angeles", now: new Date("2026-10-08T18:00:00Z"), shareByLink: true };
  const r = await X.deliverDocument(doc, to, "google_docs", deps());
  check("google_docs: made in their Drive, named like the PDF (without .pdf), and the link texted with the title", r.ok && r.via === "google_docs" && r.filename === "Cue-Product-Positioning-Scaling-2026-10-08" && /docs\.google\.com/.test(texts[0]?.content) && texts[0].content.startsWith(doc.title) && !texts[0].media_url, { r, t: texts[0] });
  const nc = await X.deliverDocument(doc, to, "google_docs", deps({ token: null }));
  check("google_docs: Docs not connected fails plainly, marked so the PDF can go instead", !nc.ok && (nc as any).notConnected === true);
  const bad = await X.deliverDocument(doc, to, "google_docs", deps({ up: { ok: false, why: "Google didn't take the document" } }));
  check("google_docs: Google refusing is a plain failure", !bad.ok && /didn't take/.test((bad as any).why));
  check("google_docs: asked to share, the Doc is opened to anyone with the link (the one it just made), and the text says so", (r as any).shared === true && shares.join() === "abc" && /Anyone with this link can open and edit it\./.test(texts[0]?.content));
  texts.length = 0;
  const priv = await X.deliverDocument(doc, to, "google_docs", deps({ share: { ok: false, why: "their Google account doesn't allow link sharing" } }));
  check("google_docs: a Workspace that refuses link sharing leaves it private, still sent, and the text says only they can open it", priv.ok && (priv as any).shared === false && /Only you can open it/.test(texts[0]?.content) && !/Anyone with this link/.test(texts[0]?.content));
  // the scope (with GOOGLE_DOCS_TEST_USERS set, as here): those members only, and shared working artifacts only, re-checked in the deliverer
  for (const [label, who, kind] of [["a member outside the test pair", "33333333-3333-4333-8333-333333333333", "partnership_plan"], ["a goal plan (kind other), even for the pair", PAIR[1], "other"], ["no kind given", PAIR[1], undefined]] as const) {
    uploads.length = 0; texts.length = 0;
    const d0 = D.resolveDocument({ title: "T", kind, sections: [{ bullets: ["x"] }] } as any);
    const res = await X.deliverDocument(d0, { ...to, userId: who }, "google_docs", deps());
    check(`google_docs refused for ${label}: nothing made in Drive, nothing texted, marked so the PDF goes instead`, !res.ok && (res as any).notAllowed === true && uploads.length === 0 && texts.length === 0);
  }
  check("the second member of the pair gets one too, for each shared kind", (["partnership_plan", "partnership_plan", "readout"] as const).every((k) => X.googleDocAllowed(PAIR[1], k)));
  check("the test pair: user ids only, at most two, junk ignored", X.docsTestPair({ GOOGLE_DOCS_TEST_USERS: ` ${PAIR[0]} ,not-an-id,${PAIR[1]},44444444-4444-4444-8444-444444444444` } as any).join() === PAIR.join() && X.docsTestPair({} as any).length === 0);
  check("with no list set, any member may get a Google Doc for a shared kind (their connected Google is the gate)", X.googleDocAllowed("33333333-3333-4333-8333-333333333333", "readout", {} as any) && !X.googleDocAllowed("33333333-3333-4333-8333-333333333333", "other", {} as any));
  check("with no list set, docTargets sends a shared kind to Google for anyone who asked", X.docTargets({ userId: "33333333-3333-4333-8333-333333333333", kind: "partnership_plan", saveTo: "google_doc", askedForGoogle: true, env: {} as any }).targets.join() === "google_docs");
  check("with the list set, it narrows to those members", !X.googleDocAllowed("33333333-3333-4333-8333-333333333333", "readout", { GOOGLE_DOCS_TEST_USERS: PAIR.join(",") } as any) && X.googleDocAllowed(PAIR[0], "readout", { GOOGLE_DOCS_TEST_USERS: PAIR.join(",") } as any));
  const T = (o: any) => X.docTargets({ userId: PAIR[0], kind: "partnership_plan", saveTo: "google_doc", askedForGoogle: true, ...o });
  check("targets: pair + shared kind + they asked = the Google Doc", T({}).targets.join() === "google_docs" && T({ saveTo: "both" }).targets.join() === "google_docs,pdf_text" && T({}).googleRefused === null);
  check("targets: Cue setting saveTo without their words is the PDF", T({ askedForGoogle: false }).targets.join() === "pdf_text" && T({ askedForGoogle: false }).googleRefused === null);
  check("targets: outside the pair is the PDF, refused as not yet (never says why it's a pair)", T({ userId: "33333333-3333-4333-8333-333333333333" }).targets.join() === "pdf_text" && T({ userId: "33333333-3333-4333-8333-333333333333" }).googleRefused === "not_yet");
  check("targets: their own goals (other) is the PDF, refused for its kind", T({ kind: "other" }).targets.join() === "pdf_text" && T({ kind: "other" }).googleRefused === "kind");
  check("a document with no kind, or a made-up one, is 'other'", D.resolveDocument({ title: "T", sections: [] }).kind === "other" && D.resolveDocument({ title: "T", sections: [], kind: "goal_tracker" }).kind === "other" && D.resolveDocument({ title: "T", sections: [], kind: "readout" }).kind === "readout");
  check("the delivery seam has both targets now", Object.keys(X.DELIVERERS).sort().join() === "google_docs,pdf_text");
  check("the real token comes only from their Docs grant, on Cue's own client (never the combined Google grant)", /googleToken: async \(userId\) => \(g\.docsConfigured\(\) \? g\.docsToken\(userId\)/.test(src("services/documentDelivery.ts")) && /const g = await import\("\.\/cueGrants\.js"\)/.test(src("services/documentDelivery.ts")));
}

// ---- the tool: a Google Doc only when they asked, the PDF otherwise
{
  const asks = ["Can you put this in a Google Doc?", "save it to my google drive", "make it a gdoc", "send me the google docs version", "put it in my Drive"];
  const not = ["Can you make me a pdf?", "send it again", "the doc looks good", "what about Google Calendar?"];
  check("their words asking for a Google Doc", asks.every((t) => L.GOOGLE_DOC_ASK.test(t)), asks.filter((t) => !L.GOOGLE_DOC_ASK.test(t)));
  check("and not otherwise (a PDF, a resend, a calendar)", not.every((t) => !L.GOOGLE_DOC_ASK.test(t)), not.filter((t) => L.GOOGLE_DOC_ASK.test(t)));
  const lt = src("agent/loopTools.ts");
  check("the tool: google_doc only when they asked in their own words (code checks the words, not Cue's say-so), routed by docTargets", /docTargets\(\{ userId: ctx\.userId, kind: doc\.kind, saveTo: input\.saveTo, askedForGoogle: GOOGLE_DOC_ASK\.test\(theirWords\(\)\) \}\)/.test(lt));
  // The delivery loop is shared with a task keeping a promise (services/documentDelivery.ts deliverToTargets).
  const dd = src("services/documentDelivery.ts");
  check("the tool: not connected, or not allowed, means the PDF goes instead; Cue offers to connect Google only when it's the connection", /\(r\.notConnected \|\| r\.notAllowed\)/.test(dd) && /if \(!targets\.includes\("pdf_text"\)\) results\.push\(await deliver\(doc, asPdfInstead, "pdf_text"\)\)/.test(dd) && /deliverAndRecord\(doc, to, \{ saveTo: input\.saveTo, askedForGoogle: GOOGLE_DOC_ASK\.test\(theirWords\(\)\)/.test(lt) && /offer to send the link to connect Google Docs \(docsConnection\)/.test(lt));
  check("the tool: still one write, the same grounding (their words) before anything is made", lt.indexOf("documentProblems(doc, source)") < lt.indexOf("docTargets({"));
  const w = Cap.ABILITIES.find((a) => a.id === "write_document")!;
  check("registry: Cue knows it can save a Google Doc when they ask and are connected, and no longer says it can't", /save it as an editable Google Doc in their own Drive/.test(w.can) && /venue brief, a partnership plan or an event readout/.test(w.can) && !/Google Docs yet/.test(w.can) && /set saveTo to google_doc/.test(w.use ?? ""));
}

// ---- the connect pages are served where Co runs
{
  const coTest = fs.readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8");
  check("co-test mounts the Google connect pages (it runs its own server file; the link 404ed there before)", /app\.use\("\/google", createGoogleRouter\(\)\)/.test(coTest) && /app\.use\("\/google", createGoogleRouter\(\)\)/.test(src("server.ts")));
  check("the Docs grant's pages say it saves only what Cue makes and sees only those (the combined grant's page no longer mentions Docs)", /Cue will save documents it makes for you into your Google Drive, and see only those\./.test(src("routes/google.ts")) && !/as a Google Doc in your Drive/.test(src("routes/google.ts")));
}

console.log(`google docs: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
