import { afterAll, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";

const { db, sqlite } = getTestDb();

// The worktree may contain schema work whose generated migration is intentionally
// deferred. Add only the columns selected by narrator history queries so this
// focused test remains isolated from that unrelated migration lifecycle.
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
// back. Bun's mock.module is process-wide and mock.restore() does NOT undo it,
// so without this the divergent provider mock (getProvider/resolveProviderAndModel)
// leaks into later suites (e.g. provider-resolution, AnthropicProvider).
const realProviderModule = { ...(await import("../../lib/agent/provider")) };
const realDbModule = { ...(await import("../../db")) };

mock.module("../../db", () => ({ db, sqlite }));

const providerCalls: string[] = [];
let disableContinuationNarratorId: string | null = null;
const testProvider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerCalls.push(params.content);
		params.onRequestStart?.();
		if (disableContinuationNarratorId && params.content.endsWith("\ndisable auto continuation")) {
			await db
				.update(narrators)
				.set({ autoContinuationOverride: "off" })
				.where(eq(narrators.id, disableContinuationNarratorId));
		}
		yield { text: "explicit goal turn ran" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
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

const { appendProtectedSpecTask, writeSpecFile } = await import("../spec-vfs-service");
const {
	closeNarrator,
	computeContinuationStallState,
	sendMessage,
	startSpecContinuationIfPossible,
} = await import("../narrator-session");

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for narrator loop");
}

afterAll(() => {
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});

describe("Dynamic Spec continuation stall classification", () => {
	test("suppresses the third consecutive identical taskReflection denial", () => {
		let state = { count: 0, key: undefined as string | undefined };
		for (let attempt = 1; attempt <= 3; attempt++) {
			const next = computeContinuationStallState(
				"task",
				{ hadToolUses: true, taskReflectionDenialFingerprint: "same-protected-change" },
				state,
			);
			expect(next.suppressed).toBe(attempt === 3);
			state = { count: next.count, key: next.key };
		}
	});

	test("resets on real progress and restarts for a different denial", () => {
		const first = computeContinuationStallState(
			"task",
			{ hadToolUses: true, taskReflectionDenialFingerprint: "first" },
			{ count: 0 },
		);
		const different = computeContinuationStallState(
			"task",
			{ hadToolUses: true, taskReflectionDenialFingerprint: "second" },
			first,
		);
		expect(different).toMatchObject({ count: 1, suppressed: false });

		const progress = computeContinuationStallState("task", { hadToolUses: true }, different);
		expect(progress).toEqual({ count: 0, key: undefined, suppressed: false });
	});

	test("preserves the one-turn blocked no-tool stop", () => {
		expect(computeContinuationStallState("blocked", { hadToolUses: false }, { count: 0 })).toEqual({
			count: 1,
			key: "no-tools:blocked",
			suppressed: true,
		});
	});
});

describe("explicit Dynamic Spec goal continuation", () => {
	test("starts one loop even when automatic continuation is off", async () => {
		const narratorId = "goal-loop-start-test";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
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
		});
		await appendProtectedSpecTask(narratorId, "Ship the explicit goal");

		providerCalls.length = 0;
		const result = await startSpecContinuationIfPossible(narratorId, "en", false, null);
		expect(result).toEqual({ started: true });

		await waitFor(async () => {
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { status: true },
			});
			return providerCalls.length === 1 && narrator?.status === "idle";
		});

		const messages = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, narratorId),
		});
		expect(
			messages.some((message) =>
				(message.contentJson as Array<{ type?: string }>).some(
					(block) => block.type === "spec_continuation",
				),
			),
		).toBe(true);
		expect(messages.some((message) => message.contentText === "explicit goal turn ran")).toBe(true);
		expect(providerCalls).toHaveLength(1);

		closeNarrator(narratorId);
	});

	test("stops at the current turn boundary when auto-continuation is disabled mid-turn", async () => {
		const narratorId = "disable-auto-continuation-mid-turn-test";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: narratorId,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model: "openai:test-model",
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "always",
			status: "idle",
			cwd: process.cwd(),
			createdAt: now,
			updatedAt: now,
		});
		await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Keep working", status: "doing" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		providerCalls.length = 0;
		disableContinuationNarratorId = narratorId;
		try {
			await sendMessage(narratorId, "disable auto continuation", undefined, "en");
			await waitFor(async () => {
				const narrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { status: true, autoContinuationOverride: true },
				});
				return (
					providerCalls.length === 1 &&
					narrator?.status === "idle" &&
					narrator.autoContinuationOverride === "off"
				);
			});
		} finally {
			disableContinuationNarratorId = null;
			closeNarrator(narratorId);
		}

		expect(providerCalls).toHaveLength(1);
	});

	test("runs a blocked continuation only once when the model makes no tool progress", async () => {
		const narratorId = "blocked-loop-stop-test";
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: narratorId,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model: "openai:test-model",
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "always",
			status: "idle",
			cwd: process.cwd(),
			createdAt: now,
			updatedAt: now,
		});
		await writeSpecFile(
			narratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Recover the missing evidence", status: "blocked" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		providerCalls.length = 0;
		const result = await startSpecContinuationIfPossible(narratorId, "en", false, null);
		expect(result).toEqual({ started: true });

		await waitFor(async () => {
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { status: true },
			});
			return providerCalls.length === 1 && narrator?.status === "idle";
		});

		const messages = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, narratorId),
		});
		const blockedContinuationMessages = messages.filter((message) =>
			(message.contentJson as Array<{ type?: string }>).some(
				(block) => block.type === "spec_blocked_continuation",
			),
		);
		expect(blockedContinuationMessages).toHaveLength(1);
		const blockedText = blockedContinuationMessages[0]?.contentText ?? "";
		// The self-clearable path is carried by the shared blocked-task rule, which this
		// prompt embeds rather than restating.
		expect(blockedText).toContain("add a concrete actionable unblock task");
		// It must ALSO name asking the user as a legitimate way to end the turn. Without
		// this, a task blocked ON THE USER has no legal exit and the model loops: one real
		// session was nudged 37 times over three hours on a task whose title said the user
		// had to run it.
		expect(blockedText).toContain("AskUserQuestion");
		// And it must identify itself as system-generated rather than the user speaking, so
		// a restated task is not read as the user insisting the work is unfinished.
		expect(blockedText).toContain("not the user speaking");
		expect(providerCalls).toHaveLength(1);

		closeNarrator(narratorId);
	});
});
