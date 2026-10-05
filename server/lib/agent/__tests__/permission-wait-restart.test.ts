/**
 * A permission request awaiting a human must not hold a planned update hostage.
 *
 * `executeTool` takes an irrevocable start grant BEFORE calling `permissionHandler`, and that
 * handler suspends on a promise with no deadline — by design, since only the user can settle it.
 * The checkpoint fence, however, is stable only while `toolStartGrants` is empty
 * (`checkpointFenceIsStable`), so an unanswered permission request blocks the restart for as long
 * as nobody is looking at the screen. That is the whole point of this suite.
 *
 * What must NOT be "fixed" by aborting the wait: the tool row is already durably `pending` and the
 * checkpoint persists it as a `pending_permission` continuation, so the request survives the
 * restart and is re-offered with its input intact. Cancelling it to unblock the fence would throw
 * away a decision the user is in the middle of making.
 *
 * That durability is the PRECONDITION for releasing the grant, so it is asserted rather than
 * assumed: the checkpoint runs for real here, against a real continuation store, at the moment the
 * grant is dropped. Stubbing `toolContinuationService.upsert` (as this suite first did) made the
 * safety argument in the comment untestable — the fence went stable either way, and a change that
 * released the grant BEFORE the request became discoverable would still have passed.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ ...realDbModule, db, sqlite }));
afterAll(() => {
	mock.module("../../../db", () => realDbModule);
});

const { toolContinuationService } = await import("@server/services/tool-continuation-service");
// Initialize the service facade first, matching application import order.
await import("@server/services/narrator-service");
const { narratorPersistence } = await import("@server/services/narrator-persistence");
const updateCoordinator = await import("@server/services/update-coordinator");
const { checkpointPlannedUpdateContinuations } = await import(
	"@server/services/update-recovery-service"
);
const { z } = await import("zod");
const { executeTool } = await import("../tool-executor");
const { toolRegistry } = await import("../tool-registry");
type AgentConfig = import("../types").AgentConfig;
type AgentToolUse = import("../types").AgentToolUse;

const PERMISSION_TOOL_NAME = "__PermissionWaitRestartTest";
const NARRATOR_ID = "narrator-self";
const TOOL_USE_ID = "permission-wait";
const TOOL_CALL_ID = "tool-permission-wait";

/**
 * The durable state `handlePermission` has already written by the time it calls
 * `onAwaitingUserDecision`: a `pending` row carrying the input the user is looking at.
 */
async function seedPendingPermissionRow(): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: NARRATOR_ID,
		variant: "primary",
		status: "working",
		createdAt: now,
		updatedAt: now,
	});
	const messageId = `${NARRATOR_ID}-message`;
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: NARRATOR_ID,
		role: "assistant",
		contentJson: [
			{ type: "tool_use", id: TOOL_USE_ID, name: PERMISSION_TOOL_NAME, input: { answer: "42" } },
		],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `${messageId}-ref`,
		narratorId: NARRATOR_ID,
		messageId,
		seq: 1,
	});
	await db.insert(narratorToolCalls).values({
		id: TOOL_CALL_ID,
		executionAttempt: 1,
		executionIdentityVersion: 1,
		narratorId: NARRATOR_ID,
		messageId,
		toolUseId: TOOL_USE_ID,
		toolName: PERMISSION_TOOL_NAME,
		status: "pending",
		inputJson: { answer: "42" },
		createdAt: now,
	});
}

function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
	return (async () => {
		const deadline = Date.now() + 2_000;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
	})();
}

describe("permission wait does not block a planned restart", () => {
	test("an unanswered permission request leaves the checkpoint fence stable", async () => {
		cleanDb(sqlite);
		updateCoordinator.resetUpdateCoordinationForTests();
		await seedPendingPermissionRow();

		let executions = 0;
		toolRegistry.register({
			name: PERMISSION_TOOL_NAME,
			description: "waits for a human decision",
			parameters: z.object({ answer: z.literal("42") }),
			execute: async () => {
				executions++;
				return { output: "executed after approval" };
			},
		});

		let permissionAsked = false;
		let releaseDecision: (() => void) | undefined;
		const decided = new Promise<void>((resolve) => {
			releaseDecision = resolve;
		});
		const approve = async () => {
			// A human decision authorizes one exact durable attempt before waking it.
			// Resolving the Promise alone is not the production approval receipt.
			const approved = await db
				.update(narratorToolCalls)
				.set({
					status: "running",
					permissionDecidedBy: "user",
					permissionDecidedAt: new Date().toISOString(),
					permissionDecisionReason: "Human approved the bound restart-wait fixture",
				})
				.where(
					and(
						eq(narratorToolCalls.id, TOOL_CALL_ID),
						eq(narratorToolCalls.narratorId, NARRATOR_ID),
						eq(narratorToolCalls.toolUseId, TOOL_USE_ID),
						eq(narratorToolCalls.executionAttempt, 1),
						eq(narratorToolCalls.status, "pending"),
						isNull(narratorToolCalls.executionStartedAt),
					),
				)
				.returning({ id: narratorToolCalls.id });
			expect(approved).toEqual([{ id: TOOL_CALL_ID }]);
			releaseDecision?.();
		};
		const abortController = new AbortController();
		/**
		 * The tool row as it stood at the instant the grant was released.
		 *
		 * Held in an object rather than a `let`: assignment happens inside the permission
		 * callback, which TypeScript's control-flow analysis does not follow, so a plain
		 * variable stays narrowed to `null` and the assertion below cannot be written.
		 */
		const observed: { row: { status: string; inputJson: unknown } | null } = { row: null };
		// Production binds the exact tool-use object to its persisted execution attempt.
		// A seeded row alone cannot authorize deferred execution after the update fence.
		const toolUse: AgentToolUse = {
			toolUseId: TOOL_USE_ID,
			name: PERMISSION_TOOL_NAME,
			input: { answer: "42" },
		};
		const config: AgentConfig = {
			requireToolCallBinding: true,
			toolExecutionBindings: new WeakMap([[toolUse, { toolCallId: TOOL_CALL_ID, attempt: 1 }]]),
			onToolExecutionStarting: (toolUseId, binding, startedAt) =>
				narratorPersistence.claimToolCallExecution(NARRATOR_ID, toolUseId, binding, startedAt),
			narratorId: NARRATOR_ID,
			conversationId: "conversation-test",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd: "/tmp",
			signal: abortController.signal,
			// Mirrors handlePermission: the row is already `pending` and the request registered
			// before the grant is dropped, then the wait suspends with no deadline.
			permissionHandler: async (_name, _input, _toolUseId, options) => {
				const row = await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, TOOL_CALL_ID),
				});
				observed.row = row ? { status: row.status, inputJson: row.inputJson } : null;
				options?.onAwaitingUserDecision?.();
				permissionAsked = true;
				await decided;
				return { behavior: "allow" as const };
			},
		};

		try {
			const running = executeTool(toolUse, config);
			await waitForCondition(() => permissionAsked, "the permission request to be raised");

			// The precondition for dropping the grant, checked at the moment it is dropped:
			// releasing it earlier — before the row is `pending` and discoverable — would leave a
			// restart seeing neither an in-flight tool nor a recoverable request.
			expect(observed.row).toEqual({ status: "pending", inputJson: { answer: "42" } });

			updateCoordinator.scheduleUpdate("9.9.9");
			updateCoordinator.beginQuiescingTools();

			// An unanswered permission request must not stall the restart: the fence has to be
			// stable and the ordinary drain must complete while the user is still deciding.
			expect(updateCoordinator.checkpointFenceIsStableForTests()).toBe(true);
			await updateCoordinator.waitForOrdinaryToolDrain();

			// And the restart really would carry the request across: a real checkpoint, against
			// the real continuation store, writes it as a recoverable `pending_permission`. This
			// is what the stubbed version could not show — the fence went stable either way.
			const unregisterLoop = updateCoordinator.registerNarratorLoop(NARRATOR_ID, "en");
			try {
				const snapshot = await checkpointPlannedUpdateContinuations();
				const covered = await toolContinuationService.listByEpoch(snapshot.updateEpoch);
				expect(covered).toHaveLength(1);
				expect(covered[0]).toMatchObject({
					toolCallId: TOOL_CALL_ID,
					narratorId: NARRATOR_ID,
					kind: "pending_permission",
					state: "waiting",
				});
			} finally {
				unregisterLoop();
			}

			// And the pending decision is still pending — never auto-denied to unblock the update.
			expect(executions).toBe(0);

			// Approving mid-restart must not start the tool against a server about to be replaced:
			// re-admission holds it behind the gate instead of half-executing it.
			await approve();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(executions).toBe(0);

			// Once the update is abandoned the gate reopens and the approved tool proceeds.
			updateCoordinator.failScheduledUpdate("test abandoned the update");
			const result = await running;
			expect(result.output).toBe("executed after approval");
			expect(executions).toBe(1);
		} finally {
			abortController.abort();
			releaseDecision?.();
			toolRegistry.unregister?.(PERMISSION_TOOL_NAME);
			updateCoordinator.resetUpdateCoordinationForTests();
		}
	});
});
