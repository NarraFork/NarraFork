import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker as NodeWorker } from "node:worker_threads";
import { getTableColumns } from "drizzle-orm";
import { narratorMessages, narratorToolCalls } from "../../../db/schema";
import {
	type NarratorDisplayPagePort,
	readDisplayFixtureMessages,
	readNarratorDisplayMessages,
} from "../../../services/narrator-display-page-reader";
import { AppError } from "../../errors";
import { logger } from "../../logger";
import { WorkerHandle } from "../../worker-runtime/lifecycle";
import {
	DISPLAY_PAGE_LIMITS,
	type DisplayPageMessagesParams,
	type DisplayPageMessagesResult,
} from "../display-page-protocol";
import {
	DISPLAY_MESSAGE_COLUMNS,
	DISPLAY_TOOL_COLUMNS,
	type DisplayColumn,
	runDisplayPageQuery,
} from "../display-page-query";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runReadTask,
	shutdownDbWorkerPool,
} from "../pool";
import type { DbWorkerInbound, DbWorkerOutbound } from "../protocol";

const NUMERIC_MESSAGE_FIELDS = new Set(
	`bodyRevision tokensIn costUsd outputTokens cachedInputTokens
	cacheCreationInputTokens cacheCreation5mTokens cacheCreation1hTokens reasoningTokens ttftMs durationMs
	contextPercent meterUsage compactPending`.split(/\s+/),
);
const NUMERIC_TOOL_FIELDS = new Set(
	`modelRevision inputChars outputChars runtimeGeneration durationMs executionIdentityVersion
	executionAttempt inputTokens outputTokens cacheCreationTokens cacheReadTokens cacheCreation5mTokens
	cacheCreation1hTokens inputCost outputCost cacheCreationCost cacheReadCost totalCost`.split(
		/\s+/,
	),
);

/** Standalone fixtures, no app bootstrap, migrations or production connection. */
function createFixture(sqlite: Database): void {
	for (const [table, descriptors, numeric] of [
		["narrator_messages", DISPLAY_MESSAGE_COLUMNS, NUMERIC_MESSAGE_FIELDS],
		["narrator_tool_calls", DISPLAY_TOOL_COLUMNS, NUMERIC_TOOL_FIELDS],
	] as const) {
		sqlite.run(
			`CREATE TABLE ${table} (${descriptors
				.map(
					({ column, field, boolean }) =>
						`"${column}" ${numeric.has(field) || boolean ? "NUMERIC DEFAULT 0" : "TEXT"}${field === "id" ? " PRIMARY KEY" : ""}`,
				)
				.join(", ")})`,
		);
	}
	// Block bodies (empty here: fixture envelopes are legacy, read from content_json).
	sqlite.run(
		"CREATE TABLE narrator_blocks(id TEXT PRIMARY KEY, message_id TEXT, ordinal INTEGER, payload TEXT, state TEXT)",
	);
	sqlite.run("CREATE TABLE narrator_block_sync_queue(message_id TEXT PRIMARY KEY)");
	sqlite.run("CREATE INDEX idx_tools_message ON narrator_tool_calls(message_id)");
	sqlite.run(
		"CREATE INDEX idx_tools_latest ON narrator_tool_calls(message_id, tool_use_id, execution_attempt, created_at, id)",
	);
	sqlite.run(
		"CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT, avatar_color TEXT, avatar_image_id TEXT, password_hash TEXT, email TEXT)",
	);
	sqlite.run(
		"INSERT INTO users VALUES ('alice', '爱丽丝', 'indigo', 'avatar-1', 'NEVER_DISPLAY_PASSWORD', 'private@secret.invalid')",
	);
}

function insert(
	sqlite: Database,
	table: string,
	descriptors: readonly DisplayColumn[],
	values: Record<string, unknown>,
): void {
	const fields = descriptors.filter(({ field }) => Object.hasOwn(values, field));
	const statement = sqlite.prepare(
		`INSERT INTO ${table} (${fields.map(({ column }) => `"${column}"`).join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
	);
	try {
		statement.run(
			...fields.map(({ field, json, boolean }) => {
				const value = values[field];
				return json && value !== null
					? JSON.stringify(value)
					: boolean
						? Number(value)
						: (value as string | number | null);
			}),
		);
	} finally {
		statement.finalize();
	}
}

function message(
	sqlite: Database,
	id = "message-1",
	overrides: Record<string, unknown> = {},
): void {
	insert(sqlite, "narrator_messages", DISPLAY_MESSAGE_COLUMNS, {
		id,
		narratorId: "original-owner",
		role: "assistant",
		contentJson: [{ type: "text", text: "中文与 emoji 😀" }],
		parentToolUseId: "inline-parent",
		createdBy: "alice",
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	});
}

function tool(sqlite: Database, id = "tool-1", overrides: Record<string, unknown> = {}): void {
	insert(sqlite, "narrator_tool_calls", DISPLAY_TOOL_COLUMNS, {
		id,
		narratorId: "execution-owner",
		messageId: "message-1",
		toolUseId: "call-1",
		toolName: "Bash",
		inputJson: { command: "pwd" },
		outputJson: { _text: "成功", _metadata: { ok: true } },
		status: "success",
		executionAttempt: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	});
}

let directory: string;
let dbPath: string;
let writer: Database;
let previousConcurrency: string | undefined;
let previousWorker: string | undefined;

/** Expensive SELECT on a standalone fixture, not HTTP SQL or production DDL. */
function installSlowDisplayFixture(): void {
	writer.run("ALTER TABLE narrator_messages RENAME TO display_messages_source");
	const selection = DISPLAY_MESSAGE_COLUMNS.map(({ column, field }) =>
		field === "contentJson"
			? `(WITH RECURSIVE scan(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM scan WHERE n < 20000000) SELECT json_array(json_object('type', 'text', 'text', sum(n))) FROM scan) AS "${column}"`
			: `m."${column}"`,
	).join(", ");
	writer.run(`CREATE VIEW narrator_messages AS SELECT ${selection} FROM display_messages_source m`);
}

function removeSlowDisplayFixture(): void {
	writer.run("DROP VIEW narrator_messages");
	writer.run("ALTER TABLE display_messages_source RENAME TO narrator_messages");
}

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "narrafork-display-page-"));
	dbPath = join(directory, "fixture.db");
	writer = new Database(dbPath);
	writer.run("PRAGMA journal_mode = WAL");
	createFixture(writer);
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	previousWorker = process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	delete process.env.NARRAFORK_DB_WORKER;
	await resetDbWorkerPoolForTest();
});

afterEach(async () => {
	await shutdownDbWorkerPool();
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	writer.close();
	rmSync(directory, { recursive: true, force: true });
}, 30_000);

const read = (
	ids = ["message-1"],
	ioBudget = 8192,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
) => readNarratorDisplayMessages({ backend: "sqlite", dbPath }, ids, { ioBudget, ...options });
// Await rejection BEFORE entering a native async matcher. Bun 1.4.2's
// .rejects.toMatchObject can park worker message dispatch behind the matcher.
const failureOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
const request = (ids = ["message-1"]): DisplayPageMessagesParams => ({
	kind: "displayPageMessages",
	messageIds: ids,
	ioBudget: 8192,
	deadlineAt: Date.now() + 10_000,
});

function boundedDisplayResult(): DisplayPageMessagesResult {
	const messages = [
		{
			id: "message-1",
			narratorId: "owner",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [],
			createdAt: "now",
			toolCalls: [],
			creator: null,
		},
	];
	return { messages, rawBytes: 0, outputBytes: Buffer.byteLength(JSON.stringify(messages)) };
}

/** Deterministic scheduling only; never evaluates worker SQL or weakens the real cancellation tests. */
function controlledDisplaySettlement() {
	const originalNow = Date.now;
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	let now = 10_000;
	type ManualTimer = { callback: () => void; delay: number; cleared: boolean };
	const timers: ManualTimer[] = [];
	let resolveTask: (worker: ControlledWorker) => void = () => {};
	const task = new Promise<ControlledWorker>((resolve) => {
		resolveTask = resolve;
	});
	class ControlledWorker extends EventEmitter {
		requestId = "";
		terminated = false;
		constructor() {
			super();
			queueMicrotask(() => this.emit({ type: "ready", buildId: null }));
		}
		emit(event: string | symbol | DbWorkerOutbound, ...args: unknown[]): boolean {
			return typeof event === "object" ? super.emit("message", event) : super.emit(event, ...args);
		}
		postMessage(message: DbWorkerInbound): void {
			if (message.type === "task") {
				this.requestId = message.requestId;
				resolveTask(this);
			}
		}
		terminate(): void {
			this.terminated = true;
			this.emit("exit", 0);
		}
	}
	Date.now = () => now;
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay = 0,
		...args: unknown[]
	) => {
		const timer: ManualTimer = { callback: () => callback(...args), delay, cleared: false };
		timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout> | number | undefined) => {
		const timer = timers.find((entry) => entry === (handle as unknown));
		if (timer) timer.cleared = true;
		else originalClearTimeout(handle);
	}) as typeof clearTimeout;
	const workerFactory = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		const worker = new ControlledWorker();
		const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
		return new WorkerHandle(worker as unknown as NodeWorker, exited, () => worker.terminate());
	});
	return {
		task,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
		activeTimers: () => timers.filter((timer) => !timer.cleared),
		fire: (timer: ManualTimer) => {
			if (timer.cleared) throw new Error("Controlled deadline timer already cleared");
			timer.cleared = true;
			timer.callback();
		},
		restore: async () => {
			// Pool-owned fake handles must be cleared while our clearTimeout still knows them.
			await shutdownDbWorkerPool();
			Date.now = originalNow;
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
			workerFactory.mockRestore();
		},
	};
}

function deferredDisplayPort() {
	let resolveResult: (result: DisplayPageMessagesResult) => void = () => {};
	let rejectResult: (error: unknown) => void = () => {};
	let captureSignal: (signal: AbortSignal) => void = () => {};
	const requested = new Promise<AbortSignal>((resolve) => {
		captureSignal = resolve;
	});
	const result = new Promise<DisplayPageMessagesResult>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const port: NarratorDisplayPagePort = {
		execution: "off-main",
		readMessages: (_request, { signal }) => {
			captureSignal(signal);
			return result;
		},
	};
	return { port, requested, resolve: resolveResult, reject: rejectResult };
}

// Fixed callback/clock order proves the contract independently of native timer scheduling load.
test("display settlement maps the pool watchdog winning before the outer timer to a deadline", async () => {
	const clock = controlledDisplaySettlement();
	try {
		const failure = failureOf(read(["message-1"], 8192, { timeoutMs: 50 }));
		const worker = await clock.task;
		const deadlines = clock.activeTimers().filter((timer) => timer.delay === 50);
		expect(deadlines).toHaveLength(2); // public timer registered first, pool watchdog second.
		clock.advance(50);
		clock.fire(deadlines[1]);
		expect(await failure).toMatchObject({ statusCode: 504, code: "DISPLAY_PAGE_DEADLINE" });
		expect(worker.terminated).toBe(true);
		expect(getDbWorkerPoolStats().busy).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
		expect(clock.activeTimers()).toHaveLength(0);
	} finally {
		await clock.restore();
	}
});

test("display settlement rejects late success even when the public timer callback has not run", async () => {
	const clock = controlledDisplaySettlement();
	const deferred = deferredDisplayPort();
	try {
		const failure = failureOf(
			readNarratorDisplayMessages({ backend: "postgres", port: deferred.port }, ["message-1"], {
				ioBudget: 32,
				timeoutMs: 50,
			}),
		);
		const signal = await deferred.requested;
		clock.advance(51);
		deferred.resolve(boundedDisplayResult());
		expect(await failure).toMatchObject({ statusCode: 504, code: "DISPLAY_PAGE_DEADLINE" });
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toMatchObject({ statusCode: 504, code: "DISPLAY_PAGE_DEADLINE" });
		expect(clock.activeTimers()).toHaveLength(0);
	} finally {
		await clock.restore();
	}
});

test("display settlement accepts success before the absolute cutoff and removes its timer", async () => {
	const clock = controlledDisplaySettlement();
	const deferred = deferredDisplayPort();
	try {
		const response = readNarratorDisplayMessages(
			{ backend: "postgres", port: deferred.port },
			["message-1"],
			{ ioBudget: 32, timeoutMs: 50 },
		);
		const signal = await deferred.requested;
		clock.advance(49);
		const result = boundedDisplayResult();
		deferred.resolve(result);
		expect(await response).toEqual(result.messages);
		expect(signal.aborted).toBe(false);
		expect(clock.activeTimers()).toHaveLength(0);
	} finally {
		await clock.restore();
	}
});

test("display settlement rechecks the deadline after result validation crosses the cutoff", async () => {
	const clock = controlledDisplaySettlement();
	const deferred = deferredDisplayPort();
	try {
		const failure = failureOf(
			readNarratorDisplayMessages({ backend: "postgres", port: deferred.port }, ["message-1"], {
				ioBudget: 32,
				timeoutMs: 50,
			}),
		);
		const signal = await deferred.requested;
		const result = boundedDisplayResult();
		const messages = result.messages;
		let first = true;
		Object.defineProperty(result, "messages", {
			get: () => {
				if (first) {
					first = false;
					clock.advance(51);
				}
				return messages;
			},
		});
		deferred.resolve(result);
		expect(await failure).toMatchObject({ statusCode: 504, code: "DISPLAY_PAGE_DEADLINE" });
		expect(signal.aborted).toBe(true);
		expect(clock.activeTimers()).toHaveLength(0);
	} finally {
		await clock.restore();
	}
});

test("display settlement preserves a cancellation that happened before the late result or deadline callback", async () => {
	const clock = controlledDisplaySettlement();
	const deferred = deferredDisplayPort();
	const controller = new AbortController();
	try {
		const failure = failureOf(
			readNarratorDisplayMessages({ backend: "postgres", port: deferred.port }, ["message-1"], {
				ioBudget: 32,
				timeoutMs: 50,
				signal: controller.signal,
			}),
		);
		const signal = await deferred.requested;
		const deadline = clock.activeTimers()[0];
		controller.abort();
		clock.advance(51);
		clock.fire(deadline);
		deferred.resolve(boundedDisplayResult());
		expect(await failure).toMatchObject({ statusCode: 499, code: "DISPLAY_PAGE_CANCELLED" });
		expect(signal.reason).toMatchObject({ statusCode: 499, code: "DISPLAY_PAGE_CANCELLED" });
		expect(clock.activeTimers()).toHaveLength(0);
	} finally {
		await clock.restore();
	}
});

test("display settlement keeps real early and late failure codes instead of clock-normalizing unrelated errors", async () => {
	const cases = [
		{
			error: Object.assign(new Error("pool watchdog PRIVATE_DRIVER_SENTINEL"), {
				code: "DB_READ_TASK_TIMEOUT",
			}),
			statusCode: 504,
			code: "DISPLAY_PAGE_DEADLINE",
		},
		{
			error: new Error("native failure PRIVATE_DRIVER_SENTINEL"),
			statusCode: 503,
			code: "DISPLAY_PAGE_READER_UNAVAILABLE",
		},
		{
			error: Object.assign(new Error("refs changed"), { code: "DISPLAY_PAGE_REFERENCES_CHANGED" }),
			statusCode: 409,
			code: "DISPLAY_PAGE_REFERENCES_CHANGED",
		},
		{
			error: Object.assign(new Error("byte budget"), { code: "DISPLAY_PAGE_BUDGET_EXCEEDED" }),
			statusCode: 413,
			code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
		},
		{
			error: Object.assign(new Error("invalid JSON"), { code: "DISPLAY_PAGE_INVALID_JSON" }),
			statusCode: 500,
			code: "DISPLAY_PAGE_INVALID_JSON",
		},
		{
			error: Object.assign(new Error("invalid input"), { code: "DISPLAY_PAGE_INVALID_INPUT" }),
			statusCode: 400,
			code: "DISPLAY_PAGE_INVALID_INPUT",
		},
		{ error: new AppError("auth denied", 403, "FORBIDDEN"), statusCode: 403, code: "FORBIDDEN" },
	];
	for (const elapsed of [10, 51]) {
		for (const entry of cases) {
			const clock = controlledDisplaySettlement();
			const deferred = deferredDisplayPort();
			try {
				const failure = failureOf(
					readNarratorDisplayMessages({ backend: "postgres", port: deferred.port }, ["message-1"], {
						ioBudget: 32,
						timeoutMs: 50,
					}),
				);
				await deferred.requested;
				clock.advance(elapsed);
				deferred.reject(entry.error);
				const actual = await failure;
				expect(actual).toMatchObject({ statusCode: entry.statusCode, code: entry.code });
				expect((actual as Error).message).not.toContain("PRIVATE_DRIVER_SENTINEL");
				if (entry.error instanceof AppError) expect(actual).toBe(entry.error);
				expect(clock.activeTimers()).toHaveLength(0);
			} finally {
				await clock.restore();
			}
		}
	}
});

test.each([
	false,
	true,
])("display failure diagnostics never expose driver data or change the 503 when sink throws=%s", async (throws) => {
	const secret = "PRIVATE_DRIVER_SENTINEL /private/display.db";
	const original = Object.assign(new Error(secret), {
		code: "PRIVATE_CODE /private/query",
		name: secret,
	});
	original.stack = `Error: ${secret}\n    at /private/worker-entry.ts:7:4`;
	const warn = spyOn(logger, "warn").mockImplementation(() => {
		if (throws) throw new Error("PRIVATE_LOG_FAILURE");
	});
	try {
		const port: NarratorDisplayPagePort = {
			execution: "off-main",
			async readMessages() {
				throw original;
			},
		};
		const actual = await failureOf(
			readNarratorDisplayMessages({ backend: "postgres", port }, ["message-1"], { ioBudget: 32 }),
		);
		expect(actual).toMatchObject({ statusCode: 503, code: "DISPLAY_PAGE_READER_UNAVAILABLE" });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toBe("History display read failed");
		expect(warn.mock.calls[0]?.[1]).toMatchObject({ kind: "display-page", outcome: "error" });
		const logged = JSON.stringify(warn.mock.calls);
		for (const value of [
			"PRIVATE_DRIVER_SENTINEL",
			"PRIVATE_CODE",
			"PRIVATE_LOG_FAILURE",
			"/private/",
			"worker-entry.ts",
		])
			expect(logged).not.toContain(value);
		for (const value of Object.values(warn.mock.calls[0]?.[1] ?? {}))
			expect(
				value === undefined ||
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean",
			).toBe(true);
	} finally {
		warn.mockRestore();
	}
});
describe("real readonly display page worker", () => {
	test("explicit DTO columns stay field-compatible with Drizzle, without importing it into the worker", () => {
		expect(DISPLAY_MESSAGE_COLUMNS.map((column) => column.field).sort()).toEqual(
			Object.keys(getTableColumns(narratorMessages))
				.map((key) => (key === "composerDocument" ? "hasComposerDocument" : key))
				.sort(),
		);
		expect(DISPLAY_TOOL_COLUMNS.map((column) => column.field).sort()).toEqual(
			Object.keys(getTableColumns(narratorToolCalls)).sort(),
		);
		for (const [descriptors, table] of [
			[DISPLAY_MESSAGE_COLUMNS, narratorMessages],
			[DISPLAY_TOOL_COLUMNS, narratorToolCalls],
		] as const) {
			const actualColumns = getTableColumns(table) as Record<string, { name: string }>;
			for (const descriptor of descriptors)
				expect(descriptor.column).toBe(
					actualColumns[
						descriptor.field === "hasComposerDocument" ? "composerDocument" : descriptor.field
					].name,
				);
		}
	});

	test("rich layout is represented by a boolean, never read into the display budget", async () => {
		message(writer, "message-1");
		writer.run("UPDATE narrator_messages SET composer_document = ? WHERE id = 'message-1'", [
			"private-layout".repeat(200_000),
		]);
		const [row] = await read();
		expect(row.hasComposerDocument).toBe(true);
		expect(Object.hasOwn(row, "composerDocument")).toBe(false);
		expect(JSON.stringify(row)).not.toContain("private-layout");
	});

	test("display worker and protocol never pull in narrator/model runtime or DB bootstrap", async () => {
		const worker = await Bun.build({
			entrypoints: [fileURLToPath(new URL("../worker-entry.ts", import.meta.url))],
			target: "bun",
		});
		expect(worker.success).toBe(true);
		const bundled = await worker.outputs[0].text();
		for (const symbol of [
			"acquireInstanceLock",
			"consumeCleanShutdownState",
			"ensureFts",
			"sqliteTable",
			"drizzle-orm",
			"getPretextDocumentPage",
			"loadModelHistorySource",
			"executePersistedToolCall",
		])
			expect(bundled).not.toContain(symbol);
		const protocol = await Bun.build({
			entrypoints: [fileURLToPath(new URL("../display-page-protocol.ts", import.meta.url))],
			target: "bun",
		});
		expect(protocol.success).toBe(true);
		const contract = await protocol.outputs[0].text();
		expect(contract).not.toContain("bun:sqlite");
		expect(contract).not.toContain("JSON.parse");
	}, 30_000);

	test("preserves fields/presence, canonical attempt/execution identity, caller ordering and public creator only", async () => {
		message(writer, "message-2", {
			role: "system",
			parentToolUseId: null,
			contentJson: [{ type: "compact", status: "completed" }],
		});
		message(writer, "message-1", {
			bodyRevision: 7,
			costMissingFields: [],
			contextCharsJson: { total: 12 },
			originalContentJson: [],
			messageUuid: "provider-msg",
			contentJson: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } }],
		});
		// The discarded attempt is deliberately too large for the raw budget and invalid
		// JSON: neither its body nor its parsing belongs to a display page.
		tool(writer, "old", { executionAttempt: 1 });
		writer.run("UPDATE narrator_tool_calls SET output_json = ? WHERE id = 'old'", [
			"bad-json".repeat(3_000_000),
		]);
		tool(writer, "a", { executionAttempt: 10 });
		tool(writer, "z", {
			executionAttempt: 10,
			modelRevision: 9,
			executionIdentityVersion: 1,
			executionOriginToolCallId: "origin-pk",
			executionSegmentId: "segment-pk",
			fileChangeOperationId: "operation-pk",
			executionDeviceId: "remote-exact",
			executionCwd: "D:\\实际路径",
			executionPathFlavor: "windows",
			resolvedFilePath: "D:\\实际路径\\file.txt",
			canonicalFilePath: "D:\\real\\file.txt",
			runtimeGeneration: 12,
			deviceSelectionSource: "explicit",
			isBackground: true,
			isFileHistoryCheckpoint: false,
			permissionSuggestions: [],
			ownedPathsJson: [],
			resultMessageId: "result-pk",
			outputJson: null,
		});
		const rows = await read(["message-2", "message-1"]);
		expect(rows.map((row) => row.id)).toEqual(["message-2", "message-1"]);
		const row = rows[1];
		expect(row.parentToolUseId).toBe("inline-parent");
		expect(row.messageUuid).toBe("provider-msg");
		expect(Object.hasOwn(row, "seq")).toBe(false); // Main attaches authorized junction seq, not the worker.
		expect(row.bodyRevision).toBe(7);
		expect(row.costMissingFields).toEqual([]);
		expect(row.originalContentJson).toEqual([]);
		expect(row.creator).toEqual({
			id: "alice",
			username: "爱丽丝",
			avatarColor: "indigo",
			avatarImageId: "avatar-1",
		});
		expect(JSON.stringify(rows)).not.toContain("NEVER_DISPLAY_PASSWORD");
		expect(JSON.stringify(rows)).not.toContain("private@secret.invalid");
		expect(row.toolCalls).toHaveLength(1);
		expect(row.toolCalls[0]).toMatchObject({
			id: "z",
			narratorId: "execution-owner",
			messageId: "message-1",
			executionAttempt: 10,
			modelRevision: 9,
			executionIdentityVersion: 1,
			executionOriginToolCallId: "origin-pk",
			executionSegmentId: "segment-pk",
			fileChangeOperationId: "operation-pk",
			resultMessageId: "result-pk",
			outputJson: null,
			permissionSuggestions: [],
			ownedPathsJson: [],
			isBackground: true,
			isFileHistoryCheckpoint: false,
			executionTarget: {
				deviceId: "remote-exact",
				cwd: "D:\\实际路径",
				runtimeGeneration: 12,
				canonicalPath: "D:\\real\\file.txt",
			},
		});
		expect(getDbWorkerPoolStats().workers).toBe(1);
	}, 30_000);

	test("structured execution plan and nullable/empty fields do not change during projection", async () => {
		message(writer);
		const plan = {
			kind: "file",
			primaryKey: "target-1",
			endpoints: [
				{
					key: "target-1",
					target: {
						deviceId: "remote-plan",
						backendKind: "remote",
						cwd: "/cwd",
						lexicalPath: "/cwd/file",
						canonicalPath: "/canonical/file",
						pathFlavor: "posix",
						runtimeGeneration: 5,
						selectionSource: "explicit",
					},
				},
			],
		};
		tool(writer, "tool-1", {
			executionTargetsJson: plan,
			executionCwd: null,
			inputJson: null,
			outputJson: {},
			permissionSuggestions: null,
		});
		const [row] = await read();
		expect(row.toolCalls[0].executionPlan).toEqual(plan);
		expect(row.toolCalls[0].executionTargetsJson).toEqual(plan);
		expect(row.toolCalls[0].executionCwd).toBeNull();
		expect(row.toolCalls[0].inputJson).toBeNull();
		expect(row.toolCalls[0].outputJson).toEqual({});
		expect(Object.hasOwn(row.toolCalls[0], "permissionSuggestions")).toBe(true);
	}, 30_000);

	test("worker projects duplicated huge I/O, keeps metadata/encrypted placeholder, and main JSON.parse never sees raw payload", async () => {
		message(writer);
		await read(); // Warm the thread: startup is not evidence of actual parse isolation.
		const cjk = "大字段😀".repeat(350_000);
		const input = {
			description: "只读 fixture",
			command: "pwd",
			body: `RAW_DISPLAY_SENTINEL${cjk}`,
		};
		const content = [
			{
				type: "thinking",
				thinking: "",
				providerMetadata: {
					openai: { reasoningEncryptedContent: "cipher".repeat(200_000), itemId: "replay-only" },
				},
			},
			{
				type: "thinking",
				thinking: "可见",
				providerMetadata: { anthropic: { signature: "replay-only" } },
			},
			{ type: "tool_use", id: "call-1", name: "Bash", input },
			{
				type: "file_reference",
				reference: { id: "ref", deviceId: "local", path: "/file", label: "file" },
				snapshotText: "hidden model body",
				snapshotHash: "hash",
				capturedAt: "time",
			},
		];
		writer.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message-1'", [
			JSON.stringify(content),
		]);
		tool(writer, "tool-1", {
			inputJson: input,
			outputJson: { _text: cjk, _metadata: { ok: true, result: "结构化卡片" } },
		});
		const originalParse = JSON.parse;
		let mainRawParses = 0;
		let beats = 0;
		JSON.parse = ((
			text: string,
			reviver?: (this: unknown, key: string, value: unknown) => unknown,
		) => {
			if (text.length > 256 * 1024 && text.includes("RAW_DISPLAY_SENTINEL")) {
				mainRawParses++;
				throw new Error("raw display JSON was parsed on main");
			}
			return originalParse(text, reviver);
		}) as typeof JSON.parse;
		const timer = setInterval(() => beats++, 1);
		try {
			const [row] = await read();
			const blocks = row.contentJson as Array<Record<string, unknown>>;
			expect(blocks[0].providerMetadata).toEqual({ hasEncryptedReasoning: true });
			expect(Object.hasOwn(blocks[1], "providerMetadata")).toBe(false);
			expect(blocks[3]).toEqual({ type: "file_reference", reference: content[3].reference });
			expect(row.toolCalls[0].inputJson).toMatchObject({
				command: "pwd",
				body: {
					_truncated: true,
					fullLength: input.body.length,
					preview: input.body.slice(0, 8192),
				},
			});
			expect(blocks[2].input).toEqual(row.toolCalls[0].inputJson);
			expect(row.toolCalls[0].outputJson).toMatchObject({
				_text: { _truncated: true },
				_metadata: { ok: true, result: "结构化卡片" },
			});
			expect(mainRawParses).toBe(0);
			expect(beats).toBeGreaterThan(0);
		} finally {
			clearInterval(timer);
			JSON.parse = originalParse;
		}
		expect(
			JSON.parse(
				writer.query<{ input_json: string }, []>("SELECT input_json FROM narrator_tool_calls").get()
					?.input_json ?? "null",
			),
		).toEqual(input);
		expect(
			JSON.parse(
				writer
					.query<{ content_json: string }, []>("SELECT content_json FROM narrator_messages")
					.get()?.content_json ?? "null",
			),
		).toEqual(content);
	}, 30_000);

	test("ExitPlanMode, Agent/Task/Send and spec_tasks inputs are preserved, not falsely truncated", async () => {
		const body = "完整中文输入".repeat(3000);
		const names = ["ExitPlanMode", "Agent", "Task", "Send", "Write", "Edit"];
		const content = names.map((name, index) => ({
			type: "tool_use",
			id: `call-${index}`,
			name,
			input: {
				...(name === "Write" || name === "Edit" ? { file_path: "spec://tasks.json" } : {}),
				body,
			},
		}));
		message(writer, "message-1", { contentJson: content });
		for (const [index, name] of names.entries())
			tool(writer, `tool-${index}`, {
				toolUseId: `call-${index}`,
				toolName: name,
				inputJson: content[index].input,
				outputJson: { _text: body },
			});
		const [row] = await read(["message-1"], 32);
		for (const [index, call] of row.toolCalls.entries()) {
			expect(call.inputJson).toEqual(content[index].input);
			expect((row.contentJson as typeof content)[index].input).toEqual(content[index].input);
			expect(call.outputJson).toEqual(
				index === 0
					? { _text: body }
					: { _text: { _truncated: true, preview: body.slice(0, 32), fullLength: body.length } },
			);
		}
	}, 30_000);

	test("raw budget is UTF-8, checked before retrieval/parsing, and no partial page is returned", async () => {
		message(writer);
		tool(writer);
		writer.run("UPDATE narrator_tool_calls SET input_json = ?", ["原始密码".repeat(2_000_000)]);
		expect(await failureOf(read())).toMatchObject({
			statusCode: 413,
			code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
		});
		writer.run("UPDATE narrator_tool_calls SET input_json = 'null'");
		expect(await read()).toHaveLength(1); // A rejected task does not poison the cached connection.
	}, 30_000);

	test("projected page budget is total UTF-8 bytes, not per-message UTF-16 chars", async () => {
		const text = "中".repeat(800_000);
		message(writer, "message-1", { contentJson: [{ type: "text", text }] });
		message(writer, "message-2", { contentJson: [{ type: "text", text }] });
		expect(() => runDisplayPageQuery(writer, request(["message-1", "message-2"]))).toThrow(
			"projected UTF-8",
		);
		expect(await read(["message-1"])).toHaveLength(1);
		const projectedFailure = await read(["message-1", "message-2"]).catch(
			(error: unknown) => error,
		);
		expect(projectedFailure).toMatchObject({
			statusCode: 413,
			code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
		});
	}, 30_000);

	test("dense scalar arrays and wide objects are rejected before JSON.parse, quoted punctuation is not graph shape", async () => {
		message(writer);
		tool(writer);
		const originalParse = JSON.parse;
		let forbiddenParses = 0;
		try {
			JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
				if (text.includes("DENSE_DISPLAY_PARSE_SENTINEL")) {
					forbiddenParses++;
					throw new Error("dense input reached JSON.parse");
				}
				return originalParse(text, reviver);
			}) as typeof JSON.parse;
			for (const value of [
				{
					sentinel: "DENSE_DISPLAY_PARSE_SENTINEL",
					dense: Array.from({ length: 17_000 }, () => false),
				},
				{
					sentinel: "DENSE_DISPLAY_PARSE_SENTINEL",
					wide: Object.fromEntries(
						Array.from({ length: 17_000 }, (_, index) => [`k${index}`, index]),
					),
				},
			]) {
				writer.run("UPDATE narrator_tool_calls SET input_json=?", [JSON.stringify(value)]);
				let failure: unknown;
				try {
					runDisplayPageQuery(writer, request());
				} catch (error) {
					failure = error;
				}
				expect(failure).toMatchObject({ code: "DISPLAY_PAGE_BUDGET_EXCEEDED" });
				expect(forbiddenParses).toBe(0);
				expect(await failureOf(read())).toMatchObject({
					statusCode: 413,
					code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
				});
			}
		} finally {
			JSON.parse = originalParse;
		}
		tool(writer, "literal-tool", {
			toolUseId: "literal-use",
			inputJson: { quoted: "[,:{中文}]".repeat(17_000) },
		});
		writer.run("UPDATE narrator_tool_calls SET input_json='{}' WHERE id='tool-1'");
		expect(await read()).toHaveLength(1);
	}, 30_000);

	test("projected clone allocation is bounded even when nested scalar arrays fit the 4MiB wire budget", async () => {
		message(writer, "message-1", {
			contentJson: [
				{
					type: "text",
					text: "dense metadata",
					data: Array.from({ length: 80 }, () => Array.from({ length: 16_000 }, () => 0)),
				},
			],
		});
		const failure = await failureOf(read());
		expect(failure).toMatchObject({ statusCode: 413, code: "DISPLAY_PAGE_BUDGET_EXCEEDED" });
		expect((failure as Error).message).toContain("allocation");
	}, 30_000);

	test("caller IDs, row overflow, malformed JSON and changed references fail explicitly without raw error leaks", async () => {
		message(writer);
		expect(await failureOf(read(["message-1", "message-1"]))).toMatchObject({
			statusCode: 400,
			code: "DISPLAY_PAGE_INVALID_INPUT",
		});
		expect(
			await failureOf(read(Array.from({ length: 501 }, (_, index) => `m-${index}`))),
		).toMatchObject({ statusCode: 400 });
		expect(await failureOf(read(["missing"]))).toMatchObject({
			statusCode: 409,
			code: "DISPLAY_PAGE_REFERENCES_CHANGED",
		});
		tool(writer);
		writer.run("UPDATE narrator_tool_calls SET output_json = 'malformed SECRET_PASSWORD'");
		const failure = await read().catch((error: unknown) => error);
		expect(failure).toMatchObject({ statusCode: 500, code: "DISPLAY_PAGE_INVALID_JSON" });
		expect((failure as Error).message).not.toContain("SECRET_PASSWORD");
		writer.run("DELETE FROM narrator_tool_calls");
		writer.transaction(() => {
			for (let index = 0; index < DISPLAY_PAGE_LIMITS.maxRows; index++)
				tool(writer, `t-${index}`, { toolUseId: `u-${index}` });
		})();
		expect(await failureOf(read())).toMatchObject({
			statusCode: 413,
			code: "DISPLAY_PAGE_BUDGET_EXCEEDED",
		});
	}, 30_000);

	test("actual readonly connection can run the reader but cannot write, and sees committed WAL changes", async () => {
		message(writer);
		const readonly = new Database(dbPath, { readonly: true });
		try {
			expect(runDisplayPageQuery(readonly, request()).messages[0].id).toBe("message-1");
			expect(() => readonly.run("DELETE FROM narrator_messages")).toThrow(/readonly|read-only/i);
		} finally {
			readonly.close();
		}
		expect(await read()).toHaveLength(1);
		message(writer, "message-2");
		expect(await read(["message-1", "message-2"])).toHaveLength(2);
		const entry = await Bun.file(new URL("../worker-entry.ts", import.meta.url)).text();
		expect(entry).toContain("new Database(dbPath, { readonly: true })");
	}, 30_000);

	test("an inline raw-byte ceiling may be lowered, never increased, before parsing", async () => {
		message(writer);
		tool(writer, "tool-1", { inputJson: { body: "x".repeat(5 * 1024 * 1024) } });
		expect(await read()).toHaveLength(1);
		const lower = await failureOf(
			readNarratorDisplayMessages({ backend: "sqlite", dbPath }, ["message-1"], {
				ioBudget: 32,
				maxRawBytes: 4 * 1024 * 1024,
			}),
		);
		expect(lower).toMatchObject({ statusCode: 413, code: "DISPLAY_PAGE_BUDGET_EXCEEDED" });
		const higher = await failureOf(
			readNarratorDisplayMessages({ backend: "sqlite", dbPath }, ["message-1"], {
				ioBudget: 32,
				maxRawBytes: DISPLAY_PAGE_LIMITS.maxRawBytes + 1,
			}),
		);
		expect(higher).toMatchObject({ statusCode: 400, code: "DISPLAY_PAGE_INVALID_INPUT" });
	}, 30_000);

	test("cancelling an ACTUAL display read retires its busy worker and frees the slot", async () => {
		message(writer);
		await read(); // Warm/cache the worker before installing a fixture-only expensive view.
		installSlowDisplayFixture();
		const controller = new AbortController();
		const task = failureOf(read(["message-1"], 8192, { signal: controller.signal }));
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(getDbWorkerPoolStats().busy).toBe(1);
		controller.abort();
		expect(await task).toMatchObject({ statusCode: 499, code: "DISPLAY_PAGE_CANCELLED" });
		// HTTP detaches immediately; synchronous SQLite may still be unwinding in its thread.
		// Only the awaited close barrier proves the DB connection and permit were released.
		await shutdownDbWorkerPool();
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(getDbWorkerPoolStats().busy).toBe(0);
		removeSlowDisplayFixture();
		expect(await read()).toHaveLength(1);
	}, 30_000);

	test("the total display deadline cancels active work, not just a queue wait", async () => {
		message(writer);
		await read();
		installSlowDisplayFixture();
		const started = Date.now();
		expect(await failureOf(read(["message-1"], 8192, { timeoutMs: 50 }))).toMatchObject({
			statusCode: 504,
			code: "DISPLAY_PAGE_DEADLINE",
		});
		expect(Date.now() - started).toBeLessThan(1500);
		await shutdownDbWorkerPool();
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
		removeSlowDisplayFixture();
		expect(await read()).toHaveLength(1);
	}, 30_000);

	test("already-cancelled and queued display reads settle without leaking worker queue entries", async () => {
		message(writer);
		await read();
		const preCancelled = new AbortController();
		preCancelled.abort();
		expect(
			await failureOf(read(["message-1"], 8192, { signal: preCancelled.signal })),
		).toMatchObject({ statusCode: 499 });
		const blockerController = new AbortController();
		const blocker = failureOf(
			runReadTask(
				dbPath,
				{
					kind: "selectRows",
					sql: "WITH RECURSIVE scan(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM scan WHERE n < ?) SELECT sum(n) FROM scan",
					params: [20_000_000],
					maxRows: 1,
				},
				{ signal: blockerController.signal },
			),
		);
		const queuedController = new AbortController();
		const queued = failureOf(read(["message-1"], 8192, { signal: queuedController.signal }));
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(getDbWorkerPoolStats().queued).toBe(1);
		queuedController.abort();
		expect(await queued).toMatchObject({ statusCode: 499 });
		expect(getDbWorkerPoolStats().queued).toBe(0);
		blockerController.abort();
		await blocker;
		expect(await read()).toHaveLength(1);
	}, 30_000);

	test("port concurrency/queue are bounded, queued deadline includes waiting, and cancellation keeps capacity reserved until work stops", async () => {
		message(writer);
		const bounded = await runReadTask<DisplayPageMessagesResult>(dbPath, request());
		let running = 0;
		let maxRunning = 0;
		let calls = 0;
		const port: NarratorDisplayPagePort = {
			execution: "off-main",
			readMessages: async (_input, { signal }) => {
				calls++;
				maxRunning = Math.max(maxRunning, ++running);
				try {
					await new Promise<void>((_resolve, reject) =>
						signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
					return bounded;
				} finally {
					running--;
				}
			},
		};
		const controller = new AbortController();
		const tasks = Array.from(
			{ length: DISPLAY_PAGE_LIMITS.concurrency + DISPLAY_PAGE_LIMITS.maxPending + 1 },
			() =>
				failureOf(
					readNarratorDisplayMessages({ backend: "postgres", port }, ["message-1"], {
						ioBudget: 32,
						signal: controller.signal,
					}),
				),
		);
		expect(await tasks[tasks.length - 1]).toMatchObject({
			statusCode: 503,
			code: "DISPLAY_PAGE_READER_BUSY",
		});
		expect(
			await failureOf(
				readNarratorDisplayMessages({ backend: "postgres", port }, ["message-1"], {
					ioBudget: 32,
					timeoutMs: 40,
				}),
			),
		).toMatchObject({ statusCode: 503, code: "DISPLAY_PAGE_READER_BUSY" });
		controller.abort();
		expect(
			(await Promise.all(tasks)).every(
				(value) => value && typeof value === "object" && "statusCode" in value,
			),
		).toBe(true);
		expect(maxRunning).toBe(2);
		expect(calls).toBe(2);
		expect(running).toBe(0);
		const blockerController = new AbortController();
		const blockers = Array.from({ length: 2 }, () =>
			failureOf(
				readNarratorDisplayMessages({ backend: "postgres", port }, ["message-1"], {
					ioBudget: 32,
					signal: blockerController.signal,
				}),
			),
		);
		const started = Date.now();
		expect(
			await failureOf(
				readNarratorDisplayMessages({ backend: "postgres", port }, ["message-1"], {
					ioBudget: 32,
					timeoutMs: 40,
				}),
			),
		).toMatchObject({ statusCode: 504, code: "DISPLAY_PAGE_DEADLINE" });
		expect(Date.now() - started).toBeLessThan(1000);
		blockerController.abort();
		await Promise.all(blockers);
		expect(await read()).toHaveLength(1);
	}, 30_000);

	test("no synchronous fallback when workers are disabled or SQLite/PG source is unsupported", async () => {
		message(writer);
		process.env.NARRAFORK_DB_WORKER = "off";
		expect(await failureOf(read())).toMatchObject({
			statusCode: 503,
			code: "DISPLAY_PAGE_READER_UNAVAILABLE",
		});
		expect(
			await failureOf(
				readNarratorDisplayMessages({ backend: "sqlite", dbPath: ":memory:" }, ["message-1"], {
					ioBudget: 32,
				}),
			),
		).toMatchObject({ statusCode: 503 });
		expect(
			await failureOf(
				readNarratorDisplayMessages({ backend: "postgres" }, ["message-1"], { ioBudget: 32 }),
			),
		).toMatchObject({ statusCode: 503 });
	}, 30_000);

	test("explicit small memory fixtures work, oversized/file fixtures and production use do not", async () => {
		const memory = new Database(":memory:");
		try {
			createFixture(memory);
			message(memory);
			expect(
				await readDisplayFixtureMessages(memory, ["message-1"], { ioBudget: 32 }),
			).toHaveLength(1);
			tool(memory, "tool-1", { inputJson: { body: "x".repeat(300_000) } });
			expect(
				await failureOf(readDisplayFixtureMessages(memory, ["message-1"], { ioBudget: 32 })),
			).toMatchObject({ statusCode: 413 });
			const previous = process.env.NODE_ENV;
			try {
				process.env.NODE_ENV = "production";
				expect(
					await failureOf(readDisplayFixtureMessages(memory, ["message-1"], { ioBudget: 32 })),
				).toMatchObject({ statusCode: 503 });
			} finally {
				process.env.NODE_ENV = previous;
			}
			expect(
				await failureOf(readDisplayFixtureMessages(writer, ["message-1"], { ioBudget: 32 })),
			).toMatchObject({ statusCode: 503 });
		} finally {
			memory.close();
		}
	}, 30_000);

	test("PG async port receives only validated authorized IDs and bounded output; no SQL or HTTP parameters", async () => {
		message(writer);
		const bounded = await runReadTask<DisplayPageMessagesResult>(dbPath, request());
		const calls: DisplayPageMessagesParams[] = [];
		const port: NarratorDisplayPagePort = {
			execution: "off-main",
			readMessages: async (input, options) => {
				calls.push(input);
				expect(options.signal).toBeInstanceOf(AbortSignal);
				return bounded;
			},
		};
		const result = await readNarratorDisplayMessages({ backend: "postgres", port }, ["message-1"], {
			ioBudget: 32,
		});
		expect(result).toEqual(bounded.messages);
		expect(calls[0]).toMatchObject({
			kind: "displayPageMessages",
			messageIds: ["message-1"],
			ioBudget: 32,
		});
		expect(Object.hasOwn(calls[0], "sql")).toBe(false);
		const invalidPort: NarratorDisplayPagePort = {
			execution: "off-main",
			readMessages: async () => ({
				...bounded,
				outputBytes: DISPLAY_PAGE_LIMITS.maxOutputBytes + 1,
			}),
		};
		expect(
			await failureOf(
				readNarratorDisplayMessages({ backend: "postgres", port: invalidPort }, ["message-1"], {
					ioBudget: 32,
				}),
			),
		).toMatchObject({ statusCode: 503 });
	}, 30_000);
});
