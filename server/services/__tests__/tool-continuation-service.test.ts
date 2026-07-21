import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { toolContinuationService } = await import("../tool-continuation-service");

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
	createdAt?: string;
}): Promise<void> {
	await db.insert(narratorToolCalls).values({
		...input,
		toolName: input.toolName ?? "Bash",
		inputJson: input.inputJson,
		status: "running",
		createdAt: input.createdAt ?? NOW,
	});
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("tool continuation claims", () => {
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

		await expect(
			toolContinuationService.upsert({
				toolCallId: "tc1",
				narratorId: "n1",
				updateEpoch: "epoch-b",
				kind: "await_agent",
				state: "waiting",
			}),
		).rejects.toThrow("active claim is resuming");

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

describe("tool continuation recovery ordering and epoch isolation", () => {
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
