import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as threads from "node:worker_threads";
import { resumeDbWorkerPool, shutdownDbWorkerPool } from "../lib/db-worker/pool";
import * as tokenService from "./token-recalculation-service";
import * as sqliteStore from "./token-recalculation-sqlite";

type Mode =
	| "healthy"
	| "constructor"
	| "not-ready"
	| "init-error"
	| "crash"
	| "exit"
	| "timeout"
	| "held"
	| "cleanup-error"
	| "null-response"
	| "missing-result"
	| "ambiguous-response"
	| "invalid-id";
let mode: Mode = "healthy";
let constructions = 0;
const workers: FaultWorker[] = [];
class FaultWorker extends EventEmitter {
	messages: Array<{ action: string; id: number }> = [];
	stopped = false;
	readonly failedCleanup = mode === "cleanup-error";
	constructor() {
		super();
		constructions++;
		if (mode === "constructor") throw new Error("injected constructor failure");
		workers.push(this);
	}
	postMessage(message: { action: string; id: number }) {
		this.messages.push(message);
		queueMicrotask(() => {
			if (this.stopped) return;
			if (message.action === "ping") {
				if (mode !== "not-ready" && !this.failedCleanup) this.emit("message", { ready: true });
			} else if (message.action === "init") {
				this.emit(
					"message",
					mode === "init-error"
						? { id: message.id, error: "injected init failure" }
						: { id: message.id, result: undefined },
				);
			} else if (message.action === "close")
				this.emit("message", { id: message.id, result: undefined });
			else if (mode === "null-response") this.emit("message", null);
			else if (mode === "missing-result") this.emit("message", { id: message.id });
			else if (mode === "ambiguous-response")
				this.emit("message", { id: message.id, error: "ambiguous", result: [] });
			else if (mode === "invalid-id") this.emit("message", { id: Number.NaN, result: [] });
			else if (mode === "crash") this.emit("error", new Error("injected task crash"));
			else if (mode === "exit") {
				this.stopped = true;
				this.emit("exit", 8);
			} else if (mode !== "timeout" && mode !== "held")
				this.emit("message", { id: message.id, result: [] });
		});
	}
	terminate() {
		if (this.failedCleanup) return Promise.reject(new Error("injected unconfirmed exit"));
		this.stopped = true;
		queueMicrotask(() => this.emit("exit", 0));
		return Promise.resolve(0);
	}
}
mock.module("node:worker_threads", () => ({ ...threads, Worker: FaultWorker }));
const {
	createTokenRecalculationWorkerStore,
	closeTokenRecalculationWorkers,
	resetTokenRecalculationWorkersForTest,
	pauseTokenRecalculationWorkers,
	resumeTokenRecalculationWorkers,
} = await import("./token-recalculation-worker-client");
const realTimeout = globalThis.setTimeout;
let hostStore: ReturnType<typeof spyOn<typeof sqliteStore, "createSqliteTokenRecalculationStore">>;
const budgets: number[] = [];
async function failure<T>(promise: Promise<T>) {
	try {
		await promise;
	} catch (error) {
		return error as Error & { code?: string };
	}
	throw new Error("expected task to reject");
}
beforeEach(async () => {
	await resetTokenRecalculationWorkersForTest();
	resumeDbWorkerPool();
	workers.length = 0;
	constructions = 0;
	budgets.length = 0;
	mode = "healthy";
	hostStore = spyOn(sqliteStore, "createSqliteTokenRecalculationStore").mockImplementation(() => {
		throw new Error("main thread store forbidden");
	});
});
afterEach(async () => {
	await closeTokenRecalculationWorkers();
	resumeDbWorkerPool();
	expect(hostStore).not.toHaveBeenCalled();
	for (const worker of workers) expect(worker.stopped).toBe(true);
	mock.restore();
});
function shortBudgets() {
	spyOn(globalThis, "setTimeout").mockImplementation(((
		...parameters: Parameters<typeof setTimeout>
	) => {
		const [callback, delay, ...args] = parameters;
		if (delay && (delay <= 5_000 || delay >= 29_000)) {
			budgets.push(delay);
			const expires = Date.now() + delay;
			return realTimeout(
				() => {
					if (delay >= 29_000) spyOn(Date, "now").mockReturnValue(expires);
					if (typeof callback === "function") callback(...args);
				},
				delay <= 5_000 ? 1 : 10,
			);
		}
		return realTimeout(callback, delay, ...args);
	}) as typeof setTimeout);
}
test.each([
	"constructor",
	"not-ready",
	"init-error",
] as const)("startup %s fails without inline store or task replay", async (failureMode) => {
	mode = failureMode;
	shortBudgets();
	const error = await failure(createTokenRecalculationWorkerStore("fixture.db"));
	expect(error).toBeInstanceOf(Error);
	expect(constructions).toBe(1);
	if (failureMode === "not-ready")
		expect(workers[0].messages.every((message) => message.action === "ping")).toBe(true);
});
test.each([
	"crash",
	"exit",
	"timeout",
] as const)("active %s fails and the initialized session is not recreated", async (failureMode) => {
	const store = await createTokenRecalculationWorkerStore("fixture.db");
	mode = failureMode;
	shortBudgets();
	const error = await failure(store.scan({ start: "", end: "2030" }));
	expect(error).toBeInstanceOf(Error);
	await failure(store.scan({ start: "", end: "2030" }));
	expect(constructions).toBe(1);
	if (failureMode === "timeout")
		expect(budgets.some((ms) => ms > 29_000 && ms <= 30_000)).toBe(true);
	await store.close();
});
test.each([
	"null-response",
	"missing-result",
	"ambiguous-response",
	"invalid-id",
] as const)("malformed %s fails explicitly and closes the session without replay", async (fault) => {
	const store = await createTokenRecalculationWorkerStore("fixture.db");
	mode = fault;
	const error = await failure(store.scan({ start: "", end: "2030" }));
	expect(error.message).toBe("Invalid token recalculation worker response");
	expect(workers[0].stopped).toBe(true);
	expect(workers[0].messages.filter((message) => message.action === "scan")).toHaveLength(1);
	await store.close();
	expect(constructions).toBe(1);
});
test("unconfirmed startup exits retain admission until their actual exit and do not permanently fuse", async () => {
	mode = "cleanup-error";
	shortBudgets();
	const errors = await Promise.all([
		failure(createTokenRecalculationWorkerStore("one.db")),
		failure(createTokenRecalculationWorkerStore("two.db")),
	]);
	for (const error of errors) expect(error.name).toBe("WorkerCleanupError");
	mode = "healthy";
	const queued = createTokenRecalculationWorkerStore("after.db");
	for (let i = 0; i < 12; i++) await Promise.resolve();
	expect(constructions).toBe(2);
	for (const worker of [...workers]) {
		worker.stopped = true;
		worker.emit("exit", 0);
	}
	const store = await queued;
	expect(constructions).toBe(3);
	await store.close();
});

test("one native worker retains connection identity across batches and closes idempotently", async () => {
	const store = await createTokenRecalculationWorkerStore("fixture.db");
	await store.scan({ start: "", end: "2030" });
	await store.scan({ start: "a", end: "2030" });
	expect(constructions).toBe(1);
	expect(workers[0].messages.map((message) => message.action)).toEqual([
		"ping",
		"init",
		"scan",
		"scan",
	]);
	await Promise.all([store.close(), store.close()]);
	expect(workers[0].messages.at(-1)?.action).toBe("close");
	await failure(store.scan({ start: "", end: "2030" }));
	expect(constructions).toBe(1);
});
test("closing rejects queued batches and drains the real exit before returning", async () => {
	const store = await createTokenRecalculationWorkerStore("fixture.db");
	mode = "held";
	const active = failure(store.scan({ start: "", end: "2030" }));
	const queued = Array.from({ length: 32 }, () => failure(store.scan({ start: "", end: "2030" })));
	const full = await failure(store.scan({ start: "", end: "2030" }));
	expect(full.code).toBe("TASK_QUEUE_FULL");
	await closeTokenRecalculationWorkers();
	await Promise.all([active, ...queued]);
	expect(workers[0].stopped).toBe(true);
	expect(workers[0].messages.filter((message) => message.action === "scan")).toHaveLength(1);
	const closed = await failure(createTokenRecalculationWorkerStore("other.db"));
	expect(closed.message).toContain("closed");
	expect(constructions).toBe(1);
});
test("startup cancellation and shutdown never dispatch init after readiness", async () => {
	mode = "not-ready";
	const controller = new AbortController();
	const pending = failure(createTokenRecalculationWorkerStore("fixture.db", controller.signal));
	for (let i = 0; i < 12; i++) await Promise.resolve();
	controller.abort(new Error("cancel startup"));
	await pending;
	expect(constructions).toBe(1);
	expect(workers[0].messages.every((message) => message.action === "ping")).toBe(true);
});
test("maintenance blocks new sessions and later batches without host execution", async () => {
	const store = await createTokenRecalculationWorkerStore("fixture.db");
	await shutdownDbWorkerPool({ pause: true });
	const blocked = await failure(createTokenRecalculationWorkerStore("other.db"));
	expect(blocked.message).toContain("maintenance");
	await failure(store.scan({ start: "", end: "2030" }));
	expect(constructions).toBe(1);
	resumeDbWorkerPool();
	await store.scan({ start: "", end: "2030" });
	await store.close();
});
test("production pause and resume rebuild only after exit; permanent shutdown cannot reopen", async () => {
	const store = await createTokenRecalculationWorkerStore("fixture.db");
	await pauseTokenRecalculationWorkers();
	await failure(createTokenRecalculationWorkerStore("paused.db"));
	await resumeTokenRecalculationWorkers();
	const resumed = await createTokenRecalculationWorkerStore("resumed.db");
	expect(constructions).toBe(2);
	await store.close();
	await resumed.close();
	await closeTokenRecalculationWorkers();
	expect((await failure(resumeTokenRecalculationWorkers())).message).toContain(
		"permanently closed",
	);
	expect(constructions).toBe(2);
});

test("maintenance preserves the owner's already committing batch and publishes its progress once", async () => {
	mode = "held";
	const service = new tokenService.TokenRecalculationService({
		async createStore(signal) {
			const store = await createTokenRecalculationWorkerStore("fixture.db", signal);
			return {
				...store,
				scan: async () => [
					{
						id: "row",
						created_at: "2026-01-01",
						provider: null,
						model: null,
						credential_id: null,
						input_tokens: 10,
						cached_input_tokens: 3,
						cache_creation_input_tokens: 0,
						cache_creation_5m_tokens: 0,
						cache_creation_1h_tokens: 0,
					},
				],
			};
		},
		async createResolver() {
			return () => ({ protocol: "openai", fallback: false });
		},
	});
	spyOn(tokenService, "getTokenRecalculationService").mockReturnValue(service);
	const cancel = spyOn(service, "cancel");
	service.start({});
	for (
		let i = 0;
		i < 80 && !workers[0]?.messages.some((message) => message.action === "apply");
		i++
	)
		await Promise.resolve();
	const apply = workers[0].messages.find((message) => message.action === "apply");
	expect(apply).toBeDefined();
	let paused = false;
	const pause = pauseTokenRecalculationWorkers().then(() => {
		paused = true;
	});
	for (let i = 0; i < 20; i++) await Promise.resolve();
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(paused).toBe(false);
	expect(workers[0].stopped).toBe(false);
	workers[0].emit("message", { id: apply?.id, result: { processed: 1, changed: 1, fallback: 0 } });
	await pause;
	expect(service.get()).toMatchObject({
		status: "cancelled",
		scanned: 1,
		processed: 1,
		changed: 1,
		error: null,
	});
	expect(workers[0].stopped).toBe(true);
	await resumeTokenRecalculationWorkers();
	expect(service.get()?.status).toBe("cancelled");
	expect(constructions).toBe(1);
});

test("live sessions have a hard limit and startup admission remains bounded", async () => {
	const sessions = await Promise.all(
		Array.from({ length: 32 }, (_, index) => createTokenRecalculationWorkerStore(`${index}.db`)),
	);
	const full = await failure(createTokenRecalculationWorkerStore("overflow.db"));
	expect(full.message).toContain("limit");
	expect(constructions).toBe(32);
	await Promise.all(sessions.map((store) => store.close()));
});
