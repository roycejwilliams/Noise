import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "api/.env") });

const PROD_WEBHOOK = "https://copatible-production.up.railway.app/sendblue/webhook";

async function main() {
  const { default: sendblue } = await import("../services/sendblue.js");
  const result = await sendblue.webhooks.update({
    webhooks: {
      receive: [PROD_WEBHOOK],
      outbound: [PROD_WEBHOOK],
      typing_indicator: [PROD_WEBHOOK],
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Failed:", err?.error ?? err?.message ?? err);
  process.exit(1);
});
