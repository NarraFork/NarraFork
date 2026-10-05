import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { ActiveNarrator } from "../narrator-session-state";

// Real durable question -> answer injection -> scheduler -> resume -> runner ->
// orchestrator. Model I/O, knowledge contents and device enumeration are observed seams.
const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const questions = await import("../narrator-question-service");
const { activeNarrators, waitForNarratorAdmissionWork } = await import("../narrator-session-state");
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const executor = await import("../narrator-executor");
const devices = await import("../device-connection-service");
const { knowledgeInjection } = await import("../knowledge-injection");
const sessionService = await import("../narrator-session");
const provider = await import("../../lib/agent/provider");
const { resolveInjectionUserId } = await import("../subagent-knowledge-injection");
const model = "questionprincipal:model";
const adapter = {
	formatTools: () => [],
	buildHistory: async (messages: Array<{ role: string; contentJson: unknown }>) => ({
		history: messages.map((message) => ({ role: message.role, content: message.contentJson })),
		trailingToolResults: [],
	}),
	injectSystemPrompt: () => {},
	chat: () => {
		throw new Error("Question principal test must not contact a model");
	},
	formatToolResult: () => ({}),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
} as unknown as ProviderAdapter;
const unregister = provider.registerExternalProviderResolver((name) =>
	name === "questionprincipal" ? adapter : null,
);
const PARENT = "principal-parent";
const CHILD = "principal-child";
const A = "question-owner-A";
const B = "later-parent-B";
const C = "answer-author-C";

function parentActive(userId: string): ActiveNarrator {
	return {
		narratorId: PARENT,
		conversationId: "parent-conversation",
		cwd: process.env.HOME as string,
		model,
		provider: "questionprincipal",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_currentUserId: userId,
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
}

beforeEach(() => {
	cleanDb(sqlite);
	const now = new Date().toISOString();
	for (const id of [A, B, C])
		db.insert(users).values({ id, username: id, passwordHash: "test", createdAt: now }).run();
	for (const id of [PARENT, CHILD])
		db.insert(narrators)
			.values({
				id,
				model,
				cwd: process.env.HOME,
				ownerUserId: A,
				status: "idle",
				lastStopReason: "normal",
				autoContinuationOverride: "off",
				type: id === CHILD ? "subagent" : "primary",
				variant: id === CHILD ? "subagent:general" : "primary",
				parentNarratorId: id === CHILD ? PARENT : null,
				aclRootNarratorId: id === CHILD ? PARENT : null,
				subagentOriginKind: id === CHILD ? "standalone" : null,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	db.insert(narratorMessages)
		.values({
			id: "ask-message",
			narratorId: CHILD,
			role: "assistant",
			parentToolUseId: "standalone-principal-child",
			contentJson: [
				{
					type: "tool_use",
					id: "ask-use",
					name: "AskUserQuestion",
					input: { async: true, questions: [{ question: "q", header: "Choice" }] },
				},
			],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "ask-ref", narratorId: CHILD, messageId: "ask-message", seq: 1 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "ask-row",
			narratorId: CHILD,
			messageId: "ask-message",
			toolUseId: "ask-use",
			toolName: "AskUserQuestion",
			status: "success",
			executionIdentityVersion: 1,
			createdAt: now,
		})
		.run();
});
afterEach(async () => {
	await waitForNarratorAdmissionWork(PARENT, AbortSignal.timeout(3000));
	for (const id of [PARENT, CHILD]) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	mock.restore();
});
afterAll(() => {
	unregister();
	mock.module("../../db", () => realDb);
});

const cases = [
	{
		name: "terminal child retains original A even though C supplies the answer",
		principal: A,
		parentUser: A,
	},
	{ name: "parent switches A to B before C answers", principal: A, parentUser: B },
	{ name: "parent active session is gone before C answers", principal: A, parentUser: undefined },
	{
		name: "explicit anonymous principal never falls back to parent B or answer C",
		principal: null,
		parentUser: B,
	},
] as const;

/**
 * Rows are inserted directly rather than through `createAsyncQuestion`.
 *
 * Subagents can no longer FILE a question (the capability is disabled), but rows filed
 * before that change still exist and must stay answerable — and answering one is
 * exactly the path whose principal handling is under test here. Going through the
 * creation API would only re-assert the new refusal and lose this coverage.
 */
async function seedChildQuestion(principal: string | null): Promise<{ record: { id: string } }> {
	const id = `principal-question-${Math.random().toString(36).slice(2, 10)}`;
	db.insert(narratorQuestions)
		.values({
			id,
			narratorId: CHILD,
			toolCallId: "ask-row",
			toolUseId: "ask-use",
			questionsJson: [{ question: "q", header: "Choice" }],
			executionPrincipalJson: { version: 1, userId: principal },
			status: "open",
			origin: "agent_async",
			createdAt: new Date().toISOString(),
		})
		.run();
	return { record: { id } };
}

describe("late async answers retain their durable execution principal", () => {
	test("receipt arriving after the prebuilt child packet reaches actual provider.chat before adoption", async () => {
		activeNarrators.set(PARENT, parentActive(A));
		const question = await seedChildQuestion(A);
		// A fork/compressed packet may intentionally omit a parent's old receipt.
		// Its COW row remains background, not a newly delivered child question.
		const foreignText =
			'{"answerMessageId":"foreign-receipt","answer":"COMPRESSED_PARENT_BACKGROUND"}';
		db.insert(narratorMessages)
			.values({
				id: "foreign-receipt",
				narratorId: PARENT,
				role: "user",
				origin: "user",
				createdBy: C,
				contentText: foreignText,
				contentJson: [
					{
						type: "system_injection",
						source: "async_question_answers",
						modelText: foreignText,
						body: {
							kind: "asyncQuestionAnswers",
							questionId: "foreign-question",
							answerMessageId: "foreign-receipt",
							outcome: "answered",
							items: [{ header: "Parent choice", answer: "COMPRESSED_PARENT_BACKGROUND" }],
						},
					},
				],
				createdAt: new Date().toISOString(),
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "foreign-child-ref", narratorId: CHILD, messageId: "foreign-receipt", seq: 2 })
			.run();
		db.update(narrators).set({ nextSeq: 2 }).where(eq(narrators.id, CHILD)).run();
		spyOn(devices, "getSessionDevices").mockResolvedValue([]);
		spyOn(knowledgeInjection, "resolveInjections").mockResolvedValue([]);
		spyOn(sessionService, "startBackgroundCompletionContinuationIfPossible").mockResolvedValue({
			started: false,
		});
		const prepared = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const requests: Array<{
			history: unknown;
			content: string;
			userId: string | null | undefined;
			adopted: string[];
		}> = [];
		const originalBuild = adapter.buildHistory.bind(adapter);
		let builds = 0;
		spyOn(adapter, "buildHistory").mockImplementation(async (...args) => {
			const snapshot = await originalBuild(...args);
			if (++builds === 1) {
				snapshot.history = snapshot.history.filter(
					(entry) => !JSON.stringify(entry).includes("COMPRESSED_PARENT_BACKGROUND"),
				);
				expect(JSON.stringify(snapshot)).not.toContain("LATE_AFTER_PREBUILT");
				prepared.resolve();
				await release.promise;
			}
			return snapshot;
		});
		spyOn(adapter, "pushUserTurn").mockImplementation((history, content, _model, results) => {
			history.push({ role: "user", content, toolResults: results });
		});
		spyOn(adapter, "pushAssistantTurn").mockImplementation(() => {});
		spyOn(adapter, "chat").mockImplementation(async function* (params) {
			params.onRequestStart?.();
			const active = activeNarrators.get(CHILD);
			requests.push({
				history: JSON.parse(JSON.stringify(params.history)),
				content: params.content,
				userId: active?._currentUserId,
				adopted: Array.from(active?._questionAnswerAdoptedMessageIds ?? []),
			});
			yield { text: "receipt applied" };
		});
		const { resumeSubagent } = await import("../subagent-resume");
		const resumed = resumeSubagent({
			subagentId: CHILD,
			intent: "follow_up",
			actor: "user",
			prompt: "OLD_PREBUILT_PACKET",
			createdBy: A,
			locale: "en",
		});
		await prepared.promise;
		const answer = await questions.answerAsyncQuestion(question.record.id, {
			answers: { q: "LATE_AFTER_PREBUILT" },
			userId: C,
			locale: "en",
		});
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		expect(
			activeNarrators
				.get(CHILD)
				?._questionAnswerAdoptedMessageIds?.has(answer.record.answerMessageId),
		).not.toBe(true);
		release.resolve();
		const outcome = await resumed;
		await outcome.terminalCompletion;
		expect(requests).toHaveLength(1);
		const packet = JSON.stringify({ history: requests[0].history, content: requests[0].content });
		expect(packet.split("LATE_AFTER_PREBUILT")).toHaveLength(2);
		expect(packet).toContain("OLD_PREBUILT_PACKET");
		expect(packet).not.toContain("COMPRESSED_PARENT_BACKGROUND");
		expect(packet).toContain('kind=\\"human\\"');
		expect(packet).toContain(`id=\\"${C}\\"`);
		expect(requests[0].userId).toBe(A);
		expect(requests[0].adopted).toEqual([answer.record.answerMessageId]);
		const readReceipt = () =>
			db
				.select({ adoptedAt: narratorBufferedMessages.currentAdoptedAt })
				.from(narratorBufferedMessages)
				.where(
					eq(narratorBufferedMessages.recipientMessageId, answer.record.answerMessageId as string),
				)
				.get();
		for (let attempt = 0; attempt < 20 && !readReceipt()?.adoptedAt; attempt++)
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(readReceipt()?.adoptedAt).toBeTruthy();
	});
	for (const scenario of cases)
		test(scenario.name, async () => {
			activeNarrators.set(PARENT, parentActive(A));
			const question = await seedChildQuestion(scenario.principal);
			// The child is truly terminal: no retained ActiveNarrator or execution owner.
			expect(activeNarrators.has(CHILD)).toBe(false);
			expect(getExecutionOwner(CHILD)).toBeUndefined();
			if (scenario.parentUser === undefined) activeNarrators.delete(PARENT);
			else activeNarrators.set(PARENT, parentActive(scenario.parentUser));
			const deviceRead = spyOn(devices, "getSessionDevices").mockResolvedValue([]);
			const knowledgeRead = spyOn(knowledgeInjection, "resolveInjections").mockResolvedValue([]);
			spyOn(sessionService, "startBackgroundCompletionContinuationIfPossible").mockResolvedValue({
				started: false,
			});
			const observed = Promise.withResolvers<{
				userId: string | null | undefined;
				knowledgeUser: unknown;
				deviceUser: unknown;
				packet: string;
			}>();
			let childPasses = 0;
			const executionUsers: Array<string | null | undefined> = [];
			spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
				if (options.config.narratorId === CHILD) {
					childPasses++;
					executionUsers.push(options.config.userId);
					observed.resolve({
						userId: options.config.userId,
						knowledgeUser: knowledgeRead.mock.calls.at(-1)?.[0],
						deviceUser: deviceRead.mock.calls.at(-1)?.[1],
						packet: JSON.stringify({ history: options.history, input: options.userText }),
					});
				}
				return {
					finalText: "principal preserved",
					hasError: false,
					shouldUpdateTitle: false,
					completedNaturally: true,
					completedAssistantTurn: true,
				};
			});
			const answer = await questions.answerAsyncQuestion(question.record.id, {
				answers: { q: "ANSWER_FROM_C" },
				userId: C,
				locale: "en",
			});
			if (!answer.ok) throw new Error(`Question answer was refused: ${JSON.stringify(answer)}`);
			const evidence = await observed.promise;
			expect(evidence.userId).toBe(scenario.principal);
			expect(evidence.knowledgeUser).toBe(scenario.principal);
			expect(evidence.deviceUser).toBe(scenario.principal);
			expect(evidence.packet).toContain("ANSWER_FROM_C");
			expect(childPasses).toBe(1);
			const stored = await questions.getAsyncQuestionExecutionPrincipal(question.record.id, CHILD);
			expect(stored).toEqual({ version: 1, userId: scenario.principal });
			const row = db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.id, answer.record.answerMessageId ?? ""))
				.get();
			expect(row?.createdBy).toBe(C);
			expect(resolveInjectionUserId(scenario.principal, PARENT)).toBe(scenario.principal);
			await waitForNarratorAdmissionWork(PARENT, AbortSignal.timeout(3000));
			// A deliberate new user turn is a NEW authorization choice, unlike the answer wake.
			const { resumeSubagent } = await import("../subagent-resume");
			const followup = await resumeSubagent({
				subagentId: CHILD,
				intent: "follow_up",
				actor: "user",
				prompt: "NEW_FOLLOWUP_FROM_B",
				createdBy: B,
				locale: "en",
			});
			expect(followup.started).toBe(true);
			await followup.terminalCompletion;
			expect(executionUsers).toEqual([scenario.principal, B]);
		});

	test("legacy unknown execution principal persists C's answer but never auto-starts", async () => {
		activeNarrators.set(PARENT, parentActive(B));
		const id = "principal-question-legacy";
		db.insert(narratorQuestions)
			.values({
				id,
				narratorId: CHILD,
				toolCallId: "ask-row",
				toolUseId: "ask-use",
				questionsJson: [{ question: "q", header: "Choice" }],
				status: "open",
				origin: "agent_async",
				createdAt: new Date().toISOString(),
			})
			.run();
		const question = { record: { id } };
		const execute = spyOn(executor, "executeAgentLoop");
		const answer = await questions.answerAsyncQuestion(question.record.id, {
			answers: { q: "ANSWER_FROM_C" },
			userId: C,
			locale: "en",
		});
		if (!answer.ok) throw new Error("Expected a durable answer");
		expect(
			await questions.getAsyncQuestionExecutionPrincipal(question.record.id, CHILD),
		).toBeNull();
		expect(execute).not.toHaveBeenCalled();
		expect(getExecutionOwner(CHILD)).toBeUndefined();
		const row = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, answer.record.answerMessageId ?? ""))
			.get();
		expect(row?.createdBy).toBe(C);
		expect(row?.contentText).toContain("ANSWER_FROM_C");
	});
});
