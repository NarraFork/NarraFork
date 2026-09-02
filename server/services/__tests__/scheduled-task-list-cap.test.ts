/**
 * `scheduledTaskService.list()` must be bounded, and must say when it truncated.
 *
 * The row count here is not curated by anyone. Tasks come from the UI *and* from the
 * `ScheduledTask` agent tool, so a model in a retry loop adds rows as fast as it can
 * call it. An unbounded `findMany` on the request path is what this repo's main-thread
 * rule forbids: the list route and the tool both run on the single JS thread, and the
 * tool then serialises the whole result into the model's context, paying the cost twice.
 *
 * The flag matters as much as the cap. A silently short list reads as "these are all
 * the tasks", and what it hides is a schedule the user believes is armed — so the
 * caller has to be able to tell the difference between "500 tasks" and "at least 500".
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/scheduled-task-list-cap.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_LOCALE } from "@shared/i18n-locales";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { scheduledTasks } from "../../db/schema";
import { generateId } from "../../lib/id";
import { scheduledTaskService } from "../scheduled-task-service";

/** Mirrors `LIST_MAX` in the service. Duplicated so a change there fails here loudly. */
const LIST_MAX = 500;

const createdIds: string[] = [];

afterEach(async () => {
	if (createdIds.length === 0) return;
	await db.delete(scheduledTasks).where(inArray(scheduledTasks.id, createdIds.splice(0)));
});

/**
 * Insert rows directly rather than through `create()`.
 *
 * `create()` computes a cron fire time and takes the service mutex per call, so 501 of
 * them would make this test minutes long and would be testing croner, not the cap. The
 * cap only reads `id`/`createdAt`, so a raw insert exercises the same query path.
 */
async function insertTasks(count: number): Promise<void> {
	const base = Date.now();
	const rows = Array.from({ length: count }, (_, i) => {
		const id = generateId();
		createdIds.push(id);
		return {
			id,
			name: `cap-probe-${i}`,
			enabled: false,
			cronExpr: "0 9 * * *",
			timezone: null,
			prompt: "x",
			systemPrompt: null,
			model: null,
			permissionMode: "bypassPermissions" as const,
			locale: DEFAULT_LOCALE,
			runContext: "standalone" as const,
			cwd: null,
			projectId: null,
			chapterId: null,
			narratorMode: "new" as const,
			reuseNarratorId: null,
			// Ordered so the cap's `asc(createdAt)` slice is deterministic and the row
			// left out is the newest one, not an arbitrary one.
			createdAt: new Date(base + i).toISOString(),
			updatedAt: new Date(base + i).toISOString(),
			nextRunAt: null,
			lastRunAt: null,
			lastNarratorId: null,
			lastStatus: null,
			lastError: null,
			createdBy: null,
		};
	});
	// Chunked: SQLite has a bound-parameter ceiling, and one 501-row insert with ~24
	// columns each exceeds it.
	for (let i = 0; i < rows.length; i += 100) {
		await db.insert(scheduledTasks).values(rows.slice(i, i + 100));
	}
}

describe("scheduledTaskService.list is bounded", () => {
	test("returns every row and truncated:false below the cap", async () => {
		await insertTasks(3);

		const { tasks, truncated } = await scheduledTaskService.list();

		expect(tasks.length).toBe(3);
		expect(truncated).toBe(false);
	});

	test("caps the result and reports truncation above the cap", async () => {
		// One past the cap: the smallest input that must truncate. A test using a
		// comfortably larger number would also pass against an off-by-one cap.
		await insertTasks(LIST_MAX + 1);

		const { tasks, truncated } = await scheduledTaskService.list();

		expect(tasks.length).toBe(LIST_MAX);
		expect(truncated).toBe(true);
	});

	test("exactly the cap is NOT reported as truncated", async () => {
		// The `LIMIT n + 1` probe row must not be mistaken for real overflow: reporting
		// truncation at exactly the cap would make the flag cry wolf, and a flag that
		// fires when nothing is missing stops being read.
		await insertTasks(LIST_MAX);

		const { tasks, truncated } = await scheduledTaskService.list();

		expect(tasks.length).toBe(LIST_MAX);
		expect(truncated).toBe(false);
	});

	test("does not return the extra probe row it fetched", async () => {
		// The implementation asks for `LIST_MAX + 1` to learn whether more exists. If it
		// forgot to slice, callers would get one row past their own stated ceiling —
		// harmless-looking until something downstream sizes a buffer by the cap.
		await insertTasks(LIST_MAX + 5);

		const { tasks } = await scheduledTaskService.list();

		expect(tasks.length).toBeLessThanOrEqual(LIST_MAX);
		expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
	});
});
