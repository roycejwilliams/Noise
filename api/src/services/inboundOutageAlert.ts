// The team hears when members' texts stop going through (Royce approved, 2026-10-28). One text to TEAM_ALERT_PHONE through the
// team-alert path (harness/failureCount.ts sendAlertText: texted, recorded as a team line) when incoming texts start failing, at
// most one an hour while it lasts, and one "back to normal" text when it's over. All state is in this process's memory: the alert
// exists for when the database is the thing that's down, so it can't depend on it.
//
// The lines carry no member data: no names, numbers, counts per member or anything anyone said. They're fixed strings.

// COPY: awaiting Royce's OK (PR "Copy" section).
export const OUTAGE_ALERT_DB = "Cue alert: incoming texts are failing. The database isn't answering, so Cue is holding them and will answer once it's back.";
export const OUTAGE_ALERT_TURNS = "Cue alert: incoming texts are failing. Several replies broke in the last 10 minutes.";
export const OUTAGE_BACK = "Cue is back to normal: incoming texts are going through again.";

export const ALERT_EVERY_MS = 60 * 60_000;
// Turn failures that aren't the database: this many inside this window is an outage.
export const TURN_FAILURES_N = 3;
export const TURN_FAILURES_WINDOW_MS = 10 * 60_000;
// Back to normal only after this long without a failure.
export const QUIET_FOR_BACK_MS = 5 * 60_000;

export type OutageKind = "db" | "turns";

export function createOutageAlert(deps: { send: (text: string) => Promise<boolean>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let failing: { kind: OutageKind; since: number } | null = null;
  let alertedThisOutage = false;
  let lastAlertAt = -Infinity;
  let lastFailureAt = -Infinity;
  let turnFailures: number[] = [];

  const send = (text: string, onFail?: () => void) => {
    deps
      .send(text)
      .then((went) => {
        if (!went) onFail?.();
      })
      .catch((err: any) => {
        console.error(`inbound outage alert: the team text failed (${err?.status ?? err?.code ?? "error"})`);
        onFail?.();
      });
  };
  const maybeAlert = () => {
    if (!failing || now() - lastAlertAt < ALERT_EVERY_MS) return;
    const before = lastAlertAt;
    const stamp = now();
    const wasAlerted = alertedThisOutage;
    lastAlertAt = stamp;
    alertedThisOutage = true;
    // A send that didn't go doesn't use up the hour (the next failure or tick tries again), and isn't followed by a "back" text.
    send(failing.kind === "db" ? OUTAGE_ALERT_DB : OUTAGE_ALERT_TURNS, () => {
      if (lastAlertAt !== stamp) return;
      lastAlertAt = before;
      alertedThisOutage = wasAlerted;
    });
  };

  return {
    // An inbound text couldn't be saved or answered because the database is unreachable.
    noteDbUnreachable(): void {
      lastFailureAt = now();
      if (!failing) failing = { kind: "db", since: now() };
      else failing.kind = "db";
      maybeAlert();
    },
    // An inbound turn failed for another reason.
    noteTurnFailure(): void {
      const t = now();
      lastFailureAt = t;
      turnFailures = [...turnFailures.filter((x) => t - x < TURN_FAILURES_WINDOW_MS), t];
      if (!failing && turnFailures.length >= TURN_FAILURES_N) failing = { kind: "turns", since: t };
      maybeAlert();
    },
    // Evidence things work again: "db" when the database answers and nothing is held, "turn" when a text was answered. A database
    // outage is over on either; a turn outage only on a real answered turn. Quiet for QUIET_FOR_BACK_MS first.
    noteHealthy(source: "db" | "turn", o: { held: number }): void {
      if (!failing) return;
      if (o.held > 0) return;
      if (failing.kind === "turns" && source !== "turn") return;
      if (now() - lastFailureAt < QUIET_FOR_BACK_MS) return;
      const tell = alertedThisOutage;
      failing = null;
      alertedThisOutage = false;
      turnFailures = [];
      if (tell) send(OUTAGE_BACK);
    },
    // Called on a timer while failing: the hourly repeat.
    tick(): void {
      maybeAlert();
    },
    state: () => ({ failing: failing ? { ...failing } : null, alertedThisOutage, lastAlertAt, lastFailureAt }),
  };
}
