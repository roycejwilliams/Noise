// Read-only: what each handle in an inline reply points to (debugging).
import "../lib/requireMeter.js";
const H = { "sb-api-key-id": process.env.SENDBLUE_API_KEY!, "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY! };
const get = async (h: string) => { const r = await fetch(`https://api.sendblue.co/api/v2/messages/${h}`, { headers: H }); const j: any = await r.json(); return j.data ?? j; };
for (const h of process.argv.slice(2)) {
  const m = await get(h);
  console.log(h.slice(0, 8), "|", m.is_outbound ? "Cue" : "them", "|", m.date_sent, "|", String(m.content ?? "").slice(0, 70), "|", m.media_url ? "media" : "");
}
const list = await fetch(`https://api.sendblue.co/api/v2/messages?is_outbound=true&order_by=createdAt&order_direction=desc&limit=8`, { headers: H }).then((r) => r.json()) as any;
for (const m of (list.data ?? list.messages ?? [])) if (String(m.to_number ?? m.number ?? "").endsWith("9728")) console.log("recent Co->you", m.message_handle.slice(0, 8), "|", m.date_sent, "|", String(m.content ?? "").slice(0, 60));
