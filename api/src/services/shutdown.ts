// Graceful restarts (Royce, 2026-09-24: "gonna happen the same way in
// production so what's the difference?"). Every deploy replaces the server,
// and until now whatever was mid-flight simply stopped: a job halfway
// through a batch of texts, a reply being drafted. Timing pushes around the
// quarter hour only dodged that on co-test.
//
// Now, on SIGTERM (Railway sends it before replacing the server; see
// drainingSeconds in railway.toml) or SIGINT:
//   1. no new scheduled job runs start, and the cron tasks stop;
//   2. the HTTP server stops taking new connections;
//   3. running jobs, in-flight requests and texts mid-reply get up to
//      SHUTDOWN_GRACE_MS to finish;
//   4. shutdown hooks run (the cost log flushes), then the process exits.
// Work cut off anyway (a crash, a job longer than the grace period) is
// covered by services/strandedClaims.ts.

export const SHUTDOWN_GRACE_MS = 25_000; // inside Railway's 30s drainingSeconds

let stopping = false;
const inflight = new Set<Promise<unknown>>();
const stoppers: (() => unknown)[] = [];
const hooks: (() => unknown)[] = [];

export function isShuttingDown(): boolean {
  return stopping;
}

// Keeps a piece of work alive through a shutdown until it settles.
export function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  p.then(
    () => inflight.delete(p),
    () => inflight.delete(p),
  );
  return p;
}

// Runs first on shutdown, to stop starting new work (cron tasks).
export function onStopAccepting(fn: () => unknown): void {
  stoppers.push(fn);
}

// Runs last, after in-flight work settles (flushing logs).
export function onShutdown(fn: () => unknown): void {
  hooks.push(fn);
}

// A scheduled job that is skipped once shutdown starts and tracked while it
// runs. Errors are logged here, never thrown into the scheduler.
export function trackedJob(name: string, fn: (...args: any[]) => unknown): (...args: any[]) => Promise<void> {
  return (...args) => {
    if (stopping) return Promise.resolve();
    return track(Promise.resolve().then(() => fn(...args))).then(
      () => undefined,
      (err: any) => console.error(`job ${name} failed:`, err?.message ?? err),
    );
  };
}

// Tracks every HTTP request until its response is done (express middleware).
export function trackRequests(_req: any, res: any, next: () => void): void {
  track(new Promise<void>((resolve) => res.on("close", () => resolve())));
  next();
}

export function inflightCount(): number {
  return inflight.size;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export async function gracefulShutdown(signal: string, server: { close: (cb?: (err?: Error) => void) => unknown } | null, graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`shutdown: ${signal} received, ${inflight.size} task(s) in flight; finishing up to ${Math.round(graceMs / 1000)}s`);
  for (const fn of stoppers) {
    try {
      await fn();
    } catch {}
  }
  try {
    server?.close();
  } catch {}
  const started = Date.now();
  await Promise.race([Promise.allSettled([...inflight]), sleep(graceMs)]);
  const left = inflight.size;
  console.log(`shutdown: ${left ? `${left} task(s) still running after ${graceMs}ms, stopping anyway` : `all work finished in ${Date.now() - started}ms`}`);
  await Promise.race([Promise.allSettled(hooks.map((h) => Promise.resolve().then(h))), sleep(4_000)]);
}

export function installGracefulShutdown(server: { close: (cb?: (err?: Error) => void) => unknown }): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void gracefulShutdown(signal, server).finally(() => process.exit(0));
    });
  }
}
