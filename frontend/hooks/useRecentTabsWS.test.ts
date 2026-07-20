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
});
