import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
	runtimePublicationOutbox,
} from "../../db/schema";
import { MAILBOX_LIMITS as L } from "../agent-runtime/limits";
import {
	createPublicationOutbox,
	LEGACY_UNKNOWN_BASH_FAILURE_SUMMARY,
	type LegacyCompletionAdmission,
	type LegacyPublicationSource,
	type LegacyRuntimeAdmission,
} from "../agent-runtime/publication-outbox";

let database: ReturnType<typeof getTestDb>;
const time = "2026-09-08T00:00:00.000Z";
const source: LegacyPublicationSource = {
	producerKind: "bash",
	taskId: "old-bash",
	recipientId: "parent",
};
const admissions = new Map<string, LegacyRuntimeAdmission>();
function task(id: string, extra: Partial<typeof backgroundTasks.$inferInsert> = {}) {
	database.db
		.insert(backgroundTasks)
		.values({
			id,
			parentNarratorId: "parent",
			type: "bash",
			status: "running",
			startedAt: time,
			createdAt: time,
			updatedAt: time,
			...extra,
		})
		.run();
}
function publisher() {
	return createPublicationOutbox(database.db, {
		readLegacyRuntimeAdmission: (input) => admissions.get(input.taskId),
	});
}
function full(store: ReturnType<typeof publisher>) {
	for (let i = 0; i < L.publicationRecipientSlots; i++)
		store.reserveRunSlots({
			producerKind: "bash",
			taskId: `capacity-${i}`,
			logicalRunId: `run-${i}`,
			recipientId: "parent",
		});
}
beforeEach(() => {
	database = getTestDb();
	admissions.clear();
	const { db } = database;
	for (const id of ["parent", "other"])
		db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
	db.insert(narratorMessages)
		.values({
			id: "tool-message",
			narratorId: "parent",
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	for (const id of ["bash-tool", "agent-tool"])
		db.insert(narratorToolCalls)
			.values({
				id,
				narratorId: "parent",
				messageId: "tool-message",
				toolUseId: id,
				toolName: id === "bash-tool" ? "Bash" : "Agent",
				status: "running",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				executionStartedAt: time,
				createdAt: time,
			})
			.run();
	task("old-bash", { toolCallId: "bash-tool", executionAttempt: 1 });
	task("unbound");
	db.insert(narrators)
		.values({
			id: "old-agent",
			type: "subagent",
			parentNarratorId: "parent",
			originToolCallId: "agent-tool",
			status: "working",
			turnStartedAt: time,
			createdAt: time,
			updatedAt: time,
		})
		.run();
	db.insert(narratorToolContinuations)
		.values({
			id: "agent-checkpoint",
			narratorId: "parent",
			toolCallId: "agent-tool",
			updateEpoch: "old-update",
			kind: "foreground_agent",
			state: "paused",
			createdAt: time,
			updatedAt: time,
		})
		.run();
	admissions.set(source.taskId, { ...source, startedAtMs: Date.parse(time) });
	admissions.set("old-agent", {
		producerKind: "agent",
		taskId: "old-agent",
		recipientId: "parent",
		startedAtMs: Date.parse(time),
	});
});
afterEach(() => database.sqlite.close());

describe("explicit legacy publication admission", () => {
	test("captured completed entry registers only its event once, without rewriting task status", () => {
		database.db
			.update(backgroundTasks)
			.set({ status: "completed", completedAt: time })
			.where(eq(backgroundTasks.id, source.taskId))
			.run();
		const admission: LegacyCompletionAdmission = Object.freeze({
			...source,
			token: {},
			eventKind: "completed",
		});
		const store = createPublicationOutbox(database.db, {
			readLegacyCompletionAdmission: () => admission,
		});
		full(store);
		const first = store.registerLegacyCompletedRunSlots(source);
		if (first.status !== "registered") throw new Error(first.reason);
		expect(first.run.logicalRunId).toStartWith("legacy:completed:completed:");
		expect(store.registerLegacyCompletedRunSlots(source)).toEqual(first);
		expect(
			database.db
				.select({ status: backgroundTasks.status })
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, source.taskId))
				.get()?.status,
		).toBe("completed");
		expect(
			database.db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.filter((row) => row.logicalRunId === first.run.logicalRunId),
		).toHaveLength(1);
		expect(store.listPending()).toHaveLength(0);
		expect(() => store.reserveRunSlots(first.run)).toThrow("captured event slot");
		expect(() =>
			store.commitIntent({
				...first.run,
				eventKind: "failed",
				summary: "wrong",
				resultRef: "task:old",
			}),
		).toThrow("captured outcome");
		expect(
			store.commitIntent({
				...first.run,
				eventKind: "completed",
				summary: "done",
				resultRef: "task:old",
			}).status,
		).toBe("committed");
		store.transferNext("parent", "bash");
		expect(store.registerLegacyCompletedRunSlots(source)).toEqual(first);
		expect(
			store.commitIntent({
				...first.run,
				eventKind: "completed",
				summary: "retry",
				resultRef: "task:old",
			}).status,
		).toBe("duplicate");
	});
	test("terminal mismatches return explicit nonblocking reasons and never allocate a slot", () => {
		database.db
			.update(backgroundTasks)
			.set({ status: "failed", completedAt: time })
			.where(eq(backgroundTasks.id, source.taskId))
			.run();
		const token = {};
		let admission: LegacyCompletionAdmission | undefined;
		const store = createPublicationOutbox(database.db, {
			readLegacyCompletionAdmission: () => admission,
		});
		expect(store.registerLegacyCompletedRunSlots(source).status).toBe("unmigratable");
		admission = { ...source, token, eventKind: "completed" };
		expect(store.registerLegacyCompletedRunSlots(source)).toMatchObject({
			status: "unmigratable",
			reason: expect.stringContaining("outcome"),
		});
		admission = { ...admission, eventKind: "failed" };
		expect(store.registerLegacyCompletedRunSlots(source)).toMatchObject({
			status: "unmigratable",
			reason: expect.stringContaining("identity or outcome changed"),
		});
		admission = { ...source, token: {}, eventKind: "failed" };
		database.db
			.update(backgroundTasks)
			.set({ logicalRunId: "new-protocol-run" })
			.where(eq(backgroundTasks.id, source.taskId))
			.run();
		expect(store.registerLegacyCompletedRunSlots(source)).toMatchObject({
			status: "unmigratable",
			reason: expect.stringContaining("current logical run"),
		});
		database.db.delete(backgroundTasks).where(eq(backgroundTasks.id, source.taskId)).run();
		expect(store.registerLegacyCompletedRunSlots(source)).toMatchObject({
			status: "unmigratable",
			reason: expect.stringContaining("deleted"),
		});
		expect(database.db.select().from(runtimePublicationOutbox).all()).toHaveLength(0);
	});
	test("newly inserted terminal rows cannot use a forged old entry or refreshed factory watermark", () => {
		const store = createPublicationOutbox(database.db);
		const later = { ...source, taskId: "new-terminal" };
		task(later.taskId, { status: "completed", completedAt: time });
		const forged: LegacyCompletionAdmission = { ...later, token: {}, eventKind: "completed" };
		const second = createPublicationOutbox(database.db, {
			readLegacyCompletionAdmission: () => forged,
		});
		expect(store.registerLegacyCompletedRunSlots(later).status).toBe("unmigratable");
		expect(second.registerLegacyCompletedRunSlots(later)).toMatchObject({
			status: "unmigratable",
			reason: expect.stringContaining("protocol activation"),
		});
		expect(database.db.select().from(runtimePublicationOutbox).all()).toHaveLength(0);
	});
	test("captured agent completion without task row validates durable background outcome", () => {
		const agent: LegacyPublicationSource = {
			producerKind: "agent",
			taskId: "old-agent",
			recipientId: "parent",
		};
		database.db
			.update(narrators)
			.set({ status: "idle", backgroundStatus: "completed", backgroundCompletedAt: time })
			.where(eq(narrators.id, agent.taskId))
			.run();
		const store = createPublicationOutbox(database.db, {
			readLegacyCompletionAdmission: () => ({ ...agent, token: agent, eventKind: "completed" }),
		});
		const result = store.registerLegacyCompletedRunSlots(agent);
		expect(result.status).toBe("registered");
		database.db
			.update(narrators)
			.set({ logicalRunId: "new-agent-run", status: "working" })
			.where(eq(narrators.id, agent.taskId))
			.run();
		expect(store.registerLegacyCompletedRunSlots(agent).status).toBe("unmigratable");
	});
	test("full quota accepts a genuinely admitted old runtime, but not a new task or new protocol run", () => {
		const store = publisher();
		full(store);
		const run = store.registerLegacyRunningRunSlots(source, { kind: "runtime" });
		expect(run.logicalRunId.startsWith("legacy:")).toBe(true);
		expect(
			database.db
				.select({ seq: narrators.inboxSequence })
				.from(narrators)
				.where(eq(narrators.id, "parent"))
				.get()?.seq,
		).toBe(0);
		expect(store.listPending()).toHaveLength(0);
		expect(
			store.reserveRunSlots({ ...run, taskId: "new-normal", logicalRunId: "new-run" }).status,
		).toBe("full");
		// Even a backdated row plus a fake old timestamp in a runtime reader cannot cross the rowid fence.
		task("newly-inserted");
		admissions.set("newly-inserted", {
			...source,
			taskId: "newly-inserted",
			startedAtMs: Date.parse(time),
		});
		expect(() =>
			store.registerLegacyRunningRunSlots(
				{ ...source, taskId: "newly-inserted" },
				{ kind: "runtime" },
			),
		).toThrow("before legacy");
		expect(() =>
			publisher().registerLegacyRunningRunSlots(
				{ ...source, taskId: "newly-inserted" },
				{ kind: "runtime" },
			),
		).toThrow("before legacy");
		database.db
			.update(backgroundTasks)
			.set({ logicalRunId: "new-protocol" })
			.where(eq(backgroundTasks.id, source.taskId))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(source, { kind: "runtime" })).toThrow(
			"new-protocol",
		);
	});
	test("legacy slots, source logical identity, terminal result and intent share a caller transaction", () => {
		const store = publisher();
		full(store);
		expect(() =>
			database.db.transaction((tx) => {
				const run = store.registerLegacyRunningRunSlots(source, { kind: "runtime" }, {}, tx);
				tx.update(backgroundTasks)
					.set({ status: "completed", output: "result" })
					.where(eq(backgroundTasks.id, source.taskId))
					.run();
				store.commitIntent(
					{ ...run, eventKind: "completed", resultRef: "task:old-bash", summary: "done" },
					tx,
				);
				throw new Error("rollback all");
			}),
		).toThrow("rollback all");
		expect(
			database.db
				.select({ run: backgroundTasks.logicalRunId, state: backgroundTasks.status })
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, source.taskId))
				.get(),
		).toEqual({ run: null, state: "running" });
		expect(store.listPending()).toHaveLength(0);
		database.db.transaction((tx) => {
			const run = store.registerLegacyRunningRunSlots(source, { kind: "runtime" }, {}, tx);
			tx.update(backgroundTasks)
				.set({ status: "completed", output: "result" })
				.where(eq(backgroundTasks.id, source.taskId))
				.run();
			expect(
				store.commitIntent(
					{ ...run, eventKind: "completed", resultRef: "task:old-bash", summary: "done" },
					tx,
				).status,
			).toBe("committed");
		});
		expect(
			database.db
				.select({ result: backgroundTasks.output })
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, source.taskId))
				.get()?.result,
		).toBe("result");
		expect(store.listPending()).toHaveLength(1);
	});
	test("recovery retains the durable old run and does not reserve twice", () => {
		const store = publisher();
		const first = store.registerLegacyRunningRunSlots(
			source,
			{ kind: "runtime" },
			{ started: true },
		);
		admissions.clear();
		// Execution-owner timestamps may advance on recovery without creating a new logical run.
		database.db
			.update(backgroundTasks)
			.set({ startedAt: new Date(Date.now() + 1000).toISOString() })
			.where(eq(backgroundTasks.id, source.taskId))
			.run();
		const recovered = createPublicationOutbox(database.db).registerLegacyRunningRunSlots(
			source,
			{ kind: "runtime" },
			{ started: true },
		);
		expect(recovered).toEqual(first);
		expect(database.db.select().from(runtimePublicationOutbox).all()).toHaveLength(2);
		expect(
			store.commitIntent({
				...first,
				eventKind: "completed",
				resultRef: "task:old-bash",
				summary: "done",
			}).status,
		).toBe("committed");
		expect(
			store.commitIntent({
				...recovered,
				eventKind: "completed",
				resultRef: "task:old-bash",
				summary: "done",
			}).status,
		).toBe("duplicate");
	});
	test("source CAS rejects a stale admission observation and rolls back all writes", () => {
		const store = createPublicationOutbox(database.db, {
			readLegacyRuntimeAdmission: () => {
				database.db
					.update(backgroundTasks)
					.set({ logicalRunId: "competing-new-run" })
					.where(eq(backgroundTasks.id, source.taskId))
					.run();
				return admissions.get(source.taskId);
			},
		});
		expect(() => store.registerLegacyRunningRunSlots(source, { kind: "runtime" })).toThrow(
			"changed before registration",
		);
		expect(
			database.db
				.select({ run: backgroundTasks.logicalRunId })
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, source.taskId))
				.get()?.run,
		).toBeNull();
		expect(database.db.select().from(runtimePublicationOutbox).all()).toHaveLength(0);
	});
	test("forged identity, wrong recipient, missing runtime and current terminal sources are refused", () => {
		const store = publisher();
		expect(() =>
			store.registerLegacyRunningRunSlots(
				{ ...source, taskId: "nonexistent" },
				{ kind: "runtime" },
			),
		).toThrow("does not exist");
		expect(() =>
			store.registerLegacyRunningRunSlots({ ...source, recipientId: "other" }, { kind: "runtime" }),
		).toThrow("does not match");
		expect(() =>
			store.registerLegacyRunningRunSlots(
				{ ...source, producerKind: "agent" },
				{ kind: "runtime" },
			),
		).toThrow("does not match");
		admissions.clear();
		expect(() => store.registerLegacyRunningRunSlots(source, { kind: "runtime" })).toThrow(
			"verified pre-existing",
		);
		database.db
			.update(backgroundTasks)
			.set({ status: "completed" })
			.where(eq(backgroundTasks.id, source.taskId))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(source, { kind: "persisted_task" })).toThrow(
			"running state",
		);
		expect(database.db.select().from(runtimePublicationOutbox).all()).toHaveLength(0);
	});
	test("persisted_task requires an exact started execution receipt, not merely an old running row", () => {
		const store = publisher();
		admissions.clear();
		expect(() =>
			store.registerLegacyRunningRunSlots(
				{ ...source, taskId: "unbound" },
				{ kind: "persisted_task" },
			),
		).toThrow("verifiable execution receipt");
		database.db
			.update(narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(narratorToolCalls.id, "bash-tool"))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(source, { kind: "persisted_task" })).toThrow(
			"receipt does not match",
		);
		database.db
			.update(narratorToolCalls)
			.set({ executionAttempt: 1, executionStartedAt: null })
			.where(eq(narratorToolCalls.id, "bash-tool"))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(source, { kind: "persisted_task" })).toThrow(
			"receipt does not match",
		);
		database.db
			.update(narratorToolCalls)
			.set({ executionStartedAt: time })
			.where(eq(narratorToolCalls.id, "bash-tool"))
			.run();
		expect(
			store.registerLegacyRunningRunSlots(source, { kind: "persisted_task" }).logicalRunId,
		).toStartWith("legacy:");
	});
	test("ordinary restart permits idle agent only with a still-running task and a verified original receipt", () => {
		task("old-agent", { type: "agent", subagentNarratorId: "old-agent" });
		const store = publisher();
		admissions.clear();
		const agent: LegacyPublicationSource = {
			producerKind: "agent",
			taskId: "old-agent",
			recipientId: "parent",
		};
		database.db
			.update(narrators)
			.set({ status: "idle" })
			.where(eq(narrators.id, agent.taskId))
			.run();
		database.db
			.update(narratorToolCalls)
			.set({ executionIdentityVersion: 0 })
			.where(eq(narratorToolCalls.id, "agent-tool"))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" })).toThrow(
			"receipt does not match",
		);
		database.db
			.update(narratorToolCalls)
			.set({ executionIdentityVersion: 1 })
			.where(eq(narratorToolCalls.id, "agent-tool"))
			.run();
		const run = store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" });
		expect(run.logicalRunId).toStartWith("legacy:");
		expect(
			database.db
				.select({ state: narrators.status })
				.from(narrators)
				.where(eq(narrators.id, agent.taskId))
				.get()?.state,
		).toBe("idle");
	});
	test("an old idle foreground receipt alone cannot manufacture a running admission", () => {
		const store = publisher();
		admissions.clear();
		const agent: LegacyPublicationSource = {
			producerKind: "agent",
			taskId: "old-agent",
			recipientId: "parent",
		};
		database.db
			.update(narrators)
			.set({ status: "idle" })
			.where(eq(narrators.id, agent.taskId))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" })).toThrow(
			"running state",
		);
		expect(() => store.registerLegacyRunningRunSlots(agent, { kind: "runtime" })).toThrow(
			"verified pre-existing",
		);
		expect(database.db.select().from(runtimePublicationOutbox).all()).toHaveLength(0);
	});
	test("old agent derives only its immutable original receipt and updates both source run records", () => {
		task("old-agent", { type: "agent", subagentNarratorId: "old-agent" });
		const store = publisher();
		admissions.clear();
		const agent: LegacyPublicationSource = {
			producerKind: "agent",
			taskId: "old-agent",
			recipientId: "parent",
		};
		database.db
			.update(narratorToolCalls)
			.set({ executionAttempt: 2, executionStartedAt: "2026-09-08T01:00:00.000Z" })
			.where(eq(narratorToolCalls.id, "agent-tool"))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" })).toThrow(
			"receipt does not match",
		);
		database.db
			.update(narratorToolCalls)
			.set({
				executionAttempt: 1,
				executionStartedAt: time,
				executionOriginToolCallId: "another-origin",
			})
			.where(eq(narratorToolCalls.id, "agent-tool"))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" })).toThrow(
			"receipt does not match",
		);
		database.db
			.update(narratorToolCalls)
			.set({ executionOriginToolCallId: null, isFileHistoryCheckpoint: true })
			.where(eq(narratorToolCalls.id, "agent-tool"))
			.run();
		expect(() => store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" })).toThrow(
			"receipt does not match",
		);
		database.db
			.update(narratorToolCalls)
			.set({ isFileHistoryCheckpoint: false })
			.where(eq(narratorToolCalls.id, "agent-tool"))
			.run();
		const run = store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" });
		expect(
			database.db
				.select({ run: narrators.logicalRunId })
				.from(narrators)
				.where(eq(narrators.id, agent.taskId))
				.get()?.run,
		).toBe(run.logicalRunId);
		expect(
			database.db
				.select({ run: backgroundTasks.logicalRunId })
				.from(backgroundTasks)
				.where(eq(backgroundTasks.id, agent.taskId))
				.get()?.run,
		).toBe(run.logicalRunId);
		expect(store.registerLegacyRunningRunSlots(agent, { kind: "persisted_task" })).toEqual(run);
		expect(database.db.select().from(runtimePublicationOutbox).all()).toHaveLength(1);
	});
	test("actual update checkpoint authorizes idle foreground recovery; fake epoch and archived source cannot", () => {
		const store = publisher();
		const agent: LegacyPublicationSource = {
			producerKind: "agent",
			taskId: "old-agent",
			recipientId: "parent",
		};
		database.db
			.update(narrators)
			.set({ status: "idle" })
			.where(eq(narrators.id, agent.taskId))
			.run();
		expect(() =>
			store.registerLegacyRunningRunSlots(agent, {
				kind: "checkpoint",
				checkpointId: "agent-checkpoint",
				updateEpoch: "forged",
			}),
		).toThrow("checkpoint does not authorize");
		const run = store.registerLegacyRunningRunSlots(agent, {
			kind: "checkpoint",
			checkpointId: "agent-checkpoint",
			updateEpoch: "old-update",
		});
		expect(
			database.db
				.select({ run: narrators.logicalRunId })
				.from(narrators)
				.where(eq(narrators.id, agent.taskId))
				.get()?.run,
		).toBe(run.logicalRunId);
		database.db
			.update(narrators)
			.set({ status: "archived" })
			.where(eq(narrators.id, agent.taskId))
			.run();
		expect(() =>
			store.registerLegacyRunningRunSlots(agent, {
				kind: "checkpoint",
				checkpointId: "agent-checkpoint",
				updateEpoch: "old-update",
			}),
		).toThrow("running state");
	});
	test("unbound old Bash has only an explicit unknown-failure publication path, never success or rerun", () => {
		const store = publisher();
		full(store);
		admissions.clear();
		const unbound = { ...source, taskId: "unbound" };
		const run = store.registerLegacyUnknownBashFailure(unbound);
		expect(run.logicalRunId).toStartWith("legacy:unknown:");
		expect(store.registerLegacyUnknownBashFailure(unbound)).toEqual(run);
		expect(() => store.reserveRunSlots(run)).toThrow("failure slot");
		for (const eventKind of ["completed", "started"] as const)
			expect(() =>
				store.commitIntent({
					...run,
					eventKind,
					summary: "invented success",
					resultRef: "task:unbound",
				}),
			).toThrow("only publish failed");
		expect(() => store.registerLegacyRunningRunSlots(unbound, { kind: "runtime" })).toThrow(
			"only publish failure",
		);
		database.db.transaction((tx) => {
			tx.update(backgroundTasks)
				.set({ status: "failed", output: LEGACY_UNKNOWN_BASH_FAILURE_SUMMARY })
				.where(eq(backgroundTasks.id, unbound.taskId))
				.run();
			expect(
				store.commitIntent(
					{
						...run,
						eventKind: "failed",
						summary: "caller text cannot claim success",
						resultRef: "task:unbound",
					},
					tx,
				).status,
			).toBe("committed");
		});
		expect(store.listPending()).toHaveLength(1);
		expect(
			database.db
				.select({ summary: runtimePublicationOutbox.summary })
				.from(runtimePublicationOutbox)
				.where(eq(runtimePublicationOutbox.logicalRunId, run.logicalRunId))
				.get()?.summary,
		).toBe(LEGACY_UNKNOWN_BASH_FAILURE_SUMMARY);
		expect(() => store.registerLegacyUnknownBashFailure(source)).toThrow("Bound legacy");
	});
});
