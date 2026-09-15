// Layer 2 harness: the code gates decideActions (services/messageRouter.ts)
// applies, spelled out as GateCheck entries for the decision log. Read-only:
// this never changes what decideActions decided, it only explains it.
import {
  ANSWER_VALUES,
  askIsFresh,
  isIrreversible,
  type Decision,
  type OpenItem,
  type RouterOutput,
} from "../services/messageRouter.js";
import type { GateCheck } from "./core.js";

export function routerGateChecks(
  out: RouterOutput,
  openItems: Pick<OpenItem, "id" | "kind" | "description" | "detail">[],
  decision: Decision<any>,
  turn: { message: string; recentConversation: string },
  routerFailed: boolean,
): GateCheck[] {
  const checks: GateCheck[] = [
    { name: "router_available", pass: !routerFailed, reason: routerFailed ? "router call failed; no actions taken" : undefined },
  ];

  const ambiguous = [...new Set(out.ambiguousBetween)].filter((id) => openItems.some((i) => i.id === id));
  checks.push({
    name: "single_item",
    pass: ambiguous.length < 2,
    reason: ambiguous.length >= 2 ? `could be answering ${ambiguous.join(" or ")}; asked instead` : undefined,
  });

  if (out.answers) {
    const item = openItems.find((i) => i.id === out.answers!.itemId);
    checks.push({ name: "answer_item_open", pass: !!item, reason: item ? undefined : `${out.answers.itemId} isn't an open item` });
    if (item) {
      const valueOk = ANSWER_VALUES[item.kind].includes(out.answers.value);
      checks.push({ name: "answer_value_valid", pass: valueOk, reason: valueOk ? undefined : `"${out.answers.value}" isn't a valid answer to ${item.kind}` });
      if (valueOk && isIrreversible(item.kind, out.answers.value)) {
        checks.push({
          name: "irreversible_high_confidence",
          pass: out.confidence === "high",
          reason: out.confidence === "high" ? undefined : `${item.kind}=${out.answers.value} needs high confidence, got ${out.confidence}`,
        });
        const fresh = askIsFresh(item, turn.message, turn.recentConversation);
        checks.push({
          name: "irreversible_co_just_asked",
          pass: fresh,
          reason: fresh ? undefined : `Co's last message didn't ask about ${item.kind}`,
        });
      } else if (valueOk) {
        checks.push({
          name: "reversible_not_low_confidence",
          pass: out.confidence !== "low",
          reason: out.confidence !== "low" ? undefined : "low confidence; nothing resolved",
        });
      }
    }
  }

  if (out.call === "explicit_request") {
    checks.push({
      name: "call_high_confidence",
      pass: out.confidence === "high",
      reason: out.confidence === "high" ? undefined : `call request at ${out.confidence} confidence; asked instead of dialing`,
    });
  }
  if ((out.call === "schedule_request" || out.call === "cancel_scheduled_call") && out.answers) {
    checks.push({
      name: "later_time_wins_over_call_now",
      pass: !decision.placeCall,
      reason: "a future time or cancel never dials now",
    });
  }
  return checks;
}
