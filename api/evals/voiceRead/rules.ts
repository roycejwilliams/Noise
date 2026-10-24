// Layer 1 checks for the live voice read on calls (services/voiceRead.ts, services/mediaStreamBridge.ts,
// services/audioCodec.ts, 2026-10-23). Fakes only: a fake Hume socket, a fake Twilio stream, a fake clock and a fake
// model stream. No Hume, Twilio, ElevenLabs or model calls, no database, nothing sent.
//   npx tsx evals/voiceRead/rules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.ELEVENLABS_TOOL_SECRET ||= "test-tool-secret";
import { readFileSync } from "fs";
import { createHmac } from "crypto";
const V = await import("../../src/services/voiceRead.js");
const B = await import("../../src/services/mediaStreamBridge.js");
const C = await import("../../src/services/audioCodec.js");
const E = await import("../../src/harness/emotion.js");
const H = await import("../../src/services/heavyMoment.js");
const EL = await import("../../src/services/elevenLabsCalls.js");
const L = await import("../../src/services/voiceStreamLink.js");
const RG = await import("../../src/harness/replyGrounding.js");
const P = await import("../../src/services/callLlmProxy.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

// ---------------------------------------------------------------- the fork in the TwiML
const EL_TWIML = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="wss://api.us.elevenlabs.io/v1/convai/conversation/twilio?agent_id=x"><Parameter name="a" value="b"/></Stream></Connect></Response>`;
const STREAM = "wss://co-test.example.app/co/voice-stream";
const SID = "Zm9yLXRlc3RzLW9ubHktYW4tb3BhcXVlLXN0cmVhbS1pZA";
const forked = V.withVoiceFork(EL_TWIML, { streamUrl: STREAM, streamId: SID });
check("the fork is added", forked.includes(`<Start><Stream name="cue-voice-read" url="${STREAM}" track="inbound_track">`));
check("caller only: inbound_track, never both_tracks or outbound", /track="inbound_track"/.test(forked) && !/both_tracks|outbound_track/.test(forked));
check("the fork starts before ElevenLabs' <Connect> (Start doesn't block; Connect does)", forked.indexOf("<Start>") < forked.indexOf("<Connect>") && forked.indexOf("<Start>") > forked.indexOf("<Response>"));
check("ElevenLabs' TwiML is untouched apart from the fork", forked.replace(/<Start>.*?<\/Start>/, "") === EL_TWIML);
check("the stream carries one opaque id as its only Parameter (Twilio drops query strings)", (forked.match(/<Parameter /g) ?? []).length === 2 && forked.includes(`<Parameter name="stream" value="${SID}"/>`) && !/voice-stream\?/.test(forked));
check("values are XML-escaped", V.withVoiceFork(EL_TWIML, { streamUrl: STREAM, streamId: `a"><Hangup/>` }).includes("a&quot;&gt;&lt;Hangup/&gt;") && !V.withVoiceFork(EL_TWIML, { streamUrl: STREAM, streamId: `a"><Hangup/>` }).includes("<Hangup/>"));
check("no <Response> to place it in: returned exactly as given", V.withVoiceFork("<Say>hi</Say>", { streamUrl: STREAM, streamId: SID }) === "<Say>hi</Say>" && V.withVoiceFork("<Response/>", { streamUrl: STREAM, streamId: SID }) === "<Response/>");
check("the stream URL comes from API_URL", V.voiceStreamUrl("https://co-test.example.app") === STREAM && V.voiceStreamUrl("https://co-test.example.app/") === STREAM && V.voiceStreamUrl(undefined) === null && V.voiceStreamUrl("not a url") === null);

// ---------------------------------------------------------------- who it runs for
const TEST = "+14155550123";
const REAL = "+14155551234";
const env = (e: Record<string, string | undefined> = {}) => ({ RAILWAY_ENVIRONMENT_NAME: "co-test", HUME_API_KEY: "dummy", API_URL: "https://co-test.example.app", TWILIO_AUTH: "dummy-auth", ...e }) as NodeJS.ProcessEnv;
check("runs for a test number", V.voiceReadAllowed({ memberPhone: TEST, consented: false }, env()));
check("runs for a member who agreed (users.voice_read_ok)", V.voiceReadAllowed({ memberPhone: REAL, consented: true }, env()));
check("never for a real member who hasn't agreed", !V.voiceReadAllowed({ memberPhone: REAL, consented: false }, env()));
check("never in production, even for a test number or a member who agreed", !V.voiceReadAllowed({ memberPhone: TEST, consented: true }, env({ RAILWAY_ENVIRONMENT_NAME: "production" })));
check("not without the Hume key", !V.voiceReadAllowed({ memberPhone: TEST, consented: true }, env({ HUME_API_KEY: "" })));
check("not without API_URL or Twilio's token (it needs both)", !V.voiceReadAllowed({ memberPhone: TEST, consented: true }, env({ API_URL: "" })) && !V.voiceReadAllowed({ memberPhone: TEST, consented: true }, env({ TWILIO_AUTH: "" })));
check("no feature switch: only what it needs", !/VOICE_READ_ENABLED|VOICE_READ\s*===|env\.VOICE_READ\b/.test(readFileSync(new URL("../../src/services/voiceRead.ts", import.meta.url), "utf8")));
const links = L.memoryVoiceStreamLinks();
const fork = (phone: string, consented: boolean, e = env()) => EL.withVoiceReadFork(EL_TWIML, { userId: "11111111-2222-3333-4444-555555555555", callToken: "1761200000.deadbeefcafe", memberPhone: phone }, e, { consented: async () => consented, links });
const fTest = await fork(TEST, false);
check("the registered TwiML gets the fork for a test member", fTest.includes("<Start>"));
check("and for a member who agreed", (await fork(REAL, true)).includes("<Start>"));
check("never for a member who hasn't agreed (the team flag is not consent)", (await fork(REAL, false)) === EL_TWIML);
check("nothing without the key", (await fork(TEST, false, env({ HUME_API_KEY: undefined }))) === EL_TWIML);
check("Twilio's TwiML carries no member id and no call token", !fTest.includes("11111111-2222-3333-4444-555555555555") && !fTest.includes("deadbeefcafe") && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(fTest));
const issuedId = /<Parameter name="stream" value="([^"]+)"/.exec(fTest)?.[1] ?? "";
check("only the stream id's hash is stored, with the session's hash (never the token)", issuedId.length === 43 && !links.rows.has(issuedId) && links.rows.has(L.streamLinkHash(issuedId)) && [...links.rows.values()].every((r) => !JSON.stringify(r).includes("deadbeefcafe")));
check("a failed consent read or link write leaves the TwiML as it was", (await EL.withVoiceReadFork(EL_TWIML, { userId: "u", callToken: "t", memberPhone: REAL }, env(), { consented: async () => { throw new Error("db down"); }, links })) === EL_TWIML && (await EL.withVoiceReadFork(EL_TWIML, { userId: "u", callToken: "t", memberPhone: TEST }, env(), { links: { put: async () => { throw new Error("db down"); }, take: async () => null } })) === EL_TWIML);
check("it never fails the TwiML", (await EL.withVoiceReadFork(undefined as any, { userId: "u", callToken: "t", memberPhone: TEST }, env(), { links })) === undefined);
const linkNow = new Date("2026-10-23T18:00:00Z");
const lk = await L.issueVoiceStreamLink("u-x", "u-x:tok", links, linkNow);
check("a link is taken once", JSON.stringify(await L.takeVoiceStreamLink(lk, links, linkNow)) === JSON.stringify({ userId: "u-x", sessionHash: L.sessionHashOf("u-x:tok") }) && (await L.takeVoiceStreamLink(lk, links, linkNow)) === null);
const lk2 = await L.issueVoiceStreamLink("u-x", "u-x:tok", links, linkNow);
check("an expired link is refused (and gone)", (await L.takeVoiceStreamLink(lk2, links, new Date(linkNow.getTime() + (L.VOICE_STREAM_LINK_TTL_SECS + 1) * 1000))) === null && !links.rows.has(L.streamLinkHash(lk2)));
check("a malformed id is refused", (await L.takeVoiceStreamLink("u-x:tok", links, linkNow)) === null && (await L.takeVoiceStreamLink(undefined, links, linkNow)) === null);
const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
check("consent is a per-member column, default false, idempotent; nobody opted in by code", /ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_read_ok BOOLEAN NOT NULL DEFAULT false/.test(mig) && !/voice_read_ok\s*=\s*true/i.test(mig + readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8")));
check("the link table keeps hashes only", /CREATE TABLE IF NOT EXISTS voice_stream_links \(\s*id_hash TEXT PRIMARY KEY,\s*user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE,\s*session_hash TEXT NOT NULL/.test(mig));
const elSrc = readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8");
check("registerElevenLabsCall returns ElevenLabs' TwiML through the fork, with the member's own number per direction", /return withVoiceReadFork\(twiml, \{ userId: o\.userId, callToken, memberPhone: o\.direction === "inbound" \? o\.from : o\.to \}\)/.test(elSrc));
check("reads no old Hume EVI variables", !/HUME_CONFIG_ID|HUME_SIGNIN_KEY|HUME_SECRET_KEY|HUME_WEBHOOK|HUME_VOICE/.test(["voiceRead.ts", "mediaStreamBridge.ts", "audioCodec.ts", "elevenLabsCalls.ts"].map((f) => readFileSync(new URL(`../../src/services/${f}`, import.meta.url), "utf8")).join("\n")));

// ---------------------------------------------------------------- Twilio's signature on the stream
const sigEnv = env();
const sig = (url: string, secret = "dummy-auth") => createHmac("sha1", secret).update(url).digest("base64");
check("a stream signed over our wss URL is accepted", B.voiceStreamSignatureOk(sig(STREAM), sigEnv));
check("the https form of the same URL is accepted", B.voiceStreamSignatureOk(sig("https://co-test.example.app/co/voice-stream"), sigEnv));
check("a wrong signature is refused", !B.voiceStreamSignatureOk(sig(STREAM, "other-secret"), sigEnv) && !B.voiceStreamSignatureOk("bm90IGEgc2ln", sigEnv));
check("a signature over another host is refused", !B.voiceStreamSignatureOk(sig("wss://evil.example/co/voice-stream"), sigEnv));
check("no signature: refused", !B.voiceStreamSignatureOk(undefined, sigEnv));
check("fails closed without TWILIO_AUTH, in any environment", !B.voiceStreamSignatureOk(sig(STREAM), env({ TWILIO_AUTH: undefined, RAILWAY_ENVIRONMENT_NAME: "co-test" })));
check("only the voice stream path is handled", B.isVoiceStreamPath("/co/voice-stream") && !B.isVoiceStreamPath("/socket.io/?EIO=4") && !B.isVoiceStreamPath("/co/voice-streamx"));
const server = readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
const upg = server.slice(server.indexOf('httpServer.on("upgrade"'), server.indexOf('httpServer.on("upgrade"') + 900);
check("server.ts checks the signature before the upgrade", upg.indexOf("voiceStreamSignatureOk(") > 0 && upg.indexOf("voiceStreamSignatureOk(") < upg.indexOf("handleUpgrade(") && /socket\.destroy\(\)/.test(upg));

// ---------------------------------------------------------------- the codec
const dec = C.decodeMulawBuffer(Buffer.from([0xff, 0x7f, 0x00, 0x80]));
check("G.711 mu-law decode: 0xFF and 0x7F are silence, 0x00/0x80 the extremes", dec[0] === 0 && dec[1] === 0 && dec[2] === -32124 && dec[3] === 32124);
const frame = Buffer.alloc(160, 0xff); // one 20 ms Twilio frame
const pcm = C.mulaw8kToPcm16k(frame);
check("20 ms of 8 kHz mulaw becomes 20 ms of 16 kHz s16le (640 bytes, even)", pcm.length === 640 && pcm.length % 2 === 0 && Math.abs(C.pcm16kMs(pcm.length) - 20) < 0.01);
check("silence stays silence", pcm.every((b) => b === 0));
const ramp = C.resampleLinear(Int16Array.from([0, 100, 200]), 8000, 16000);
check("8k -> 16k interpolates between samples", ramp.length === 6 && ramp[0] === 0 && ramp[1] === 50 && ramp[2] === 100 && ramp[3] === 150);
const loud = C.mulaw8kToPcm16k(Buffer.from([0x00, 0x80]));
check("little-endian samples", loud.readInt16LE(0) === -32124 && loud.length === 8);

// ---------------------------------------------------------------- the rolling read
const W = (utt: number, startMs: number, endMs: number, receivedAt: number, ex: [string, number][] = [], va: [string, number][] = []) => ({ utteranceId: utt, startMs, endMs, receivedAt, expressions: ex.map(([name, probability]) => ({ name, probability })), voiceAttributes: va.map(([name, probability]) => ({ name, probability })) });
const NOW = 1_000_000;
const flatW = (i: number, p = 0.8) => W(0, i * 3000, i * 3000 + 3000, NOW - 1000, [["tiredness", p]], [["monotone", p]]);
check("Hume's names map to the five ways a voice can go", V.windowDims({ expressions: [{ name: "Excitement", probability: 0.9 }], voiceAttributes: [{ name: "flat", probability: 0.8 }] }).bright === 0.9 && V.windowDims({ expressions: [], voiceAttributes: [{ name: "flat", probability: 0.8 }] }).flat === 0.8);
check("unknown names are ignored (Hume may add names)", Object.values(V.windowDims({ expressions: [{ name: "brand new name", probability: 1 }], voiceAttributes: [] })).every((x) => x === 0));
check("never one window: a single strong window says nothing", V.rollingRead([flatW(0, 1)], NOW).strongest === null);
check("two windows still nothing", V.rollingRead([flatW(0, 1), flatW(1, 1)], NOW).strongest === null);
check("three steady windows: flat", V.rollingRead([flatW(0), flatW(1), flatW(2)], NOW).strongest === "flat");
const spike = [flatW(0, 1), W(0, 3000, 6000, NOW - 1000), W(0, 6000, 9000, NOW - 1000), W(0, 9000, 12000, NOW - 1000)];
check("a spike in one window is smoothed away", V.rollingRead(spike, NOW).strongest === null);
const unsteady = [flatW(0, 1), flatW(1, 1), flatW(2, 1), flatW(3, 0.3), flatW(4, 0.3), flatW(5, 0.3)];
check("strong on average but not steady: nothing", V.smooth(unsteady, 3).dims.flat >= V.VOICE_READ.bar && V.rollingRead(unsteady, NOW).strongest === null);
check("weak but steady: nothing (under the bar)", V.rollingRead([flatW(0, 0.5), flatW(1, 0.5), flatW(2, 0.55)], NOW).strongest === null);
const old = [flatW(0), flatW(1), flatW(2)];
const recentCalm = [W(0, 40_000, 43_000, NOW - 1000), W(0, 43_000, 46_000, NOW - 1000), W(0, 46_000, 49_000, NOW - 1000)];
check("only the last ~30 s counts: an old flat stretch doesn't color now", V.rollingRead([...old, ...recentCalm], NOW).strongest === null);
check("a stale read (no score for 45 s) says nothing", V.rollingRead([flatW(0), flatW(1), flatW(2)].map((w) => ({ ...w, receivedAt: NOW - 60_000 })), NOW).strongest === null);

// ---------------------------------------------------------------- the line
const flatRead = V.rollingRead([flatW(0), flatW(1), flatW(2)], NOW);
const brightRead = V.rollingRead([0, 1, 2].map((i) => W(0, i * 3000, i * 3000 + 3000, NOW - 1000, [["excitement", 0.85]], [["animated", 0.8]])), NOW);
const ok = { noisy: false, safety: false };
const fine = V.voiceLine(flatRead, "Yeah, I'm fine, it's all good.", ok);
check("flat voice under 'I'm fine': a mismatch line", !!fine.line && fine.mismatch && /flat while the words stay positive/.test(fine.line!), fine);
check("flat voice with words that say it: nothing (the words carry it)", V.voiceLine(flatRead, "Honestly I'm exhausted, it's been a rough week.", ok).line === null);
check("flat voice, neutral words: a gentler line", /flat and slow/.test(V.voiceLine(flatRead, "We moved the meeting to Thursday.", ok).line ?? ""));
check("a voice that lifts while the words make little of it", /lifts while the words make little of it/.test(V.voiceLine(brightRead, "It's probably a bad idea, the trip.", ok).line ?? ""));
check("a lifted voice with upbeat words: nothing", V.voiceLine(brightRead, "I'm so excited about it!", ok).line === null);
check("nothing strong: nothing", V.voiceLine(V.rollingRead([], NOW), "I'm fine", ok).line === null);
check("a safety call: voice is never used", V.voiceLine(flatRead, "I'm fine", { noisy: false, safety: true }).line === null);
check("a noisy call: voice is ignored", V.voiceLine(flatRead, "I'm fine", { noisy: true, safety: false }).line === null);
// Never names a feeling: every line the read can produce passes the call's own label check and uses none of its feeling words.
const emoSrc = readFileSync(new URL("../../src/harness/emotion.ts", import.meta.url), "utf8");
const words = [...(emoSrc.match(/const EMOTION_WORDS =\s*"([^"]+)"/)?.[1] ?? "").split("|"), ...(emoSrc.match(/const EMOTION_NOUNS =\s*"([^"]+)"/)?.[1] ?? "").split("|")].filter(Boolean);
check("the feeling words were read from the guard", words.length > 40 && words.includes("stressed") && words.includes("frustration"));
const allLines: string[] = [];
for (const d of V.VOICE_DIMS) {
  const read = { windows: 3, dims: { flat: 0, tight: 0, low: 0, sharp: 0, bright: 0, [d]: 0.9 }, strongest: d, score: 0.9 } as any;
  for (const w of ["I'm fine, all good", "We moved it to Thursday", "It's awful, I hate it"]) { const l = V.voiceLine(read, w, ok).line; if (l) allLines.push(l); }
}
check("every kind of line was produced", allLines.length === 10, allLines.length);
check("no line names a feeling (the call's label check)", allLines.every((l) => E.checkNoEmotionLabelOnCall(l).pass && E.checkNoEmotionLabel(l).pass));
check("no line carries a feeling word Cue could say back", allLines.every((l) => !words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(l))), allLines.find((l) => words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(l))));
check("every line says not to mention it", allLines.every((l) => l.startsWith(V.VOICE_LINE_LEAD) && /never mention/.test(l)));
check("the line never carries their words or anyone's name", allLines.every((l) => !/Thursday|awful|hate|all good/.test(l)) && !(V.voiceLine(flatRead, "I'm fine, Priya Shah said it's good", ok).line ?? "").includes("Priya"));

// ---------------------------------------------------------------- the relay (fake Hume, fake Twilio)
type Handler = (...a: any[]) => void;
class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  handlers = new Map<string, Handler[]>();
  closed = false;
  on(e: string, fn: Handler) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); return this; }
  emit(e: string, ...a: any[]) { for (const fn of this.handlers.get(e) ?? []) fn(...a); }
  send(d: unknown) { if (this.throwOnSend) throw new Error("boom"); this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; this.emit("close"); }
  throwOnSend = false;
}
let clock = 5_000_000;
const logs: string[] = [];
const records: { userId: string; summary: any }[] = [];
let humes: FakeSocket[] = [];
let humeFactory: () => FakeSocket = () => { const h = new FakeSocket(); humes.push(h); return h; };
const bridgeLinks = L.memoryVoiceStreamLinks();
B.setBridgeDeps({ connectHume: () => humeFactory() as any, takeLink: (id) => L.takeVoiceStreamLink(id, bridgeLinks, new Date(clock)), now: () => clock, log: (l) => logs.push(l), record: (userId, summary) => records.push({ userId, summary }), apiKey: () => "dummy" });
const mediaMsg = (payload = Buffer.alloc(160, 0xff).toString("base64"), track = "inbound") => JSON.stringify({ event: "media", streamSid: "MZ1", media: { track, chunk: "1", timestamp: "0", payload } });
const startMsg = (streamId: string) => JSON.stringify({ event: "start", streamSid: "MZ1", start: { callSid: "CA1", streamSid: "MZ1", tracks: ["inbound"], customParameters: { stream: streamId } } });
const tick = () => new Promise((r) => setImmediate(r));
const linkFor = (userId: string, now = clock) => L.issueVoiceStreamLink(userId, B.callKeyOf(userId, `tok-${userId}`), bridgeLinks, new Date(now));
const openWith = async (streamId: string) => { const tw = new FakeSocket(); B.handleTwilioStream(tw as any); tw.emit("message", startMsg(streamId)); await tick(); return tw; };
const openStream = async (userId: string) => openWith(await linkFor(userId));
const humeReady = (h: FakeSocket) => { h.readyState = 1; h.emit("open"); h.emit("message", JSON.stringify({ type: "session.created", session_id: "sess-1" })); h.emit("message", JSON.stringify({ type: "session.updated", audio: {}, measurement_timer_ms: 3000 })); };
const score = (h: FakeSocket, utt: number, s: number, e: number, ex: [string, number][], va: [string, number][] = []) => h.emit("message", JSON.stringify({ type: "measurement.result", measurement_id: 0, utterance_id: utt, audio_start_ms: s, audio_end_ms: e, trigger: "interval", expressions: ex.map(([name, probability]) => ({ name, probability })), voice_attributes: va.map(([name, probability]) => ({ name, probability })) }));

// A bad token: refused, Hume never opened.
B.resetVoiceSessions(); humes = [];
const bad = await openWith("Zm9yZ2VkLWZvcmdlZC1mb3JnZWQtZm9yZ2VkLWZvcmdlZA");
check("a stream without a live link is refused and Hume never opened", bad.closed && humes.length === 0);
const used = await linkFor("u-used");
await openWith(used);
const humesBefore = humes.length;
const reuse = await openWith(used);
check("a stream link used once is refused the second time", reuse.closed && humes.length === humesBefore);
const expired = await linkFor("u-exp", clock - (L.VOICE_STREAM_LINK_TTL_SECS + 5) * 1000);
const exp = await openWith(expired);
check("an expired stream link is refused", exp.closed && humes.length === humesBefore);
const early = new FakeSocket(); B.handleTwilioStream(early as any); early.emit("message", startMsg("Zm9yZ2VkLWZvcmdlZC1mb3JnZWQtZm9yZ2VkLWZvcmdlZA")); for (let i = 0; i < 40; i++) early.emit("message", mediaMsg()); await tick();
check("audio before the link is checked is never sent, and dropped when refused", early.closed && humes.length === humesBefore);

// Hume never answers: frames are taken without blocking, the buffer is capped, and the line is simply absent.
B.resetVoiceSessions(); humes = [];
const slow = await openStream("u-slow");
const key = B.callKeyOf("u-slow", "tok-u-slow");
const t0 = performance.now();
for (let i = 0; i < 400; i++) slow.emit("message", mediaMsg());
const tookMs = performance.now() - t0;
check("Hume opened once with the key, session.update sent on open", humes.length === 1);
check("8 s of audio is taken in well under a second while Hume hangs", tookMs < 500, tookMs);
check("the pre-connect buffer is capped (~3 s), never the whole call", (B.sessionShape(key)?.pendingBytes ?? 0) <= B.BRIDGE.pendingCap * B.BRIDGE.batchBytes);
const tl0 = performance.now();
const line0 = B.voiceReadLineFor(key, "I'm fine", ["I'm fine"], { safety: false });
check("the turn's read is synchronous and empty while Hume hangs", !(line0 instanceof Promise) && line0?.line === null && performance.now() - tl0 < 50);
slow.emit("message", JSON.stringify({ event: "stop", streamSid: "MZ1", stop: { callSid: "CA1" } }));
check("the call ending closes Hume and clears the buffers", humes[0].closed && B.sessionShape(key)?.pendingBytes === 0 && B.sessionShape(key)?.batchBytes === 0);

// Hume can't even connect: nothing throws.
B.resetVoiceSessions(); humes = [];
humeFactory = () => { throw new Error("ECONNREFUSED"); };
let threw = false;
try { const tw = await openStream("u-down"); for (let i = 0; i < 50; i++) tw.emit("message", mediaMsg()); tw.emit("close"); } catch { threw = true; }
check("Hume down: the stream handler never throws", !threw);
check("Hume down: the session is logged with the error", records.some((r) => r.userId === "u-down" && /connect/.test(String(r.summary.error))));
humeFactory = () => { const h = new FakeSocket(); humes.push(h); return h; };

// Hume errors mid-call: read stops, frames are dropped, no throw.
B.resetVoiceSessions(); humes = [];
const mid = await openStream("u-mid");
humeReady(humes[0]);
for (let i = 0; i < 10; i++) mid.emit("message", mediaMsg());
humes[0].emit("error", new Error("socket hang up"));
threw = false;
try { for (let i = 0; i < 10; i++) mid.emit("message", mediaMsg()); } catch { threw = true; }
check("Hume dropping mid-call: no throw, the read is just absent", !threw && B.voiceReadLineFor(B.callKeyOf("u-mid", "tok-u-mid"), "fine", [], { safety: false })?.line === null);
// A send that throws: dropped, not thrown.
B.resetVoiceSessions(); humes = [];
const thr = await openStream("u-thr"); humeReady(humes[0]); humes[0].throwOnSend = true;
threw = false; try { for (let i = 0; i < 10; i++) thr.emit("message", mediaMsg()); } catch { threw = true; }
check("a failed send to Hume is dropped, never thrown into the stream", !threw);
thr.emit("message", JSON.stringify({ event: "stop" })); humes[0].emit("message", JSON.stringify({ type: "session.closed", reason: "client_request" }));
check("and counted as dropped in the session log", (records.find((r) => r.userId === "u-thr")?.summary.framesDropped ?? 0) >= 1, records.find((r) => r.userId === "u-thr")?.summary);

// The happy path: batching, session.update first, scores, the line, latency, the log.
B.resetVoiceSessions(); humes = []; records.length = 0; logs.length = 0;
const tw = await openStream("u-ok");
const h = humes[0];
const okKey = B.callKeyOf("u-ok", "tok-u-ok");
for (let i = 0; i < 3; i++) tw.emit("message", mediaMsg());
check("audio waits until Hume has the format (nothing binary before session.updated)", h.sent.length === 0);
humeReady(h);
check("session.update is the first thing sent, with exactly Hume's documented format", h.sent.length >= 1 && JSON.stringify(JSON.parse(String(h.sent[0]))) === JSON.stringify(B.HUME_SESSION_UPDATE) && JSON.stringify(B.HUME_SESSION_UPDATE.audio) === JSON.stringify({ type: "audio/pcm", encoding: "s16le", sample_rate: 16000, channels: 1 }));
for (let i = 0; i < 20; i++) tw.emit("message", mediaMsg());
const bins = h.sent.filter((x) => Buffer.isBuffer(x)) as Buffer[];
check("frames go in ~100 ms batches (3200 bytes, even)", bins.length >= 3 && bins.every((b) => b.length === 3200));
for (let i = 0; i < 5; i++) tw.emit("message", mediaMsg(Buffer.alloc(160, 0x00).toString("base64"), "outbound"));
check("only the caller's track is ever sent", (h.sent.filter((x) => Buffer.isBuffer(x)) as Buffer[]).every((b) => b.every((x) => x === 0)));
clock += 700;
h.emit("message", JSON.stringify({ type: "utterance.start", utterance_id: 0, audio_start_ms: 0 }));
score(h, 0, 0, 300, [["tiredness", 0.8]], [["monotone", 0.8]]);
score(h, 0, 0, 300, [["tiredness", 0.85]], [["flat", 0.8]]);
score(h, 0, 0, 300, [["weariness", 0.8]], [["monotone", 0.9]]);
const l1 = B.voiceReadLineFor(okKey, "Yeah I'm fine, honestly it's all good.", ["Yeah I'm fine, honestly it's all good."], { safety: false });
check("live: a flat voice under 'I'm fine' reaches the turn", /flat while the words stay positive/.test(l1?.line ?? ""), l1);
check("another call's key sees nothing of this one", B.voiceReadLineFor(B.callKeyOf("u-other", "tok-u-other"), "I'm fine", [], { safety: false }) === null);
check("the same user with another call token sees nothing either", B.voiceReadLineFor(B.callKeyOf("u-ok", "tok-other"), "I'm fine", [], { safety: false }) === null);
const replay = await openStream("u-ok");
check("a second stream for the same call is refused (replay)", replay.closed && humes.length === 1);
h.emit("message", JSON.stringify({ type: "utterance.end", utterance_id: 0, audio_start_ms: 0, audio_end_ms: 9000 }));
tw.emit("message", JSON.stringify({ event: "stop" }));
check("on stop: what's left is sent and session.close asked for", h.sent.some((x) => typeof x === "string" && JSON.parse(x).type === "session.close"));
h.emit("message", JSON.stringify({ type: "session.closed", session_id: "sess-1", reason: "client_request", received: { audio_duration_ms: 500, frames: 5 }, produced: { utterances: 1, measurements: 3 } }));
const rec = records.find((r) => r.userId === "u-ok");
check("every session is logged: ids, timings, counts, latency, what passed", !!rec && rec.summary.callSid === "CA1" && rec.summary.streamSid === "MZ1" && rec.summary.humeSessionId === "sess-1" && rec.summary.windows === 3 && rec.summary.readLatencyMs.n === 3 && rec.summary.readLatencyMs.p50 === 700 && rec.summary.passed.flat === 1 && rec.summary.linesOffered === 1 && rec.summary.heardSpeechSecs === 9, rec?.summary);
const logged = JSON.stringify(rec?.summary) + logs.join("\n");
check("the log has no words of theirs and no audio", !/fine|all good|honestly/i.test(logged) && !/\/\/8=|\/\/\/\//.test(logged) && !logged.includes(Buffer.alloc(160, 0xff).toString("base64").slice(0, 20)));
check("nothing is held after the session but a few scores", B.sessionShape(okKey)?.pendingBytes === 0 && B.sessionShape(okKey)?.batchBytes === 0 && B.sessionShape(okKey)?.finished === true);
const bridgeSrc = readFileSync(new URL("../../src/services/mediaStreamBridge.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
check("no audio persisted: the relay never touches disk or the database", !/from "fs"|from "node:fs"|writeFile|createWriteStream|pool\.query|INSERT INTO/.test(bridgeSrc));

// ---------------------------------------------------------------- after the call
const callerTurns = V.callerTurnsFrom([
  { role: "agent", message: "Priya Shah from the dinner wants to meet you.", time_in_call_secs: 0 },
  { role: "user", message: "Yeah I'm fine, honestly it's all good.", time_in_call_secs: 0.5 },
  { role: "user", message: "", time_in_call_secs: 20 },
]);
check("only the caller's own lines are used for quotes", callerTurns.length === 1 && callerTurns[0].text.startsWith("Yeah"));
const got = await B.takeVoiceMoments(okKey, callerTurns, 50);
check("after the call: one strong moment, a mismatch", got.length === 1 && got[0].mismatch && got[0].dim === "flat", got);
const sig0 = V.momentSignals(got)[0] as any;
check("written as source 'call', basis 'voice', about their life, with their own words", sig0?.source === "call" && sig0?.basis === "voice" && sig0?.target === "life" && sig0?.valence === "negative" && sig0?.quote === "Yeah I'm fine, honestly it's all good." && sig0?.about === null);
check("the record carries nothing but the signal's fields (no scores, no audio)", Object.keys(sig0).sort().join(",") === "about,basis,emotion,intensity,quote,source,target,valence");
check("no other member's details in the record (Cue's line naming someone is never the quote)", !JSON.stringify(V.momentSignals(got)).includes("Priya"));
check("taken once: a retried webhook gets none", (await B.takeVoiceMoments(okKey, callerTurns, 10)).length === 0);
const many = [
  ...[0, 1].map((i) => W(1, i * 3000, i * 3000 + 3000, NOW, [["excitement", 0.9]])),
  ...[0, 1].map((i) => W(2, 30_000 + i * 3000, 30_000 + i * 3000 + 3000, NOW, [["stress", 0.7]])),
  ...[0, 1].map((i) => W(3, 60_000 + i * 3000, 60_000 + i * 3000 + 3000, NOW, [["tiredness", 0.95]])),
  W(4, 90_000, 93_000, NOW, [["anger", 1]]),
];
const turns2 = [{ atSecs: 0, text: "The trip is probably a bad idea." }, { atSecs: 30, text: "We moved the meeting." }, { atSecs: 60, text: "It's all good, really." }, { atSecs: 90, text: "Whatever." }];
const ms = V.voiceMoments(many, turns2);
check("at most two moments, mismatches first", ms.length === 2 && ms.every((m) => m.mismatch) && ms[0].score >= ms[1].score, ms.map((m) => [m.dim, m.mismatch, m.score]));
check("a one-window utterance never makes a moment", !ms.some((m) => m.dim === "sharp"));
check("intensity from the smoothed score", ms.find((m) => m.dim === "flat")?.intensity === "high");
check("a moment the words already carry isn't written", V.voiceMoments([0, 1].map((i) => W(5, i * 3000, i * 3000 + 3000, NOW, [["tiredness", 0.9]])), [{ atSecs: 0, text: "I'm so exhausted." }]).length === 0);
const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
check("post-call: the voice moments are written with the call's other moments, tied to the transcript", /\[\.\.\.moments, \.\.\.frustrated, \.\.\.voiced\]\.map\(\(m\) => \(\{ \.\.\.m, memoryId: transcriptMemoryId \}\)\)/.test(co) && /voice: async \(\) => momentSignals\(await takeVoiceMoments\(callKeyOf\(userId, String\(vars\.call_token \?\? ""\)\), callerTurnsFrom\(turns\)\)\)/.test(co));

// The after-call judge seam (Jev slot, not wired): one batched call, rule by default, logged per moment.
check("the default after-call judge is the rule bar", V.voiceMomentJudge() === V.RULE_JUDGE && V.RULE_JUDGE.name === "rule");
check("the after-call log names the judge", logs.some((l) => /voiceRead: after call/.test(l) && /"judgedBy":"rule"/.test(l) && /"judge":"rule"/.test(l)));
const calls: any[][] = [];
const fakeJev: import("../../src/services/voiceRead.js").VoiceMomentJudge = { name: "jev-fake", judge: async (m) => { calls.push(m); return m.map((x, i) => ({ keep: i === 1, kind: "strain" as const, p: 0.91, why: "fake" })); } };
const turns3 = V.callerTurnsFrom([{ role: "agent", message: "Priya Shah wants to meet you.", time_in_call_secs: 0 }, { role: "user", message: "The trip is probably a bad idea.", time_in_call_secs: 0.2 }, { role: "agent", message: "How is the week going?", time_in_call_secs: 25 }, { role: "user", message: "We moved the meeting.", time_in_call_secs: 30 }]);
const j1 = await V.judgeVoiceMoments(many, turns3, fakeJev);
check("one batched judge call per call, with every candidate", calls.length === 1 && calls[0].length === 3, calls.map((c) => c.length));
check("the judge sees only the documented shape, top dimensions only", calls[0].every((c: any) => Object.keys(c).sort().join(",") === "callerText,contextLine,endSec,scores,startSec" && Object.keys(c.scores).length <= 2));
check("the judge gets Cue's line before as context", calls[0][0].contextLine === "Priya Shah wants to meet you." && calls[0][1].contextLine === "How is the week going?");
check("the judge decides what's kept, and each kept moment says which judge", j1.moments.length === 1 && j1.moments[0].judge === "jev-fake" && j1.judgedBy === "jev-fake" && j1.moments[0].quote === "We moved the meeting.");
check("context never reaches the record", !JSON.stringify(V.momentSignals(j1.moments)).includes("Priya") && !JSON.stringify(V.momentSignals(j1.moments)).includes("week going") && !("judge" in (V.momentSignals(j1.moments)[0] as any)));
const jThrow = await V.judgeVoiceMoments(many, turns3, { name: "jev-fake", judge: async () => { throw new Error("busy"); } });
check("a failing judge falls back to the rule, and says so", jThrow.judgedBy === "rule (fallback from jev-fake)" && jThrow.moments.length === 2 && jThrow.moments.every((m) => m.judge === "rule (fallback from jev-fake)"));
const jShort = await V.judgeVoiceMoments(many, turns3, { name: "jev-fake", judge: async () => [] });
check("a judge answering the wrong number of moments falls back too", jShort.judgedBy === "rule (fallback from jev-fake)");
check("the rule judge matches the rule path", JSON.stringify((await V.judgeVoiceMoments(many, turns2)).moments) === JSON.stringify(V.voiceMoments(many, turns2)));
const vrSrc = readFileSync(new URL("../../src/services/voiceRead.ts", import.meta.url), "utf8");
check("Jev is not wired: nothing imports the gateway", !/from "\.\/jevGateway|import\("\.\/jevGateway/.test(vrSrc + bridgeSrc));
const liveFn = bridgeSrc.slice(bridgeSrc.indexOf("export function voiceReadLineFor"), bridgeSrc.indexOf("export async function takeVoiceMoments"));
check("the live per-turn line stays rule-based (no judge on the turn path)", liveFn.length > 100 && !/judge/i.test(liveFn));

// ---------------------------------------------------------------- noisy and multi-voice calls
check("a recording on their line: noisy", V.voiceCrosstalk({ heardSpeechMs: 5000, callerLines: ["Please hold, your call is being forwarded to an automated voice messaging system"] }).noisy);
check("far more speech heard than their words account for: noisy", V.voiceCrosstalk({ heardSpeechMs: 60_000, callerLines: ["yeah", "uh huh, sure", "okay"] }).noisy);
check("one person talking: not noisy", !V.voiceCrosstalk({ heardSpeechMs: 30_000, callerLines: ["I spent the whole weekend moving into the new place and it was a lot but it's done now and I'm happy with how it turned out honestly, the light is great and the neighbours seem kind"] }).noisy);
check("too little heard to judge: not noisy", !V.voiceCrosstalk({ heardSpeechMs: 10_000, callerLines: ["hi"] }).noisy);
B.resetVoiceSessions(); humes = []; records.length = 0;
const nz = await openStream("u-noisy"); const hn = humes[0]; humeReady(hn);
for (let i = 0; i < 20; i++) nz.emit("message", mediaMsg());
hn.emit("message", JSON.stringify({ type: "utterance.end", utterance_id: 0, audio_start_ms: 0, audio_end_ms: 45_000 }));
for (let i = 0; i < 3; i++) score(hn, 0, i * 3000, i * 3000 + 3000, [["tiredness", 0.9]], [["monotone", 0.9]]);
const nzKey = B.callKeyOf("u-noisy", "tok-u-noisy");
check("live: a noisy call gets no line, and stays off", B.voiceReadLineFor(nzKey, "I'm fine", ["I'm fine", "yeah"], { safety: false })?.line === null && B.voiceReadLineFor(nzKey, "I'm fine", ["I'm fine", "yeah", "I'm fine, ".repeat(40)], { safety: false })?.line === null);
nz.emit("close");
hn.emit("message", JSON.stringify({ type: "session.closed", reason: "client_request" }));
check("after: a noisy call writes nothing", (await B.takeVoiceMoments(nzKey, [{ atSecs: 0, text: "I'm fine" }], 10)).length === 0);
check("the noisy call is logged as ignored", records.some((r) => r.userId === "u-noisy" && r.summary.noisy));

// ---------------------------------------------------------------- the call brain gets the line
const textEv = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }];
const runWith = async (voiceRead: string | null, said: string, extra: Partial<import("../../src/services/callLlmProxy.js").ProxyDeps> = {}) => {
  const reqs: any[] = [];
  const body = { model: "co", stream: true, messages: [{ role: "system", content: "This call is outbound." }, { role: "assistant", content: "Hey, it's Cue." }, { role: "user", content: said }] } as any;
  for await (const _c of P.runCallLlm(body, { stream: (r: any) => { reqs.push(JSON.parse(JSON.stringify(r))); return (async function* () { for (const e of textEv("Got it.")) yield e as any; })(); }, ...extra, voiceRead })) void _c;
  return reqs;
};
const LINE = allLines[0];
const r1 = await runWith(LINE, "I'm fine.");
const lastMsg = r1[0]?.messages?.at(-1);
check("the line goes after their words in this turn's request", lastMsg?.role === "user" && lastMsg.content.at(-1)?.text === LINE);
check("never in the cached system prompt", !r1[0].system.map((x: any) => x.text).join("\n").includes(LINE));
check("no line: nothing added", !(JSON.stringify((await runWith(null, "I'm fine."))[0])).includes(V.VOICE_LINE_LEAD));
check("a safety call: no voice line", !JSON.stringify((await runWith(LINE, "I don't want to be here anymore, I want to end it"))[0]).includes(V.VOICE_LINE_LEAD));
check("voice-only mode adds nothing", !JSON.stringify((await runWith(LINE, "I'm fine.", { voiceOnly: true }))[0]).includes(V.VOICE_LINE_LEAD));
const route = readFileSync(new URL("../../src/routes/callLlm.ts", import.meta.url), "utf8");
check("the route reads the line without awaiting Hume", /voiceRead: userId && !voiceOnly \? voiceLineForTurn\(callKey, body\) : null/.test(route) && !/await\s+voiceLineForTurn|await\s+voiceReadLineFor/.test(route));
check("the route's key is the bridge's key (user and call token)", /const callKey = `\$\{userId\}:\$\{String\(extra\.call_token \?\? ""\)\}`/.test(route) && B.callKeyOf("a", "b") === "a:b");

// ---------------------------------------------------------------- the one record, every reader: supporting only
const now = new Date("2026-10-23T18:00:00Z");
const ago = (m: number) => new Date(now.getTime() - m * 60_000);
const voiceNeg = { source: "call" as const, emotion: "flat under upbeat words", intensity: "high" as const, valence: "negative" as const, about: null, quote: "I'm fine", at: ago(30), target: "life" as const, basis: "voice" as const };
const ctxVoice = E.summarizeSignals([voiceNeg], now);
check("a voice moment alone never marks a hard day (needsCare)", !ctxVoice.needsCare);
check("but it is seen: the call's moments carry it to every reader", /their voice showed: flat under upbeat words \(high\) when they said "I'm fine"/.test(E.renderEmotionalContext(ctxVoice, now)));
const textNeg = { source: "text" as const, emotion: "overwhelmed", intensity: "high" as const, valence: "negative" as const, about: "the move", quote: "it's too much", at: ago(120), target: "life" as const, basis: null };
const voicePos = { ...voiceNeg, emotion: "lit up", valence: "positive" as const, at: ago(10) };
check("a bright voice never clears what their words said (needsCare stays)", E.summarizeSignals([textNeg, voicePos], now).needsCare);
check("isScoreBasis covers both scores", E.isScoreBasis("voice") && E.isScoreBasis("frustration_score") && !E.isScoreBasis(null) && !E.isScoreBasis(undefined));
const hs = (s: any) => ({ ...s, at: s.at });
check("the next-day check-in never starts from voice alone", H.pickEpisode([hs(voiceNeg), hs({ ...voiceNeg, at: ago(20) })], now, "America/Los_Angeles") === null);
const textHigh = { ...textNeg, at: new Date("2026-10-23T02:00:00Z") };
const later = new Date("2026-10-23T05:00:00Z");
check("and a bright voice never cancels one their words started", H.pickEpisode([hs(textHigh), hs({ ...voicePos, at: new Date("2026-10-23T03:00:00Z") })], later, "America/Los_Angeles") !== null);
const heavySrc = readFileSync(new URL("../../src/services/heavyMoment.ts", import.meta.url), "utf8");
check("the send-time check ignores a voice-only good moment too", /valence = 'positive' AND basis IS DISTINCT FROM 'voice'/.test(heavySrc));

// One strong voice moment never makes a heavy moment (replyGrounding.ts heavyMoment holds the door, the cold-start question
// and doc offers); the tone context still carries it (review of #269).
const oneVoice = E.summarizeSignals([voiceNeg], now);
check("one strong voice moment: heavyMoment is false", RG.heavyMoment(oneVoice) === false && oneVoice.current === null);
check("and the tone context still carries it", oneVoice.lastCall?.moments.length === 1 && /their voice showed: flat under upbeat words/.test(E.renderEmotionalContext(oneVoice, now)));
check("the same for ElevenLabs' frustration score", RG.heavyMoment(E.summarizeSignals([{ ...voiceNeg, emotion: "frustrated", basis: "frustration_score" as const }], now)) === false);
const callRead = { ...voiceNeg, emotion: "overwhelmed", basis: null, quote: "it's a lot" };
check("a call's text read still is (heavy on a strong hard moment)", RG.heavyMoment(E.summarizeSignals([callRead, voiceNeg], now)) === true && E.summarizeSignals([callRead, voiceNeg], now).current?.basis === null);

// Finished sessions are pruned when another finishes, so one whose post-call webhook never comes doesn't linger.
B.resetVoiceSessions(); humes = [];
const pa = await openStream("u-prune-a"); humeReady(humes[0]); pa.emit("message", JSON.stringify({ event: "stop" })); humes[0].emit("message", JSON.stringify({ type: "session.closed", reason: "client_request" }));
const paKey = B.callKeyOf("u-prune-a", "tok-u-prune-a");
check("a finished session waits for its webhook", B.sessionShape(paKey)?.finished === true);
clock += B.BRIDGE.keepFinishedMs + 1000;
const pb = await openStream("u-prune-b"); pb.emit("message", JSON.stringify({ event: "stop" }));
check("past the wait, it's pruned when another session finishes", B.sessionShape(paKey) === null);

// The recap's heavy call and the hard stretch (the mood stack) never count a voice score alone (final review of #269).
const pcf = readFileSync(new URL("../../src/jobs/postCallFollowUp.ts", import.meta.url), "utf8");
check("a voice moment alone never makes a heavy call (the recap isn't held for it)", /const heavyCall = \(emo\?\.lastCall\?\.moments \?\? \[\]\)\.some\(\(m\) => m\.intensity === "high" && m\.valence === "negative" && !isScoreBasis\(m\.basis\)\);/.test(pcf) && /\{ getEmotionalContext, isScoreBasis \}/.test(pcf));
const hAt = new Date("2026-10-23T12:00:00Z");
const hrs = (h: number) => new Date(hAt.getTime() - h * 3_600_000);
const textHard = (h: number) => ({ valence: "negative" as const, intensity: "high" as const, basis: null, at: hrs(h) });
const voiceSig = (h: number, valence: "negative" | "positive") => ({ valence, intensity: "high" as const, basis: "voice" as const, at: hrs(h) });
check("a voice moment never extends a hard stretch", E.hardStretchSince([textHard(0), voiceSig(20, "negative"), textHard(40)], hAt).getTime() === hAt.getTime());
check("a voice moment never breaks one either", E.hardStretchSince([textHard(0), voiceSig(5, "positive"), textHard(10)], hAt).getTime() === hrs(10).getTime());
check("a frustration score never extends one", E.hardStretchSince([textHard(0), { ...voiceSig(20, "negative"), basis: "frustration_score" as const }, textHard(40)], hAt).getTime() === hAt.getTime());
check("the stretch's own read leaves score reads out, both branches", /AND \(basis IS NULL OR basis NOT IN \('frustration_score', 'voice'\)\)\s*AND \(valence = 'positive' OR \(valence = 'negative' AND intensity <> 'low'\)\)/.test(emoSrc) && !/DISTINCT FROM 'frustration_score'/.test(emoSrc));

B.setBridgeDeps(null);
console.log(`voice read rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
