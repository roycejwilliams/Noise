// The actions slot of an event page (the content layer's renderActions hook). Plain HTML forms that post to /e/:id/actions/*,
// so it works with no script; every value is escaped.
//
// Who sees what (actions.ts VISIBILITY, a decision for Royce):
//   anyone with the link, no member token   the page, and one line: members RSVP through the link Co texted them
//   a member (their own sealed link)        their own RSVP, reactions, comments and questions; the headcount once enough are
//                                           going; nothing of any other member unless Royce opts in to showing comments
//   flag off                                the members line only, for everyone
//
// The content layer's hook is synchronous, so the page handler first reads the viewer (eventViewer, async: token, cookie, the
// member's own rows), then renders with renderEventActions(page, viewer).
import type { Request, Response } from "express";
import { actionsEnabled, memberView, pgActionStore, REACTIONS, RSVP_LABEL, RSVP_VALUES, TEXT_CAP, VISIBILITY, type ActionStore, type MemberState, type PageView, type VisibilityPolicy } from "./actions.js";
import type { EventPageRecord } from "./contract.js";
import { memberOnRequest, pagePath, realIdentityDeps, type IdentityDeps } from "./identity.js";

export type Viewer = { kind: "public" } | { kind: "member"; state: MemberState; page: PageView; policy: VisibilityPolicy };
export const PUBLIC_VIEWER: Viewer = { kind: "public" };

export const MEMBERS_LINE = "Members RSVP through the link Co texted them.";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Who's looking, for this page. Flag off, no token, a bad or expired token, a token for another page, or an archived member:
// public. A valid link sets the page's cookie (identity.ts).
export async function eventViewer(
  req: Request,
  res: Response | null,
  page: Pick<EventPageRecord, "id">,
  deps: { identity?: IdentityDeps; store?: ActionStore; policy?: VisibilityPolicy; env?: NodeJS.ProcessEnv } = {},
): Promise<Viewer> {
  if (!actionsEnabled(deps.env)) return PUBLIC_VIEWER;
  const claim = await memberOnRequest(req, res, page.id, deps.identity ?? realIdentityDeps).catch(() => null);
  if (!claim) return PUBLIC_VIEWER;
  const policy = deps.policy ?? VISIBILITY;
  const v = await memberView(page.id, claim.userId, deps.store ?? pgActionStore, policy).catch((err: any) => {
    console.error("event page: member view failed (showing the page view-only):", err?.message ?? err);
    return null;
  });
  return v ? { kind: "member", state: v.state, page: v.page, policy } : PUBLIC_VIEWER;
}

const STYLE = `<style>
.co-ea{margin:32px 0 0;display:grid;gap:22px;font:inherit;color:inherit}
.co-ea h3{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin:0 0 10px}
.co-ea form{margin:0}
.co-ea .row{display:flex;flex-wrap:wrap;gap:8px}
.co-ea button{font:inherit;font-size:15px;padding:10px 16px;border-radius:999px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;opacity:.75}
.co-ea button[aria-pressed=true]{opacity:1;background:currentColor}
.co-ea button[aria-pressed=true] span{filter:invert(1)}
.co-ea textarea{box-sizing:border-box;width:100%;min-height:76px;font:inherit;font-size:15px;padding:12px;border-radius:12px;border:1px solid currentColor;background:transparent;color:inherit;opacity:.9}
.co-ea .send{margin-top:8px}
.co-ea .quiet{font-size:14px;opacity:.65;margin:6px 0 0}
.co-ea ul{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:8px}
.co-ea li{font-size:15px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.co-ea li form{display:inline}
.co-ea li button{padding:2px 10px;font-size:13px;margin-left:6px}
.co-ea .members{font-size:15px;opacity:.75;margin:0}
</style>`;

const pressed = (on: boolean) => `aria-pressed="${on ? "true" : "false"}"`;

// Pure, synchronous: the actions slot for this viewer. env is read for the flag only.
export function renderEventActions(page: Pick<EventPageRecord, "id">, viewer: Viewer, env: NodeJS.ProcessEnv = process.env): string {
  if (!actionsEnabled(env) || viewer.kind !== "member") return `<section class="co-ea" id="actions">${STYLE}<p class="members">${esc(MEMBERS_LINE)}</p></section>`;
  const base = esc(pagePath(page.id));
  const s = viewer.state;
  const p = viewer.page;
  const rsvp = `<div><h3>Your RSVP</h3><form method="post" action="${base}/actions/rsvp" class="row">${RSVP_VALUES.map(
    (v) => `<button type="submit" name="value" value="${v}" ${pressed(s.rsvp === v)}><span>${esc(RSVP_LABEL[v])}</span></button>`,
  ).join("")}</form>${p.headcountLine ? `<p class="quiet">${esc(p.headcountLine)}</p>` : ""}</div>`;
  const reactions = `<div><h3>React</h3><form method="post" action="${base}/actions/reaction" class="row">${REACTIONS.map((r) => {
    const n = p.reactionCounts?.[r];
    return `<button type="submit" name="value" value="${esc(r)}" ${pressed(s.reactions.includes(r))} aria-label="${esc(r)}"><span>${esc(r)}${n ? ` ${n}` : ""}</span></button>`;
  }).join("")}</form></div>`;
  const takeBack = (id: string) => `<form method="post" action="${base}/actions/retract"><button type="submit" name="id" value="${esc(id)}">Remove</button></form>`;
  const own = (items: { id: string; text: string }[]) => (items.length ? `<ul>${items.map((c) => `<li>${esc(c.text)}${takeBack(c.id)}</li>`).join("")}</ul>` : "");
  const others = p.othersComments.length ? `<ul>${p.othersComments.map((c) => `<li><strong>${esc(c.firstName)}</strong> ${esc(c.text)}</li>`).join("")}</ul>` : "";
  const comments = `<div><h3>Comments</h3><form method="post" action="${base}/actions/comment"><textarea name="text" maxlength="${TEXT_CAP.comment}" aria-label="Comment"></textarea><div class="send"><button type="submit"><span>Post</span></button></div></form><p class="quiet">${
    viewer.policy.othersComments ? "Members on this page can see your comments." : "Only you and Co see your comments."
  }</p>${own(s.comments)}${others}</div>`;
  const ask = `<div><h3>Ask Co</h3><form method="post" action="${base}/actions/question"><textarea name="text" maxlength="${TEXT_CAP.question}" aria-label="Your question for Co"></textarea><div class="send"><button type="submit"><span>Ask</span></button></div></form><p class="quiet">Co will answer you by text. Only you and Co see your question.</p>${own(s.questions)}</div>`;
  return `<section class="co-ea" id="actions">${STYLE}${rsvp}${reactions}${comments}${ask}</section>`;
}
