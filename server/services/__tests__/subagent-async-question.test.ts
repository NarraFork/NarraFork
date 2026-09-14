import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { AgentConfig, ToolContext } from "../../lib/agent/types";
import { resolveRuntimePolicy } from "../agent-runtime/policy";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const questionService = await import("../narrator-question-service");
const { askUserQuestionTool } = await import("../../lib/agent/tools/ask-user-question");
const { awaitTool } = await import("../../lib/agent/tools/await");
const { handlePermission } = await import("../narrator-permission");
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { deliverInjection, setInjectionScheduler } = await import("../narrator-injection");
const { activeNarrators } = await import("../narrator-session-state");
const { resolveToolFilter } = await import("../subagent-tools");

const PARENT = "p5-parent";
const CHILD = "p5-child";
const SIBLING = "p5-sibling";
const USER = "p5-user";
const QUESTIONS = [
	{
		question: "cache",
		header: "Which cache?",
		options: [
			{ label: "Memory", description: "Local" },
			{ label: "Disk", description: "Persistent" },
		],
	},
];
const events: { target: string; event: unknown }[] = [];
const wakes: string[] = [];
const stops: string[] = [];
const principals: unknown[] = [];
let running = false;
let sequence = 0;
const previousSeam = questionService.setQuestionServiceSeam({
	isLoopRunning: () => running,
	deliverInjection: async (narratorId, options) => {
		principals.push(
			(options as typeof options & { executionPrincipal?: unknown }).executionPrincipal,
		);
		return deliverInjection(narratorId, options);
	},
	broadcastToNarrator: (target, event) => {
		events.push({ target, event });
	},
	emitAttention: () => {},
	emitAttentionResolved: () => {},
});
// Keep question service AND actual injection persistence/transaction logic intact.
// Only observe the scheduling boundary; engine dispatch has a separate real caller test.
const previousScheduler = setInjectionScheduler({
	requestSoftStop: (id) => {
		stops.push(id);
		return running;
	},
	wakeIfIdle: async (id) => {
		wakes.push(id);
		return { started: false };
	},
});
toolRegistry.register(askUserQuestionTool);

beforeEach(async () => {
	cleanDb(sqlite);
	events.length = 0;
	wakes.length = 0;
	stops.length = 0;
	principals.length = 0;
	activeNarrators.delete(PARENT);
	running = false;
	const now = new Date().toISOString();
	await db
		.insert(users)
		.values({ id: USER, username: "p5-user", passwordHash: "unused", createdAt: now });
	await db.insert(narrators).values([
		{ id: PARENT, variant: "primary", createdAt: now, updatedAt: now },
		{
			id: CHILD,
			variant: "subagent:general",
			parentNarratorId: PARENT,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: SIBLING,
			variant: "subagent:explore",
			parentNarratorId: PARENT,
			createdAt: now,
			updatedAt: now,
		},
	]);
});
afterAll(() => {
	questionService.setQuestionServiceSeam(previousSeam);
	setInjectionScheduler(previousScheduler);
	activeNarrators.delete(PARENT);
	cleanDb(sqlite);
	mock.module("../../db", () => realDb);
});

async function seedCall(
	narratorId = CHILD,
	input: Record<string, unknown> = { async: true, questions: QUESTIONS },
): Promise<
	ToolContext & {
		currentToolUseId: string;
		toolCallBinding: { toolCallId: string; attempt: number };
	}
> {
	sequence += 1;
	const messageId = `p5-msg-${sequence}`;
	const toolUseId = `p5-use-${sequence}`;
	const toolCallId = `p5-call-${sequence}`;
	const now = new Date().toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		contentText: "",
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: `p5-ref-${sequence}`, narratorId, messageId, seq: sequence });
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId,
		messageId,
		toolUseId,
		toolName: "AskUserQuestion",
		inputJson: input,
		status: "running",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now,
	});
	return {
		narratorId,
		parentNarratorId: narratorId === PARENT ? undefined : PARENT,
		userId: USER,
		currentToolUseId: toolUseId,
		toolCallBinding: { toolCallId, attempt: 1 },
		cwd: process.cwd(),
		locale: "en",
		signal: new AbortController().signal,
	} as ToolContext & {
		currentToolUseId: string;
		toolCallBinding: { toolCallId: string; attempt: number };
	};
}
async function submit(ctx: ToolContext) {
	const result = await askUserQuestionTool.execute({ async: true, questions: QUESTIONS }, ctx);
	expect(result.isError).not.toBe(true);
	expect(result.output).toContain("Question submitted asynchronously");
	const rows = await questionService.listAsyncQuestions({ narratorId: ctx.narratorId });
	const record = rows.items.find((row) => row.toolCallId === ctx.toolCallBinding?.toolCallId);
	if (!record) throw new Error("question was not persisted");
	return record;
}

describe("child async-only question integration", () => {
	test("principal snapshots distinguish unknown legacy identity from explicit anonymity", () => {
		expect(questionService.parseQuestionExecutionPrincipal(null)).toBeNull();
		expect(questionService.parseQuestionExecutionPrincipal(undefined)).toBeNull();
		expect(questionService.parseQuestionExecutionPrincipal({ version: 1 })).toBeNull();
		expect(questionService.parseQuestionExecutionPrincipal({ version: 1, userId: "" })).toBeNull();
		expect(questionService.parseQuestionExecutionPrincipal({ version: 1, userId: null })).toEqual({
			version: 1,
			userId: null,
		});
		expect(questionService.parseQuestionExecutionPrincipal({ version: 1, userId: USER })).toEqual({
			version: 1,
			userId: USER,
		});
	});

	for (const parentState of ["switched-user", "released"] as const) {
		for (const originalUserId of [USER, null]) {
			test(`late answer keeps original ${originalUserId ?? "anonymous"} principal when parent is ${parentState}`, async () => {
				const now = new Date().toISOString();
				await db.insert(users).values([
					{ id: "p5-user-B", username: "p5-user-B", passwordHash: "unused", createdAt: now },
					{ id: "p5-answer-C", username: "p5-answer-C", passwordHash: "unused", createdAt: now },
				]);
				const ctx = { ...(await seedCall()), userId: originalUserId };
				const record = await submit(ctx);
				await db
					.update(narratorToolCalls)
					.set({ status: "success" })
					.where(eq(narratorToolCalls.id, ctx.toolCallBinding.toolCallId));
				if (parentState === "switched-user")
					activeNarrators.set(PARENT, {
						narratorId: PARENT,
						_currentUserId: "p5-user-B",
					} as import("../narrator-session-state").ActiveNarrator);
				else activeNarrators.delete(PARENT);
				const answer = await questionService.answerAsyncQuestion(record.id, {
					answers: { cache: "Disk" },
					userId: "p5-answer-C",
					locale: "en",
				});
				expect(answer.ok).toBe(true);
				if (!answer.ok || !answer.record.answerMessageId)
					throw new Error("late answer was not persisted");
				expect(principals).toEqual([{ version: 1, userId: originalUserId }]);
				expect(wakes).toEqual([CHILD]);
				expect(await questionService.getAsyncQuestionExecutionPrincipal(record.id, CHILD)).toEqual({
					version: 1,
					userId: originalUserId,
				});
				expect(
					await questionService.getAsyncQuestionExecutionPrincipal(record.id, SIBLING),
				).toBeNull();
				const message = await db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, answer.record.answerMessageId),
				});
				expect(message?.createdBy).toBe("p5-answer-C");
			});
		}
	}

	test("model input cannot forge the execution principal captured from ToolContext", async () => {
		const ctx = await seedCall();
		const result = await askUserQuestionTool.execute(
			{
				async: true,
				questions: QUESTIONS,
				userId: "forged-user",
				executionPrincipal: { version: 1, userId: "forged-user" },
				executionPrincipalJson: { version: 1, userId: "forged-user" },
			},
			ctx,
		);
		expect(result.isError).not.toBe(true);
		const record = (await questionService.listAsyncQuestions({ narratorId: CHILD })).items[0];
		if (!record) throw new Error("question not stored");
		expect(await questionService.getAsyncQuestionExecutionPrincipal(record.id, CHILD)).toEqual({
			version: 1,
			userId: USER,
		});
	});

	test("question replay cannot replace its captured principal with a later actor", async () => {
		const ctx = await seedCall();
		const record = await submit(ctx);
		await questionService.createAsyncQuestion({
			narratorId: CHILD,
			toolCallId: ctx.toolCallBinding.toolCallId,
			toolUseId: ctx.currentToolUseId,
			questions: QUESTIONS,
			executionPrincipal: { version: 1, userId: "different-actor" },
		});
		expect(await questionService.getAsyncQuestionExecutionPrincipal(record.id, CHILD)).toEqual({
			version: 1,
			userId: USER,
		});
	});

	test("unknown legacy principal preserves the late answer but never guesses a wake actor", async () => {
		const ctx = await seedCall();
		const { record } = await questionService.createAsyncQuestion({
			narratorId: CHILD,
			toolCallId: ctx.toolCallBinding.toolCallId,
			toolUseId: ctx.currentToolUseId,
			questions: QUESTIONS,
		});
		const answer = await questionService.answerAsyncQuestion(record.id, {
			answers: { cache: "Disk" },
			userId: USER,
			locale: "en",
		});
		expect(answer.ok).toBe(true);
		if (!answer.ok) throw new Error("legacy answer lost");
		expect(answer.record.answerMessageId).not.toBeNull();
		expect(await questionService.getAsyncQuestionExecutionPrincipal(record.id, CHILD)).toBeNull();
		expect(wakes).toEqual([]);
		expect(stops).toEqual([]);
	});

	test("policy exposes async only without widening readOnly, nesting or approval", () => {
		for (const type of ["general", "explore", "plan", "review", "search", "missing-custom"]) {
			const policy = resolveRuntimePolicy({ variant: "subagent", subagentType: type });
			expect(policy.capabilities.askUserQuestion).toBe("async-only");
			const filter = resolveToolFilter(type);
			expect(filter?.(askUserQuestionTool)).toBe(true);
			for (const name of ["Agent", "ForkNarrator", "EnterPlanMode", "ExitPlanMode"])
				expect(filter?.({ ...askUserQuestionTool, name })).toBe(false);
			if (type !== "general")
				expect(filter?.({ ...askUserQuestionTool, name: "Write" })).toBe(false);
		}
		const config = { parentNarratorId: PARENT } as AgentConfig;
		const schema = askUserQuestionTool.getRawJsonSchema?.(config) as {
			properties: { async: { const?: boolean } };
			required: string[];
			anyOf: unknown[];
		};
		expect(schema.properties.async.const).toBe(true);
		expect(schema.required).toContain("async");
		expect(schema.anyOf).toEqual([{ required: ["questions"] }, { required: ["withdraw"] }]);
		const primary = askUserQuestionTool.getRawJsonSchema?.({} as AgentConfig) as {
			required: string[];
		};
		expect(primary.required).not.toContain("async");
	});

	test("explicit custom allowlist can disable asking without revoking own question waits", () => {
		const customDefinition = { toolAccess: "custom" as const, customTools: ["Read", "Await"] };
		const policy = resolveRuntimePolicy({
			variant: "subagent",
			subagentType: "custom",
			customDefinition,
		});
		expect(policy.capabilities.askUserQuestion).toBe("disabled");
		expect(policy.capabilities.awaitOwnQuestion).toBe(true);
		const filter = resolveToolFilter("custom", {
			...customDefinition,
			name: "custom",
			description: "test",
			prompt: "test",
			defaultModel: "",
			location: "test",
		});
		expect(filter?.(askUserQuestionTool)).toBe(false);
		expect(filter?.(awaitTool)).toBe(true);
	});

	test("primary tool retains synchronous answers and optional asynchronous submission", async () => {
		const ctx = await seedCall(PARENT);
		const result = await askUserQuestionTool.execute(
			{ questions: QUESTIONS, answers: { cache: "Memory" } },
			ctx,
		);
		expect(result.isError).not.toBe(true);
		expect(result.output).toContain("User answered:");
		expect(result.output).toContain("Memory");
		const record = await submit(ctx);
		expect(record.narratorId).toBe(PARENT);
	});

	test("permission allows async immediately; submission returns while question is still open", async () => {
		const ctx = await seedCall();
		const decision = await handlePermission(
			CHILD,
			ctx.signal,
			"AskUserQuestion",
			{ async: true, questions: QUESTIONS },
			ctx.currentToolUseId,
			ctx.cwd,
			"en",
			PARENT,
			{ toolCallBinding: ctx.toolCallBinding },
		);
		expect(decision.behavior).toBe("allow");
		const record = await submit(ctx);
		expect(record.status).toBe("open");
		expect(record.decidedBy).toBeNull();
		expect(record.origin).toBe("agent_async");
		expect(wakes).toEqual([]);
		expect(events.map((event) => event.target)).toEqual([CHILD, PARENT]);
		for (const { event } of events)
			expect(event).toMatchObject({
				narratorId: CHILD,
				question: { narratorId: CHILD, decidedBy: null },
			});
	});

	test("real executeTool carries the resolved policy through permission and durable child submission", async () => {
		const { executeTool } = await import("../../lib/agent/tool-executor");
		const ctx = await seedCall();
		const policy = resolveRuntimePolicy({ variant: "subagent", subagentType: "general" });
		const config: AgentConfig = {
			narratorId: CHILD,
			conversationId: "p5-real-execution",
			provider: "anthropic",
			model: "test-model",
			cwd: ctx.cwd,
			signal: ctx.signal,
			locale: "en",
			parentNarratorId: PARENT,
			runtimePolicy: policy,
			requireToolCallBinding: true,
			permissionHandler: (name, input, id, options) =>
				handlePermission(CHILD, ctx.signal, name, input, id, ctx.cwd, "en", PARENT, options),
			onToolExecutionStarting: async (_id, binding) => binding,
		};
		const result = await executeTool(
			{
				name: "AskUserQuestion",
				toolUseId: ctx.currentToolUseId,
				input: {
					async: true,
					questions: QUESTIONS,
					runtimePolicy: resolveRuntimePolicy({ variant: "primary" }),
				},
			},
			config,
			{ toolCallBinding: ctx.toolCallBinding },
		);
		expect(result.isError).not.toBe(true);
		expect(result.output).toContain("Question submitted asynchronously");
		expect((await questionService.listAsyncQuestions({ narratorId: CHILD })).items).toHaveLength(1);
		expect(config.runtimePolicy).toBe(policy);
		expect(wakes).toEqual([]);
	});

	test("DB identity rejects omitted parent hint, synchronous input and forged answers before withdrawals", async () => {
		const ctx = await seedCall();
		const record = await submit(ctx);
		for (const input of [
			{ questions: QUESTIONS },
			{ async: false, questions: QUESTIONS },
			{ questions: QUESTIONS, withdraw: [record.id] },
			{ async: true, questions: QUESTIONS, answers: { cache: "forged" } },
			{ async: true, questions: QUESTIONS, deferredByUser: true },
		]) {
			const result = await askUserQuestionTool.execute(input, {
				...ctx,
				parentNarratorId: undefined,
			});
			expect(result.isError).toBe(true);
			const decision = await handlePermission(
				CHILD,
				ctx.signal,
				"AskUserQuestion",
				input,
				ctx.currentToolUseId,
				ctx.cwd,
				"en",
				PARENT,
				{ toolCallBinding: ctx.toolCallBinding },
			);
			expect(decision.behavior).toBe("deny");
		}
		expect((await questionService.getAsyncQuestion(record.id))?.status).toBe("open");
	});

	test("child payload limits reject oversized submissions and withdrawal batches before writes", async () => {
		const ctx = await seedCall();
		for (const input of [
			{ async: true, questions: Array.from({ length: 5 }, () => QUESTIONS[0]) },
			{ async: true, questions: [{ ...QUESTIONS[0], header: "问".repeat(22_000) }] },
			{ async: true, withdraw: Array.from({ length: 101 }, (_, index) => `q-${index}`) },
		]) {
			const result = await askUserQuestionTool.execute(input, ctx);
			expect(result.isError).toBe(true);
		}
		expect(await questionService.countOpenAsyncQuestions(CHILD)).toBe(0);
		expect(events).toEqual([]);
	});

	test("exact binding rejects missing/stale attempts and service rejects another child's tool identity", async () => {
		const ctx = await seedCall();
		for (const toolCallBinding of [
			undefined,
			{ toolCallId: ctx.toolCallBinding.toolCallId, attempt: 2 },
		]) {
			const result = await askUserQuestionTool.execute(
				{ async: true, questions: QUESTIONS },
				{ ...ctx, toolCallBinding },
			);
			expect(result.isError).toBe(true);
			expect(result.output).not.toContain("Ask again without");
		}
		await expect(
			questionService.createAsyncQuestion({
				narratorId: SIBLING,
				toolCallId: ctx.toolCallBinding.toolCallId,
				toolUseId: ctx.currentToolUseId,
				questions: QUESTIONS,
			}),
		).rejects.toThrow("does not belong");
		expect(await questionService.countOpenAsyncQuestions(CHILD)).toBe(0);
	});

	test("answer persists only into child history with actual user attribution, then wakes the same child", async () => {
		const ctx = await seedCall();
		const record = await submit(ctx);
		const answer = await questionService.answerAsyncQuestion(record.id, {
			answers: { cache: "Disk" },
			userId: USER,
			locale: "en",
		});
		expect(answer.ok).toBe(true);
		if (!answer.ok) throw new Error("answer failed");
		if (!answer.record.answerMessageId) throw new Error("missing answer message");
		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, answer.record.answerMessageId),
		});
		if (!message) throw new Error("missing persisted message");
		expect(message).toMatchObject({ narratorId: CHILD, role: "user", createdBy: USER });
		expect(message?.contentText).toContain("Disk");
		const refs = await db
			.select()
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, message.id));
		expect(refs.map((row) => row.narratorId)).toEqual([CHILD]);
		expect(wakes).toEqual([CHILD]);
		const own = await awaitTool.execute({ type: "question", id: record.id }, ctx);
		expect(own.isError).not.toBe(true);
		expect(own.output).toContain("Disk");
		for (const narratorId of [SIBLING, PARENT]) {
			const foreign = await awaitTool.execute(
				{ type: "question", id: record.id },
				{ ...ctx, narratorId },
			);
			expect(foreign.isError).toBe(true);
		}
	});

	test("running child is interjected, not independently woken", async () => {
		const record = await submit(await seedCall());
		running = true;
		await questionService.answerAsyncQuestion(record.id, {
			answers: { cache: "Memory" },
			userId: USER,
			locale: "en",
		});
		expect(stops).toEqual([CHILD]);
		expect(wakes).toEqual([]);
	});

	test("withdraw is own-only and a late answer is stale without history mutation", async () => {
		const ctx = await seedCall();
		const own = await submit(ctx);
		const other = await submit(await seedCall(SIBLING));
		const result = await askUserQuestionTool.execute(
			{ async: true, withdraw: [own.id, other.id] },
			ctx,
		);
		expect(result.output).toContain("Withdrew 1");
		expect(result.output).toContain("Could not withdraw 1");
		expect((await questionService.getAsyncQuestion(other.id))?.status).toBe("open");
		const late = await questionService.answerAsyncQuestion(own.id, {
			answers: { cache: "Disk" },
			userId: USER,
			locale: "en",
		});
		expect(late.ok).toBe(false);
		expect(wakes).toEqual([]);
	});

	test("wait timeout does not expire the question; answer after child task completion is still durable", async () => {
		const ctx = await seedCall();
		const record = await submit(ctx);
		const timeout = new AbortController();
		timeout.abort();
		const result = await questionService.awaitAsyncQuestion({
			narratorId: CHILD,
			questionId: record.id,
			timeoutMs: 0,
			timeoutSignal: timeout.signal,
		});
		expect(result.status).toBe("timeout");
		// Completing the task is not consent to discard an unanswered question.
		await db
			.update(narratorToolCalls)
			.set({ status: "success" })
			.where(eq(narratorToolCalls.id, ctx.toolCallBinding.toolCallId));
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, CHILD));
		expect((await questionService.getAsyncQuestion(record.id))?.status).toBe("open");
		const answer = await questionService.answerAsyncQuestion(record.id, {
			answers: { cache: "Disk" },
			userId: USER,
			locale: "en",
		});
		expect(answer.ok).toBe(true);
		if (!answer.ok) throw new Error("late answer lost");
		expect(answer.record.answerMessageId).not.toBeNull();
		expect(wakes).toEqual([CHILD]);
	});
});
