import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	runtimePublicationOutbox,
} from "../../db/schema";
import { getNarraforkPath } from "../../lib/narrafork-home";
import {
	beginRecoveryDiscovery,
	finishRecoveryDiscovery,
	getRegisteredRecoverySource,
	resetRecoveryHandoffForTests,
} from "../recovery-handoff";

// Keep all recovery classification, conditional result writes, and continuation claims real.
// Only the boundaries that would launch a tool/model are replaced below.
const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
// Initialize the service first to avoid its persistence facade's circular import.
await import("../narrator-service");
const recovery = await import("../restart-recovery-service");
const { toolContinuationService } = await import("../tool-continuation-service");
const { narratorPersistence } = await import("../narrator-persistence");
const coordinator = await import("../update-coordinator");
const session = await import("../narrator-session");
const now = "2026-10-07T00:00:00.000Z";
const backgroundStartOutput =
	'<background_task_id>helper</background_task_id>\n\nBackground task started. Await({ type: "agent", id: "helper" })';
const originalArgs = [...process.argv];
type RecoveredRun = NonNullable<Parameters<typeof session.continueNarrator>[4]>;
/** Every recovery start goes through the one entry: the session and its run options. */
const runs: Array<{ narratorId: string; run?: RecoveredRun }> = [];
/** Recovery that did not re-enter the session's own persisted run. */
const freshRuns: string[] = [];
const started = () => runs.map((entry) => entry.narratorId);
let executedTools = 0;

function emptyProtection() {
	return {
		narratorIds: new Set<string>(),
		toolCallIds: new Set<string>(),
		backgroundTaskIds: new Set<string>(),
	};
}

/** A run registration that delivers its result to `deliverTo` (what makes a run delegated). */
function deliveringRun(
	id: string,
	deliverTo: { narratorId: string; toolUseId: string; toolCallId?: string },
) {
	return { version: 1 as const, run: { logicalRunId: `run-${id}`, deliverTo } };
}

/**
 * By default a seeded session's run delivers to a caller that is not itself being
 * recovered (an independently mounted delegated run). Pass `runtimeRegistrationJson:
 * null` for a session that delivers to nobody.
 */
async function seedNarrator(id: string, values: Partial<typeof narrators.$inferInsert> = {}) {
	await db.insert(narrators).values({
		id,
		variant: "subagent:general",
		type: "subagent",
		status: "working",
		logicalRunId: `run-${id}`,
		runtimeRegistrationJson: deliveringRun(id, {
			narratorId: "external-caller",
			toolUseId: `use-for-${id}`,
		}),
		createdAt: now,
		updatedAt: now,
		...values,
	});
}

async function seedTool(
	id: string,
	narratorId: string,
	values: Partial<typeof narratorToolCalls.$inferInsert> = {},
) {
	const messageId = `message-${id}`;
	const toolUseId = `use-${id}`;
	const toolName = values.toolName ?? "Bash";
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
		createdAt: now,
	});
	const refs = await db.query.narratorMessageRefs.findMany({
		where: eq(narratorMessageRefs.narratorId, narratorId),
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${id}`,
		narratorId,
		messageId,
		seq: refs.length,
	});
	await db.insert(narratorToolCalls).values({
		id,
		narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson: {},
		executionIdentityVersion: 1,
		executionAttempt: 1,
		status: "running",
		createdAt: now,
		...values,
	});
}

async function seedAgent(background = false) {
	await seedNarrator("parent", {
		variant: "primary",
		type: "primary",
		runtimeRegistrationJson: null,
		status: "waiting",
		substatus: JSON.stringify(["awaiting_subagent"]),
	});
	await seedTool("agent-call", "parent", {
		toolName: "Agent",
		executionStartedAt: now,
		...(background ? { status: "success", outputJson: backgroundStartOutput } : {}),
	});
	await seedNarrator("child", {
		parentNarratorId: "parent",
		originToolCallId: "agent-call",
		runtimeRegistrationJson: deliveringRun("child", {
			narratorId: "parent",
			toolUseId: "use-agent-call",
			toolCallId: "agent-call",
		}),
	});
	if (background) {
		await db.insert(backgroundTasks).values({
			id: "background-child",
			parentNarratorId: "parent",
			subagentNarratorId: "child",
			type: "agent",
			status: "running",
			toolCallId: "agent-call",
			logicalRunId: "run-child",
			alias: "helper",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
	}
}

async function tool(id: string) {
	return db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, id) });
}

beforeEach(async () => {
	cleanDb(sqlite);
	recovery.resetRestartRecoveryForTests();
	resetRecoveryHandoffForTests();
	coordinator.resetUpdateCoordinationForTests();
	process.argv = originalArgs.filter((arg) => arg !== recovery.NO_AUTO_RESUME_FLAG);
	runs.length = 0;
	freshRuns.length = 0;
	executedTools = 0;
	await unlink(getNarraforkPath("restart-recovery.json")).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	spyOn(session, "continueNarrator").mockImplementation(async (narratorId, _l, _r, _u, run) => {
		runs.push({ narratorId, run });
		// Recovery always continues the persisted run (same id, same deadline), never a new one.
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
		if (!run?.recovered || (row?.logicalRunId && run.resumeRunId !== row.logicalRunId))
			freshRuns.push(narratorId);
		// Simulate the run boundary: a run that delivers and has no running task row
		// rewrites its registered destination tool call once; a task row receives it otherwise.
		const deliverTo = await session.readSessionDeliverTo(narratorId);
		const task = await db.query.backgroundTasks.findFirst({
			where: eq(backgroundTasks.subagentNarratorId, narratorId),
		});
		if (deliverTo?.toolCallId && run?.deliver !== false && task?.status !== "running") {
			const origin = await tool(deliverTo.toolCallId);
			if (origin) {
				await narratorPersistence.updateToolCallResultIfActive(
					origin.toolUseId,
					{ status: "success", output: "Recovered child result", completedAt: Date.now() },
					origin.messageId,
					origin.id,
				);
			}
		}
		return { ok: true, terminal: Promise.resolve("Recovered child result") };
	});
	spyOn(session, "executePersistedToolCall").mockImplementation(async () => {
		executedTools++;
		throw new Error("Unexpected tool execution in restart recovery test");
	});
	spyOn(session, "resumeBufferedMessagesIfIdle").mockResolvedValue(undefined as never);
});

afterEach(() => {
	const { listRunHolds, setRunHold } =
		require("../agent-runtime/ownership") as typeof import("../agent-runtime/ownership");
	for (const id of listRunHolds()) setRunHold(id, undefined);
	expect(freshRuns).toEqual([]);
	process.argv = [...originalArgs];
	coordinator.resetUpdateCoordinationForTests();
	mock.restore();
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	cleanDb(sqlite);
	sqlite.close();
});

describe("ordinary restart eligibility and tool disposition", () => {
	test("preload isolates all manifests from the user's data", () => {
		expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
		expect(process.env.NARRAFORK_HOME).not.toBe(testEnvironment.realNarraforkHome);
	});

	test("automatic resume is enabled unless the exact opt-out flag is present", () => {
		expect(recovery.automaticResumeEnabled([])).toBe(true);
		expect(recovery.automaticResumeEnabled(["bun", "--no-auto-resume"])).toBe(false);
		expect(recovery.automaticResumeEnabled(["--no-auto-resume=false"])).toBe(true);
	});

	test("only active non-severed runs are eligible", () => {
		for (const status of ["working", "waiting"]) {
			expect(recovery.restartEligible({ status, substatus: null })).toBe(true);
			for (const tag of ["taken_over", "manual_override", "cancelled", "error"]) {
				expect(recovery.restartEligible({ status, substatus: JSON.stringify([tag]) })).toBe(false);
			}
		}
		for (const status of ["idle", "archived"]) {
			expect(recovery.restartEligible({ status, substatus: null })).toBe(false);
		}
	});

	test("terminal results win; execution evidence never becomes permission to retry", () => {
		const row = { status: "running", executionStartedAt: null, fileChangeOperationId: null };
		expect(recovery.restartToolDisposition(row)).toBe("deferred");
		expect(recovery.restartToolDisposition({ ...row, status: "pending" })).toBe("permission");
		expect(recovery.restartToolDisposition({ ...row, executionStartedAt: now })).toBe(
			"execution_unknown",
		);
		expect(recovery.restartToolDisposition({ ...row, fileChangeOperationId: "operation" })).toBe(
			"execution_unknown",
		);
		for (const status of ["success", "fail"]) {
			expect(recovery.restartToolDisposition({ ...row, status, executionStartedAt: now })).toBe(
				"terminal",
			);
		}
	});
});

describe("ordinary restart with real persisted recovery records", () => {
	test("an empty startup hold snapshot skips the second scan, but standalone hydration stays fresh", async () => {
		await seedNarrator("later-held", { runtimeRegistrationJson: null });
		const runtime = await import("../agent-runtime/run");
		const hydration = spyOn(runtime, "hydrateRunHolds");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.heldRunIds).toEqual(new Set());
		expect(hydration).toHaveBeenCalledTimes(1);
		expect(await recovery.protectHeldRunFacts(emptyProtection(), prepared.heldRunIds)).toEqual(
			new Set(),
		);
		expect(hydration).toHaveBeenCalledTimes(1);

		await db
			.update(narrators)
			.set({ substatus: '["taken_over"]' })
			.where(eq(narrators.id, "later-held"));
		const fresh = emptyProtection();
		expect(await recovery.protectHeldRunFacts(fresh)).toEqual(new Set(["later-held"]));
		expect(fresh.narratorIds.has("later-held")).toBe(true);
		expect(prepared.heldRunIds).toEqual(new Set());
		expect(hydration).toHaveBeenCalledTimes(2);
	});

	test("failed hold hydration is not cached and can be retried", async () => {
		await seedNarrator("held-retry", {
			runtimeRegistrationJson: null,
			substatus: '["taken_over"]',
		});
		const runtime = await import("../agent-runtime/run");
		const hydration = spyOn(runtime, "hydrateRunHolds");
		hydration.mockRejectedValueOnce(new Error("temporary hold read failure"));
		await expect(recovery.protectHeldRunFacts(emptyProtection())).rejects.toThrow(
			"temporary hold read failure",
		);
		expect(await recovery.protectHeldRunFacts(emptyProtection())).toEqual(new Set(["held-retry"]));
		expect(hydration).toHaveBeenCalledTimes(2);
	});

	test("M5 full startup preserves a held background task and pending permission without notifying its caller", async () => {
		await seedAgent(true);
		await seedTool("held-permission", "child", {
			status: "pending",
			permissionSuggestions: [
				{ type: "danger_reflection", requestId: "held-approval", status: "awaiting_user" },
			],
		});
		await db
			.update(narrators)
			.set({ substatus: '["taken_over"]' })
			.where(eq(narrators.id, "child"));
		const { runtimePublication } = await import("../agent-runtime/publication");
		runtimePublication.stop();
		const runtime = await import("../agent-runtime/run");
		const hydration = spyOn(runtime, "hydrateRunHolds");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.manifest).toBeNull();
		expect(prepared.heldRunIds).toEqual(new Set(["child"]));
		expect(prepared.protection.narratorIds.has("child")).toBe(true);
		expect(prepared.protection.backgroundTaskIds.has("background-child")).toBe(true);
		expect(prepared.protection.toolCallIds.has("held-permission")).toBe(true);
		Reflect.deleteProperty(globalThis, Symbol.for("narrafork.narrator.initialized"));
		try {
			await session.recoverOnStartup(prepared.protection, { heldRunIds: prepared.heldRunIds });
			expect(hydration).toHaveBeenCalledTimes(1);
			expect(
				(
					await db.query.backgroundTasks.findFirst({
						where: eq(backgroundTasks.id, "background-child"),
					})
				)?.status,
			).toBe("running");
			expect(await tool("held-permission")).toMatchObject({
				status: "pending",
				permissionSuggestions: [
					{ type: "danger_reflection", requestId: "held-approval", status: "awaiting_user" },
				],
			});
			expect(await db.select().from(runtimePublicationOutbox)).toHaveLength(0);
			expect(started()).toEqual([]);
		} finally {
			Reflect.deleteProperty(globalThis, Symbol.for("narrafork.narrator.initialized"));
		}
	});

	test("M4 terminal persisted before idle is recovered as delivery, not a new model run", async () => {
		await seedAgent(true);
		const { getRuntimePublicationService, runtimePublication } = await import(
			"../agent-runtime/publication"
		);
		runtimePublication.stop();
		const pub = getRuntimePublicationService();
		const run = (
			await pub.startRun({
				narratorId: "child",
				resumeRunId: "run-child",
				binding: { deliverTo: { narratorId: "parent", toolUseId: "test-tool-use" } },
			})
		).publication!;
		await pub.commitAgentTerminal({
			run,
			eventKind: "completed",
			text: "durable crash answer",
			summary: "crashed before idle",
		});
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.manifest).toBeNull();
		expect((await db.query.narrators.findFirst({ where: eq(narrators.id, "child") }))?.status).toBe(
			"idle",
		);
		await recovery.restoreOrdinaryRestartRecovery(prepared);
		expect(started()).toEqual([]);
		expect((await pub.readAgentTerminalResult(run))?.output).toBe("durable crash answer");
		expect(await db.select().from(runtimePublicationOutbox)).toHaveLength(1);
	});

	test("publishes validated previous targets before an early bounded continuation read fails", async () => {
		await seedNarrator("parent", { type: "primary", variant: "primary", status: "idle" });
		await seedNarrator("child", { parentNarratorId: "parent" });
		await seedNarrator("unrelated");
		await writeFile(
			getNarraforkPath("restart-recovery.json"),
			JSON.stringify({
				version: 1,
				snapshot: {
					version: 2,
					updateEpoch: "restart-early-bounded-failure",
					capturedAt: now,
					narrators: [{ narratorId: "child", locale: "en" }],
				},
				targets: [{ narratorId: "child", logicalRunId: "run-child" }],
			}),
		);
		const error = new Error("Continuation payload exceeds startup budget");
		spyOn(toolContinuationService, "listByEpoch").mockRejectedValue(error);
		const discovered = new Set<string>();
		await expect(
			recovery.prepareOrdinaryRestartRecovery(emptyProtection(), {
				onTargetsDiscovered: (ids) => {
					for (const id of ids) discovered.add(id);
				},
			}),
		).rejects.toThrow(error.message);
		expect([...discovered]).toEqual(["child"]);
		expect(await session.failUnownedStartupRecovery(discovered, error)).toBe(1);
		const child = await db.query.narrators.findFirst({ where: eq(narrators.id, "child") });
		expect(child?.status).toBe("idle");
		expect(child?.errorMessage).toBe(`Startup recovery failed: ${error.message}`);
		expect(JSON.parse(child?.substatus ?? "[]")).toContain("interrupted");
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, "unrelated") }))?.status,
		).toBe("working");
	});

	test("publishes newly selected targets before output repair can fail", async () => {
		await seedNarrator("parent", { type: "primary", variant: "primary", status: "idle" });
		await seedNarrator("child", { parentNarratorId: "parent" });
		const outputRecovery = await import("../narrator-output-recovery");
		const error = new Error("output repair failed");
		spyOn(outputRecovery, "cleanupIncompleteNarratorOutput").mockRejectedValue(error);
		const discovered: string[] = [];
		await expect(
			recovery.prepareOrdinaryRestartRecovery(emptyProtection(), {
				onTargetsDiscovered: (ids) => discovered.push(...ids),
			}),
		).rejects.toThrow(error.message);
		expect(discovered).toEqual(["child"]);
		expect(await session.failUnownedStartupRecovery(discovered, error)).toBe(1);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, "child") }))?.errorMessage,
		).toBe(`Startup recovery failed: ${error.message}`);
	});

	test("does not publish targets from an invalid previous manifest", async () => {
		await writeFile(
			getNarraforkPath("restart-recovery.json"),
			JSON.stringify({
				version: 1,
				snapshot: { updateEpoch: "unowned-epoch", narrators: [] },
				targets: [{ narratorId: "untrusted", logicalRunId: null }],
			}),
		);
		const discovered: string[] = [];
		await expect(
			recovery.prepareOrdinaryRestartRecovery(emptyProtection(), {
				onTargetsDiscovered: (ids) => discovered.push(...ids),
			}),
		).rejects.toThrow("Invalid restart recovery manifest");
		expect(discovered).toEqual([]);
	});

	test("ordinary same-epoch external manifest edits reject a new handoff before changing the gate", async () => {
		await seedNarrator("child");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		if (!prepared.manifest) throw new Error("Missing ordinary manifest");
		const foreign = {
			...prepared.manifest,
			targets: [{ narratorId: "child", logicalRunId: "foreign-run" }],
		};
		await writeFile(getNarraforkPath("restart-recovery.json"), JSON.stringify(foreign));
		expect(() =>
			coordinator.scheduleUpdate(undefined, "system_shutdown", {
				supportedRecoveryManifestVersions: [1, 2, 3],
			}),
		).toThrow("manifest changed");
		expect(coordinator.getUpdateCoordinationStatus().phase).toBe("idle");
		expect(coordinator.getUpdateCoordinationStatus().updateEpoch).toBeUndefined();
		expect(runs).toEqual([]);
		expect(JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"))).toEqual(
			foreign,
		);
	});

	test("ordinary legitimate manual target shrink refreshes its identity for the next handoff", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedNarrator("chosen");
		await seedNarrator("remaining");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		await db.update(narrators).set({ status: "idle", substatus: JSON.stringify(["interrupted"]) });
		const handle = await recovery.restoreOrdinaryRestartRecovery(prepared, {
			manual: true,
			includedNarratorIds: new Set(["chosen"]),
		});
		await handle?.completion;
		const current = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(current.targets.map((target: { narratorId: string }) => target.narratorId)).toEqual([
			"remaining",
		]);
		coordinator.scheduleUpdate(undefined, "system_shutdown", {
			supportedRecoveryManifestVersions: [1, 2, 3],
		});
		await coordinator.waitForScheduledRecoveryHandoff();
		expect(coordinator.getScheduledRecoverySources()[0]?.pendingNarratorIds).toEqual(["remaining"]);
		const epoch = coordinator.getUpdateCoordinationStatus().updateEpoch;
		if (!epoch) throw new Error("Missing handoff epoch");
		coordinator.cancelScheduledUpdate();
		coordinator.rollbackPreparedUpdateRecoverySnapshot(epoch);
		coordinator.releasePreparedUpdateRecoveryHandoff(epoch);
	});

	for (const background of [false, true]) {
		test(`v3 reattached ${background ? "background" : "foreground"} Agent protects its child before ordinary classification`, async () => {
			await seedAgent(background);
			await toolContinuationService.upsert({
				toolCallId: "agent-call",
				narratorId: "parent",
				updateEpoch: "old-source",
				kind: "pending_permission",
				state: "waiting",
			});
			await toolContinuationService.claim("agent-call", {
				claimToken: "old-claim",
				deadlineAt: new Date(Date.now() + 300_000).toISOString(),
			});
			coordinator.writePlannedUpdateRecoverySnapshot({
				version: 3,
				updateEpoch: "new-root",
				capturedAt: now,
				resumeOnNextStartup: true,
				narrators: [],
				sources: [
					{
						updateEpoch: "old-source",
						kind: "planned",
						capturedAt: now,
						narrators: [
							{ narratorId: "parent", locale: "en" },
							{ narratorId: "child", locale: "en" },
						],
						pendingNarratorIds: ["parent", "child"],
						unstartedTools: [{ toolCallId: "agent-call", executionAttempt: 1 }],
					},
				],
			});
			const { getPlannedUpdateStartupProtection } = await import("../update-recovery-service");
			const startup = await getPlannedUpdateStartupProtection();
			const record = await toolContinuationService.getByToolCallId("agent-call");
			expect(record?.kind).toBe(background ? "background_agent" : "foreground_agent");
			expect(record?.updateEpoch).toBe("old-source");
			expect(record?.claimToken).toBeNull();
			expect(startup.protection.narratorIds.has("child")).toBe(true);
			if (background)
				expect(startup.protection.backgroundTaskIds.has("background-child")).toBe(true);
			const ordinary = await recovery.prepareOrdinaryRestartRecovery(startup.protection);
			expect(ordinary.manifest).toBeNull();
			expect(runs).toEqual([]);
			expect(executedTools).toBe(0);
		});
	}

	test("v3 clears only an evidenced unstarted permission claim and consumes root authorization once", async () => {
		await seedNarrator("child");
		await seedTool("approval", "child", { status: "pending" });
		await toolContinuationService.upsert({
			toolCallId: "approval",
			narratorId: "child",
			updateEpoch: "old-source",
			kind: "pending_permission",
			state: "waiting",
		});
		await toolContinuationService.claim("approval", {
			claimToken: "old-claim",
			deadlineAt: new Date(Date.now() + 300_000).toISOString(),
		});
		coordinator.writePlannedUpdateRecoverySnapshot({
			version: 3,
			updateEpoch: "new-root",
			capturedAt: now,
			resumeOnNextStartup: true,
			narrators: [],
			sources: [
				{
					updateEpoch: "old-source",
					kind: "ordinary",
					capturedAt: now,
					narrators: [{ narratorId: "child", locale: "en" }],
					pendingNarratorIds: ["child"],
					logicalRuns: [{ narratorId: "child", logicalRunId: "run-child" }],
					unstartedTools: [{ toolCallId: "approval", executionAttempt: 1 }],
				},
			],
		});
		const { getPlannedUpdateStartupProtection } = await import("../update-recovery-service");
		const startup = await getPlannedUpdateStartupProtection();
		expect(startup.snapshot?.updateEpoch).toBe("new-root");
		expect(await toolContinuationService.getByToolCallId("approval")).toMatchObject({
			updateEpoch: "old-source",
			state: "waiting",
			claimToken: null,
		});
		await toolContinuationService.claim("approval", {
			claimToken: "current-claim",
			deadlineAt: new Date(Date.now() + 300_000).toISOString(),
		});
		expect((await getPlannedUpdateStartupProtection()).snapshot).toBeNull();
		expect((await toolContinuationService.getByToolCallId("approval"))?.claimToken).toBe(
			"current-claim",
		);
	});

	test("active foreground child resumes its logical run and settles its parent exactly once", async () => {
		await seedAgent();
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.narratorIds).toEqual(new Set(["parent", "child"]));
		expect(prepared.protection.toolCallIds.has("agent-call")).toBe(true);
		const record = await toolContinuationService.getByToolCallId("agent-call");
		expect(record?.kind).toBe("foreground_agent");
		expect(record?.payloadJson?.logicalRunId).toBe("run-child");
		const handle = await recovery.restoreOrdinaryRestartRecovery(prepared);
		expect(handle).not.toBeNull();
		await handle?.completion;
		// Child and parent recover through the same entry: the child's run delivers to the
		// waiting call once, then the parent continues from that result.
		expect(started()).toEqual(["child", "parent"]);
		expect(runs[0]?.run?.resumeRunId).toBe("run-child");
		expect(runs[0]?.run?.deliver).not.toBe(false);
		expect((await tool("agent-call"))?.status).toBe("success");
		expect(executedTools).toBe(0);
		const repeated = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(repeated.manifest).toBeNull();
		expect(await recovery.restoreOrdinaryRestartRecovery(repeated)).toBeNull();
		expect(runs).toHaveLength(2);
	});

	test("a session with no parent that registers deliverTo recovers exactly like a delegated one", async () => {
		await seedAgent();
		// Same registration, no creation relationship: no parent, no origin, ordinary type.
		await db
			.update(narrators)
			.set({
				type: "primary",
				variant: "primary",
				parentNarratorId: null,
				originToolCallId: null,
				subagentOriginKind: null,
			})
			.where(eq(narrators.id, "child"));
		// A session with neither parent nor registration is not selected.
		await seedNarrator("plain", {
			type: "primary",
			variant: "primary",
			runtimeRegistrationJson: null,
		});
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.narratorIds).toEqual(new Set(["parent", "child"]));
		expect(prepared.manifest?.targets.map((target) => target.narratorId).sort()).toEqual([
			"child",
			"parent",
		]);
		const record = await toolContinuationService.getByToolCallId("agent-call");
		expect(record?.kind).toBe("foreground_agent");
		expect(record?.payloadJson?.subagentId).toBe("child");
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		// The run delivers once, then the session it delivers to continues from it.
		expect(started()).toEqual(["child", "parent"]);
		expect(runs[0]?.run?.resumeRunId).toBe("run-child");
		expect((await tool("agent-call"))?.status).toBe("success");
		expect(executedTools).toBe(0);
	});

	test("background Agent preserves its existing task and does not rerun the parent", async () => {
		await seedAgent(true);
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.backgroundTaskIds).toEqual(new Set(["background-child"]));
		const record = await toolContinuationService.getByToolCallId("agent-call");
		expect(record?.kind).toBe("background_agent");
		expect(record?.payloadJson?.backgroundTaskId).toBe("background-child");
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		// Only the child's run continues; it is not bound to a caller attempt, and its
		// result goes to its still-running task row, not into the start result.
		expect(started()).toEqual(["child"]);
		expect(runs[0]?.run?.cancelSignal).toBeUndefined();
		expect((await db.select().from(backgroundTasks)).map((row) => row.id)).toEqual([
			"background-child",
		]);
		expect((await tool("agent-call"))?.outputJson).toBe(backgroundStartOutput);
		expect(executedTools).toBe(0);
	});

	test("an ordinary cold boot adopts only actual old planned Agent and approval executions", async () => {
		await seedAgent();
		await seedTool("approval", "child", { status: "pending", permissionStartedAt: now });
		await seedTool("started-write", "child", { executionStartedAt: now });
		await seedNarrator("independent");
		for (const [toolCallId, narratorId, kind, payloadJson] of [
			[
				"agent-call",
				"parent",
				"foreground_agent",
				{ subagentId: "child", logicalRunId: "run-child" },
			],
			["approval", "child", "pending_permission", {}],
			["started-write", "child", "deferred_tool", {}],
		] as const) {
			await toolContinuationService.create({
				toolCallId,
				narratorId,
				kind,
				payloadJson,
				updateEpoch: "old-planned",
				state: "waiting",
			});
			await toolContinuationService.claim(toolCallId, {
				claimToken: `dead-${toolCallId}`,
				deadlineAt: "2099-01-01T00:00:00.000Z",
			});
		}
		let finishApproval!: () => void;
		const approval = new Promise<void>((resolve) => {
			finishApproval = resolve;
		});
		let reportApprovalMounted!: () => void;
		const approvalMounted = new Promise<void>((resolve) => {
			reportApprovalMounted = resolve;
		});
		spyOn(session, "executePersistedToolCall").mockImplementation(async (input) => {
			expect(input.toolCallId).toBe("approval");
			executedTools++;
			reportApprovalMounted();
			await approval;
			const call = await tool("approval");
			if (!call) throw new Error("Missing approval");
			await narratorPersistence.updateToolCallResultIfActive(
				call.toolUseId,
				{
					status: "success",
					output: "Approved",
					completedAt: Date.now(),
				},
				call.messageId,
				call.id,
			);
			return { ok: true, shouldContinue: true } as never;
		});
		beginRecoveryDiscovery();
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		finishRecoveryDiscovery();
		expect(prepared.manifest?.snapshot.updateEpoch).toMatch(/^restart-/);
		expect(getRegisteredRecoverySource("old-planned")).toBeUndefined();
		for (const id of ["agent-call", "approval"]) {
			expect((await toolContinuationService.getByToolCallId(id))?.updateEpoch).toBe(
				prepared.manifest?.snapshot.updateEpoch,
			);
		}
		expect((await tool("started-write"))?.errorMessage).toBe(recovery.RESTART_EXECUTION_UNKNOWN);
		const mounted = await recovery.restoreOrdinaryRestartRecovery(prepared);
		await approvalMounted;
		expect(runs.some((input) => input.narratorId === "independent")).toBe(true);
		expect(executedTools).toBe(1);
		finishApproval();
		await mounted?.completion;
		expect((await tool("approval"))?.status).toBe("success");
		expect(
			(await toolContinuationService.getByToolCallId("approval"))?.payloadJson?.recoveryStatus,
		).not.toBe("failed");
		expect(runs.filter((input) => input.narratorId === "child")).toHaveLength(1);
		expect(runs.find((input) => input.narratorId === "child")?.run?.resumeRunId).toBe("run-child");
		expect(await db.select({ id: narrators.id }).from(narrators)).toHaveLength(3);
	});

	for (const state of ["cancelled", "owner_started"] as const) {
		test(`old planned ${state} Agent cannot revive its stale active child during ordinary recovery`, async () => {
			await seedAgent();
			await seedNarrator("independent");
			await toolContinuationService.create({
				toolCallId: "agent-call",
				narratorId: "parent",
				updateEpoch: "old-planned",
				kind: "foreground_agent",
				state: state === "cancelled" ? "cancelled" : "completed",
				payloadJson: {
					subagentId: "child",
					logicalRunId: "run-child",
					...(state === "owner_started" ? { recoveryPhase: "owner_continuation_started" } : {}),
				},
			});
			const previous = await toolContinuationService.getByToolCallId("agent-call");
			beginRecoveryDiscovery();
			const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
			finishRecoveryDiscovery();
			await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
			expect(runs.map((input) => input.narratorId)).toEqual(["independent"]);
			expect(await toolContinuationService.getByToolCallId("agent-call")).toEqual(previous);
		});
	}

	test("a delivered old planned background Agent still recovers its running child without reviving the parent", async () => {
		await seedAgent(true);
		await toolContinuationService.create({
			toolCallId: "agent-call",
			narratorId: "parent",
			updateEpoch: "old-planned",
			kind: "background_agent",
			state: "completed",
			payloadJson: {
				subagentId: "child",
				logicalRunId: "run-child",
				backgroundTaskId: "background-child",
				recoveryPhase: "owner_continuation_started",
			},
		});
		const original = await toolContinuationService.getByToolCallId("agent-call");
		beginRecoveryDiscovery();
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		finishRecoveryDiscovery();
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		// Only the child's own run continues; the parent is not revived.
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			narratorId: "child",
			run: { resumeRunId: "run-child", recovered: true },
		});
		expect(executedTools).toBe(0);
		expect(await toolContinuationService.getByToolCallId("agent-call")).toEqual(original);
		expect(
			(
				await db.query.backgroundTasks.findFirst({
					where: eq(backgroundTasks.id, "background-child"),
				})
			)?.status,
		).toBe("running");
	});

	test("a started side-effect tool gets an explicit unknown result without being executed", async () => {
		await seedNarrator("standalone");
		await seedTool("started-write", "standalone", { toolName: "Write", executionStartedAt: now });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const repaired = await tool("started-write");
		expect(repaired?.status).toBe("fail");
		expect(repaired?.outputJson).toBe(recovery.RESTART_EXECUTION_UNKNOWN);
		expect(repaired?.errorMessage).toContain("not automatically retried");
		expect(repaired?.completedAt).not.toBeNull();
		expect(await toolContinuationService.getByToolCallId("started-write")).toBeNull();
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		expect(executedTools).toBe(0);
		expect(started()).toEqual(["standalone"]);
	});

	test("pending approval and not-yet-started tools are protected, not blanket-failed", async () => {
		await seedNarrator("standalone");
		await seedTool("approval", "standalone", { status: "pending", permissionStartedAt: now });
		await seedTool("deferred", "standalone", { status: "initializing" });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.toolCallIds).toEqual(new Set(["approval", "deferred"]));
		const approval = await toolContinuationService.getByToolCallId("approval");
		expect(approval?.kind).toBe("pending_permission");
		expect(approval?.state).toBe("waiting");
		expect(approval?.payloadJson?.preservePendingPermission).toBe(true);
		expect(approval?.payloadJson?.permissionMode).toBe("normal");
		expect((await tool("approval"))?.status).toBe("pending");
		expect((await toolContinuationService.getByToolCallId("deferred"))?.kind).toBe("deferred_tool");
		expect(executedTools).toBe(0);
		expect(runs).toEqual([]);
	});

	test("scanner protects only verified execution rows, never COW history clones or legacy identities", async () => {
		await seedNarrator("owner");
		await seedTool("real", "owner", { status: "pending" });
		await seedTool("history", "owner", {
			status: "pending",
			executionOriginToolCallId: "real",
			executionIdentityVersion: 1,
		});
		await seedTool("unverified", "owner", {
			status: "running",
			executionIdentityVersion: 0,
			executionStartedAt: now,
		});
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.toolCallIds).toEqual(new Set(["real"]));
		expect(await toolContinuationService.getByToolCallId("history")).toBeNull();
		expect(await toolContinuationService.getByToolCallId("unverified")).toBeNull();
		expect((await tool("history"))?.status).toBe("pending");
		expect((await tool("unverified"))?.status).toBe("running");
		expect(executedTools).toBe(0);
	});

	test("approval remount keeps normal permissions and does not block an independent streaming child", async () => {
		await seedNarrator("approval-child");
		await seedTool("approval", "approval-child", { status: "pending", permissionStartedAt: now });
		await seedNarrator("streaming-child");
		let releaseApproval: () => void = () => {};
		const decision = new Promise<void>((resolve) => {
			releaseApproval = resolve;
		});
		const mountedInputs: Array<Parameters<typeof session.executePersistedToolCall>[0]> = [];
		let reportMounted: () => void = () => {};
		const approvalMounted = new Promise<void>((resolve) => {
			reportMounted = resolve;
		});
		spyOn(session, "executePersistedToolCall").mockImplementation(async (input) => {
			mountedInputs.push(input);
			reportMounted();
			await decision;
			const call = await tool(input.toolCallId);
			if (!call) throw new Error("Missing pending approval fixture");
			await narratorPersistence.updateToolCallResultIfActive(
				call.toolUseId,
				{ status: "success", output: "Explicit approval result", completedAt: Date.now() },
				call.messageId,
				call.id,
			);
			return { ok: true, shouldContinue: true } as never;
		});
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const handle = await recovery.restoreOrdinaryRestartRecovery(prepared);
		try {
			expect(handle).not.toBeNull();
			await approvalMounted;
			expect(mountedInputs).toHaveLength(1);
			expect(mountedInputs[0]?.permissionMode).toBe("normal");
			expect((await tool("approval"))?.status).toBe("pending");
			expect(started()).toEqual(["streaming-child"]);
		} finally {
			releaseApproval();
			await handle?.completion;
		}
		expect((await tool("approval"))?.status).toBe("success");
		expect(started().sort()).toEqual(["approval-child", "streaming-child"]);
	});

	test("terminal tool results and completed or severed legacy children are never revived", async () => {
		await seedNarrator("active-legacy", { logicalRunId: null });
		await seedTool("legacy-success", "active-legacy", { status: "success", outputJson: "kept" });
		await seedTool("legacy-fail", "active-legacy", { status: "fail", outputJson: "kept failure" });
		await seedNarrator("done", { status: "idle", logicalRunId: null });
		await seedNarrator("cancelled", {
			substatus: JSON.stringify(["cancelled"]),
			logicalRunId: null,
		});
		await seedNarrator("taken-over", {
			substatus: JSON.stringify(["taken_over"]),
			logicalRunId: null,
		});
		await seedNarrator("unrelated-primary", {
			type: "primary",
			variant: "primary",
			runtimeRegistrationJson: null,
		});
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.manifest?.targets.map((row) => row.narratorId)).toEqual(["active-legacy"]);
		expect(prepared.protection.toolCallIds.size).toBe(0);
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		expect(started()).toEqual(["active-legacy"]);
		expect((await tool("legacy-success"))?.outputJson).toBe("kept");
		expect((await tool("legacy-fail"))?.outputJson).toBe("kept failure");
		expect(executedTools).toBe(0);
	});

	test("a terminal historical foreground Agent call is not replayed for a child's later run", async () => {
		await seedAgent();
		await db
			.update(narratorToolCalls)
			.set({ status: "success", outputJson: "Historical result" })
			.where(eq(narratorToolCalls.id, "agent-call"));
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(await toolContinuationService.getByToolCallId("agent-call")).toBeNull();
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		expect(started()).toEqual(["child"]);
		// The call already has its result: the child's later run must not deliver into it.
		expect(runs[0]?.run?.deliver).toBe(false);
		expect((await tool("agent-call"))?.outputJson).toBe("Historical result");
		expect(executedTools).toBe(0);
	});

	test("planned-update protected rows remain owned by their existing recovery", async () => {
		await seedNarrator("planned-child");
		await seedTool("planned-tool", "planned-child", { executionStartedAt: now });
		const protection = emptyProtection();
		protection.narratorIds.add("planned-child");
		protection.toolCallIds.add("planned-tool");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(protection);
		expect(prepared.manifest).toBeNull();
		expect((await tool("planned-tool"))?.status).toBe("running");
		expect(await toolContinuationService.getByToolCallId("planned-tool")).toBeNull();
	});

	test("--no-auto-resume still repairs and protects durable records but launches nothing", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedTool("approval", "child", { status: "pending" });
		await seedTool("started", "child", { executionStartedAt: now });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.toolCallIds.has("approval")).toBe(true);
		expect((await tool("started"))?.status).toBe("fail");
		expect(await recovery.restoreOrdinaryRestartRecovery(prepared)).toBeNull();
		expect(runs).toEqual([]);
		expect(executedTools).toBe(0);
		const manifest = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(manifest.snapshot.updateEpoch).toBe(prepared.manifest?.snapshot.updateEpoch);
	});

	test("opt-out boot followed by real signal preparation retains paused runs for default cold recovery", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedNarrator("paused");
		await seedTool("approval", "paused", { status: "pending" });
		for (const id of ["done", "cancelled", "archived", "taken-over", "new-run"]) {
			await seedNarrator(id);
		}
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const approvalId = (await toolContinuationService.getByToolCallId("approval"))?.id;
		await recovery.restoreOrdinaryRestartRecovery(first);
		await db.update(narrators).set({ status: "idle", substatus: '["interrupted"]' });
		await db.update(narrators).set({ substatus: "[]" }).where(eq(narrators.id, "done"));
		await db
			.update(narrators)
			.set({ substatus: '["cancelled"]' })
			.where(eq(narrators.id, "cancelled"));
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "archived"));
		await db
			.update(narrators)
			.set({ substatus: '["taken_over"]' })
			.where(eq(narrators.id, "taken-over"));
		await db
			.update(narrators)
			.set({ logicalRunId: "replacement-run" })
			.where(eq(narrators.id, "new-run"));
		await seedNarrator("live");
		coordinator.registerNarratorLoop("live", "zh-CN", {
			userId: "signal-user",
			replyInUserLanguage: true,
		});
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		expect(
			signal.targets.map((target: { narratorId: string }) => target.narratorId).sort(),
		).toEqual(["live", "paused"]);
		expect(
			signal.snapshot.narrators.find(
				(target: { narratorId: string }) => target.narratorId === "live",
			),
		).toEqual({
			narratorId: "live",
			locale: "zh-CN",
			userId: "signal-user",
			replyInUserLanguage: true,
		});
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		resetRecoveryHandoffForTests();
		process.argv = originalArgs.filter((arg) => arg !== recovery.NO_AUTO_RESUME_FLAG);
		spyOn(session, "executePersistedToolCall").mockImplementation(async (input) => {
			const call = await tool(input.toolCallId);
			if (!call) throw new Error("Missing signal approval fixture");
			await narratorPersistence.updateToolCallResultIfActive(
				call.toolUseId,
				{
					status: "success",
					output: "Approved after cold boot",
					completedAt: Date.now(),
				},
				call.messageId,
				call.id,
			);
			return { ok: true, shouldContinue: true } as never;
		});
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect((await toolContinuationService.getByToolCallId("approval"))?.id).toBe(approvalId);
		await (await recovery.restoreOrdinaryRestartRecovery(cold))?.completion;
		expect(started().sort()).toEqual(["live", "paused"]);
		expect((await tool("approval"))?.status).toBe("success");
	});

	test("signal preparation preserves terminal result epoch until its idle owner receives continuation", async () => {
		await seedNarrator("result-owner");
		await seedTool("finished", "result-owner", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		await toolContinuationService.claim("finished", {
			claimToken: "result-claim",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const call = await tool("finished");
		if (!call) throw new Error("Missing finished signal fixture");
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{
				status: "success",
				output: "Durable signal result",
				completedAt: Date.now(),
			},
			call.messageId,
			call.id,
		);
		await toolContinuationService.markResultWritten("finished", { claimToken: "result-claim" });
		await db.update(narrators).set({ status: "idle", substatus: "[]" });
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		expect(signal.targets.map((target: { narratorId: string }) => target.narratorId)).toEqual([
			"result-owner",
		]);
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		resetRecoveryHandoffForTests();
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		await (await recovery.restoreOrdinaryRestartRecovery(cold))?.completion;
		expect(started()).toEqual(["result-owner"]);
		expect((await tool("finished"))?.outputJson).toBe("Durable signal result");
		expect(
			(await toolContinuationService.getByToolCallId("finished"))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
		expect(executedTools).toBe(0);
	});

	test("cancelled continuations override interrupted tags, including foreground children, without dropping opt-out pauses", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedNarrator("cancelled-owner");
		await seedTool("cancelled-tool", "cancelled-owner", { status: "pending" });
		await seedNarrator("paused-owner");
		await seedTool("paused-tool", "paused-owner", { status: "pending" });
		await seedNarrator("streaming-only");
		await seedNarrator("mixed-owner");
		await seedTool("mixed-cancelled", "mixed-owner", { status: "pending" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const epoch = first.manifest?.snapshot.updateEpoch;
		if (!epoch) throw new Error("Missing cancellation test epoch");
		await toolContinuationService.cancelInterruptibleForNarrator("parent", epoch);
		await toolContinuationService.cancelInterruptibleForNarrator("cancelled-owner", epoch);
		await toolContinuationService.cancelInterruptibleForNarrator("mixed-owner", epoch);
		await seedTool("mixed-pending", "mixed-owner", { status: "pending" });
		await toolContinuationService.upsert({
			toolCallId: "mixed-pending",
			narratorId: "mixed-owner",
			updateEpoch: epoch,
			kind: "pending_permission",
			state: "waiting",
			payloadJson: { ordinaryRestart: true },
		});
		expect((await toolContinuationService.getByToolCallId("agent-call"))?.state).toBe("cancelled");
		expect(
			(await toolContinuationService.getByToolCallId("agent-call"))?.payloadJson?.subagentId,
		).toBe("child");
		await db.update(narrators).set({ status: "idle", substatus: '["interrupted"]' });
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch).toBe(epoch);
		expect(
			signal.targets.map((target: { narratorId: string }) => target.narratorId).sort(),
		).toEqual(["mixed-owner", "paused-owner", "streaming-only"]);
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		resetRecoveryHandoffForTests();
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(cold.manifest?.targets.map((target) => target.narratorId).sort()).toEqual([
			"mixed-owner",
			"paused-owner",
			"streaming-only",
		]);
		expect(await recovery.restoreOrdinaryRestartRecovery(cold)).toBeNull();
		expect(runs).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("signal does not retain an idle owner after its continuation was already delivered", async () => {
		await seedNarrator("delivered");
		await seedTool("delivered-tool", "delivered", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const epoch = first.manifest?.snapshot.updateEpoch;
		if (!epoch) throw new Error("Missing delivered owner epoch");
		const call = await tool("delivered-tool");
		if (!call) throw new Error("Missing delivered owner tool");
		await toolContinuationService.claim(call.id, {
			claimToken: "delivered-claim",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{
				status: "success",
				output: "Already delivered",
				completedAt: Date.now(),
			},
			call.messageId,
			call.id,
		);
		await toolContinuationService.markResultWritten(call.id, { claimToken: "delivered-claim" });
		await toolContinuationService.markOwnerContinuationPendingForMessage(call.messageId, epoch);
		await toolContinuationService.markOwnerContinuationStartedForMessage(call.messageId, epoch);
		expect(
			(await toolContinuationService.getByToolCallId(call.id))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
		await db.update(narrators).set({ status: "idle", substatus: "[]" });
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.targets).toEqual([]);
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		resetRecoveryHandoffForTests();
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(cold.manifest).toBeNull();
		expect(runs).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("fresh signal snapshot keeps only eligible live targets and their locale/user options", async () => {
		await seedNarrator("live");
		await seedNarrator("done", { status: "idle" });
		await seedNarrator("taken-over", { substatus: '["taken_over"]' });
		for (const id of ["live", "done", "taken-over"]) {
			coordinator.registerNarratorLoop(id, "zh-CN", {
				userId: "live-user",
				replyInUserLanguage: false,
			});
		}
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch.startsWith("restart-")).toBe(true);
		expect(signal.targets).toEqual([{ narratorId: "live", logicalRunId: "run-live" }]);
		expect(signal.snapshot.narrators).toEqual([
			{
				narratorId: "live",
				locale: "zh-CN",
				userId: "live-user",
				replyInUserLanguage: false,
			},
		]);
		expect(signal.snapshot.handoffMarkerNonce).toBeUndefined();
		expect(signal.snapshot.resumeOnNextStartup).toBeUndefined();
	});

	test("signal during a planned update cannot translate its epoch or handoff into restart authorization", async () => {
		await seedNarrator("planned-child");
		coordinator.registerNarratorLoop("planned-child", "zh-CN");
		coordinator.scheduleUpdate("future-version", "update");
		await recovery.prepareSignalRestartRecovery();
		expect(await Bun.file(getNarraforkPath("restart-recovery.json")).exists()).toBe(false);
		expect(coordinator.getUpdateCoordinationStatus().operation).toBe("update");
	});

	test("explicit manual continue resumes only the chosen subtree with --no-auto-resume", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedNarrator("chosen");
		await seedNarrator("descendant", {
			runtimeRegistrationJson: deliveringRun("descendant", {
				narratorId: "chosen",
				toolUseId: "use-chosen",
			}),
		});
		await seedNarrator("unrelated");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.narratorIds.size).toBe(0);
		// Startup's generic cleanup may rest these rows; the durable manifest still authorizes Continue.
		await db.update(narrators).set({ status: "idle", substatus: JSON.stringify(["interrupted"]) });
		expect(await recovery.restoreOrdinaryRestartRecovery(prepared)).toBeNull();
		expect(await recovery.manuallyResumeRestartRecovery("missing")).toBe(false);
		expect(runs).toEqual([]);
		expect(await recovery.manuallyResumeRestartRecovery("chosen")).toBe(true);
		expect(started().sort()).toEqual(["chosen", "descendant"]);
		expect(runs.map((entry) => entry.run?.resumeRunId).sort()).toEqual([
			"run-chosen",
			"run-descendant",
		]);
		expect(executedTools).toBe(0);
		// Manual entry returns after mounting; wait for its real background manifest transaction.
		let remaining: string[] = [];
		const deadline = Date.now() + 2_000;
		do {
			const manifest = JSON.parse(
				await readFile(getNarraforkPath("restart-recovery.json"), "utf8"),
			);
			remaining = manifest.targets.map((target: { narratorId: string }) => target.narratorId);
			if (remaining.length === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		} while (Date.now() < deadline);
		expect(remaining).toEqual(["unrelated"]);
		expect(await recovery.manuallyResumeRestartRecovery("chosen")).toBe(false);
		expect(runs).toHaveLength(2);
	});

	test("idle children without interrupted tags retain eligibility for undelivered persisted results", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedNarrator("result-owner");
		await seedTool("finished", "result-owner", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const epoch = first.manifest?.snapshot.updateEpoch;
		if (!epoch) throw new Error("Missing initial restart manifest");
		const claim = await toolContinuationService.claim("finished", {
			claimToken: "old-result-claim",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(claim).not.toBeNull();
		const call = await tool("finished");
		if (!call) throw new Error("Missing finished tool fixture");
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{ status: "success", output: "Persisted before owner resumed", completedAt: Date.now() },
			call.messageId,
			call.id,
		);
		await toolContinuationService.markResultWritten("finished", { claimToken: "old-result-claim" });
		await db
			.update(narrators)
			.set({ status: "idle", substatus: "[]" })
			.where(eq(narrators.id, "result-owner"));
		recovery.resetRestartRecoveryForTests();
		resetRecoveryHandoffForTests();
		const second = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(second.manifest?.snapshot.updateEpoch).toBe(epoch);
		expect(second.manifest?.targets.map((target) => target.narratorId)).toEqual(["result-owner"]);
		expect(
			(await toolContinuationService.getByToolCallId("finished"))?.payloadJson?.recoveryPhase,
		).toBe("result_written");
		expect(await recovery.restoreOrdinaryRestartRecovery(second)).toBeNull();
		expect(runs).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("manual child-only recovery is not deferred behind its excluded foreground parent", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedTool("child-approval", "child", { status: "pending" });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect((await toolContinuationService.getByToolCallId("agent-call"))?.kind).toBe(
			"foreground_agent",
		);
		await db.update(narrators).set({ status: "idle", substatus: JSON.stringify(["interrupted"]) });
		spyOn(session, "executePersistedToolCall").mockImplementation(async (input) => {
			executedTools++;
			expect(input.permissionMode).toBe("normal");
			const call = await tool(input.toolCallId);
			if (!call) throw new Error("Missing child approval fixture");
			await narratorPersistence.updateToolCallResultIfActive(
				call.toolUseId,
				{ status: "success", output: "Child approved result", completedAt: Date.now() },
				call.messageId,
				call.id,
			);
			return { ok: true, shouldContinue: true } as never;
		});
		const handle = await recovery.restoreOrdinaryRestartRecovery(prepared, {
			manual: true,
			includedNarratorIds: new Set(["child"]),
		});
		expect(handle).not.toBeNull();
		await handle?.completion;
		expect(started()).toEqual(["child"]);
		expect(runs[0]?.run?.resumeRunId).toBe("run-child");
		expect(executedTools).toBe(1);
		expect((await tool("agent-call"))?.status).toBe("success");
		expect((await toolContinuationService.getByToolCallId("agent-call"))?.state).toBe("paused");
		expect(
			(await toolContinuationService.getByToolCallId("child-approval"))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
	});

	test("cold recovery reconciles a terminal tool result before an expired execution claim", async () => {
		await seedNarrator("result-owner");
		await seedTool("finished", "result-owner", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		await toolContinuationService.claim("finished", {
			claimToken: "expired-execution",
			deadlineAt: now,
			now: new Date(Date.parse(now) - 60_000).toISOString(),
		});
		const call = await tool("finished");
		if (!call) throw new Error("Missing finished tool fixture");
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{ status: "success", output: "Successful durable side effect", completedAt: Date.now() },
			call.messageId,
			call.id,
		);
		const before = await toolContinuationService.getByToolCallId("finished");
		expect(before?.state).toBe("resuming");
		expect(before?.payloadJson?.recoveryPhase).toBeUndefined();
		const completedAt = (await tool("finished"))?.completedAt;
		await db
			.update(narrators)
			.set({ status: "idle", substatus: "[]" })
			.where(eq(narrators.id, "result-owner"));
		recovery.resetRestartRecoveryForTests();
		resetRecoveryHandoffForTests();
		const second = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(second.manifest?.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		await (await recovery.restoreOrdinaryRestartRecovery(second))?.completion;
		const after = await tool("finished");
		expect(after?.status).toBe("success");
		expect(after?.outputJson).toBe("Successful durable side effect");
		expect(after?.completedAt).toBe(completedAt);
		expect(after?.errorMessage).toBeNull();
		expect(executedTools).toBe(0);
		expect(started()).toEqual(["result-owner"]);
		expect(
			(await toolContinuationService.getByToolCallId("finished"))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
	});

	test("repeated cold boots retain the epoch, one continuation per call, and repaired results", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedTool("approval", "child", { status: "pending" });
		await seedTool("started", "child", { executionStartedAt: now });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const approvalId = (await toolContinuationService.getByToolCallId("approval"))?.id;
		const completedAt = (await tool("started"))?.completedAt;
		await db.update(narrators).set({ status: "idle", substatus: JSON.stringify(["interrupted"]) });
		recovery.resetRestartRecoveryForTests();
		resetRecoveryHandoffForTests();
		const second = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(second.manifest?.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		expect((await toolContinuationService.getByToolCallId("approval"))?.id).toBe(approvalId);
		expect(
			await toolContinuationService.listByEpoch(second.manifest?.snapshot.updateEpoch ?? ""),
		).toHaveLength(2);
		expect((await tool("started"))?.completedAt).toBe(completedAt);
		expect((await tool("started"))?.outputJson).toBe(recovery.RESTART_EXECUTION_UNKNOWN);
		expect(await recovery.restoreOrdinaryRestartRecovery(second)).toBeNull();
		expect(runs).toEqual([]);
		expect(executedTools).toBe(0);
	});
});
