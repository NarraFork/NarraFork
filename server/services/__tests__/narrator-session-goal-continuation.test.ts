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
	"ALTER TABLE narrator_tool_calls ADD COLUMN resolved_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN device_selection_source TEXT",
]) {
	try {
		sqlite.run(statement);
	} catch (err) {
		if (!String(err).includes("duplicate column name")) throw err;
	}
}

mock.module("../../db", () => ({ db, sqlite }));

const providerCalls: string[] = [];
const testProvider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerCalls.push(params.content);
		params.onRequestStart?.();
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

const { appendProtectedSpecTask } = await import("../spec-vfs-service");
const { closeNarrator, startSpecContinuationIfPossible } = await import("../narrator-session");

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
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
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
});
