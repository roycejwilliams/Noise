import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "api/.env") });

async function main() {
  const { default: sendblue } = await import("../services/sendblue.js");

  for (const number of [process.env.KEANA_PHONE_NUMBER!, "+12817432976"]) {
    try {
      const contact = await sendblue.contacts.retrieve(number);
      console.log(number, "->", JSON.stringify(contact));
    } catch (err: any) {
      console.log(number, "-> ERROR", err?.error ?? err?.message ?? err);
    }
  }

  try {
    const list = await sendblue.contacts.list();
    console.log("\nAll contacts on this account:", JSON.stringify(list, null, 2));
  } catch (err: any) {
    console.log("list ERROR", err?.error ?? err?.message ?? err);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
