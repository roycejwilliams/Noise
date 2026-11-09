// Local stand-ins for Luma's public registration page, in the states a registration meets. Shaped on what Luma's real page showed on
// 2026-11-09 (luma.com event pages read in a browser with every non-GET request refused; nothing submitted): the page's __NEXT_DATA__
// (event, ticket_info, registration_questions with question_type), a "Register" / "Request to Join" / "Join Waitlist" button that
// opens a [role=dialog] with a form: Name (name="name", autocomplete="name"), Email (type="email"), custom answers named
// registration_answers.N.value (a company question as .company and .job_title with autocomplete organization / organization-title), a
// dropdown as an input role="combobox" with a listbox, and a terms checkbox inside its label ("By registering, I agree to the event
// terms."). What Luma shows AFTER a submit was never seen (no live submit): those texts here are assumptions the live test must confirm.
//
// Nothing here touches the network: the driver serves these through its fixture route and refuses every other request.
export type FixtureField =
  | { kind: "text"; name: string; label: string; required?: boolean; type?: string; autocomplete?: string }
  | { kind: "combo"; label: string; options: string[]; required?: boolean }
  | { kind: "check"; label: string; required?: boolean };

export type Fixture = {
  slug: string;
  name?: string;
  startAt?: string;
  zone?: string;
  button?: "Register" | "Request to Join" | "Join Waitlist" | null;
  ticketInfo?: Record<string, unknown>;
  ticketTypes?: { name: string; type: string; cents?: number }[];
  terms?: string;
  fields?: FixtureField[];
  // What the page shows after the submit button is clicked.
  result?: "registered" | "pending" | "waitlist" | "already" | "timeout" | "error" | "code";
  // A sign-in wall first (Luma's email-code sign-in); the code that signs in; the fields it reveals once signed in.
  signIn?: { code: string; reveals?: FixtureField[] };
  // The code a post-submit code step accepts.
  code?: string;
  captcha?: boolean;
  closed?: boolean;
};

export const NAME_EMAIL: FixtureField[] = [
  { kind: "text", name: "name", label: "Name", required: true, autocomplete: "name" },
  { kind: "text", name: "email", label: "Email", required: true, type: "email", autocomplete: "email" },
];

export function fixtureUrl(f: Fixture): string {
  return `https://luma.com/${f.slug}`;
}

export function fixtureHtml(f: Fixture): string {
  const data = {
    props: {
      pageProps: {
        initialData: {
          kind: "event",
          data: {
            event: { name: f.name ?? "Demo Night", start_at: f.startAt ?? "2026-11-21T02:00:00.000Z", timezone: f.zone ?? "America/Los_Angeles", url: f.slug },
            ticket_info: f.ticketInfo ?? { price: null, is_free: true, is_sold_out: false, require_approval: f.button === "Request to Join" },
            ticket_types: f.ticketTypes ?? [{ name: "Standard", type: "free" }],
            registration_questions: f.terms ? [{ id: "t1", label: "Terms and Conditions", question_type: "terms", terms: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: f.terms }] }] } } }] : [],
            waitlist_active: f.button === "Join Waitlist",
            hosts: [{ name: "Host Collective" }],
          },
        },
      },
    },
  };
  const cfg = { fields: f.fields ?? NAME_EMAIL, button: f.button === undefined ? "Register" : f.button, result: f.result ?? "registered", signIn: f.signIn ?? null, code: f.code ?? null, closed: !!f.closed };
  return `<!doctype html><html><head><title>${data.props.pageProps.initialData.data.event.name} · Luma</title>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></head><body>
<h1>${data.props.pageProps.initialData.data.event.name}</h1>
${f.captcha ? '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile"></iframe><p>Verify you are human</p>' : ""}
${cfg.closed ? "<p>Registration Closed</p>" : ""}
<div id="root"></div>
<script>
const cfg = ${JSON.stringify(cfg)};
window.__submits = 0; window.__submitted = null; window.__signIns = 0;
const root = document.getElementById("root");
let signedIn = !cfg.signIn;
function el(tag, attrs, html) { const e = document.createElement(tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (html !== undefined) e.innerHTML = html; return e; }
function fieldNode(f, i) {
  const wrap = el("div");
  if (f.kind === "text") {
    const id = "f" + i;
    wrap.appendChild(el("label", { for: id }, "<div>" + f.label + (f.required ? "&nbsp;*" : "") + "</div>"));
    const inp = el("input", { id, name: f.name, type: f.type || "text", autocomplete: f.autocomplete || "" });
    if (f.required) inp.setAttribute("required", "");
    wrap.appendChild(inp);
  } else if (f.kind === "combo") {
    const id = "c" + i;
    wrap.appendChild(el("label", { for: id }, "<div>" + f.label + (f.required ? "&nbsp;*" : "") + "</div>"));
    const inp = el("input", { id, role: "combobox", "aria-controls": id + "-listbox", placeholder: "Select an option", "aria-required": f.required ? "true" : "false", type: "text" });
    const list = el("div", { id: id + "-listbox", role: "listbox", style: "display:none" });
    for (const o of f.options) { const opt = el("div", { role: "option" }, o); opt.onclick = () => { inp.value = o; list.style.display = "none"; }; list.appendChild(opt); }
    inp.onclick = () => { list.style.display = "block"; };
    inp.onkeydown = (e) => { if (e.key === "Escape") list.style.display = "none"; };
    wrap.appendChild(inp); wrap.appendChild(list);
  } else {
    const lab = el("label");
    const box = el("input", { type: "checkbox" });
    lab.appendChild(box);
    lab.appendChild(el("div", {}, "<div>" + f.label + (f.required ? "<span>&nbsp;*</span>" : "") + "</div>"));
    wrap.appendChild(lab);
  }
  return wrap;
}
function dialog(inner) { root.innerHTML = ""; const d = el("div", { role: "dialog" }); d.appendChild(inner); root.appendChild(d); return d; }
function codeForm(expect, onOk) {
  const form = el("form", { action: "#" });
  form.appendChild(el("p", {}, "Enter the code we sent to your email."));
  form.appendChild(el("input", { autocomplete: "one-time-code", inputmode: "numeric", name: "code" }));
  form.appendChild(el("button", { type: "submit" }, "Continue"));
  form.onsubmit = (e) => { e.preventDefault(); if (form.querySelector("input").value === expect) onOk(); else form.querySelector("p").textContent = "That code didn't work. Enter the code we sent to your email."; };
  dialog(form);
}
function regForm() {
  const form = el("form", { action: "#" });
  form.appendChild(el("h3", {}, "Your Info"));
  const fields = cfg.fields.concat(signedIn && cfg.signIn && cfg.signIn.reveals ? cfg.signIn.reveals : []);
  fields.forEach((f, i) => form.appendChild(fieldNode(f, i)));
  form.appendChild(el("button", { type: "submit" }, cfg.button));
  form.onsubmit = (e) => {
    e.preventDefault();
    window.__submits++;
    const out = {};
    form.querySelectorAll("input").forEach((i) => { const k = i.name || i.id || (i.closest("label") ? i.closest("label").innerText.trim() : "?"); out[k] = i.type === "checkbox" ? i.checked : i.value; });
    window.__submitted = out;
    // What the page received, where the test can read it (the page's own text, outside the dialog).
    let rec = document.getElementById("rec"); if (!rec) { rec = el("pre", { id: "rec" }); document.body.appendChild(rec); }
    rec.textContent = "RECORD " + JSON.stringify(out) + " COUNT " + window.__submits;
    const show = (t) => dialog(el("div", {}, "<p>" + t + "</p>"));
    if (cfg.result === "registered") show("You're In. A confirmation is on its way to your email.");
    else if (cfg.result === "pending") show("Pending Approval. Your request has been sent to the host.");
    else if (cfg.result === "waitlist") show("You're on the waitlist. We'll let you know if a spot opens up.");
    else if (cfg.result === "already") show("You have already registered for this event.");
    else if (cfg.result === "error") show("Something went wrong. Please try again.");
    else if (cfg.result === "code") codeForm(cfg.code, () => show("You're In."));
    // "timeout": nothing changes on the page.
  };
  dialog(form);
}
function signInForm() {
  const form = el("form", { action: "#" });
  form.appendChild(el("p", {}, "Please sign in to register. Continue with email and we'll email you a code."));
  form.appendChild(fieldNode({ kind: "text", name: "email", label: "Email", required: true, type: "email", autocomplete: "email" }, 0));
  form.appendChild(el("button", { type: "submit" }, "Continue with Email"));
  form.onsubmit = (e) => { e.preventDefault(); window.__signIns++; codeForm(cfg.signIn.code, () => { signedIn = true; regForm(); }); };
  dialog(form);
}
if (cfg.button && !cfg.closed) {
  const b = el("button", { type: "button" }, cfg.button);
  b.onclick = () => (signedIn ? regForm() : signInForm());
  document.body.insertBefore(b, root);
}
</script></body></html>`;
}

export function fixtureMap(list: Fixture[]): Record<string, string> {
  return Object.fromEntries(list.map((f) => [fixtureUrl(f), fixtureHtml(f)]));
}
