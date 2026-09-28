// Replays Royce's 09-28 "I'm in" (pressed Reply on the Grok Bot link; the
// webhook's reply_to was a later text in the same thread) through the
// lookup and the router. Read-only; nothing is sent.
const { repliedTo, bareLink, inlineNote } = await import("../../src/services/inlineReply.js");
const { routeMessage } = await import("../../src/services/messageRouter.js");
const body = { reply_to: { message_handle: "eeb65dde-c3d9-469b-b327-ef773d70900a" }, thread_originator: { message_handle: "92943ec6-b917-48fa-b029-11d44c8f4679" } };
const H = { "sb-api-key-id": process.env.SENDBLUE_API_KEY!, "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY! };
const m: any = await fetch("https://api.sendblue.co/api/v2/messages/92943ec6-b917-48fa-b029-11d44c8f4679", { headers: H }).then((r) => r.json());
const phone = (m.data ?? m).number ?? (m.data ?? m).to_number;
let r = await repliedTo(body, phone);
const link = r?.fromCo ? bareLink(r.text) : null;
// The action-record lookup runs on the server (see routes/sendblue.ts); here
// its result for this link is passed in: REPLAY_LABEL.
const label = String(process.env.REPLAY_LABEL ?? "").replace(link ?? "", "").trim();
if (r && link && label) r = { ...r, what: label };
console.log("pressed:", r?.text, "| what:", r?.what?.slice(0, 80), "| also in thread:", r?.alsoInThread);
const openItems = [
  { id: "offer_reaction:39", kind: "offer_reaction", description: "Co offered \"Grok Bot x Notion for Product Builders night (SF)\" (Tuesday)", askedAt: new Date() },
  { id: "offer_reaction:38", kind: "offer_reaction", description: "Co offered \"daytonaio's AI Builders demo night\" (Tuesday)", askedAt: new Date() },
] as any;
const out = await routeMessage({ message: `I'm in ${inlineNote(r!)}`, recentConversation: "", openItems });
console.log("router:", JSON.stringify(out.output).slice(0, 400));
