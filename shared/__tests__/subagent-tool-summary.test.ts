import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	buildSubagentSummarySqlExpr,
	projectSubagentToolInputSummary,
} from "../subagent-tool-summary";

describe("scheduled task summary projection", () => {
	test("projects actions and outcomes without reading prompts or report details", () => {
		const input = {
			action: "create",
			outcome: "partial",
			id: "task",
			get task() {
				throw new Error("must not read task prompt");
			},
			get summary() {
				throw new Error("must not read report body");
			},
		};
		expect(projectSubagentToolInputSummary(input)).toEqual({
			action: "create",
			outcome: "partial",
			id: "task",
		});
	});

	test("SQL uses the same bounded, prompt-free projection", () => {
		const db = new Database(":memory:");
		try {
			const row = db
				.query<{ value: string }, [string]>(
					`SELECT ${buildSubagentSummarySqlExpr("input")} AS value FROM (SELECT ? AS input)`,
				)
				.get(
					JSON.stringify({
						action: "update",
						outcome: "done",
						task: { prompt: "SECRET_PROMPT" },
						summary: "SECRET_SUMMARY",
					}),
				);
			expect(row?.value).toContain('"action":"update"');
			expect(row?.value).toContain('"outcome":"done"');
			expect(row?.value).not.toContain("SECRET");
		} finally {
			db.close();
		}
	});
});
