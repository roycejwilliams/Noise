import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "api/.env") });

async function main() {
  const { default: sendblue } = await import("../services/sendblue.js");
  const result = await sendblue.webhooks.list();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Failed:", err?.error ?? err?.message ?? err);
  process.exit(1);
});
