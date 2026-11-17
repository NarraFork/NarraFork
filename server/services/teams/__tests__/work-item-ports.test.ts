/**
 * The production session hold of a base sync (P3 review S4): while it holds the worker and its
 * helpers, none of them can claim an execution (a run cannot start), and a session that is
 * already running, waiting or owned makes the whole hold fail without holding anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "../../../db";
import { tryClaimExecution } from "../../agent-runtime/ownership";
import { productionWorkItemPorts } from "../work-item-ports";

const NOW = "2026-11-17T00:00:00.000Z";

beforeEach(() => {
	for (const [id, status] of [
		["p3h-worker", "idle"],
		["p3h-helper", "idle"],
		["p3h-busy", "working"],
	])
		sqlite.run(
			"INSERT INTO narrators (id, type, status, created_at, updated_at) VALUES (?, 'subagent', ?, ?, ?)",
			[id, status, NOW, NOW],
		);
});
afterEach(() => {
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'p3h-%'");
});

describe("holdSessions", () => {
	test("no session can claim an execution while held; released afterwards", async () => {
		const result = await productionWorkItemPorts.holdSessions(
			["p3h-worker", "p3h-helper"],
			async () => {
				expect(tryClaimExecution("p3h-worker", "run")).toBeNull();
				expect(tryClaimExecution("p3h-helper", "run")).toBeNull();
				return "merged";
			},
		);
		expect(result).toEqual({ held: true, value: "merged" });
		for (const id of ["p3h-worker", "p3h-helper"]) {
			const owner = tryClaimExecution(id, "run");
			expect(owner).not.toBeNull();
			owner?.release();
		}
	});

	test("a running or owned session is busy and nothing stays held", async () => {
		let ran = false;
		const busy = await productionWorkItemPorts.holdSessions(
			["p3h-worker", "p3h-busy"],
			async () => {
				ran = true;
			},
		);
		expect(busy).toEqual({ held: false, busy: "p3h-busy" });
		const owner = tryClaimExecution("p3h-helper", "run");
		const owned = await productionWorkItemPorts.holdSessions(
			["p3h-worker", "p3h-helper"],
			async () => {
				ran = true;
			},
		);
		expect(owned).toEqual({ held: false, busy: "p3h-helper" });
		owner?.release();
		expect(ran).toBe(false);
		// The worker claimed first was released when the hold failed.
		const worker = tryClaimExecution("p3h-worker", "run");
		expect(worker).not.toBeNull();
		worker?.release();
	});
});
