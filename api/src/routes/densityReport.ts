import { Router, Request, Response } from "express";
import pool from "../db/db.js";
import { RAPPORT_TOPICS, RAPPORT_TOPIC_DESCRIPTIONS, getProfileCompletenessPercent } from "../services/profileExtraction.js";

// Internal-only. Not linked from the app, not authenticated as a normal
// user — gated by a single shared-secret query param checked against
// DENSITY_REPORT_KEY, same spirit as co-test's own dashboard password.
// Read-only: every query here is a plain SELECT against tables this same
// service already owns, so there's no separate credential or cross-
// environment connection to manage.
//
// Answers five questions the Co Loop density build (Stages 1/2/3/5/6) was
// built to eventually answer, per the density-first strategy: is the
// network worth anything yet, is the relevance scoring finding anything
// real, is anyone engaging with follow-up, where is context still thin, and
// is the network actually growing anywhere in particular.
export function createDensityReportRouter(): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!process.env.DENSITY_REPORT_KEY || key !== process.env.DENSITY_REPORT_KEY) {
      return res.status(401).send("Unauthorized");
    }

    const [profilesResult, edgesResult, checkinsResult, weeklyProfilesResult, weeklyEdgesResult, cityResult] =
      await Promise.all([
        pool.query(`SELECT topics_covered FROM co_profiles`),
        pool.query(
          `SELECT match_score, mutual, ask_text FROM relevance_edges WHERE status = 'open' ORDER BY match_score DESC NULLS LAST`,
        ),
        pool.query(`SELECT checkin_count, responded_count, resolved_at FROM ask_checkins`),
        // Last 8 weeks — cheap enough to compute from raw timestamps directly
        // (no snapshot table needed) since co_profiles is small at this stage;
        // revisit if this table grows large enough to make the scan costly.
        pool.query(
          `SELECT date_trunc('week', created_at) AS week, count(*)::int AS count
           FROM co_profiles WHERE created_at > NOW() - INTERVAL '8 weeks'
           GROUP BY week ORDER BY week`,
        ),
        pool.query(
          `SELECT date_trunc('week', created_at) AS week, count(*)::int AS count
           FROM relevance_edges WHERE created_at > NOW() - INTERVAL '8 weeks'
           GROUP BY week ORDER BY week`,
        ),
        // Closest thing to a real "cluster" signal available without a
        // separate embedding-clustering pass — city is already a hard
        // eligibility filter elsewhere (matching.ts's findBestCircleWithScore),
        // so a concentration here is also a concentration of who could
        // eventually be placed together, not just a vanity breakdown.
        pool.query(
          `SELECT city, count(*)::int AS count FROM co_profiles
           WHERE city IS NOT NULL AND city != '' GROUP BY city ORDER BY count DESC LIMIT 15`,
        ),
      ]);

    // Section 1 — network health
    const totalProfiles = profilesResult.rows.length;
    const completenessScores = profilesResult.rows.map((r: any) => getProfileCompletenessPercent(r.topics_covered));
    const avgCompleteness = completenessScores.length
      ? Math.round(completenessScores.reduce((a: number, b: number) => a + b, 0) / completenessScores.length)
      : 0;

    // Section 2 — relevance quality
    const edges = edgesResult.rows;
    const buckets = { "80-100": 0, "60-79": 0, "40-59": 0, "20-39": 0, "0-19": 0 };
    for (const e of edges) {
      const s = e.match_score ?? 0;
      if (s >= 80) buckets["80-100"]++;
      else if (s >= 60) buckets["60-79"]++;
      else if (s >= 40) buckets["40-59"]++;
      else if (s >= 20) buckets["20-39"]++;
      else buckets["0-19"]++;
    }
    const strongEdges = edges.filter((e: any) => (e.match_score ?? 0) >= 60);
    const mutualCount = strongEdges.filter((e: any) => e.mutual).length;
    const topAsks = [...new Set(strongEdges.map((e: any) => e.ask_text as string))].slice(0, 20);

    // Section 3 — follow-up engagement
    const checkins = checkinsResult.rows;
    const totalCheckinSends = checkins.reduce((sum: number, c: any) => sum + (c.checkin_count ?? 0), 0);
    const totalResponses = checkins.reduce((sum: number, c: any) => sum + (c.responded_count ?? 0), 0);
    const responseRate = totalCheckinSends ? Math.round((totalResponses / totalCheckinSends) * 100) : 0;
    const selfResolvedCount = checkins.filter((c: any) => c.resolved_at).length;

    // Section 4 — coverage gaps, network-wide
    const topicCounts: Record<string, number> = {};
    for (const t of RAPPORT_TOPICS) topicCounts[t] = 0;
    for (const row of profilesResult.rows) {
      const covered = row.topics_covered ?? {};
      for (const t of RAPPORT_TOPICS) {
        if (covered[t]) topicCounts[t]++;
      }
    }
    const topicRows = RAPPORT_TOPICS.map((t) => ({
      topic: t,
      description: RAPPORT_TOPIC_DESCRIPTIONS[t],
      coveredCount: topicCounts[t],
      coveredPct: totalProfiles ? Math.round((topicCounts[t] / totalProfiles) * 100) : 0,
    })).sort((a, b) => a.coveredPct - b.coveredPct);

    // Section 5 — growth & city clusters
    const fmtWeek = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const weeklyProfiles = weeklyProfilesResult.rows.map((r: any) => ({ week: fmtWeek(r.week), count: r.count }));
    const weeklyEdges = weeklyEdgesResult.rows.map((r: any) => ({ week: fmtWeek(r.week), count: r.count }));
    const maxWeeklyProfiles = Math.max(1, ...weeklyProfiles.map((r) => r.count));
    const maxWeeklyEdges = Math.max(1, ...weeklyEdges.map((r) => r.count));
    const cityRows = cityResult.rows as { city: string; count: number }[];
    const maxCityCount = Math.max(1, ...cityRows.map((r) => r.count));

    const row2 = (cells: (string | number)[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const barRow = (label: string, count: number, max: number) =>
      `<div class="bar-row"><div class="bar-label">${label}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.round((count / max) * 100)}%"></div></div><div class="bar-count">${count}</div></div>`;

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Co — Density Report</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2.5rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.9rem; }
  td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; }
  .stat { font-size: 1.6rem; font-weight: 600; }
  .stat-label { color: #666; font-size: 0.85rem; }
  .stat-row { display: flex; gap: 2rem; margin-top: 0.75rem; }
  .muted { color: #888; font-size: 0.85rem; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 0.85rem; }
  .bar-label { width: 110px; flex-shrink: 0; color: #444; }
  .bar-track { flex: 1; background: #f0f0f0; border-radius: 3px; height: 14px; overflow: hidden; }
  .bar-fill { background: #4a7dfc; height: 100%; }
  .bar-count { width: 32px; text-align: right; color: #666; flex-shrink: 0; }
</style>
</head>
<body>
<h1>Co — Density Report</h1>
<p class="muted">Generated ${new Date().toISOString()}. Read-only, computed live from production.</p>

<h2>1. Network health</h2>
<div class="stat-row">
  <div><div class="stat">${totalProfiles}</div><div class="stat-label">profiles</div></div>
  <div><div class="stat">${avgCompleteness}%</div><div class="stat-label">avg profile completeness</div></div>
</div>

<h2>2. Relevance quality</h2>
<p class="muted">Open relevance_edges only (retired/acted_on excluded).</p>
<table>
<tr><th>Score range</th><th>Count</th></tr>
${row2(["80-100", buckets["80-100"]])}
${row2(["60-79", buckets["60-79"]])}
${row2(["40-59", buckets["40-59"]])}
${row2(["20-39", buckets["20-39"]])}
${row2(["0-19", buckets["0-19"]])}
</table>
<div class="stat-row">
  <div><div class="stat">${mutualCount} / ${strongEdges.length}</div><div class="stat-label">mutual, among score ≥ 60</div></div>
</div>
${topAsks.length ? `<p class="muted" style="margin-top:1rem;">Asks behind the strong (≥60) matches, for a sense of what's actually being asked for:</p><ul>${topAsks.map((a) => `<li>${a}</li>`).join("")}</ul>` : `<p class="muted">No matches scoring 60+ yet.</p>`}

<h2>3. Follow-up engagement</h2>
<div class="stat-row">
  <div><div class="stat">${checkins.length}</div><div class="stat-label">tracked asks</div></div>
  <div><div class="stat">${responseRate}%</div><div class="stat-label">check-in response rate</div></div>
  <div><div class="stat">${selfResolvedCount}</div><div class="stat-label">resolved on their own</div></div>
</div>

<h2>4. Coverage gaps (network-wide, thinnest first)</h2>
<table>
<tr><th>Topic</th><th>Covered</th><th>%</th></tr>
${topicRows.map((r) => row2([`${r.topic} — ${r.description}`, `${r.coveredCount} / ${totalProfiles}`, `${r.coveredPct}%`])).join("")}
</table>

<h2>5. Growth &amp; city clusters</h2>
<p class="muted">New profiles and relevance edges by week, last 8 weeks.</p>
${weeklyProfiles.length ? `<p class="muted" style="margin-top:1rem;">New profiles</p>${weeklyProfiles.map((r) => barRow(r.week, r.count, maxWeeklyProfiles)).join("")}` : `<p class="muted">No profiles created in the last 8 weeks.</p>`}
${weeklyEdges.length ? `<p class="muted" style="margin-top:1rem;">New relevance edges</p>${weeklyEdges.map((r) => barRow(r.week, r.count, maxWeeklyEdges)).join("")}` : `<p class="muted">No relevance edges logged in the last 8 weeks.</p>`}
${cityRows.length ? `<p class="muted" style="margin-top:1rem;">Profiles by city — the closest thing to a real cluster signal without a separate embedding pass; a concentration here is also a concentration of who could eventually be placed together.</p>${cityRows.map((r) => barRow(r.city, r.count, maxCityCount)).join("")}` : `<p class="muted">No city on file for any profile yet.</p>`}

</body>
</html>`;

    res.status(200).send(html);
  });

  return router;
}
