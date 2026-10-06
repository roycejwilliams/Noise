// Live test for Co's voice cues (services/voiceCues.ts): real conversations
// with a Co agent as the clean test member, the caller's turns played from
// acted clips (the voice-emotion pilot's round-2 clips and call plans), timing
// every reply from the end of the caller's line to Co's first audio, with
// whether that reply carried a cue. No real voices.
//   npx tsx evals/calls/cuesLive.ts <agent id> <test member user id> <clips dir> <call name>...
// Optional environment, for comparing setups on a real context and opening:
//   CONTEXT_FILE=path   the call's context_summary (default: empty, a fresh member)
//   OPENING="..."       the opening line to set for the call (default: the agent's own)
//   RUN_TAG=name        results go to <clips dir>cue-runs-<name>.json (default cue-runs.json)
// The clips dir holds audio/<id>.wav and calls/<name>.json (calls.py in the pilot).
import "../lib/requireMeter.js";
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import WebSocket from "ws";
import { issueCallToken } from "../../src/services/elevenLabsCalls.js";
import { cuesIn } from "../../src/services/voiceCues.js";
import pool from "../../src/db/db.js";
import { isTestNumber } from "../../src/services/testNumbers.js";

const [agentId, userId, clipsDir, ...callNames] = process.argv.slice(2);
if (!agentId || !userId || !clipsDir || !callNames.length) throw new Error("usage: cuesLive.ts <agent id> <test member user id> <clips dir> <call name>...");
const member = (await pool.query(`SELECT phone_number FROM users WHERE id = $1`, [userId])).rows[0];
if (!member || !isTestNumber(member.phone_number)) throw new Error("cuesLive.ts only runs as a test member (555-01xx)");
const dir = clipsDir.endsWith("/") ? clipsDir : `${clipsDir}/`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function muLaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  const s = Math.min(Math.abs(sample), 32635) + 0x84;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}
function toUlaw8k(path: string): Buffer {
  const buf = readFileSync(path);
  const pcm = buf.subarray(buf.indexOf("data") + 8);
  const n = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = muLaw((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1);
  return out;
}
const CHUNK = 800;
const SILENCE = Buffer.alloc(CHUNK, 0xff);

// As a real call does, mark the call started, after the last one finished processing.
async function startLikeARealCall(): Promise<void> {
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    const r = (await pool.query(`SELECT call_status FROM users WHERE id = $1`, [userId])).rows[0];
    if (!r?.call_status || !["processing", "initiated", "in-progress"].includes(r.call_status)) break;
    await sleep(5000);
  }
  await pool.query(`UPDATE users SET call_status = 'initiated', call_status_updated_at = NOW() WHERE id = $1`, [userId]);
}

type Reply = { text: string; cues: string[]; latencyMs: number | null; afterCaller: string | null };
async function runCall(name: string): Promise<{ name: string; conversationId: string | null; replies: Reply[] }> {
  const { expect } = JSON.parse(readFileSync(`${dir}calls/${name}.json`, "utf8"));
  const clips: Buffer[] = expect.map((e: any) => toUlaw8k(`${dir}audio/${e.id}.wav`));
  await startLikeARealCall();
  const { signed_url } = (await (await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" } })).json()) as any;
  const ws = new WebSocket(signed_url);
  let conversationId: string | null = null;
  let lastAudio = 0;
  let turnStart = 0;
  let turnBytes = 0;
  let agentTurns = 0;
  let callerEndedAt: number | null = null;
  let callerLine: string | null = null;
  let pending: { firstAudio: number | null } = { firstAudio: null };
  const replies: Reply[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event?.event_id }));
    else if (m.type === "conversation_initiation_metadata") conversationId = m.conversation_initiation_metadata_event?.conversation_id ?? null;
    else if (m.type === "audio") {
      const now = Date.now();
      if (now - lastAudio > 3000) {
        turnStart = now;
        turnBytes = 0;
      }
      if (pending.firstAudio === null) pending.firstAudio = now;
      turnBytes += Math.floor(((m.audio_event?.audio_base_64 ?? "").length * 3) / 4);
      lastAudio = now;
    } else if (m.type === "interruption") turnBytes = 0;
    else if (m.type === "agent_response") {
      agentTurns++;
      const text = String(m.agent_response_event?.agent_response ?? "");
      replies.push({ text, cues: cuesIn(text), latencyMs: callerEndedAt !== null && pending.firstAudio !== null ? pending.firstAudio - callerEndedAt : null, afterCaller: callerLine });
      console.log(`  Co${callerEndedAt !== null && pending.firstAudio !== null ? ` (+${pending.firstAudio - callerEndedAt}ms)` : ""}: ${text}`);
      pending = { firstAudio: null };
      callerEndedAt = null;
    }
  });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const context = process.env.CONTEXT_FILE ? readFileSync(process.env.CONTEXT_FILE, "utf8") : "";
  ws.send(
    JSON.stringify({
      type: "conversation_initiation_client_data",
      dynamic_variables: { user_id: userId, call_token: issueCallToken(userId), first_name: process.env.CONTEXT_FILE ? "Royce" : "Jordan", context_summary: context, direction: "outbound" },
      ...(process.env.OPENING ? { conversation_config_override: { agent: { first_message: process.env.OPENING } } } : {}),
    }),
  );
  const agentDone = async (turn: number) => {
    const until = Date.now() + 45_000;
    const playing = () => Date.now() < turnStart + (turnBytes / 8000) * 1000 + 800;
    while (Date.now() < until && (agentTurns < turn || Date.now() - lastAudio < 1500 || playing())) await sleep(100);
  };
  for (let i = 0; i < clips.length; i++) {
    await agentDone(i + 1);
    pending = { firstAudio: null };
    for (let o = 0; o < clips[i].length; o += CHUNK) {
      ws.send(JSON.stringify({ user_audio_chunk: clips[i].subarray(o, o + CHUNK).toString("base64") }));
      await sleep(100);
    }
    callerEndedAt = Date.now();
    callerLine = expect[i].quote;
    pending = { firstAudio: null };
    console.log(`  [caller, ${expect[i].tone}] ${expect[i].quote.slice(0, 60)}`);
    for (let s = 0; s < 20; s++) {
      ws.send(JSON.stringify({ user_audio_chunk: SILENCE.toString("base64") }));
      await sleep(100);
    }
  }
  await agentDone(clips.length + 1);
  ws.close();
  await sleep(500);
  return { name, conversationId, replies };
}

const results = [];
for (const name of callNames) {
  console.log(`\n${name}`);
  results.push(await runCall(name));
}
await pool.end();
writeFileSync(`${dir}cue-runs${process.env.RUN_TAG ? `-${process.env.RUN_TAG}` : ""}.json`, JSON.stringify(results, null, 1));
const all = results.flatMap((r) => r.replies);
const timed = (rs: Reply[]) => rs.map((r) => r.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
const cued = all.filter((r) => r.cues.length);
console.log(`\nreplies ${all.length}, with a cue ${cued.length} (${Math.round((100 * cued.length) / Math.max(1, all.length))}%), cues ${JSON.stringify(cued.flatMap((r) => r.cues))}`);
console.log(`median ms from caller's line ending to Co's first audio: cued ${med(timed(cued))} (n=${timed(cued).length}), plain ${med(timed(all.filter((r) => !r.cues.length)))} (n=${timed(all.filter((r) => !r.cues.length)).length})`);
console.log("conversations:", results.map((r) => `${r.name}=${r.conversationId}`).join(", "));
