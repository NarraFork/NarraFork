import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import * as pool from "../../lib/db-worker/pool";
import { captureWorkerRejection, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
// Preserve the existing service/persistence import-cycle initialization order.
const { narratorService } = await import("../narrator-service");
const { getNarratorPanelState } = await import("../narrator-panel-state");
const { getNarratorDraftMetadata } = await import("../narrator-draft-service");
const time = "2026-10-12T00:00:00.000Z";
function narrator(id = "n1", parent?: string) {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, parent_narrator_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
		)
		.run(id, parent ?? null, time, time);
}
function permission(
	id: string,
	input: unknown = { command: id },
	owner = "n1",
	parent: string | null = null,
	suggestions: unknown = null,
) {
	sqlite
		.prepare(
			"INSERT INTO narrator_messages (id, narrator_id, role, content_json, parent_tool_use_id, created_at) VALUES (?, ?, 'assistant', '[]', ?, ?)",
		)
		.run(`m-${id}`, owner, parent, time);
	sqlite
		.prepare(
			"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, input_json, permission_suggestions, status, created_at) VALUES (?, ?, ?, ?, 'Bash', ?, ?, 'pending', ?)",
		)
		.run(
			id,
			owner,
			`m-${id}`,
			`use-${id}`,
			JSON.stringify(input),
			suggestions === null ? null : JSON.stringify(suggestions),
			time,
		);
}
function buffer(id: string, seq: number, priority = false, state = "queued", text = id) {
	sqlite
		.prepare(
			"INSERT INTO narrator_buffered_messages (id, narrator_id, text, priority, seq, arrival_seq, state, buffered_at) VALUES (?, 'n1', ?, ?, ?, ?, ?, ?)",
		)
		.run(id, text, priority ? 1 : 0, seq, seq, state, time);
}
function driverQueries() {
	const queries: string[] = [];
	const prepare = sqlite.prepare.bind(sqlite);
	const run = pool.runReadTask;
	spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
		if (params.kind === "selectRows" || params.kind === "selectValues") queries.push(params.sql);
		return run(path, params, options);
	}) as typeof pool.runReadTask);
	spyOn(sqlite, "prepare").mockImplementation((...args: Parameters<typeof sqlite.prepare>) => {
		queries.push(args[0]);
		return prepare(...args);
	});
	return queries;
}
beforeEach(() => {
	mock.restore();
	cleanDb(sqlite);
	narrator();
});
afterAll(async () => {
	mock.restore();
	mock.module("../../db", () => realDbModule);
	await fixture.close();
});

describe("bounded narrator panel state", () => {
	test("independent 32-item cursors preserve every item, including tied timestamps and priority queue rows", async () => {
		for (let i = 0; i < 70; i++) {
			const id = i.toString().padStart(3, "0");
			permission(`p-${id}`);
			buffer(`b-${id}`, Math.floor(i / 2), i % 3 === 0, i % 5 === 0 ? "failed" : "queued");
		}
		const first = await getNarratorPanelState("n1", "viewer");
		expect(first.permissions).toHaveLength(32);
		expect(first.buffer).toHaveLength(32);
		expect(first.hasMore).toEqual({ permissions: true, buffer: true });
		const permissions = [...first.permissions];
		const buffers = [...first.buffer];
		let page = first;
		while (page.hasMore.permissions || page.hasMore.buffer) {
			const previous = page;
			page = await getNarratorPanelState("n1", "viewer", {
				permissionsCursor: previous.nextCursor?.permissions,
				bufferCursor: previous.nextCursor?.buffer,
			});
			if (previous.hasMore.permissions) permissions.push(...page.permissions);
			if (previous.hasMore.buffer) buffers.push(...page.buffer);
		}
		expect(permissions.map((item) => item.id)).toEqual(
			Array.from({ length: 70 }, (_, i) => `p-${i.toString().padStart(3, "0")}`),
		);
		expect(new Set(buffers.map((item) => item.id)).size).toBe(70);
		expect(buffers.filter((item) => item.state === "failed")).toHaveLength(14);
		expect(buffers[0]?.priority).toBe(true);
	});

	test("reflection filtering and child routing match the legacy permission projection", async () => {
		narrator("child", "n1");
		narrator("foreign");
		permission("own");
		permission("child-visible", {}, "child", "agent-use");
		permission("child-hidden", {}, "child", "other-use");
		permission("foreign", {}, "foreign");
		permission("running", {}, "n1", null, [{ type: "danger_reflection", status: "running" }]);
		permission("awaiting", {}, "n1", null, [
			"primitive",
			{ type: "plan_reflection", status: "awaiting_user" },
		]);
		sqlite
			.prepare(
				"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('parent-msg', 'n1', 'assistant', '[]', ?)",
			)
			.run(time);
		sqlite
			.prepare(
				"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('parent-ref', 'n1', 'parent-msg', 1)",
			)
			.run();
		sqlite
			.prepare(
				"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, input_json, status, created_at) VALUES ('parent-tool', 'n1', 'parent-msg', 'agent-use', 'Agent', '{}', 'completed', ?)",
			)
			.run(time);
		const legacy = await narratorService.getPendingPermissions("n1");
		const result = await getNarratorPanelState("n1", "viewer");
		expect(result.permissions).toEqual(legacy.sort((a, b) => a.id.localeCompare(b.id)));
		expect(result.permissions.find((item) => item.id === "child-visible")?.subagentNarratorId).toBe(
			"child",
		);
	});

	test("actual SQLite metadata query uses the narrator/status index rather than a global tool scan", async () => {
		permission("own");
		type Bindings = Parameters<ReturnType<typeof sqlite.prepare>["values"]>;
		let executed: { query: string; bindings: Bindings } | undefined;
		const prepare = sqlite.prepare.bind(sqlite);
		const run = pool.runReadTask;
		spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
			if (
				!executed &&
				(params.kind === "selectValues" || params.kind === "selectRows") &&
				params.sql.includes('from "narrator_tool_calls"') &&
				params.sql.includes("length(CAST(")
			)
				executed = { query: params.sql, bindings: params.params as Bindings };
			return run(path, params, options);
		}) as typeof pool.runReadTask);
		await getNarratorPanelState("n1", "viewer");
		const getExecution = (): { query: string; bindings: Bindings } | undefined => executed;
		const actual = getExecution();
		if (!actual) throw new Error("SQLite metadata execution was not observed");
		const plan = prepare(`EXPLAIN QUERY PLAN ${actual.query}`).all(...actual.bindings) as Array<{
			detail: string;
		}>;
		expect(plan.some((row) => row.detail.includes("idx_toolcalls_status"))).toBe(true);
		expect(plan.some((row) => /SCAN narrator_tool_calls/.test(row.detail))).toBe(false);
	});

	test("large I/O shrinks pages before body reads rather than dropping a tail", async () => {
		for (let i = 0; i < 40; i++)
			permission(`large-${i.toString().padStart(3, "0")}`, { text: "x".repeat(300 * 1024) });
		const queries = driverQueries();
		let page = await getNarratorPanelState("n1", "viewer");
		expect(page.permissions.length).toBeGreaterThan(0);
		expect(page.permissions.length).toBeLessThan(32);
		const ids = page.permissions.map((item) => item.id);
		while (page.hasMore.permissions) {
			page = await getNarratorPanelState("n1", "viewer", {
				permissionsCursor: page.nextCursor?.permissions,
			});
			ids.push(...page.permissions.map((item) => item.id));
		}
		expect(new Set(ids).size).toBe(40);
		expect(
			queries
				.filter((query) => query.includes('from "narrator_tool_calls"'))
				.every((query) => query.includes("limit ?")),
		).toBe(true);
	});

	test("oversize single item fails explicitly without fetching its body", async () => {
		permission("huge", { text: "x".repeat(5 * 1024 * 1024) });
		const queries = driverQueries();
		await expect(getNarratorPanelState("n1", "viewer")).rejects.toMatchObject({
			statusCode: 413,
			code: "PANEL_STATE_ITEM_TOO_LARGE",
		});
		const permissionReads = queries.filter((query) => query.includes('from "narrator_tool_calls"'));
		expect(permissionReads).toHaveLength(1);
		expect(permissionReads[0]).toContain(
			'length(CAST("narrator_tool_calls"."input_json" AS BLOB))',
		);
	});

	test("cursors reject cross-narrator and collection substitution", async () => {
		for (let i = 0; i < 33; i++) {
			permission(`p-${i}`);
			buffer(`b-${i}`, i);
		}
		const first = await getNarratorPanelState("n1", "viewer");
		await expect(
			getNarratorPanelState("n2", "viewer", { bufferCursor: first.nextCursor?.buffer }),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			getNarratorPanelState("n1", "viewer", { permissionsCursor: first.nextCursor?.buffer }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	test("end cursors skip completed collections and reordered queues fail instead of dropping items", async () => {
		for (let i = 0; i < 33; i++) {
			permission(`p-${i}`);
			buffer(`b-${i}`, i);
		}
		const first = await getNarratorPanelState("n1", "viewer");
		const second = await getNarratorPanelState("n1", "viewer", {
			permissionsCursor: "end",
			bufferCursor: first.nextCursor?.buffer,
		});
		expect(second.permissions).toEqual([]);
		expect(second.hasMore).toEqual({ permissions: false, buffer: false });
		expect(second.buffer).toHaveLength(1);
		sqlite.prepare("UPDATE narrator_buffered_messages SET priority = 1 WHERE id = 'b-32'").run();
		expect(
			await captureWorkerRejection(
				getNarratorPanelState("n1", "viewer", {
					permissionsCursor: "end",
					bufferCursor: first.nextCursor?.buffer,
				}),
			),
		).toMatchObject({ statusCode: 409, code: "PANEL_STATE_CHANGED" });
	});

	test("large queued text and command-only fields never enter a full-row read before budget validation", async () => {
		buffer("huge", 1, false, "queued", "x".repeat(5 * 1024 * 1024));
		const queries = driverQueries();
		await expect(
			getNarratorPanelState("n1", "viewer", { permissionsCursor: "end" }),
		).rejects.toMatchObject({ statusCode: 413, code: "PANEL_STATE_ITEM_TOO_LARGE" });
		expect(
			queries.filter((query) => query.includes('from "narrator_buffered_messages"')),
		).toHaveLength(2);
	});

	test("draft metadata preserves per-user tombstones and never projects text or locator JSON", async () => {
		sqlite
			.prepare(
				"INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('viewer', 'viewer', 'secret', 'user', ?)",
			)
			.run(time);
		sqlite
			.prepare(
				"INSERT INTO narrator_drafts (id, user_id, narrator_id, text, revision, updated_at) VALUES ('d', 'viewer', 'n1', ?, 7, ?)",
			)
			.run("x".repeat(1024 * 1024), time);
		const queries = driverQueries();
		expect(await getNarratorDraftMetadata("viewer", "n1")).toEqual({
			hasDraft: true,
			revision: 7,
			updatedAt: time,
		});
		expect(await getNarratorDraftMetadata("other", "n1")).toEqual({
			hasDraft: false,
			revision: 0,
			updatedAt: null,
		});
		expect(queries[0]).toContain("length(trim(");
		expect(queries[0]).not.toContain('select "text"');
		sqlite.prepare("UPDATE narrator_drafts SET text = '', revision = 8 WHERE id = 'd'").run();
		expect(await getNarratorDraftMetadata("viewer", "n1")).toEqual({
			hasDraft: false,
			revision: 8,
			updatedAt: time,
		});
	});
});
