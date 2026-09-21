// Scoring for Claude-vs-Jev comparisons (2026-09-21). One place, so every classifier
// is judged the same way and no number depends on a cutoff picked after the fact.
//
//   - wilson:     confidence interval on an accuracy
//   - mcnemar:    exact two-sided paired test on the cases where the two disagree
//   - bootDiff:   bootstrap interval on (jev accuracy - claude accuracy)
//   - calibration: how often Jev is right in each probability band
//   - cascadeCV:  pick the "Jev decides when sure" band on TRAIN folds only, score it on
//                 the held-out fold, so the cascade number is not tuned on what it is scored on
export type Row = { label: boolean; claude: boolean; jevP: number };

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

// b = Jev right and Claude wrong, c = Claude right and Jev wrong. Two-sided exact binomial.
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

export function accuracy(rows: Row[], pred: (r: Row) => boolean): number {
  return rows.length ? rows.filter((r) => pred(r) === r.label).length / rows.length : 0;
}

export function paired(rows: Row[], jevYes = 0.5) {
  let both = 0, onlyJev = 0, onlyClaude = 0, neither = 0;
  for (const r of rows) {
    const j = r.jevP >= jevYes === r.label;
    const c = r.claude === r.label;
    if (j && c) both++;
    else if (j) onlyJev++;
    else if (c) onlyClaude++;
    else neither++;
  }
  return { both, onlyJev, onlyClaude, neither, p: mcnemar(onlyJev, onlyClaude) };
}

// Seeded so a rerun gives the same interval.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function bootDiff(rows: Row[], jevYes = 0.5, iters = 2000, seed = 7): [number, number] {
  const r = rng(seed);
  const diffs: number[] = [];
  for (let i = 0; i < iters; i++) {
    const s = Array.from({ length: rows.length }, () => rows[Math.floor(r() * rows.length)]);
    diffs.push(accuracy(s, (x) => x.jevP >= jevYes) - accuracy(s, (x) => x.claude));
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(iters * 0.025)], diffs[Math.floor(iters * 0.975)]];
}

export function calibration(rows: Row[], edges = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0001]) {
  const out: { band: string; n: number; jevRight: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const inBand = rows.filter((r) => r.jevP >= edges[i] && r.jevP < edges[i + 1]);
    out.push({ band: `${edges[i]}-${Math.min(1, edges[i + 1])}`, n: inBand.length, jevRight: inBand.filter((r) => r.jevP >= 0.5 === r.label).length });
  }
  return out;
}

// Cascade: Jev decides when p <= lo or p >= hi, else Claude. The band is chosen on the
// training folds (best accuracy, ties go to the wider Jev share) and scored on the held-out fold.
export function cascadeCV(rows: Row[], folds = 5, seed = 11) {
  const grid: [number, number][] = [];
  for (const lo of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) grid.push([lo, 1 - lo]);
  const r = rng(seed);
  const order = rows.map((x, i) => ({ x, k: r() })).sort((a, b) => a.k - b.k).map((o) => o.x);
  let correct = 0, jevDecided = 0;
  const bands: string[] = [];
  const run = (rs: Row[], lo: number, hi: number) => {
    let ok = 0, j = 0;
    for (const x of rs) {
      const useJev = x.jevP <= lo || x.jevP >= hi;
      const pred = useJev ? x.jevP >= 0.5 : x.claude;
      if (useJev) j++;
      if (pred === x.label) ok++;
    }
    return { ok, j };
  };
  for (let f = 0; f < folds; f++) {
    const test = order.filter((_, i) => i % folds === f);
    const train = order.filter((_, i) => i % folds !== f);
    let best = grid[0], bestScore = -1, bestJ = -1;
    for (const [lo, hi] of grid) {
      const { ok, j } = run(train, lo, hi);
      if (ok > bestScore || (ok === bestScore && j > bestJ)) [best, bestScore, bestJ] = [[lo, hi], ok, j];
    }
    bands.push(`${best[0]}-${best[1]}`);
    const { ok, j } = run(test, best[0], best[1]);
    correct += ok;
    jevDecided += j;
  }
  return { accuracy: correct / rows.length, jevShare: jevDecided / rows.length, bands };
}

export function report(name: string, rows: Row[], jevYes = 0.5): string {
  const n = rows.length;
  const c = rows.filter((r) => r.claude === r.label).length;
  const j = rows.filter((r) => r.jevP >= jevYes === r.label).length;
  const [cl, ch] = wilson(c, n);
  const [jl, jh] = wilson(j, n);
  const pr = paired(rows, jevYes);
  const [dl, dh] = bootDiff(rows, jevYes);
  const cv = cascadeCV(rows);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `${name}: n=${n}`,
    `  Claude ${c}/${n} = ${pct(c / n)} (95% CI ${pct(cl)}-${pct(ch)})`,
    `  Jev    ${j}/${n} = ${pct(j / n)} (95% CI ${pct(jl)}-${pct(jh)})`,
    `  paired: only Jev right ${pr.onlyJev}, only Claude right ${pr.onlyClaude}, both ${pr.both}, neither ${pr.neither}; McNemar p=${pr.p.toFixed(3)}`,
    `  Jev minus Claude: ${pct((j - c) / n)} (bootstrap 95% ${pct(dl)} to ${pct(dh)})`,
    `  cascade (band chosen on train folds, scored held-out): ${pct(cv.accuracy)}, Jev decides ${pct(cv.jevShare)} of checks, bands ${cv.bands.join(", ")}`,
  ].join("\n");
}
