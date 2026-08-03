/**
 * Transcript export: the properties that make an exported file trustworthy.
 *
 * The pure formatting helpers (fences, filenames, page assembly) are tested
 * directly; the streaming generator is driven against a real SQLite fixture so
 * the ref/scope/lineage predicates are exercised as SQL rather than as mocks.
 *
 * What is pinned here:
 *   - `scope: "full"` really is full — a compacted history does not silently
 *     export only its tail, which was the failure mode worth guarding
 *   - every truncation or omission is announced in the output
 *   - fenced content inside tool output cannot break the `<details>` structure
 *   - JSON ends with a `complete: true` sentinel, and a mid-stream failure still
 *     produces a parseable file that says it is incomplete
 *   - lazily-forked history is reachable without materializing (writing) refs
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const {
	assemblePage,
	buildExportFileName,
	codeBlock,
	escapeHtml,
	EXPORT_CHILD_CONTENT_LIMIT,
	EXPORT_PAGE_TOOL_IO_BUDGET,
	EXPORT_TOOL_CALLS_PER_MESSAGE,
	EXPORT_TOOL_ERROR_LIMIT,
	EXPORT_TOOL_FIELD_LIMIT,
	fenceFor,
	NARRATOR_EXPORT_DEFAULTS,
	streamNarratorExport,
} = await import("../narrator-export");

const now = "2026-08-03T10:00:00.000Z";

function seedNarrator(id = "n1", extra: { variant?: string; title?: string } = {}) {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, title, variant, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(id, extra.title ?? "Session", extra.variant ?? "primary", "claude-opus-4.6", now, now);
}

async function seedMessage(params: {
	id: string;
	narratorId: string;
	seq: number;
	role?: "user" | "assistant" | "system";
	contentJson?: unknown;
	contentText?: string;
	isCompact?: boolean;
	segmentCompactId?: string;
	parentToolUseId?: string;
	refNarratorId?: string;
}) {
	await db.insert(narratorMessages).values({
		id: params.id,
		narratorId: params.narratorId,
		role: params.role ?? "assistant",
		contentJson: params.contentJson ?? [{ type: "text", text: params.contentText ?? params.id }],
		contentText: params.contentText ?? params.id,
		parentToolUseId: params.parentToolUseId,
		model: "claude-opus-4.6",
		createdAt: now,
	});
	// A child message hangs off a tool call, not off the narrator's ref list.
	if (params.parentToolUseId) return;
	await db.insert(narratorMessageRefs).values({
		id: `ref-${params.refNarratorId ?? params.narratorId}-${params.id}`,
		narratorId: params.refNarratorId ?? params.narratorId,
		messageId: params.id,
		seq: params.seq,
		isCompact: params.isCompact ? 1 : 0,
		segmentCompactId: params.segmentCompactId ?? null,
	});
}

async function seedToolCall(params: {
	id: string;
	narratorId: string;
	messageId: string;
	toolUseId: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
	status?: "success" | "fail";
	createdAt?: string;
}) {
	await db.insert(narratorToolCalls).values({
		id: params.id,
		narratorId: params.narratorId,
		messageId: params.messageId,
		toolUseId: params.toolUseId,
		toolName: params.toolName ?? "Read",
		inputJson: params.input ?? { file_path: "a.ts" },
		outputJson: params.output ?? "ok",
		status: params.status ?? "success",
		durationMs: 12,
		createdAt: params.createdAt ?? now,
	});
}

async function collect(
	narratorId: string,
	options: Partial<typeof NARRATOR_EXPORT_DEFAULTS> = {},
	signal?: AbortSignal,
): Promise<string> {
	let out = "";
	for await (const chunk of streamNarratorExport(
		narratorId,
		{ ...NARRATOR_EXPORT_DEFAULTS, ...options },
		signal,
	)) {
		out += chunk;
	}
	return out;
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
});

describe("markdown fencing", () => {
	test("a fence outgrows any backtick run in the content", () => {
		expect(fenceFor("plain")).toBe("```");
		expect(fenceFor("has ``` inside")).toBe("````");
		expect(fenceFor("has ````` inside")).toBe("``````");
	});

	test("tool output containing a fence cannot terminate the block early", () => {
		const output = "before\n```\nfenced\n```\nafter";
		const block = codeBlock(output);
		const fence = block.slice(0, block.indexOf("\n"));
		expect(fence.length).toBeGreaterThan(3);
		// The inner fence must be strictly shorter, otherwise it would close ours.
		for (const run of output.match(/`+/g) ?? []) {
			expect(run.length).toBeLessThan(fence.length);
		}
		expect(block.endsWith(fence)).toBe(true);
	});

	test("a code block always closes on its own line", () => {
		expect(codeBlock("no trailing newline")).toBe("```\nno trailing newline\n```");
		expect(codeBlock("has trailing\n")).toBe("```\nhas trailing\n```");
	});

	test("summary text is HTML-escaped so it cannot inject markup", () => {
		expect(escapeHtml('<img src=x onerror="y">&')).toBe(
			"&lt;img src=x onerror=&quot;y&quot;&gt;&amp;",
		);
	});
});

describe("export filenames", () => {
	const at = new Date("2026-08-03T10:20:00.000Z");

	test("CR/LF and quotes are stripped so a title cannot inject a header", () => {
		const name = buildExportFileName('evil"\r\nSet-Cookie: x=1', "markdown", at);
		expect(name.ascii).not.toContain("\r");
		expect(name.ascii).not.toContain("\n");
		expect(name.ascii).not.toContain('"');
		expect(name.utf8).not.toContain("\r");
		expect(name.utf8).not.toContain("\n");
		expect(name.utf8).not.toContain('"');
	});

	test("the ASCII fallback drops non-ASCII while filename* keeps the real title", () => {
		const name = buildExportFileName("登录修复", "json", at);
		expect(name.ascii).toMatch(/^narrafork-[\x20-\x7e]+\.json$/);
		expect(name.utf8).toContain("登录修复");
		expect(name.utf8.endsWith(".json")).toBe(true);
	});

	test("an empty or symbol-only title still yields a usable name", () => {
		expect(buildExportFileName("", "markdown", at).ascii).toBe(
			"narrafork-narrator-20260803-1020.md",
		);
		expect(buildExportFileName("///", "markdown", at).ascii).toContain("narrator");
	});

	test("the extension follows the format", () => {
		expect(buildExportFileName("t", "markdown", at).ascii.endsWith(".md")).toBe(true);
		expect(buildExportFileName("t", "json", at).ascii.endsWith(".json")).toBe(true);
	});
});

describe("page assembly bookkeeping", () => {
	const message = {
		id: "m1",
		role: "assistant",
		contentJson: [{ type: "text", text: "hi" }],
		contentText: "hi",
		model: null,
		provider: null,
		origin: null,
		originLabel: null,
		createdAt: now,
		editedAt: null,
		tokensIn: null,
		outputTokens: null,
		costUsd: null,
		parentToolUseId: null,
	};

	function freshStats() {
		return {
			toolFieldsTruncated: 0,
			toolCallsOmitted: 0,
			pagesWithIoOmitted: 0,
			childMessagesOmitted: 0,
			childMessagesTruncated: 0,
			earlierHistoryOmitted: false,
		};
	}

	function toolRow(index: number, overrides: Record<string, unknown> = {}) {
		return {
			id: `tc-${index}`,
			messageId: "m1",
			toolUseId: `tu-${index}`,
			toolName: "Read",
			status: "success",
			durationMs: 1,
			errorMessage: null,
			errorBytes: 0,
			createdAt: now,
			input: "{}",
			output: "ok",
			inputBytes: 2,
			outputBytes: 2,
			ioOmitted: false,
			rank: index + 1,
			...overrides,
		};
	}

	test("tool calls beyond the per-message cap are counted, not dropped silently", () => {
		const stats = freshStats();
		const rows = Array.from({ length: EXPORT_TOOL_CALLS_PER_MESSAGE + 5 }, (_, i) => toolRow(i));
		const page = assemblePage(
			[{ refId: "r1", messageId: "m1", seq: 1, isCompact: 0, folded: false }],
			new Map([["m1", message]]),
			// biome-ignore lint/suspicious/noExplicitAny: narrowed fixture rows
			rows as any,
			[],
			true,
			stats,
		);
		expect(page[0].toolCalls).toHaveLength(EXPORT_TOOL_CALLS_PER_MESSAGE);
		expect(page[0].toolCallsOmitted).toBe(5);
		expect(stats.toolCallsOmitted).toBe(5);
	});

	test("an over-limit field is flagged with its original byte length", () => {
		const stats = freshStats();
		const page = assemblePage(
			[{ refId: "r1", messageId: "m1", seq: 1, isCompact: 0, folded: false }],
			new Map([["m1", message]]),
			// biome-ignore lint/suspicious/noExplicitAny: narrowed fixture rows
			[toolRow(0, { outputBytes: EXPORT_TOOL_FIELD_LIMIT + 999 })] as any,
			[],
			true,
			stats,
		);
		expect(page[0].toolCalls[0].outputTruncated).toBe(true);
		expect(page[0].toolCalls[0].outputBytes).toBe(EXPORT_TOOL_FIELD_LIMIT + 999);
		expect(stats.toolFieldsTruncated).toBe(1);
	});

	test("nothing is marked truncated when tool IO was not requested", () => {
		const stats = freshStats();
		const page = assemblePage(
			[{ refId: "r1", messageId: "m1", seq: 1, isCompact: 0, folded: false }],
			new Map([["m1", message]]),
			// biome-ignore lint/suspicious/noExplicitAny: narrowed fixture rows
			[toolRow(0, { input: null, output: null, outputBytes: EXPORT_TOOL_FIELD_LIMIT + 1 })] as any,
			[],
			false,
			stats,
		);
		expect(page[0].toolCalls[0].outputTruncated).toBe(false);
		expect(stats.toolFieldsTruncated).toBe(0);
	});

	test("subagent messages attach to the tool call that spawned them", () => {
		const stats = freshStats();
		const child = { ...message, id: "c1", parentToolUseId: "tu-0" };
		const page = assemblePage(
			[{ refId: "r1", messageId: "m1", seq: 1, isCompact: 0, folded: false }],
			new Map([["m1", message]]),
			// biome-ignore lint/suspicious/noExplicitAny: narrowed fixture rows
			[toolRow(0), toolRow(1)] as any,
			[child],
			true,
			stats,
		);
		expect(page[0].toolCalls[0].children.map((c) => c.id)).toEqual(["c1"]);
		expect(page[0].toolCalls[1].children).toHaveLength(0);
	});
});

describe("scope", () => {
	/** user → assistant → compact marker → post-compact assistant. */
	async function seedCompactedHistory() {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, role: "user", contentText: "early-q" });
		await seedMessage({ id: "m2", narratorId: "n1", seq: 2, contentText: "early-a" });
		await seedMessage({
			id: "m3",
			narratorId: "n1",
			seq: 3,
			role: "system",
			isCompact: true,
			contentJson: [{ type: "compact", status: "compacted", summary: "earlier work" }],
			contentText: "[Compact]",
		});
		await seedMessage({ id: "m4", narratorId: "n1", seq: 4, contentText: "late-a" });
	}

	test("full is genuinely full: pre-compact history is present", async () => {
		await seedCompactedHistory();
		const md = await collect("n1", { scope: "full" });
		expect(md).toContain("early-q");
		expect(md).toContain("early-a");
		expect(md).toContain("late-a");
	});

	test("visible is the default and starts after the last compact point", async () => {
		await seedCompactedHistory();
		expect(NARRATOR_EXPORT_DEFAULTS.scope).toBe("visible");
		const md = await collect("n1");
		expect(md).not.toContain("early-q");
		expect(md).not.toContain("early-a");
		expect(md).toContain("late-a");
	});

	/**
	 * The narrower default is only acceptable if the file admits it. These pin the
	 * disclosure so a future change cannot quietly produce a partial archive that
	 * reads as complete.
	 */
	test("a default export that hides earlier history says so, at the top and the bottom", async () => {
		await seedCompactedHistory();
		const md = await collect("n1");
		expect(md).toContain("This is not the full history.");
		// Header and footer, so it is visible without reading the whole transcript.
		const firstAt = md.indexOf("This is not the full history.");
		const lastAt = md.lastIndexOf("This is not the full history.");
		expect(firstAt).toBeLessThan(md.indexOf("## "));
		expect(lastAt).toBeGreaterThan(md.indexOf("Export summary"));
	});

	test("the JSON default export flags the omission machine-readably", async () => {
		await seedCompactedHistory();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.narrafork.earlierHistoryOmitted).toBe(true);
		expect(parsed.narrafork.scopeNote).toContain('scope="full"');
		expect(parsed.truncation.earlierHistoryOmitted).toBe(true);
		// Still a complete export *of its stated scope* — the two ideas are distinct.
		expect(parsed.complete).toBe(true);
	});

	test("an explicit full export carries no omission notice", async () => {
		await seedCompactedHistory();
		const md = await collect("n1", { scope: "full" });
		expect(md).not.toContain("This is not the full history.");
		const parsed = JSON.parse(await collect("n1", { format: "json", scope: "full" }));
		expect(parsed.narrafork.earlierHistoryOmitted).toBe(false);
		expect(parsed.narrafork.scopeNote).toBeUndefined();
	});

	test("a session with no compact point is never labelled as withholding history", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, role: "user", contentText: "only-q" });
		await seedMessage({ id: "m2", narratorId: "n1", seq: 2, contentText: "only-a" });

		const md = await collect("n1");
		expect(md).toContain("only-q");
		expect(md).not.toContain("This is not the full history.");
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.narrafork.earlierHistoryOmitted).toBe(false);
	});

	/**
	 * A compact marker at the very start hides nothing, so claiming otherwise would
	 * be a false warning — the reason the check probes for real messages instead of
	 * just testing whether a marker exists.
	 */
	test("a compact point with nothing before it raises no notice", async () => {
		seedNarrator("n1");
		await seedMessage({
			id: "m1",
			narratorId: "n1",
			seq: 1,
			role: "system",
			isCompact: true,
			contentJson: [{ type: "compact", status: "compacted", summary: "nothing prior" }],
		});
		await seedMessage({ id: "m2", narratorId: "n1", seq: 2, contentText: "after-only" });

		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.narrafork.earlierHistoryOmitted).toBe(false);
		expect(parsed.messages.map((m: { id: string }) => m.id)).toEqual(["m2"]);
	});

	test("full keeps segment-compacted messages, visible hides them", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "folded-msg" });
		await seedMessage({ id: "m2", narratorId: "n1", seq: 2, contentText: "kept-msg" });
		await db
			.update(narratorMessageRefs)
			.set({ segmentCompactId: "sc-1" })
			.where(eq(narratorMessageRefs.id, "ref-n1-m1"));

		expect(await collect("n1", { scope: "full" })).toContain("folded-msg");
		const visible = await collect("n1", { scope: "visible" });
		expect(visible).not.toContain("folded-msg");
		expect(visible).toContain("kept-msg");
	});
});

describe("lazy fork history", () => {
	/**
	 * Parent owns seq 1-2; the child materializes only seq 3 and inherits the rest
	 * via `refsInheritedFrom` / `refsBackfillCursor`.
	 */
	async function seedLazyFork() {
		seedNarrator("parent");
		seedNarrator("child");
		await seedMessage({ id: "p1", narratorId: "parent", seq: 1, contentText: "ancestor-one" });
		await seedMessage({ id: "p2", narratorId: "parent", seq: 2, contentText: "ancestor-two" });
		await seedMessage({ id: "c1", narratorId: "child", seq: 3, contentText: "child-own" });
		sqlite
			.prepare(
				"UPDATE narrators SET refs_inherited_from = 'parent', refs_backfill_cursor = 3 WHERE id = 'child'",
			)
			.run();
	}

	test("inherited history is exported", async () => {
		await seedLazyFork();
		const md = await collect("child");
		expect(md).toContain("ancestor-one");
		expect(md).toContain("ancestor-two");
		expect(md).toContain("child-own");
	});

	test("exporting does not materialize refs — it stays a read", async () => {
		await seedLazyFork();
		const before = sqlite
			.prepare("SELECT COUNT(*) AS n FROM narrator_message_refs WHERE narrator_id = 'child'")
			.get() as { n: number };
		await collect("child");
		const after = sqlite
			.prepare("SELECT COUNT(*) AS n FROM narrator_message_refs WHERE narrator_id = 'child'")
			.get() as { n: number };
		expect(after.n).toBe(before.n);

		const cursor = sqlite
			.prepare("SELECT refs_backfill_cursor AS c FROM narrators WHERE id = 'child'")
			.get() as { c: number | null };
		expect(cursor.c).toBe(3);
	});

	/**
	 * Regression: seq is not unique across the lineage scope, so a seq-only paging
	 * cursor skipped every same-seq row that fell past a page boundary. With 100
	 * refs per page, 120 distinct messages all sharing seq 1 in the parent must
	 * still all come out.
	 */
	test("same-seq refs spanning a page boundary are all exported", async () => {
		seedNarrator("parent");
		seedNarrator("child");
		for (let i = 0; i < 120; i++) {
			await seedMessage({
				id: `p-${i}`,
				narratorId: "parent",
				seq: 1,
				contentText: `dup-${i}`,
			});
		}
		sqlite
			.prepare(
				"UPDATE narrators SET refs_inherited_from = 'parent', refs_backfill_cursor = 2 WHERE id = 'child'",
			)
			.run();

		const parsed = JSON.parse(await collect("child", { format: "json" }));
		expect(parsed.messageCount).toBe(120);
		expect(parsed.complete).toBe(true);
		const ids = new Set(parsed.messages.map((m: { id: string }) => m.id));
		expect(ids.size).toBe(120);
	});

	test("a message reachable twice is exported once", async () => {
		await seedLazyFork();
		// Give the child its own ref to a message the parent also holds.
		await db.insert(narratorMessageRefs).values({
			id: "ref-child-p1",
			narratorId: "child",
			messageId: "p1",
			seq: 1,
			isCompact: 0,
		});
		const json = JSON.parse(await collect("child", { format: "json" }));
		const ids = json.messages.map((m: { id: string }) => m.id);
		expect(ids.filter((id: string) => id === "p1")).toHaveLength(1);
	});
});

describe("markdown rendering", () => {
	test("thinking, images and compact markers each get a representation", async () => {
		seedNarrator("n1");
		await seedMessage({
			id: "m1",
			narratorId: "n1",
			seq: 1,
			contentJson: [
				{ type: "thinking", thinking: "internal reasoning" },
				{ type: "text", text: "visible answer" },
				{ type: "image", imageId: "img-42" },
			],
		});
		await seedMessage({
			id: "m2",
			narratorId: "n1",
			seq: 2,
			role: "system",
			isCompact: true,
			contentJson: [{ type: "compact", status: "compacted", summary: "what happened" }],
		});

		// Full scope: the compact marker is the newest message here, so the default
		// `visible` scope would correctly export nothing and there would be no blocks
		// left to assert on.
		const md = await collect("n1", { scope: "full" });
		expect(md).toContain("<summary>Thinking</summary>");
		expect(md).toContain("internal reasoning");
		expect(md).toContain("visible answer");
		expect(md).toContain("img-42");
		expect(md).toContain("History compacted");
		expect(md).toContain("what happened");
	});

	test("details blocks keep the blank lines that make inner markdown render", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "tu1" });

		const md = await collect("n1");
		expect(md).toContain("</summary>\n\n");
		expect(md).toContain("\n\n</details>");
	});

	test("tool bodies are omitted entirely when not requested", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedToolCall({
			id: "tc1",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "tu1",
			input: { secret_path: "/etc/passwd" },
			output: "sensitive-body",
		});

		const md = await collect("n1", { includeToolIO: false });
		expect(md).toContain("Read");
		expect(md).not.toContain("sensitive-body");
		expect(md).not.toContain("secret_path");
	});

	test("labels follow the requested language", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, role: "user", contentText: "q" });
		expect(await collect("n1", { lang: "en" })).toContain("## User");
		expect(await collect("n1", { lang: "zh-CN" })).toContain("## 用户");
	});

	test("an oversized output is labelled with its true size", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedToolCall({
			id: "tc1",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "tu1",
			output: "x".repeat(EXPORT_TOOL_FIELD_LIMIT + 500),
		});

		const md = await collect("n1");
		expect(md).toMatch(/truncated, \d+ bytes original/);
		expect(md).toContain("Truncated tool fields: 1");
	});

	test("the footer states completion", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		const md = await collect("n1");
		expect(md).toContain("Export summary");
		expect(md).toContain("Messages: 1");
		expect(md).toContain("Export complete.");
	});
});

describe("json completeness", () => {
	test("a successful export parses and ends with the sentinel", async () => {
		seedNarrator("n1", { title: "My session" });
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, role: "user", contentText: "hello" });
		await seedMessage({ id: "m2", narratorId: "n1", seq: 2, contentText: "world" });

		const raw = await collect("n1", { format: "json" });
		const parsed = JSON.parse(raw);
		expect(parsed.complete).toBe(true);
		expect(parsed.partial).toBe(false);
		expect(parsed.error).toBeUndefined();
		expect(parsed.messageCount).toBe(2);
		expect(parsed.narrator.title).toBe("My session");
		expect(parsed.narrafork.exportVersion).toBe(1);
		// The sentinel must be last so a truncated file cannot appear complete.
		expect(raw.trimEnd().endsWith("}")).toBe(true);
		expect(raw.lastIndexOf('"complete"')).toBeGreaterThan(raw.lastIndexOf('"messages"'));
	});

	test("raw content blocks survive the round trip", async () => {
		seedNarrator("n1");
		const blocks = [
			{ type: "thinking", thinking: "why" },
			{ type: "text", text: "because" },
		];
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, contentJson: blocks });

		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.messages[0].content).toEqual(blocks);
	});

	test("an empty history is a valid, complete export", async () => {
		seedNarrator("n1");
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.messages).toEqual([]);
		expect(parsed.complete).toBe(true);
		expect(parsed.messageCount).toBe(0);
	});

	/**
	 * Force a failure *inside* the paging loop, after the header has been emitted.
	 *
	 * A trigger is used rather than dropping the table: `cleanDb` only deletes
	 * rows, so a dropped table would stay dropped and break every later test in
	 * the file. The trigger is installed and removed within the single test.
	 */
	async function withFailingRefReads(body: () => Promise<void>) {
		sqlite.run(
			`CREATE TEMP VIEW IF NOT EXISTS _unused_export_probe AS SELECT 1;
			 CREATE TRIGGER _export_boom BEFORE DELETE ON narrator_message_refs
			 BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
		);
		// The trigger alone does not affect SELECTs, so break reads by renaming the
		// table for the duration of the call and restoring it immediately after.
		sqlite.run("DROP TRIGGER _export_boom");
		sqlite.run("ALTER TABLE narrator_message_refs RENAME TO narrator_message_refs_hidden");
		try {
			await body();
		} finally {
			sqlite.run("ALTER TABLE narrator_message_refs_hidden RENAME TO narrator_message_refs");
		}
	}

	test("a mid-stream failure yields a parseable file that says it is incomplete", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "first" });

		await withFailingRefReads(async () => {
			const raw = await collect("n1", { format: "json" });
			const parsed = JSON.parse(raw);
			expect(parsed.complete).toBe(false);
			expect(parsed.partial).toBe(true);
			expect(typeof parsed.error.message).toBe("string");
			expect(parsed.error.message.length).toBeGreaterThan(0);
		});
	});

	test("a mid-stream failure is announced in markdown too", async () => {
		seedNarrator("n1");
		await withFailingRefReads(async () => {
			const md = await collect("n1");
			expect(md).toContain("Export incomplete");
			expect(md).not.toContain("Export complete.");
		});
	});

	test("tool IO keys are absent from JSON when not requested", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "tu1" });

		const parsed = JSON.parse(await collect("n1", { format: "json", includeToolIO: false }));
		const tool = parsed.messages[0].toolCalls[0];
		expect(tool.toolName).toBe("Read");
		expect(tool.status).toBe("success");
		expect("input" in tool).toBe(false);
		expect("output" in tool).toBe(false);
	});
});

/**
 * The page budget is the only thing standing between a large transcript and a
 * multi-hundred-megabyte synchronous read on the thread that serves every other
 * request. It used to be a JS-side check that ran *after* `bun:sqlite` had handed
 * the bytes over, so it bounded nothing; these tests pin the property that
 * actually matters — what comes back is bounded, and what was withheld says so.
 */
describe("page byte budget", () => {
	const FIELD = "x".repeat(EXPORT_TOOL_FIELD_LIMIT);
	/** Each row projects two clamped fields, so this many rows fill the budget exactly. */
	const ROWS_THAT_FIT = Math.floor(EXPORT_PAGE_TOOL_IO_BUDGET / (2 * EXPORT_TOOL_FIELD_LIMIT));
	const OVERSHOOT = 12;

	/**
	 * Spread over two messages so the per-message cap (100) is not what limits the
	 * page: the budget has to be the binding constraint for this to test anything.
	 */
	async function seedBudgetOverflow() {
		seedNarrator("n1");
		const total = ROWS_THAT_FIT + OVERSHOOT;
		const perMessage = Math.ceil(total / 2);
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedMessage({ id: "m2", narratorId: "n1", seq: 2 });
		for (let i = 0; i < total; i++) {
			const messageId = i < perMessage ? "m1" : "m2";
			await seedToolCall({
				id: `tc-${i}`,
				narratorId: "n1",
				messageId,
				toolUseId: `tu-${i}`,
				input: FIELD,
				output: FIELD,
				// Distinct timestamps keep the rank order deterministic.
				createdAt: new Date(Date.parse(now) + i).toISOString(),
			});
		}
		return total;
	}

	test("returned tool bodies never exceed the page budget", async () => {
		const total = await seedBudgetOverflow();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));

		const tools = parsed.messages.flatMap(
			(m: { toolCalls: Array<Record<string, unknown>> }) => m.toolCalls,
		);
		expect(tools).toHaveLength(total);

		const returnedBytes = tools.reduce(
			(sum: number, t: { input: string | null; output: string | null }) =>
				sum + (t.input?.length ?? 0) + (t.output?.length ?? 0),
			0,
		);
		expect(returnedBytes).toBeLessThanOrEqual(EXPORT_PAGE_TOOL_IO_BUDGET);
		// Not vacuously bounded: the budget was actually filled, not sidestepped by
		// returning nothing.
		expect(returnedBytes).toBeGreaterThan(EXPORT_PAGE_TOOL_IO_BUDGET / 2);
	});

	test("what the budget withheld is labelled, not silently blank", async () => {
		const total = await seedBudgetOverflow();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		const tools = parsed.messages.flatMap(
			(m: { toolCalls: Array<Record<string, unknown>> }) => m.toolCalls,
		);

		const omitted = tools.filter((t: { ioOmitted: boolean }) => t.ioOmitted);
		expect(omitted).toHaveLength(total - ROWS_THAT_FIT);
		// Metadata survives, so the call is still visible as having happened, and the
		// real size is stated even though the body is gone.
		for (const tool of omitted) {
			expect(tool.input).toBeNull();
			expect(tool.output).toBeNull();
			expect(tool.toolName).toBe("Read");
			expect(tool.outputBytes).toBeGreaterThan(EXPORT_TOOL_FIELD_LIMIT);
		}
		expect(parsed.truncation.pagesWithIoOmitted).toBe(1);
	});

	test("markdown announces the withheld bodies too", async () => {
		await seedBudgetOverflow();
		const md = await collect("n1", { lang: "en" });
		expect(md).toContain("tool body omitted: page budget reached");
		expect(md).toContain("Pages over the tool body budget: 1");
	});

	test("bodies are read for the rows that fit, and clamped there", async () => {
		await seedBudgetOverflow();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		const tools = parsed.messages.flatMap(
			(m: { toolCalls: Array<Record<string, unknown>> }) => m.toolCalls,
		);
		const kept = tools.filter((t: { ioOmitted: boolean }) => !t.ioOmitted);
		expect(kept).toHaveLength(ROWS_THAT_FIT);
		for (const tool of kept) {
			expect(tool.output.length).toBeLessThanOrEqual(EXPORT_TOOL_FIELD_LIMIT);
			// The stored value is the field plus JSON quoting, so it is over the limit
			// and must be flagged as clamped.
			expect(tool.outputTruncated).toBe(true);
		}
	});

	test("opting out of tool IO reads no bodies and claims no budget pressure", async () => {
		await seedBudgetOverflow();
		const parsed = JSON.parse(await collect("n1", { format: "json", includeToolIO: false }));
		const tools = parsed.messages.flatMap(
			(m: { toolCalls: Array<Record<string, unknown>> }) => m.toolCalls,
		);
		for (const tool of tools) {
			expect("input" in tool).toBe(false);
			expect("ioOmitted" in tool).toBe(false);
		}
		expect(parsed.truncation.pagesWithIoOmitted).toBe(0);
		expect(parsed.truncation.toolFieldsTruncated).toBe(0);
	});
});

describe("subagent message clamping", () => {
	async function seedOversizedChild() {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "tu1" });
		await seedMessage({
			id: "c1",
			narratorId: "n1",
			seq: 0,
			parentToolUseId: "tu1",
			contentJson: [{ type: "text", text: "c".repeat(EXPORT_CHILD_CONTENT_LIMIT * 2) }],
			contentText: `head-${"c".repeat(EXPORT_CHILD_CONTENT_LIMIT * 2)}`,
		});
	}

	test("an oversized child arrives as a labelled excerpt, not whole", async () => {
		await seedOversizedChild();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		const child = parsed.messages[0].toolCalls[0].subagentMessages[0];

		expect(child.contentTruncated).toBe(true);
		expect(child.contentBytes).toBeGreaterThan(EXPORT_CHILD_CONTENT_LIMIT);
		expect(child.contentText.length).toBeLessThanOrEqual(EXPORT_CHILD_CONTENT_LIMIT);
		// A clamped JSON document does not parse, so blocks cannot be offered — the
		// text excerpt is what survives, and the flag says which one this is.
		expect(child.content).toEqual([]);
		expect(parsed.truncation.childMessagesTruncated).toBe(1);
	});

	test("the markdown excerpt is flagged where it is read and in the footer", async () => {
		await seedOversizedChild();
		const md = await collect("n1", { lang: "en" });
		expect(md).toContain("head-");
		expect(md).toMatch(/truncated, \d+ bytes original/);
		expect(md).toContain("Truncated subagent messages: 1");
	});

	test("a long tool error message is clamped and says so", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedToolCall({
			id: "tc1",
			narratorId: "n1",
			messageId: "m1",
			toolUseId: "tu1",
			status: "fail",
		});
		// error_message carries whole tool outputs in practice, so it is as unbounded
		// as the bodies are and needs the same treatment.
		await db
			.update(narratorToolCalls)
			.set({ errorMessage: "e".repeat(EXPORT_TOOL_ERROR_LIMIT * 3) })
			.where(eq(narratorToolCalls.id, "tc1"));

		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		const tool = parsed.messages[0].toolCalls[0];
		expect(tool.errorMessage.length).toBe(EXPORT_TOOL_ERROR_LIMIT);
		expect(tool.errorTruncated).toBe(true);
		expect(tool.errorBytes).toBe(EXPORT_TOOL_ERROR_LIMIT * 3);
	});

	test("the subagent-omission count reaches the footer", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		await seedToolCall({ id: "tc1", narratorId: "n1", messageId: "m1", toolUseId: "tu1" });
		const md = await collect("n1", { lang: "en" });
		// The stat existed but was never disclosed; the count is 0 here, and that is
		// exactly what has to be visible for a non-zero one to be trustworthy.
		expect(md).toContain("Omitted subagent messages (at least): 0");
	});
});

/**
 * The clamps above must not change what a normal transcript looks like. Anything
 * small enough to fit is expected to come out byte-for-byte, with every truncation
 * flag reading false.
 */
describe("no regression for ordinary exports", () => {
	async function seedSmallSession() {
		seedNarrator("n1", { title: "Small" });
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, role: "user", contentText: "please" });
		await seedMessage({ id: "m2", narratorId: "n1", seq: 2, contentText: "on it" });
		await seedToolCall({
			id: "tc1",
			narratorId: "n1",
			messageId: "m2",
			toolUseId: "tu1",
			input: { file_path: "src/index.ts" },
			output: "file contents here",
		});
		await seedMessage({
			id: "c1",
			narratorId: "n1",
			seq: 0,
			parentToolUseId: "tu1",
			contentJson: [{ type: "text", text: "subagent said this" }],
			contentText: "subagent said this",
		});
	}

	test("small tool bodies come back whole and unflagged", async () => {
		await seedSmallSession();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		const tool = parsed.messages[1].toolCalls[0];

		expect(JSON.parse(tool.input)).toEqual({ file_path: "src/index.ts" });
		expect(JSON.parse(tool.output)).toBe("file contents here");
		expect(tool.inputTruncated).toBe(false);
		expect(tool.outputTruncated).toBe(false);
		expect(tool.ioOmitted).toBe(false);
		expect(tool.errorTruncated).toBe(false);
	});

	test("a small subagent message keeps its content blocks", async () => {
		await seedSmallSession();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		const child = parsed.messages[1].toolCalls[0].subagentMessages[0];

		expect(child.content).toEqual([{ type: "text", text: "subagent said this" }]);
		expect(child.contentTruncated).toBe(false);
	});

	test("every truncation counter stays at zero", async () => {
		await seedSmallSession();
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.truncation).toMatchObject({
			toolFieldsTruncated: 0,
			toolCallsOmitted: 0,
			pagesWithIoOmitted: 0,
			childMessagesOmitted: 0,
			childMessagesTruncated: 0,
		});
		expect(parsed.complete).toBe(true);
	});

	test("markdown still renders the whole exchange", async () => {
		await seedSmallSession();
		const md = await collect("n1", { lang: "en" });
		expect(md).toContain("please");
		expect(md).toContain("on it");
		expect(md).toContain("src/index.ts");
		expect(md).toContain("file contents here");
		expect(md).toContain("subagent said this");
		expect(md).not.toContain("truncated");
		expect(md).not.toContain("page budget reached");
		expect(md).toContain("Export complete.");
	});

	/**
	 * The per-message cap moved from a JS `slice` into a SQL window function, so the
	 * rows past it are no longer fetched at all. `count(*) OVER (PARTITION BY ...)`
	 * is what keeps the omission count exact rather than an underestimate derived
	 * from however many rows happened to arrive.
	 */
	test("the per-message cap is applied in SQL and counted exactly", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		const total = EXPORT_TOOL_CALLS_PER_MESSAGE + 17;
		for (let i = 0; i < total; i++) {
			await seedToolCall({
				id: `tc-${i}`,
				narratorId: "n1",
				messageId: "m1",
				toolUseId: `tu-${i}`,
				createdAt: new Date(Date.parse(now) + i).toISOString(),
			});
		}

		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.messages[0].toolCalls).toHaveLength(EXPORT_TOOL_CALLS_PER_MESSAGE);
		expect(parsed.messages[0].toolCallsOmitted).toBe(17);
		expect(parsed.truncation.toolCallsOmitted).toBe(17);
		// The kept ones are the earliest, which are the calls the message text refers to.
		expect(parsed.messages[0].toolCalls[0].toolUseId).toBe("tu-0");
	});

	test("tool calls keep their original per-message order", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1 });
		// Same createdAt across all three: the rank tiebreaker, not the timestamp, is
		// what has to keep the order stable between the metadata and body reads.
		for (const i of [0, 1, 2]) {
			await seedToolCall({
				id: `tc-${i}`,
				narratorId: "n1",
				messageId: "m1",
				toolUseId: `tu-${i}`,
				output: `body-${i}`,
			});
		}
		const parsed = JSON.parse(await collect("n1", { format: "json" }));
		expect(parsed.messages[0].toolCalls.map((t: { toolUseId: string }) => t.toolUseId)).toEqual([
			"tu-0",
			"tu-1",
			"tu-2",
		]);
	});
});

describe("cancellation", () => {
	test("an already-aborted signal stops before any message is emitted", async () => {
		seedNarrator("n1");
		await seedMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "should-not-appear" });

		const controller = new AbortController();
		controller.abort();
		const raw = await collect("n1", { format: "json" }, controller.signal);
		expect(raw).not.toContain("should-not-appear");
		// Aborting is a disconnect, so no tail is written: the file is detectably partial.
		expect(() => JSON.parse(raw)).toThrow();
	});
});

describe("subagent narrators", () => {
	test("a subagent exports its own messages without recursing", async () => {
		seedNarrator("sub", { variant: "explore" });
		await seedMessage({ id: "s1", narratorId: "sub", seq: 1, contentText: "subagent-work" });
		const md = await collect("sub");
		expect(md).toContain("subagent-work");
	});
});
