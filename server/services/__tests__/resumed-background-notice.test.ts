/**
 * resumed-background-notice.test.ts — a session the USER continued by hand, whose run
 * still delivers to a caller's tool call, reaches that caller.
 *
 * The continued run ends through the single run finalizer. With no live task row the
 * finalizer rewrites the destination tool call's conclusion AND commits the caller's
 * notice in the same transaction — the rewrite alone is only read on the caller's NEXT
 * turn, and an idle caller has no next turn: nothing would wake it.
 *
 * These contracts fail silently in production:
 *
 *   - not delivering        → an idle caller never acts on the new result
 *   - omitting the result   → readers and the current turn cannot see what finished
 *   - delivering too early  → the woken turn is built from the SUPERSEDED tool result
 *   - waking after a stop   → a turn is spent on work the user just interrupted
 *
 * Nothing here is specific to how the session was created: the destination is the
 * run's registered `deliverTo`.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { type ProviderAdapter, registerExternalProviderResolver } from "../../lib/agent/provider";
import { runtimePublication } from "../agent-runtime/publication";
import { runAtomicWrite } from "../agent-runtime/runtime-write";
import {
	backgroundAgentNoticePreview,
	formatBackgroundCompletionNotifications,
} from "../bg-completion-queue";
import * as passExecutor from "../narrator-executor";
import { closePrefixSnapshotStore } from "../narrator-prefix-snapshots";
import { projectPendingInjection } from "../parent-injection-queue";

const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Notice test must never call a model");
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
let unregisterProvider: () => void = () => {};
beforeAll(() => {
	unregisterProvider = registerExternalProviderResolver({
		resolve: (name) => (name === "noticetest" ? provider : null),
		listReadiness: () => [],
	});
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	unregisterProvider();
});

describe("the run finalizer is the only notice producer", () => {
	it("no started intent or separate announcer exists outside the finalizer", async () => {
		const runner = await Bun.file(new URL("../subagent-runner.ts", import.meta.url)).text();
		expect(runner).not.toContain('eventKind: "started"');
		expect(runner).not.toContain("announceResumedBackgroundTask");
		expect(runner).not.toContain("pushBgCompletionNotification(");
	});

	/**
	 * ORDER, invisible when wrong: the notice must commit with the conclusion rewrite,
	 * never before it, or the woken turn is built from the superseded tool result.
	 */
	it("the detached delivery commits the notice inside the conclusion transaction", async () => {
		const source = await Bun.file(new URL("../agent-runtime/run.ts", import.meta.url)).text();
		const start = source.indexOf("async function deliverDetachedResult(");
		const end = source.indexOf("// === Control ===", start);
		const body = source.slice(start, end);
		const conclusion = body.indexOf("await updateToolCallConclusion(");
		const onPersist = body.indexOf("onPersist: (tx)", conclusion);
		expect(conclusion).toBeGreaterThan(-1);
		expect(onPersist).toBeGreaterThan(conclusion);
		expect(body.indexOf("runtimePublication.commit(", onPersist)).toBeGreaterThan(onPersist);
	});
});

async function seedDestination(time: string) {
	db.insert(narrators)
		.values([
			{ id: "notice-parent", createdAt: time, updatedAt: time },
			{
				id: "notice-child",
				parentNarratorId: "notice-parent",
				type: "subagent",
				variant: "subagent:general",
				model: "noticetest:model",
				cwd: process.env.HOME,
				autoContinuationOverride: "off",
				originToolCallId: "notice-agent-call",
				createdAt: time,
				updatedAt: time,
			},
		])
		.run();
	db.insert(narratorMessages)
		.values({
			id: "notice-agent-message",
			narratorId: "notice-parent",
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: "notice-agent-ref",
			narratorId: "notice-parent",
			messageId: "notice-agent-message",
			seq: 1,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "notice-agent-call",
			narratorId: "notice-parent",
			messageId: "notice-agent-message",
			toolUseId: "notice-origin",
			toolName: "Agent",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "success",
			outputJson: "PREVIOUS RUN RESULT",
			createdAt: time,
		})
		.run();
}

describe("a user-continued run delivers its own result once", () => {
	for (const [status, result] of [
		["completed", "本轮复核结果：滚动位置正确"],
		["cancelled", "取消时已完成的结果"],
		["completed", ""],
		["completed", "x".repeat(12001)],
	] as const) {
		it(`projects this run's ${result.length}-character result and ${status === "completed" ? "wakes once" : "does not wake after stop"}`, async () => {
			await closePrefixSnapshotStore();
			cleanDb(sqlite);
			runtimePublication.stop();
			let wakes = 0;
			runtimePublication.setWake(() => {
				wakes++;
			});
			const time = new Date().toISOString();
			await seedDestination(time);
			// Seed a previous run so the projection cannot accidentally use its output.
			runAtomicWrite(db, "test.seedPreviousResult", (tx) =>
				runtimePublication.persistResult(
					{
						producerKind: "agent",
						taskId: "notice-child",
						recipientId: "notice-parent",
						logicalRunId: "previous-notice-run",
					},
					"OLD RESULT",
					tx,
				),
			);
			const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(
				async ({ config }) => {
					if (status === "cancelled") config.signal.dispatchEvent(new Event("abort"));
					const now = new Date().toISOString();
					db.insert(narratorMessages)
						.values({
							id: "notice-child-answer",
							narratorId: "notice-child",
							role: "assistant",
							contentJson: [{ type: "text", text: result }],
							contentText: result,
							createdAt: now,
						})
						.run();
					return {
						finalText: result,
						hasError: false,
						shouldUpdateTitle: false,
						completedNaturally: status === "completed",
						completedAssistantTurn: status === "completed",
					};
				},
			);
			try {
				const { startNarratorRun, controlRun } = await import("../agent-runtime/run");
				// The user continues the session from its own page: a NEW run that still
				// owes its result to the registered destination.
				const handle = await startNarratorRun({
					narratorId: "notice-child",
					locale: "en",
					text: "continue",
					principal: null,
					binding: {
						deliverTo: {
							narratorId: "notice-parent",
							toolUseId: "notice-origin",
							toolCallId: "notice-agent-call",
						},
					},
				});
				expect(handle.started).toBe(true);
				if (status === "cancelled")
					await controlRun("notice-child", { kind: "cancel", reason: "Stopped by user" });
				await handle.terminal;
				runtimePublication.flushRecipient("notice-parent");
				runtimePublication.flushRecipient("notice-parent");
				const rows = db
					.select()
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.narratorId, "notice-parent"))
					.all();
				expect(rows).toHaveLength(1);
				if (result) expect(rows[0].text).not.toContain(result);
				const projected = projectPendingInjection(rows[0]);
				expect(projected.kind).toBe("bg_agent");
				if (projected.kind !== "bg_agent") throw new Error("Expected task notice projection");
				// An empty final text is reported as the finalizer's "(no output)".
				const boundedResult = result.slice(0, 12000) || "(no output)";
				if (status === "completed") {
					expect(projected.task.result ?? "").toBe(boundedResult);
					expect(projected.task.resultTruncated ?? false).toBe(result.length > 12000);
					expect(backgroundAgentNoticePreview(projected.task, "zh-CN")).toBe(
						projected.task.result ?? backgroundAgentNoticePreview(projected.task, "zh-CN"),
					);
				}
				const formatted = formatBackgroundCompletionNotifications([projected.task]);
				expect(formatted).not.toContain("OLD RESULT");
				if (result.length > 12000) {
					expect(formatted).toContain("truncated");
					expect(formatted).toContain("Await(");
				}
				// The destination's conclusion is this run's, not the superseded one.
				const call = db
					.select()
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.id, "notice-agent-call"))
					.get();
				expect(JSON.stringify(call?.outputJson)).not.toContain("PREVIOUS RUN RESULT");
				expect(wakes).toBe(status === "completed" ? 1 : 0);
			} finally {
				execute.mockRestore();
				runtimePublication.setWake(undefined);
				await closePrefixSnapshotStore();
				cleanDb(sqlite);
			}
		});
	}
});
