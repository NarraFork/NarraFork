import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { desc, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { terminals } from "../../../../db/schema";
import type { ToolContext } from "../../types";

type Row = {
	id: string;
	narratorId: string;
	name: string;
	status: string;
	createdAt: string;
};
type QueryConfig = {
	where: SQL;
	limit?: number;
	columns: Record<string, boolean>;
	orderBy?: (table: typeof terminals, operators: { desc: typeof desc }) => SQL[];
};
type Query = { kind: "first" | "many"; config: QueryConfig; then: () => never };
const dialect = new SQLiteSyncDialect();
const rows: Row[] = [];
const reads: Array<{ query: Query; options: Record<string, unknown> }> = [];
let workerFailure: Error | undefined;
const inlineExecution = mock((): never => {
	throw new Error("query executed outside the read worker");
});
const rename = mock(async () => {});

function query(kind: Query["kind"], config: QueryConfig): Query {
	// biome-ignore lint/suspicious/noThenProperty: direct awaiting a query must fail this isolation test.
	return { kind, config, then: inlineExecution };
}
mock.module("@server/db", () => ({
	db: {
		query: {
			terminals: {
				findFirst: (config: QueryConfig) => query("first", config),
				findMany: (config: QueryConfig) => query("many", config),
			},
		},
	},
}));
mock.module("@server/db/worker-read", () => ({
	readQuery: async (request: Query, options: Record<string, unknown>) => {
		reads.push({ query: request, options });
		expect(options.executionPolicy).toBe("worker-required");
		expect(options.timeoutMs).toBe(30_000);
		if (workerFailure) throw workerFailure;
		const parameters = dialect.sqlToQuery(request.config.where).params;
		let matches = rows.filter((row) =>
			request.kind === "first"
				? row.id === parameters[0]
				: row.narratorId === parameters[0] && row.status === parameters[1],
		);
		if (request.config.orderBy) {
			const order = request.config.orderBy(terminals, { desc });
			expect(order).toHaveLength(1);
			expect(dialect.sqlToQuery(order[0]).sql).toBe('"terminals"."created_at" desc');
			matches = matches.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
		}
		if (request.kind === "first") return matches[0];
		expect(request.config.limit).toBe(200);
		expect(options.maxRows).toBe(200);
		return matches.slice(0, request.config.limit);
	},
}));
mock.module("@server/services/terminal-service", () => ({ terminalService: { rename } }));
mock.module("@server/services/terminal-watch-service", () => ({
	createWatchFrameMatcher: () => {},
	DEFAULT_WATCH_TIMEOUT_MS: 30_000,
	MAX_WATCH_PATTERN_CHARS: 1_000,
	MAX_WATCH_TIMEOUT_MS: 300_000,
	MIN_WATCH_TIMEOUT_MS: 1_000,
	normalizeWatchPattern: (pattern: string) => pattern,
	startTerminalWatch: () => {},
}));
mock.module("../truncate", () => ({ truncateOutput: (content: string) => ({ content }) }));
const { terminalTool } = await import("../terminal");

afterAll(() => mock.restore());
beforeEach(() => {
	rows.length = 0;
	reads.length = 0;
	workerFailure = undefined;
	inlineExecution.mockClear();
	rename.mockClear();
});
function row(id: string, status = "running", createdAt = "2026-11-18T00:00:00Z"): Row {
	return { id, narratorId: "lookup-owner", name: "Shell", status, createdAt };
}
const run = (terminalId = "sHeLl") =>
	terminalTool.execute({ action: "rename", terminal_id: terminalId, name: "Renamed" }, {
		narratorId: "lookup-owner",
		signal: new AbortController().signal,
	} as ToolContext);

describe("Terminal lookup through the read worker", () => {
	test("running names beat newer exited names and newest running wins", async () => {
		rows.push(
			row("old-running", "running", "2026-11-16T00:00:00Z"),
			row("new-exited", "exited", "2026-11-18T00:00:00Z"),
			row("new-running", "running", "2026-11-17T00:00:00Z"),
		);
		expect((await run()).isError).toBeFalsy();
		expect(rename).toHaveBeenCalledWith("new-running", "Renamed");
		expect(reads).toHaveLength(3);
		expect(inlineExecution).not.toHaveBeenCalled();
	});

	test("the newest exited name is used when no running name matches", async () => {
		rows.push(
			{ ...row("unrelated"), name: "Other" },
			row("old-exited", "exited", "2026-11-16T00:00:00Z"),
			row("new-exited", "exited", "2026-11-18T00:00:00Z"),
		);
		expect((await run()).isError).toBeFalsy();
		expect(rename).toHaveBeenCalledWith("new-exited", "Renamed");
		expect(reads).toHaveLength(4);
	});

	test("an exact ID wins over a name, but ownership is still checked", async () => {
		rows.push(row("explicit-id"), { ...row("foreign-id"), narratorId: "another-owner" });
		expect((await run("explicit-id")).isError).toBeFalsy();
		expect(rename).toHaveBeenCalledWith("explicit-id", "Renamed");
		expect((await run("foreign-id")).output).toContain("Access denied");
		expect(rename).toHaveBeenCalledTimes(1);
		expect(reads.every(({ query: request }) => request.kind === "first")).toBe(true);
	});

	test("another narrator's matching name does not grant access", async () => {
		rows.push({ ...row("foreign"), narratorId: "another-owner" });
		expect(await run()).toMatchObject({ isError: true });
		expect(rename).not.toHaveBeenCalled();
	});

	test("each status lookup keeps its 200-row query budget", async () => {
		for (let i = 0; i < 200; i++) rows.push({ ...row(`other-${i}`), name: "Other" });
		rows.push(row("outside-budget", "running", "2026-11-16T00:00:00Z"));
		expect(await run()).toMatchObject({ isError: true });
		expect(rename).not.toHaveBeenCalled();
	});

	for (const code of [
		"DB_READ_UNAVAILABLE",
		"DB_READ_DISABLED",
		"DB_READ_WORKER_FAILED",
		"DB_READ_TIMEOUT",
	]) {
		test(`${code} is propagated without executing the query inline`, async () => {
			workerFailure = Object.assign(new Error(code), { code });
			rows.push(row("shell"));
			await expect(run()).rejects.toBe(workerFailure);
			expect(inlineExecution).not.toHaveBeenCalled();
			expect(rename).not.toHaveBeenCalled();
		});
	}
});
