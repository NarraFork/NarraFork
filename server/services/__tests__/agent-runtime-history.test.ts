import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
				const results = nativeQuestionResults(
					placement === "trailing" ? prepared.trailingToolResults : prepared.history,
				);
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
			expect(JSON.stringify(nativeQuestionResults(prepared.trailingToolResults))).toContain(
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
		expect(prepared.trailingToolResults).toEqual([]);
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
	{
		label: "Anthropic relay",
		model: "claude-sonnet-4",
		provider: "history-relay",
		liftsTail: true,
	},
	{
		label: "Anthropic official",
		model: "claude-sonnet-4",
		provider: "history-official",
		liftsTail: false,
	},
	{ label: "Responses", model: "gpt-5", provider: "question-responses", liftsTail: false },
	{ label: "Completions", model: "gpt-5", provider: "question-completions", liftsTail: false },
	{ label: "Gemini", model: "gemini-2.5-pro", provider: "question-gemini", liftsTail: false },
	{
		label: "Gemini interactions",
		model: "gemini-2.5-pro",
		provider: "question-interactions",
		liftsTail: false,
	},
]) {
	test(`${entry.label} reports native source IDs retained in history, not its extracted tail`, async () => {
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
		expect(prepared.replayedInjectionMessageIds).toEqual(
			entry.liftsTail ? ["u", "historical-notice"] : ["u", "historical-notice", "tail-notice"],
		);
		const historyText = JSON.stringify(prepared.history);
		expect(historyText.split("same-notice-body").length - 1).toBe(entry.liftsTail ? 1 : 2);
		expect(historyText).not.toContain("hidden-child-body");
		expect(historyText).not.toContain("display-only-body");
		if (entry.liftsTail) expect(prepared.currentText).toContain("same-notice-body");
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
			expect(prepared.replayedInjectionMessageIds).toEqual(
				entry.liftsTail ? [] : ["buffered-user", "buffered-knowledge-hint"],
			);
			const historyText = JSON.stringify(prepared.history);
			if (entry.liftsTail) {
				expect(historyText).not.toContain("buffered-plain-body");
				expect(prepared.currentText).toContain("buffered-knowledge-body");
			} else {
				expect(historyText).toContain("buffered-plain-body");
				expect(historyText).toContain("buffered-knowledge-body");
			}
		});
	}

	test(`${entry.label} never reports a native current-user row as replayed history`, async () => {
		const prepared = await buildRuntimeHistory({
			...options(),
			...entry,
			sourceMessages: [
				message("a", "assistant", "answer"),
				injectionMessage("current-user-notice", "user", "current-native-body"),
			],
		});
		expect(prepared.replayedInjectionMessageIds).toEqual([]);
		expect(JSON.stringify(prepared.history)).not.toContain("current-native-body");
	});

	test(`${entry.label} handles an empty extracted sys tail without guessing from trailing text`, async () => {
		const prepared = await buildRuntimeHistory({
			...options(),
			...entry,
			sourceMessages: [
				message("a", "assistant", "answer"),
				injectionMessage("user-before-empty-tail", "user", "before-empty-tail-body"),
				injectionMessage("empty-sys-tail", "sys", ""),
			],
		});
		expect(prepared.replayedInjectionMessageIds).toEqual(
			entry.liftsTail ? [] : ["user-before-empty-tail"],
		);
		const historyText = JSON.stringify(prepared.history);
		if (entry.liftsTail) expect(historyText).not.toContain("before-empty-tail-body");
		else expect(historyText).toContain("before-empty-tail-body");
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
	if (official) {
		expect(prepared.trailingUserText).toBeUndefined();
		expect(prepared.history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "system",
					content: '<sender kind="system" />\nfresh injection',
				}),
			]),
		);
	} else {
		expect(prepared.trailingUserText).toContain("fresh injection");
		expect(prepared.currentText).toContain("fresh injection");
	}
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
	expect(JSON.stringify(prepared.trailingToolResults)).toContain("parent result survives");
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
	expect(child.trailingToolResults).toHaveLength(1);
	expect(JSON.stringify(child.trailingToolResults)).toContain("large output");
	expect(JSON.stringify(child.history)).toContain("reasoned");
	const primary = await buildRuntimeHistory({ ...options(), sourceMessages: source });
	expect(primary.history).toEqual([]);
});

test("empty prompt recovers the popped user but pure tool results never invent continuation", async () => {
	const recovered = await buildRuntimeHistory({
		...options(),
		sourceMessages: [message("u", "user", "actual accepted text")],
	});
	expect(recovered.currentText).toBe('<sender kind="human" />\nactual accepted text');
	expect(recovered.history).toEqual([]);
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
	expect(replay.isPureToolResultReplay).toBe(true);
	expect(replay.currentText).toBe("");
	expect(replay.trailingToolResults).toHaveLength(1);
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
	expect(prepared.currentText).toBe(
		'<sender kind="system" />\npending notice\n\n<sender kind="system" />\nnew principal input',
	);
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
	expect(prepared.currentText).toContain("const accepted = 42;");
	expect(prepared.currentText).toContain("offline-device");
	expect(JSON.stringify(source)).toBe(before);
	expect(prepared.history).toEqual([]);
});

test("real loader plus currentRevision adoption retain exact history identity and current-input guard", async () => {
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
	expect(first.currentText).toBe('<sender kind="human" />\nedited current');
	expect((await store.getByDelivery(row.deliveryId as string))?.currentAdoptedAt).toBeNull();
	consumeAgentMessageHistory([...first.history], first.currentText);
	consumeAgentMessageHistory(first.history, "other replacement input");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect((await store.getByDelivery(row.deliveryId as string))?.currentAdoptedAt).toBeNull();
	const accepted = await buildRuntimeHistory(options());
	consumeAgentMessageHistory(accepted.history, accepted.currentText);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(await store.getByDelivery(row.deliveryId as string)).toMatchObject({
		currentAdoptedRevision: 2,
		adoptedAt: null,
	});
	expect(
		db.select().from(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, saved.id)).get()
			?.injectionConsumedAt,
	).toBeInstanceOf(Date);
});

test("grouped extracted sys receipts require the exact projected packet before adoption", async () => {
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
	expect(prepared.currentText).toContain('<sender kind="agent" id="agent-a" name="A" />\none');
	expect(prepared.currentText).toContain('<sender kind="agent" id="agent-b" name="B" />\ntwo');
	consumeAgentMessageHistory(prepared.history, "unrelated replacement input");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect((await store.getByDelivery(row.deliveryId as string))?.adoptedAt).toBeNull();
	const accepted = await buildRuntimeHistory(options());
	consumeAgentMessageHistory(accepted.history, accepted.currentText);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect((await store.getByDelivery(row.deliveryId as string))?.adoptedAt).not.toBeNull();
});

test("an already prepared initial packet is not attributed or extracted twice", async () => {
	const source = message("sys", "sys", "prepared context");
	const first = await buildRuntimeHistory({ ...options(), sourceMessages: [source] });
	const resumed = await buildRuntimeHistory({
		...options(),
		sourceMessages: [source],
		currentInput: first.currentText,
	});
	expect(resumed.currentInputText).toBe(first.currentText);
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
		// Relay builders pop the final user row; locators must survive that recovery.
		if (mode === "relay") expect(recovered.currentText).toContain('image: "logo.png"');
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
