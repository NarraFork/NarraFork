import { and, count, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import {
	apiRequests,
	containerInstances,
	narrators,
	projects,
	scheduledTasks,
	terminals,
} from "../db/schema";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { projectPrincipalOf } from "../lib/project-access";
import { narratorReadableWhere } from "../services/narrator-acl";
import { narratorService } from "../services/narrator-service";
import { projectReadableWhere } from "../services/project-acl";

export const dashboardRoutes = new Hono();

/**
 * GET /api/dashboard/summary
 * Read-only aggregated endpoint for the dashboard home page.
 * All COUNT queries use indexed columns; no full-table scans.
 */
dashboardRoutes.get("/summary", async (c) => {
	// ── Projects ──────────────────────────────────────────────────────────
	// Counted over the projects this user may read. A total that included projects they
	// cannot open would be both misleading and a disclosure of how much other work
	// exists on the instance.
	const projectReadable = projectReadableWhere(projectPrincipalOf(c));
	const [activeProjectResult] = await db
		.select({ c: count() })
		.from(projects)
		.where(and(eq(projects.status, "active"), projectReadable));
	const activeProjectCount = activeProjectResult?.c ?? 0;

	const [totalProjectResult] = await db
		.select({ c: count() })
		.from(projects)
		.where(projectReadable);
	const totalProjectCount = totalProjectResult?.c ?? 0;

	// ── Narrators (primary variant only, exclude archived) ────────────────
	// Every narrator aggregate below is scoped to what this user may read. Counting
	// sessions they cannot open would both mislead ("3 waiting" with nothing to act
	// on) and leak activity from private work.
	const narratorBaseCondition = and(
		eq(narrators.variant, "primary"),
		ne(narrators.status, "archived"),
		narratorReadableWhere(narratorPrincipalOf(c)),
	);

	const [workingResult] = await db
		.select({ c: count() })
		.from(narrators)
		.where(and(narratorBaseCondition, eq(narrators.status, "working")));
	const workingNarratorCount = workingResult?.c ?? 0;

	const [waitingResult] = await db
		.select({ c: count() })
		.from(narrators)
		.where(and(narratorBaseCondition, eq(narrators.status, "waiting")));
	const waitingNarratorCount = waitingResult?.c ?? 0;

	// ── Terminals ─────────────────────────────────────────────────────────
	const [runningTerminalResult] = await db
		.select({ c: count() })
		.from(terminals)
		.where(eq(terminals.status, "running"));
	const runningTerminalCount = runningTerminalResult?.c ?? 0;

	// ── Containers ────────────────────────────────────────────────────────
	const [runningContainerResult] = await db
		.select({ c: count() })
		.from(containerInstances)
		.where(eq(containerInstances.status, "running"));
	const runningContainerCount = runningContainerResult?.c ?? 0;

	// ── Scheduled tasks ───────────────────────────────────────────────────
	const [enabledTaskResult] = await db
		.select({ c: count() })
		.from(scheduledTasks)
		.where(eq(scheduledTasks.enabled, true));
	const enabledScheduledTaskCount = enabledTaskResult?.c ?? 0;

	// ── Today cost (from api_requests table, not narrators.totalCostUsd) ──
	// narrators.totalCostUsd is a cumulative lifetime value, not a daily delta.
	// api_requests has per-request cost_usd + created_at with idx_api_requests_created index.
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const todayStartIso = todayStart.toISOString();

	const [todayCostResult] = await db
		.select({ total: sql<number>`coalesce(sum(${apiRequests.costUsd}), 0)` })
		.from(apiRequests)
		.where(gte(apiRequests.createdAt, todayStartIso));
	const todayCostUsd = todayCostResult?.total ?? 0;

	// ── Today tokens (input + output + reasoning) ─────────────────────────
	// Same api_requests source and created_at index as the cost aggregate above.
	const [todayTokensResult] = await db
		.select({
			input: sql<number>`coalesce(sum(${apiRequests.inputTokens}), 0)`,
			output: sql<number>`coalesce(sum(${apiRequests.outputTokens}), 0)`,
			reasoning: sql<number>`coalesce(sum(${apiRequests.reasoningTokens}), 0)`,
		})
		.from(apiRequests)
		.where(gte(apiRequests.createdAt, todayStartIso));
	const todayTokens = {
		input: todayTokensResult?.input ?? 0,
		output: todayTokensResult?.output ?? 0,
		reasoning: todayTokensResult?.reasoning ?? 0,
		total:
			(todayTokensResult?.input ?? 0) +
			(todayTokensResult?.output ?? 0) +
			(todayTokensResult?.reasoning ?? 0),
	};

	// ── Attention: permission count ───────────────────────────────────────
	// N+1 pattern: query waiting narrators, then call getPendingPermissions per narrator.
	// Waiting narrators are typically very few; limit 50 as a safety cap.
	const waitingNarrators = await db
		.select({ id: narrators.id })
		.from(narrators)
		.where(and(narratorBaseCondition, eq(narrators.status, "waiting")))
		.limit(50);

	let permissionCount = 0;
	for (const n of waitingNarrators) {
		const permissions = await narratorService.getPendingPermissions(n.id);
		permissionCount += permissions.length;
	}

	// ── Attention: failed narrator count ──────────────────────────────────
	const [failedResult] = await db
		.select({ c: count() })
		.from(narrators)
		.where(and(narratorBaseCondition, isNotNull(narrators.errorMessage)));
	const failedNarratorCount = failedResult?.c ?? 0;

	return c.json({
		activeProjectCount,
		totalProjectCount,
		workingNarratorCount,
		waitingNarratorCount,
		runningTerminalCount,
		runningContainerCount,
		enabledScheduledTaskCount,
		todayCostUsd,
		todayTokens,
		attention: {
			permissionCount,
			failedNarratorCount,
		},
	});
});
