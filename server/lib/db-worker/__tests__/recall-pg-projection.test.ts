import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { COMPILED_WORKER_ENTRIES } from "../../compiled-worker";
import type { RecallMessagePage } from "../../recall-contract";
import { WorkerHandle } from "../../worker-runtime/lifecycle";
import { projectRecallPg, type RecallPgProjectionRequest } from "../recall-pg-projection";
import { createRecallPgProjectionRunner } from "../recall-pg-projection-client";

const input = { narratorId: "n", messageId: "m", offset: 0, maxChars: 20000 };
const request = (contentJson: string): RecallPgProjectionRequest => ({
	kind: "message",
	input,
	row: {
		messageId: "m",
		narratorId: "n",
		narratorTitle: "title",
		role: "assistant",
		origin: null,
		createdAt: "now",
		seq: "7",
		bodyRevision: "3",
		contentJson,
		toolCalls: [],
	},
});
const failureOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
afterEach(() => mock.restore());

test("PG projection preserves omitted/visible escaped NUL and native model text", () => {
	const result = projectRecallPg(
		request(
			JSON.stringify([
				{ type: "text", text: "原\0😄文" },
				{ type: "image", source: { data: "omitted\0bytes" } },
				{ type: "system_injection", modelText: "native\0text", body: { hidden: "secret\0" } },
			]),
		),
		Date.now() + 30000,
	) as RecallMessagePage;
	expect(result.text).toBe("原\0😄文\nnative\0text");
	expect(result.totalChars).toBe(Array.from(result.text).length);
	expect(result.omittedBlocks).toEqual(["image"]);
	expect(result).not.toHaveProperty("originLabel");
	expect(JSON.stringify(result)).not.toContain("secret");
});

test("PG projection code-point pages include NUL and preserve huge offsets", () => {
	const body = JSON.stringify([{ type: "text", text: "A😄\0B" }]);
	for (const [offset, maxChars, text, nextOffset] of [
		[1, 2, "😄\0", 3],
		[3, 2, "B", null],
		[Number.MAX_SAFE_INTEGER, 20, "", null],
	] as const) {
		const work = request(body);
		if (work.kind !== "message") throw new Error("fixture");
		work.input = { ...input, offset, maxChars };
		expect(projectRecallPg(work, Date.now() + 30000)).toMatchObject({
			text,
			offset,
			totalChars: 4,
			nextOffset,
			hasMore: nextOffset !== null,
		});
	}
});

test("PG projection rejects malformed/nonarray/source/result budgets and expired deadlines", () => {
	for (const raw of ["not json", "{}"])
		expect(() => projectRecallPg(request(raw), Date.now() + 30000)).toThrow();
	expect(() =>
		projectRecallPg(request("x".repeat(40 * 1024 * 1024 + 1)), Date.now() + 30000),
	).toThrow("source budget");
	expect(() =>
		projectRecallPg(
			request(JSON.stringify(Array.from({ length: 10000 }, () => ({ type: "omitted".repeat(5) })))),
			Date.now() + 30000,
		),
	).toThrow("metadata");
	expect(() => projectRecallPg(request("[]"), Date.now() - 1)).toThrow("deadline");
});

test("registered real PG Worker parses raw JSON off-main and emits bounded pages", async () => {
	expect(COMPILED_WORKER_ENTRIES).toContain("lib/db-worker/recall-pg-projection-worker.ts");
	const parse = JSON.parse;
	let mainParses = 0;
	spyOn(JSON, "parse").mockImplementation(
		(text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
			if (text.includes("PG_WORKER_NUL_SENTINEL")) mainParses++;
			return parse(text, reviver);
		},
	);
	const run = createRecallPgProjectionRunner({ disabled: () => false });
	const result = await run<RecallMessagePage>(async () =>
		request(
			JSON.stringify([
				{ type: "image", data: "PG_WORKER_NUL_SENTINEL\0" },
				{ type: "text", text: "原\0😄文" },
			]),
		),
	);
	expect(result?.text).toBe("原\0😄文");
	expect(mainParses).toBe(0);
	const rows = await run<Record<string, unknown>[]>(async () => ({
		kind: "summaries",
		rows: [
			{
				id: "tool",
				tool_name: "AskUserQuestion",
				recall_summary_input: JSON.stringify({
					questions: [{ header: "选择\0😄" }],
					command: "a\0b",
				}),
			},
		],
	}));
	expect(rows?.[0]).toMatchObject({ question_header: "选择\0😄", command: "a\0b" });
	expect(rows?.[0]).not.toHaveProperty("recall_summary_input");
});

function fakeHandle(mode: "crash" | "timeout" | "success") {
	const worker = new EventEmitter() as EventEmitter & { postMessage: () => void };
	let exited!: (code: number) => void;
	const handle = new WorkerHandle(
		worker as unknown as Worker,
		new Promise<number>((resolve) => {
			exited = resolve;
		}),
		() => {
			exited(0);
		},
	);
	worker.postMessage = () => {
		if (mode === "crash") queueMicrotask(() => worker.emit("error", new Error("worker failed")));
		if (mode === "success")
			queueMicrotask(() => worker.emit("message", { result: { text: "only-worker-result" } }));
	};
	return handle;
}

for (const fault of ["spawn", "crash", "timeout", "disabled", "cancelled", "deadline"] as const) {
	test(`PG Worker ${fault} never falls back to inline JSON parsing`, async () => {
		const load = mock(async () => request('[{"type":"text","text":"INLINE_FORBIDDEN"}]'));
		const parse = JSON.parse;
		let mainParses = 0;
		spyOn(JSON, "parse").mockImplementation(
			(text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
				if (text.includes("INLINE_FORBIDDEN")) mainParses++;
				return parse(text, reviver);
			},
		);
		const run = createRecallPgProjectionRunner({
			disabled: () => fault === "disabled",
			launch: async () => {
				if (fault === "spawn") throw new Error("creation failed");
				return fakeHandle(fault === "crash" ? "crash" : "timeout");
			},
		});
		const error = await failureOf(
			run(
				load,
				fault === "cancelled" ? AbortSignal.abort() : undefined,
				Date.now() + (fault === "deadline" ? -1 : fault === "timeout" ? 20 : 30000),
			),
		);
		expect(error).toBeInstanceOf(Error);
		if (["disabled", "spawn", "cancelled", "deadline"].includes(fault))
			expect(load).not.toHaveBeenCalled();
		expect(mainParses).toBe(0);
	});
}

test("PG Worker cancellation terminates in-flight projection and backpressure rejects excess fetches", async () => {
	const run = createRecallPgProjectionRunner({
		disabled: () => false,
		launch: async () => fakeHandle("timeout"),
	});
	const controller = new AbortController();
	const load = mock(async () => request("[]"));
	const first = failureOf(run(load, controller.signal));
	const second = failureOf(run(load, controller.signal));
	await Promise.resolve();
	expect(await failureOf(run(load))).toMatchObject({ code: "DB_READ_UNAVAILABLE" });
	expect(load.mock.calls.length).toBeLessThanOrEqual(2);
	controller.abort();
	for (const result of await Promise.all([first, second]))
		expect(result).toMatchObject({ code: "DB_READ_ABORTED" });
});

for (const fault of ["cancel", "deadline"] as const) {
	test(`PG pending raw fetch ${fault} fails promptly but retains admission until late settlement`, async () => {
		let settle!: (value: RecallPgProjectionRequest | null) => void;
		const pending = new Promise<RecallPgProjectionRequest | null>((resolve) => {
			settle = resolve;
		});
		let stopped = 0;
		const run = createRecallPgProjectionRunner({
			disabled: () => false,
			launch: async () => {
				const handle = fakeHandle("success");
				const close = handle.close.bind(handle);
				handle.close = () => {
					stopped++;
					return close();
				};
				return handle;
			},
		});
		const controller = new AbortController();
		let entered!: () => void;
		const loaded = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const load = mock(async () => {
			entered();
			return pending;
		});
		const first = failureOf(
			run(load, controller.signal, Date.now() + (fault === "deadline" ? 25 : 30000)),
		);
		await loaded;
		if (fault === "cancel") controller.abort();
		expect(await first).toMatchObject({
			code: fault === "cancel" ? "DB_READ_ABORTED" : "DB_READ_TASK_TIMEOUT",
		});
		expect(stopped).toBe(1);
		const secondController = new AbortController();
		const second = failureOf(run(async () => pending, secondController.signal));
		await Promise.resolve();
		expect(await failureOf(run(async () => request("[]")))).toMatchObject({
			code: "DB_READ_UNAVAILABLE",
		});
		secondController.abort();
		await second;
		// Resolve the abandoned query with malformed payload: no inline parse or projection occurs.
		settle(request("LATE_INVALID_JSON"));
		await Promise.resolve();
		await Promise.resolve();
	});
}
