import "dotenv/config";
import { printReview } from "../harness/devReview.js";

// "What broke since X" (harness/devReview.ts), for a session. Flags only.
//
//   npm run broke                          the last 24 hours
//   npm run broke -- --since 3d            the last 3 days (h / d)
//   npm run broke -- --since 2026-09-18T19:00Z [--until ...]
//   npm run broke -- --no-model            log and conversation checks only
//   npm run broke -- --digest              print the morning text instead
//   npm run broke -- --store               also save the flags (co-test only)
//
// On co-test (this scripts folder isn't in its build), see printReview.
const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
printReview({ since: arg("since"), until: arg("until"), model: !args.includes("--no-model"), digest: args.includes("--digest"), store: args.includes("--store") }).catch((err) => {
  console.error(err);
  process.exit(1);
});
