// co-test runs api/src from its own package (co-test/package.json), so a package api/src imports but co-test doesn't list crashes
// co-test at boot or at the first call (2026-10-08: goalEdges.ts imported @anthropic-ai/sdk; the goal sweep failed at runtime from
// #107, inbound call openings fell back to the stock line, and #108 failed its deploy health check). Zero tokens:
//   npx tsx evals/deploy/coTestDeps.ts
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const root = new URL("../../../", import.meta.url).pathname;
const coTest = JSON.parse(fs.readFileSync(path.join(root, "co-test/package.json"), "utf8"));
const have = new Set(Object.keys({ ...(coTest.dependencies ?? {}), ...(coTest.devDependencies ?? {}) }));
// Files only the API server loads (its own middleware, auth, Stripe, sockets); co-test never imports them.
const SERVER_ONLY = [/^server\.ts$/, /^middleware\//, /^routes\/auth\.ts$/, /^routes\/stripe\.ts$/, /^socket\//];
// Resolved through another dependency (zod comes with ai).
const TRANSITIVE = new Set(["zod"]);
const builtins = new Set(builtinModules);

const src = path.join(root, "api/src");
const files: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) files.push(p);
  }
};
walk(src);

const missing = new Map<string, string[]>();
for (const f of files) {
  const rel = path.relative(src, f);
  if (SERVER_ONLY.some((re) => re.test(rel))) continue;
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/(?:^|[^.\w])(?:import\s[^"'`]*?from\s*|import\s*\(\s*|export\s[^"'`]*?from\s*)["']([^"'./][^"']*)["']/g)) {
    const spec = m[1];
    if (spec.startsWith("node:") || builtins.has(spec.split("/")[0])) continue;
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (have.has(pkg) || TRANSITIVE.has(pkg)) continue;
    // A type-only import is erased at build time.
    if (new RegExp(`import\\s+type\\s[^"']*["']${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`).test(text)) continue;
    missing.set(pkg, [...(missing.get(pkg) ?? []), rel]);
  }
}

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
check("every package api/src imports (outside the API server's own files) is a co-test dependency", missing.size === 0, Object.fromEntries([...missing].map(([k, v]) => [k, v.slice(0, 4)])));
check("including @anthropic-ai/sdk (goalEdges.ts, callOpening.ts)", have.has("@anthropic-ai/sdk"));
check("the scan saw the code (sanity)", files.length > 100);
console.log(`co-test dependencies: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
