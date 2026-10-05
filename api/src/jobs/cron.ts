// node-cron, but every scheduled job goes through services/shutdown.ts: no
// new runs once a restart begins, running ones are waited for, and the
// tasks are stopped. jobs/index.ts imports this instead of node-cron.
import nodeCron from "node-cron";
import { onStopAccepting, trackedJob } from "../services/shutdown.js";

let count = 0;

function schedule(expression: string, fn: (...args: any[]) => unknown, options?: Parameters<typeof nodeCron.schedule>[2]) {
  const task = nodeCron.schedule(expression, trackedJob(`cron#${++count} (${expression})`, fn), options);
  onStopAccepting(() => task.stop());
  return task;
}

export default { schedule };
