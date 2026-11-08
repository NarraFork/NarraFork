/**
 * The exact text a subagent's result reaches its caller with, on every delivery path of the run
 * service (`agent-runtime/run.ts`): the foreground tool result, a background task's result, the
 * conclusion rewrite of a call no task projects, and a held result released with no live run.
 *
 * Pinned before outline P2 PR 9a added report attachment to that shared path: a subagent sent
 * without `task` (every spec session, and most outline delegations) must get its result byte for
 * byte as before. Only the model pass is scripted; the run service, the publication, the task
 * projection and the conclusion rewrite are real.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import * as websocket from "../../websocket/narrator-ws";
import { getExecutionOwner, getRunControl, setRunHold } from "../agent-runtime/ownership";
import { controlRun, startNarratorRun } from "../agent-runtime/run";
import * as completionQueue from "../bg-completion-queue";
import * as passExecutor from "../narrator-executor";
import { activeNarrators } from "../narrator-session-state";
import { drainPendingInjections } from "../parent-injection-queue";
import { clearAliasRegistry } from "../subagent-alias";
import { runSubagent } from "../subagent-runner";

const MODEL = "anthropic:claude-sonnet-4-20250514";
const originalProviders = settings.anthropicProviders;
const originalDefaultModel = settings.agent.defaultModel;
const originalAllowedModels = settings.agent.subagentAllowedModels;
const ids: string[] = [];
const restores: Array<() => void> = [];
let parentId: string;
/** What the scripted model passes return, in order (a reply may wait on a gate, or fail). */
let replies: Array<string | { text: string; hasError?: boolean; gate?: Promise<void> }> = [];

const runEnded = (id: string) => !getExecutionOwner(id) && !getRunControl(id);

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await Bun.sleep(5);
	}
}

beforeEach(async () => {
	parentId = generateId();
	ids.push(parentId);
	replies = [];
	settings.anthropicProviders = [
		{
			id: "pin-test",
			name: "Test provider (no network)",
			prefix: "anthropic",
			apiKey: "not-a-real-key",
			baseUrl: "https://pin-test.invalid",
			defaultModel: "claude-sonnet-4-20250514",
		},
	];
	settings.agent.defaultModel = MODEL;
	settings.agent.subagentAllowedModels = { general: [MODEL], explore: [], plan: [] };
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: parentId,
		type: "primary",
		variant: "primary",
		status: "working",
		model: MODEL,
		cwd: process.env.HOME,
		createdAt: now,
		updatedAt: now,
	});
	const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation(() => {});
	const wake = spyOn(completionQueue, "pushBgCompletionNotification").mockImplementation(() => {});
	const network = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() => {
				throw new Error("Real model/network access is forbidden here");
			},
			{ preconnect: () => {} },
		),
	);
	const execute = spyOn(passExecutor, "executeAgentLoop").mockImplementation(async (options) => {
		const id = options.config.narratorId as string;
		if (!ids.includes(id)) ids.push(id);
		const next = replies.shift() ?? "(scripted)";
		const reply = typeof next === "string" ? { text: next } : next;
		await reply.gate;
		return {
			finalText: reply.text,
			hasError: reply.hasError === true,
			shouldUpdateTitle: false,
			completedNaturally: true,
			completedAssistantTurn: true,
		};
	});
	restores.push(
		() => broadcast.mockRestore(),
		() => wake.mockRestore(),
		() => network.mockRestore(),
		() => execute.mockRestore(),
	);
});

afterEach(async () => {
	for (const id of ids) if (!runEnded(id)) await until(() => runEnded(id)).catch(() => {});
	for (const restore of restores.splice(0).reverse()) restore();
	settings.anthropicProviders = originalProviders;
	settings.agent.defaultModel = originalDefaultModel;
	settings.agent.subagentAllowedModels = originalAllowedModels;
	for (const id of ids) {
		setRunHold(id, undefined);
		drainPendingInjections(id);
		clearAliasRegistry(id);
		activeNarrators.delete(id);
	}
	if (ids.length) {
		await db.delete(backgroundTasks).where(inArray(backgroundTasks.id, ids));
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, ids));
		await db
			.delete(fileChangeExecutionSegments)
			.where(inArray(fileChangeExecutionSegments.narratorId, ids));
		await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
		await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
		for (const id of [...ids].reverse()) await db.delete(narrators).where(eq(narrators.id, id));
	}
	ids.length = 0;
});

/** A durable receipt for the parent's Agent call, as the live tool executor records it. */
async function agentCall() {
	const now = new Date().toISOString();
	const toolUseId = generateId();
	const callId = generateId();
	const segmentId = generateId();
	const messageId = generateId();
	await db.insert(fileChangeExecutionSegments).values({
		id: segmentId,
		narratorId: parentId,
		sourceToolCallId: callId,
		sourceExecutionAttempt: 1,
		createdAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: parentId,
		role: "assistant",
		contentJson: [],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: parentId, messageId, seq: 1 });
	await db.insert(narratorToolCalls).values({
		id: callId,
		messageId,
		narratorId: parentId,
		toolUseId,
		toolName: "Agent",
		inputJson: {},
		status: "running",
		executionStartedAt: now,
		executionAttempt: 1,
		executionIdentityVersion: 1,
		executionSegmentId: segmentId,
		createdAt: now,
	});
	return { toolUseId, binding: { toolCallId: callId, attempt: 1, executionSegmentId: segmentId } };
}

async function launch(background: boolean, signal = new AbortController().signal) {
	const call = await agentCall();
	const output = await runSubagent({
		parentNarratorId: parentId,
		toolUseId: call.toolUseId,
		toolCallBinding: call.binding,
		subagentType: "general",
		prompt: "Look into the refresh race",
		cwd: process.env.HOME as string,
		title: "Pin run",
		alias: "pin-run",
		model: MODEL,
		locale: "en",
		signal,
		background,
		userId: null,
	});
	const child = await db.query.narrators.findFirst({
		where: eq(narrators.originToolCallId, call.binding.toolCallId),
	});
	if (!child) throw new Error("no child");
	if (!ids.includes(child.id)) ids.push(child.id);
	return { output, childId: child.id, call };
}

const toolOutput = async (callId: string) =>
	(await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, callId) }))
		?.outputJson;

describe("subagent result text without task (pinned)", () => {
	test("foreground: the tool result", async () => {
		replies = ["The race is in refresh().\n\n- evidence: auth.ts:42"];
		const { output } = await launch(false);
		expect(output).toBe(
			"<subagent_id>pin-run</subagent_id>\n\nThe race is in refresh().\n\n- evidence: auth.ts:42",
		);
	});

	test("background: the task's result and the session's background result", async () => {
		replies = ["Background answer."];
		const { output, childId } = await launch(true);
		expect(output).toBe(
			'<background_task_id>pin-run</background_task_id>\n\nBackground task started. Await({ type: "agent", id: "pin-run" })',
		);
		await until(() => runEnded(childId));
		await until(
			async () =>
				(await db.query.backgroundTasks.findFirst({ where: eq(backgroundTasks.id, childId) }))
					?.status === "completed",
		);
		const task = await db.query.backgroundTasks.findFirst({
			where: eq(backgroundTasks.id, childId),
		});
		expect(task?.output).toBe("Background answer.");
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
		expect(row?.backgroundResult).toBe("Background answer.");
	});

	test("a later run whose destination holds no result yet: the conclusion rewrite", async () => {
		replies = ["first", "second answer"];
		const { childId, call } = await launch(false);
		await until(() => runEnded(childId));
		const handle = await startNarratorRun({ narratorId: childId, locale: "en", text: "again" });
		expect(handle.started).toBe(true);
		await handle.terminal;
		await until(() => runEnded(childId));
		expect(await toolOutput(call.binding.toolCallId)).toBe(
			"<subagent_id>pin-run</subagent_id>\n\nsecond answer",
		);
	});

	test("a failed run: the foreground tool result, and a background task's failure", async () => {
		replies = [{ text: "Model refused the request.", hasError: true }];
		const fg = await launch(false);
		expect(fg.output).toBe("<subagent_id>pin-run</subagent_id>\n\nModel refused the request.");
		replies = [{ text: "Provider error: overloaded", hasError: true }];
		const { childId } = await launch(true);
		await until(() => runEnded(childId));
		await until(
			async () =>
				(await db.query.backgroundTasks.findFirst({ where: eq(backgroundTasks.id, childId) }))
					?.status === "failed",
		);
		const task = await db.query.backgroundTasks.findFirst({
			where: eq(backgroundTasks.id, childId),
		});
		expect(task?.output).toBe("Provider error: overloaded");
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
		expect(row?.backgroundResult).toBe("Provider error: overloaded");
	});

	test("a cancelled run: the caller's interrupt in the foreground, a Stop in the background", async () => {
		const caller = new AbortController();
		const first = Promise.withResolvers<void>();
		replies = [{ text: "", gate: first.promise }];
		const pending = launch(false, caller.signal);
		await until(async () => ids.length > 1 && !!getRunControl(ids.at(-1) as string));
		caller.abort("Caller interrupted in test");
		first.resolve();
		const fg = await pending;
		expect(fg.output).toBe(
			"<subagent_id>pin-run</subagent_id>\n\nInterrupted: Caller interrupted in test",
		);
		const second = Promise.withResolvers<void>();
		replies = [{ text: "", gate: second.promise }];
		const { childId } = await launch(true);
		await until(() => !!getRunControl(childId));
		expect(await controlRun(childId, { kind: "cancel", reason: "Stopped in test" })).toBe(true);
		second.resolve();
		await until(() => runEnded(childId));
		await until(
			async () =>
				(await db.query.backgroundTasks.findFirst({ where: eq(backgroundTasks.id, childId) }))
					?.status === "cancelled",
		);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, childId) });
		expect(row?.backgroundResult).toBe("Interrupted: Stopped in test");
	});

	test("a held result released with no live run: delivered as the conclusion", async () => {
		replies = ["first"];
		const { childId, call } = await launch(false);
		await until(() => runEnded(childId));
		setRunHold(childId, { released: false });
		expect(await controlRun(childId, { kind: "release" })).toBe(true);
		// The session has no assistant message of its own (the pass is scripted).
		expect(await toolOutput(call.binding.toolCallId)).toBe(
			"<subagent_id>pin-run</subagent_id>\n\n(no output)",
		);
	});
});
