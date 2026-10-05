// The blind grading page for evals/sweepSelect/replay.ts: for each day, what
// the old rules queued and what Co chose, as A and B in a shuffled order, with
// names and dates only (no reasoning, which would give the new side away).
// Royce marks each item wow / fine / no, says which day's texts he'd rather
// have had, and can tick anything in the full pool he'd have wanted (to check
// Co's "nothing today" days). Marks stay in the browser; "Download" saves them
// for evals/sweepSelect/score.ts. key.json says which side was which.
import type { ReplayDay } from "./replay.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Deterministic per day, so a re-render keeps the same sides.
export function newSideFor(day: string): "A" | "B" {
  let h = 0;
  for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 2 === 0 ? "A" : "B";
}

export function renderGrading(days: ReplayDay[], name: string): { html: string; key: Record<string, "A" | "B"> } {
  const key: Record<string, "A" | "B"> = {};
  const sections = days.map((d) => {
    const side = newSideFor(d.day);
    key[d.day] = side;
    const byKey = new Map(d.pool.map((p) => [p.key, p]));
    const oldItems = d.oldPick.map((k) => byKey.get(k)).filter(Boolean) as ReplayDay["pool"];
    const newItems = d.judgments.filter((j) => j.verdict === "send").map((j) => byKey.get(j.key)).filter(Boolean) as ReplayDay["pool"];
    const sets = side === "A" ? { A: newItems, B: oldItems } : { A: oldItems, B: newItems };
    const list = (items: ReplayDay["pool"]) =>
      items.length
        ? items
            .map(
              (p) => `<div class="item"><span class="nm">${esc(p.name)}${p.date ? ` <span class="dt">${esc(p.date)}</span>` : ""}</span>
          <span class="marks">${["wow", "fine", "no"].map((m) => `<label><input type="radio" name="m|${esc(d.day)}|${esc(p.key)}" value="${m}">${m}</label>`).join("")}</span></div>`,
            )
            .join("")
        : `<div class="none">Nothing sent today</div>`;
    const poolList = d.pool.map((p) => `<label class="pl"><input type="checkbox" name="w|${esc(d.day)}" value="${esc(p.key)}"> ${esc(p.name)}${p.date ? ` <span class="dt">${esc(p.date)}</span>` : ""}</label>`).join("");
    return `<section data-day="${esc(d.day)}"><h2>${esc(d.day)}</h2>
      <div class="cols"><div class="col"><h3>A</h3>${list(sets.A)}</div><div class="col"><h3>B</h3>${list(sets.B)}</div></div>
      <div class="pref">Which would you rather have gotten that day? ${["A", "B", "same", "neither"].map((v) => `<label><input type="radio" name="p|${esc(d.day)}" value="${v}">${v}</label>`).join("")}</div>
      <details><summary>Everything that was in the pool (${d.pool.length}): tick anything you'd have wanted</summary>${poolList}</details></section>`;
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sweep blind grading</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1db;--card:#fff;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#9a9993;--line:#2c2b29;--card:#1e1e1c;--accent:#8fc2b0}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;max-width:980px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}p.lead{color:var(--muted);margin:0 0 20px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 14px}
h2{font-size:16px;margin:0 0 10px}h3{font-size:13px;color:var(--muted);margin:0 0 6px;letter-spacing:.04em}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media (max-width:640px){.cols{grid-template-columns:1fr}}
.item{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--line)}.dt{color:var(--muted);font-size:13px}
.marks label,.pref label{margin-right:12px;white-space:nowrap}.none{color:var(--muted);padding:8px 0;border-top:1px solid var(--line)}
.pref{margin-top:10px}details{margin-top:8px;color:var(--muted)}.pl{display:block;color:var(--fg);padding:3px 0}
.bar{position:sticky;bottom:0;background:var(--bg);padding:10px 0;border-top:1px solid var(--line);display:flex;gap:12px;align-items:center}
button{background:var(--accent);color:var(--bg);border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}#count{color:var(--muted)}
</style></head><body>
<h1>Which texts would you rather have gotten?</h1>
<p class="lead">${days.length} days from your real sweeps, ${esc(name)}. A and B are the old rules and Co's new pick, in a different order each day. Mark each item wow / fine / no, pick a side, and open the pool on days a side sent nothing.</p>
${sections.join("\n")}
<div class="bar"><button id="dl">Download marks</button><span id="count"></span></div>
<script>
const K="sweep-grading-"+${JSON.stringify(days.map((d) => d.day).join(","))}.length+"-"+${JSON.stringify(days[0]?.day ?? "")};
function load(){try{return JSON.parse(localStorage.getItem(K)||"{}")}catch(e){return {}}}
function save(v){try{localStorage.setItem(K,JSON.stringify(v))}catch(e){}}
const st=load();
document.querySelectorAll("input").forEach(i=>{const v=st[i.name];if(i.type==="radio"&&v===i.value)i.checked=true;if(i.type==="checkbox"&&Array.isArray(v)&&v.includes(i.value))i.checked=true;
 i.addEventListener("change",()=>{if(i.type==="radio")st[i.name]=i.value;else{const all=[...document.querySelectorAll('input[name="'+CSS.escape(i.name)+'"]:checked')].map(x=>x.value);st[i.name]=all}save(st);count()})});
function count(){const days=document.querySelectorAll("section").length;const done=Object.keys(st).filter(k=>k.startsWith("p|")).length;document.getElementById("count").textContent=done+" of "+days+" days picked"}
count();
document.getElementById("dl").onclick=()=>{const out={};for(const [k,v] of Object.entries(st)){const [t,day,...rest]=k.split("|");out[day]??={items:{},wanted:[]};if(t==="m")out[day].items[rest.join("|")]=v;if(t==="p")out[day].pref=v;if(t==="w")out[day].wanted=v}
 const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="marks.json";a.click()};
</script></body></html>`;
  return { html, key };
}
