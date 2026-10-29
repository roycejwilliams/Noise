// Never lose a member's text (Royce, 2026-10-28: "What if it's down and the person doesn't know? We don't retry the same message
// again?"). The webhook acks every text first (routes/sendblue.ts: a slow turn once made Sendblue resend one five times), so once a
// text is acked, Sendblue never sends it again. On 2026-10-28 a database password rotation left co-test unable to reach Postgres for
// about 30 minutes: the handle and payload writes failed silently, every turn failed, and with nothing saved the restart check had
// nothing to replay. Royce's texts were lost and he never knew.
//
// This is where such a text waits instead: in memory, keyed by Sendblue's message_handle, and in a local file so a process restart
// in the same container doesn't drop it. It is answered through the normal replay path once the database answers again
// (services/inboundRecovery.ts createHoldDrain). Capped by size and by age (a day). Logs carry counts only, never what anyone said
// or a phone number.
//
// The file: RAILWAY_VOLUME_MOUNT_PATH when a Railway volume is attached to the service, otherwise the OS temp directory. The api
// service is a Docker image with no volume in railway.toml, so the temp file lives on the container's own disk: it survives this
// process crashing and restarting inside the same container, and is gone when Railway replaces the container (every deploy). Texts
// lost that way are found again from Sendblue's message list (routes/sendblue.ts recoverFromSendblue).
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export const HOLD_MAX_AGE_MS = 24 * 60 * 60_000;
export const HOLD_MAX_SIZE = 500;

export type HeldText = {
  handle: string;
  // The webhook body as it arrived (a copy, before anything rewrites it).
  payload: Record<string, unknown>;
  receivedAt: number;
  // Its first handler is still running (waiting on the phone's lock, or mid-turn). Only that handler, never the drain, may answer
  // it until it settles: otherwise the drain's replay and the original turn could both answer the same text.
  active: boolean;
  // Its replay already took the one-shot claim and then died on the database before anything reached them: the drain gives the claim
  // back before trying again (routes/sendblue.ts replayRecovered).
  reclaim?: boolean;
};

export function holdFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.RAILWAY_VOLUME_MOUNT_PATH || tmpdir(), "cue-inbound-hold.json");
}

const phoneKey = (n: unknown) => String(n ?? "").replace(/\D/g, "").slice(-10);

export function createInboundHold(o: { file?: string | null; now?: () => number; maxSize?: number; maxAgeMs?: number } = {}) {
  const now = o.now ?? Date.now;
  const maxSize = o.maxSize ?? HOLD_MAX_SIZE;
  const maxAgeMs = o.maxAgeMs ?? HOLD_MAX_AGE_MS;
  const file = o.file ?? null;
  const items = new Map<string, HeldText>();
  let dropped = 0;

  const persist = () => {
    if (!file) return;
    try {
      if (!items.size) {
        rmSync(file, { force: true });
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      // A .tmp a crashed write left behind keeps its own mode (writeFileSync's mode applies only to a new file), so it goes first,
      // and the new one is set to the owner only before it takes the file's place. A failed rename leaves no copy behind.
      const tmp = `${file}.tmp`;
      rmSync(tmp, { force: true });
      try {
        writeFileSync(tmp, JSON.stringify([...items.values()]), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
      } catch (err) {
        rmSync(tmp, { force: true, recursive: true });
        throw err;
      }
    } catch (err: any) {
      console.error(`inbound hold: writing the hold file failed (${err?.code ?? "error"}); ${items.size} held in memory only`);
    }
  };
  // Oldest out first, past a day or past the cap. Counted, never named.
  const trim = (): number => {
    let n = 0;
    for (const [h, t] of items) {
      if (now() - t.receivedAt <= maxAgeMs) continue;
      items.delete(h);
      n++;
    }
    while (items.size > maxSize) {
      const oldest = [...items.values()].sort((a, b) => a.receivedAt - b.receivedAt)[0];
      items.delete(oldest.handle);
      n++;
    }
    if (n) {
      dropped += n;
      console.error(`inbound hold: dropped ${n} held text(s) past the ${Math.round(maxAgeMs / 3_600_000)}h / ${maxSize} cap`);
    }
    return n;
  };

  return {
    // Holds a text (or updates its state). Returns whether it's held after the cap.
    hold(t: { handle: string; payload: unknown; receivedAt: Date | number; active: boolean; reclaim?: boolean }): boolean {
      const prev = items.get(t.handle);
      const payload = prev?.payload ?? (JSON.parse(JSON.stringify(t.payload ?? {})) as Record<string, unknown>);
      const receivedAt = prev?.receivedAt ?? (t.receivedAt instanceof Date ? t.receivedAt.getTime() : t.receivedAt);
      const reclaim = !!(t.reclaim || prev?.reclaim);
      items.set(t.handle, { handle: t.handle, payload, receivedAt, active: t.active, ...(reclaim ? { reclaim } : {}) });
      trim();
      persist();
      if (!prev) console.error(`inbound hold: holding a text until the database answers (${items.size} held)`);
      return items.has(t.handle);
    },
    // Its first handler finished without answering it: the drain may take it now.
    settle(handle: string): void {
      const t = items.get(handle);
      if (t && t.active) {
        t.active = false;
        persist();
      }
    },
    // Answered, or handed to the one-shot replay claim: no longer held.
    release(handle: string): void {
      if (items.delete(handle)) persist();
    },
    has: (handle: string) => items.has(handle),
    size: () => items.size,
    activeCount: () => [...items.values()].filter((t) => t.active).length,
    dropped: () => dropped,
    // What the drain may answer now, oldest first.
    ready(): HeldText[] {
      if (trim()) persist();
      return [...items.values()].filter((t) => !t.active).sort((a, b) => a.receivedAt - b.receivedAt);
    },
    // The settled texts from one phone, oldest first (a live turn from that phone takes them in).
    readyFor(phone: string, exceptHandle?: string): HeldText[] {
      const k = phoneKey(phone);
      return this.ready().filter((t) => t.handle !== exceptHandle && k !== "" && phoneKey(t.payload.number) === k);
    },
    // After a restart: whatever the file kept. Nothing is still running, so every text is ready.
    load(): number {
      if (!file) return 0;
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(raw))
          for (const t of raw)
            if (t && typeof t.handle === "string" && t.payload && typeof t.receivedAt === "number")
              items.set(t.handle, { handle: t.handle, payload: t.payload, receivedAt: t.receivedAt, active: false, ...(t.reclaim ? { reclaim: true } : {}) });
      } catch (err: any) {
        if (err?.code !== "ENOENT") console.error(`inbound hold: the hold file couldn't be read (${err?.code ?? "bad json"}); starting empty`);
      }
      trim();
      persist();
      if (items.size) console.error(`inbound hold: ${items.size} held text(s) kept from before the restart`);
      return items.size;
    },
  };
}

// Whether an error is the database itself being unreachable (down, refusing this login, out of connections, shutting down): a
// Postgres SQLSTATE in those classes, or one of pg's own connection messages. 28P01 is the 2026-10-28 password rotation. A generic
// network code (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE, ECONNREFUSED) is NOT enough on its own: Anthropic, a fetch or
// Sendblue throw those too (review of #301). For those, ask the database (routes/sendblue.ts dbAnswers) before calling it down.
const PG_DOWN_CODES = new Set(["08000", "08001", "08003", "08004", "08006", "28000", "28P01", "3D000", "53300", "57P01", "57P02", "57P03"]);
const PG_DOWN_MESSAGE =
  /Connection terminated|timeout exceeded when trying to connect|password authentication failed|Client has encountered a connection error|the database system is (starting up|shutting down|in recovery mode)|sorry, too many clients/i;
export function isDbUnreachable(err: unknown, depth = 0): boolean {
  if (!err || depth > 4) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && PG_DOWN_CODES.has(e.code)) return true;
  if (typeof e.message === "string" && PG_DOWN_MESSAGE.test(e.message)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isDbUnreachable(x, depth + 1))) return true;
  return isDbUnreachable(e.cause, depth + 1);
}

// The database is down when the error says so itself, or when it doesn't and the database doesn't answer a probe either.
export async function dbDownFor(err: unknown, dbAnswers: () => Promise<boolean>): Promise<boolean> {
  return isDbUnreachable(err) || !(await dbAnswers());
}
