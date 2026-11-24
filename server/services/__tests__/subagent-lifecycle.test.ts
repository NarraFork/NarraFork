import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../../db/schema";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));

const liveSessions = new Set<string>();
const closed: string[] = [];
const resourcesClosed: string[] = [];
const helpersStopped: string[] = [];
const runControls: Array<{ id: string; kind: string }> = [];
const statusUpdates: Array<{ id: string; status: string }> = [];
const frames: Array<Record<string, unknown>> = [];
const realSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realSession,
	closeNarrator: (id: string) => {
		closed.push(id);
		liveSessions.delete(id);
	},
	isNarratorActive: (id: string) => liveSessions.has(id),
	isLoopRunning: (id: string) => liveSessions.has(id),
}));
const realRun = { ...(await import("../agent-runtime/run")) };
mock.module("../agent-runtime/run", () => ({
	...realRun,
	controlRun: async (id: string, command: Parameters<typeof realRun.controlRun>[1]) => {
		runControls.push({ id, kind: command.kind });
		return realRun.controlRun(id, command);
	},
	stopSubagentHelpers: async (id: string) => {
		helpersStopped.push(id);
		return 0;
	},
}));
const realResources = { ...(await import("../subagent-resources")) };
mock.module("../subagent-resources", () => ({
	...realResources,
	closeSubagentResources: async (id: string) => {
		resourcesClosed.push(id);
		return { terminals: 0, browserSessions: 0 };
	},
}));
const realWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (_id: string, message: Record<string, unknown>) => frames.push(message),
}));
const { narratorService } = await import("../narrator-service");
const updateStatus = narratorService.updateStatus.bind(narratorService);
const statusSpy = spyOn(narratorService, "updateStatus").mockImplementation(
	async (id, status, options) => {
		statusUpdates.push({ id, status });
		return updateStatus(id, status, options);
	},
);
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { backgroundTaskService } = await import("../background-task-service");
const { getRuntimePublicationService, runtimePublication } = await import(
	"../agent-runtime/publication"
);
const { tryClaimExecution, setRunHold, setRunControl } = await import("../agent-runtime/ownership");
const { interruptAndArchiveSubagent, archiveRetiredSubagents } = await import(
	"../subagent-lifecycle"
);
const {
	beginRecoveryDiscovery,
	finishRecoveryDiscovery,
	invalidateRecoveryTarget,
	isRecoveryTargetPending,
	registerRecoverySource,
	resetRecoveryHandoffForTests,
} = await import("../recovery-handoff");
const publication = getRuntimePublicationService();
const derivedSpy = spyOn(backgroundTaskService, "notifyDerivedStatusChanged");
const wakes: string[] = [];
const owners: Array<NonNullable<ReturnType<typeof tryClaimExecution>>> = [];
const pending = new Set<Promise<void>>();
const broadcaster = backgroundTaskService as unknown as {
	broadcastTaskUpsert(parentId: string, taskId: string): Promise<void>;
	broadcastListDelta(parentId: string, delta: unknown): Promise<void>;
};
const upsert = broadcaster.broadcastTaskUpsert.bind(backgroundTaskService);
const delta = broadcaster.broadcastListDelta.bind(backgroundTaskService);
function track(work: Promise<void>): Promise<void> {
	pending.add(work);
	void work.then(
		() => pending.delete(work),
		() => pending.delete(work),
	);
	return work;
}
spyOn(broadcaster, "broadcastTaskUpsert").mockImplementation((...args) => track(upsert(...args)));
spyOn(broadcaster, "broadcastListDelta").mockImplementation((...args) => track(delta(...args)));
async function flush(): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (backgroundOccupancyStore.isReady) await backgroundOccupancyStore.flush();
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (pending.size === 0) return;
		await Promise.all([...pending]);
	}
	throw new Error("Archive notifications did not settle");
}
const NOW = "2026-11-18T10:00:00.000Z";
function row(id: string) {
	return db.select().from(narrators).where(eq(narrators.id, id)).get();
}
async function seed(): Promise<void> {
	await db.insert(narrators).values([
		{ id: "root", type: "primary", variant: "primary", createdAt: NOW, updatedAt: NOW },
		{
			id: "parent",
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: "root",
			createdAt: NOW,
			updatedAt: NOW,
		},
		{
			id: "sub-1",
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: "parent",
			status: "working",
			title: "Worker",
			createdAt: NOW,
			updatedAt: NOW,
		},
		{
			id: "sub-2",
			type: "subagent",
			variant: "subagent:explore",
			parentNarratorId: "parent",
			status: "idle",
			title: "Explorer",
			createdAt: NOW,
			updatedAt: NOW,
		},
		{
			id: "primary",
			type: "primary",
			variant: "primary",
			status: "working",
			createdAt: NOW,
			updatedAt: NOW,
		},
	]);
	liveSessions.add("sub-1");
	liveSessions.add("primary");
}
async function seedOrphan(status: "idle" | "archived" = "archived"): Promise<void> {
	await seed();
	liveSessions.delete("sub-1");
	await db
		.update(narrators)
		.set({
			status,
			isBackground: true,
			backgroundStatus: "running",
			backgroundResult: "retained result",
			errorMessage: "retained error",
			substatus: '["error"]',
		})
		.where(eq(narrators.id, "sub-1"));
	await db.insert(narratorMessages).values({
		id: "history",
		narratorId: "sub-1",
		role: "assistant",
		contentJson: [{ type: "text", text: "retained" }],
		createdAt: NOW,
	});
}

beforeEach(() => {
	resetRecoveryHandoffForTests();
	cleanDb(sqlite);
	backgroundTaskService.resetListVersionsForTests();
	liveSessions.clear();
	closed.length = 0;
	resourcesClosed.length = 0;
	helpersStopped.length = 0;
	runControls.length = 0;
	statusUpdates.length = 0;
	frames.length = 0;
	wakes.length = 0;
	derivedSpy.mockClear();
	runtimePublication.setWake((id) => {
		wakes.push(id);
	});
});
afterEach(async () => {
	for (const owner of owners.splice(0)) owner.release();
	for (const id of ["sub-1", "sub-2", "primary"]) setRunHold(id, undefined);
	await flush();
});
afterAll(async () => {
	runtimePublication.stop();
	await backgroundOccupancyStore.stop();
	statusSpy.mockRestore();
	mock.module("../../db", () => realDb);
	mock.module("../narrator-session", () => realSession);
	mock.module("../agent-runtime/run", () => realRun);
	mock.module("../subagent-resources", () => realResources);
	mock.module("../../websocket/narrator-ws", () => realWs);
	mock.restore();
	await fixture.close();
});

describe("interruptAndArchiveSubagent", () => {
	test("interrupts running work, stops helpers, closes resources and archives a subagent", async () => {
		await seed();
		const result = await interruptAndArchiveSubagent("sub-1");
		expect(result).toMatchObject({ ok: true, archived: true, interrupted: true });
		expect(closed).toEqual(["sub-1"]);
		expect(runControls).toEqual([{ id: "sub-1", kind: "cancel" }]);
		expect(helpersStopped).toEqual(["sub-1"]);
		expect(resourcesClosed).toEqual(["sub-1"]);
		expect(statusUpdates).toEqual([{ id: "sub-1", status: "archived" }]);
		expect(row("sub-1")?.status).toBe("archived");
	});
	test("is idempotent for already-archived subagents", async () => {
		await seed();
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "sub-1"));
		const result = await interruptAndArchiveSubagent("sub-1");
		expect(result).toMatchObject({ ok: true, alreadyArchived: true, archived: false });
		expect(statusUpdates).toEqual([]);
		expect(resourcesClosed).toEqual(["sub-1"]);
	});
	test("archives an authorized ordinary session; unknown ids write nothing", async () => {
		await seed();
		expect(await interruptAndArchiveSubagent("primary")).toMatchObject({
			ok: true,
			archived: true,
		});
		expect(runControls).toEqual([{ id: "primary", kind: "cancel" }]);
		expect(closed).toEqual(["primary"]);
		statusUpdates.length = 0;
		expect(await interruptAndArchiveSubagent("nope")).toMatchObject({
			ok: false,
			error: "not_found",
		});
		expect(statusUpdates).toEqual([]);
	});

	for (const status of ["idle", "archived"] as const) {
		test(`settles a driverless legacy claim on ${status === "idle" ? "first archive" : "repeated archive"}`, async () => {
			await seedOrphan(status);
			const before = row("sub-1");
			const messages = await db.select().from(narratorMessages);
			const result = await interruptAndArchiveSubagent("sub-1");
			expect(result).toMatchObject({
				ok: true,
				alreadyArchived: status === "archived",
				archived: status !== "archived",
				interrupted: true,
			});
			expect(row("sub-1")).toMatchObject({
				status: "archived",
				parentNarratorId: "parent",
				backgroundStatus: "cancelled",
				backgroundResult: before?.backgroundResult,
			});
			expect(row("sub-1")?.backgroundCompletedAt).not.toBeNull();
			expect(await db.select().from(narratorMessages)).toEqual(messages);
			if (status === "archived") expect(row("sub-1")?.errorMessage).toBe(before?.errorMessage);
			expect(derivedSpy).toHaveBeenCalledWith("parent", "sub-1");
			expect(wakes).toEqual([]);
			await flush();
			expect(frames.some((frame) => frame.type === "subagent_completed")).toBe(false);
		});
	}
	for (const terminal of ["failed", "completed", "cancelled"] as const) {
		test(`preserves existing ${terminal} terminal fields`, async () => {
			await seedOrphan();
			await db
				.update(narrators)
				.set({ backgroundStatus: terminal, backgroundCompletedAt: NOW })
				.where(eq(narrators.id, "sub-1"));
			const before = row("sub-1");
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")).toEqual(before);
			expect(derivedSpy).not.toHaveBeenCalled();
		});
	}
	for (const protection of [
		"owner",
		"run-control",
		"hold",
		"held-result",
		"taken-over",
		"registration",
		"logical-run",
		"terminal-checkpoint",
		"task",
	] as const) {
		test(`preserves a claim protected by ${protection}`, async () => {
			await seedOrphan();
			if (protection === "owner" || protection === "run-control") {
				const owner = tryClaimExecution("sub-1", "run");
				if (!owner) throw new Error("Missing fixture owner");
				owners.push(owner);
				if (protection === "run-control")
					setRunControl(owner, {
						startedAt: Date.now(),
						cancel: new AbortController(),
						timedOut: false,
						terminal: new Promise(() => {}),
					});
			}
			if (protection === "hold") setRunHold("sub-1", { released: false });
			if (protection === "held-result")
				setRunHold("sub-1", {
					released: true,
					result: {
						started: true,
						output: "result",
						finalText: "result",
						hasError: false,
						interrupted: false,
						timedOut: false,
					},
				});
			if (protection === "taken-over")
				await db
					.update(narrators)
					.set({ substatus: '["taken_over"]' })
					.where(eq(narrators.id, "sub-1"));
			if (protection === "registration")
				await db
					.update(narrators)
					.set({ runtimeRegistrationJson: { version: 1, run: { logicalRunId: "registered-run" } } })
					.where(eq(narrators.id, "sub-1"));
			if (protection === "logical-run")
				await db
					.update(narrators)
					.set({ logicalRunId: "recoverable-run" })
					.where(eq(narrators.id, "sub-1"));
			if (protection === "terminal-checkpoint")
				await db
					.update(narrators)
					.set({ substatus: '["terminal_run:old-run"]' })
					.where(eq(narrators.id, "sub-1"));
			if (protection === "task")
				await db.insert(backgroundTasks).values({
					id: "distinct-projection",
					parentNarratorId: "parent",
					subagentNarratorId: "sub-1",
					type: "agent",
					status: "running",
					startedAt: NOW,
					createdAt: NOW,
					updatedAt: NOW,
				});
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(row("sub-1")?.backgroundCompletedAt).toBeNull();
			expect(derivedSpy).not.toHaveBeenCalled();
		});
	}
	for (const continuationOwner of ["sub-1", "parent"] as const) {
		for (const checkpointState of ["paused", "completed"] as const) {
			test(`retains the ${checkpointState} checkpoint owned by ${continuationOwner}`, async () => {
				await seedOrphan();
				await db.insert(narratorToolCalls).values({
					id: "checkpoint-tool",
					narratorId: continuationOwner,
					messageId: "history",
					toolName: "Agent",
					toolUseId: "checkpoint-use",
					createdAt: NOW,
				});
				await db.insert(narratorToolContinuations).values({
					id: "checkpoint",
					narratorId: continuationOwner,
					toolCallId: "checkpoint-tool",
					updateEpoch: "restart-test",
					kind: "background_agent",
					state: checkpointState,
					payloadJson: { subagentId: "sub-1", recoveryPhase: "owner_continuation_pending" },
					createdAt: NOW,
					updatedAt: NOW,
				});
				expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
				expect(row("sub-1")?.backgroundStatus).toBe("running");
				expect(derivedSpy).not.toHaveBeenCalled();
			});
		}
	}
	for (const mounted of ["cancelled", "owner_continuation_started"] as const) {
		test(`a checkpoint already handed back through ${mounted} permits orphan compensation`, async () => {
			await seedOrphan();
			await db.insert(narratorToolCalls).values({
				id: "mounted-tool",
				narratorId: "sub-1",
				messageId: "history",
				toolName: "Bash",
				toolUseId: "mounted-use",
				createdAt: NOW,
			});
			await db.insert(narratorToolContinuations).values({
				id: "mounted-continuation",
				narratorId: "sub-1",
				toolCallId: "mounted-tool",
				updateEpoch: "restart-mounted",
				kind: "deferred_tool",
				state: mounted === "cancelled" ? "cancelled" : "completed",
				payloadJson: mounted === "cancelled" ? {} : { recoveryPhase: mounted },
				createdAt: NOW,
				updatedAt: NOW,
			});
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")?.backgroundStatus).toBe("cancelled");
		});
	}
	for (const outcome of ["settled", "withdrawn", "invalidated"] as const) {
		test(`a manifest-only null-run target is protected until ${outcome}`, async () => {
			await seedOrphan();
			expect(row("sub-1")?.logicalRunId).toBeNull();
			expect(row("sub-1")?.runtimeRegistrationJson).toBeNull();
			expect(
				await db
					.select({ id: narratorToolContinuations.id })
					.from(narratorToolContinuations)
					.limit(1),
			).toEqual([]);
			const source: import("../recovery-handoff").RecoverySource = {
				updateEpoch: "manifest-only",
				kind: "ordinary",
				capturedAt: NOW,
				narrators: [{ narratorId: "sub-1", locale: "en" }],
				pendingNarratorIds: ["sub-1"],
				logicalRuns: [{ narratorId: "sub-1", logicalRunId: null }],
			};
			const handle = registerRecoverySource(source);
			expect(isRecoveryTargetPending("sub-1")).toBe(true);
			expect(await interruptAndArchiveSubagent("sub-1")).toMatchObject({
				ok: true,
				alreadyArchived: true,
				interrupted: false,
			});
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(derivedSpy).not.toHaveBeenCalled();
			if (outcome === "settled") handle.update({ ...source, pendingNarratorIds: [] });
			else if (outcome === "withdrawn") handle.retire();
			else invalidateRecoveryTarget("sub-1");
			expect(isRecoveryTargetPending("sub-1")).toBe(false);
			expect(await interruptAndArchiveSubagent("sub-1")).toMatchObject({
				ok: true,
				alreadyArchived: true,
				interrupted: true,
			});
			expect(row("sub-1")?.backgroundStatus).toBe("cancelled");
			expect(derivedSpy).toHaveBeenCalledWith("parent", "sub-1");
			expect(wakes).toEqual([]);
		});
	}
	test("a pending manifest target published during the worker read protects the claim", async () => {
		await seedOrphan();
		const source: import("../recovery-handoff").RecoverySource = {
			updateEpoch: "manifest-read-race",
			kind: "ordinary",
			capturedAt: NOW,
			narrators: [{ narratorId: "sub-1", locale: "en" }],
			pendingNarratorIds: ["sub-1"],
			logicalRuns: [{ narratorId: "sub-1", logicalRunId: null }],
		};
		const read = publication.readArchivedOrphanBackgroundClaim.bind(publication);
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockImplementation(
			async (id) => {
				const claim = await read(id);
				registerRecoverySource(source);
				return claim;
			},
		);
		try {
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(derivedSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		registerRecoverySource(source).retire();
		expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
		expect(row("sub-1")?.backgroundStatus).toBe("cancelled");
	});
	test("recovery discovery defers compensation until pending identities are classified", async () => {
		await seedOrphan();
		beginRecoveryDiscovery();
		expect(isRecoveryTargetPending("sub-1")).toBe(false);
		expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
		expect(row("sub-1")?.backgroundStatus).toBe("running");
		finishRecoveryDiscovery();
		expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
		expect(row("sub-1")?.backgroundStatus).toBe("cancelled");
	});
	test("a manifest-only target registered during the identity read protects the claim", async () => {
		await seedOrphan();
		const read = publication.readArchivedOrphanBackgroundClaim.bind(publication);
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockImplementation(
			async (id) => {
				const claim = await read(id);
				registerRecoverySource({
					updateEpoch: "manifest-read-race",
					kind: "planned",
					capturedAt: NOW,
					narrators: [{ narratorId: id, locale: "en" }],
					pendingNarratorIds: [id],
					logicalRuns: [{ narratorId: id, logicalRunId: null }],
				});
				return claim;
			},
		);
		try {
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(derivedSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	test("a session that becomes active during the worker read protects the claim", async () => {
		await seedOrphan();
		const read = publication.readArchivedOrphanBackgroundClaim.bind(publication);
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockImplementation(
			async (id) => {
				const claim = await read(id);
				liveSessions.add(id);
				return claim;
			},
		);
		try {
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(derivedSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	test("retains an existing completion time when settling a raw running claim", async () => {
		await seedOrphan();
		await db.update(narrators).set({ backgroundCompletedAt: NOW }).where(eq(narrators.id, "sub-1"));
		expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
		expect(row("sub-1")).toMatchObject({
			backgroundStatus: "cancelled",
			backgroundCompletedAt: NOW,
		});
	});
	test("CAS preserves a competing terminal and sends no cleanup notification", async () => {
		await seedOrphan();
		const read = publication.readArchivedOrphanBackgroundClaim.bind(publication);
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockImplementation(
			async (id) => {
				const claim = await read(id);
				await db
					.update(narrators)
					.set({ backgroundStatus: "failed", backgroundCompletedAt: NOW })
					.where(eq(narrators.id, id));
				return claim;
			},
		);
		try {
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")).toMatchObject({
				backgroundStatus: "failed",
				backgroundCompletedAt: NOW,
			});
			expect(derivedSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	test("CAS rejects a newer terminal or run identity read after observation", async () => {
		await seedOrphan();
		const read = publication.readArchivedOrphanBackgroundClaim.bind(publication);
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockImplementation(
			async (id) => {
				const claim = await read(id);
				await db
					.update(narrators)
					.set({
						logicalRunId: "newer-run",
						runtimeRegistrationJson: { version: 1, run: { logicalRunId: "newer-run" } },
					})
					.where(eq(narrators.id, id));
				return claim;
			},
		);
		try {
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")).toMatchObject({
				logicalRunId: "newer-run",
				backgroundStatus: "running",
				backgroundCompletedAt: null,
			});
			expect(derivedSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	test("a task projection inserted after the worker read wins over orphan compensation", async () => {
		await seedOrphan();
		const read = publication.readArchivedOrphanBackgroundClaim.bind(publication);
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockImplementation(
			async (id) => {
				const claim = await read(id);
				await db.insert(backgroundTasks).values({
					id: "racing-projection",
					type: "agent",
					parentNarratorId: "parent",
					subagentNarratorId: id,
					status: "running",
					createdAt: NOW,
					startedAt: NOW,
					updatedAt: NOW,
				});
				return claim;
			},
		);
		try {
			expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(derivedSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	test("worker read failure remains observable without a successful cleanup notification", async () => {
		await seedOrphan();
		const failure = new Error("Archive identity worker unavailable");
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockRejectedValue(failure);
		try {
			expect(await interruptAndArchiveSubagent("sub-1")).toMatchObject({
				ok: false,
				error: failure.message,
			});
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(resourcesClosed).toEqual(["sub-1"]);
			expect(derivedSpy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	test("a released hold without a retained result does not own the abandoned claim", async () => {
		await seedOrphan();
		setRunHold("sub-1", { released: true });
		expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
		expect(row("sub-1")?.backgroundStatus).toBe("cancelled");
	});
	test("database lock failure is observable, closes resources and emits no successful cleanup", async () => {
		await seedOrphan();
		const blocker = new Database(sqlite.filename);
		blocker.run("PRAGMA busy_timeout = 0");
		const read = publication.readArchivedOrphanBackgroundClaim.bind(publication);
		const spy = spyOn(publication, "readArchivedOrphanBackgroundClaim").mockImplementation(
			async (id) => {
				const claim = await read(id);
				blocker.run("BEGIN IMMEDIATE");
				return claim;
			},
		);
		try {
			const result = await interruptAndArchiveSubagent("sub-1");
			expect(result).toMatchObject({ ok: false, alreadyArchived: true, archived: false });
			expect(result.error).toMatch(/locked|busy/i);
			expect(row("sub-1")?.backgroundStatus).toBe("running");
			expect(resourcesClosed).toEqual(["sub-1"]);
			expect(derivedSpy).not.toHaveBeenCalled();
			expect(wakes).toEqual([]);
		} finally {
			spy.mockRestore();
			if (blocker.inTransaction) blocker.run("ROLLBACK");
			blocker.close();
		}
	});
	test("successful archive compensation clears cached ancestor counts and publishes a cancelled legacy row", async () => {
		await seedOrphan("idle");
		await backgroundOccupancyStore.start();
		await flush();
		expect(backgroundOccupancyStore.snapshot(["root", "parent"]).childCounts).toEqual(
			new Map([
				["root", 1],
				["parent", 1],
			]),
		);
		frames.length = 0;
		expect((await interruptAndArchiveSubagent("sub-1")).ok).toBe(true);
		await flush();
		for (const id of ["root", "parent"]) {
			expect(backgroundOccupancyStore.snapshot([id]).childCounts.get(id)).toBe(0);
			expect(
				frames.some(
					(frame) =>
						frame.type === "background_task_count_changed" &&
						frame.narratorId === id &&
						frame.activeBackgroundTaskCount === 0,
				),
			).toBe(true);
		}
		const page = await backgroundTaskService.listPageByParent("parent");
		expect(page.activeCount).toBe(0);
		expect(page.activeTasks).toEqual([]);
		expect(page.tasks.find((task) => task.id === "sub-1")).toMatchObject({
			status: "cancelled",
			effectiveStatus: "cancelled",
			canCancelActiveWork: false,
		});
		expect(
			frames.some(
				(frame) =>
					frame.type === "background_task_list_delta" &&
					(frame.upsert as { id?: string; status?: string } | undefined)?.id === "sub-1" &&
					(frame.upsert as { status?: string }).status === "cancelled",
			),
		).toBe(true);
		expect(wakes).toEqual([]);
	});
});

const pgArchiveTest = process.env.PG_INTEGRATION === "1" ? test : test.skip;
pgArchiveTest(
	"PG archive compensation preserves task, checkpoint and CAS protections",
	async () => {
		const [
			{ withPostgres },
			{ createPostgresClient },
			{ migrate },
			schema,
			{ createPostgresRuntimeQueue },
			{ createPostgresRuntimePublication },
		] = await Promise.all([
			import("../../../tests/db/pg-test-harness"),
			import("../../db/postgres-client"),
			import("drizzle-orm/bun-sql/migrator"),
			import("../../db/postgres-schema"),
			import("../agent-runtime/postgres-runtime-queue"),
			import("../agent-runtime/postgres-runtime-publication"),
		]);
		const result = await withPostgres(async ({ port, credentials }) => {
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/nf_harness`;
			const client = createPostgresClient({ driver: "bun-sql", url });
			try {
				const pg = client.db;
				await migrate(pg, { migrationsFolder: "drizzle-postgres" });
				const engine = createPostgresRuntimePublication(
					pg,
					createPostgresRuntimeQueue(pg),
					{ legacyReaders: new Map() },
					{ summarize: (value) => value, snapshotBytes: 64 * 1024 },
				);
				await pg.insert(schema.narrators).values([
					{
						id: "pg-parent",
						type: "primary",
						variant: "primary",
						createdAt: NOW,
						updatedAt: NOW,
					},
					...["orphan", "task", "checkpoint", "race"].map((id) => ({
						id: `pg-${id}`,
						type: "subagent",
						variant: "subagent:general",
						parentNarratorId: "pg-parent",
						status: "archived",
						isBackground: true,
						backgroundStatus: "running",
						backgroundResult: "retained",
						createdAt: NOW,
						updatedAt: NOW,
					})),
				]);
				const orphan = await engine.readArchivedOrphanBackgroundClaim("pg-orphan");
				if (!orphan) throw new Error("Missing PostgreSQL orphan fixture");
				expect(
					await engine.settleArchivedOrphanBackgroundClaim(orphan, "2026-11-18T11:00:00.000Z"),
				).toBe(true);
				const [settled] = await pg
					.select({
						status: schema.narrators.status,
						backgroundStatus: schema.narrators.backgroundStatus,
						result: schema.narrators.backgroundResult,
					})
					.from(schema.narrators)
					.where(eq(schema.narrators.id, "pg-orphan"));
				expect(settled).toEqual({
					status: "archived",
					backgroundStatus: "cancelled",
					result: "retained",
				});
				expect(
					await pg
						.select({ id: schema.runtimePublicationOutbox.id })
						.from(schema.runtimePublicationOutbox)
						.limit(1),
				).toEqual([]);
				await pg.insert(schema.backgroundTasks).values({
					id: "distinct-pg-task",
					parentNarratorId: "pg-parent",
					subagentNarratorId: "pg-task",
					type: "agent",
					status: "running",
					createdAt: NOW,
					startedAt: NOW,
					updatedAt: NOW,
				});
				const task = await engine.readArchivedOrphanBackgroundClaim("pg-task");
				if (!task) throw new Error("Missing PostgreSQL task fixture");
				expect(await engine.settleArchivedOrphanBackgroundClaim(task, NOW)).toBe(false);
				await pg.insert(schema.narratorMessages).values({
					id: "pg-message",
					narratorId: "pg-parent",
					role: "assistant",
					contentJson: [],
					createdAt: NOW,
				});
				await pg.insert(schema.narratorToolCalls).values({
					id: "pg-tool",
					narratorId: "pg-parent",
					messageId: "pg-message",
					toolName: "Agent",
					toolUseId: "pg-use",
					createdAt: NOW,
				});
				await pg.insert(schema.narratorToolContinuations).values({
					id: "pg-continuation",
					narratorId: "pg-parent",
					toolCallId: "pg-tool",
					updateEpoch: "pg-archive",
					kind: "background_agent",
					state: "completed",
					payloadJson: {
						subagentId: "pg-checkpoint",
						recoveryPhase: "owner_continuation_pending",
					},
					createdAt: NOW,
					updatedAt: NOW,
				});
				const checkpoint = await engine.readArchivedOrphanBackgroundClaim("pg-checkpoint");
				if (!checkpoint) throw new Error("Missing PostgreSQL checkpoint fixture");
				expect(await engine.settleArchivedOrphanBackgroundClaim(checkpoint, NOW)).toBe(false);
				const race = await engine.readArchivedOrphanBackgroundClaim("pg-race");
				if (!race) throw new Error("Missing PostgreSQL race fixture");
				await pg
					.update(schema.narrators)
					.set({ backgroundStatus: "failed", backgroundCompletedAt: NOW })
					.where(eq(schema.narrators.id, race.id));
				expect(await engine.settleArchivedOrphanBackgroundClaim(race, NOW)).toBe(false);
				return "passed";
			} finally {
				await client.close();
			}
		});
		if (typeof result === "object" && result.status === "blocked")
			throw new Error(`PostgreSQL archive test unavailable: ${result.reason}`);
		expect(result).toBe("passed");
	},
	300_000,
);

describe("archiveRetiredSubagents", () => {
	test("archives each unique subagent once and continues past failures", async () => {
		await seed();
		const results = await archiveRetiredSubagents(["sub-1", "sub-1", "missing", "sub-2"]);
		expect(results.map((result) => result.id)).toEqual(["sub-1", "missing", "sub-2"]);
		expect(results[0]?.archived).toBe(true);
		expect(results[1]?.ok).toBe(false);
		expect(results[2]?.archived).toBe(true);
		expect(row("sub-1")?.status).toBe("archived");
		expect(row("sub-2")?.status).toBe("archived");
	});
});
