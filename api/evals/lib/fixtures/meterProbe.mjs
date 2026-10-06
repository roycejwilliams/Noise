// Test fixture: makes the calls a live eval would, through the meter, and reports what happened.
const call = async (model, headers = {}, extra = {}) => {
  try {
    await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...extra }) });
    return "ok";
  } catch (e) { return String(e.message).slice(0, 60); }
};
const out = {};
out.sonnetAsWorker = await call("claude-sonnet-5", {}, { output_config: { effort: "low" } });
out.opusAsWorker = await call("claude-opus-5");
out.sonnetAsGrader = await call("claude-sonnet-5", { "x-eval-role": "grader" });
out.opusAsGrader = await call("claude-opus-5", { "X-Eval-Role": "grader" });
out.webSearch = await call("claude-sonnet-5", {}, { tools: [{ type: "web_search_20250305", name: "web_search" }] });
try { await fetch("https://api.resend.com/emails", { method: "POST" }); out.otherHost = "allowed"; } catch (e) { out.otherHost = "refused"; }
console.log("PROBE " + JSON.stringify(out));
