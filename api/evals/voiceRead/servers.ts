// The voice read's stream reaches a handler on both servers (2026-10-31): Twilio's <Start><Stream> goes to API_URL/co/voice-stream,
// and test.copatible.com is the co-test service, which had no upgrade handler for it (only api/src/server.ts did), so the fork could
// never connect there. Each server must route the path, check Twilio's signature before upgrading, and hand the socket to the bridge.
// Layer 1: reads the two servers' source; no network.   npx tsx evals/voiceRead/servers.ts
import { readFileSync } from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
for (const [name, path] of [["api", "../../src/server.ts"], ["co-test", "../../../co-test/src/server.ts"]] as const) {
  const src = readFileSync(new URL(path, import.meta.url), "utf8");
  // The voice-stream handler itself: the last upgrade handler opened before its path check (a server can hold several, e.g. GPT-Live's).
  const gate = src.indexOf("if (!isVoiceStreamPath(req.url)) return;");
  const at = gate >= 0 ? src.lastIndexOf('httpServer.on("upgrade",', gate) : -1;
  const block = at >= 0 ? src.slice(at, at + 900) : "";
  check(`${name}: an upgrade handler routes /co/voice-stream`, at >= 0);
  check(`${name}: Twilio's signature is checked before the upgrade, and a bad one is refused`, block.indexOf("voiceStreamSignatureOk(") > 0 && block.indexOf("voiceStreamSignatureOk(") < block.indexOf("handleUpgrade(") && /socket\.destroy\(\)/.test(block));
  check(`${name}: the socket goes to the voice read's bridge`, /handleTwilioStream\(ws as unknown as SocketLike\)/.test(block));
  check(`${name}: the bridge comes from api/src/services/mediaStreamBridge.ts`, /import \{[^}]*handleTwilioStream[^}]*\} from "(?:\.\/|\.\.\/\.\.\/api\/src\/)services\/mediaStreamBridge\.js"/.test(src));
}
console.log(`voice stream on both servers: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
