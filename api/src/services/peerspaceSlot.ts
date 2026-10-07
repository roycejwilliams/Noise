// Peerspace's own booking panel, read for one date and start time (Royce, 2026-10-07, browser pilot round 1): the page
// text alone gives a price range and no availability, so a confident "available" could be wrong (826 Valencia was booked
// until 6:30). This sets the date and start time in the listing's panel, exactly as a person would, and reads what the
// panel then shows: "$X x N hours" (or a flat "for N hours" block, or only a drink minimum) and "This space is
// unavailable from ...". No model; nothing is booked (it never presses "Request to book" or "Start Booking"), and it
// runs in the same shared browser as browserRead.ts.
import type { Page } from "playwright-core";
import { browserSlot, privateHost, sharedBrowser } from "./browserRead.js";

export type PeerspaceSlot = { date: string; start: string }; // date "2026-10-22", start "6:00 pm"
// priceRange: the listing shows a range (the rate depends on the day); hourlyPrice is then null, never a guess inside it.
export type SlotFacts = { hourlyPrice: number | null; priceRange: [number, number] | null; minimumHours: number | null; capacity: number | null; available: "yes" | "no" | "unknown"; evidence: string };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const money = (s: string) => Number(s.replace(/[$,]/g, ""));

// "6:00 pm" -> minutes after midnight; "6:30 PM" too.
export function minutesOf(t: string): number | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i);
  if (!m) return null;
  const h = (Number(m[1]) % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  return h * 60 + Number(m[2]);
}

// Pure: what the panel says, read from the page text after the date and start are set.
export function parsePanel(text: string, slot: PeerspaceSlot, state: "chosen" | "not_offered" | "failed", header = ""): SlotFacts {
  const ev: string[] = [];
  let hourlyPrice: number | null = null;
  let priceRange: [number, number] | null = null;
  // The rate the listing itself shows (read before a date was picked): one rate, or a range across days.
  const range = header.match(/\$([\d,]+)\s*[–-]\s*\$([\d,]+)\s*\/\s*hr/);
  const single = header.match(/\$([\d,]+(?:\.\d+)?)\s*\/\s*hr\b/);
  const perHour = text.match(/^\s*\$([\d,]+(?:\.\d+)?)\s*x\s*(\d+)\s*hours?\s*$/im);
  const block = text.match(/(?:room|area|space|rental|package)[^\n$]{0,40}for\s+(\d+)\s+hours?\s*\n?\s*\$([\d,]+(?:\.\d+)?)/i);
  if (range) {
    priceRange = [money(range[1]), money(range[2])];
    ev.push(range[0]);
  } else if (single) {
    hourlyPrice = money(single[1]);
    ev.push(single[0]);
  } else if (perHour) {
    hourlyPrice = money(perHour[1]);
    ev.push(perHour[0]);
  } else if (block) {
    hourlyPrice = Math.round((money(block[2]) / Number(block[1])) * 100) / 100;
    ev.push(block[0].replace(/\s+/g, " "));
  }
  const minM = text.match(/(\d+)\s*hrs?\.?\s*min(?:imum)?\b/i) ?? text.match(/minimum[^\n]{0,20}?(\d+)\s*h/i);
  const capM = text.match(/(?:Up to\s+)?(\d+)\s+people/i);
  const unav = text.match(/This space is unavailable from\s*([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
  let available: SlotFacts["available"] = state === "chosen" ? "yes" : state === "not_offered" ? "no" : "unknown";
  if (state === "not_offered") ev.push(`${slot.start} on ${slot.date} isn't offered in the listing's own panel`);
  if (state === "failed" && slot.date) ev.push("the panel couldn't be set");
  if (unav) {
    ev.push(unav[0]);
    const from = minutesOf(unav[2]), to = minutesOf(unav[3]), at = minutesOf(slot.start);
    if (from !== null && to !== null && at !== null && at >= from && at < to) available = "no";
  }
  return { hourlyPrice, priceRange, minimumHours: minM ? Number(minM[1]) : null, capacity: capM ? Number(capM[1]) : null, available, evidence: ev.join("; ").slice(0, 400) };
}

async function setSlot(page: Page, slot: PeerspaceSlot): Promise<"chosen" | "not_offered" | "failed"> {
  const [y, mo, d] = slot.date.split("-").map(Number);
  const want = `${MONTHS[mo - 1]} ${y}`;
  const opener = page.getByRole("button", { name: /^start date$|^[A-Z][a-z]+ \d{1,2}(st|nd|rd|th), \d{4}$/ }).first();
  await opener.click({ timeout: 5_000 });
  const dialog = page.locator("[role=dialog]").filter({ has: page.locator("[role=grid]") }).first();
  for (let i = 0; i < 13; i++) {
    const head = (await dialog.locator("[aria-live=polite]").first().innerText({ timeout: 3_000 }).catch(() => "")).trim();
    if (head === want) break;
    await dialog.getByRole("button", { name: "Go to next month" }).click({ timeout: 3_000 });
    await page.waitForTimeout(300);
  }
  const day = dialog.locator('button[name="day"]').filter({ hasText: new RegExp(`^\\s*${d}\\s*$`) }).first();
  if (!(await day.count())) return "failed";
  if (await day.isDisabled().catch(() => true)) return "not_offered"; // the whole day is blocked
  await day.click({ timeout: 3_000 });
  await page.waitForTimeout(800);
  // The time selects carry no accessible name, only their text: the first is the start.
  const start = page.getByRole("combobox").first();
  await start.click({ timeout: 4_000 });
  const option = page.getByRole("option", { name: new RegExp(`^${slot.start.replace(/\s+/g, "\\s*")}$`, "i") }).first();
  const offered = await page.getByRole("option").count();
  if (!(await option.count()) || (await option.getAttribute("aria-disabled")) === "true" || (await option.getAttribute("data-disabled")) !== null) {
    await page.keyboard.press("Escape").catch(() => {});
    // The list loaded but this start isn't in it (or is greyed out): that time is taken.
    return offered > 0 ? "not_offered" : "failed";
  }
  await option.click({ timeout: 3_000 });
  await page.waitForTimeout(2_500);
  return "chosen";
}

// One listing, one slot. Null when the page or the panel couldn't be read.
// slot null: no date asked, so only the listing's own rate, minimum and capacity (availability stays unknown).
export async function readPeerspaceSlot(url: string, slot: PeerspaceSlot | null): Promise<{ facts: SlotFacts; text: string } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || privateHost(u.hostname) || !/(^|\.)peerspace\.com$/.test(u.hostname)) return null;
  const release = await browserSlot();
  const b = await sharedBrowser();
  const context = await b.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", locale: "en-US", viewport: { width: 1400, height: 950 } });
  try {
    // Read-only at the network: nothing but GET/HEAD leaves. Not even Peerspace's own price quote (2026-10-07: its response
    // carries new contract ids, so it records something on their side). Picking a date and reading which start times are
    // offered needs no POST; the exact slot price does, so the price is the listing's own shown rate or range.
    await context.route("**/*", (route) => {
      const req = route.request();
      if (!["GET", "HEAD"].includes(req.method()) || ["font", "media", "image"].includes(req.resourceType())) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const res = await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (!res || res.status() >= 400) return null;
    await page.waitForTimeout(3_000);
    // The panel's own rate line before a date is picked ("$200 /hr 2 hr minimum", or "$175–$250/hr").
    const before = (await page.innerText("body", { timeout: 5_000 })).replace(/[ \t]+/g, " ");
    const at = before.search(/Date and time/);
    const header = at > 0 ? before.slice(Math.max(0, at - 300), at) : "";
    if (!slot) return { facts: parsePanel(before, { date: "", start: "" }, "failed", header), text: before };
    const state = await setSlot(page, slot).catch(() => "failed" as const);
    const text = (await page.innerText("body", { timeout: 5_000 })).replace(/[ \t]+/g, " ");
    return { facts: parsePanel(text, slot, state, header), text };
  } catch {
    return null;
  } finally {
    await context.close().catch(() => {});
    release();
  }
}
