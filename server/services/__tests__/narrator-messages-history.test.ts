import type { SQLQueryBindings } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
for (const statement of [
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_path_flavor TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN canonical_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN runtime_generation INTEGER",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_targets_json TEXT",
]) {
	try {
		sqlite.run(statement);
	} catch (err) {
		if (!String(err).includes("duplicate column name")) throw err;
	}
}
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const { narratorService } = await import("../narrator-service");
const { narratorMessageQueries } = await import("../narrator-messages");

const now = "2026-07-17T10:00:00.000Z";

async function seedNarrator(id = "n1") {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, now, now);
}

async function seedMessage(params: {
	id: string;
	narratorId: string;
	seq: number;
	role: "user" | "assistant" | "system" | "disp" | "sys";
	contentText?: string;
	contentJson?: unknown;
	isCompact?: boolean;
	parentToolUseId?: string;
}) {
	await db.insert(narratorMessages).values({
		id: params.id,
		narratorId: params.narratorId,
		role: params.role,
		contentJson: params.contentJson ?? [{ type: "text", text: params.contentText ?? "" }],
		contentText: params.contentText ?? null,
		parentToolUseId: params.parentToolUseId,
		provider: "provider-that-must-not-be-loaded",
		model: "model-that-must-not-be-loaded",
		tokensIn: 123,
		commandText: "/internal-command",
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${params.id}`,
		narratorId: params.narratorId,
		messageId: params.id,
		seq: params.seq,
		isCompact: params.isCompact ? 1 : 0,
	});
}

beforeEach(() => cleanDb(sqlite));

afterAll(async () => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	await fixture.close();
});

describe("narrator model history projection", () => {
	test("summary editing caches UTF-16 characters without counting the global marker twice", async () => {
		await seedNarrator();
		await seedMessage({
			id: "compact-chars",
			narratorId: "n1",
			seq: 1,
			role: "system",
			isCompact: true,
			contentJson: [{ type: "compact", status: "compacted", summary: "legacy" }],
		});
		const updatedId = await narratorMessageQueries.updateCompactSummary(
			"n1",
			"compact-chars",
			"中文😀",
		);
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		const marker = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, updatedId),
		});
		expect(narrator?.contextSummaryChars).toBe(4);
		expect(marker?.contextCharsJson).toEqual({ segments: [] });
		await narratorMessageQueries.deleteCompactMessage("n1", updatedId);
		const cleared = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(cleared?.contextSummaryChars).toBe(0);
	});

	test("model and compact input exclude persisted display receipts but retain sys", async () => {
		await seedNarrator();
		await seedMessage({
			id: "injection",
			narratorId: "n1",
			seq: 1,
			role: "sys",
			contentText: "keep injection",
		});
		await seedMessage({
			id: "publication-result:run",
			narratorId: "n1",
			seq: 2,
			role: "disp",
			contentText: "snapshot preview",
			contentJson: [
				{
					type: "text",
					text: "snapshot preview",
					publicationResult: {
						logicalRunId: "run",
						truncated: false,
						originalBytes: 16,
						sourceResultRef: "message:answer",
					},
				},
			],
		});
		expect(
			(await narratorService.getModelHistorySinceLastCompact("n1")).map((row) => row.id),
		).toEqual(["injection"]);
		expect(
			(await narratorService.getMessagesSinceLastCompact("n1")).map((row) => row.id),
		).toContain("publication-result:run");
		expect(
			sqlite.query("SELECT id FROM narrator_messages WHERE id = ?").get("publication-result:run"),
		).toBeTruthy();
	});
	test("loads post-compact history with narrow fields", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-before",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "old",
		});
		await seedMessage({
			id: "m-compact",
			narratorId: "n1",
			seq: 2,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "old" }],
			isCompact: true,
		});
		await seedMessage({
			id: "m-after",
			narratorId: "n1",
			seq: 3,
			role: "assistant",
			contentText: "new",
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-1",
			narratorId: "n1",
			messageId: "m-after",
			toolUseId: "tu-1",
			toolName: "Bash",
			inputJson: { command: "pwd" },
			outputJson: { stdout: "/workspace" },
			status: "success",
			createdAt: now,
		});
		const messages = await narratorService.getModelHistorySinceLastCompact("n1");

		expect(messages.map((message) => message.id)).toEqual(["m-after"]);
		expect(messages[0]).toMatchObject({
			id: "m-after",
			narratorId: "n1",
			role: "assistant",
			contentText: "new",
		});
		expect(messages[0]).not.toHaveProperty("provider");
		expect(messages[0]).not.toHaveProperty("model");
		expect(messages[0]).not.toHaveProperty("tokensIn");
		expect(messages[0]).not.toHaveProperty("commandText");
		expect(messages[0].toolCalls).toEqual([
			expect.objectContaining({
				toolUseId: "tu-1",
				toolName: "Bash",
				inputJson: { command: "pwd" },
				outputJson: { stdout: "/workspace" },
				status: "success",
			}),
		]);
	});

	test("excludes metadata-only empty reasoning without hiding trailing tool results", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-tool",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentJson: [
				{
					type: "reasoning",
					text: "",
					providerMetadata: {
						anthropic: { blockIndex: 0, signature: "tool-signature" },
						signatureSource: "kimi-2",
					},
				},
				{ type: "tool_use", id: "tu-continue", name: "Read", input: { file_path: "a.ts" } },
			],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-continue",
			narratorId: "n1",
			messageId: "m-tool",
			toolUseId: "tu-continue",
			toolName: "Read",
			inputJson: { file_path: "a.ts" },
			outputJson: { content: "file contents" },
			status: "success",
			createdAt: now,
		});
		await seedMessage({
			id: "m-empty-reasoning",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentJson: [
				{
					type: "reasoning",
					text: "",
					providerMetadata: {
						anthropic: { blockIndex: 0, signature: "metadata-only-signature" },
						signatureSource: "kimi-2",
					},
				},
			],
		});

		const messages = await narratorService.getModelHistorySinceLastCompact("n1");

		expect(messages.map((message) => message.id)).toEqual(["m-tool"]);
		expect(messages[0].toolCalls).toEqual([
			expect.objectContaining({
				toolUseId: "tu-continue",
				toolName: "Read",
				status: "success",
				outputJson: { content: "file contents" },
			}),
		]);
	});

	test("preserves non-empty reasoning and empty reasoning attached to tools", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-visible-reasoning",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "visible thought" }],
		});
		await seedMessage({
			id: "m-reasoning-tool",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "" },
				{ type: "tool_use", id: "tu-preserved", name: "Read", input: {} },
			],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-preserved",
			narratorId: "n1",
			messageId: "m-reasoning-tool",
			toolUseId: "tu-preserved",
			toolName: "Read",
			inputJson: {},
			outputJson: {},
			status: "success",
			createdAt: now,
		});

		const messages = await narratorService.getModelHistorySinceLastCompact("n1");

		expect(messages.map((message) => message.id)).toEqual([
			"m-visible-reasoning",
			"m-reasoning-tool",
		]);
	});

	test("builds a bounded ContextAsk snapshot from the latest post-compact history", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-before",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "old context",
		});
		await seedMessage({
			id: "m-compact",
			narratorId: "n1",
			seq: 2,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "old" }],
			isCompact: true,
		});
		await seedMessage({
			id: "m-after",
			narratorId: "n1",
			seq: 3,
			role: "assistant",
			contentText: "first recent message",
		});
		await seedMessage({
			id: "m-long",
			narratorId: "n1",
			seq: 4,
			role: "assistant",
			contentText: `latest ${"x".repeat(7_000)}`,
		});
		await seedMessage({
			id: "m-lifecycle",
			narratorId: "n1",
			seq: 5,
			role: "system",
			contentText: "inactive compact marker",
			contentJson: [{ type: "compact", status: "error", summary: "ignored" }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-long",
			narratorId: "n1",
			messageId: "m-long",
			toolUseId: "tu-long",
			toolName: "Bash",
			inputJson: { command: "x".repeat(2_000) },
			outputJson: { stdout: "y".repeat(4_000) },
			status: "success",
			createdAt: now,
		});

		const full = await narratorService.getContextAskHistorySnapshot("n1", 2);
		expect(full.messages.map((message) => message.id)).toEqual(["m-after", "m-long"]);
		expect(full.hasMore).toBe(false);
		expect(full.messages[1].contentText?.length).toBe(6_000);
		expect(full.messages[1].contentTruncated).toBe(true);
		expect(full.messages[1].toolCalls).toEqual([
			expect.objectContaining({
				toolUseId: "tu-long",
				inputTruncated: true,
				outputTruncated: true,
			}),
		]);
		expect(full.messages[1].toolCalls[0].inputText?.length).toBeLessThanOrEqual(1_200);
		expect(full.messages[1].toolCalls[0].outputText?.length).toBeLessThanOrEqual(2_400);
		expect(full.sourceTruncated).toBe(true);

		const latestOnly = await narratorService.getContextAskHistorySnapshot("n1", 1);
		expect(latestOnly.messages.map((message) => message.id)).toEqual(["m-long"]);
		expect(latestOnly.hasMore).toBe(true);
	});

	test("projects pending permissions without loading unrelated tool-call metadata", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-pending",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentText: "tool",
		});
		await db.insert(narratorToolCalls).values([
			{
				id: "tc-visible",
				narratorId: "n1",
				messageId: "m-pending",
				toolUseId: "tu-visible",
				toolName: "Bash",
				inputJson: { command: "pwd" },
				status: "pending",
				permissionDecisionReason: "needs approval",
				permissionSuggestions: [{ type: "permission", status: "awaiting_user" }],
				executionDeviceId: "local",
				executionCwd: "/workspace",
				resolvedFilePath: "/workspace/file.txt",
				deviceSelectionSource: "local_default",
				provider: "provider-that-must-not-be-loaded",
				model: "model-that-must-not-be-loaded",
				createdAt: now,
			},
			{
				id: "tc-hidden",
				narratorId: "n1",
				messageId: "m-pending",
				toolUseId: "tu-hidden",
				toolName: "Edit",
				inputJson: { path: "/workspace/file.txt" },
				status: "pending",
				permissionSuggestions: [{ type: "danger_reflection", status: "running" }],
				createdAt: now,
			},
		]);

		const permissions = await narratorService.getPendingPermissions("n1");

		expect(permissions).toEqual([
			{
				id: "tc-visible",
				toolName: "Bash",
				toolUseId: "tu-visible",
				inputJson: { command: "pwd" },
				decisionReason: "needs approval",
				suggestions: [{ type: "permission", status: "awaiting_user" }],
				executionDeviceId: "local",
				executionCwd: "/workspace",
				executionPathFlavor: null,
				resolvedFilePath: "/workspace/file.txt",
				canonicalFilePath: null,
				runtimeGeneration: null,
				executionTargetsJson: null,
				deviceSelectionSource: "local_default",
				executionTarget: {
					deviceId: "local",
					backendKind: "local",
					cwd: "/workspace",
					lexicalPath: "/workspace/file.txt",
					resolvedFilePath: "/workspace/file.txt",
					selectionSource: "local_default",
				},
				executionTargets: [
					{
						deviceId: "local",
						backendKind: "local",
						cwd: "/workspace",
						lexicalPath: "/workspace/file.txt",
						resolvedFilePath: "/workspace/file.txt",
						selectionSource: "local_default",
					},
				],
				executionPlan: null,
				parentToolUseId: null,
				subagentNarratorId: null,
				ownerNarratorId: "n1",
			},
		]);
	});

	test("returns pending permissions for directly visible subagents with routing ownership", async () => {
		await seedNarrator("n1");
		sqlite
			.prepare(
				"INSERT INTO narrators (id, type, variant, parent_narrator_id, created_at, updated_at) VALUES (?, 'subagent', 'subagent:general', ?, ?, ?)",
			)
			.run("sub1", "n1", now, now);
		await seedMessage({
			id: "m-spawn",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu-spawn", name: "Agent", input: {} }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-spawn",
			narratorId: "n1",
			messageId: "m-spawn",
			toolUseId: "tu-spawn",
			toolName: "Agent",
			status: "running",
			createdAt: now,
		});
		await seedMessage({
			id: "m-sub-pending",
			narratorId: "sub1",
			seq: 1,
			role: "assistant",
			parentToolUseId: "tu-spawn",
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-sub-pending",
			narratorId: "sub1",
			messageId: "m-sub-pending",
			toolUseId: "tu-sub-pending",
			toolName: "Write",
			inputJson: { file_path: "secret.ts", content: "permission detail remains complete" },
			status: "pending",
			createdAt: now,
		});

		const permissions = await narratorService.getPendingPermissions("n1");
		expect(permissions).toEqual([
			expect.objectContaining({
				id: "tc-sub-pending",
				parentToolUseId: "tu-spawn",
				subagentNarratorId: "sub1",
				ownerNarratorId: "sub1",
				inputJson: {
					file_path: "secret.ts",
					content: "permission detail remains complete",
				},
			}),
		]);
	});
});

// Capture the real generated query and bindings; EXPLAIN only this isolated test DB.
async function traceReads<T>(run: () => Promise<T>) {
	const queries: Array<{ query: string; params: SQLQueryBindings[]; rows: unknown[][] }> = [];
	const prepare = sqlite.prepare.bind(sqlite);
	const spy = spyOn(sqlite, "prepare").mockImplementation(
		<T, P extends SQLQueryBindings | SQLQueryBindings[]>(query: string, bindings?: P) => {
			const statement = prepare<T, P>(query, bindings);
			const values = statement.values.bind(statement);
			statement.values = (...params) => {
				const rows = values(...params);
				queries.push({ query, params, rows });
				return rows;
			};
			return statement;
		},
	);
	try {
		return { result: await run(), queries };
	} finally {
		spy.mockRestore();
	}
}

function queryPlan(query: string, params: SQLQueryBindings[]) {
	return sqlite
		.query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${query}`)
		.all(...params)
		.map((row) => row.detail)
		.join("\n");
}

describe("pending and child catch-up query equivalence", () => {
	test("pending-first matches historical caller IDs, including shared/hidden refs and direct children only", async () => {
		for (const id of ["caller", "source", "child", "grandchild", "foreign"]) {
			await seedNarrator(id);
		}
		await db.update(narrators).set({ parentNarratorId: "caller" }).where(eq(narrators.id, "child"));
		await db
			.update(narrators)
			.set({ parentNarratorId: "child" })
			.where(eq(narrators.id, "grandchild"));
		for (const [id, owner, name] of [
			["shared-agent", "source", "Agent"],
			["task", "caller", "Task"],
			["send", "caller", "Send"],
			["not-agent", "caller", "Read"],
			["foreign-agent", "foreign", "Agent"],
		]) {
			await seedMessage({ id, narratorId: owner, seq: 1, role: "assistant" });
			await db.insert(narratorToolCalls).values({
				id: `tool-${id}`,
				narratorId: owner,
				messageId: id,
				toolUseId: id,
				toolName: name,
				status: "success",
				createdAt: now,
			});
		}
		// Reused provider IDs in another session neither duplicate nor grant refs.
		await db.insert(narratorToolCalls).values({
			id: "foreign-duplicate",
			narratorId: "foreign",
			messageId: "foreign-agent",
			toolUseId: "shared-agent",
			toolName: "Agent",
			status: "success",
			createdAt: now,
		});
		// A COW/shared-prefix caller ref need not have the tool row's narratorId.
		await db.insert(narratorMessageRefs).values({
			id: "shared-ref",
			narratorId: "caller",
			messageId: "shared-agent",
			seq: 2,
			segmentCompactId: "hidden-segment",
		});
		for (const [id, owner, parent, status] of [
			["own", "caller", "foreign-agent", "pending"],
			["shared", "child", "shared-agent", "pending"],
			["legacy-task", "child", "task", "pending"],
			["legacy-send", "child", "send", "pending"],
			["wrong-name", "child", "not-agent", "pending"],
			["no-ref", "child", "foreign-agent", "pending"],
			["not-direct", "grandchild", "shared-agent", "pending"],
			["foreign-owner", "foreign", "shared-agent", "pending"],
			["finished", "child", "shared-agent", "success"],
		] as const) {
			await seedMessage({
				id,
				narratorId: owner,
				seq: 3,
				role: "assistant",
				parentToolUseId: parent,
			});
			await db.insert(narratorToolCalls).values({
				id,
				narratorId: owner,
				messageId: id,
				toolUseId: `permission-${id}`,
				toolName: "Write",
				status,
				createdAt: now,
			});
		}
		// Frozen old two-query shape: enumerate all visible Agent/Task/Send IDs first.
		const oldIds = sqlite
			.query<{ tool_use_id: string }, []>(`
			SELECT t.tool_use_id FROM narrator_tool_calls t JOIN narrator_message_refs r
			ON r.message_id=t.message_id AND r.narrator_id='caller'
			WHERE t.tool_name IN ('Agent','Task','Send')`)
			.all()
			.map((row) => row.tool_use_id);
		const expected = sqlite
			.query<{ id: string }, string[]>(`
			SELECT t.id FROM narrator_tool_calls t JOIN narrator_messages m ON m.id=t.message_id
			JOIN narrators n ON n.id=t.narrator_id WHERE t.status='pending'
			AND (t.narrator_id='caller' OR (n.parent_narrator_id='caller'
			AND m.parent_tool_use_id IN (${oldIds.map(() => "?").join(",")})))
			ORDER BY t.created_at`)
			.all(...oldIds)
			.map((row) => row.id)
			.sort();
		const { result, queries } = await traceReads(() =>
			narratorService.getPendingPermissions("caller"),
		);
		expect(result.map((row) => row.id).sort()).toEqual(expected);
		expect(expected).toEqual(["legacy-send", "legacy-task", "own", "shared"]);
		const pending = queries.find((row) => row.query.includes('"permission_caller_tool"'));
		expect(pending).toBeDefined();
		if (!pending) throw new Error("missing pending query");
		const plan = queryPlan(pending.query, pending.params);
		expect(plan).toContain("idx_toolcalls_status_narrator_created");
		expect(plan).toContain("idx_toolcalls_tool_use_id");
		expect(plan).toContain("idx_narrator_refs_unique");
		expect(queries.filter((row) => row.query.includes('from "narrator_tool_calls"'))).toHaveLength(
			1,
		);
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, "shared-ref"));
		expect(
			(await narratorService.getPendingPermissions("caller")).map((row) => row.id).sort(),
		).toEqual(["legacy-send", "legacy-task", "own"]);
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, "ref-task"));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, "ref-send"));
		expect((await narratorService.getPendingPermissions("caller")).map((row) => row.id)).toEqual([
			"own",
		]);
	});

	test("zero pending does not first load historical Agent IDs", async () => {
		await seedNarrator("caller");
		await seedMessage({ id: "history", narratorId: "caller", seq: 1, role: "assistant" });
		await db.insert(narratorToolCalls).values(
			Array.from({ length: 128 }, (_, i) => ({
				id: `history-${i}`,
				narratorId: "caller",
				messageId: "history",
				toolUseId: `agent-${i}`,
				toolName: "Agent",
				status: "success" as const,
				createdAt: now,
			})),
		);
		const { result, queries } = await traceReads(() =>
			narratorService.getPendingPermissions("caller"),
		);
		expect(result).toEqual([]);
		const toolReads = queries.filter((row) => row.query.includes('from "narrator_tool_calls"'));
		expect(toolReads).toHaveLength(1);
		expect(toolReads[0].rows).toEqual([]);
	});

	for (const owners of [1, 100]) {
		for (const statistics of ["none", "optimize", "analyze"] as const) {
			test(`child lookup seeks with ${statistics} statistics, 10k history rows / ${owners} owners`, async () => {
				for (let i = 0; i < owners; i++) await seedNarrator(`owner-${i}`);
				sqlite.run(
					`WITH RECURSIVE numbers(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM numbers WHERE x<9999)
					INSERT INTO narrator_messages (id,narrator_id,role,content_json,created_at)
					SELECT 'history-'||x,'owner-'||(x%?),'assistant','[]',? FROM numbers`,
					[owners, now],
				);
				sqlite.run(
					`WITH RECURSIVE numbers(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM numbers WHERE x<9999)
					INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq)
					SELECT 'history-ref-'||x,'owner-'||(x%?),'history-'||x,x+1 FROM numbers`,
					[owners],
				);
				await seedMessage({ id: "parent", narratorId: "owner-0", seq: 0, role: "assistant" });
				const anchors = Array.from({ length: 8 }, (_, i) => ({ parentToolUseId: `anchor-${i}` }));
				for (const anchor of anchors) {
					await db.insert(narratorToolCalls).values({
						id: anchor.parentToolUseId,
						narratorId: "owner-0",
						messageId: "parent",
						toolUseId: anchor.parentToolUseId,
						toolName: "Read",
						status: "success",
						createdAt: now,
					});
				}
				try {
					for (const childCount of [0, 2]) {
						for (let i = 0; i < childCount; i++) {
							await seedMessage({
								id: `child-${i}`,
								narratorId: "owner-0",
								seq: 10001 + i,
								role: "assistant",
								parentToolUseId: `anchor-${i}`,
							});
						}
						if (statistics === "optimize") {
							sqlite.run("PRAGMA analysis_limit=1000");
							// 0x10000 considers every table, including on a fresh connection.
							sqlite.run("PRAGMA optimize=0x10002");
						}
						if (statistics === "analyze") {
							sqlite.run("PRAGMA analysis_limit=0");
							sqlite.run("ANALYZE");
						}
						if (statistics !== "none") {
							expect(
								sqlite
									.query(
										"SELECT stat FROM sqlite_stat1 WHERE idx='idx_messages_parent_tool_use_lookup'",
									)
									.get(),
							).not.toBeNull();
						}
						const { result, queries } = await traceReads(() =>
							narratorService.getMessagesAfter("owner-0", { childAnchors: anchors }, 1),
						);
						const childQuery = queries.find((row) =>
							row.query.includes('cross join "narrator_message_refs"'),
						);
						if (!childQuery) throw new Error("missing child query");
						const oldRows = sqlite
							.query(`SELECT r.message_id,r.seq FROM narrator_message_refs r
							JOIN narrator_messages m ON r.message_id=m.id WHERE ${anchors
								.map(
									() =>
										"(r.narrator_id='owner-0' AND r.segment_compact_id IS NULL AND r.seq>-1 AND m.parent_tool_use_id=?)",
								)
								.join(" OR ")}
							ORDER BY r.seq LIMIT 2`)
							.values(...anchors.map((a) => a.parentToolUseId));
						expect(childQuery.rows).toEqual(oldRows);
						expect(childQuery.rows).toHaveLength(childCount);
						expect(result.hitLimit).toBe(childCount > 1);
						const plan = queryPlan(childQuery.query, childQuery.params);
						expect(plan).toContain(
							"SEARCH narrator_messages USING INDEX idx_messages_parent_tool_use_lookup (parent_tool_use_id=?)",
						);
						expect(plan).toContain("idx_narrator_refs_unique");
						expect(plan).not.toContain("SCAN narrator_messages");
					}
				} finally {
					// Do not leak fixture statistics into other tests using this connection.
					if (statistics !== "none") {
						sqlite.run("DELETE FROM sqlite_stat1");
						sqlite.run("ANALYZE sqlite_schema");
					}
					sqlite.run("PRAGMA analysis_limit=0");
				}
			});
		}
	}

	test("non-SQLite child query retains the unhinted query shape", async () => {
		await seedNarrator("caller");
		await seedMessage({ id: "parent", narratorId: "caller", seq: 0, role: "assistant" });
		await db.insert(narratorToolCalls).values({
			id: "anchor",
			narratorId: "caller",
			messageId: "parent",
			toolUseId: "anchor",
			toolName: "Read",
			status: "success",
			createdAt: now,
		});
		mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "postgres" }));
		try {
			const { queries } = await traceReads(() =>
				narratorService.getMessagesAfter("caller", {
					childAnchors: [{ parentToolUseId: "anchor" }],
				}),
			);
			const childQuery = queries.find((row) =>
				row.query.includes('cross join "narrator_message_refs"'),
			);
			if (!childQuery) throw new Error("missing child query");
			expect(childQuery.query).not.toContain("INDEXED BY");
			expect(childQuery.query).not.toContain('"parent_tool_use_id" in');
		} finally {
			mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
		}
	});

	test("indexed child catch-up preserves per-anchor seq, caller refs, global limit and cursor", async () => {
		await seedNarrator("caller");
		await seedNarrator("source");
		await seedNarrator("foreign");
		await seedMessage({ id: "parent", narratorId: "source", seq: 1, role: "assistant" });
		for (const toolUseId of ["a", "b"]) {
			await db.insert(narratorToolCalls).values({
				id: `tool-${toolUseId}`,
				narratorId: "source",
				messageId: "parent",
				toolUseId,
				toolName: "Read",
				status: "success",
				createdAt: now,
			});
		}
		await db
			.insert(narratorMessageRefs)
			.values({ id: "caller-parent", narratorId: "caller", messageId: "parent", seq: 1 });
		for (const [id, parent, seq] of [
			["a-old", "a", 2],
			["b-new", "b", 3],
			["a-new", "a", 4],
			["b-old", "b", 5],
			["b-last", "b", 6],
			["hidden", "a", 7],
		] as const) {
			await seedMessage({
				id,
				narratorId: "source",
				seq,
				role: "assistant",
				parentToolUseId: parent,
			});
			await db.insert(narratorMessageRefs).values({
				id: `caller-${id}`,
				narratorId: "caller",
				messageId: id,
				seq,
				segmentCompactId: id === "hidden" ? "hidden-segment" : null,
			});
		}
		await seedMessage({
			id: "foreign-child",
			narratorId: "foreign",
			seq: 8,
			role: "assistant",
			parentToolUseId: "a",
		});
		const input = {
			childAnchors: [
				{ parentToolUseId: "a", narratorId: "source", lastMessageId: "a-old" },
				{ parentToolUseId: "b", lastMessageId: "b-old" },
			],
		};
		const { result, queries } = await traceReads(() =>
			narratorService.getMessagesAfter("caller", input, 2),
		);
		const childQuery = queries.find((row) =>
			row.query.includes('cross join "narrator_message_refs"'),
		);
		expect(childQuery).toBeDefined();
		if (!childQuery) throw new Error("missing child query");
		const oldRows = sqlite
			.query(`SELECT r.message_id, r.seq FROM narrator_message_refs r
			JOIN narrator_messages m ON r.message_id=m.id
			WHERE (r.seq>2 AND r.segment_compact_id IS NULL AND m.parent_tool_use_id='a' AND r.narrator_id='caller')
			OR (r.seq>5 AND r.segment_compact_id IS NULL AND m.parent_tool_use_id='b' AND r.narrator_id='caller')
			ORDER BY r.seq LIMIT 3`)
			.values();
		expect(childQuery.rows).toEqual(oldRows);
		expect(oldRows).toEqual([
			["a-new", 4],
			["b-last", 6],
		]);
		const plan = queryPlan(childQuery.query, childQuery.params);
		expect(plan).toContain("idx_messages_parent_tool_use_lookup");
		expect(plan).toContain("idx_narrator_refs_unique");
		expect(plan).not.toContain("idx_narrator_refs_seq");
		expect(result.hitLimit).toBe(false);
		expect(result.orphanChildren.map((row) => row.id)).toEqual(["a-new", "b-last"]);
		expect(result.cursor?.childAnchors).toEqual([
			{ parentToolUseId: "a", narratorId: "source", lastMessageId: "a-new" },
			{ parentToolUseId: "b", narratorId: "source", lastMessageId: "b-last" },
		]);
		expect((await narratorService.getMessagesAfter("caller", input, 1)).hitLimit).toBe(true);
		if (!result.cursor) throw new Error("missing catch-up cursor");
		const empty = await narratorService.getMessagesAfter("caller", result.cursor, 2);
		expect(empty.hitLimit).toBe(false);
		expect(empty.orphanChildren).toEqual([]);
		expect(empty.cursor?.childAnchors).toEqual([
			{ parentToolUseId: "a", narratorId: "caller", lastMessageId: "a-new" },
			{ parentToolUseId: "b", narratorId: "caller", lastMessageId: "b-last" },
		]);
		const forged = await narratorService.getMessagesAfter("caller", {
			childAnchors: [{ parentToolUseId: "a", narratorId: "foreign" }],
		});
		expect(forged.orphanChildren).toEqual([]);
	});
});

describe("pretext exact document transport", () => {
	test("pages the complete ordered top-level history without layout estimates", async () => {
		await seedNarrator();
		for (let seq = 1; seq <= 5; seq++) {
			await seedMessage({
				id: `m-${seq}`,
				narratorId: "n1",
				seq,
				role: seq % 2 === 0 ? "assistant" : "user",
				contentText: `message ${seq}`,
			});
		}

		// afterSeq walks forward from the very start (seq >= 0), the legacy full
		// forward-pagination path. No cursor now means the tail page (covered below).
		const first = await narratorService.getPretextDocumentPage("n1", { limit: 2, afterSeq: -1 });
		expect(first.messages.map((message) => [message.id, message.seq])).toEqual([
			["m-1", 1],
			["m-2", 2],
		]);
		expect(first).toMatchObject({ minSeq: 1, maxSeq: 2, hasNext: true, messageVersion: 0 });
		expect(first).not.toHaveProperty("heightHint");
		expect(first).not.toHaveProperty("bands");

		const second = await narratorService.getPretextDocumentPage("n1", {
			afterSeq: first.maxSeq ?? undefined,
			limit: 2,
			messageVersion: first.messageVersion,
		});
		expect(second.messages.map((message) => [message.id, message.seq])).toEqual([
			["m-3", 3],
			["m-4", 4],
		]);
		expect(second).toMatchObject({ minSeq: 3, maxSeq: 4, hasNext: true, messageVersion: 0 });

		const last = await narratorService.getPretextDocumentPage("n1", {
			afterSeq: second.maxSeq ?? undefined,
			limit: 2,
			messageVersion: first.messageVersion,
		});
		expect(last.messages.map((message) => [message.id, message.seq])).toEqual([["m-5", 5]]);
		expect(last).toMatchObject({ minSeq: 5, maxSeq: 5, hasNext: false, messageVersion: 0 });
	});

	test("returns the newest page first and walks older pages via beforeSeq", async () => {
		await seedNarrator();
		for (let seq = 1; seq <= 5; seq++) {
			await seedMessage({
				id: `m-${seq}`,
				narratorId: "n1",
				seq,
				role: seq % 2 === 0 ? "assistant" : "user",
				contentText: `message ${seq}`,
			});
		}

		// No cursor → the tail (newest) page, returned in ascending order with the
		// reverse-scroll flag.
		const tail = await narratorService.getPretextDocumentPage("n1", { limit: 2 });
		expect(tail.messages.map((message) => [message.id, message.seq])).toEqual([
			["m-4", 4],
			["m-5", 5],
		]);
		expect(tail).toMatchObject({
			minSeq: 4,
			maxSeq: 5,
			hasPrev: true,
			hasNext: false,
			messageVersion: 0,
		});

		// beforeSeq walks one page older, still ascending, still contiguous.
		const older = await narratorService.getPretextDocumentPage("n1", {
			beforeSeq: tail.minSeq ?? undefined,
			limit: 2,
			messageVersion: tail.messageVersion,
		});
		expect(older.messages.map((message) => [message.id, message.seq])).toEqual([
			["m-2", 2],
			["m-3", 3],
		]);
		expect(older).toMatchObject({ minSeq: 2, maxSeq: 3, hasPrev: true, hasNext: true });

		const oldest = await narratorService.getPretextDocumentPage("n1", {
			beforeSeq: older.minSeq ?? undefined,
			limit: 2,
			messageVersion: tail.messageVersion,
		});
		expect(oldest.messages.map((message) => [message.id, message.seq])).toEqual([["m-1", 1]]);
		expect(oldest).toMatchObject({ minSeq: 1, maxSeq: 1, hasPrev: false, hasNext: true });
	});

	test("reports an empty tail page with no rows", async () => {
		await seedNarrator();
		const tail = await narratorService.getPretextDocumentPage("n1", { limit: 2 });
		expect(tail).toMatchObject({
			messages: [],
			minSeq: null,
			maxSeq: null,
			hasNext: false,
			hasPrev: false,
		});
	});

	test("rejects a continuation page pinned to a stale document revision", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});

		await expect(
			narratorService.getPretextDocumentPage("n1", { limit: 1, messageVersion: 9 }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "PRETEXT_DOCUMENT_CHANGED",
		});
	});

	test("keeps an unpinned page when streaming only bumps the sync version", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});
		const original = narratorMessageQueries.getMessageVersion;
		narratorMessageQueries.getMessageVersion = async (narratorId: string) => {
			// A completed block / tool result advances the counter without inserting a ref.
			sqlite
				.prepare("UPDATE narrators SET message_version = message_version + 1 WHERE id = ?")
				.run(narratorId);
			return original(narratorId);
		};
		try {
			const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 1 });
			expect(page.messages.map((message) => message.id)).toEqual(["m-1"]);
			// The page reports the revision it read, not the counter that moved afterwards.
			expect(page.messageVersion).toBe(0);
		} finally {
			narratorMessageQueries.getMessageVersion = original;
		}
	});

	test("rebuilds an unpinned page when a message lands during hydration", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});
		const original = narratorMessageQueries.getMessageVersion;
		let inserted = false;
		narratorMessageQueries.getMessageVersion = async (narratorId: string) => {
			if (!inserted) {
				inserted = true;
				await seedMessage({
					id: "m-2",
					narratorId,
					seq: 2,
					role: "assistant",
					contentText: "message 2",
				});
				sqlite
					.prepare("UPDATE narrators SET message_version = message_version + 1 WHERE id = ?")
					.run(narratorId);
			}
			return original(narratorId);
		};
		try {
			const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 10 });
			expect(page.messages.map((message) => message.id)).toEqual(["m-1", "m-2"]);
			expect(page.messageVersion).toBe(1);
		} finally {
			narratorMessageQueries.getMessageVersion = original;
		}
	});

	test("rejects a pinned page if the revision changes while it is being built", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});
		const original = narratorMessageQueries.getMessageVersion;
		narratorMessageQueries.getMessageVersion = async () => 11;
		try {
			await expect(
				narratorMessageQueries.getPretextDocumentPage("n1", { limit: 1, messageVersion: 0 }),
			).rejects.toMatchObject({
				statusCode: 409,
				code: "PRETEXT_DOCUMENT_CHANGED",
			});
		} finally {
			narratorMessageQueries.getMessageVersion = original;
		}
	});

	test("rejects an unpinned page when the window keeps moving", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});
		const original = narratorMessageQueries.getMessageVersion;
		let seq = 1;
		narratorMessageQueries.getMessageVersion = async (narratorId: string) => {
			seq += 1;
			await seedMessage({
				id: `m-${seq}`,
				narratorId,
				seq,
				role: "assistant",
				contentText: `message ${seq}`,
			});
			sqlite
				.prepare("UPDATE narrators SET message_version = message_version + 1 WHERE id = ?")
				.run(narratorId);
			return original(narratorId);
		};
		try {
			await expect(
				narratorMessageQueries.getPretextDocumentPage("n1", { limit: 10 }),
			).rejects.toMatchObject({
				statusCode: 409,
				code: "PRETEXT_DOCUMENT_CHANGED",
			});
		} finally {
			narratorMessageQueries.getMessageVersion = original;
		}
	});

	test("does not rebuild a page pinned to a revision when it drifts mid-build", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});
		const pinned = await narratorMessageQueries.getMessageVersion("n1");
		const original = narratorMessageQueries.getMessageVersion;
		let calls = 0;
		narratorMessageQueries.getMessageVersion = async () => {
			calls++;
			return pinned + 1;
		};
		try {
			await expect(
				narratorMessageQueries.getPretextDocumentPage("n1", {
					limit: 1,
					messageVersion: pinned,
				}),
			).rejects.toMatchObject({ statusCode: 409, code: "PRETEXT_DOCUMENT_CHANGED" });
			expect(calls).toBe(1);
		} finally {
			narratorMessageQueries.getMessageVersion = original;
		}
	});
});

describe("latest assistant text across compact boundary", () => {
	test("recovers the last assistant text even when a compact marker is at the tail", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-user",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "do the work",
		});
		await seedMessage({
			id: "m-answer",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentText: "here is the real conclusion",
		});
		// A compact that completed right before the subagent stopped: its marker is
		// the highest-seq ref and is flagged isCompact=1, so getModelHistorySinceLastCompact
		// would return an empty set.
		await seedMessage({
			id: "m-compact",
			narratorId: "n1",
			seq: 3,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "compacted summary" }],
			isCompact: true,
		});

		// Sanity: the compact-bounded query is empty in this window.
		expect(await narratorService.getModelHistorySinceLastCompact("n1")).toEqual([]);

		const latest = await narratorService.getLatestAssistantTextAndId("n1");
		expect(latest).toEqual({ id: "m-answer", text: "here is the real conclusion" });
	});

	test("skips tool-only assistant messages and returns the most recent with text", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-text",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentText: "earlier text answer",
		});
		await seedMessage({
			id: "m-toolonly",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentText: "tool call",
			contentJson: [{ type: "tool_use", id: "tu-x", name: "Bash", input: { command: "ls" } }],
		});

		const latest = await narratorService.getLatestAssistantTextAndId("n1");
		expect(latest).toEqual({ id: "m-text", text: "earlier text answer" });
	});

	test("returns null when there is no assistant text at all", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-user",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "only a question",
		});

		expect(await narratorService.getLatestAssistantTextAndId("n1")).toBeNull();
	});

	test("getLatestSuccessfulCompactSummary returns the newest compacted summary only", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-old-compact",
			narratorId: "n1",
			seq: 1,
			role: "system",
			contentText: "[Compact] old",
			contentJson: [{ type: "compact", status: "compacted", summary: "old summary" }],
			isCompact: true,
		});
		await seedMessage({
			id: "m-new-compact",
			narratorId: "n1",
			seq: 2,
			role: "system",
			contentText: "[Compact] new",
			contentJson: [{ type: "compact", status: "compacted", summary: "newest summary" }],
			isCompact: true,
		});
		// A failed compact marker is not flagged isCompact=1 and must be ignored.
		await seedMessage({
			id: "m-failed-compact",
			narratorId: "n1",
			seq: 3,
			role: "system",
			contentText: "[Compact Failed]",
			contentJson: [{ type: "compact", status: "error", summary: "ignored" }],
		});

		const summary = await narratorService.getLatestSuccessfulCompactSummary("n1");
		expect(summary).toEqual({ id: "m-new-compact", summary: "newest summary" });
	});
});
