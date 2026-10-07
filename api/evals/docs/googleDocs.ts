// Saving a document as a Google Doc (services/googleDocs.ts, documentDelivery.ts google_docs, agent/loopTools.ts saveTo).
// Layer 1: fake Google, fake Sendblue; no network.   npx tsx evals/docs/googleDocs.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const GD = await import("../../src/services/googleDocs.js");
const GA = await import("../../src/services/googleAuth.js");
const X = await import("../../src/services/documentDelivery.js");
const D = await import("../../src/services/documentSheet.js");
const L = await import("../../src/agent/loopTools.js");
const Cap = await import("../../src/services/capabilities.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

const doc = D.resolveDocument({ title: "Co: Product positioning & scaling", note: "From today.", sections: [{ heading: "What separates us", bullets: ["We match inside the event.", "<b>bold</b> stays text"] }], suggestions: ["An idea of Co's."] });

// ---- the scope: the narrowest Drive scope, and only it
check("Co asks for drive.file and nothing wider in Drive (never drive, drive.readonly or documents)", GA.GOOGLE_SCOPES.includes(GD.DRIVE_FILE_SCOPE as any) && !GA.GOOGLE_SCOPES.some((s) => /auth\/(drive|drive\.readonly|documents)$/.test(s)));
check("a grant of exactly what Co asked for is kept; one with drive.file left off still is", GA.scopesAllowed(GA.GOOGLE_SCOPES.join(" ")) && GA.scopesAllowed("https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/gmail.metadata"));
check("a grant wider than asked (full Drive) is refused", !GA.scopesAllowed(`${GA.GOOGLE_SCOPES.join(" ")} https://www.googleapis.com/auth/drive`));
check("Docs only when they allowed it on Google's screen", GA.canCreateDocs([GD.DRIVE_FILE_SCOPE]) && !GA.canCreateDocs(["https://www.googleapis.com/auth/calendar.freebusy"]));

// ---- the Doc
const html = GD.docsHtml(doc, { firstName: "Royce", date: "October 8, 2026" });
check("the Doc carries the title, who and when, the sections as headings and bullets", /<h1>Co: Product positioning &amp; scaling<\/h1>/.test(html) && /Prepared for Royce, October 8, 2026/.test(html) && /<h2>What separates us<\/h2><ul><li>We match inside the event\.<\/li>/.test(html));
check("Co's suggestions are under their own heading, apart from the member's points", /<h2>Co's suggestions<\/h2><ul><li>An idea of Co&#39;s\.<\/li><\/ul>/.test(html) && html.indexOf("suggestions") > html.indexOf("What separates us"));
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
  const boom: any = async () => { throw new Error("net"); };
  check("upload: no answer is a plain failure", (await GD.uploadGoogleDoc("tok", "Name", "<p>x</p>", boom)).ok === false);
}

// ---- delivery
{
  const texts: any[] = [];
  const deps = (o: { token?: string | null; up?: any } = {}): any => ({
    render: async () => Buffer.alloc(2000, 1),
    cache: (_b: Buffer, n?: string) => `https://x.test/plan-file/abc/${n}`,
    send: async (m: any) => { texts.push(m); return {}; },
    from: "+15550000000",
    googleToken: async () => (o.token === undefined ? "tok" : o.token),
    uploadDoc: async (_t: string, name: string) => o.up ?? { ok: true, id: "abc", link: `https://docs.google.com/document/d/abc/edit#${name}` },
  });
  const to = { userId: "u1", firstName: "Royce", phone: "+15550100001", zone: "America/Los_Angeles", now: new Date("2026-10-08T18:00:00Z") };
  const r = await X.deliverDocument(doc, to, "google_docs", deps());
  check("google_docs: made in their Drive, named like the PDF (without .pdf), and the link texted with the title", r.ok && r.via === "google_docs" && r.filename === "Co-Product-Positioning-Scaling-2026-10-08" && /docs\.google\.com/.test(texts[0]?.content) && texts[0].content.startsWith(doc.title) && !texts[0].media_url, { r, t: texts[0] });
  const nc = await X.deliverDocument(doc, to, "google_docs", deps({ token: null }));
  check("google_docs: not connected (or Docs not allowed) fails plainly, marked so the PDF can go instead", !nc.ok && (nc as any).notConnected === true);
  const bad = await X.deliverDocument(doc, to, "google_docs", deps({ up: { ok: false, why: "Google didn't take the document" } }));
  check("google_docs: Google refusing is a plain failure", !bad.ok && /didn't take/.test((bad as any).why));
  check("the delivery seam has both targets now", Object.keys(X.DELIVERERS).sort().join() === "google_docs,pdf_text");
  check("the real token comes only when Google is set up AND they allowed Docs", /googleConfigured\(\) && g\.canCreateDocs\(\(await g\.isConnected\(userId\)\)\.scopes\)/.test(src("services/documentDelivery.ts")));
}

// ---- the tool: a Google Doc only when they asked, the PDF otherwise
{
  const asks = ["Can you put this in a Google Doc?", "save it to my google drive", "make it a gdoc", "send me the google docs version", "put it in my Drive"];
  const not = ["Can you make me a pdf?", "send it again", "the doc looks good", "what about Google Calendar?"];
  check("their words asking for a Google Doc", asks.every((t) => L.GOOGLE_DOC_ASK.test(t)), asks.filter((t) => !L.GOOGLE_DOC_ASK.test(t)));
  check("and not otherwise (a PDF, a resend, a calendar)", not.every((t) => !L.GOOGLE_DOC_ASK.test(t)), not.filter((t) => L.GOOGLE_DOC_ASK.test(t)));
  const lt = src("agent/loopTools.ts");
  check("the tool: google_doc only when they asked in their own words (code checks the words, not Co's say-so)", /const wantsGoogle = \(input\.saveTo === "google_doc" \|\| input\.saveTo === "both"\) && GOOGLE_DOC_ASK\.test\(theirWords\(\)\)/.test(lt));
  check("the tool: not connected means the PDF goes instead and Co offers to connect Google", /if \(!targets\.includes\("pdf_text"\)\) results\.push\(await deliverDocument\(doc, to, "pdf_text"\)\)/.test(lt) && /offer to send the link to connect Google \(googleConnection\)/.test(lt));
  check("the tool: still one write, the same grounding (their words) before anything is made", lt.indexOf("documentProblems(doc, source)") < lt.indexOf("const wantsGoogle"));
  const w = Cap.ABILITIES.find((a) => a.id === "write_document")!;
  check("registry: Co knows it can save a Google Doc when they ask and are connected, and no longer says it can't", /save it as an editable Google Doc in their own Drive/.test(w.can) && !/Google Docs yet/.test(w.can) && /set saveTo to google_doc/.test(w.use ?? ""));
}

// ---- the connect pages are served where Co runs
{
  const coTest = fs.readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8");
  check("co-test mounts the Google connect pages (it runs its own server file; the link 404ed there before)", /app\.use\("\/google", createGoogleRouter\(\)\)/.test(coTest) && /app\.use\("\/google", createGoogleRouter\(\)\)/.test(src("server.ts")));
  check("the connected page tells them about Docs, and that Co sees only the files it creates", /save a document you ask for as a Google Doc in your Drive \(Co sees only the files it creates\)/.test(src("routes/google.ts")));
}

console.log(`google docs: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
