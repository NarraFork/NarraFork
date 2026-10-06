/**
 * The execution log's correctness rests on three things that are easy to break
 * silently, so each has a test here:
 *
 *  - the `started_at` fallback chain (rows written before migration 0034 have all
 *    four lifecycle timestamps NULL and would otherwise vanish from the timeline),
 *  - keyset pagination across rows that share a timestamp (a naive cursor either
 *    repeats or skips them),
 *  - the promise that a list page never carries `input_json`/`output_json`, which
 *    is a main-thread performance constraint rather than a cosmetic one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	chapters,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "@server/db/schema";
import { decodeExecutionLogCursor } from "@server/lib/execution-log-cursor";
import { cleanDb, getTestDb } from "../../tests/setup";
import { ExecutionLogService } from "./execution-log-service";

const { db, sqlite } = getTestDb();
const service = new ExecutionLogService(db);

afterEach(() => cleanDb(sqlite));

const T = {
	oldest: "2026-07-17T10:00:00.000Z",
	middle: "2026-07-17T11:00:00.000Z",
	newest: "2026-07-17T12:00:00.000Z",
};

interface ToolCallSeed {
	id: string;
	narratorId?: string;
	toolName?: string;
	status?: "initializing" | "pending" | "running" | "success" | "fail";
	createdAt: string;
	streamStartedAt?: string | null;
	permissionStartedAt?: string | null;
	executionStartedAt?: string | null;
	inputJson?: unknown;
	outputJson?: unknown;
	errorMessage?: string | null;
	executionDeviceId?: string | null;
	isFileHistoryCheckpoint?: boolean;
	isBackground?: boolean;
}

function seedNarrator(id: string, extra: Partial<typeof narrators.$inferInsert> = {}) {
	db.insert(narrators)
		.values({ id, createdAt: T.oldest, updatedAt: T.oldest, ...extra })
		.run();
}

/**
 * Every tool call needs an owning message row — `narrator_tool_calls.message_id`
 * is a real foreign key, so seeding calls alone fails.
 */
function seedMessages(seeds: Array<{ id: string; narratorId: string; createdAt: string }>) {
	db.insert(narratorMessages)
		.values(
			seeds.map((seed) => ({
				id: seed.id,
				narratorId: seed.narratorId,
				role: "assistant" as const,
				contentJson: [],
				createdAt: seed.createdAt,
			})),
		)
		.run();
}

function seedToolCalls(seeds: ToolCallSeed[]) {
	seedMessages(
		seeds.map((seed) => ({
			id: `message-${seed.id}`,
			narratorId: seed.narratorId ?? "narrator-1",
			createdAt: seed.createdAt,
		})),
	);
	db.insert(narratorToolCalls)
		.values(
			seeds.map((seed) => ({
				id: seed.id,
				narratorId: seed.narratorId ?? "narrator-1",
				messageId: `message-${seed.id}`,
				toolUseId: `use-${seed.id}`,
				toolName: seed.toolName ?? "Bash",
				status: seed.status ?? ("success" as const),
				createdAt: seed.createdAt,
				streamStartedAt: seed.streamStartedAt ?? null,
				permissionStartedAt: seed.permissionStartedAt ?? null,
				executionStartedAt: seed.executionStartedAt ?? null,
				inputJson: seed.inputJson ?? null,
				outputJson: seed.outputJson ?? null,
				errorMessage: seed.errorMessage ?? null,
				executionDeviceId: seed.executionDeviceId ?? null,
				isFileHistoryCheckpoint: seed.isFileHistoryCheckpoint ?? false,
				isBackground: seed.isBackground ?? false,
			})),
		)
		.run();
}

describe("ExecutionLogService ordering", () => {
	test("orders by the started_at fallback chain, not created_at", async () => {
		seedNarrator("narrator-1");
		// Each row's effective start comes from a different column in the chain, and
		// created_at is deliberately in the OPPOSITE order so a regression that sorts
		// by created_at fails rather than coincidentally passing.
		seedToolCalls([
			{ id: "by-exec", createdAt: T.oldest, executionStartedAt: T.newest },
			{ id: "by-permission", createdAt: T.middle, permissionStartedAt: T.middle },
			{ id: "by-stream", createdAt: T.newest, streamStartedAt: T.oldest },
		]);

		const result = await service.listCursor({}, 10);
		expect(result.records.map((record) => record.id)).toEqual([
			"by-exec",
			"by-permission",
			"by-stream",
		]);
		expect(result.records.map((record) => record.startedAt)).toEqual([
			T.newest,
			T.middle,
			T.oldest,
		]);
	});

	test("falls back to created_at for legacy rows with no lifecycle timestamps", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{ id: "legacy", createdAt: T.middle },
			{ id: "modern", createdAt: T.oldest, executionStartedAt: T.newest },
		]);

		const result = await service.listCursor({}, 10);
		expect(result.records.map((record) => record.id)).toEqual(["modern", "legacy"]);
		// A legacy row must still appear on the timeline, at its creation moment.
		expect(result.records[1]?.startedAt).toBe(T.middle);
	});

	test("prefers execution over permission over stream when several are set", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "all-set",
				createdAt: T.oldest,
				streamStartedAt: T.oldest,
				permissionStartedAt: T.middle,
				executionStartedAt: T.newest,
			},
		]);

		const result = await service.listCursor({}, 10);
		expect(result.records[0]?.startedAt).toBe(T.newest);
	});
});

describe("ExecutionLogService cursor pagination", () => {
	test("pages through rows sharing a timestamp without repeats or gaps", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{ id: "call-a", createdAt: T.newest, executionStartedAt: T.newest },
			{ id: "call-b", createdAt: T.newest, executionStartedAt: T.newest },
			{ id: "call-c", createdAt: T.newest, executionStartedAt: T.newest },
			{ id: "call-d", createdAt: T.newest, executionStartedAt: T.newest },
			{ id: "call-e", createdAt: T.newest, executionStartedAt: T.newest },
		]);

		const all = await service.listCursor({}, 100);
		expect(all.records).toHaveLength(5);
		const expectedOrder = all.records.map((record) => record.id);

		const paged: string[] = [];
		let cursor: ReturnType<typeof decodeExecutionLogCursor> | undefined;
		for (let page = 0; page < 5; page++) {
			const result = await service.listCursor({}, 2, cursor ?? undefined);
			paged.push(...result.records.map((record) => record.id));
			if (!result.hasMore) break;
			cursor = decodeExecutionLogCursor(result.nextCursor ?? undefined);
			expect(cursor).not.toBeNull();
		}

		expect(paged).toEqual(expectedOrder);
		expect(new Set(paged).size).toBe(5);
	});

	test("reports no next cursor on the final page", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([{ id: "only", createdAt: T.newest }]);

		const result = await service.listCursor({}, 2);
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeNull();
	});

	test("clamps the requested limit to the hard ceiling", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([{ id: "only", createdAt: T.newest }]);

		expect((await service.listCursor({}, 5000)).limit).toBe(100);
		expect((await service.listCursor({}, 0)).limit).toBe(1);
	});
});

describe("ExecutionLogService payload safety", () => {
	test("a list page never carries input or output JSON", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "with-payload",
				createdAt: T.newest,
				inputJson: { description: "run the tests", secret: "x".repeat(5000) },
				outputJson: { stdout: "y".repeat(50_000) },
			},
		]);

		const result = await service.listCursor({}, 10);
		const record = result.records[0];
		expect(record).toBeDefined();
		expect("inputJson" in (record as object)).toBe(false);
		expect("outputJson" in (record as object)).toBe(false);
		// The bounded summary is what the list shows instead.
		expect(record?.summary).toBe("run the tests");
		expect(JSON.stringify(result)).not.toContain("x".repeat(100));
	});

	test("detail returns payloads and byte-caps oversized ones", async () => {
		seedNarrator("narrator-1");
		const huge = "z".repeat(400_000);
		seedToolCalls([
			{ id: "small", createdAt: T.oldest, inputJson: { a: 1 }, outputJson: { b: 2 } },
			{ id: "huge", createdAt: T.newest, outputJson: { stdout: huge } },
		]);

		const small = await service.getRecord("small");
		expect(small?.inputJson).toEqual({ a: 1 });
		expect(small?.outputJson).toEqual({ b: 2 });
		expect(small?.outputTruncated).toBe(false);

		const capped = await service.getRecord("huge");
		expect(capped?.outputTruncated).toBe(true);
		expect(capped?.outputBytes).toBeGreaterThan(400_000);
		expect(typeof capped?.outputJson).toBe("string");
		expect((capped?.outputJson as string).length).toBeLessThanOrEqual(256 * 1024);
	});

	test("returns null for an unknown id", async () => {
		expect(await service.getRecord("missing")).toBeNull();
	});

	/**
	 * This view spans every narrator, so an unmasked detail read hands one
	 * administrator the credentials of users who never shared them. Redaction lives
	 * in `execution-log-redaction.ts` (unit-tested there for pattern breadth); this
	 * asserts the endpoint actually routes through it.
	 */
	test("detail masks credentials in both payloads", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "leaky",
				createdAt: T.newest,
				inputJson: { command: 'curl -H "Authorization: Bearer sk-live-topsecret" https://x.test' },
				outputJson: { stdout: "export DEPLOY_TOKEN=ghp_anotherTopSecret" },
			},
		]);

		const record = await service.getRecord("leaky");
		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain("sk-live-topsecret");
		expect(serialized).not.toContain("ghp_anotherTopSecret");
		// Masking replaces values, it does not drop the surrounding payload.
		expect(serialized).toContain("curl");
		expect(serialized).toContain("DEPLOY_TOKEN");
	});

	test("an oversized payload is masked before it is truncated", async () => {
		// Order matters: truncating first would let a secret survive inside the
		// discarded tail's replacement-free prefix, or worse, inside the kept prefix.
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "big-and-leaky",
				createdAt: T.newest,
				outputJson: { stdout: `Bearer sk-live-atthefront ${"z".repeat(400_000)}` },
			},
		]);

		const record = await service.getRecord("big-and-leaky");
		expect(record?.outputTruncated).toBe(true);
		expect(JSON.stringify(record)).not.toContain("sk-live-atthefront");
	});

	test("the list summary is masked too", async () => {
		// The list is read far more often than detail, so a signed URL surfacing here
		// would be the first thing an administrator sees.
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "leaky-summary",
				createdAt: T.newest,
				toolName: "WebFetch",
				inputJson: { url: "https://x.test/data?access_token=sk-live-inthesummary" },
			},
		]);

		const result = await service.listCursor({}, 10);
		expect(JSON.stringify(result)).not.toContain("sk-live-inthesummary");
	});
});

describe("ExecutionLogService filters", () => {
	test("filters by narrator, optionally including its subagents", async () => {
		seedNarrator("parent");
		seedNarrator("child", { parentNarratorId: "parent", type: "subagent" });
		seedToolCalls([
			{ id: "parent-call", narratorId: "parent", createdAt: T.newest },
			{ id: "child-call", narratorId: "child", createdAt: T.middle },
		]);

		const own = await service.listCursor({ narratorId: "parent" }, 10);
		expect(own.records.map((r) => r.id)).toEqual(["parent-call"]);

		const withSubagents = await service.listCursor(
			{ narratorId: "parent", includeSubagents: true },
			10,
		);
		expect(withSubagents.records.map((r) => r.id)).toEqual(["parent-call", "child-call"]);
	});

	test("filters by tool name, status, device and background flag", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "bash-fail-remote",
				toolName: "Bash",
				status: "fail",
				executionDeviceId: "device-x",
				createdAt: T.newest,
			},
			{ id: "read-ok-local", toolName: "Read", executionDeviceId: "local", createdAt: T.middle },
			{ id: "bash-bg", toolName: "Bash", isBackground: true, createdAt: T.oldest },
		]);

		expect((await service.listCursor({ toolName: "Bash" }, 10)).records.map((r) => r.id)).toEqual([
			"bash-fail-remote",
			"bash-bg",
		]);
		expect((await service.listCursor({ status: "fail" }, 10)).records.map((r) => r.id)).toEqual([
			"bash-fail-remote",
		]);
		expect(
			(await service.listCursor({ executionDeviceId: "local" }, 10)).records.map((r) => r.id),
		).toEqual(["read-ok-local"]);
		expect((await service.listCursor({ isBackground: true }, 10)).records.map((r) => r.id)).toEqual(
			["bash-bg"],
		);
	});

	test("bounds the time range on started_at, not created_at", async () => {
		seedNarrator("narrator-1");
		// created_at is old but execution happened inside the window: a filter applied
		// to created_at would wrongly exclude this row.
		seedToolCalls([
			{ id: "in-window", createdAt: T.oldest, executionStartedAt: T.newest },
			{ id: "out-of-window", createdAt: T.oldest, executionStartedAt: T.oldest },
		]);

		const result = await service.listCursor({ startDate: T.middle }, 10);
		expect(result.records.map((r) => r.id)).toEqual(["in-window"]);
	});

	test("onlyErrors ignores rows with blank error text", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{ id: "failed", createdAt: T.newest, errorMessage: "boom" },
			{ id: "blank", createdAt: T.middle, errorMessage: "   " },
			{ id: "clean", createdAt: T.oldest },
		]);

		const result = await service.listCursor({ onlyErrors: true }, 10);
		expect(result.records.map((r) => r.id)).toEqual(["failed"]);
	});

	test("hides file-history checkpoints by default and shows them on request", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{ id: "real", createdAt: T.newest },
			{ id: "checkpoint", createdAt: T.middle, isFileHistoryCheckpoint: true },
		]);

		expect((await service.listCursor({}, 10)).records.map((r) => r.id)).toEqual(["real"]);
		expect(
			(await service.listCursor({ hideFileHistoryCheckpoints: false }, 10)).records.map(
				(r) => r.id,
			),
		).toEqual(["real", "checkpoint"]);
	});

	test("joins chapter and project context onto each row", async () => {
		db.insert(projects)
			.values({
				id: "project-1",
				name: "Demo project",
				gitPath: "/tmp/demo",
				createdAt: T.oldest,
				updatedAt: T.oldest,
			})
			.run();
		db.insert(chapters)
			.values({
				id: "chapter-1",
				projectId: "project-1",
				title: "Demo chapter",
				branch: "demo",
				baseBranch: "main",
				createdAt: T.oldest,
				updatedAt: T.oldest,
			})
			.run();
		seedNarrator("narrator-1", { chapterId: "chapter-1", title: "Demo narrator" });
		seedToolCalls([{ id: "call", createdAt: T.newest }]);

		const record = (await service.listCursor({}, 10)).records[0];
		expect(record?.narratorTitle).toBe("Demo narrator");
		expect(record?.chapterId).toBe("chapter-1");
		expect(record?.chapterTitle).toBe("Demo chapter");
		expect(record?.projectId).toBe("project-1");
		expect(record?.projectName).toBe("Demo project");
	});
});

describe("ExecutionLogService free-text search", () => {
	test("matches small columns without reading payloads", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "matching",
				toolName: "Bash",
				createdAt: T.newest,
				inputJson: { description: "run migrations" },
			},
			{
				id: "other",
				toolName: "Read",
				createdAt: T.middle,
				inputJson: { file_path: "/tmp/readme.md" },
			},
		]);

		expect((await service.listCursor({ q: "migrations" }, 10)).records.map((r) => r.id)).toEqual([
			"matching",
		]);
		expect((await service.listCursor({ q: "readme" }, 10)).records.map((r) => r.id)).toEqual([
			"other",
		]);
	});

	test("does not reach into payloads unless searchPayload is set", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{
				id: "deep",
				createdAt: T.newest,
				// Only present in a field the summary never extracts.
				inputJson: { command: "grep needlevalue ." },
				outputJson: { stdout: "needlevalue" },
			},
		]);

		expect((await service.listCursor({ q: "needlevalue" }, 10)).records).toHaveLength(0);
		const deep = await service.listCursor({ q: "needlevalue", searchPayload: true }, 10);
		expect(deep.records.map((r) => r.id)).toEqual(["deep"]);
	});

	test("treats LIKE wildcards in the needle as literals", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{ id: "literal", createdAt: T.newest, inputJson: { description: "100% done" } },
			{ id: "other", createdAt: T.middle, inputJson: { description: "still running" } },
		]);

		// An unescaped `%` would match every row.
		const result = await service.listCursor({ q: "100%" }, 10);
		expect(result.records.map((r) => r.id)).toEqual(["literal"]);
	});

	test("reports an untruncated payload search on a small table", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([{ id: "call", createdAt: T.newest, outputJson: { stdout: "hello" } }]);

		const result = await service.listCursor({ q: "hello", searchPayload: true }, 10);
		expect(result.records.map((r) => r.id)).toEqual(["call"]);
		// Fewer rows than the window, so nothing was withheld.
		expect(result.payloadSearchTruncated).toBe(false);
		expect(result.payloadSearchWindowStart).toBeNull();
	});

	test("confines a payload search to the window and says so", async () => {
		// A 2-row window stands in for the production 20k one. The point of the
		// window is that an unbounded payload LIKE reads the whole table, so a match
		// that falls outside it must be reported as withheld, never silently dropped.
		const windowed = new ExecutionLogService(db, { payloadSearchWindowRows: 2 });
		seedNarrator("narrator-1");
		seedToolCalls([
			{ id: "newest", createdAt: "2026-07-17T12:00:03.000Z", outputJson: { s: "needle" } },
			{ id: "second", createdAt: "2026-07-17T12:00:02.000Z", outputJson: { s: "filler" } },
			{ id: "third", createdAt: "2026-07-17T12:00:01.000Z", outputJson: { s: "filler" } },
			{ id: "too-old", createdAt: "2026-07-17T12:00:00.000Z", outputJson: { s: "needle" } },
		]);

		const result = await windowed.listCursor({ q: "needle", searchPayload: true }, 10);
		expect(result.records.map((r) => r.id)).toEqual(["newest"]);
		expect(result.payloadSearchTruncated).toBe(true);
		expect(result.payloadSearchWindowStart).toBe("2026-07-17T12:00:01.000Z");

		// The same needle without payload search is not windowed at all.
		const unwindowed = await windowed.listCursor({ q: "needle" }, 10);
		expect(unwindowed.payloadSearchTruncated).toBe(false);
	});
});

describe("ExecutionLogService facets", () => {
	test("includes tool names observed in the data", async () => {
		seedNarrator("narrator-1");
		seedToolCalls([
			{ id: "a", toolName: "Bash", createdAt: T.newest },
			{ id: "b", toolName: "SomeRetiredTool", createdAt: T.middle },
		]);

		const facets = await service.listFacets();
		expect(facets.toolNames).toContain("Bash");
		expect(facets.toolNames).toContain("SomeRetiredTool");
		expect(facets.statuses).toEqual(["initializing", "pending", "running", "success", "fail"]);
		expect(facets.toolNames).toEqual([...facets.toolNames].sort((x, y) => x.localeCompare(y)));
	});

	test("lists providers seen in the recent window", async () => {
		seedNarrator("narrator-1");
		seedMessages([
			{ id: "m1", narratorId: "narrator-1", createdAt: T.newest },
			{ id: "m2", narratorId: "narrator-1", createdAt: T.middle },
		]);
		db.insert(narratorToolCalls)
			.values([
				{
					id: "with-provider",
					narratorId: "narrator-1",
					messageId: "m1",
					toolUseId: "u1",
					toolName: "Bash",
					provider: "codex",
					createdAt: T.newest,
				},
				{
					id: "blank-provider",
					narratorId: "narrator-1",
					messageId: "m2",
					toolUseId: "u2",
					toolName: "Bash",
					provider: "  ",
					createdAt: T.middle,
				},
			])
			.run();

		const facets = await service.listFacets();
		expect(facets.providers).toEqual(["codex"]);
	});
});
