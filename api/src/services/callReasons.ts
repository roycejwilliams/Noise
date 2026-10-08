// Turning the call gate's reason into what Co tells the member (2026-10-01).
// Why a requested call wasn't placed, said the way Co can tell them.
export function callNotPlacedReason(error: string | null | undefined): string {
  const e = String(error ?? "");
  const recent = e.match(/Co called (\d+) min ago \(needs (\d+)\)/);
  if (recent) return `Co called them ${recent[1]} minute${recent[1] === "1" ? "" : "s"} ago and waits ${recent[2]} minutes between calls, so it can call again in about ${Math.max(1, Number(recent[2]) - Number(recent[1]))} minute${Math.max(1, Number(recent[2]) - Number(recent[1])) === 1 ? "" : "s"}.`;
  if (/already in progress/i.test(e)) return "A call to them still shows as in progress, so a second one can't start yet.";
  if (/subscription/i.test(e)) return "Their membership isn't active, so calls are paused.";
  if (/8am-9pm|UTC|outside .*time/i.test(e)) return "It's outside the hours Co calls (8am to 9pm their time).";
  if (/opted out/i.test(e)) return "They've opted out of calls and texts.";
  return "Something stopped the call before it was placed; the reason isn't clear.";
}

// The same reason as facts Co can cite: what it did before (the recent call)
// and what's true now. Not a "not_done" fact, which can't back a timing claim.
export function callNotPlacedFacts(error: string | null | undefined): { kind: "did_before" | "known"; text: string }[] {
  const e = String(error ?? "");
  const recent = e.match(/Co called (\d+) min ago \(needs (\d+)\)/);
  const out: { kind: "did_before" | "known"; text: string }[] = [];
  if (recent) {
    const left = Math.max(1, Number(recent[2]) - Number(recent[1]));
    out.push({ kind: "did_before", text: `Co called them ${recent[1]} minute${recent[1] === "1" ? "" : "s"} ago.` });
    out.push({ kind: "known", text: `No new call was placed this turn: Co waits ${recent[2]} minutes between calls, so it can call them again in about ${left} minute${left === 1 ? "" : "s"} if they ask (text "call me" again).` });
    return out;
  }
  out.push({ kind: "known", text: `No call was placed this turn. ${callNotPlacedReason(e)}` });
  return out;
}
