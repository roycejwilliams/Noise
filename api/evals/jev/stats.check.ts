// Sanity checks for stats.ts: known values, so the scoring can be trusted.
//   npx tsx evals/jev/stats.check.ts
import { mcnemar, wilson, bootDiff, cascadeCV, calibration, type Row } from "./stats.js";
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
check("mcnemar 0 vs 0 is p=1", mcnemar(0, 0) === 1);
check("mcnemar 5 vs 5 is p=1", Math.abs(mcnemar(5, 5) - 1) < 1e-9);
check("mcnemar 10 vs 0 matches the exact value 2/1024", Math.abs(mcnemar(10, 0) - 2 / 1024) < 1e-9);
check("mcnemar 11 vs 3 is about 0.057", Math.abs(mcnemar(11, 3) - 0.0574) < 0.002);
const [lo, hi] = wilson(50, 100);
check("wilson 50/100 is about 40%-60%", lo > 0.39 && lo < 0.41 && hi > 0.59 && hi < 0.61);
check("wilson 0/0 is the full range", wilson(0, 0)[0] === 0 && wilson(0, 0)[1] === 1);
const same: Row[] = Array.from({ length: 40 }, (_, i) => ({ label: i % 2 === 0, claude: i % 2 === 0, jevP: i % 2 === 0 ? 0.9 : 0.1 }));
const [dl, dh] = bootDiff(same);
check("identical systems: bootstrap diff straddles 0 (exactly 0)", dl === 0 && dh === 0);
const cv = cascadeCV(same);
check("perfect systems: cascade is perfect", cv.accuracy === 1);
const cal = calibration(same);
check("calibration bins count every row", cal.reduce((a, b) => a + b.n, 0) === same.length);
console.log(`stats checks: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
