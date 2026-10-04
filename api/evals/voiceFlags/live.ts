// Live test for voice flags (services/voiceFlags.ts) without anyone's real
// voice: a real conversation with Co's ElevenLabs agent as the clean test
// member, where the caller's turns are acted clips (round 2 of the synthetic
// test). The test member's 555-01xx number can't take a phone call, so this
// drives the agent's own WebSocket instead; the real post-call webhook then
// reaches co-test, which reads the call and (VOICE_FLAGS=test) runs the flag
// pass. Audit afterwards with evals/voiceFlags/audit.ts.
//   npx tsx evals/voiceFlags/live.ts <test member user id> <call name, e.g. roger_A> [more calls...]
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import WebSocket from "ws";
import { issueCallToken } from "../../src/services/elevenLabsCalls.js";
import pool from "../../src/db/db.js";
import { isTestNumber } from "../../src/services/testNumbers.js";

const [userId, ...callNames] = process.argv.slice(2);
if (!userId || !callNames.length) throw new Error("usage: live.ts <test member user id> <call name>...");
const member = (await pool.query(`SELECT phone_number FROM users WHERE id = $1`, [userId])).rows[0];
if (!member || !isTestNumber(member.phone_number)) throw new Error("live.ts only runs as a test member (555-01xx)");

// A real call marks the member's call 'initiated' when it starts (callTrigger.ts
// outbound, /co/incoming-call inbound); post-call processing claims the member
// only from there. This drive skips Twilio, so it does the same, and waits for
// the previous call to finish processing first, as a real next call would.
async function startLikeARealCall(): Promise<void> {
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    const r = (await pool.query(`SELECT call_status FROM users WHERE id = $1`, [userId])).rows[0];
    if (!r?.call_status || !["processing", "initiated", "in-progress"].includes(r.call_status)) break;
    await sleep(5000);
  }
  await pool.query(`UPDATE users SET call_status = 'initiated', call_status_updated_at = NOW() WHERE id = $1`, [userId]);
}
const dir = new URL("../voice-emotion-pilot/synthetic/data2/", import.meta.url);

// 16 kHz 16-bit mono WAV -> 8 kHz mu-law (the agent's input, as on a phone line).
function muLaw(sample: number): number {
  const BIAS = 0x84;
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(sample), 32635) + BIAS;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
function toUlaw8k(wavPath: URL): Buffer {
  const buf = readFileSync(wavPath);
  const data = buf.indexOf("data");
  const pcm = buf.subarray(data + 8);
  const n = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = muLaw((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 800; // 100 ms at 8 kHz
const SILENCE = Buffer.alloc(CHUNK, 0xff);

async function runCall(name: string): Promise<{ name: string; conversationId: string | null; heard: string[] }> {
  const { expect } = JSON.parse(readFileSync(new URL(`calls/${name}.json`, dir), "utf8"));
  const clips: Buffer[] = expect.map((e: any) => toUlaw8k(new URL(`audio/${e.id}.wav`, dir)));
  await startLikeARealCall();
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" } });
  const { signed_url } = (await r.json()) as any;
  const ws = new WebSocket(signed_url);
  let conversationId: string | null = null;
  let lastAgentAudio = 0;
  // Co's audio arrives faster than it plays, so its turn ends when the audio
  // received would have finished playing (8000 bytes a second), not when it stops arriving.
  let turnAudioStart = 0;
  let turnAudioBytes = 0;
  let agentTurns = 0;
  const heard: string[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event?.event_id }));
    else if (m.type === "conversation_initiation_metadata") conversationId = m.conversation_initiation_metadata_event?.conversation_id ?? null;
    else if (m.type === "audio") {
      const b64 = m.audio_event?.audio_base_64 ?? "";
      if (Date.now() - lastAgentAudio > 3000) {
        turnAudioStart = Date.now();
        turnAudioBytes = 0;
      }
      turnAudioBytes += Math.floor((b64.length * 3) / 4);
      lastAgentAudio = Date.now();
    } else if (m.type === "interruption") turnAudioBytes = 0;
    else if (m.type === "agent_response") {
      agentTurns++;
      console.log(`  Co: ${m.agent_response_event?.agent_response}`);
    } else if (m.type === "user_transcript") {
      const t = m.user_transcription_event?.user_transcript;
      heard.push(t);
      console.log(`  caller (as heard): ${t}`);
    }
  });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  ws.send(
    JSON.stringify({
      type: "conversation_initiation_client_data",
      dynamic_variables: { user_id: userId, call_token: issueCallToken(userId), first_name: "Jordan", context_summary: "", direction: "outbound" },
    }),
  );
  const agentDone = async (turn: number) => {
    const until = Date.now() + 45_000;
    const playing = () => Date.now() < turnAudioStart + (turnAudioBytes / 8000) * 1000 + 800;
    while (Date.now() < until && (agentTurns < turn || Date.now() - lastAgentAudio < 1500 || playing())) await sleep(100);
  };
  for (let i = 0; i < clips.length; i++) {
    await agentDone(i + 1);
    console.log(`  [playing ${expect[i].id}]`);
    for (let o = 0; o < clips[i].length; o += CHUNK) {
      ws.send(JSON.stringify({ user_audio_chunk: clips[i].subarray(o, o + CHUNK).toString("base64") }));
      await sleep(100);
    }
    for (let s = 0; s < 20; s++) {
      ws.send(JSON.stringify({ user_audio_chunk: SILENCE.toString("base64") }));
      await sleep(100);
    }
  }
  await agentDone(clips.length + 1);
  ws.close();
  await sleep(500);
  return { name, conversationId, heard };
}

const results = [];
for (const name of callNames) {
  console.log(`\n${name}`);
  results.push(await runCall(name));
}
const out = new URL("live-runs.json", dir);
let prior: any[] = [];
try {
  prior = JSON.parse(readFileSync(out, "utf8"));
} catch {}
writeFileSync(out, JSON.stringify([...prior, ...results.map((r) => ({ ...r, userId, at: new Date().toISOString() }))], null, 1));
await pool.end();
console.log("\nconversations:", results.map((r) => `${r.name}=${r.conversationId}`).join(", "));
