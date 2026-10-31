import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { historyStrings } from "../../../tests/fixtures/model-input";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narrators, narratorToolCalls } from "../../db/schema";
import { buildLegacyAttachedFilesHint } from "../../lib/attached-files";
import { settings } from "../../lib/settings";
import { setUploadsDirForTests } from "../../lib/uploads";
import type { RuntimeHistoryMessage } from "../agent-runtime/history";
import { readSqliteModelHistorySignature } from "../agent-runtime/model-history-revision";
import { MODEL_HISTORY_REVISION_CONTRACT } from "../agent-runtime/model-history-revision-sql";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { buildRuntimeHistory } = await import("../agent-runtime/history");
const { narratorPersistence } = await import("../narrator-persistence");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { consumeAgentMessageHistory } = await import("../agent-message-delivery");
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const originalProviders = settings.anthropicProviders;
const originalOpenAIProviders = settings.openaiProviders;
const originalGeminiProviders = settings.geminiProviders;
const time = "2026-09-09T00:00:00.000Z";
beforeEach(() => {
	cleanDb(sqlite);
	// Keep the actual loader integration cases versioned after cleanDb clears fixture rows.
	sqlite
		.query(
			"INSERT INTO model_history_revision_contracts (id, installed_version) VALUES ('model-history', ?)",
		)
		.run(MODEL_HISTORY_REVISION_CONTRACT);
	settings.anthropicProviders = [false, true].map((officialApi) => ({
		id: officialApi ? "history-official" : "history-relay",
		name: "History test",
		prefix: officialApi ? "history-official" : "history-relay",
		apiKey: "isolated-test-no-network",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "claude-sonnet-4",
		officialApi,
	}));
	settings.openaiProviders = (["responses", "completions"] as const).map((apiMode) => ({
		id: `question-${apiMode}`,
		name: "Question OpenAI history",
		prefix: `question-${apiMode}`,
		apiKey: "isolated-test-no-network",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "gpt-5",
		apiMode,
	}));
	settings.geminiProviders = (["generate-content", "interactions"] as const).map(
		(geminiTransport) => ({
			id: geminiTransport === "generate-content" ? "question-gemini" : "question-interactions",
			name: "Question Gemini history",
			prefix: geminiTransport === "generate-content" ? "question-gemini" : "question-interactions",
			apiKey: "isolated-test-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "gemini-2.5-pro",
			geminiTransport,
		}),
	);
	for (const id of ["primary", "child", "fork"])
		db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
	expect(readSqliteModelHistorySignature(sqlite, "primary").trusted).toBe(true);
});
afterEach(() => {
	for (const id of ["primary", "child", "fork"]) getExecutionOwner(id)?.release();
	settings.anthropicProviders = originalProviders;
	settings.openaiProviders = originalOpenAIProviders;
	settings.geminiProviders = originalGeminiProviders;
});
afterAll(() => sqlite.close());
/**
 * "subagent" names the session shape whose run delivers to the "origin" call: its own
 * turns are placed under that call. The rule is the same for every session.
 */
function options(profile: "primary" | "subagent" = "primary", official = false) {
	return {
		narratorId: profile === "primary" ? "primary" : "child",
		ownTurnPlacement: profile === "subagent" ? "origin" : null,
		model: "claude-sonnet-4",
		provider: official ? "history-official" : "history-relay",
	};
}
function message(
	id: string,
	role: RuntimeHistoryMessage["role"],
	text: string,
	parentToolUseId: string | null = null,
): RuntimeHistoryMessage {
	return {
		id,
		narratorId: "primary",
		role,
		contentText: text,
		contentJson: [{ type: "text", text }],
		parentToolUseId,
		messageUuid: null,
	};
}

test("hydration may outlive the source-read deadline without rejecting a valid history", async () => {
	const prefix = await import("../narrator-prefix-state");
	const original = prefix.hydrateContextUpdates;
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const hydration = spyOn(prefix, "hydrateContextUpdates").mockImplementation(async (...args) => {
		const rows = await original(...args);
		now += 11_000;
		return rows;
	});
	try {
		const built = await buildRuntimeHistory({
			...options(),
			deadline: now + 10_000,
			sourceMessages: [message("input", "user", "large history survives hydration")],
		});
		expect(built.modelMessages[0].contentText).toBe("large history survives hydration");
	} finally {
		hydration.mockRestore();
		clock.mockRestore();
	}
});

test("cancellation after hydration still prevents provider history publication", async () => {
	const prefix = await import("../narrator-prefix-state");
	const original = prefix.hydrateContextUpdates;
	const controller = new AbortController();
	const hydration = spyOn(prefix, "hydrateContextUpdates").mockImplementation(async (...args) => {
		const rows = await original(...args);
		controller.abort(new Error("hydration cancelled"));
		return rows;
	});
	try {
		await expect(
			buildRuntimeHistory({
				...options(),
				attachmentSignal: controller.signal,
				sourceMessages: [message("input", "user", "cancelled")],
			}),
		).rejects.toThrow("hydration cancelled");
	} finally {
		hydration.mockRestore();
	}
});

const HUMAN_QUESTION_CANARY = "human-answer-only-7c970c41";
const questionInput = {
	questions: [
		{
			question: "Which rollout should we use?",
			header: "Rollout",
			options: [
				{ label: "Small", description: "Start with a limited rollout" },
				{ label: "Full", description: "Roll out to everyone" },
			],
			multiSelect: false,
		},
	],
	async: false,
};
const questionReply = {
	answers: { "Which rollout should we use?": HUMAN_QUESTION_CANARY },
	annotations: { "Which rollout should we use?": "human-annotation-only-62590eaa" },
	deferredByUser: true,
};
type QuestionProvider = "anthropic" | "responses" | "gemini";
function questionProviderOptions(provider: QuestionProvider) {
	return provider === "anthropic"
		? { model: "claude-sonnet-4", provider: "history-relay" }
		: provider === "responses"
			? { model: "gpt-5", provider: "question-responses" }
			: { model: "gemini-2.5-pro", provider: "question-gemini" };
}

// Inspect concrete native provider items, not the DB/modelMessages projection.
function nativeToolArguments(history: unknown[], toolName = "AskUserQuestion"): unknown[] {
	const inputs: unknown[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
		} else if (value && typeof value === "object") {
			const row = value as Record<string, unknown>;
			if (row.type === "tool_use" && row.name === toolName) inputs.push(row.input);
			if (row.type === "function_call" && row.name === toolName) {
				if (typeof row.arguments !== "string")
					throw new Error("Responses function_call.arguments must be native JSON text");
				// One parse must recover the object; a second parse would hide a wire bug.
				inputs.push(JSON.parse(row.arguments));
			}
			if (row.functionCall && typeof row.functionCall === "object") {
				const call = row.functionCall as Record<string, unknown>;
				if (call.name === toolName) inputs.push(call.args);
			}
			for (const entry of Object.values(row)) visit(entry);
		}
	};
	visit(history);
	return inputs;
}
function nativeQuestionResults(payload: unknown): unknown[] {
	const outputs: unknown[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
		} else if (value && typeof value === "object") {
			const row = value as Record<string, unknown>;
			if (row.tool_use_id === "question-use") outputs.push(row.content);
			if (row.type === "function_call_output" && row.call_id === "question-use")
				outputs.push(row.output);
			if (row.name === "AskUserQuestion" && row.response) outputs.push(row.response);
			for (const entry of Object.values(row)) visit(entry);
		}
	};
	visit(payload);
	return outputs;
}

for (const provider of ["anthropic", "responses", "gemini"] as const) {
	for (const profile of ["primary", "subagent"] as const) {
		test.each([
			"current",
			"legacy-sdk",
			"sdk-input-only",
			"row-only",
			"legacy-string-row",
		] as const)(`${provider} ${profile} keeps %s question arguments authored and receipts human`, async (layout) => {
			const tool = message(
				"question-message",
				"assistant",
				"",
				profile === "subagent" ? "origin" : null,
			);
			const audit = { ...questionInput, async: true, ...questionReply };
			tool.contentJson =
				layout === "row-only" || layout === "legacy-string-row"
					? []
					: [
							{
								type: "tool_use",
								id: "question-use",
								name: "AskUserQuestion",
								input:
									layout === "legacy-sdk" ? { ...questionInput, ...questionReply } : questionInput,
							},
						];
			tool.toolCalls = [
				{
					toolUseId: "question-use",
					toolName: "AskUserQuestion",
					inputJson:
						layout === "sdk-input-only"
							? null
							: layout === "legacy-string-row"
								? JSON.stringify(audit)
								: audit,
					outputJson: `The user answered: ${HUMAN_QUESTION_CANARY}`,
					status: "success",
				},
			];
			const expected =
				layout === "row-only" || layout === "legacy-string-row"
					? { ...questionInput, async: true }
					: questionInput;
			for (const placement of ["trailing", "history", "user-event"] as const) {
				const source = [tool];
				if (placement === "user-event")
					source.push(
						message(
							"question-answer-event",
							"user",
							`Human answer event: ${HUMAN_QUESTION_CANARY}`,
						),
					);
				if (placement !== "trailing")
					source.push(message("after-question", "assistant", "Acknowledged"));
				const before = structuredClone(source);
				const prepared = await buildRuntimeHistory({
					...options(profile),
					...questionProviderOptions(provider),
					sourceMessages: source,
				});
				const arguments_ = nativeToolArguments(prepared.history);
				expect(arguments_).toEqual([expected]);
				expect(JSON.stringify(arguments_)).not.toContain(HUMAN_QUESTION_CANARY);
				expect(JSON.stringify(arguments_)).not.toContain(
					questionReply.annotations["Which rollout should we use?"],
				);
				// Results ride in the history, trailing ones included.
				const results = nativeQuestionResults(prepared.history);
				expect(results).toHaveLength(1);
				expect(JSON.stringify(results)).toContain(HUMAN_QUESTION_CANARY);
				if (placement === "user-event") {
					const humanTurn = prepared.history.find((item) => {
						const row = item as { role?: string };
						return row.role === "user" && JSON.stringify(row).includes("Human answer event:");
					});
					expect(JSON.stringify(humanTurn)).toContain(HUMAN_QUESTION_CANARY);
				}
				expect(prepared.sourceMessages).toBe(source);
				expect(source).toEqual(before);
				expect(tool.toolCalls[0].inputJson).toEqual(before[0].toolCalls?.[0].inputJson);
			}
		});
	}

	test(`${provider} matches each original question by tool use ID and preserves other tool fields`, async () => {
		const secondQuestion = {
			...questionInput,
			questions: [
				{ ...questionInput.questions[0], question: "When should the second rollout start?" },
			],
			async: true,
		};
		const readInput = {
			file_path: "/authored/file.ts",
			answers: "ordinary-read-data-not-question-answer",
			annotations: { author: "ordinary-read-data" },
			deferredByUser: true,
		};
		const tool = message("multiple-question-message", "assistant", "");
		tool.contentJson = [
			{ type: "tool_use", id: "question-use", name: "AskUserQuestion", input: questionInput },
			{
				type: "tool_use",
				id: "second-question-use",
				name: "AskUserQuestion",
				input: secondQuestion,
			},
			{ type: "tool_use", id: "ordinary-read", name: "Read", input: readInput },
		];
		// Reverse row order so a projection by name/position cannot accidentally pass.
		tool.toolCalls = [
			{
				toolUseId: "second-question-use",
				toolName: "AskUserQuestion",
				inputJson: { ...secondQuestion, async: false, ...questionReply },
				outputJson: "second answer",
				status: "success",
			},
			{
				toolUseId: "question-use",
				toolName: "AskUserQuestion",
				inputJson: { ...questionInput, async: true, ...questionReply },
				outputJson: HUMAN_QUESTION_CANARY,
				status: "success",
			},
			{
				toolUseId: "ordinary-read",
				toolName: "Read",
				inputJson: readInput,
				outputJson: "file contents",
				status: "success",
			},
		];
		const source = [tool];
		const before = structuredClone(source);
		const prepared = await buildRuntimeHistory({
			...options(),
			...questionProviderOptions(provider),
			sourceMessages: source,
		});
		expect(nativeToolArguments(prepared.history)).toEqual([questionInput, secondQuestion]);
		expect(nativeToolArguments(prepared.history, "Read")).toEqual([readInput]);
		expect(source).toEqual(before);
	});

	test(`${provider} full fork replays shared persisted questions without modifying audit or SDK rows`, async () => {
		const saved = await narratorPersistence.persistAssistantMessage("primary", {
			uuid: "persisted-question",
			session_id: "question-session",
			message: {
				content: [
					{ type: "tool_use", id: "question-use", name: "AskUserQuestion", input: questionInput },
				],
			},
		});
		const call = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.messageId, saved.id),
		});
		if (!call) throw new Error("Missing persisted question call");
		const audit = { ...questionInput, async: true, ...questionReply };
		await narratorPersistence.overwriteToolCallInput("question-use", audit, call.id);
		await narratorPersistence.updateToolCallResult(
			"question-use",
			{ output: HUMAN_QUESTION_CANARY, status: "success" },
			saved.id,
			call.id,
		);
		db.insert(narratorMessageRefs)
			.values({ id: "full-fork-question-ref", narratorId: "fork", messageId: saved.id, seq: 0 })
			.run();
		const before = await db.query.narratorMessages.findFirst({
			where: (messages, { eq }) => eq(messages.id, saved.id),
		});
		const auditBefore = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, call.id),
		});
		expect(auditBefore?.inputJson).toEqual(audit);
		expect(before?.contentJson).toEqual([
			{ type: "tool_use", id: "question-use", name: "AskUserQuestion", input: questionInput },
		]);
		for (const narratorId of ["primary", "fork"]) {
			const prepared = await buildRuntimeHistory({
				...options(),
				...questionProviderOptions(provider),
				narratorId,
			});
			expect(nativeToolArguments(prepared.history)).toEqual([questionInput]);
			expect(JSON.stringify(nativeQuestionResults(prepared.history))).toContain(
				HUMAN_QUESTION_CANARY,
			);
			expect(prepared.sourceMessages[0].id).toBe(saved.id);
			expect(prepared.sourceMessages[0].toolCalls?.[0].inputJson).toEqual(audit);
		}
		expect(
			await db.query.narratorMessages.findFirst({
				where: (messages, { eq }) => eq(messages.id, saved.id),
			}),
		).toEqual(before);
		expect(
			await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, call.id) }),
		).toEqual(auditBefore);
	});

	test(`${provider} legacy orphan SDK question does not leak human fields or invent a completed call`, async () => {
		const orphan = message("orphan-question", "assistant", "");
		orphan.contentJson = [
			{
				type: "tool_use",
				id: "question-use",
				name: "AskUserQuestion",
				input: { ...questionInput, ...questionReply },
			},
		];
		const source = [orphan];
		const before = structuredClone(source);
		const prepared = await buildRuntimeHistory({
			...options(),
			...questionProviderOptions(provider),
			sourceMessages: source,
		});
		expect(nativeToolArguments(prepared.history)).toEqual([]);
		expect(JSON.stringify(prepared.history)).not.toContain(HUMAN_QUESTION_CANARY);
		expect(source).toEqual(before);
	});
}

function injectionMessage(id: string, role: "sys" | "user", text: string) {
	return {
		...message(id, role, text),
		contentJson: [{ type: "system_injection", source: "bg_agent", modelText: text }],
	};
}

for (const entry of [
	{ label: "Anthropic relay", model: "claude-sonnet-4", provider: "history-relay" },
	{ label: "Anthropic official", model: "claude-sonnet-4", provider: "history-official" },
	{ label: "Responses", model: "gpt-5", provider: "question-responses" },
	{ label: "Completions", model: "gpt-5", provider: "question-completions" },
	{ label: "Gemini", model: "gemini-2.5-pro", provider: "question-gemini" },
	{ label: "Gemini interactions", model: "gemini-2.5-pro", provider: "question-interactions" },
]) {
	test(`${entry.label} reports native source IDs retained in history, the tail included`, async () => {
		const source = [
			message("u", "user", "earlier"),
			injectionMessage("historical-notice", "sys", "same-notice-body"),
			message("a", "assistant", "answer"),
			injectionMessage("tail-notice", "sys", "same-notice-body"),
			{
				...injectionMessage("hidden-notice", "sys", "hidden-child-body"),
				parentToolUseId: "child-origin",
			},
			{ ...injectionMessage("display-notice", "sys", "display-only-body"), role: "disp" as const },
		];
		const before = structuredClone(source);
		const prepared = await buildRuntimeHistory({ ...options(), ...entry, sourceMessages: source });
		expect(prepared.replayedInjectionMessageIds).toEqual(["u", "historical-notice", "tail-notice"]);
		const historyText = JSON.stringify(prepared.history);
		expect(historyText.split("same-notice-body").length - 1).toBe(2);
		expect(historyText).not.toContain("hidden-child-body");
		expect(historyText).not.toContain("display-only-body");
		expect(prepared.currentText).toBe("");
		expect(source).toEqual(before);
	});

	for (const legacyMetadata of [false, true]) {
		test(`${entry.label} reports buffered plain input before a hint (legacy=${legacyMetadata})`, async () => {
			const buffered = message("buffered-user", "user", "buffered-plain-body");
			if (legacyMetadata)
				(buffered.contentJson as unknown[]).push({
					type: "system_injection",
					source: "subagent_message",
				});
			const prepared = await buildRuntimeHistory({
				...options(),
				...entry,
				sourceMessages: [
					message("a", "assistant", "answer"),
					buffered,
					injectionMessage("buffered-knowledge-hint", "sys", "buffered-knowledge-body"),
				],
			});
			expect(prepared.replayedInjectionMessageIds).toEqual([
				"buffered-user",
				"buffered-knowledge-hint",
			]);
			const historyText = JSON.stringify(prepared.history);
			expect(historyText).toContain("buffered-plain-body");
			expect(historyText).toContain("buffered-knowledge-body");
		});
	}

	test(`${entry.label} reports the native current-user row its history carries`, async () => {
		const prepared = await buildRuntimeHistory({
			...options(),
			...entry,
			sourceMessages: [
				message("a", "assistant", "answer"),
				injectionMessage("current-user-notice", "user", "current-native-body"),
			],
		});
		expect(prepared.replayedInjectionMessageIds).toEqual(["current-user-notice"]);
		expect(JSON.stringify(prepared.history)).toContain("current-native-body");
	});

	test(`${entry.label} skips an empty sys tail without dropping the input before it`, async () => {
		const prepared = await buildRuntimeHistory({
			...options(),
			...entry,
			sourceMessages: [
				message("a", "assistant", "answer"),
				injectionMessage("user-before-empty-tail", "user", "before-empty-tail-body"),
				injectionMessage("empty-sys-tail", "sys", ""),
			],
		});
		expect(prepared.replayedInjectionMessageIds).toEqual(["user-before-empty-tail"]);
		expect(JSON.stringify(prepared.history)).toContain("before-empty-tail-body");
	});
}

// Numeric composition/cache tests now live in narrator-context-composition.test.ts.
// Runtime history semantics remain independently covered below.

test.each([
	false,
	true,
])("real Anthropic builder retains official/nonofficial sys semantics (official=%s)", async (official) => {
	const prepared = await buildRuntimeHistory({
		...options("primary", official),
		sourceMessages: [
			message("u", "user", "earlier"),
			message("a", "assistant", "answer"),
			message("s", "sys", "fresh injection"),
		],
	});
	expect(prepared.currentText).toBe("");
	const last = prepared.history.at(-1) as { role: string; content: unknown };
	// Official endpoints take runtime context as a system message; compatible ones as user input.
	expect(last.role).toBe(official ? "system" : "user");
	expect(JSON.stringify(last.content)).toContain('<sender kind=\\"system\\" />\\nfresh injection');
});

test.each([
	"primary",
	"subagent",
] as const)("%s excludes publication receipts before provider projection", async (profile) => {
	const receipt = message("publication-result:run", "disp", "private snapshot preview");
	receipt.contentJson = [
		{
			type: "text",
			text: receipt.contentText,
			publicationResult: {
				logicalRunId: "run",
				truncated: true,
				originalBytes: 100000,
				sourceResultRef: "message:answer",
			},
		},
	];
	const tool = message("parent-tool", "assistant", "");
	tool.contentJson = [{ type: "tool_use", id: "agent", name: "Agent", input: {} }];
	tool.toolCalls = [
		{
			toolUseId: "agent",
			toolName: "Agent",
			inputJson: {},
			outputJson: "parent result survives",
			status: "success",
		},
	];
	const prepared = await buildRuntimeHistory({
		...options(profile),
		sourceMessages: [tool, receipt],
	});
	expect(prepared.sourceMessages).toContain(receipt);
	expect(prepared.modelMessages.map((row) => row.id)).toEqual(["parent-tool"]);
	expect(JSON.stringify(prepared.history)).not.toContain("private snapshot preview");
	expect(JSON.stringify(prepared.history)).toContain("parent result survives");
	expect(prepared.endsWithToolResults).toBe(true);
});

test("child placement is projected while complete tools and reasoning metadata are retained", async () => {
	const source = [message("old", "assistant", "reasoned", "origin")];
	source[0].contentJson = [
		{ type: "reasoning", text: "reason", providerMetadata: { opaque: "keep" } },
		{ type: "text", text: "reasoned" },
		{ type: "tool_use", id: "bash", name: "Bash", input: {} },
	];
	source[0].toolCalls = [
		{
			toolUseId: "bash",
			toolName: "Bash",
			inputJson: {},
			outputJson: "large output",
			status: "success",
		},
	];
	const before = JSON.stringify(source);
	const child = await buildRuntimeHistory({
		...options("subagent"),
		sourceMessages: source,
	});
	expect(JSON.stringify(source)).toBe(before);
	expect(child.sourceMessages).toBe(source);
	expect(child.modelMessages[0].parentToolUseId).toBeNull();
	expect(child.modelMessages[0].narratorId).toBe("primary");
	expect(child.modelMessages[0].toolCalls).toEqual(source[0].toolCalls);
	expect(child.modelMessages[0].contentJson).toEqual(source[0].contentJson);
	expect(child.endsWithToolResults).toBe(true);
	expect(JSON.stringify(child.history)).toContain("large output");
	expect(JSON.stringify(child.history)).toContain("reasoned");
	const primary = await buildRuntimeHistory({ ...options(), sourceMessages: source });
	expect(primary.history).toEqual([]);
});

test("reconciled epoch and raw candidates are reused without a second epoch query", async () => {
	const epochs = await import("../narrator-epochs");
	const epochQuery = spyOn(epochs, "toolLoadingEpochOf");
	const name = "HistoryCandidateTool";
	const candidates = [
		{
			name,
			description: "candidate from this request",
			parameters: z.object({}),
			execute: async () => ({ output: "ok" }),
		},
	];
	try {
		const prepared = await buildRuntimeHistory({
			...options(),
			sourceMessages: [],
			toolLoading: {
				managed: new Set([name]),
				current: new Set([name]),
				candidates,
				epoch: {
					toolNames: [name],
					definitionSnapshots: [
						{
							name,
							description: "candidate from this request",
							parameters: { type: "object", properties: {} },
						},
					],
				},
			},
		});
		expect(epochQuery).not.toHaveBeenCalled();
		expect(prepared.toolCandidates).toBe(candidates);
		expect(prepared.toolLoading?.base).toEqual(new Set([name]));
	} finally {
		epochQuery.mockRestore();
	}
});

test("runtime retains the final merged prefix state rather than its pre-publication ancestor", async () => {
	const prefix = await import("../narrator-prefix-state");
	const ancestor = {};
	const latest = {};
	const load = spyOn(prefix, "loadPrefixState").mockResolvedValue({
		baselinePrompt: "baseline",
		parts: new Map(),
		definitionSnapshots: [],
		keepalive: latest,
	});
	try {
		const built = await buildRuntimeHistory({
			...options(),
			sourceMessages: [],
			toolLoading: {
				managed: new Set(),
				current: [],
				candidates: [],
				epoch: {
					toolNames: [],
					markerId: "epoch",
					prefixState: ancestor,
					prefix: { contract: "contract", parts: [], tools: "tools" },
				},
			},
		});
		expect(built.toolLoading?.prefixState).toBe(latest);
	} finally {
		load.mockRestore();
	}
});

test("empty prompt keeps the accepted user in history and tool results never invent continuation", async () => {
	const recovered = await buildRuntimeHistory({
		...options(),
		sourceMessages: [message("u", "user", "actual accepted text")],
	});
	expect(recovered.currentText).toBe("");
	expect(recovered.currentInputText).toBe('<sender kind="human" />\nactual accepted text');
	expect(recovered.currentInputPersisted).toBe(true);
	expect(JSON.stringify(recovered.history)).toContain("actual accepted text");
	const tool = message("tool", "assistant", "");
	tool.contentJson = [{ type: "tool_use", id: "call", name: "Read", input: { path: "x" } }];
	tool.toolCalls = [
		{
			toolUseId: "call",
			toolName: "Read",
			inputJson: { path: "x" },
			outputJson: "result",
			status: "success",
		},
	];
	const replay = await buildRuntimeHistory({ ...options(), sourceMessages: [tool] });
	expect(replay.endsWithToolResults).toBe(true);
	expect(replay.currentText).toBe("");
	expect(replay.currentInputText).toBe("");
	expect(JSON.stringify(replay.history)).toContain("result");
});

test("current text stays distinct from extracted sys and source attachment metadata survives", async () => {
	const source = [
		message("u", "user", "old"),
		message("a", "assistant", "reply"),
		message("s", "sys", "pending notice"),
	];
	const prepared = await buildRuntimeHistory({
		...options(),
		sourceMessages: source,
		currentInput: "new principal input",
	});
	// The pending notice is a persisted row in history; only the new input is current text.
	expect(prepared.currentText).toBe('<sender kind="system" />\nnew principal input');
	expect(prepared.currentInputPersisted).toBe(false);
	expect(JSON.stringify(prepared.history)).toContain("pending notice");
	expect(prepared.sourceMessages).toBe(source);
});

test("snapshot-only accepted input recovers frozen attachment bytes without resolving its device path", async () => {
	const source = message("snapshot-user", "user", "");
	source.contentJson = [
		{
			type: "file_reference",
			reference: {
				id: "file",
				deviceId: "offline-device",
				path: "/never-read/current-file.ts",
				label: "frozen.ts",
			},
			snapshotText: "const accepted = 42;",
			snapshotHash: "hash-at-acceptance",
			capturedAt: time,
		},
	];
	const before = JSON.stringify(source);
	const prepared = await buildRuntimeHistory({ ...options(), sourceMessages: [source] });
	expect(prepared.currentText).toBe("");
	expect(prepared.currentInputText).toContain("const accepted = 42;");
	const history = JSON.stringify(prepared.history);
	expect(history).toContain("const accepted = 42;");
	expect(history).toContain("offline-device");
	expect(JSON.stringify(source)).toBe(before);
});

test("real loader plus currentRevision adoption retain exact history identity", async () => {
	const owner = tryClaimExecution("primary", "run");
	if (!owner) throw new Error("Missing owner");
	const store = createMailboxStore(db);
	const result = store.enqueue({
		kind: "user_input",
		narratorId: "primary",
		text: "original",
		projectedByteSize: 8,
		requestKey: "history-user",
	});
	if (result.status !== "accepted") throw new Error(result.status);
	const row = store.claimBatch("primary", { token: "claim", epoch: owner.epoch })[0];
	const saved = await narratorPersistence.persistUserMessage(
		"primary",
		"original",
		undefined,
		undefined,
		undefined,
		undefined,
		{
			mailboxClaim: {
				id: row.id,
				narratorId: row.narratorId,
				token: row.claimToken as string,
				epoch: row.claimEpoch as string,
			},
		},
	);
	await narratorPersistence.copyOnWriteMessage("primary", saved.id, {
		contentText: "edited current",
		contentJson: [{ type: "text", text: "edited current" }],
	});
	const first = await buildRuntimeHistory(options());
	expect(first.currentText).toBe("");
	expect(first.currentInputText).toBe('<sender kind="human" />\nedited current');
	expect(historyStrings(first.history)).toContain('<sender kind="human" />\nedited current');
	expect(store.getByDelivery(row.deliveryId as string)?.currentAdoptedAt).toBeNull();
	// A copy is not the built history's identity and adopts nothing.
	consumeAgentMessageHistory([...first.history]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)?.currentAdoptedAt).toBeNull();
	consumeAgentMessageHistory(first.history);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		currentAdoptedRevision: 2,
		adoptedAt: null,
	});
	expect(
		db.select().from(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, saved.id)).get()
			?.injectionConsumedAt,
	).toBeInstanceOf(Date);
});

test("grouped sys receipts are adopted with the history that carries their packet", async () => {
	const owner = tryClaimExecution("primary", "run");
	if (!owner) throw new Error("Missing owner");
	const store = createMailboxStore(db);
	const result = store.enqueue({
		kind: "user_input",
		narratorId: "primary",
		text: "one\ntwo",
		projectedByteSize: 7,
		requestKey: "grouped-sender-receipt",
	});
	if (result.status !== "accepted") throw new Error(result.status);
	const row = store.claimBatch("primary", { token: "claim", epoch: owner.epoch })[0];
	await narratorPersistence.persistSystemMessage(
		"primary",
		"one\ntwo",
		[
			{
				type: "system_injection",
				source: "subagent_message",
				modelText: "one\ntwo",
				body: {
					kind: "messages",
					items: [
						{ fromId: "agent-a", fromTitle: "A", text: "one" },
						{ fromId: "agent-b", fromTitle: "B", text: "two" },
					],
				},
			},
		],
		undefined,
		undefined,
		{
			mailboxClaim: {
				id: row.id,
				narratorId: row.narratorId,
				token: row.claimToken as string,
				epoch: row.claimEpoch as string,
			},
		},
	);
	const prepared = await buildRuntimeHistory(options());
	expect(prepared.currentText).toBe("");
	const packet = historyStrings(prepared.history);
	expect(packet).toContain('<sender kind="agent" id="agent-a" name="A" />\none');
	expect(packet).toContain('<sender kind="agent" id="agent-b" name="B" />\ntwo');
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
	consumeAgentMessageHistory(prepared.history);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).not.toBeNull();
});

test("an already prepared initial packet is not attributed or extracted twice", async () => {
	const source = message("sys", "sys", "prepared context");
	const first = await buildRuntimeHistory({
		...options(),
		sourceMessages: [source],
		currentInput: "prepared context",
	});
	expect(first.currentInputPersisted).toBe(true);
	const resumed = await buildRuntimeHistory({
		...options(),
		sourceMessages: [source],
		currentInput: first.currentInputText,
	});
	expect(resumed.currentInputPersisted).toBe(true);
	expect(resumed.currentText).toBe("");
	expect(resumed.currentInputText).toBe(first.currentInputText);
	expect(resumed.currentInputText.match(/<sender /g)).toHaveLength(1);
});

// Exercise the real provider adapters, not just the attachment formatter.
test.each([
	"relay",
	"official",
	"responses",
	"chat",
] as const)("%s prepares image/file locators for current input and historical replay", async (mode) => {
	const root = mkdtempSync(join(tmpdir(), "nf-runtime-attachments-"));
	const cwd = join(root, "worktree");
	const oldOpenAI = settings.openaiProviders;
	try {
		mkdirSync(cwd);
		mkdirSync(join(root, "uploads", "primary"), { recursive: true });
		writeFileSync(
			join(root, "uploads", "primary", "logo.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=",
				"base64",
			),
		);
		setUploadsDirForTests(join(root, "uploads"));
		settings.openaiProviders = [
			{
				id: "history-openai",
				name: "History OpenAI",
				prefix: "history-openai",
				apiKey: "isolated-test-no-network",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "gpt-5",
				apiMode: mode === "chat" ? "completions" : "responses",
			},
		];
		const file = { filename: "notes.txt", filePath: join(cwd, "notes.txt"), size: 12 };
		const user = message("image-user", "user", "use logo");
		user.createdBy = "alice";
		user.creator = { username: "Alice" };
		user.contentJson = [
			{ type: "image", imageId: "logo", filename: "logo.png", uploadNarratorId: "primary" },
			{ type: "text_file", ...file },
			{ type: "text", text: "use logo" },
		];
		user.contentText = `use logo${buildLegacyAttachedFilesHint([file])}`;
		const original = JSON.stringify(user);
		const runtimeOptions = {
			...options("primary", mode === "official"),
			...(mode === "chat" || mode === "responses"
				? { provider: "history-openai", model: "gpt-5" }
				: {}),
			attachmentCwd: cwd,
		};
		const current = await buildRuntimeHistory({
			...runtimeOptions,
			sourceMessages: [user],
			currentInput: user.contentText,
		});
		expect(current.currentInputText).toContain('<sender kind="human" id="alice" name="Alice" />');
		expect(current.currentInputText).toContain('image: "logo.png"');
		expect(current.currentInputText).toContain('file: "notes.txt"');
		expect(current.currentInputText.match(/<attached_files>/g)).toHaveLength(1);
		expect(current.currentInputText).not.toContain(join(root, "uploads"));
		expect(JSON.stringify(user)).toBe(original);
		const historical = await buildRuntimeHistory({
			...runtimeOptions,
			sourceMessages: [user, message("reply", "assistant", "done")],
		});
		const history = JSON.stringify(historical.history);
		expect(history).toContain("logo.png");
		expect(history).toContain("device: local");
		expect(history).toContain(join(cwd, ".narrafork", "attached"));
		expect(history).toContain(mode === "relay" || mode === "official" ? '"type":"image"' : "image");
		expect(readdirSync(join(cwd, ".narrafork", "attached"))).toHaveLength(1);
		const recovered = await buildRuntimeHistory({ ...runtimeOptions, sourceMessages: [user] });
		// Recovered with no prompt, the accepted row keeps its locators in history.
		expect(recovered.currentInputText).toContain('image: "logo.png"');
		expect(historyStrings(recovered.history)).toContain('image: "logo.png"');
		const child = await buildRuntimeHistory({
			...runtimeOptions,
			ownTurnPlacement: "origin",
			sourceMessages: [{ ...user, parentToolUseId: "origin" }],
			currentInput: user.contentText,
		});
		expect(child.currentInputText).toContain('image: "logo.png"');
	} finally {
		settings.openaiProviders = oldOpenAI;
		setUploadsDirForTests(null);
		rmSync(root, { recursive: true, force: true });
	}
});
