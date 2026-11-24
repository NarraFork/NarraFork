import { describe, expect, test } from "bun:test";
import {
	BackgroundOccupancyIndex,
	type OccupancyNarrator,
	type OccupancyTask,
} from "./background-occupancy-index";

function narrator(
	id: string,
	parentNarratorId: string | null = null,
	patch: Partial<OccupancyNarrator> = {},
): OccupancyNarrator {
	return {
		id,
		parentNarratorId,
		type: parentNarratorId ? "subagent" : "primary",
		status: "idle",
		backgroundStatus: null,
		isBackground: false,
		legacySubagent: !!parentNarratorId,
		takenOver: false,
		hasProjection: false,
		...patch,
	};
}
function task(
	id: string,
	parentNarratorId: string,
	patch: Partial<OccupancyTask> = {},
): OccupancyTask {
	return {
		id,
		parentNarratorId,
		type: "bash",
		status: "running",
		backgroundKind: "task",
		subagentNarratorId: null,
		...patch,
	};
}

describe("maintained background occupancy graph", () => {
	test("5000 cold removals inspect each of 2000 live tasks once without key copies", () => {
		const index = new BackgroundOccupancyIndex();
		let parentReads = 0;
		let narratorParentReads = 0;
		for (let i = 0; i < 200; i++) {
			const row = narrator(`active-${i}`, "unrelated", { status: "working" });
			Object.defineProperty(row, "parentNarratorId", {
				get: () => {
					narratorParentReads++;
					return "unrelated";
				},
			});
			index.upsertNarrator(row);
		}
		for (let i = 0; i < 2000; i++) {
			const row = task(`service-${i}`, "unrelated", { backgroundKind: "service" });
			Object.defineProperty(row, "parentNarratorId", {
				get: () => {
					parentReads++;
					return "unrelated";
				},
			});
			index.upsertTask(row);
		}
		index.getTaskIds = () => {
			throw new Error("batch removal must not copy task keys");
		};
		index.getNarratorIds = () => {
			throw new Error("batch removal must not copy narrator keys");
		};
		const removed = new Set(Array.from({ length: 5000 }, (_, i) => `cold-${i}`));
		const result = index.deleteNarrators(removed);
		expect(parentReads).toBe(2000);
		expect(narratorParentReads).toBe(400);
		expect(result.affectedIds.size).toBe(0);
		expect(result.narratorIds.size).toBe(0);
		expect(result.taskIds.size).toBe(0);
		expect(index.getTask("service-1999")).toBeDefined();
	});

	test("batch removal returns surviving reattachments, all projections and old owners", () => {
		const index = new BackgroundOccupancyIndex();
		for (const row of [
			narrator("root"),
			narrator("removed", "root"),
			narrator("deleted-child", "removed"),
			narrator("survivor", "removed", { status: "working" }),
		])
			index.upsertNarrator(row);
		for (const row of [
			task("owned", "removed"),
			task("projection-a", "owner-a", { type: "agent", subagentNarratorId: "deleted-child" }),
			task("projection-b", "owner-b", { type: "agent", subagentNarratorId: "deleted-child" }),
			task("surviving-projection", "removed", { type: "agent", subagentNarratorId: "survivor" }),
			task("surviving-work", "survivor"),
		])
			index.upsertTask(row);
		index.setRuntimeLive("removed", true);
		index.rebuild();
		const result = index.deleteNarrators(new Set(["removed", "deleted-child", "cold"]));
		expect(result.narratorIds).toEqual(new Set(["survivor"]));
		expect(result.taskIds).toEqual(
			new Set(["owned", "projection-a", "projection-b", "surviving-projection"]),
		);
		expect(result.affectedIds).toEqual(
			new Set(["removed", "deleted-child", "root", "owner-a", "owner-b"]),
		);
		expect(index.getTaskIds()).toEqual(["surviving-work"]);
		expect(index.getNarrator("survivor")).toBeDefined();
		expect(index.getNarrator("removed")).toBeUndefined();
		// Old materialized ancestry is intentionally available until publication.
		expect(index.getAncestorIds("deleted-child")).toEqual([
			"removed",
			"owner-a",
			"owner-b",
			"root",
		]);
	});

	test("nested idle ancestors propagate paused transfers but not bash services", () => {
		const index = new BackgroundOccupancyIndex();
		for (const row of [narrator("root"), narrator("child", "root"), narrator("leaf", "child")])
			index.upsertNarrator(row);
		index.upsertTask(task("service", "leaf", { backgroundKind: "service" }));
		index.rebuild();
		expect(index.snapshot(["root", "child", "leaf"]).occupied.size).toBe(0);
		expect(index.snapshot(["leaf"]).counts.get("leaf")).toEqual({
			activeCount: 1,
			activeWorkCount: 0,
			activeServiceCount: 1,
		});
		index.upsertTask(task("transfer", "leaf", { type: "transfer", status: "paused" }));
		index.rebuild();
		expect(index.snapshot(["root", "child", "leaf"]).occupied.size).toBe(3);
		expect([...index.snapshot(["root", "child", "leaf"]).childCounts.values()]).toEqual([1, 1, 1]);
		expect(index.getAncestorIds("leaf")).toEqual(["child", "root"]);
	});

	test("working, waiting, taken over, runtime and unprojected legacy are seeds", () => {
		const index = new BackgroundOccupancyIndex();
		for (const row of [
			narrator("working", "root", { status: "working" }),
			narrator("waiting", "root", { status: "waiting" }),
			narrator("taken", "root", { takenOver: true }),
			narrator("live", "root"),
			narrator("legacy", "root", { backgroundStatus: "running" }),
		])
			index.upsertNarrator(row);
		index.setRuntimeLive("live", true);
		index.rebuild();
		expect(index.snapshot(["root"]).counts.get("root")?.activeWorkCount).toBe(5);
		expect(index.getOccupiedChildIds("root")).toHaveLength(5);
		expect(index.snapshot(["root"]).occupied).toEqual(new Set(["root"]));
	});

	test("archiving a legacy subagent clears occupancy and wake work despite a stale running flag", () => {
		const index = new BackgroundOccupancyIndex();
		const child = narrator("child", "root", { backgroundStatus: "running" });
		index.upsertNarrator(child);
		index.rebuild();
		expect(index.getActiveWakeWorkCount("root")).toBe(1);

		index.upsertNarrator({ ...child, status: "archived" });
		index.rebuild();
		expect(index.snapshot(["root"]).counts.get("root")?.activeCount).toBe(0);
		expect(index.getActiveWakeWorkCount("root")).toBe(0);
		expect(index.getActiveLegacyIds("root")).toEqual([]);
	});

	test("archival does not hide real runtime work, active descendants or a running projection", () => {
		const index = new BackgroundOccupancyIndex();
		const child = narrator("child", "root", { status: "archived", backgroundStatus: "running" });
		index.upsertNarrator(child);
		index.setRuntimeLive(child.id, true);
		index.rebuild();
		expect(index.getActiveWakeWorkCount("root")).toBe(1);

		index.setRuntimeLive(child.id, false);
		index.upsertNarrator(narrator("leaf", child.id, { status: "working" }));
		index.rebuild();
		expect(index.getOccupiedChildIds("root")).toEqual([child.id]);
		expect(index.getAncestorIds("leaf")).toEqual([child.id, "root"]);

		index.upsertNarrator(narrator("leaf", child.id));
		index.upsertNarrator({ ...child, hasProjection: true });
		index.upsertTask(task("projection", "root", { type: "agent", subagentNarratorId: child.id }));
		index.rebuild();
		expect(index.getActiveTaskIds("root")).toEqual(["projection"]);
	});

	test("terminal unified projection excludes stale legacy running; live descendants revive it", () => {
		const index = new BackgroundOccupancyIndex();
		index.upsertNarrator(
			narrator("child", "root", { backgroundStatus: "running", hasProjection: true }),
		);
		index.upsertTask(
			task("projection", "root", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "child",
			}),
		);
		index.rebuild();
		expect(index.snapshot(["root"]).counts.get("root")?.activeCount).toBe(0);
		index.upsertTask(task("bash", "child"));
		index.rebuild();
		expect(index.snapshot(["root"]).counts.get("root")?.activeCount).toBe(1);
		expect(index.getActiveTaskIds("root")).toEqual(["projection"]);
	});

	test("multiple projections count separately but occupied child and duplicate edges count once", () => {
		const index = new BackgroundOccupancyIndex();
		index.upsertNarrator(narrator("child", "root", { hasProjection: true }));
		index.upsertTask(task("p1", "root", { type: "agent", subagentNarratorId: "child" }));
		index.upsertTask(
			task("p2", "root", { type: "agent", status: "completed", subagentNarratorId: "child" }),
		);
		index.rebuild();
		expect(index.snapshot(["root"]).counts.get("root")?.activeWorkCount).toBe(2);
		expect(index.snapshot(["root"]).childCounts.get("root")).toBe(1);
		expect(index.getOccupiedChildIds("root")).toEqual(["child"]);
	});

	test("primary fork provenance is not a propagation edge; projection is", () => {
		const index = new BackgroundOccupancyIndex();
		index.upsertNarrator(
			narrator("primary", "provenance", {
				type: "primary",
				legacySubagent: false,
				status: "working",
			}),
		);
		index.rebuild();
		expect(index.snapshot(["provenance"]).occupied.size).toBe(0);
		index.upsertTask(task("p", "actual", { type: "agent", subagentNarratorId: "primary" }));
		index.rebuild();
		expect(index.getAncestorIds("primary")).toEqual(["actual"]);
	});

	test("self edges ignored and seedless cycles are reclaimed after final seed disappears", () => {
		const index = new BackgroundOccupancyIndex();
		index.upsertNarrator(narrator("a", "b"));
		index.upsertNarrator(narrator("b", "a"));
		index.upsertNarrator(narrator("self", "self"));
		index.upsertTask(task("seed", "a"));
		index.rebuild();
		expect(index.snapshot(["a", "b"]).occupied.size).toBe(2);
		expect(index.getAncestorIds("a")).toEqual(["b"]);
		expect(index.getAncestorIds("self")).toEqual([]);
		index.deleteTask("seed");
		index.rebuild();
		index.prune();
		expect(index.snapshot(["a", "b"]).occupied.size).toBe(0);
		expect(index.getNarratorIds()).toHaveLength(0);
		expect(index.getAncestorIds("a")).toEqual([]);
	});

	test("independent work and service caps and defensive snapshot copies", () => {
		const index = new BackgroundOccupancyIndex();
		for (let i = 0; i < 250; i++) {
			index.upsertTask(task(`work-${i}`, "root"));
			index.upsertTask(task(`service-${i}`, "root", { backgroundKind: "service" }));
		}
		index.rebuild();
		const snapshot = index.snapshot(["root"]);
		expect(snapshot.counts.get("root")).toEqual({
			activeCount: 400,
			activeWorkCount: 200,
			activeServiceCount: 200,
		});
		const value = snapshot.counts.get("root");
		if (value) value.activeCount = -1;
		expect(index.snapshot(["root"]).counts.get("root")?.activeCount).toBe(400);
	});

	test("historical leaves and terminal projections are discarded", () => {
		const index = new BackgroundOccupancyIndex();
		for (let i = 0; i < 1000; i++) {
			index.upsertNarrator(narrator(`old-${i}`, "root"));
			index.upsertTask(task(`done-${i}`, "root", { status: "completed" }));
		}
		index.rebuild();
		index.prune();
		expect(index.getNarratorIds()).toHaveLength(0);
		expect(index.getTaskIds()).toHaveLength(0);
	});

	test("active work and service buckets are ordered once and sliced independently", () => {
		const index = new BackgroundOccupancyIndex();
		for (const row of [
			task("work-old", "root", { createdAt: "2026-01-01" }),
			task("work-a", "root", { createdAt: "2026-01-02" }),
			task("work-z", "root", { createdAt: "2026-01-02" }),
			task("service-new", "root", { createdAt: "2026-01-03", backgroundKind: "service" }),
			task("service-old", "root", { createdAt: "2025-01-01", backgroundKind: "service" }),
		])
			index.upsertTask(row);
		index.rebuild();
		expect(index.getActiveTaskIds("root", { limit: 2 })).toEqual(["service-new", "work-z"]);
		expect(index.getActiveTaskIds("root", { serviceOnly: false, limit: 2 })).toEqual([
			"work-z",
			"work-a",
		]);
		expect(index.getActiveTaskIds("root", { serviceOnly: true, limit: 1 })).toEqual([
			"service-new",
		]);
		expect(index.getActiveTaskIds("root", { limit: 0 })).toEqual([]);
		expect(index.getActiveTaskIds("root", { limit: -1 })).toEqual([]);
		const copied = index.getActiveTaskIds("root", { limit: 1 });
		copied[0] = "mutated";
		expect(index.getActiveTaskIds("root", { limit: 1 })).toEqual(["service-new"]);
		// Read-side code must not inspect metadata or sort full active buckets.
		const row = index.getTask("work-z");
		if (row)
			Object.defineProperty(row, "createdAt", {
				get() {
					throw new Error("read-side sort");
				},
			});
		expect(index.getActiveTaskIds("root", { serviceOnly: false, limit: 1 })).toEqual(["work-z"]);
	});

	test("occupied children are ordered but projected children cannot consume the legacy cap", () => {
		const index = new BackgroundOccupancyIndex();
		for (let i = 0; i < 250; i++) {
			index.upsertNarrator(
				narrator(`projected-${String(i).padStart(3, "0")}`, "root", {
					status: "working",
					hasProjection: true,
					createdAt: "2026-01-03",
				}),
			);
		}
		index.upsertNarrator(
			narrator("legacy-a", "root", { status: "working", createdAt: "2026-01-01" }),
		);
		index.upsertNarrator(
			narrator("legacy-z", "root", { status: "working", createdAt: "2026-01-01" }),
		);
		index.upsertNarrator(
			narrator("ordinary", "root", {
				status: "working",
				legacySubagent: false,
				createdAt: "2026-01-04",
			}),
		);
		index.rebuild();
		expect(index.getOccupiedChildIds("root", 2)).toEqual(["ordinary", "projected-249"]);
		expect(index.getActiveLegacyIds("root", 1)).toEqual(["legacy-z"]);
		expect(index.getActiveLegacyIds("root")).toEqual(["legacy-z", "legacy-a"]);
		expect(index.getActiveLegacyIds("root", 0)).toEqual([]);
		expect(index.getActiveLegacyIds("missing", 1)).toEqual([]);
	});

	test("batch ancestry union probes a deep shared graph once rather than once per root", () => {
		const index = new BackgroundOccupancyIndex();
		let parent = "root";
		const ids = [parent];
		for (let i = 0; i < 2048; i++) {
			const id = `level-${i}`;
			index.upsertNarrator(narrator(id, parent));
			ids.push(id);
			parent = id;
		}
		index.upsertTask(task("work", parent));
		index.rebuild();
		const graph = (index as unknown as { parents: Map<string, Set<string>> }).parents;
		const originalGet = graph.get.bind(graph);
		let probes = 0;
		graph.get = (id) => {
			probes++;
			return originalGet(id);
		};
		expect(index.getAncestorIdsForBatch(ids)).toEqual([]);
		expect(probes).toBe(ids.length);
	});

	test("active input cap is independent of depth and rejects atomically", () => {
		const index = new BackgroundOccupancyIndex(2);
		index.upsertNarrator(narrator("child", "root"));
		index.upsertTask(task("work", "child"));
		expect(() => index.upsertTask(task("overflow", "child"))).toThrow("active graph source limit");
		index.upsertTask(task("work", "child", { status: "paused" }));
		index.rebuild();
		expect(index.getTaskIds()).toEqual(["work"]);
		expect(index.snapshot(["root"]).counts.get("root")?.activeCount).toBe(1);
	});
});
