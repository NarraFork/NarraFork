import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	fileChangeOperations,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../../db/schema";
import {
	captureWorkerRejection,
	captureWorkerRejectionThrower,
	getNarratorWorkerTestDb,
} from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { toolContinuationService } = await import("../tool-continuation-service");
const {
	registerRecoverySource,
	reserveRecoveryHandoff,
	bindRecoveryHandoffEpoch,
	releaseRecoveryHandoff,
	resetRecoveryHandoffForTests,
	beginRecoveryDiscovery,
	finishRecoveryDiscovery,
	invalidateRecoveryTarget,
	getRegisteredRecoverySource,
} = await import("../recovery-handoff");

function registerSource(updateEpoch: string) {
	return registerRecoverySource({
		updateEpoch,
		kind: "planned",
		capturedAt: NOW,
		narrators: [{ narratorId: "n1", locale: "en" }],
		pendingNarratorIds: ["n1"],
	});
}

const NOW = "2026-07-20T12:00:00.000Z";
const EXPIRED = "2026-07-20T12:01:00.000Z";
const RECLAIMED_UNTIL = "2099-07-20T12:10:00.000Z";

async function seedNarrator(id: string): Promise<void> {
	await db.insert(narrators).values({ id, createdAt: NOW, updatedAt: NOW });
}

async function seedMessage(
	id: string,
	narratorId: string,
	toolUseIds: string[],
	createdAt = NOW,
): Promise<void> {
	await db.insert(narratorMessages).values({
		id,
		narratorId,
		role: "assistant",
		contentJson: toolUseIds.map((toolUseId) => ({
			type: "tool_use",
			id: toolUseId,
			name: "Bash",
			input: {},
		})),
		createdAt,
	});
}

async function seedToolCall(input: {
	id: string;
	narratorId: string;
	messageId: string;
	toolUseId: string;
	toolName?: string;
	inputJson?: Record<string, unknown>;
	executionAttempt?: number;
	createdAt?: string;
}): Promise<void> {
	await db.insert(narratorToolCalls).values({
		...input,
		toolName: input.toolName ?? "Bash",
		inputJson: input.inputJson,
		status: "running",
		executionAttempt: input.executionAttempt ?? 1,
		executionIdentityVersion: 1,
		createdAt: input.createdAt ?? NOW,
	});
}

beforeEach(() => {
	cleanDb(sqlite);
	resetRecoveryHandoffForTests();
});

afterAll(async () => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	await fixture.close();
});

async function ordinaryFixture() {
	await seedNarrator("n1");
	await db
		.update(narrators)
		.set({ status: "working", logicalRunId: "owner-run" })
		.where(eq(narrators.id, "n1"));
	await seedMessage("m1", "n1", ["u1"]);
	await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
	await toolContinuationService.create({
		toolCallId: "tc1",
		narratorId: "n1",
		updateEpoch: "old-planned",
		kind: "pending_permission",
		state: "waiting",
	});
	await toolContinuationService.claim("tc1", {
		claimToken: "dead-owner",
		deadlineAt: RECLAIMED_UNTIL,
	});
	beginRecoveryDiscovery();
	registerRecoverySource({
		updateEpoch: "ordinary",
		kind: "ordinary",
		capturedAt: NOW,
		narrators: [{ narratorId: "n1", locale: "en" }],
		pendingNarratorIds: ["n1"],
		logicalRuns: [{ narratorId: "n1", logicalRunId: "owner-run" }],
	});
	return {
		toolCallId: "tc1",
		narratorId: "n1",
		updateEpoch: "ordinary",
		kind: "pending_permission" as const,
	};
}

const ordinaryPass = () =>
	toolContinuationService.beginOrdinaryColdAdoptionPass({
		rootEpoch: "ordinary",
		toolCallId: "tc1",
	});

// Native settlement avoids Bun's reused-Worker `.rejects` matcher stall.
describe("ordinary single-record cold adoption", () => {
	test("fresh ordinary authority adopts an unstarted approval without registering the old planned epoch", async () => {
		const input = await ordinaryFixture();
		const pass = await ordinaryPass();
		expect(getRegisteredRecoverySource("old-planned")).toBeUndefined();
		expect(await captureWorkerRejectionThrower(toolContinuationService.upsert(input))).toThrow();
		expect(
			await toolContinuationService.controlledOrdinaryColdAdoption(input, pass.authorization),
		).toMatchObject({
			updateEpoch: "ordinary",
			state: "waiting",
			claimToken: null,
			payloadJson: { executionAttempt: 1 },
		});
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.controlledOrdinaryColdAdoption(input, pass.authorization),
			),
		).toThrow("single-record");
	});

	test("unregistered roots, planned roots, no lock, hot handoffs, closed passes and forged booleans never authorize adoption", async () => {
		const input = await ordinaryFixture();
		const original = await toolContinuationService.getByToolCallId("tc1");
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.beginOrdinaryColdAdoptionPass({
					rootEpoch: "missing",
					toolCallId: "tc1",
				}),
			),
		).toThrow("registered ordinary");
		registerSource("planned");
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.beginOrdinaryColdAdoptionPass({
					rootEpoch: "planned",
					toolCallId: "tc1",
				}),
			),
		).toThrow("registered ordinary");
		const prior = process.env.NARRAFORK_ALLOW_MULTIPLE;
		process.env.NARRAFORK_ALLOW_MULTIPLE = "1";
		try {
			expect(await captureWorkerRejectionThrower(ordinaryPass())).toThrow("exclusive instance");
		} finally {
			if (prior === undefined) delete process.env.NARRAFORK_ALLOW_MULTIPLE;
			else process.env.NARRAFORK_ALLOW_MULTIPLE = prior;
		}
		const pass = await ordinaryPass();
		pass.close();
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.controlledOrdinaryColdAdoption(input, pass.authorization),
			),
		).toThrow("single-record");
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.controlledOrdinaryColdAdoption(
					input,
					true as unknown as typeof pass.authorization,
				),
			),
		).toThrow("single-record");
		const hotPass = await ordinaryPass();
		finishRecoveryDiscovery();
		const ticket = reserveRecoveryHandoff();
		try {
			expect(await captureWorkerRejectionThrower(ordinaryPass())).toThrow("discovery");
			expect(
				await captureWorkerRejectionThrower(
					toolContinuationService.controlledOrdinaryColdAdoption(input, hotPass.authorization),
				),
			).toThrow("discovery");
		} finally {
			releaseRecoveryHandoff(ticket);
			hotPass.close();
		}
		expect(await toolContinuationService.getByToolCallId("tc1")).toEqual(original);
	});

	for (const boundary of [
		"foreign-owner",
		"changed-run",
		"changed-attempt",
		"started",
		"file-change",
		"cancelled",
		"deleted",
		"owner-started",
		"user-interrupt",
		"manual-override",
		"invalidated",
	] as const) {
		test(`single-record receipt rejects ${boundary} without reviving the old row`, async () => {
			const input = await ordinaryFixture();
			const pass = await ordinaryPass();
			if (boundary === "foreign-owner") {
				await seedNarrator("foreign");
				await db
					.update(narratorToolCalls)
					.set({ narratorId: "foreign" })
					.where(eq(narratorToolCalls.id, "tc1"));
			} else if (boundary === "changed-run") {
				await db.update(narrators).set({ logicalRunId: "other-run" }).where(eq(narrators.id, "n1"));
			} else if (boundary === "changed-attempt") {
				await db
					.update(narratorToolCalls)
					.set({ executionAttempt: 2 })
					.where(eq(narratorToolCalls.id, "tc1"));
			} else if (boundary === "started") {
				await db
					.update(narratorToolCalls)
					.set({ executionStartedAt: NOW })
					.where(eq(narratorToolCalls.id, "tc1"));
			} else if (boundary === "file-change") {
				await db.insert(fileChangeOperations).values({
					id: "operation",
					sourceInstanceId: "old-instance",
					sourceKind: "tool",
					sourceId: "tc1",
					attempt: 1,
					actorSubjectKey: "n1",
					actorJson: {
						kind: "subagent",
						subjectKey: "n1",
						narratorId: "n1",
						userId: null,
						label: null,
						deleted: false,
						parentSubjectKey: null,
					},
					startedAt: NOW,
					updatedAt: NOW,
				});
				await db
					.update(narratorToolCalls)
					.set({ fileChangeOperationId: "operation" })
					.where(eq(narratorToolCalls.id, "tc1"));
			} else if (boundary === "cancelled") {
				await db
					.update(narratorToolContinuations)
					.set({ state: "cancelled" })
					.where(eq(narratorToolContinuations.toolCallId, "tc1"));
			} else if (boundary === "deleted") {
				await db
					.delete(narratorToolContinuations)
					.where(eq(narratorToolContinuations.toolCallId, "tc1"));
			} else if (boundary === "owner-started") {
				await db
					.update(narratorToolContinuations)
					.set({
						state: "completed",
						payloadJson: { executionAttempt: 1, recoveryPhase: "owner_continuation_started" },
					})
					.where(eq(narratorToolContinuations.toolCallId, "tc1"));
			} else if (boundary === "invalidated") {
				invalidateRecoveryTarget("n1");
			} else {
				await db
					.update(narrators)
					.set({
						status: "idle",
						substatus: JSON.stringify([
							boundary === "manual-override" ? "manual_override" : "cancelled",
						]),
					})
					.where(eq(narrators.id, "n1"));
			}
			const original = await toolContinuationService.getByToolCallId("tc1");
			try {
				if (["changed-attempt", "cancelled", "owner-started", "deleted"].includes(boundary)) {
					expect(
						await captureWorkerRejection(
							toolContinuationService.controlledOrdinaryColdAdoption(input, pass.authorization),
						),
					).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
				} else {
					expect(
						await toolContinuationService.controlledOrdinaryColdAdoption(input, pass.authorization),
					).toBeNull();
				}
			} finally {
				pass.close();
			}
			expect(await toolContinuationService.getByToolCallId("tc1")).toEqual(original);
		});
	}

	test("a cold Agent receipt reattaches exactly its selected existing child and logical run", async () => {
		await ordinaryFixture();
		await db
			.update(narratorToolCalls)
			.set({ toolName: "Agent", executionStartedAt: NOW })
			.where(eq(narratorToolCalls.id, "tc1"));
		await db.insert(narrators).values({
			id: "child",
			parentNarratorId: "n1",
			originToolCallId: "tc1",
			logicalRunId: "child-run",
			type: "subagent",
			status: "working",
			createdAt: NOW,
			updatedAt: NOW,
		});
		resetRecoveryHandoffForTests();
		beginRecoveryDiscovery();
		registerRecoverySource({
			updateEpoch: "ordinary",
			kind: "ordinary",
			capturedAt: NOW,
			narrators: [
				{ narratorId: "n1", locale: "en" },
				{ narratorId: "child", locale: "en" },
			],
			pendingNarratorIds: ["n1", "child"],
			logicalRuns: [
				{ narratorId: "n1", logicalRunId: "owner-run" },
				{ narratorId: "child", logicalRunId: "child-run" },
			],
		});
		const input = {
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "ordinary",
			kind: "foreground_agent" as const,
			payloadJson: { subagentId: "child", logicalRunId: "child-run" },
		};
		const pass = await ordinaryPass();
		try {
			expect(
				await toolContinuationService.controlledOrdinaryColdAdoption(
					{ ...input, payloadJson: { ...input.payloadJson, logicalRunId: "new-run" } },
					pass.authorization,
				),
			).toBeNull();
			expect(
				await captureWorkerRejectionThrower(
					toolContinuationService.controlledOrdinaryColdAdoption(
						{ ...input, toolCallId: "foreign" },
						pass.authorization,
					),
				),
			).toThrow("single-record");
			expect(
				await toolContinuationService.controlledOrdinaryColdAdoption(input, pass.authorization),
			).toMatchObject({
				updateEpoch: "ordinary",
				kind: "foreground_agent",
				claimToken: null,
				payloadJson: input.payloadJson,
			});
		} finally {
			pass.close();
		}
		expect(await db.select({ id: narrators.id }).from(narrators)).toHaveLength(2);
	});

	test("a saved result is carried verbatim rather than replayed or cleared", async () => {
		const input = await ordinaryFixture();
		await db
			.update(narratorToolCalls)
			.set({ status: "success", executionStartedAt: NOW, outputJson: "durable result" })
			.where(eq(narratorToolCalls.id, "tc1"));
		await toolContinuationService.complete("tc1", {
			claimToken: "dead-owner",
			payloadJson: {
				executionAttempt: 1,
				recoveryPhase: "tool_result_written",
				result: "durable result",
			},
		});
		const original = await toolContinuationService.getByToolCallId("tc1");
		const pass = await ordinaryPass();
		try {
			const adopted = await toolContinuationService.controlledOrdinaryColdAdoption(
				input,
				pass.authorization,
			);
			expect(adopted).toMatchObject({
				updateEpoch: "ordinary",
				state: "completed",
				claimToken: null,
				payloadJson: original?.payloadJson,
			});
		} finally {
			pass.close();
		}
	});
});

describe("tool continuation claims", () => {
	test("reserved carryover checkpoint and Send checkpoint leave claims and phases byte-for-byte unchanged", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({
			id: "tc1",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u1",
			toolName: "Send",
		});
		await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "send_await",
			state: "waiting",
			payloadJson: { requestId: "original" },
		});
		await toolContinuationService.claim("tc1", {
			claimToken: "old-owner",
			now: NOW,
			deadlineAt: RECLAIMED_UNTIL,
		});
		await toolContinuationService.markResultWritten("tc1", { claimToken: "old-owner" });
		const original = await toolContinuationService.getByToolCallId("tc1");
		if (!original) throw new Error("Missing carryover fixture");
		registerSource("old");
		const ticket = reserveRecoveryHandoff();
		bindRecoveryHandoffEpoch(ticket, "new");
		try {
			expect(
				await toolContinuationService.checkpoint({
					toolCallId: "tc1",
					narratorId: "n1",
					updateEpoch: "new",
					kind: "deferred_tool",
					payloadJson: { changed: true },
				}),
			).toEqual(original);
			expect(
				await toolContinuationService.checkpointSendAwait({
					toolCallId: "tc1",
					narratorId: "n1",
					updateEpoch: "new",
					payloadJson: { changed: true },
					deadlineAt: null,
				}),
			).toEqual(original);
			expect(
				(await toolContinuationService.listByEpoch(["new", "old"])).map((row) => row.toolCallId),
			).toEqual(["tc1"]);
			expect(await toolContinuationService.listByEpoch("new")).toEqual([]);
			expect(
				await captureWorkerRejectionThrower(
					toolContinuationService.upsert({
						toolCallId: "tc1",
						narratorId: "n1",
						updateEpoch: "old",
						kind: "send_await",
					}),
				),
			).toThrow("active claim");
		} finally {
			releaseRecoveryHandoff(ticket);
		}
		expect(await toolContinuationService.getByToolCallId("tc1")).toEqual(original);
	});

	test("cold receipt can reattach unstarted approval but never a started side effect or changed attempt", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		const input = {
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "pending_permission" as const,
			state: "waiting" as const,
		};
		await toolContinuationService.create(input);
		await toolContinuationService.claim("tc1", {
			claimToken: "dead-owner",
			now: NOW,
			deadlineAt: RECLAIMED_UNTIL,
		});
		registerSource("old");
		registerSource("new");
		const pass = toolContinuationService.beginColdRecoveryPass({
			rootEpoch: "new",
			sourceEpochs: ["old"],
			unstartedTools: [{ toolCallId: "tc1", executionAttempt: 1 }],
		});
		const evidence = { sourceEpoch: "old", executionAttempt: 1, authorization: pass.authorization };
		try {
			await db
				.update(narratorToolCalls)
				.set({ executionStartedAt: NOW })
				.where(eq(narratorToolCalls.id, "tc1"));
			expect(await toolContinuationService.controlledColdTakeover(input, evidence)).toBeNull();
			expect((await toolContinuationService.getByToolCallId("tc1"))?.claimToken).toBe("dead-owner");
			await db
				.update(narratorToolCalls)
				.set({ executionStartedAt: null, executionAttempt: 2 })
				.where(eq(narratorToolCalls.id, "tc1"));
			expect(await toolContinuationService.controlledColdTakeover(input, evidence)).toBeNull();
			await db
				.update(narratorToolCalls)
				.set({ executionAttempt: 1, status: "pending" })
				.where(eq(narratorToolCalls.id, "tc1"));
			expect(await toolContinuationService.controlledColdTakeover(input, evidence)).toMatchObject({
				updateEpoch: "old",
				state: "waiting",
				claimToken: null,
			});
		} finally {
			pass.close();
		}
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.controlledColdTakeover(input, evidence),
			),
		).toThrow("live authorized");
	});

	test("cold started Agent reattaches only its durable child and logical run", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({
			id: "tc1",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u1",
			toolName: "Agent",
		});
		await db
			.update(narratorToolCalls)
			.set({ executionStartedAt: NOW })
			.where(eq(narratorToolCalls.id, "tc1"));
		await db.insert(narrators).values({
			id: "child",
			parentNarratorId: "n1",
			originToolCallId: "tc1",
			logicalRunId: "child-run",
			type: "subagent",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "pending_permission",
			state: "waiting",
		});
		await toolContinuationService.claim("tc1", {
			claimToken: "dead-owner",
			now: NOW,
			deadlineAt: RECLAIMED_UNTIL,
		});
		registerSource("old");
		const pass = toolContinuationService.beginColdRecoveryPass({
			rootEpoch: "old",
			sourceEpochs: [],
			unstartedTools: [],
		});
		const input = {
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "foreground_agent" as const,
		};
		const evidence = {
			sourceEpoch: "old",
			executionAttempt: 1,
			authorization: pass.authorization,
			subagentId: "child",
			logicalRunId: "child-run",
		};
		try {
			expect(
				await toolContinuationService.controlledColdReattachAgent(input, {
					...evidence,
					logicalRunId: "wrong",
				}),
			).toBeNull();
			expect((await toolContinuationService.getByToolCallId("tc1"))?.claimToken).toBe("dead-owner");
			expect(
				await toolContinuationService.controlledColdReattachAgent(input, evidence),
			).toMatchObject({
				updateEpoch: "old",
				kind: "foreground_agent",
				state: "waiting",
				claimToken: null,
				payloadJson: { subagentId: "child", logicalRunId: "child-run" },
			});
		} finally {
			pass.close();
		}
	});

	test("a stale epoch cannot claim, renew, complete or deliver a different recovery owner", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "current",
			kind: "deferred_tool",
			state: "waiting",
		});
		expect(
			await toolContinuationService.claim("tc1", {
				updateEpoch: "old",
				claimToken: "owner",
				deadlineAt: RECLAIMED_UNTIL,
			}),
		).toBeNull();
		await toolContinuationService.claim("tc1", {
			updateEpoch: "current",
			claimToken: "owner",
			deadlineAt: RECLAIMED_UNTIL,
		});
		const original = await toolContinuationService.getByToolCallId("tc1");
		expect(
			await toolContinuationService.renewClaim("tc1", {
				updateEpoch: "old",
				claimToken: "owner",
				deadlineAt: RECLAIMED_UNTIL,
			}),
		).toBeNull();
		expect(
			await toolContinuationService.complete("tc1", { updateEpoch: "old", claimToken: "owner" }),
		).toBeNull();
		expect(
			await toolContinuationService.markResultWritten("tc1", {
				updateEpoch: "old",
				claimToken: "owner",
			}),
		).toBeNull();
		expect(await toolContinuationService.getByToolCallId("tc1")).toEqual(original);
	});

	test("cold authorization rejects forged handles, missing lock and a hot handoff", async () => {
		registerSource("old");
		const prior = process.env.NARRAFORK_ALLOW_MULTIPLE;
		process.env.NARRAFORK_ALLOW_MULTIPLE = "1";
		try {
			expect(() =>
				toolContinuationService.beginColdRecoveryPass({
					rootEpoch: "old",
					sourceEpochs: [],
					unstartedTools: [],
				}),
			).toThrow("exclusive instance");
		} finally {
			if (prior === undefined) delete process.env.NARRAFORK_ALLOW_MULTIPLE;
			else process.env.NARRAFORK_ALLOW_MULTIPLE = prior;
		}
		const ticket = reserveRecoveryHandoff();
		try {
			expect(() =>
				toolContinuationService.beginColdRecoveryPass({
					rootEpoch: "old",
					sourceEpochs: [],
					unstartedTools: [],
				}),
			).toThrow("non-reserved");
		} finally {
			releaseRecoveryHandoff(ticket);
		}
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.controlledColdTakeover(
					{ toolCallId: "tc1", narratorId: "n1", updateEpoch: "old", kind: "deferred_tool" },
					{
						sourceEpoch: "old",
						executionAttempt: 1,
						authorization: {} as Parameters<
							typeof toolContinuationService.controlledColdTakeover
						>[1]["authorization"],
					},
				),
			),
		).toThrow("live authorized");
	});

	test("a real retry uses a new tool PK and leaves already-delivered history intact", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		const historical = await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "deferred_tool",
			state: "completed",
			payloadJson: { recoveryPhase: "owner_continuation_started" },
		});
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.upsert({
					toolCallId: "tc1",
					narratorId: "n1",
					updateEpoch: "new",
					kind: "deferred_tool",
				}),
			),
		).toThrow("epoch");
		await seedToolCall({
			id: "tc2",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u1",
			executionAttempt: 2,
		});
		expect(
			await toolContinuationService.checkpoint({
				toolCallId: "tc2",
				narratorId: "n1",
				updateEpoch: "new",
				kind: "deferred_tool",
			}),
		).toMatchObject({
			toolCallId: "tc2",
			updateEpoch: "new",
			state: "paused",
			payloadJson: { executionAttempt: 2 },
		});
		expect(await toolContinuationService.getByToolCallId("tc1")).toEqual(historical);
	});
	test("ordinary upsert rejects a waiting row from another epoch without changing it", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		const original = await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "pending_permission",
			state: "waiting",
			payloadJson: { permissionGranted: false },
			deadlineAt: RECLAIMED_UNTIL,
		});
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.upsert({
					toolCallId: "tc1",
					narratorId: "n1",
					updateEpoch: "new",
					kind: "deferred_tool",
					payloadJson: { permissionGranted: true },
				}),
			),
		).toThrow("epoch");
		expect(await toolContinuationService.getByToolCallId("tc1")).toEqual(original);
	});

	test("Send checkpoint cannot migrate an old waiting row without a reserved ticket", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({
			id: "tc1",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u1",
			toolName: "Send",
		});
		const original = await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "send_await",
			state: "waiting",
			payloadJson: { requestId: "original" },
			deadlineAt: RECLAIMED_UNTIL,
		});
		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.checkpointSendAwait({
					toolCallId: "tc1",
					narratorId: "n1",
					updateEpoch: "new",
					payloadJson: {},
					deadlineAt: null,
				}),
			),
		).toThrow("epoch");
		expect(await toolContinuationService.getByToolCallId("tc1")).toEqual(original);
	});
	test("upsert CAS does not overwrite or clear an unexpired resuming claim", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "epoch-a",
			kind: "foreground_agent",
			state: "waiting",
		});
		await toolContinuationService.claim("tc1", {
			claimToken: "claim-a",
			now: NOW,
			deadlineAt: RECLAIMED_UNTIL,
		});

		expect(
			await captureWorkerRejectionThrower(
				toolContinuationService.upsert({
					toolCallId: "tc1",
					narratorId: "n1",
					updateEpoch: "epoch-b",
					kind: "await_agent",
					state: "waiting",
				}),
			),
		).toThrow("active claim is resuming");

		const current = await toolContinuationService.getByToolCallId("tc1");
		expect(current).toMatchObject({
			updateEpoch: "epoch-a",
			kind: "foreground_agent",
			state: "resuming",
			claimToken: "claim-a",
			deadlineAt: RECLAIMED_UNTIL,
		});
	});

	test("crash reclaim marks non-idempotent work execution_unknown but reclaims Agent", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-deferred", "u-agent"]);
		await seedToolCall({
			id: "tc-deferred",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-deferred",
		});
		await seedToolCall({
			id: "tc-agent",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-agent",
		});
		await toolContinuationService.create({
			toolCallId: "tc-deferred",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "deferred_tool",
			state: "waiting",
		});
		await toolContinuationService.create({
			toolCallId: "tc-agent",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "foreground_agent",
			state: "waiting",
			payloadJson: { subagentId: "child" },
		});
		await toolContinuationService.claim("tc-deferred", {
			claimToken: "dead-deferred",
			now: NOW,
			deadlineAt: EXPIRED,
		});
		await toolContinuationService.claim("tc-agent", {
			claimToken: "dead-agent",
			now: NOW,
			deadlineAt: EXPIRED,
		});

		expect(
			await toolContinuationService.claim("tc-deferred", {
				claimToken: "retry-deferred",
				now: "2026-07-20T12:02:00.000Z",
				deadlineAt: RECLAIMED_UNTIL,
			}),
		).toBeNull();
		const unknown = await toolContinuationService.markExecutionUnknown("tc-deferred", {
			claimToken: "dead-deferred",
			now: "2026-07-20T12:02:00.000Z",
			errorMessage: "deterministic recovery error",
			payloadJson: { recoveryStatus: "execution_unknown" },
		});
		expect(unknown).toMatchObject({
			state: "failed",
			claimToken: null,
			errorMessage: "deterministic recovery error",
			payloadJson: { recoveryStatus: "execution_unknown" },
		});
		const finalized = await toolContinuationService.finalizeRecoveryFailure("tc-deferred", {
			errorMessage: "deterministic recovery error",
			payloadJson: { recoveryStatus: "execution_unknown", toolErrorWritten: true },
		});
		expect(finalized?.payloadJson).toEqual({
			recoveryStatus: "execution_unknown",
			toolErrorWritten: true,
		});
		expect(
			await toolContinuationService.claim("tc-deferred", {
				claimToken: "second-retry",
				now: "2026-07-20T12:03:00.000Z",
				deadlineAt: RECLAIMED_UNTIL,
			}),
		).toBeNull();

		const reclaimedAgent = await toolContinuationService.claim("tc-agent", {
			claimToken: "retry-agent",
			now: "2026-07-20T12:02:00.000Z",
			deadlineAt: RECLAIMED_UNTIL,
		});
		expect(reclaimedAgent).toMatchObject({ state: "resuming", claimToken: "retry-agent" });
	});

	test("reclaims an expired Send await claim because waiting is idempotent", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-send"]);
		await seedToolCall({
			id: "tc-send",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-send",
			toolName: "Send",
			inputJson: { await: true, message: "already delivered" },
		});
		await toolContinuationService.create({
			toolCallId: "tc-send",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "send_await",
			state: "waiting",
		});
		await toolContinuationService.claim("tc-send", {
			claimToken: "dead-send-claim",
			now: NOW,
			deadlineAt: EXPIRED,
		});

		const reclaimed = await toolContinuationService.claim("tc-send", {
			claimToken: "new-send-claim",
			now: "2026-07-20T12:02:00.000Z",
			deadlineAt: RECLAIMED_UNTIL,
		});
		expect(reclaimed).toMatchObject({
			kind: "send_await",
			state: "resuming",
			claimToken: "new-send-claim",
		});
	});

	test("keeps a terminal Send ToolResult authoritative during a stale checkpoint write", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-send"]);
		await seedToolCall({
			id: "tc-send-terminal",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-send",
			toolName: "Send",
			inputJson: { await: true },
		});
		await toolContinuationService.create({
			toolCallId: "tc-send-terminal",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "send_await",
			state: "waiting",
			payloadJson: { sendAwait: { version: "old" } },
		});
		await db
			.update(narratorToolCalls)
			.set({
				status: "success",
				outputJson: { _text: "reply from old process" },
				completedAt: "2026-07-20T12:00:05.000Z",
			})
			.where(eq(narratorToolCalls.id, "tc-send-terminal"));

		const reconciled = await toolContinuationService.checkpointSendAwait({
			toolCallId: "tc-send-terminal",
			narratorId: "n1",
			updateEpoch: "epoch",
			deadlineAt: "2099-07-20T12:10:00.000Z",
			payloadJson: { sendAwait: { version: "stale-checkpoint" } },
		});

		expect(reconciled).toMatchObject({
			state: "completed",
			deadlineAt: null,
			claimToken: null,
		});
		expect(reconciled?.payloadJson).toMatchObject({
			sendAwait: { version: "old" },
			recoveryPhase: "result_written",
		});
		const toolCall = await toolContinuationService.getToolCallResult("tc-send-terminal");
		expect(toolCall).toMatchObject({
			status: "success",
			outputJson: { _text: "reply from old process" },
		});

		await toolContinuationService.markOwnerContinuationPendingForMessage("m1", "epoch");
		await toolContinuationService.markOwnerContinuationStartedForMessage("m1", "epoch");
		const afterDelivery = await toolContinuationService.checkpointSendAwait({
			toolCallId: "tc-send-terminal",
			narratorId: "n1",
			updateEpoch: "epoch",
			deadlineAt: null,
			payloadJson: { sendAwait: { version: "even-newer-stale-checkpoint" } },
		});
		expect(afterDelivery).toMatchObject({
			state: "completed",
			payloadJson: { recoveryPhase: "owner_continuation_started" },
		});
	});

	test("renews a claim only with the current claim token", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "await_agent",
			state: "waiting",
		});
		await toolContinuationService.claim("tc1", {
			claimToken: "claim-a",
			now: NOW,
			deadlineAt: EXPIRED,
		});

		expect(
			await toolContinuationService.renewClaim("tc1", {
				claimToken: "wrong-token",
				now: "2026-07-20T12:00:30.000Z",
				deadlineAt: RECLAIMED_UNTIL,
			}),
		).toBeNull();
		const renewed = await toolContinuationService.renewClaim("tc1", {
			claimToken: "claim-a",
			now: "2026-07-20T12:00:30.000Z",
			deadlineAt: RECLAIMED_UNTIL,
		});
		expect(renewed).toMatchObject({ claimToken: "claim-a", deadlineAt: RECLAIMED_UNTIL });
	});
});

describe("tool continuation interrupt scope", () => {
	test("cancels parent-bound recovery without cancelling background Agent work", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-foreground", "u-background", "u-send"]);
		await seedToolCall({
			id: "tc-foreground",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-foreground",
		});
		await seedToolCall({
			id: "tc-background",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-background",
		});
		await seedToolCall({
			id: "tc-send",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-send",
			toolName: "Send",
			inputJson: { await: true, message: "already delivered" },
		});
		await toolContinuationService.create({
			toolCallId: "tc-foreground",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "foreground_agent",
			state: "waiting",
		});
		await toolContinuationService.create({
			toolCallId: "tc-background",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "background_agent",
			state: "waiting",
		});
		await toolContinuationService.create({
			toolCallId: "tc-send",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "send_await",
			state: "waiting",
		});

		const cancelled = await toolContinuationService.cancelInterruptibleForNarrator(
			"n1",
			"epoch",
			"interrupted",
		);

		expect(cancelled.map((row) => row.toolCallId).sort()).toEqual(["tc-foreground", "tc-send"]);
		expect(await toolContinuationService.getByToolCallId("tc-foreground")).toMatchObject({
			state: "cancelled",
			errorMessage: "interrupted",
		});
		expect(await toolContinuationService.getByToolCallId("tc-send")).toMatchObject({
			state: "cancelled",
			errorMessage: "interrupted",
		});
		expect(await toolContinuationService.getByToolCallId("tc-background")).toMatchObject({
			state: "waiting",
		});

		const parentDeliveryCancelled = await toolContinuationService.cancelInterruptibleForNarrator(
			"n1",
			"epoch",
			{
				errorMessage: "parent delivery interrupted",
				includeBackgroundAgentOwner: true,
			},
		);
		expect(parentDeliveryCancelled.map((row) => row.toolCallId)).toEqual(["tc-background"]);
		expect(await toolContinuationService.getByToolCallId("tc-background")).toMatchObject({
			state: "cancelled",
			errorMessage: "parent delivery interrupted",
		});
	});

	test("an old interrupt token cannot cancel a continuation rebound to a newer recovery", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-send"]);
		await seedToolCall({
			id: "tc-token-send",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-send",
			toolName: "Send",
			inputJson: { await: true },
		});
		await toolContinuationService.create({
			toolCallId: "tc-token-send",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "send_await",
			state: "waiting",
		});
		await toolContinuationService.bindRecoveryTokenForNarrator("n1", "epoch", "old-token");
		await toolContinuationService.bindRecoveryTokenForNarrator("n1", "epoch", "new-token");

		const staleCancellation = await toolContinuationService.cancelInterruptibleForNarrator(
			"n1",
			"epoch",
			{ errorMessage: "stale interrupt", recoveryToken: "old-token" },
		);
		expect(staleCancellation).toEqual([]);
		expect(await toolContinuationService.getByToolCallId("tc-token-send")).toMatchObject({
			state: "waiting",
			payloadJson: { recoveryToken: "new-token" },
		});

		const currentCancellation = await toolContinuationService.cancelInterruptibleForNarrator(
			"n1",
			"epoch",
			{ errorMessage: "current interrupt", recoveryToken: "new-token" },
		);
		expect(currentCancellation.map((row) => row.toolCallId)).toEqual(["tc-token-send"]);
	});
});

describe("bounded continuation read races", () => {
	async function seedContinuations(count = 1, payloadBytes?: (index: number) => number) {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", []);
		const insertTool = sqlite.prepare(
			"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES (?, 'n1', 'm1', ?, 'Bash', 'running', ?)",
		);
		const insertRow = sqlite.prepare(
			"INSERT INTO narrator_tool_continuations (id, tool_call_id, narrator_id, update_epoch, kind, state, payload_json, created_at, updated_at) VALUES (?, ?, 'n1', ?, 'deferred_tool', 'completed', ?, ?, ?)",
		);
		try {
			sqlite.transaction(() => {
				for (let index = 0; index < count; index++) {
					const id = `tc-${index.toString().padStart(3, "0")}`;
					insertTool.run(id, id, NOW);
					insertRow.run(
						id,
						id,
						index % 2 ? "source" : "root",
						JSON.stringify({ data: "x".repeat((payloadBytes?.(index) ?? 11) - 11) }),
						NOW,
						NOW,
					);
				}
			})();
		} finally {
			insertTool.finalize();
			insertRow.finalize();
		}
	}

	// Keep every query real: write only after metadata has completed, immediately before
	// the payload SELECT is built. SQL byte guards must still reject any enlarged row.
	function beforePayloadRead(write: () => void) {
		const originalSelect = db.select.bind(db);
		return spyOn(db, "select").mockImplementation(((fields?: Parameters<typeof db.select>[0]) => {
			if (!fields || !("bytes" in fields)) write();
			return fields ? originalSelect(fields) : originalSelect();
		}) as typeof db.select);
	}

	const updatePayload = (payload: Record<string, unknown>, id = "tc-000") =>
		sqlite.run("UPDATE narrator_tool_continuations SET payload_json = ? WHERE id = ?", [
			JSON.stringify(payload),
			id,
		]);

	for (const reader of ["listByEpoch", "listRecoveryQueueByEpoch"] as const) {
		test(`${reader} restarts all metadata after legal recovery payload growth in a later page`, async () => {
			await seedContinuations(102);
			// An out-of-scope oversized row must never enter either the retry or its budget.
			sqlite.run(
				"UPDATE narrator_tool_continuations SET update_epoch = 'unrelated', payload_json = ? WHERE id = 'tc-001'",
				[JSON.stringify({ data: "x".repeat(65536) })],
			);
			const grownPayload = {
				executionAttempt: 1,
				recoveryToken: "startup-recovery-token",
				recoveryPhase: "owner_continuation_pending",
			};
			let payloadReads = 0;
			const select = beforePayloadRead(() => {
				if (++payloadReads === 2) updatePayload(grownPayload, "tc-101");
			});
			try {
				const rows = await toolContinuationService[reader](["root", "source"]);
				const records = rows.map((row) => ("record" in row ? row.record : row));
				expect(records).toHaveLength(101);
				expect(new Set(records.map((row) => row.id)).size).toBe(101);
				expect(records.find((row) => row.toolCallId === "tc-101")?.payloadJson).toEqual(
					grownPayload,
				);
				expect(records.every((row) => ["root", "source"].includes(row.updateEpoch))).toBe(true);
				expect(payloadReads).toBe(4);
				expect(select.mock.calls.map(([fields]) => !!fields && "bytes" in fields)).toEqual([
					true,
					true,
					false,
					false,
					true,
					true,
					false,
					false,
				]);
			} finally {
				select.mockRestore();
			}
		});

		test(`${reader} rejects oversized growth on fresh metadata without reading large fields`, async () => {
			await seedContinuations();
			const select = beforePayloadRead(() => updatePayload({ data: "x".repeat(65536) }));
			const payloadRead = spyOn(narratorToolContinuations.payloadJson, "mapFromDriverValue");
			const inputRead = spyOn(narratorToolCalls.inputJson, "mapFromDriverValue");
			const contentRead = spyOn(narratorMessages.contentJson, "mapFromDriverValue");
			try {
				expect(
					await captureWorkerRejectionThrower(toolContinuationService[reader](["root", "source"])),
				).toThrow("payload budget exceeded");
				expect(select.mock.calls.map(([fields]) => !!fields && "bytes" in fields)).toEqual([
					true,
					false,
					true,
				]);
				expect(payloadRead).not.toHaveBeenCalled();
				expect(inputRead).not.toHaveBeenCalled();
				expect(contentRead).not.toHaveBeenCalled();
			} finally {
				select.mockRestore();
				payloadRead.mockRestore();
				inputRead.mockRestore();
				contentRead.mockRestore();
			}
		});

		test(`${reader} rechecks the combined byte budget after growth`, async () => {
			// Payloads are 1216 bytes below 16 MiB, leaving room for the queue's tiny messages.
			await seedContinuations(257, (index) => (index === 0 ? 8000 : 65500));
			const select = beforePayloadRead(() =>
				updatePayload({ data: "x".repeat(7989), recoveryToken: "t".repeat(2048) }),
			);
			const payloadRead = spyOn(narratorToolContinuations.payloadJson, "mapFromDriverValue");
			try {
				expect(
					await captureWorkerRejectionThrower(toolContinuationService[reader](["root", "source"])),
				).toThrow("payload budget exceeded");
				// The first guarded batch can read only unchanged, already-budgeted rows.
				expect(
					payloadRead.mock.calls.every(([value]) => !String(value).includes("recoveryToken")),
				).toBe(true);
				expect(
					select.mock.calls.filter(([fields]) => !fields || !("bytes" in fields)),
				).toHaveLength(1);
				expect(select.mock.calls.filter(([fields]) => fields && "bytes" in fields)).toHaveLength(6);
			} finally {
				select.mockRestore();
				payloadRead.mockRestore();
			}
		});

		test(`${reader} fails after three attempts when recovery payload keeps growing`, async () => {
			await seedContinuations();
			let writes = 0;
			const select = beforePayloadRead(() => {
				updatePayload({ recoveryToken: "t".repeat(++writes), recoveryPhase: "result_written" });
			});
			try {
				expect(
					await captureWorkerRejectionThrower(toolContinuationService[reader](["root", "source"])),
				).toThrow("Continuation recovery scope changed during bounded read");
				expect(writes).toBe(3);
				expect(select.mock.calls.map(([fields]) => !!fields && "bytes" in fields)).toEqual([
					true,
					false,
					true,
					false,
					true,
					false,
				]);
			} finally {
				select.mockRestore();
			}
		});
	}
});

describe("tool continuation recovery ordering and epoch isolation", () => {
	test("a combined message waits for both epochs, preserves tool order, and writes each actual epoch", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-old", "u-new"]);
		for (const [id, epoch] of [
			["new", "root"],
			["old", "source"],
		] as const) {
			await seedToolCall({
				id: `tc-${id}`,
				narratorId: "n1",
				messageId: "m1",
				toolUseId: `u-${id}`,
			});
			await toolContinuationService.create({
				toolCallId: `tc-${id}`,
				narratorId: "n1",
				updateEpoch: epoch,
				kind: "deferred_tool",
				state: id === "old" ? "waiting" : "completed",
			});
		}
		const scope = ["root", "source"];
		expect(
			(await toolContinuationService.listRecoveryQueueByEpoch(scope)).map(
				(item) => item.record.toolCallId,
			),
		).toEqual(["tc-old", "tc-new"]);
		expect(
			await toolContinuationService.markOwnerContinuationPendingForMessage("m1", scope),
		).toBeNull();
		expect(await toolContinuationService.hasUnwrittenResultsForNarrator("n1", scope)).toBe(true);
		await toolContinuationService.claim("tc-old", {
			claimToken: "old-claim",
			now: NOW,
			deadlineAt: RECLAIMED_UNTIL,
		});
		await toolContinuationService.markResultWritten("tc-old", { claimToken: "old-claim" });
		expect(
			(await toolContinuationService.bindRecoveryTokenForNarrator("n1", scope, "root-token"))
				.length,
		).toBe(2);
		expect(
			(
				await toolContinuationService.markOwnerContinuationPendingForMessage(
					"m1",
					scope,
					"root-token",
				)
			)?.length,
		).toBe(2);
		expect(
			(
				await toolContinuationService.markOwnerContinuationStartedForMessage(
					"m1",
					scope,
					"root-token",
				)
			)?.length,
		).toBe(2);
		expect(await toolContinuationService.hasUnfinishedForMessage("m1", scope)).toBe(false);
		expect((await toolContinuationService.getByToolCallId("tc-old"))?.updateEpoch).toBe("source");
		expect((await toolContinuationService.getByToolCallId("tc-new"))?.updateEpoch).toBe("root");
	});

	test("already-mounted source history does not block a real retry's new owner token in the same message", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-retried"]);
		for (const id of ["old", "new"]) {
			await seedToolCall({
				id: `tc-${id}`,
				narratorId: "n1",
				messageId: "m1",
				toolUseId: "u-retried",
				executionAttempt: id === "old" ? 1 : 2,
			});
			await toolContinuationService.create({
				toolCallId: `tc-${id}`,
				narratorId: "n1",
				updateEpoch: id,
				kind: "deferred_tool",
				state: "completed",
				payloadJson:
					id === "old"
						? { recoveryPhase: "owner_continuation_started", recoveryToken: "old-token" }
						: {},
			});
		}
		const historical = await toolContinuationService.getByToolCallId("tc-old");
		const scope = ["old", "new"];
		expect(
			(await toolContinuationService.bindRecoveryTokenForNarrator("n1", scope, "new-token")).length,
		).toBe(1);
		expect(
			await toolContinuationService.markOwnerContinuationPendingForMessage(
				"m1",
				scope,
				"new-token",
			),
		).not.toBeNull();
		expect(
			await toolContinuationService.markOwnerContinuationStartedForMessage(
				"m1",
				scope,
				"new-token",
			),
		).not.toBeNull();
		expect(await toolContinuationService.getByToolCallId("tc-old")).toEqual(historical);
		expect(await toolContinuationService.hasUnfinishedForMessage("m1", scope)).toBe(false);
	});

	test("the 10000-row budget applies to the whole epoch union before payload loading", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", []);
		const insertTool = sqlite.prepare(
			"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES (?, 'n1', 'm1', ?, 'Bash', 'running', ?)",
		);
		const insertRow = sqlite.prepare(
			"INSERT INTO narrator_tool_continuations (id, tool_call_id, narrator_id, update_epoch, kind, state, created_at, updated_at) VALUES (?, ?, 'n1', ?, 'deferred_tool', 'waiting', ?, ?)",
		);
		sqlite.transaction(() => {
			for (let index = 0; index < 10001; index++) {
				const id = `tc-${index.toString().padStart(5, "0")}`;
				insertTool.run(id, id, NOW);
				insertRow.run(id, id, index < 5000 ? "root" : "source", NOW, NOW);
			}
		})();
		const select = spyOn(db, "select");
		try {
			expect(
				await captureWorkerRejectionThrower(
					toolContinuationService.listByEpoch(["root", "source"]),
				),
			).toThrow("10000-row");
			expect(select.mock.calls.every((args) => args[0] && "bytes" in args[0])).toBe(true);
			select.mockClear();
			expect(
				await captureWorkerRejectionThrower(
					toolContinuationService.listRecoveryQueueByEpoch(["root", "source"]),
				),
			).toThrow("10000-row");
			expect(select.mock.calls.every((args) => args[0] && "bytes" in args[0])).toBe(true);
		} finally {
			select.mockRestore();
		}
	});

	test("oversized legacy payload fails its per-row budget before materialization", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "old",
			kind: "deferred_tool",
		});
		await db
			.update(narratorToolContinuations)
			.set({ payloadJson: { data: "x".repeat(65536) } })
			.where(eq(narratorToolContinuations.toolCallId, "tc1"));
		const select = spyOn(db, "select");
		try {
			expect(
				await captureWorkerRejectionThrower(toolContinuationService.listByEpoch("old")),
			).toThrow("payload budget");
			expect(select.mock.calls.every((args) => args[0] && "bytes" in args[0])).toBe(true);
		} finally {
			select.mockRestore();
		}
	});

	test("combined payload budget is checked with metadata before loading payloads", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", []);
		const insertTool = sqlite.prepare(
			"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES (?, 'n1', 'm1', ?, 'Bash', 'running', ?)",
		);
		const insertRow = sqlite.prepare(
			"INSERT INTO narrator_tool_continuations (id, tool_call_id, narrator_id, update_epoch, kind, state, payload_json, created_at, updated_at) VALUES (?, ?, 'n1', ?, 'deferred_tool', 'waiting', ?, ?, ?)",
		);
		sqlite.transaction(() => {
			for (let index = 0; index < 280; index++) {
				const id = `tc-${index}`;
				insertTool.run(id, id, NOW);
				insertRow.run(
					id,
					id,
					index < 140 ? "root" : "source",
					JSON.stringify({ data: "x".repeat(63_000) }),
					NOW,
					NOW,
				);
			}
		})();
		const select = spyOn(db, "select");
		try {
			expect(
				await captureWorkerRejectionThrower(
					toolContinuationService.listByEpoch(["root", "source"]),
				),
			).toThrow("payload budget");
			expect(select.mock.calls.every((args) => args[0] && "bytes" in args[0])).toBe(true);
			select.mockClear();
			expect(
				await captureWorkerRejectionThrower(
					toolContinuationService.listRecoveryQueueByEpoch(["root", "source"]),
				),
			).toThrow("payload budget");
			expect(select.mock.calls.every((args) => args[0] && "bytes" in args[0])).toBe(true);
		} finally {
			select.mockRestore();
		}
	});
	test("protects an unfinished Send await tool call and its owner", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-send"]);
		await seedToolCall({
			id: "tc-send-protected",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-send",
			toolName: "Send",
			inputJson: { await: true, message: "already delivered" },
		});
		await toolContinuationService.create({
			toolCallId: "tc-send-protected",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "send_await",
			state: "waiting",
		});

		const protection = await toolContinuationService.getProtectionSets("epoch");
		expect(protection.toolCallIds).toEqual(new Set(["tc-send-protected"]));
		expect(protection.narratorIds).toEqual(new Set(["n1"]));
	});

	test("orders a message by original tool_use position instead of insertion order", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-second", "u-first"]);
		await seedToolCall({
			id: "tc-first",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-first",
			toolName: "Agent",
			inputJson: { prompt: "resume" },
			createdAt: "2026-07-20T12:00:00.000Z",
		});
		await seedToolCall({
			id: "tc-second",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-second",
			toolName: "Bash",
			inputJson: { command: "true", strict_serial: true },
			createdAt: "2026-07-20T12:00:01.000Z",
		});
		await toolContinuationService.create({
			toolCallId: "tc-first",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "deferred_tool",
		});
		await toolContinuationService.create({
			toolCallId: "tc-second",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "pending_permission",
		});

		const queue = await toolContinuationService.listRecoveryQueueByEpoch("epoch");
		expect(queue.map(({ record }) => record.toolCallId)).toEqual(["tc-second", "tc-first"]);
		expect(queue.map(({ toolUseOrder }) => toolUseOrder)).toEqual([0, 1]);
		expect(queue.map(({ toolName }) => toolName)).toEqual(["Bash", "Agent"]);
		expect(queue.map(({ input }) => input)).toEqual([
			{ command: "true", strict_serial: true },
			{ prompt: "resume" },
		]);
	});

	test("protects legacy completed rows until owner delivery is persisted", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-legacy", "u-mounted"]);
		await seedToolCall({
			id: "tc-legacy",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-legacy",
		});
		await seedToolCall({
			id: "tc-mounted",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "u-mounted",
		});
		await toolContinuationService.create({
			toolCallId: "tc-legacy",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "deferred_tool",
			state: "completed",
		});
		await toolContinuationService.create({
			toolCallId: "tc-mounted",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "deferred_tool",
			state: "completed",
			payloadJson: { recoveryPhase: "owner_continuation_started" },
		});

		const protection = await toolContinuationService.getProtectionSets("epoch");
		expect(protection.toolCallIds).toEqual(new Set(["tc-legacy"]));
		expect(protection.narratorIds).toEqual(new Set(["n1"]));
	});

	test("persists result-written, owner-pending, and owner-started delivery phases", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u1"]);
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "u1" });
		await toolContinuationService.create({
			toolCallId: "tc1",
			narratorId: "n1",
			updateEpoch: "epoch",
			kind: "deferred_tool",
			state: "waiting",
		});
		await toolContinuationService.claim("tc1", {
			claimToken: "claim",
			now: NOW,
			deadlineAt: RECLAIMED_UNTIL,
		});

		const resultWritten = await toolContinuationService.markResultWritten("tc1", {
			claimToken: "claim",
		});
		expect(resultWritten?.payloadJson?.recoveryPhase).toBe("result_written");
		expect(resultWritten?.state).toBe("resuming");

		const pending = await toolContinuationService.markOwnerContinuationPendingForMessage(
			"m1",
			"epoch",
		);
		expect(pending?.[0]?.payloadJson?.recoveryPhase).toBe("owner_continuation_pending");
		expect(await toolContinuationService.hasUnfinishedForMessage("m1", "epoch")).toBe(true);

		const started = await toolContinuationService.markOwnerContinuationStartedForMessage(
			"m1",
			"epoch",
		);
		expect(started?.[0]).toMatchObject({ state: "completed", claimToken: null });
		expect(started?.[0]?.payloadJson?.recoveryPhase).toBe("owner_continuation_started");
		expect(await toolContinuationService.hasUnfinishedForMessage("m1", "epoch")).toBe(false);
	});

	test("hasUnfinishedForMessage only considers the requested update epoch", async () => {
		await seedNarrator("n1");
		await seedMessage("m1", "n1", ["u-a", "u-b"]);
		await seedToolCall({ id: "tc-a", narratorId: "n1", messageId: "m1", toolUseId: "u-a" });
		await seedToolCall({ id: "tc-b", narratorId: "n1", messageId: "m1", toolUseId: "u-b" });
		await toolContinuationService.create({
			toolCallId: "tc-a",
			narratorId: "n1",
			updateEpoch: "epoch-a",
			kind: "deferred_tool",
			state: "waiting",
		});
		await toolContinuationService.create({
			toolCallId: "tc-b",
			narratorId: "n1",
			updateEpoch: "epoch-b",
			kind: "deferred_tool",
			state: "completed",
		});

		expect(await toolContinuationService.hasUnfinishedForMessage("m1", "epoch-a")).toBe(true);
		// A legacy completed row proves the tool result was written, not that owner continuation
		// was safely mounted; recovery must retry delivery before removing the manifest.
		expect(await toolContinuationService.hasUnfinishedForMessage("m1", "epoch-b")).toBe(true);
		expect(await toolContinuationService.hasUnfinishedForMessage("m1", "epoch-c")).toBe(false);

		const rows = await db.select().from(narratorToolContinuations);
		expect(rows).toHaveLength(2);
	});
});
