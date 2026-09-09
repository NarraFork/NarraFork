import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narrators } from "../../db/schema";
import { settings } from "../../lib/settings";
import type { RuntimeHistoryMessage } from "../agent-runtime/history";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const { buildRuntimeHistory } = await import("../agent-runtime/history");
const { narratorPersistence } = await import("../narrator-persistence");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { consumeAgentMessageHistory } = await import("../agent-message-delivery");
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const originalProviders = settings.anthropicProviders;
const time = "2026-09-09T00:00:00.000Z";
beforeEach(() => {
	cleanDb(sqlite);
	settings.anthropicProviders = [false, true].map((officialApi) => ({
		id: officialApi ? "history-official" : "history-relay",
		name: "History test",
		prefix: officialApi ? "history-official" : "history-relay",
		apiKey: "isolated-test-no-network",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "claude-sonnet-4",
		officialApi,
	}));
	for (const id of ["primary", "child", "fork"])
		db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
});
afterEach(() => {
	for (const id of ["primary", "child", "fork"]) getExecutionOwner(id)?.release();
	settings.anthropicProviders = originalProviders;
});
afterAll(() => sqlite.close());
function options(profile: "primary" | "subagent" = "primary", official = false) {
	return {
		narratorId: profile === "primary" ? "primary" : "child",
		profile,
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
				expect.objectContaining({ role: "system", content: "fresh injection" }),
			]),
		);
	} else {
		expect(prepared.trailingUserText).toContain("fresh injection");
		expect(prepared.currentText).toContain("fresh injection");
	}
});

test("child placement is projected only and source reasoning/pruning data is never mutated", async () => {
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
		pruneBoundaryId: "old",
	});
	expect(JSON.stringify(source)).toBe(before);
	expect(child.sourceMessages).toBe(source);
	expect(child.modelMessages[0].parentToolUseId).toBeNull();
	expect(child.modelMessages[0].narratorId).toBe("primary");
	expect(child.modelMessages[0].toolCalls).toEqual([]);
	expect(JSON.stringify(child.history)).toContain("reasoned");
	const primary = await buildRuntimeHistory({ ...options(), sourceMessages: source });
	expect(primary.history).toEqual([]);
});

test("empty prompt recovers the popped user but pure tool results never invent continuation", async () => {
	const recovered = await buildRuntimeHistory({
		...options(),
		sourceMessages: [message("u", "user", "actual accepted text")],
	});
	expect(recovered.currentText).toBe("actual accepted text");
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
	expect(prepared.currentText).toBe("pending notice\n\nnew principal input");
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
	const owner = tryClaimExecution("primary", "primary");
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
	expect(first.currentText).toBe("edited current");
	expect(store.getByDelivery(row.deliveryId as string)?.currentAdoptedAt).toBeNull();
	consumeAgentMessageHistory([...first.history], first.currentText);
	consumeAgentMessageHistory(first.history, "other replacement input");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)?.currentAdoptedAt).toBeNull();
	const accepted = await buildRuntimeHistory(options());
	consumeAgentMessageHistory(accepted.history, accepted.currentText);
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
