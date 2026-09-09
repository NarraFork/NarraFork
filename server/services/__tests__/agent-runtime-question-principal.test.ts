import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
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

describe("late async answers retain their durable execution principal", () => {
	for (const scenario of cases)
		test(scenario.name, async () => {
			activeNarrators.set(PARENT, parentActive(A));
			const question = await questions.createAsyncQuestion({
				narratorId: CHILD,
				toolCallId: "ask-row",
				toolUseId: "ask-use",
				questions: [{ question: "q", header: "Choice" }],
				executionPrincipal: { version: 1, userId: scenario.principal },
			});
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
		const question = await questions.createAsyncQuestion({
			narratorId: CHILD,
			toolCallId: "ask-row",
			toolUseId: "ask-use",
			questions: [{ question: "q", header: "Choice" }],
		});
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
