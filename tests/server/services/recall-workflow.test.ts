/** The agent's actual search -> source -> context -> tool-evidence workflow, on committed fixtures. */
import { afterAll, expect, mock, test } from "bun:test";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../server/db/schema";
import type { RecallMessagePage } from "../../../server/lib/recall-contract";
import { getNarratorWorkerTestDb } from "../../../server/services/__tests__/narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const realDb = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({
	...realDb,
	db: fixture.db,
	sqlite: fixture.sqlite,
	activeDatabaseBackend: "sqlite",
	postgresRuntime: null,
}));
const { ensureFts } = await import("../../../server/db/fts");
ensureFts(fixture.sqlite, { skipUncleanShutdownRebuild: true });
const { createSqliteSearchStore } = await import("../../../server/services/search/sqlite-store");
const { createSqliteSearchQueryExecutor } = await import(
	"../../../server/services/search/sqlite-worker-runner"
);
const searchStore = createSqliteSearchStore(
	createSqliteSearchQueryExecutor(fixture.sqlite.filename),
);
mock.module("../../../server/services/search/backend", () => ({ searchStore }));
const { recallTool } = await import("../../../server/lib/agent/tools/recall");
afterAll(async () => {
	await fixture.close();
	mock.module("../../../server/db", () => realDb);
});

const createdAt = "2026-07-01T00:00:00.000Z";
const source = `requirements: 原始用户约束\n${"保持原文\u{1F600}与中文完整；".repeat(80)}`;
for (const [id, title] of [
	["owner", "Original owner"],
	["fork", "Readable fork"],
]) {
	fixture.db.insert(narrators).values({ id, title, createdAt, updatedAt: createdAt }).run();
}
for (const [id, owner, role, origin, text, seq] of [
	["original", "owner", "user", "user", source, 0],
	["automatic", "fork", "user", "system", "requirements automatic restart", 50],
	["assistant", "fork", "assistant", "assistant", "requirements repeated by assistant", 100],
] as const) {
	fixture.db
		.insert(narratorMessages)
		.values({
			id,
			narratorId: owner,
			role,
			origin,
			contentJson: [{ type: "text", text }],
			contentText: text,
			createdAt,
		})
		.run();
	// The owner has rolled back/unlinked its ref, while the fork retained the original.
	fixture.db
		.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId: "fork", messageId: id, seq })
		.run();
}
fixture.db
	.insert(narratorToolCalls)
	.values({
		id: "question-ledger",
		toolUseId: "question-use",
		narratorId: "fork",
		messageId: "assistant",
		toolName: "AskUserQuestion",
		status: "success",
		inputJson: {
			questions: [{ header: "Boundary", description: "Which boundary?", options: [] }],
			answers: { Boundary: "Only communication" },
		},
		outputJson: { _text: "Recorded answer" },
		permissionDecidedBy: "reflection",
		permissionDecidedAt: createdAt,
		createdAt,
	})
	.run();
function run(input: Record<string, unknown>) {
	return recallTool.execute(input, {
		narratorId: "fork",
		signal: new AbortController().signal,
	} as never);
}
function hint(output: string, prefix: string): Record<string, unknown> {
	const line = output.split("\n").find((item) => item.startsWith(prefix));
	if (!line) throw new Error(`Missing follow-up: ${prefix}`);
	return JSON.parse(line.slice(prefix.length));
}

test("documented recipes find genuine input in a surviving fork and read all four source types", async () => {
	const found = await run({
		action: "search",
		query: "requirements",
		roles: ["user"],
		origins: ["user"],
		all_narrators: true,
		sort: "oldest",
	});
	expect(found.isError).not.toBe(true);
	const results = found.metadata?.results as {
		id: string;
		narratorId: string;
		ownerNarratorId: string;
	}[];
	expect(results).toHaveLength(1);
	expect(results[0]).toMatchObject({
		id: "original",
		narratorId: "fork",
		ownerNarratorId: "owner",
	});
	const fragment = found.output.split("Read the first hit: ")[1]?.split(". Use each hit's IDs")[0];
	if (!fragment) throw new Error("Missing source-read recipe");
	let input: Record<string, unknown> = { ...JSON.parse(fragment), max_chars: 80 };
	let original = "";
	for (let pages = 0; pages < 100; pages++) {
		const result = await run(input);
		expect(result.isError).not.toBe(true);
		const page = result.metadata as unknown as RecallMessagePage;
		expect(page.narratorId).toBe("fork");
		original += page.text;
		if (!page.hasMore) break;
		input = hint(result.output, "Continue this message: ");
	}
	expect(original).toBe(source);

	const chronology = await run({
		action: "read_conversation",
		direction: "newer",
		roles: ["user"],
		origins: ["user"],
		limit: 1,
	});
	expect((chronology.metadata?.messages as { id: string }[]).map((item) => item.id)).toEqual([
		"original",
	]);
	const execution = await run({
		action: "read_conversation",
		message_id: "assistant",
		roles: ["assistant"],
		include_tool_calls: true,
		limit: 1,
	});
	const calls = (
		execution.metadata?.messages as { toolCalls: { toolUseId: string; summary: string }[] }[]
	)[0].toolCalls;
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({ toolUseId: "question-use", summary: "Boundary" });
	const evidence = await run({
		action: "read_tool_call",
		tool_call_id: calls[0].toolUseId,
		part: "input",
	});
	expect(evidence.isError).not.toBe(true);
	expect(evidence.metadata?.permissionDecidedBy).toBe("reflection");
	expect(evidence.metadata?.question).toMatchObject({ decidedBy: "reflection" });
	expect(evidence.output).toContain("Only communication");
});
