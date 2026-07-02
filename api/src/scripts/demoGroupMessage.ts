// One-off demo: exercises the real Sendblue group-messaging integration
// (the same client used in co.ts's consensus-poll and Keana-approval flows)
// against real phone numbers, since fake circle members can't receive iMessages.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "api/.env") });

async function main() {
  const { default: sendblue } = await import("../services/sendblue.js");

  const targets = [
    { label: "Keana", number: process.env.KEANA_PHONE_NUMBER! },
    { label: "Royce", number: "+12817432976" },
  ];

  for (const t of targets) {
    try {
      const result = await sendblue.messages.send({
        number: t.number,
        content: `Co here — verifying ${t.label}'s contact before the group test.`,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
      console.log(`${t.label} (${t.number}): OK`, JSON.stringify(result));
    } catch (err: any) {
      console.log(`${t.label} (${t.number}): FAILED`, err?.error?.message ?? err?.message ?? err);
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
