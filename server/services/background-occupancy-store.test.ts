import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	BackgroundOccupancyIndex,
	type OccupancyNarrator,
	type OccupancyTask,
} from "./background-occupancy-index";
import {
	type BackgroundOccupancySource,
	BackgroundOccupancyStore,
	createDatabaseBackgroundOccupancySource,
} from "./background-occupancy-store";

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

class FakeSource implements BackgroundOccupancySource {
	narrators = new Map<string, OccupancyNarrator>();
	tasks = new Map<string, OccupancyTask>();
	calls: string[] = [];
	limits: number[] = [];
	onRead: ((label: string) => Promise<void>) | null = null;
	private async read<T>(label: string, rows: T[]): Promise<T[]> {
		this.calls.push(label);
		const copied = structuredClone(rows);
		await this.onRead?.(label);
		return copied;
	}
	private narratorRows(): OccupancyNarrator[] {
		return [...this.narrators.values()].map((row) => ({
			...row,
			hasProjection: [...this.tasks.values()].some(
				(t) => t.id === row.id || (t.type === "agent" && t.subagentNarratorId === row.id),
			),
		}));
	}
	private page<T extends { id: string }>(rows: T[], after: string | null, limit: number): T[] {
		this.limits.push(limit);
		return rows
			.filter((r) => after === null || r.id > after)
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.slice(0, limit);
	}
	scanNarrators(after: string | null, limit: number): Promise<OccupancyNarrator[]> {
		return this.read("scanNarrators", this.page(this.narratorRows(), after, limit));
	}
	scanTasks(after: string | null, limit: number): Promise<OccupancyTask[]> {
		return this.read("scanTasks", this.page([...this.tasks.values()], after, limit));
	}
	getNarrators(ids: string[]): Promise<OccupancyNarrator[]> {
		return this.read(
			"getNarrators",
			this.narratorRows().filter((r) => ids.includes(r.id)),
		);
	}
	getTasks(ids: string[]): Promise<OccupancyTask[]> {
		return this.read(
			"getTasks",
			[...this.tasks.values()].filter((r) => ids.includes(r.id)),
		);
	}
	getProjections(id: string, after: string | null, limit: number): Promise<OccupancyTask[]> {
		return this.read(
			"getProjections",
			this.page(
				[...this.tasks.values()].filter(
					(r) => r.id === id || (r.type === "agent" && r.subagentNarratorId === id),
				),
				after,
				limit,
			),
		);
	}
}

function fixture(): { source: FakeSource; store: BackgroundOccupancyStore } {
	const source = new FakeSource();
	source.narrators.set("root", narrator("root"));
	source.narrators.set("child", narrator("child", "root"));
	source.narrators.set("leaf", narrator("leaf", "child"));
	return { source, store: new BackgroundOccupancyStore(source) };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("background occupancy coordinator", () => {
	test("cold flush and reads never trigger the explicitly scheduled initial scan", async () => {
		const { source, store } = fixture();
		await expect(store.flush()).rejects.toThrow("not initialized");
		expect(() => store.snapshot(["root"])).toThrow("not initialized");
		store.refreshNarrator("child");
		store.refreshTask("work");
		await expect(store.flush()).rejects.toThrow("not initialized");
		expect(source.calls).toHaveLength(0);
		await store.start();
		expect(store.isReady).toBe(true);
	});

	test("real SQL correlates projection existence to the outer narrator, not background task itself", async () => {
		const client = new Database(":memory:");
		client.exec(`
			CREATE TABLE narrators (
				id TEXT PRIMARY KEY, parent_narrator_id TEXT, type TEXT, status TEXT,
				background_status TEXT, is_background INTEGER, variant TEXT, substatus TEXT, created_at TEXT
			);
			CREATE TABLE background_tasks (
				id TEXT PRIMARY KEY, parent_narrator_id TEXT, type TEXT, status TEXT,
				background_kind TEXT, subagent_narrator_id TEXT, created_at TEXT
			);
			INSERT INTO narrators VALUES ('root', NULL, 'primary', 'idle', NULL, 0, 'primary', '[]', '2026-01-01');
			INSERT INTO narrators VALUES ('legacy', 'root', 'subagent', 'idle', 'running', 1, 'subagent:general', '[]', '2026-01-01');
			INSERT INTO narrators VALUES ('projected', 'root', 'subagent', 'idle', 'running', 1, 'subagent:general', '[]', '2026-01-01');
			INSERT INTO narrators VALUES ('same-id', 'root', 'subagent', 'idle', 'running', 1, 'subagent:general', '[]', '2026-01-01');
			INSERT INTO background_tasks VALUES ('unrelated', 'root', 'bash', 'running', 'task', NULL, '2026-01-01');
			INSERT INTO background_tasks VALUES ('projection', 'root', 'agent', 'completed', 'task', 'projected', '2026-01-01');
			INSERT INTO background_tasks VALUES ('same-id', 'root', 'bash', 'completed', 'task', NULL, '2026-01-01');
		`);
		try {
			const db = drizzle({ client });
			const source = createDatabaseBackgroundOccupancySource(async () => db);
			const rows = await source.getNarrators(["legacy", "projected", "same-id"]);
			expect(new Map(rows.map((row) => [row.id, row.hasProjection]))).toEqual(
				new Map([
					["legacy", false],
					["projected", true],
					["same-id", true],
				]),
			);
			const store = new BackgroundOccupancyStore(source);
			await store.start();
			expect(store.getActiveLegacyIds("root")).toEqual(["legacy"]);
			client.exec(
				"INSERT INTO background_tasks VALUES ('service', 'root', 'bash', 'running', 'service', NULL, '2026-01-02')",
			);
			store.refreshTask("service");
			await store.flush();
			expect(store.getActiveLegacyIds("root")).toEqual(["legacy"]);
			expect(store.snapshot(["root"]).counts.get("root")).toEqual({
				activeCount: 3,
				activeWorkCount: 2,
				activeServiceCount: 1,
			});
		} finally {
			client.close();
		}
	});
	test("explicit startup scans paged metadata only once; all steady reads are SQL-free", async () => {
		const { source, store } = fixture();
		for (let i = 0; i < 1100; i++) {
			source.narrators.set(
				`old-${String(i).padStart(4, "0")}`,
				narrator(`old-${String(i).padStart(4, "0")}`, "root"),
			);
			source.tasks.set(
				`done-${String(i).padStart(4, "0")}`,
				task(`done-${String(i).padStart(4, "0")}`, "root", { status: "completed" }),
			);
		}
		source.tasks.set("work", task("work", "leaf", { type: "transfer", status: "paused" }));
		await Promise.all([store.start(), store.ensureReady()]);
		expect(source.calls.filter((c) => c === "scanNarrators").length).toBe(9);
		expect(source.calls.filter((c) => c === "scanTasks").length).toBe(9);
		expect(Math.max(...source.limits)).toBe(128);
		const reads = source.calls.length;
		for (let i = 0; i < 100; i++) {
			expect(store.snapshot(["root"]).counts.get("root")?.activeWorkCount).toBe(1);
			expect(store.getOccupiedChildIds("root")).toEqual(["child"]);
			expect(store.getActiveTaskIds("leaf")).toEqual(["work"]);
			expect(store.getAncestorIds("leaf")).toEqual(["child", "root"]);
			await store.ensureReady();
		}
		expect(source.calls.length).toBe(reads);
	});

	test("startup pages yield actual macrotasks", async () => {
		const { source, store } = fixture();
		let turnRan = false;
		setImmediate(() => {
			turnRan = true;
		});
		source.onRead = async (label) => {
			if (label === "scanTasks") expect(turnRan).toBe(true);
		};
		await store.start();
	});

	test("wake-work counts only tasks whose completion wakes the parent", async () => {
		const { source, store } = fixture();
		// bash task — wakes the parent on completion.
		source.tasks.set("bash-task", task("bash-task", "root"));
		// background subagent — wakes the parent on completion.
		source.tasks.set(
			"agent-task",
			task("agent-task", "root", { type: "agent", subagentNarratorId: "child" }),
		);
		// legacy projection-less background narrator — still a subagent, wakes the parent.
		source.narrators.set(
			"legacy-bg",
			narrator("legacy-bg", "root", { isBackground: true, backgroundStatus: "running" }),
		);
		// service — not work at all.
		source.tasks.set("svc", task("svc", "root", { backgroundKind: "service" }));
		// transfer — work for the badge, but its terminal commit skips publication,
		// so no wake-up turn would ever re-raise a suppressed done notification.
		source.tasks.set("xfer", task("xfer", "root", { type: "transfer" }));
		await store.start();

		expect(store.countActiveWakeWork("root")).toBe(3);
		// The badge work count still includes the transfer (and the service sits apart).
		expect(store.snapshot(["root"]).counts.get("root")).toEqual({
			activeCount: 5,
			activeWorkCount: 4,
			activeServiceCount: 1,
		});
	});

	test("a finished agent projection kept alive by a transfer does not swallow the parent", async () => {
		const { source, store } = fixture();
		// The agent session already published its terminal wake. The row stays
		// indexed only because the child is still occupied — here, by a transfer
		// that will never publish. Counting it would suppress the parent's done
		// with no later turn to re-raise it.
		source.tasks.set(
			"agent-done",
			task("agent-done", "root", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "child",
			}),
		);
		source.tasks.set("xfer", task("xfer", "child", { type: "transfer" }));
		await store.start();

		expect(store.countActiveWakeWork("root")).toBe(0);
		expect(store.countActiveWakeWork("child")).toBe(0);
		// The badge still shows the retained projection as work on the parent.
		expect(store.snapshot(["root"]).counts.get("root")?.activeWorkCount).toBe(1);
	});

	test("a running subagent still counts while its only child task is a transfer", async () => {
		const { source, store } = fixture();
		source.tasks.set(
			"agent-task",
			task("agent-task", "root", { type: "agent", subagentNarratorId: "child" }),
		);
		source.tasks.set("xfer", task("xfer", "child", { type: "transfer" }));
		await store.start();

		expect(store.countActiveWakeWork("root")).toBe(1);
		expect(store.countActiveWakeWork("child")).toBe(0);
	});

	test("a legacy narrator occupied only by a transfer does not count as wake-work", async () => {
		const { source, store } = fixture();
		source.narrators.set(
			"legacy-bg",
			narrator("legacy-bg", "root", { isBackground: true, status: "idle" }),
		);
		source.tasks.set("xfer", task("xfer", "legacy-bg", { type: "transfer" }));
		await store.start();

		expect(store.countActiveWakeWork("root")).toBe(0);
		expect(store.snapshot(["root"]).counts.get("root")?.activeWorkCount).toBeGreaterThan(0);
	});

	test("dirty events arriving during shadow rebuild are replayed before publish", async () => {
		const { source, store } = fixture();
		source.tasks.set("work", task("work", "leaf"));
		const entered = deferred();
		const release = deferred();
		let blocked = false;
		source.onRead = async (label) => {
			if (label === "scanTasks" && !blocked) {
				blocked = true;
				entered.resolve();
				await release.promise;
			}
		};
		const starting = store.start();
		await entered.promise;
		source.tasks.set("work", task("work", "leaf", { status: "completed" }));
		store.refreshTask("work");
		release.resolve();
		await starting;
		expect(store.snapshot(["root"]).counts.get("root")?.activeCount).toBe(0);
	});

	test("concurrent hot invalidations cannot be cleared by stale async reads", async () => {
		const { source, store } = fixture();
		await store.start();
		const entered = deferred();
		const release = deferred();
		let blocked = false;
		source.onRead = async (label) => {
			if (label === "getTasks" && !blocked) {
				blocked = true;
				entered.resolve();
				await release.promise;
			}
		};
		source.tasks.set("work", task("work", "leaf"));
		store.refreshTask("work");
		await entered.promise;
		source.tasks.set("work", task("work", "leaf", { status: "completed" }));
		store.refreshTask("work");
		release.resolve();
		await store.flush();
		expect(store.snapshot(["root"]).occupied.size).toBe(0);
		expect(source.calls.filter((c) => c === "getTasks").length).toBe(2);
	});

	test("terminal projections revive through descendants and reparented projections replace old edges", async () => {
		const { source, store } = fixture();
		source.narrators.set("other", narrator("other"));
		source.tasks.set(
			"projection",
			task("projection", "root", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "child",
			}),
		);
		await store.start();
		source.tasks.set("work", task("work", "leaf"));
		store.refreshTask("work");
		await store.flush();
		expect(store.getActiveTaskIds("root")).toEqual(["projection"]);
		source.tasks.set(
			"projection",
			task("projection", "other", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "child",
			}),
		);
		store.refreshTask("projection");
		await store.flush();
		expect(store.getActiveTaskIds("root")).toEqual([]);
		expect(store.getActiveTaskIds("other")).toEqual(["projection"]);
		expect(store.getAncestorIds("child")).toEqual(["root", "other"]);
	});

	test("narrator refresh removes deleted terminal projections and unmasks legacy", async () => {
		const { source, store } = fixture();
		source.narrators.set(
			"child",
			narrator("child", "root", { status: "working", backgroundStatus: "running" }),
		);
		source.tasks.set(
			"projection",
			task("projection", "root", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "child",
			}),
		);
		await store.start();
		source.tasks.delete("projection");
		store.refreshNarrator("child");
		await store.flush();
		expect(store.getActiveTaskIds("root")).toEqual([]);
		expect(store.snapshot(["root"]).counts.get("root")?.activeCount).toBe(1);
	});

	test("runtime liveness is maintained without a session import, including absent narrator ids", async () => {
		const { store } = fixture();
		store.setRuntimeLive("child", true);
		store.setRuntimeLive("missing", true);
		await store.start();
		expect(store.snapshot(["root", "missing"]).occupied.size).toBe(2);
		store.setRuntimeLive("child", false);
		store.setRuntimeLive("missing", false);
		await store.flush();
		expect(store.snapshot(["root", "missing"]).occupied.size).toBe(0);
	});

	test("post-commit narrator removal handles cascaded tasks and surviving reattachments", async () => {
		const { source, store } = fixture();
		source.narrators.set("other", narrator("other"));
		source.tasks.set("work", task("work", "leaf"));
		source.tasks.set(
			"projection",
			task("projection", "child", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "leaf",
			}),
		);
		await store.start();
		source.narrators.delete("child");
		source.tasks.delete("projection");
		source.narrators.set("leaf", narrator("leaf", "other"));
		store.removeNarrators(["child"]);
		await store.flush();
		expect(store.snapshot(["root"]).occupied.size).toBe(0);
		expect(store.snapshot(["other"]).occupied.size).toBe(1);
		expect(store.getAncestorIds("leaf")).toEqual(["other"]);
	});

	test("5000 cold deleted ids leave 2000 service tasks alone with one batch and no reads or broadcasts", async () => {
		const { source, store } = fixture();
		for (let i = 0; i < 2000; i++)
			source.tasks.set(`service-${i}`, task(`service-${i}`, "root", { backgroundKind: "service" }));
		await store.start();
		await new Promise<void>((resolve) => setImmediate(resolve));
		source.calls = [];
		const notifications: string[][] = [];
		store.subscribe("list", (ids) => {
			notifications.push([...ids]);
		});
		const batch = spyOn(BackgroundOccupancyIndex.prototype, "deleteNarrators");
		const single = spyOn(BackgroundOccupancyIndex.prototype, "deleteNarrator");
		const taskKeys = spyOn(BackgroundOccupancyIndex.prototype, "getTaskIds");
		const narratorKeys = spyOn(BackgroundOccupancyIndex.prototype, "getNarratorIds");
		const taskReads = spyOn(BackgroundOccupancyIndex.prototype, "getTask");
		try {
			store.removeNarrators(Array.from({ length: 5000 }, (_, i) => `cold-${i}`));
			await store.flush();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(batch).toHaveBeenCalledTimes(1);
			expect(single).not.toHaveBeenCalled();
			expect(taskKeys).not.toHaveBeenCalled();
			expect(narratorKeys).not.toHaveBeenCalled();
			expect(taskReads.mock.calls.length).toBeLessThanOrEqual(2000);
			expect(source.calls).toEqual([]);
			expect(notifications).toEqual([]);
			expect(store.getActiveTaskIds("root", { serviceOnly: true })).toHaveLength(2000);
		} finally {
			batch.mockRestore();
			single.mockRestore();
			taskKeys.mockRestore();
			narratorKeys.mockRestore();
			taskReads.mockRestore();
		}
	});

	test("hydrate batches missing narrators across SQL pages instead of cascading per id", async () => {
		const { source, store } = fixture();
		const ids = Array.from({ length: 257 }, (_, i) => `deleted-${i}`);
		for (const id of ids) {
			source.narrators.set(id, narrator(id, "root", { status: "working" }));
			source.tasks.set(`owned-${id}`, task(`owned-${id}`, id, { backgroundKind: "service" }));
		}
		for (let i = 0; i < 2000; i++)
			source.tasks.set(`service-${i}`, task(`service-${i}`, "root", { backgroundKind: "service" }));
		await store.start();
		await new Promise<void>((resolve) => setImmediate(resolve));
		for (const id of ids) {
			source.narrators.delete(id);
			source.tasks.delete(`owned-${id}`);
		}
		source.calls = [];
		const batch = spyOn(BackgroundOccupancyIndex.prototype, "deleteNarrators");
		const single = spyOn(BackgroundOccupancyIndex.prototype, "deleteNarrator");
		try {
			store.refreshNarrators(ids);
			await store.flush();
			expect(single).not.toHaveBeenCalled();
			const nonempty = batch.mock.calls.filter(([removed]) => removed.size > 0);
			expect(nonempty).toHaveLength(1);
			expect(nonempty[0][0].size).toBe(257);
			expect(source.calls.filter((label) => label === "getNarrators")).toHaveLength(3);
			expect(source.calls.filter((label) => label === "getTasks")).toHaveLength(3);
			expect(store.getActiveTaskIds("root", { serviceOnly: true })).toHaveLength(2000);
			expect(store.snapshot(["root"]).occupied.size).toBe(0);
		} finally {
			batch.mockRestore();
			single.mockRestore();
		}
	});

	test.each([
		{ mode: "remove", fail: false },
		{ mode: "remove", fail: true },
		{ mode: "hydrate", fail: false },
		{ mode: "hydrate", fail: true },
	])("mixed removal via $mode, failed read=$fail preserves projections and owners", async ({
		mode,
		fail,
	}) => {
		const { source, store } = fixture();
		for (const row of [
			narrator("other-root"),
			narrator("other-owner", "other-root"),
			narrator("external-root"),
			narrator("external-owner", "external-root"),
			narrator("doomed", "child", { status: "working" }),
		])
			source.narrators.set(row.id, row);
		for (const row of [
			task("work", "leaf"),
			task("doomed-work", "doomed"),
			task("service", "child", { backgroundKind: "service" }),
			task("moving-projection", "child", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "leaf",
			}),
			task("second-projection", "root", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "leaf",
			}),
			task("deleted-projection", "external-owner", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "doomed",
			}),
		])
			source.tasks.set(row.id, row);
		await store.start();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const delivered = deferred();
		let notified: readonly string[] = [];
		store.subscribe("list", (ids) => {
			notified = ids;
			delivered.resolve();
		});
		source.narrators.delete("child");
		source.narrators.delete("doomed");
		source.narrators.set("leaf", narrator("leaf", "other-owner"));
		source.tasks.delete("doomed-work");
		source.tasks.delete("deleted-projection");
		source.tasks.set("service", task("service", "other-owner", { backgroundKind: "service" }));
		source.tasks.set(
			"moving-projection",
			task("moving-projection", "other-owner", {
				type: "agent",
				status: "completed",
				subagentNarratorId: "leaf",
			}),
		);
		source.calls = [];
		let shouldFail = fail;
		source.onRead = async (label) => {
			if (label === "getTasks" && shouldFail) {
				shouldFail = false;
				throw new Error("expected batch removal read failure");
			}
		};
		if (mode === "remove") store.removeNarrators(["child", "doomed", "cold"]);
		else store.refreshNarrators(["child", "doomed"]);
		if (fail) {
			await expect(store.flush()).rejects.toThrow("batch removal read failure");
			expect(notified).toEqual([]);
			expect(() => store.snapshot(["root"])).toThrow("batch removal read failure");
		}
		await store.flush();
		await delivered.promise;
		expect(notified).toEqual(
			expect.arrayContaining([
				"root",
				"child",
				"doomed",
				"leaf",
				"other-owner",
				"other-root",
				"external-owner",
				"external-root",
			]),
		);
		expect(notified).not.toContain("cold");
		expect(store.getActiveTaskIds("root")).toEqual(["second-projection"]);
		expect(store.getActiveTaskIds("other-owner")).toEqual(["service", "moving-projection"]);
		expect(store.getActiveTaskIds("external-owner")).toEqual([]);
		expect(new Set(store.getAncestorIds("leaf"))).toEqual(
			new Set(["other-owner", "other-root", "root"]),
		);
		expect(store.snapshot(["child", "doomed", "external-root"]).occupied.size).toBe(0);
		expect(source.calls).not.toContain("scanNarrators");
		expect(source.calls).not.toContain("scanTasks");
	});

	test("reset cancels old shadow generations without overwriting the new graph", async () => {
		const { source, store } = fixture();
		const entered = deferred();
		const release = deferred();
		let blocked = false;
		source.onRead = async (label) => {
			if (label === "scanNarrators" && !blocked) {
				blocked = true;
				entered.resolve();
				await release.promise;
			}
		};
		const old = store.start().catch((error: unknown) => error);
		await entered.promise;
		store.resetForTests();
		source.tasks.set("new", task("new", "leaf"));
		await store.start();
		release.resolve();
		expect(await old).toBeInstanceOf(Error);
		expect(store.snapshot(["root"]).occupied.size).toBe(1);
	});

	test("page overflow and oversized fields fail closed and can be retried", async () => {
		const { source, store } = fixture();
		const original = source.scanTasks.bind(source);
		source.scanTasks = async () => Array.from({ length: 129 }, (_, i) => task(String(i), "root"));
		await expect(store.start()).rejects.toThrow("row limit");
		expect(() => store.snapshot(["root"])).toThrow();
		source.scanTasks = original;
		await store.start();
		source.tasks.set("bad", task("bad", "x".repeat(1025)));
		store.refreshTask("bad");
		await expect(store.flush()).rejects.toThrow("field limit");
		source.tasks.delete("bad");
		await store.flush();
		expect(store.snapshot(["root"]).occupied.size).toBe(0);
	});

	test("ready state and bounded ordered task, occupied and independent legacy APIs", async () => {
		const { source, store } = fixture();
		expect(store.isReady).toBe(false);
		source.narrators.set(
			"child",
			narrator("child", "root", { status: "working", createdAt: "2026-01-02" }),
		);
		source.narrators.set(
			"legacy",
			narrator("legacy", "root", { status: "working", createdAt: "2026-01-01" }),
		);
		source.tasks.set(
			"projected",
			task("projected", "root", {
				type: "agent",
				subagentNarratorId: "child",
				createdAt: "2026-01-02",
			}),
		);
		source.tasks.set(
			"service",
			task("service", "root", { backgroundKind: "service", createdAt: "2026-01-03" }),
		);
		await store.start();
		expect(store.isReady).toBe(true);
		const reads = source.calls.length;
		expect(store.getActiveTaskIds("root", { limit: 1 })).toEqual(["service"]);
		expect(store.getActiveTaskIds("root", { serviceOnly: false, limit: 1 })).toEqual(["projected"]);
		expect(store.getActiveTaskIds("root", { serviceOnly: true, limit: 1 })).toEqual(["service"]);
		expect(store.getOccupiedChildIds("root", 1)).toEqual(["child"]);
		expect(store.getActiveLegacyIds("root", 1)).toEqual(["legacy"]);
		expect(source.calls.length).toBe(reads);
		store.resetForTests();
		expect(store.isReady).toBe(false);
	});

	test("keyed subscribers run asynchronously after publication and may flush without deadlock", async () => {
		const { source, store } = fixture();
		source.narrators.set("cold", narrator("cold", "root"));
		source.tasks.set("work", task("work", "leaf"));
		const delivered = deferred();
		let replacedCalls = 0;
		const notifications: string[][] = [];
		store.subscribe("list", () => {
			replacedCalls++;
		});
		store.subscribe("list", async (ids) => {
			notifications.push([...ids]);
			await store.flush();
			delivered.resolve();
		});
		await store.start();
		expect(notifications).toHaveLength(0);
		await delivered.promise;
		expect(replacedCalls).toBe(0);
		expect(store.isReady).toBe(true);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("root");
		expect(notifications[0]).toContain("child");
		expect(notifications[0]).not.toContain("cold");
		store.snapshot(["root"]);
		await store.ensureReady();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(notifications).toHaveLength(1);
	});

	test("subscribers receive old and new ancestor chains on ownership changes and removals", async () => {
		const { source, store } = fixture();
		source.narrators.set("other", narrator("other"));
		source.tasks.set("work", task("work", "leaf"));
		await store.start();
		await new Promise<void>((resolve) => setImmediate(resolve));
		let delivered = deferred();
		const notifications: string[][] = [];
		store.subscribe("list", (ids) => {
			notifications.push([...ids]);
			delivered.resolve();
		});
		source.narrators.set("leaf", narrator("leaf", "other"));
		store.refreshNarrator("leaf");
		await store.flush();
		await delivered.promise;
		expect(notifications[0]).toEqual(expect.arrayContaining(["root", "child", "leaf", "other"]));
		expect(store.snapshot(["root"]).occupied.size).toBe(0);
		delivered = deferred();
		source.narrators.delete("leaf");
		source.tasks.delete("work");
		store.removeNarrators(["leaf"]);
		await store.flush();
		await delivered.promise;
		expect(notifications[1]).toEqual(expect.arrayContaining(["leaf", "other"]));
		expect(store.snapshot(["other"]).occupied.size).toBe(0);
	});

	test("task parent moves and service updates notify both owners; subscriber errors are isolated", async () => {
		const { source, store } = fixture();
		source.narrators.set("other", narrator("other"));
		source.tasks.set("service", task("service", "root", { backgroundKind: "service" }));
		await store.start();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const delivered = deferred();
		let affected: readonly string[] = [];
		store.subscribe("broken", () => {
			throw new Error("expected test subscriber failure");
		});
		store.subscribe("list", (ids) => {
			affected = ids;
			delivered.resolve();
		});
		source.tasks.set("service", task("service", "other", { backgroundKind: "service" }));
		store.refreshTask("service");
		await store.flush();
		await delivered.promise;
		expect(affected).toEqual(expect.arrayContaining(["root", "other"]));
		expect(store.isReady).toBe(true);
		expect(store.snapshot(["other"]).counts.get("other")?.activeServiceCount).toBe(1);
	});

	test.each([
		"delete",
		"move",
	] as const)("failed %s maintenance retains old owners until successful notification", async (action) => {
		const { source, store } = fixture();
		source.narrators.set("other", narrator("other"));
		source.tasks.set("work", task("work", "leaf"));
		await store.start();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const delivered = deferred();
		let notified: readonly string[] = [];
		store.subscribe("list", (ids) => {
			notified = ids;
			delivered.resolve();
		});
		let fail = true;
		source.onRead = async (label) => {
			if (label === "getTasks" && fail) {
				fail = false;
				throw new Error("expected single read failure");
			}
		};
		if (action === "delete") source.tasks.delete("work");
		else source.tasks.set("work", task("work", "other"));
		store.refreshTask("work");
		await expect(store.flush()).rejects.toThrow("single read failure");
		expect(notified).toHaveLength(0);
		await store.flush();
		await delivered.promise;
		expect(notified).toEqual(expect.arrayContaining(["leaf", "child", "root"]));
		if (action === "move") expect(notified).toContain("other");
		expect(store.snapshot(["root"]).counts.get("root")?.activeCount).toBe(0);
		expect(store.snapshot(["other"]).counts.get("other")?.activeCount).toBe(
			action === "move" ? 1 : 0,
		);
	});

	test("deep initial closure yields to timers without an ancestry depth cap", async () => {
		const source = new FakeSource();
		source.narrators.set("root", narrator("root"));
		let parent = "root";
		for (let i = 0; i < 512; i++) {
			const id = `level-${i}`;
			source.narrators.set(id, narrator(id, parent));
			parent = id;
		}
		source.tasks.set("work", task("work", parent));
		const store = new BackgroundOccupancyStore(source);
		let ticks = 0;
		const timer = setInterval(() => {
			ticks++;
		}, 1);
		try {
			await store.start();
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThan(0);
		expect(store.getAncestorIds(parent)).toHaveLength(512);
		expect(store.snapshot(["root"]).counts.get("root")?.activeCount).toBe(1);
	});
});
