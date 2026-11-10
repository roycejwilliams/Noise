# Event registration copy for review

This is every line a member reads about registering for another host's Luma event, word for word, as `copy.ts` builds it. The lines are grouped by stage, and each has one line on when it's used. None of it reaches a member until `REGISTRATION_COPY_APPROVED` is true in `approvals.ts`, and that waits on Royce's yes.

Notation:
- `{Event}` is the event's name from its own page.
- `{when}` is its start in the event's zone, for example "Fri Nov 20, 6:00 PM".
- `{email}` is the email the signup uses: the account email unless they chose another.
- `{link}` is the event's public page.
- A line ending in `\n{link}` sends the link on the next line.

The only words of Cue's own in an ask are one optional "why it fits" sentence placed before the ask (`{fit}`). It's checked against the event's public page and the find's checked facts (`fitProblem`): no guesses, nothing private, no other member.

## 1. Ask: the submit question (the only yes that authorizes a submit)

**Opening, chosen by the page:**
- Free, open registration:
  > {Event} is on {when}, and it's free.
- The host approves each guest (Request to Join):
  > {Event} is on {when}. It's free, and the host approves each guest.
- Full, with a waitlist (Join Waitlist):
  > {Event} is on {when}. It's free but full, so this would add you to the waitlist.

**What goes on the form:** every detail and answer is listed.
> I'd use your name ({name}) and your email ({email}){, your company ({company}), your role ({role}), …}{, with this answer: "{question}": "{answer}" | , with these answers: "{q1}": "{a1}"; "{q2}": "{a2}"}.

**Terms**, only when the form has a terms or attestation box:
> Registering also means agreeing to their terms: "{terms text, up to 300 characters}".

With more than one box: "agreeing to these terms: "…"; "…"."

**Who the event is for**, only when the event's own description says who it's for or what attending needs ("open to …", "members only", "invite only", "21+", "ID required"). The sentence is quoted word for word; Cue never judges whether they qualify. New line (2026-11-09), needs Royce's approval:
> Their page also says: "{the page's sentence}" Only say yes if that fits you.

Example, from the live test page:
> Their page also says: "This event is open to Stanford students and affiliates." Only say yes if that fits you.

**Mailing list**, only when the form has a mailing-list box (it stays unchecked):
> I'll leave their mailing-list boxes unchecked.

**The question.** Its wording depends on what's in the ask:
- Only details:
  > Want me to register you for this event using these details?
- With answers:
  > Want me to register you for this event using these details and answers?
- With terms:
  > Want me to register you for this event using these details and answers, and agree to those terms?

**Full example** (an answer, terms and a mailing-list box):
> Founders Dinner is on Fri Nov 20, 6:00 PM, and it's free. I'd use your name (Jordan Ellis), your email (jordan@example.com), and your company (Northwind), with this answer: "Why do you want to attend?": "I'm building a battery startup and want to meet climate investors.". Registering also means agreeing to their terms: "No recording without consent.". I'll leave their mailing-list boxes unchecked. Want me to register you for this event using these details and answers, and agree to those terms?

**Leads placed before the submit question, when something changed:**
- Signing in showed a question that wasn't visible before:
  > Signing in showed one more question.
- Signing in showed several:
  > Signing in showed a few more questions.
- The page changed between their yes and the submit (time, price, approval or waitlist, a new detail, new terms). The submit question is asked again:
  > Before I submit: the page changed since I asked ({what changed}).

  `{what changed}` items are joined with "and":
  - "the time changed ({old} to {new})"
  - "the price changed ({old} to {new})"
  - "the ticket changed"
  - "it's now a waitlist"
  - "the host now approves each guest"
  - "it no longer needs approval"
  - "the form now also asks for "{label}""
  - "there are new terms to agree to ("{label}")"
  - "the event's name changed"

## 2. Answers: missing details and drafts (a yes here saves answers; it never submits)

**Used when** the form needs a detail Cue doesn't have, or an open question needs their approved answer:
> {fit }I can handle the signup for {Event}. They also need {needs}.{ Here's a draft for "{question}": "{draft}"} {closing}

`{needs}` is joined with "and". Each item is one of:
- "your full name"
- "your first name"
- "your last name"
- "the email you'd like to use"
- "your phone number"
- "your company"
- "your role"
- "your city"
- "your LinkedIn"
- "your website"
- "your handle"
- "an answer to "{question}"", with "({options})" added for a choice list
- "a short answer to "{question}"", for an open question

`{closing}`:
- A draft plus missing details:
  > Does the draft work, and what should I put for {missing}?
- Only a draft:
  > Does the draft work?
- Only missing details:
  > What should I put for {missing}?

**Example:**
> I can handle the signup for Founders Dinner. They also need your company and a short answer to "Why do you want to attend?". Here's a draft for "Why do you want to attend?": "I'm raising a seed round for a battery startup and want to meet climate investors." Does the draft work, and what should I put for your company?

After their answers, the next message is the submit question (section 1), never a submit.

## 3. Codes (Luma's emailed sign-in code)

The code they text back is caught before the ordinary reply and used once. Nothing on Cue's side saves it: `evals/registration/codeNeverKept.ts` drives the real inbound handler with a fresh random code and finds it in no database write, log line, send, embedding or outside call. What Cue can't control: Sendblue and iMessage keep the message on their side, which is why the line says "Cue won't save the code" (Royce, 2026-11-09).

- Signing in is needed before the signup (no email access exists, so they're asked):
  > Luma sent a sign-in code to {email}. What's the code? I'll use it for this signup. Cue won't save the code.
- Luma asks for a code after the submit:
  > Luma sent a code to {email} to confirm the signup. What's the code? I'll use it for this signup. Cue won't save the code.
- Before any retry of an unconfirmed submit, to read Luma's own state for them:
  > Before I try again, I'll check with Luma whether the first one went through. Luma sent a sign-in code to {email}. What's the code? I'll use it for this signup. Cue won't save the code.
- The page didn't take the code:
  > That code didn't go through. Could you check the latest email from Luma and send the code again?
- Luma wants a step only they can take in their email (a link instead of a code):
  > Luma wants you to confirm from your email before the signup goes through. Tell me once you have, and I'll check the page.
- The held page timed out (10 minutes) before the code came, and nothing was submitted yet:
  > The signup page timed out while I waited for the code, so nothing was submitted. Want me to start it again? Luma will send a new code.
- The held page timed out, but the submit had already happened (a code after submit):
  > The page timed out before I could enter the code, so the signup for {Event} isn't confirmed. Here's the page:\n{link}

## 4. Outcomes (said only as the page or Luma's own signed-in page shows it)

- Registered:
  > You're registered for {Event}, {when}. Luma's confirmation goes to {email}.\n{link}
- Request sent; the host approves (never "Done", never "you're in"):
  > Submitted, pending approval. The host reviews each request for {Event}, so you're not confirmed yet; Luma emails {email} when they decide.\n{link}
- Waitlisted:
  > You're on the waitlist for {Event}, not confirmed yet. If a spot opens, Luma will email {email}.\n{link}
- Already registered. The page or Luma's own state says so, a second yes, or a reconcile found it; nothing is submitted again:
  > You're already registered for {Event} with {email}, so I didn't sign you up again.\n{link}
- The page said the submit failed:
  > The signup for {Event} didn't go through: the page said "{page's words, up to 140 characters}". Nothing is confirmed. Here's the page if you'd like to try it yourself:\n{link}
- Submitted, but the page never showed a result (timeout, lost response, or the browser stopped after the click):
  > I submitted the signup for {Event}, but the page didn't confirm it, so I can't say you're in. A confirmation from Luma at {email} would settle it. I won't submit again unless you want me to.\n{link}
- They ask about it again, or say yes to the old ask, after an unconfirmed submit. A yes to this leads to the reconcile code ask (section 3), never straight to a submit:
  > Still nothing confirming {Event}. Want me to submit it once more? If the first one went through, Luma should say you're already registered.
- The reconcile couldn't tell (no sign-in possible, or the page showed neither state); nothing is submitted again:
  > I couldn't confirm whether the signup for {Event} went through, so I won't submit it again. Luma's confirmation email to {email}, or the event page when you're signed in, will show it.\n{link}

## 5. Stops (nothing submitted; each ends with the real event link)

- Any price, deposit, fee, donation or credit:
  > {Event} isn't free ({what the page shows, for example "the page shows a price ($25.00)"}), and paid signups aren't something I do. Here's the page:\n{link}
- No price words, or words that can't be read as free:
  > I can't tell from the page whether {Event} costs anything, so I stopped there. Here's the page:\n{link}
- A sign-in that isn't Luma's emailed code (a password, another provider):
  > {Event} wants a sign-in I can't do for you, so I stopped there. Here's the page:\n{link}
- A verification step Cue can't finish:
  > Luma wants a confirmation step I can't finish for you, so I stopped there. Here's the page:\n{link}
- A bot check (CAPTCHA, Cloudflare). It is never solved or bypassed:
  > The page for {Event} put up a bot check, and I don't get around those. Here's the page to sign up yourself:\n{link}
- Registration closed:
  > Registration for {Event} is closed.\n{link}
- Full, with no waitlist:
  > {Event} is full, with no waitlist.\n{link}
- More than one ticket type (v1 takes a single free ticket):
  > {Event} has more than one ticket type, and I only handle a single free ticket for now. Here's the page:\n{link}
- A required field Cue can't fill (an upload, an unknown control):
  > The form for {Event} asks for something I can't fill in ("{field label}"). Here's the page:\n{link}
- The form couldn't be read, a field vanished, or the browser stopped before the click:
  > I couldn't read the signup form for {Event}, so nothing was submitted. Here's the page:\n{link}

## 6. Cue phrases these itself (neutral labels, not sent verbatim)

- **Withdrawal.** They take it back before a submit. The tool note says "Stopped; nothing was submitted." and Cue says so in its own words.
- **What Cue knows** (shown under "Details you gave for event signups" and "Your answers on event signups"):
  - "{label}: {value} (given for {Event})"
  - "for {Event}, "{question}": {answer}", with " (Cue's draft you approved)" added when the words were Cue's draft
- **Member picture** (the events section):
  - "A plan to go to "{Event}", {date} (registered through Cue)"
  - "Asked to go to "{Event}", {date} (submitted, pending the host's approval; not confirmed)"
  - "On the waitlist for "{Event}", {date} (not confirmed)"
  - With a reason: "; their reason for this event: "…"" or "; a reason they approved for this event (Cue's draft): "…""
