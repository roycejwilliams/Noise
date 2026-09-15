// Shared eval runner for every layer's harness (see src/harness/core.ts).
//
// Each layer keeps its cases in evals/<layer>/:
//   cases.synthetic.json  committed; made-up cases for flows real traffic hasn't hit
//   cases.local.json      gitignored; real user data, never commit it
//
// A case's score has hard failures (an action that must never happen: a
// wrong text, call, intro, or false claim) and soft checks (quality). Any
// hard failure exits 1, which is the ship gate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type EvalCase = { id: string; source?: "real" | "synthetic" } & Record<string, unknown>;

export type CaseScore = { hard: string[]; soft: { name: string; ok: boolean }[] };

export function loadCases<T extends EvalCase>(dir: string): T[] {
  const read = (file: string): T[] => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : []);
  return [
    ...read("cases.local.json").map((c) => ({ source: "real" as const, ...c })),
    ...read("cases.synthetic.json").map((c) => ({ source: "synthetic" as const, ...c })),
  ];
}

export async function runEval<T extends EvalCase, R>(opts: {
  name: string;
  dir: string;
  cases: T[];
  run: (c: T) => Promise<R>;
  score: (c: T, result: R) => CaseScore;
  concurrency?: number;
  only?: string[];
}): Promise<{ hard: number; softPct: number }> {
  const cases = opts.only?.length ? opts.cases.filter((c) => opts.only!.includes(c.id)) : opts.cases;
  const rows: { id: string; result?: R; error?: string; score: CaseScore }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++];
      try {
        const result = await opts.run(c);
        rows.push({ id: c.id, result, score: opts.score(c, result) });
      } catch (err: any) {
        rows.push({ id: c.id, error: err?.message ?? String(err), score: { hard: [`run error: ${err?.message ?? err}`], soft: [] } });
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));

  const hardRows = rows.filter((r) => r.score.hard.length);
  const soft = rows.flatMap((r) => r.score.soft);
  const softPct = soft.length ? (100 * soft.filter((s) => s.ok).length) / soft.length : 100;

  console.log(`\n${opts.name}: ${rows.length} cases, ${hardRows.length} hard failures, ${softPct.toFixed(1)}% soft`);
  for (const r of hardRows.sort((a, b) => a.id.localeCompare(b.id))) console.log(`  HARD ${r.id}: ${r.score.hard.join("; ")}`);
  const softMisses = new Map<string, number>();
  for (const s of soft) if (!s.ok) softMisses.set(s.name, (softMisses.get(s.name) ?? 0) + 1);
  for (const [name, n] of softMisses) console.log(`  soft miss ${name}: ${n}`);

  mkdirSync(join(opts.dir, "results"), { recursive: true });
  writeFileSync(
    join(opts.dir, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.local.json`),
    JSON.stringify({ hard: hardRows.length, softPct, rows }, null, 2),
  );
  if (hardRows.length) process.exitCode = 1;
  return { hard: hardRows.length, softPct };
}
