// Per-tier counts for one search and one day (Royce, 2026-10-28: "show what each tier searched, found, kept and dropped" on /sweeps).
// Tiers by kind of page: 1 Noise's own events, 2 event pages (any page that is one public event by its own record, eventPage.ts),
// 3 web and X openings. No imports, so the dashboard's rollup (dailySweep.ts) reads it without the search's own modules.
export type TierCount = { searched: number; found: number; kept: number; dropped: number };
export type TierCounts = Record<"1" | "2" | "3", TierCount>;
export const emptyTierCounts = (): TierCounts => ({ "1": { searched: 0, found: 0, kept: 0, dropped: 0 }, "2": { searched: 0, found: 0, kept: 0, dropped: 0 }, "3": { searched: 0, found: 0, kept: 0, dropped: 0 } });
export const tierKey = (t: unknown): "1" | "2" | "3" => (t === 1 ? "1" : t === 2 ? "2" : "3");
