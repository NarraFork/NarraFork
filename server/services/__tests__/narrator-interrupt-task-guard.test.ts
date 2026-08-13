import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();

// Focused suite: keep the narrator history columns the loop reads even when the
// worktree carries unrelated deferred schema work.
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
	} catch (err) {
		if (!String(err).includes("duplicate column name")) throw err;
	}
}

// Snapshot real modules before mocking so afterAll can re-point each specifier
// back. Bun's mock.module is process-wide and mock.restore() does NOT undo it.
const realProviderModule = { ...(await import("../../lib/agent/provider")) };
const realDbModule = { ...(await import("../../db")) };

mock.module("../../db", () => ({ db, sqlite }));

/**
 * The provider chat generator is the steering wheel for these tests: it blocks
 * on a gate so the test can interrupt a genuinely running loop, and records every
 * prompt the loop sends so continuations are visible as extra calls.
 *
 * Two properties matter, and both are about passes the test does not explicitly drive:
 *
 *  1. The gate unblocks on `signal` too, as a real provider's stream does — the loop
 *     hands every attempt an AbortController.
 *  2. Setting `releaseChat = null` DISARMS the gate, so any later pass runs straight
 *     through. This is load-bearing: `sendMessage` resolves while the narrator is still
 *     `working`, and auto-continuation then starts a fresh pass. With the gate still
 *     armed that pass parks with nobody left to free it, the narrator never reaches
 *     `idle`, and a test waiting for `idle` times out — a deadlock in the harness, not
 *     in the product.
 */
let releaseChat: (() => void) | null = null;
const providerCalls: string[] = [];
const testProvider = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params: { content: string; onRequestStart?: () => void; signal?: AbortSignal }) {
		providerCalls.push(params.content);
		params.onRequestStart?.();
		if (releaseChat) {
			const signal = params.signal;
			await new Promise<void>((resolve) => {
				if (signal?.aborted) {
					resolve();
					return;
				}
				const release = releaseChat;
				const done = () => {
					signal?.removeEventListener("abort", done);
					resolve();
				};
				releaseChat = () => {
					release?.();
					done();
				};
				signal?.addEventListener("abort", done, { once: true });
			});
		}
		yield { text: "turn ran" };
	},
	formatToolResult: (toolUseId: string, output: string, isError: boolean) => ({
		toolUseId,
		output,
		isError,
	}),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

mock.module("../../lib/agent/provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "openai",
		requestedModel: "openai:test-model",
		provider: "openai",
		adapter: testProvider,
		model: "test-model",
	}),
}));

const { writeSpecFile } = await import("../spec-vfs-service");
const { closeNarrator, interruptNarrator, sendMessage } = await import("../narrator-session");

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for condition");
}

async function insertIdleNarrator(narratorId: string): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: narratorId,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "openai:test-model",
		permissionMode: "bypassPermissions",
		// "always" so an open doing task WOULD auto-continue without the guard —
		// that is exactly the behavior under test.
		autoContinuationOverride: "always",
		status: "idle",
		cwd: process.cwd(),
		createdAt: now,
		updatedAt: now,
	});
}

async function narratorStatus(narratorId: string): Promise<string | undefined> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { status: true },
	});
	return narrator?.status;
}

async function guardNoteCount(narratorId: string): Promise<number> {
	const messages = await db.query.narratorMessages.findMany({
		where: eq(narratorMessages.narratorId, narratorId),
	});
	return messages.filter((message) =>
		(message.contentJson as Array<{ type?: string; source?: string }>).some(
			(block) => block.type === "system_injection" && block.source === "interrupt_task_guard",
		),
	).length;
}

async function specContinuationCount(narratorId: string): Promise<number> {
	const messages = await db.query.narratorMessages.findMany({
		where: eq(narratorMessages.narratorId, narratorId),
	});
	return messages.filter((message) =>
		(message.contentJson as Array<{ type?: string }>).some(
			(block) => block.type === "spec_continuation",
		),
	).length;
}

afterAll(() => {
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});

beforeEach(() => {
	providerCalls.length = 0;
	releaseChat = null;
});

describe("interrupt task guard", () => {
	test("interrupting a running loop with open tasks suppresses the next spec continuation and injects a note", async () => {
		const narratorId = "interrupt-guard-open-tasks";
		await insertIdleNarrator(narratorId);
		await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Old stale task", status: "doing" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		// Start a real loop and hold the provider mid-turn so the interrupt aborts
		// a genuinely running pass (the only path finalizeInterruptedRun runs on).
		let gateOpened = false;
		releaseChat = () => {
			gateOpened = true;
		};
		const sendPromise = sendMessage(narratorId, "work on the stale task", undefined, "en");
		await waitFor(() => providerCalls.length === 1);

		expect(interruptNarrator(narratorId)).toBe(true);
		// Open the provider gate so the aborted stream can finish unwinding, then DISARM it:
		// `sendMessage` resolves while the narrator is still `working`, and the pass
		// auto-continuation starts next must not park on a gate nobody is left to open.
		releaseChat?.();
		await sendPromise;
		releaseChat = null;
		await waitFor(async () => (await narratorStatus(narratorId)) === "idle", 15_000);
		expect(gateOpened).toBe(true);

		// The guard fired: one persisted system note whose contentJson carries the
		// interrupt_task_guard system_injection block. contentJson may come back as
		// a raw string from the driver, so parse defensively before matching.
		await waitFor(async () => {
			const messages = await db.query.narratorMessages.findMany({
				where: eq(narratorMessages.narratorId, narratorId),
			});
			return messages.some((message) => {
				const blocks: unknown =
					typeof message.contentJson === "string"
						? JSON.parse(message.contentJson)
						: message.contentJson;
				return (blocks as Array<{ type?: string; source?: string }>).some(
					(block) => block.type === "system_injection" && block.source === "interrupt_task_guard",
				);
			});
		}, 15_000);

		// The next user turn must NOT be followed by a spec auto-continuation for
		// the stale task — the one-shot suppression consumes exactly that turn.
		await sendMessage(narratorId, "changed my mind", undefined, "en");
		await waitFor(async () => (await narratorStatus(narratorId)) === "idle", 15_000);
		expect(await specContinuationCount(narratorId)).toBe(0);

		closeNarrator(narratorId);
	}, 15_000);

	test("no open tasks at interrupt time means no guard note", async () => {
		const narratorId = "interrupt-guard-no-tasks";
		await insertIdleNarrator(narratorId);

		releaseChat = () => {};
		const sendPromise = sendMessage(narratorId, "hello", undefined, "en");
		await waitFor(() => providerCalls.length === 1);

		expect(interruptNarrator(narratorId)).toBe(true);
		releaseChat?.();
		await sendPromise;
		await waitFor(async () => (await narratorStatus(narratorId)) === "idle");

		expect(await guardNoteCount(narratorId)).toBe(0);
		closeNarrator(narratorId);
	});

	test("a repeated interrupt with an unchanged spec does not stack guard notes", async () => {
		const narratorId = "interrupt-guard-dedupe";
		await insertIdleNarrator(narratorId);
		await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Same task", status: "doing" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		for (let round = 0; round < 2; round++) {
			releaseChat = () => {};
			const sendPromise = sendMessage(narratorId, `round ${round}`, undefined, "en");
			await waitFor(() => providerCalls.length === round + 1);
			interruptNarrator(narratorId);
			releaseChat?.();
			await sendPromise;
			await waitFor(async () => (await narratorStatus(narratorId)) === "idle");
		}

		// The spec never changed between interrupts, so the second one stayed quiet.
		expect(await guardNoteCount(narratorId)).toBe(1);
		closeNarrator(narratorId);
	});
});
