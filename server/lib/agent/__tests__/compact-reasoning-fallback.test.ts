import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { narratorMessageRefs, narratorMessages, narrators } from "../../../db/schema";
import {
	closeRuntimeTestDb,
	getRuntimeTestDb,
} from "../../../services/__tests__/agent-runtime-test-database";
import type {
	CompactSummaryRetryHandler,
	CompactSummaryRetryPolicy,
} from "../../../services/narrator-context";
import { settings } from "../../settings";
import type { GenerateOptions, ProviderAdapter } from "../provider";
import { resetReasoningMandatoryModels } from "../reasoning-mandatory-fallback";
import { ApiError } from "../types";

// Import the real wrappers without starting their process-wide temp-file cleanup job.
spyOn(await import("../truncate"), "initTruncateCleanup").mockImplementation(() => {});
// Bind the same isolated file database for the live compact and its read workers.
const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDb = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ ...realDb, db, sqlite }));
const { summaryGenerate, summaryGenerateWithHistory } = await import("../index");
const provider = await import("../provider");
const tracking = await import("../../api-request-tracker");
const { narratorContext } = await import("../../../services/narrator-context");
const { compactLocks, queueLiveCompactModel, runSegmentCompact } = await import(
	"../../../services/narrator-compact"
);
const { narratorService } = await import("../../../services/narrator-service");

const strictModel = "anthropic:claude-haiku-4-5";
const replacement = "anthropic:claude-sonnet-4-5";
const rejection = new ApiError(
	400,
	"Reasoning is mandatory for this endpoint and cannot be disabled.",
);
const narratorId = "n-reasoning-compact";
const message = { id: "message", role: "user" as const, contentText: "Keep this evidence" };
const requests: Array<[string, GenerateOptions["reasoningEffort"]]> = [];
let onRejection: (() => void) | undefined;

async function dispatch(model: string, options?: GenerateOptions) {
	requests.push([model, options?.reasoningEffort]);
	if (model === strictModel && options?.reasoningEffort === "none") {
		onRejection?.();
		throw rejection;
	}
	return { text: `Summary from ${model}` };
}

beforeEach(() => {
	settings.agent.summaryModel = strictModel;
	settings.agent.maxTransientRetries = 0;
	requests.length = 0;
	onRejection = undefined;
	const adapter = {
		generateWithMeta: (_text, model, _system, options) => dispatch(model, options),
		generateWithHistoryWithMeta: (_system, _content, model, _locale, options) =>
			dispatch(model, options),
	} satisfies Pick<ProviderAdapter, "generateWithMeta" | "generateWithHistoryWithMeta">;
	spyOn(provider, "resolveProviderAndModel").mockImplementation((model = strictModel) => ({
		model,
		requestedModel: model,
		provider: "anthropic",
		requestedProvider: "anthropic",
		adapter: adapter as ProviderAdapter,
	}));
	spyOn(tracking, "trackApiRequest").mockImplementation(async (_options, run) => run());
});

afterEach(() => {
	resetReasoningMandatoryModels();
	mock.restore();
});

afterAll(async () => {
	await closeRuntimeTestDb(sqlite, { sessionTails: true });
	mock.module("../../../db", () => realDb);
});

function chunk(policy: CompactSummaryRetryPolicy, retry?: CompactSummaryRetryHandler) {
	return narratorContext._summarizeChunk(
		narratorId,
		[{ message, text: message.contentText }],
		"",
		"system",
		"suffix",
		0,
		2_000,
		undefined,
		strictModel,
		undefined,
		undefined,
		undefined,
		retry,
		undefined,
		policy,
	);
}

test("zero compact retries exposes the original rejection; a new call already knows the model", async () => {
	const policy = { limit: 0, used: 0 };
	const retry = mock();
	await expect(chunk(policy, retry)).rejects.toBe(rejection);
	expect(requests).toEqual([[strictModel, "none"]]);
	expect(retry).not.toHaveBeenCalled();

	expect((await chunk(policy, retry)).summary).toBe(`Summary from ${strictModel}`);
	expect(requests).toEqual([
		[strictModel, "none"],
		[strictModel, undefined],
	]);
	expect(policy.used).toBe(0);
	expect(retry).not.toHaveBeenCalled();
});

test("recovering on the same model consumes one compact retry", async () => {
	const policy = { limit: 1, used: 0 };
	const retry = mock();
	expect((await chunk(policy, retry)).summary).toBe(`Summary from ${strictModel}`);
	expect(requests).toEqual([
		[strictModel, "none"],
		[strictModel, undefined],
	]);
	expect(policy.used).toBe(1);
	expect(retry.mock.calls).toEqual([
		[expect.objectContaining({ attempt: 1, maxRetries: 1, error: rejection.message })],
	]);
});

test("a live pending model gets the next dispatch instead of an implicit retry of the old model", async () => {
	settings.agent.compactMaxRetries = 0;
	// Post-compact display estimates and queue delivery are outside this request test.
	spyOn(
		await import("../../../services/narrator-history-token-estimate"),
		"estimateNarratorBuildHistoryTokens",
	).mockResolvedValue(null);
	spyOn(
		await import("../../../services/compact-queue-drain"),
		"drainQueuedMessagesAfterCompact",
	).mockResolvedValue(undefined);
	const now = new Date().toISOString();
	db.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now }).run();
	db.insert(narratorMessages)
		.values({
			...message,
			narratorId,
			contentJson: [{ type: "text", text: message.contentText }],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "ref", narratorId, messageId: message.id, seq: 0 })
		.run();
	let markerId = "";
	onRejection = () => {
		markerId = compactLocks.get(narratorId)?.messageId ?? "";
		expect(queueLiveCompactModel(narratorId, markerId, replacement)).toEqual({
			pendingModel: replacement,
		});
	};

	await runSegmentCompact(narratorId, "en", [message.id]);
	expect(requests).toEqual([
		[strictModel, "none"],
		[replacement, "none"],
	]);
	expect(await narratorService.getSegmentCompactSummary(narratorId, markerId)).toBe(
		`Summary from ${replacement}`,
	);
});

for (const kind of ["summary", "history"] as const) {
	test(`ordinary ${kind} still transparently retries even with transient retries disabled`, async () => {
		const result =
			kind === "summary"
				? (await summaryGenerate("prompt", "system")).text
				: await summaryGenerateWithHistory("system", "prompt");
		expect(result).toBe(`Summary from ${strictModel}`);
		expect(requests).toEqual([
			[strictModel, "none"],
			[strictModel, undefined],
		]);
	});
}
