import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";
import {
  approveRealPlacementAndNotify,
  attemptRealPlacement,
  getActiveRealTestUser,
  getLatestDynamicRuns,
  getRealPlacementCircleState,
  rejectRealPlacement,
  resetDynamicPools,
  runAllDynamicVariants,
  seedDynamicPools,
  type DynamicVariant,
} from "../services/dynamicPlacementTest.js";

// Real-test-user-vs-filler-pool feature — every route here either reads
// state or acts on a real, non-simulated test user going through actual
// onboarding. The one action with a real-world side effect (a real Sendblue
// send to a real phone) is POST /approve — everything else is read-only or
// scoped to this feature's own generated filler data.
const router = express.Router();

router.get("/real-user", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getActiveRealTestUser();
    return res.status(200).json({ success: true, user });
  } catch (error) {
    next(error);
  }
});

router.post("/seed", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getActiveRealTestUser();
    if (!user) return res.status(400).json({ success: false, error: "No verified real test user found." });
    if (!user.hasSignal) {
      return res
        .status(400)
        .json({ success: false, error: "Real test user has no captured profile signal yet (no goals/chapters/activities) — have them say more first." });
    }
    const seeded = await seedDynamicPools(user.userId);
    return res.status(200).json({ success: true, seeded });
  } catch (error) {
    next(error);
  }
});

router.post("/run-all", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getActiveRealTestUser();
    if (!user) return res.status(400).json({ success: false, error: "No verified real test user found." });
    const runs = await runAllDynamicVariants(user.userId);
    return res.status(200).json({ success: true, runs });
  } catch (error) {
    next(error);
  }
});

router.get("/runs", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getActiveRealTestUser();
    if (!user) return res.status(200).json({ success: true, runs: [] });
    const runs = await getLatestDynamicRuns(user.userId);
    return res.status(200).json({ success: true, runs });
  } catch (error) {
    next(error);
  }
});

router.post("/attempt-placement", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { variant } = req.body as { variant?: DynamicVariant };
    const user = await getActiveRealTestUser();
    if (!user) return res.status(400).json({ success: false, error: "No verified real test user found." });
    const result = await attemptRealPlacement(user.userId, variant ?? "A");
    return res.status(result.success ? 200 : 400).json({ ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/circle-state", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getActiveRealTestUser();
    if (!user) return res.status(200).json({ success: true, circle: null });

    const circle = await getRealPlacementCircleState(user.userId);
    if (!circle) return res.status(200).json({ success: true, circle: null });

    const circleMembers = await pool.query(
      `SELECT cm.member_id, cm.status, u.first_name, u.is_simulated
       FROM circle_members cm JOIN users u ON u.id = cm.member_id WHERE cm.circle_id = $1`,
      [circle.id],
    );

    return res.status(200).json({ success: true, circle, circle_members: circleMembers.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { circle_id } = req.body as { circle_id: string };
    const result = await approveRealPlacementAndNotify(circle_id);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { circle_id } = req.body as { circle_id: string };
    const result = await rejectRealPlacement(circle_id);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/reset", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await resetDynamicPools();
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
