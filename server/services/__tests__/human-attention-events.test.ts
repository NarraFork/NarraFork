import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { NarraForkEvent } from "../../lib/event-bus";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { eventBus } = await import("../../lib/event-bus");
const { notifyHumanAttentionChanged } = await import("../human-attention-events");
const { pendingPermissions, pendingDangerReflections } = await import("../narrator-session-state");
const {
	createAsyncQuestion,
	withdrawAsyncQuestions,
	awaitAsyncQuestion,
	isAsyncQuestionAwaited,
	setQuestionServiceSeam,
} = await import("../narrator-question-service");
const {
	handlePermission,
	resolvePermission,
	reflectPendingAskUserQuestion,
	stopDangerReflectionLoop,
	cancelDangerReflection,
} = await import("../narrator-permission");
const {
	createTaskReflectionDecision,
	takeOverTaskReflection,
	confirmTaskReflection,
	cleanupTaskReflection,
	getTaskReflectionAwaitingUser,
	broadcastTaskReflectionProgress,
} = await import("../../lib/agent/tools/task-reflection");
const questionReflection = await import("../ask-user-question-reflection");
const { listHumanAttentionForPrincipal: list } = await import("../human-attention-service");
const now = "2026-09-07T00:00:00.000Z";
const principal = { userId: "owner", isAdmin: false };
const events: {
	event: NarraForkEvent;
	hasPermission: boolean;
	hasTask: boolean;
	hasDanger: boolean;
	dangerTakenOver: boolean;
	questionCount: number;
	awaited: boolean;
}[] = [];
const observe = (event: NarraForkEvent) => {
	if (event.type !== "human_attention:changed") return;
	events.push({
		event,
		hasPermission: pendingPermissions.has("call"),
		hasTask: getTaskReflectionAwaitingUser("task_synthetic") !== null,
		hasDanger: pendingDangerReflections.has("call"),
		dangerTakenOver: pendingDangerReflections.get("call")?.reflectionStoppedByUser === true,
		questionCount: db
			.select({ id: narratorQuestions.id })
			.from(narratorQuestions)
			.where(eq(narratorQuestions.status, "open"))
			.all().length,
		awaited: isAsyncQuestionAwaited(questionId),
	});
};
let questionId = "unknown";
let localBroadcasts = 0;
const controllers: AbortController[] = [];
const questions = [{ id: "choice", header: "Choose", options: [{ header: "yes" }] }];
eventBus.onAny(observe);

beforeEach(async () => {
	mock.restore();
	for (const controller of controllers) controller.abort();
	controllers.length = 0;
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	cleanupTaskReflection("task_synthetic");
	cleanDb(sqlite);
	await db
		.insert(users)
		.values({ id: "owner", username: "owner", passwordHash: "test", createdAt: now });
	await db.insert(narrators).values({
		id: "n",
		title: "A private narrator",
		ownerUserId: "owner",
		visibility: "private",
		permissionMode: "default",
		createdAt: now,
		updatedAt: now,
	});
	await db
		.insert(narratorMessages)
		.values({ id: "message", narratorId: "n", role: "assistant", contentJson: [], createdAt: now });
	await db.insert(narratorToolCalls).values({
		id: "call",
		narratorId: "n",
		messageId: "message",
		toolUseId: "tool",
		toolName: "AskUserQuestion",
		status: "pending",
		inputJson: { questions },
		createdAt: now,
	});
	questionId = "unknown";
	localBroadcasts = 0;
	events.length = 0;
	setQuestionServiceSeam({
		isLoopRunning: () => false,
		broadcastToNarrator: () => {
			localBroadcasts++;
		},
		emitAttention: () => {},
		emitAttentionResolved: () => {},
	});
});

afterAll(() => {
	for (const controller of controllers) controller.abort();
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	cleanupTaskReflection("task_synthetic");
	eventBus.offAny(observe);
	setQuestionServiceSeam(null);
	mock.restore();
	mock.module("../../db", () => realDb);
});

async function startPermission() {
	const controller = new AbortController();
	controllers.push(controller);
	const permission = handlePermission(
		"n",
		controller.signal,
		"AskUserQuestion",
		{ questions },
		"tool",
		"/test",
	);
	// Registration has no synchronous API because it first persists permission state.
	for (let i = 0; i < 300 && !pendingPermissions.has("call"); i++)
		await new Promise((r) => setTimeout(r, 1));
	expect(pendingPermissions.has("call")).toBe(true);
	return { permission, controller };
}

describe("data-free authoritative human attention invalidation", () => {
	test("notifier has no narrator, input, or routing data and needs no subscriptions", () => {
		notifyHumanAttentionChanged();
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toEqual({ type: "human_attention:changed" });
		expect(localBroadcasts).toBe(0);
	});

	test("permission invalidates after registry.set and again after cleanup, not only its earlier broadcast", async () => {
		const { permission } = await startPermission();
		expect(events.some((e) => e.hasPermission)).toBe(true);
		expect((await list(principal)).items).toHaveLength(1);
		await resolvePermission("call", "deny");
		expect((await permission).behavior).toBe("deny");
		expect(events.at(-1)?.hasPermission).toBe(false);
		expect((await list(principal)).items).toHaveLength(0);
	});

	test("abort clears registered permission before publishing invalidation", async () => {
		const { permission, controller } = await startPermission();
		events.length = 0;
		controller.abort();
		expect(pendingPermissions.has("call")).toBe(false);
		expect(events[0]?.hasPermission).toBe(false);
		expect((await permission).behavior).toBe("deny");
	});

	test("async creation, await start/end and withdrawal are discoverable globally without a narrator view", async () => {
		const { record } = await createAsyncQuestion({
			narratorId: "n",
			toolCallId: "call",
			toolUseId: "tool",
			questions,
			// Required since the async-question closure: an agent-initiated question must
			// carry the context the user needs to answer it later.
			context: "choose the cache backend; continuing with the local cache meanwhile",
		});
		questionId = record.id;
		expect(events.at(-1)?.questionCount).toBe(1);
		const controller = new AbortController();
		controllers.push(controller);
		const waiting = awaitAsyncQuestion({
			questionId,
			narratorId: "n",
			timeoutMs: 0,
			signal: controller.signal,
		});
		for (let i = 0; i < 30 && !isAsyncQuestionAwaited(questionId); i++) await Promise.resolve();
		expect(events.some((event) => event.awaited)).toBe(true);
		controller.abort();
		await waiting;
		expect(events.at(-1)?.awaited).toBe(false);
		await withdrawAsyncQuestions("n", [questionId]);
		expect(events.at(-1)?.questionCount).toBe(0);
		expect(events.every((event) => Object.keys(event.event).join() === "type")).toBe(true);
	});

	test("async invalidation still happens when the narrator-specific broadcast fails", async () => {
		setQuestionServiceSeam({
			isLoopRunning: () => false,
			broadcastToNarrator: () => {
				throw new Error("local subscriber failed");
			},
		});
		await expect(
			createAsyncQuestion({
				narratorId: "n",
				toolCallId: "call",
				toolUseId: "tool",
				questions,
				context: "choose the cache backend; continuing with the local cache meanwhile",
			}),
		).rejects.toThrow("local subscriber failed");
		expect(events.at(-1)?.questionCount).toBe(1);
		expect((await list(principal)).items).toHaveLength(1);
	});

	test("task registration/takeover/decision/cleanup invalidate but progress never does", async () => {
		const decision = createTaskReflectionDecision("task_synthetic", {
			narratorId: "n",
			broadcastTargetId: "n",
			toolCallId: "call",
			toolUseId: "tool",
			toolName: "AskUserQuestion",
			inputJson: { questions },
			mutations: [],
		});
		expect(events.at(-1)?.hasTask).toBe(false);
		await takeOverTaskReflection("task_synthetic");
		expect(events.at(-1)?.hasTask).toBe(true);
		const count = events.length;
		await broadcastTaskReflectionProgress("task_synthetic", {
			phase: "thinking",
			thinkingChars: 10,
			outputChars: 0,
		});
		expect(events).toHaveLength(count);
		await confirmTaskReflection(
			"task_synthetic",
			"Approved by user after takeover",
			undefined,
			"user",
		);
		expect((await decision).action).toBe("confirm");
		expect(events.at(-1)?.hasTask).toBe(false);
	});

	test("danger takeover and cleanup invalidate only after their real transitions", async () => {
		pendingDangerReflections.set("call", {
			requestId: "call",
			toolCallId: "call",
			narratorId: "n",
			broadcastTargetId: "n",
			toolUseId: "tool",
			toolName: "AskUserQuestion",
			input: { questions },
			fingerprint: "fp",
			danger: { severity: "high", summary: "Danger", consequences: [], saferAlternatives: [] },
			startedAt: Date.now(),
			resolve: () => {},
			cleanup: () => {
				pendingDangerReflections.delete("call");
				notifyHumanAttentionChanged();
			},
		});
		await stopDangerReflectionLoop("call");
		expect(events.at(-1)?.dangerTakenOver).toBe(true);
		await cancelDangerReflection("call", "User declined", "user");
		expect(events.at(-1)?.dangerTakenOver).toBe(false);
	});

	test("a real danger gate emits after registration and disappears synchronously on parent abort", async () => {
		const { localBackend } = await import("../../lib/agent/execution/registry");
		const { localPathSemantics } = await import("../../lib/agent/execution/path-semantics");
		await db
			.update(narrators)
			.set({ permissionMode: "bypassPermissions", dangerReflectionOverride: "standard" })
			.where(eq(narrators.id, "n"));
		await db
			.update(narratorToolCalls)
			.set({ toolName: "Bash" })
			.where(eq(narratorToolCalls.id, "call"));
		const controller = new AbortController();
		controllers.push(controller);
		const gate = await handlePermission(
			"n",
			controller.signal,
			"Bash",
			{ command: "rm -rf ./build" },
			"tool",
			process.cwd(),
			"en",
			undefined,
			{
				executionBackend: localBackend,
				executionTarget: {
					deviceId: "local",
					backendKind: "local",
					cwd: process.cwd(),
					pathFlavor: localPathSemantics.flavor,
					runtimeGeneration: localBackend.runtimeGeneration ?? 0,
					selectionSource: "local_default",
				},
			},
		);
		if (gate.behavior !== "dangerReflection") throw new Error("Expected a paused danger gate");
		expect(events.at(-1)?.hasDanger).toBe(true);
		await stopDangerReflectionLoop("call");
		expect((await list(principal)).items).toHaveLength(1);
		controller.abort();
		expect(events.at(-1)?.hasDanger).toBe(false);
		expect(pendingDangerReflections.has("call")).toBe(false);
		expect((await gate.decision).behavior).toBe("deny");
		expect((await list(principal)).items).toHaveLength(0);
	});

	test("Ask auto-answer start hides its item; failure completion invalidates and restores the human question", async () => {
		const { permission } = await startPermission();
		const generation = Promise.withResolvers<Record<string, string>>();
		const generate = spyOn(questionReflection, "generateAskUserQuestionAnswers").mockImplementation(
			() => generation.promise,
		);
		try {
			const reflection = reflectPendingAskUserQuestion("call");
			for (let i = 0; i < 100 && generate.mock.calls.length === 0; i++)
				await new Promise((r) => setTimeout(r, 1));
			expect(generate).toHaveBeenCalled();
			expect((await list(principal)).items).toHaveLength(0);
			const count = events.length;
			generation.reject(new Error("test upstream failure"));
			expect((await reflection).ok).toBe(false);
			expect(events.length).toBeGreaterThan(count);
			expect((await list(principal)).items).toHaveLength(1);
			await resolvePermission("call", "deny");
			await permission;
		} finally {
			generate.mockRestore();
		}
	});
});
