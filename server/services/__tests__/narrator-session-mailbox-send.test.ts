import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages, narratorMessages, narrators } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { RuntimeQueuePort } from "../agent-runtime/runtime-queue-port";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
const realProviderModule = { ...(await import("../../lib/agent/provider")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

for (const statement of [
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_device_id TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_cwd TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_path_flavor TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN resolved_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN canonical_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN runtime_generation INTEGER",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_targets_json TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN device_selection_source TEXT",
]) {
	try {
		sqlite.run(statement);
	} catch (error) {
		if (!String(error).includes("duplicate column name")) throw error;
	}
}

const providerCalls: string[] = [];
const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerCalls.push(params.content);
		params.onRequestStart?.();
		yield { text: "mailbox send turn ran" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

mock.module("../../lib/agent/provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "openai",
		requestedModel: "openai:test-model",
		provider: "openai",
		adapter: provider,
		model: "test-model",
	}),
}));

const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { bindRuntimeQueue } = await import("../agent-runtime/runtime-queue-port");
const { closeNarrator, hasPendingBufferedWork, sendMessage } = await import("../narrator-session");

const now = new Date().toISOString();

function seedNarrator(narratorId: string) {
	db.insert(narrators)
		.values({
			id: narratorId,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model: "openai:test-model",
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			status: "idle",
			cwd: process.cwd(),
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function enqueueCancelledNotice(narratorId: string, index: number) {
	const store = createMailboxStore(db);
	const result = store.enqueue({
		kind: "task_notice",
		noticeKind: "agent",
		narratorId,
		sourceKey: `cancelled-${index}`,
		text: `cancelled task ${index}`,
		projectedByteSize: 32,
		metadata: {
			producerKind: "agent",
			taskId: `cancelled-task-${index}`,
			logicalRunId: `cancelled-run-${index}`,
			eventKind: "cancelled",
		},
	});
	if (!("delivery" in result)) throw new Error("failed to enqueue cancellation notice");
}

async function waitForIdle(narratorId: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const row = db
			.select({ status: narrators.status })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (providerCalls.length === 1 && row?.status === "idle") return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for narrator loop");
}

beforeEach(() => {
	cleanDb(sqlite);
	providerCalls.length = 0;
});

test("consumes earlier cancelled task notices before sending a new idle user input", async () => {
	const narratorId = "mailbox-send-cancelled-notices";
	seedNarrator(narratorId);
	for (let index = 1; index <= 6; index++) enqueueCancelledNotice(narratorId, index);

	await expect(sendMessage(narratorId, "continue after cancelled reviews")).resolves.toMatchObject({
		contentText: "continue after cancelled reviews",
	});
	await waitForIdle(narratorId);

	const mailboxRows = db
		.select({ kind: narratorBufferedMessages.kind, state: narratorBufferedMessages.state })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.all();
	expect(mailboxRows).toHaveLength(7);
	expect(mailboxRows.every((row) => row.state === "materialized")).toBe(true);
	expect(providerCalls).toHaveLength(1);
	expect(
		db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, narratorId))
			.all().length,
	).toBeGreaterThanOrEqual(8);

	closeNarrator(narratorId);
});

test("does not skip an earlier user input while draining non-user mailbox work", async () => {
	const narratorId = "mailbox-send-earlier-user";
	seedNarrator(narratorId);
	const store = createMailboxStore(db);
	const earlier = store.enqueue({
		kind: "user_input",
		narratorId,
		text: "earlier user input",
		projectedByteSize: 20,
	});
	if (!("delivery" in earlier)) throw new Error("failed to enqueue earlier user input");

	await expect(sendMessage(narratorId, "later user input")).rejects.toThrow(
		"Input is queued behind earlier mailbox work",
	);

	const rows = db
		.select({ text: narratorBufferedMessages.text, state: narratorBufferedMessages.state })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.all();
	expect(rows.map((row) => row.text)).toEqual(["earlier user input", "later user input"]);
	expect(rows.every((row) => row.state === "queued")).toBe(true);
	closeNarrator(narratorId);
});

test("gates the synchronous pending-work probe on PostgreSQL", () => {
	bindRuntimeQueue({ backend: "postgres", queue: {} as RuntimeQueuePort });
	try {
		expect(() => hasPendingBufferedWork("mailbox-send-pg-gate")).toThrow(
			"cannot inspect the PostgreSQL mailbox",
		);
	} finally {
		bindRuntimeQueue({ backend: "sqlite" });
	}
});

test("uses awaited backend-neutral cleanup for buffered deliveries", async () => {
	const source = await Bun.file(new URL("../narrator-session.ts", import.meta.url)).text();
	expect(source).toContain("await cleanupBufferedTextFilesAsync(first.id)");
	expect(source).toContain("await cleanupBufferedTextFilesAsync(stagingId)");
	expect(source).not.toContain("cleanupBufferedTextFiles(");
});

afterAll(() => {
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});
