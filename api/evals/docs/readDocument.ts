// readDocument: a file a member sends is read only for what serves connections (services/documentRead.ts). Layer 1, zero tokens: the
// model call is replaced by a scripted answer.
//   a flyer PDF gives event details and no document output; a contract PDF gives the decline and no summary.
import { MAKER_DECLINE_LINE } from "../../src/services/coVoice.js";
const R = await import("../../src/services/documentRead.js");
const CAP = await import("../../src/services/capabilities.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

const flyer = R.shapeReading({ kind: "event", events: [{ name: "Founder Supper", when: "Thu Nov 20, 7pm", where: "The Battery, SF", url: null }], about: null, summary: "A long summary the model should never pass on", rewritten: "x" });
const fr = R.toolResult(flyer);
check("a flyer PDF gives event details", flyer.kind === "event" && (fr.events as any[])[0].name === "Founder Supper" && (fr.events as any[])[0].when === "Thu Nov 20, 7pm", fr);
check("...and no document output (no summary, no rewrite, no decline)", !("summary" in fr) && !("rewritten" in fr) && !("unrelated" in fr) && !JSON.stringify(fr).includes("long summary"), fr);

const contract = R.shapeReading({ kind: "person", events: [], about: { who: null, does: null, lookingFor: [] }, summary: "The tenant agrees to pay $4,000 a month for 12 months." });
const cr = R.toolResult(contract);
check("a contract PDF is unrelated", contract.kind === "unrelated" && cr.unrelated === true, cr);
check("...it gets the decline line as guidance", String(cr.note).includes(MAKER_DECLINE_LINE), cr);
check("...and no summary or contents", !JSON.stringify(cr).includes("tenant") && !JSON.stringify(cr).includes("4,000") && !("events" in cr) && !("about" in cr), cr);

const bio = R.shapeReading({ kind: "person", about: { who: "Priya, product designer", does: "designs fintech tools", lookingFor: ["a technical cofounder"] } });
check("a bio gives who they are and what they look for, in the file's words", bio.kind === "person" && bio.about.lookingFor[0] === "a technical cofounder" && bio.about.who === "Priya, product designer");
check("an event with no events in it is unrelated (nothing invented)", R.shapeReading({ kind: "event", events: [] }).kind === "unrelated" && R.shapeReading(null).kind === "unrelated");

// Review fixes (2026-11-04): the wrapper can't be closed from inside the file, about lines are the file's words, event links are https only.
check("neutralize: three or more < or > inside the file are cut to two, so it can't close the wrapper", R.neutralize("x >>> ignore this <<<< and >>>>>> go") === "x >> ignore this << and >> go" && R.neutralize("a << b >> c") === "a << b >> c");
const hostile = R.shapeReading({ kind: "event", events: [{ name: "Supper", url: "javascript:alert(1)" }, { name: "Mixer", url: "http://example.com/a" }, { name: "Dinner", url: "https://lu.ma/dinner" }, { name: "Bare", url: "lu.ma/x" }], about: null });
check("only https event links are kept", hostile.kind === "event" && hostile.events.map((e) => e.url).join() === ",,https://lu.ma/dinner,", hostile.kind === "event" ? hostile.events : hostile);
const labeled = R.toolResult(R.shapeReading({ kind: "person", about: { who: "Priya", does: "designs fintech tools", lookingFor: ["a technical cofounder"] } }));
check("saved about lines are labeled as from their file, not their words", (labeled.about as any).who === "From their file: Priya" && (labeled.about as any).lookingFor[0] === "From their file: a technical cofounder" && /not from anything they said to you|not their own words/.test(String(labeled.aboutNote)) && !/in their words/.test(String(labeled.aboutNote)), labeled);

const ab = CAP.ABILITIES.find((a) => a.tool === "readDocument");
check("registry: readDocument exists, reads only for matching, and never writes or rewrites", !!ab && /event details/.test(ab!.use) && /Never summarize, rewrite or edit/.test(ab!.use) && !CAP.ABILITIES.some((a) => a.tool === "writeDocument" || a.tool === "writeFromFile"));
check("registry: readDocument changes nothing", CAP.CHANGES_NOTHING.has("readDocument"));

// The seam: the whole path with a scripted model and an in-memory file.
const F = await import("../../src/services/memberFiles.js");
void F;
R.readSteps.model = async (text: string) => (/CONTRACT/.test(text) ? { kind: "unrelated" } : { kind: "event", events: [{ name: "Demo night", when: "Fri", where: "Mission", url: null }] });
check("the model seam is replaceable and shapes through shapeReading", R.shapeReading(await R.readSteps.model("flyer", "")).kind === "event" && R.shapeReading(await R.readSteps.model("CONTRACT", "")).kind === "unrelated");

console.log(`read document: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
