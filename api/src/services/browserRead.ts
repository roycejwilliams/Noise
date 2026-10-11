// Reading a page in a real browser when a plain fetch is turned away (Royce,
// 2026-09-30: "instinct uses a cloud computer backend.. that's why we can see
// the pages"). Peerspace, The Bash and most marketplaces answer a plain fetch
// with 403 or load their listings by script; headless Chrome reads them
// (tested 2026-09-30: Peerspace search 24k characters with 36 listings, a
// listing's "$75/hr 2 hr minimum"). GigSalad, Yelp and The Knot still block it.
//
// Only a fallback: readPageText (webOpportunitySearch.ts) tries the fetch first.
// One shared browser, at most two pages at once, 15s a page, closed when idle.
// Images, fonts and media aren't loaded, and nothing on a private address is.
// No Chromium (a laptop without it, or BROWSER_READ=off): returns null and
// the search works as before.
import fs from "node:fs";
import type { Browser } from "playwright-core";

export const BROWSER_LIMITS = { pages: 2, pageMs: 15_000, settleMs: 2_500, idleMs: 120_000, retryAfterFailMs: 10 * 60_000 };

// A request the page makes may not reach a local or private address.
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || h === "0.0.0.0" || h.includes(":")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // Alpine's package (Dockerfile); elsewhere Playwright's own download.
  return ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
}

// The links on pages read recently, so a result found on a list page can point
// at its own listing (2026-09-30: Peerspace results linked the category page,
// a list of 36 spaces).
const LINKS_KEPT = 50;
const seenLinks = new Map<string, { text: string; href: string }[]>();
export function linksSeen(url: string): { text: string; href: string }[] {
  return seenLinks.get(url) ?? [];
}
export function rememberLinks(url: string, links: { text: string; href: string }[]): void {
  seenLinks.delete(url);
  seenLinks.set(url, links.slice(0, 400));
  while (seenLinks.size > LINKS_KEPT) seenLinks.delete(seenLinks.keys().next().value!);
}

// The link on a list page whose text names this thing, on the same site.
export function ownLink(pageUrl: string, name: string): string | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  const key = name.toLowerCase().replace(/\s+/g, " ").trim();
  const hit = linksSeen(pageUrl).find((l) => {
    try {
      return new URL(l.href).hostname === host && l.href !== pageUrl && l.text.toLowerCase().replace(/\s+/g, " ").includes(key);
    } catch {
      return false;
    }
  });
  return hit?.href ?? null;
}

let browser: Promise<Browser> | null = null;
let idle: NodeJS.Timeout | null = null;
let failedAt = 0;
let open = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<() => void> {
  if (open >= BROWSER_LIMITS.pages) await new Promise<void>((r) => waiting.push(r));
  open++;
  return () => {
    open--;
    waiting.shift()?.();
  };
}

function getBrowser(): Promise<Browser> {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => void closeBrowser(), BROWSER_LIMITS.idleMs);
  idle.unref?.();
  browser ??= import("playwright-core").then(({ chromium }) =>
    chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] }),
  );
  browser.catch(() => {
    browser = null;
    failedAt = Date.now();
  });
  return browser;
}

// The same shared browser and page slots, for the SDK venue reader (services/sdkBrowserReader.ts, pilot 2026-10-07).
export const sharedBrowser = (): Promise<Browser> => getBrowser();
export const browserSlot = (): Promise<() => void> => slot();

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (b) await b.then((x) => x.close()).catch(() => {});
}

export function browserReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BROWSER_READ !== "off" && Date.now() - failedAt > BROWSER_LIMITS.retryAfterFailMs;
}

// The page's visible text, or null.
export async function browserPageText(url: string): Promise<string | null> {
  if (!browserReadEnabled()) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || privateHost(u.hostname)) return null;
  // Names are resolved too (security review, 2026-10-11): a public-looking name that points at a private address is refused, for
  // the page and for every request it makes.
  const { hostIsPublic } = await import("./linkReader.js");
  const resolved = new Map<string, Promise<boolean>>();
  const publicHost = (h: string) => {
    if (!resolved.has(h)) resolved.set(h, hostIsPublic(h.replace(/^\[|\]$/g, "")).catch(() => false));
    return resolved.get(h)!;
  };
  if (!(await publicHost(u.hostname))) return null;
  const release = await slot();
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      javaScriptEnabled: true,
    });
    await context.route("**/*", async (route) => {
      const req = route.request();
      let host = "";
      try {
        host = new URL(req.url()).hostname;
      } catch {}
      if (!/^https?:/.test(req.url()) || privateHost(host) || ["image", "font", "media"].includes(req.resourceType())) return route.abort();
      if (!(await publicHost(host))) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const res = await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: BROWSER_LIMITS.pageMs });
    if (!res || res.status() >= 400) return null;
    await page.waitForTimeout(BROWSER_LIMITS.settleMs);
    const text = (await page.innerText("body", { timeout: 3_000 })).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const links = await page.$$eval("a[href]", (as) => as.map((a) => ({ text: ((a as HTMLElement).innerText || "").slice(0, 300), href: (a as HTMLAnchorElement).href }))).catch(() => []);
    rememberLinks(u.toString(), links.filter((l) => l.text.trim() && /^https:/.test(l.href)));
    return text.length >= 200 ? text : null;
  } catch (err: any) {
    if (/Executable doesn't exist|Failed to launch|ENOENT/i.test(err?.message ?? "")) failedAt = Date.now();
    return null;
  } finally {
    await context?.close().catch(() => {});
    release();
  }
}

// A one-page PDF of HTML Co wrote itself (services/planSheet.ts), or null. No scripts run and the only
// network it may reach is the font host the page names, so nothing in the page can send anything anywhere.
// size: a fixed page size ("13.333in" x "7.5in" for a 16:9 deck, PR 4); without it, Letter as before.
export async function renderPdf(html: string, size?: { width: string; height: string }): Promise<Buffer | null> {
  if (!browserReadEnabled()) return null;
  const release = await slot();
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    const b = await getBrowser();
    context = await b.newContext({ javaScriptEnabled: false, locale: "en-US" });
    await context.route("**/*", (route) => {
      let host = "";
      try {
        host = new URL(route.request().url()).hostname;
      } catch {}
      return host === "fonts.googleapis.com" || host === "fonts.gstatic.com" || route.request().url().startsWith("data:") ? route.continue() : route.abort();
    });
    const pg = await context.newPage();
    await pg.setContent(html, { waitUntil: "load", timeout: BROWSER_LIMITS.pageMs });
    // Give the web font a few seconds; without it the serif falls back and the sheet still reads. A slow
    // font host never fails the send.
    await Promise.race([pg.evaluate(() => (document as any).fonts?.ready), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
    // No page range: a long plan flows onto a second page rather than losing steps the calendar still has.
    const pdf = await pg.pdf({ ...(size ? { width: size.width, height: size.height } : { format: "Letter" as const }), printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
    return pdf.length > 1_000 ? Buffer.from(pdf) : null;
  } catch (err: any) {
    if (/Executable doesn't exist|Failed to launch|ENOENT/i.test(err?.message ?? "")) failedAt = Date.now();
    return null;
  } finally {
    await context?.close().catch(() => {});
    release();
  }
}
