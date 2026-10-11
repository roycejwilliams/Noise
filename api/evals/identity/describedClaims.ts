// The "as a new dad" gap (Royce, 2026-10-11: fix it). Co must not say what someone is unless they told it so; a describing word
// between the article and the claim ("as a new dad", "you're a proud Nigerian") or a sideways form ("dads like you") is the same
// claim. Zero tokens.   npx tsx evals/identity/describedClaims.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const G = await import("../../src/services/identityGuard.js");
const X = await import("../../src/services/documentDelivery.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const known = "Jordan, San Francisco, founder of a fintech startup";
const claims = ["As a new dad, you might like this.", "Being a single working mom, this fits.", "You are a proud Nigerian founder.", "you’re a new mom, so this works", "Great for dads like you.", "For parents like yourself.", "As a first-time father of two, enjoy.", "As newlyweds you will love it.", "As a recent immigrant, this helps.", "for women like you", "men like you love it", "As a mom you'll like it.",
  // Re-review of #145: real claims a phrase-end-only rule missed (the first is the original incident).
  "As a French founder, you'd fit in.", "As a mom who loves jazz, you'd like it.", "As an Italian living here, you'd know.", "As a Nigerian-American, you'd enjoy it.", "As a mom and a founder, this fits.", "It's great for you as a new dad."];
const fine = ["As a founder, you might like this.", "It is aimed at new dads.", "A mixer for French founders.", "As an aside, it starts at 7.", "Bring a friend like you said.", "As a new member, welcome.", "As a regular, you'll know the bar.",
  // Review of #145: venue copy, never a claim about them.
  "It works as a great Italian spot for dinner.", "Think of it as a quiet French bistro with a bar.", "As a reminder the man at the door has the list.", "It's run as a husband and wife team.", "a woman-led event", "a mom-and-pop shop", "student-led talks", "parent-friendly hours", "there's a student discount", "a Mexican institution", "as a group", "as a heads-up", "you're a natural", "people like you", "a man of his word", "It was pitched as a new Italian.", "As an Irish pub, it fills up early.", "It's a cozy Japanese izakaya, and you'll love the bar."];
check("a describing word or a sideways form doesn't hide the claim", claims.every((t) => G.ungroundedIdentityClaims(t, known).length > 0), claims.filter((t) => !G.ungroundedIdentityClaims(t, known).length));
check("saying who an event is for, or a role they gave, is never a claim about them", fine.every((t) => !G.ungroundedIdentityClaims(t, known).length), fine.filter((t) => G.ungroundedIdentityClaims(t, known).length));
check("what they told Co keeps it", !G.ungroundedIdentityClaims("As a new dad, you might like this.", "Jordan just became a dad").length);
check("the sentence with the claim is dropped, the rest kept", G.stripUngroundedIdentity("As a new dad, you might like this. It starts at 7.", known) === "It starts at 7.");
// Review of #144: a revision that had to go as a PDF already says so in its text; Co isn't handed a reason to repeat.
const src = (await import("node:fs")).readFileSync(new URL("../../src/services/documentDelivery.ts", import.meta.url), "utf8");
check("review of #144: once the text said it's a PDF, Co isn't handed the reason again", /const r = inPlace && \(!o\.askedForGoogle \|\| docBecamePdf\) \? \{ \.\.\.r0, googleRefused: null, googleMissing: false \} : r0;/.test(src));
void X;
console.log(`identity described claims: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
