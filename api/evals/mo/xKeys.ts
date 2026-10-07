// Test helper: Co's X send keys on or off (mo/xApi.ts xWriteConfigured). Member-facing Mo runs when MO_ENABLED is on and
// these exist; there is no separate member switch (Royce, 2026-10-07). "partial" sets one key only, which must read as off.
const KEYS = ["X_MO_CONSUMER_KEY", "X_MO_CONSUMER_SECRET", "X_MO_ACCESS_TOKEN", "X_MO_ACCESS_SECRET", "X_MO_USER_ID"] as const;
export function setXKeys(state: "on" | "off" | "partial"): void {
  for (const k of KEYS) delete process.env[k];
  if (state === "on") for (const k of KEYS) process.env[k] = "test";
  if (state === "partial") process.env.X_MO_CONSUMER_KEY = "test";
}
export const xKeysOn = (): boolean => KEYS.every((k) => Boolean(process.env[k]));
