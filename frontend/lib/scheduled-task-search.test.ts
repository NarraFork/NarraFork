import { describe, expect, test } from "bun:test";
import {
	hasScheduledTaskFilters,
	parseScheduledTaskDetailSearch,
	parseScheduledTaskNewSearch,
	parseScheduledTaskSearch,
	RUN_VERDICTS,
} from "./scheduled-task-search";

describe("scheduled task URL filters", () => {
	test("omits defaults and rejects unsupported or oversized input", () => {
		expect(
			parseScheduledTaskSearch({
				lifecycle: "active",
				sort: "nextRun",
				q: "  ",
				creator: "admin",
				attention: "false",
				kind: "daily",
				result: "success",
				owner: "../user",
				projectId: ["p"],
				runContext: "legacy",
				prompt: "never pass this",
				copyFrom: "other",
			}),
		).toEqual({});
		expect(parseScheduledTaskSearch({ q: "x".repeat(501) })).toEqual({});
		expect(hasScheduledTaskFilters({ sort: "name" })).toBe(false);
	});
	test("preserves combined filters and canonicalizes search", () => {
		const input = {
			lifecycle: "all",
			attention: "true",
			creator: "mine",
			owner: "user_1",
			projectId: "project-1",
			kind: "repeat",
			result: "unconfirmed",
			runContext: "project",
			q: "  周报 & review  ",
			sort: "lastRun",
		};
		const parsed = parseScheduledTaskSearch(input);
		expect(parsed).toEqual({ ...input, attention: true, q: "周报 & review" });
		expect(parseScheduledTaskSearch(parsed)).toEqual(parsed);
		expect(hasScheduledTaskFilters(parsed)).toBe(true);
	});
	test("keeps paused, ended and every two-axis verdict", () => {
		for (const lifecycle of ["paused", "ended", "all"])
			expect(parseScheduledTaskSearch({ lifecycle }).lifecycle).toBe(lifecycle);
		for (const result of RUN_VERDICTS)
			expect(parseScheduledTaskSearch({ result }).result).toBe(result);
	});
	test("detail and copy IDs do not leak into list filters", () => {
		expect(parseScheduledTaskNewSearch({ copyFrom: "task_1", q: "work" })).toEqual({
			copyFrom: "task_1",
			q: "work",
		});
		expect(parseScheduledTaskDetailSearch({ runId: "run_1", lifecycle: "ended" })).toEqual({
			runId: "run_1",
			lifecycle: "ended",
		});
		expect(parseScheduledTaskDetailSearch({ runId: "#invalid" })).toEqual({});
		expect(parseScheduledTaskNewSearch({ copyFrom: 123 })).toEqual({});
		expect(parseScheduledTaskSearch({ copyFrom: "task_1", runId: "run_1" })).toEqual({});
	});
});
