import { describe, expect, test } from "bun:test";
import { dispatchRecentTabsListStateSnapshot } from "./useRecentTabsWS";

describe("RecentTabs list-state snapshots", () => {
	test("fans a batched list snapshot into narrator updates", () => {
		const updates: Array<{
			narratorId: string;
			type: string;
			status?: string;
			substatus?: string[];
		}> = [];
		const count = dispatchRecentTabsListStateSnapshot(
			{
				type: "list_state_snapshot",
				items: [
					{ narratorId: "n1", status: "working", substatus: ["reasoning"] },
					{ narratorId: "n2", status: "idle", substatus: [] },
				],
			},
			(narratorId, event) => updates.push({ narratorId, ...event }),
		);

		expect(count).toBe(2);
		expect(updates).toEqual([
			{ narratorId: "n1", type: "status", status: "working", substatus: ["reasoning"] },
			{ narratorId: "n2", type: "status", status: "idle", substatus: [] },
		]);
	});

	test("does not join or leave presence for the RecentTabs subscription", async () => {
		const source = await Bun.file(new URL("./useRecentTabsWS.ts", import.meta.url)).text();
		expect(source).toContain('"presence_update"');
		expect(source).not.toContain(".joinPresence(");
		expect(source).not.toContain(".leavePresence(");
	});

	test("fans background task counts out of a list snapshot into count updates", () => {
		const updates: Array<{
			narratorId: string;
			type: string;
			activeBackgroundTaskCount?: number;
		}> = [];
		dispatchRecentTabsListStateSnapshot(
			{
				type: "list_state_snapshot",
				items: [
					{ narratorId: "n1", status: "idle", activeBackgroundTaskCount: 3 },
					{ narratorId: "n2", status: "working", activeBackgroundTaskCount: 0 },
					// No count field → no event, so a partial snapshot never zeroes a badge.
					{ narratorId: "n3", status: "idle" },
				],
			},
			(narratorId, event) => updates.push({ narratorId, ...event }),
		);

		const countEvents = updates.filter((event) => event.type === "backgroundTaskCount");
		expect(countEvents).toEqual([
			{ narratorId: "n1", type: "backgroundTaskCount", activeBackgroundTaskCount: 3 },
			{ narratorId: "n2", type: "backgroundTaskCount", activeBackgroundTaskCount: 0 },
		]);
	});
});
