import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";
import {
  getLastScenarioRun,
  resetSimulatedData,
  resolveConsensusNow,
  runMatchingForSimulatedGroup,
  SCENARIOS,
  seedFakeVenues,
  seedScenario,
  seedSimulatedMembers,
  simulateAvailabilityResponse,
  simulateCircleResponse,
  simulateModeratorApproval,
  type ScenarioId,
} from "../services/circlesSimulation.js";

// Internal-only test-harness endpoints for the Circles pipeline simulation
// (see circlesSimulation.ts) — never reachable from Sendblue's real webhook,
// only from the checklist page's own "Circles pipeline test" panel. Every
// response here is explicitly marked simulated: true so the client can
// never accidentally render this next to real-test data without the
// distinction being visible.
const router = express.Router();

// circles/circle_members/moments/moment_responses are shared tables between
// this simulation harness and the real dynamic-placement-test flow (see
// dynamicPlacementTest.ts) — moderatorActions.ts's mutation functions accept
// a bare id with no filter, so without this check a circle_id/moment_id
// belonging to a real (non-simulated) test placement could be force-mutated
// through these simulation-only routes. This is on top of, not instead of,
// requireInternalAuth gating the whole router in server.ts.
async function assertSimulatedCircle(res: Response, circleId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM circles WHERE id = $1 AND is_simulated = true`, [circleId]);
  if (result.rows.length > 0) return true;
  res.status(403).json({ success: false, error: "Not a simulated circle." });
  return false;
}

async function assertSimulatedMoment(res: Response, momentId: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM moments WHERE id = $1 AND is_simulated = true`, [momentId]);
  if (result.rows.length > 0) return true;
  res.status(403).json({ success: false, error: "Not a simulated moment." });
  return false;
}

// GET /scenarios — static catalog for the panel's scenario picker.
router.get("/scenarios", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const list = Object.values(SCENARIOS).map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      expectedNote: s.expected.note,
    }));
    return res.status(200).json({ success: true, scenarios: list });
  } catch (error) {
    next(error);
  }
});

router.post("/seed", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scenario } = req.body as { scenario?: ScenarioId };
    const venues = await seedFakeVenues();
    const members =
      scenario && SCENARIOS[scenario] ? await seedScenario(scenario) : await seedSimulatedMembers(6);
    return res.status(200).json({ success: true, simulated: true, member_ids: members.userIds, venues, scenario: scenario ?? null });
  } catch (error) {
    next(error);
  }
});

router.post("/reset", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await resetSimulatedData();
    return res.status(200).json({ success: true, simulated: true });
  } catch (error) {
    next(error);
  }
});

router.post("/match", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runMatchingForSimulatedGroup();
    return res.status(result.success ? 200 : 400).json({ ...result, simulated: true });
  } catch (error) {
    next(error);
  }
});

// GET /state — everything the panel needs to render current simulated
// circle/moment/member status in one call.
router.get("/state", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const members = await pool.query(
      `SELECT id, first_name FROM users WHERE is_simulated = true ORDER BY first_name`,
    );
    const circle = await pool.query(
      `SELECT id, circle_name, status FROM circles WHERE is_simulated = true ORDER BY created_at DESC LIMIT 1`,
    );
    const circleMembers = circle.rows[0]
      ? await pool.query(
          `SELECT cm.member_id, cm.status, u.first_name FROM circle_members cm JOIN users u ON u.id = cm.member_id WHERE cm.circle_id = $1`,
          [circle.rows[0].id],
        )
      : { rows: [] as any[] };
    const moment = circle.rows[0]
      ? await pool.query(
          `SELECT id, moments_name, status, venue, candidate_windows, suggested_time FROM moments WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [circle.rows[0].id],
        )
      : { rows: [] as any[] };
    const momentResponses = moment.rows[0]
      ? await pool.query(
          `SELECT mr.user_id, mr.response, mr.selected_windows, u.first_name FROM moment_responses mr JOIN users u ON u.id = mr.user_id WHERE mr.moment_id = $1`,
          [moment.rows[0].id],
        )
      : { rows: [] as any[] };

    const lastScenarioRun = await getLastScenarioRun();

    return res.status(200).json({
      success: true,
      simulated: true,
      members: members.rows,
      circle: circle.rows[0] ?? null,
      circle_members: circleMembers.rows,
      moment: moment.rows[0] ?? null,
      moment_responses: momentResponses.rows,
      scenario_run: lastScenarioRun,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/circle-response", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { circle_id, member_id, action } = req.body as { circle_id: string; member_id: string; action: "accept" | "decline" };
    if (!(await assertSimulatedCircle(res, circle_id))) return;
    const result = await simulateCircleResponse(circle_id, member_id, action);
    return res.status(result.success ? 200 : 400).json({ ...result, simulated: true });
  } catch (error) {
    next(error);
  }
});

router.post("/moderator-approval", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { target, action } = req.body as {
      target: { type: "circle"; circleId: string } | { type: "venue"; momentId: string };
      action: "approve" | "reject";
    };
    const isSimulated =
      target.type === "circle" ? await assertSimulatedCircle(res, target.circleId) : await assertSimulatedMoment(res, target.momentId);
    if (!isSimulated) return;
    const result = await simulateModeratorApproval(target, action);
    return res.status(result.success ? 200 : 400).json({ ...result, simulated: true });
  } catch (error) {
    next(error);
  }
});

router.post("/resolve-consensus", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { moment_id } = req.body as { moment_id: string };
    if (!(await assertSimulatedMoment(res, moment_id))) return;
    const result = await resolveConsensusNow(moment_id);
    return res.status(result.success ? 200 : 400).json({ ...result, simulated: true });
  } catch (error) {
    next(error);
  }
});

router.post("/availability-response", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { moment_id, member_id, selected_windows } = req.body as {
      moment_id: string;
      member_id: string;
      selected_windows: number[];
    };
    if (!(await assertSimulatedMoment(res, moment_id))) return;
    const result = await simulateAvailabilityResponse(moment_id, member_id, selected_windows);
    return res.status(200).json({ ...result, simulated: true });
  } catch (error) {
    next(error);
  }
});

export default router;
