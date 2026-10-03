// The real Sendblue webhook router, mounted in-process on 127.0.0.1 with a
// fake socket.io. No server.ts, no workers, no cron. Requests come from this
// process only; the port is the only extra one the network guard allows.
import { H } from "./boot.js";
import { raw, settle } from "./db.js";
import { PHONE } from "./fixtures.js";

let base: string | null = null;
export const SECRET = "harness-placeholder-not-a-secret"; // = SENDBLUE_WEBHOOK_SECRET in boot
let handleN = 0;

export async function mountRouter(): Promise<string> {
  if (base) return base;
  const express = (await import("express")).default;
  const { sendblueRouter } = await import("../../src/routes/sendblue.js");
  const io: any = { to: (room: string) => ({ emit: (event: string) => { H.sockets.push({ room, event }); } }), emit: (event: string) => { H.sockets.push({ room: "*", event }); }, in: () => io };
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/sendblue", sendblueRouter(io));
  await new Promise<void>((res) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      H.localHttp.add(`127.0.0.1:${port}`);
      base = `http://127.0.0.1:${port}`;
      res();
    });
  });
  return base!;
}

export async function inbound(from: string, content: string, o: { secret?: string | null; handle?: string; extra?: Record<string, any> } = {}): Promise<{ status: number; handle: string }> {
  const b = await mountRouter();
  const handle = o.handle ?? `harness-in-${Date.now()}-${++handleN}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.secret !== null) headers["sb-signing-secret"] = o.secret ?? SECRET;
  const body = { number: from, from_number: from, to_number: process.env.SENDBLUE_PHONE_NUMBER, content, message_handle: handle, is_outbound: false, status: "RECEIVED", service: "iMessage", date_sent: new Date().toISOString(), ...(o.extra ?? {}) };
  const r = await fetch(`${b}/sendblue/webhook`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, handle };
}

// A turn is done when its handle is marked finished (or nothing moves for a while).
export async function turnDone(handle: string, maxMs = 120000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await raw(`SELECT finished_at IS NOT NULL AS done FROM inbound_webhook_handles WHERE handle = $1`, [handle]).catch(() => ({ rows: [] as any[] }));
    if (r.rows[0]?.done) { await settle(600, 20000); return true; }
  }
  await settle(600, 20000);
  return false;
}
export { PHONE };
