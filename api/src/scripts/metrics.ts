import "dotenv/config";
import { computeMetrics, metricLines } from "../harness/metrics.js";

// The business numbers (harness/metrics.ts), on demand:
//   npm run metrics                 the last 30 days
//   npm run metrics -- --days 7
// On co-test this runs inside the container, like the "what broke" review.
const args = process.argv.slice(2);
const i = args.indexOf("--days");
const days = i === -1 ? 30 : Math.max(1, Number(args[i + 1]) || 30);
Promise.all([computeMetrics(days), import("../harness/northStar.js").then((n) => n.computeNorthStar(days).then((v) => n.northStarLines(v)))])
  .then(([m, north]) => {
    console.log(`The two numbers, last ${days} days\n`);
    for (const line of north) console.log(`- ${line}`);
    console.log(`\nCue numbers, last ${days} days\n`);
    for (const line of metricLines(m)) console.log(`- ${line}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
