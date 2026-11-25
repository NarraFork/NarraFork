import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./api";
import {
	createNarratorPanelReadScope,
	type NarratorPanelStateOptions,
	type NarratorPanelStateResponse,
} from "./api/narrators";
import {
	createPanelReconcileRestartScheduler,
	panelConnectionRead,
	reconcilePanelStatePages,
	shouldFallbackPanelState,
} from "./narrator-panel-state";
import { createSharedInflight } from "./shared-inflight";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const page = (overrides: Partial<NarratorPanelStateResponse> = {}): NarratorPanelStateResponse => ({
	permissions: [],
	buffer: [],
	draft: { hasDraft: false, revision: 0, updatedAt: null },
	hasMore: { permissions: false, buffer: false },
	...overrides,
});
const permission = (id: string) => ({ id, toolName: "Bash", inputJson: { command: "pwd" } });
const message = (id: string) => ({ id, text: id, bufferedAt: "2026-01-01", imageCount: 0 });

describe("live panel-state read sharing", () => {
	test("mount, composer and query readers share one in-flight read but never a completed snapshot", async () => {
		const share = createSharedInflight<number>();
		const pending = deferred<number>();
		let calls = 0;
		const read = () => {
			calls++;
			return pending.promise;
		};
		const readers = [share("u:n", read), share("u:n", read), share("u:n", read)];
		await Promise.resolve();
		expect(calls).toBe(1);
		pending.resolve(1);
		expect(await Promise.all(readers)).toEqual([1, 1, 1]);
		await share("u:n", async () => {
			calls++;
			return 2;
		});
		expect(calls).toBe(2);
	});

	test("all readers cancelling before the microtask never starts transport", async () => {
		const share = createSharedInflight<number>();
		const firstController = new AbortController();
		const secondController = new AbortController();
		let calls = 0;
		const read = async () => ++calls;
		const first = share("key", read, { signal: firstController.signal });
		const second = share("key", read, { signal: secondController.signal });
		firstController.abort();
		secondController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(0);
		expect(await share("key", read)).toBe(1);
	});

	test("one observer cancelling does not abort another observer's read", async () => {
		const share = createSharedInflight<number>();
		const pending = deferred<number>();
		const controller = new AbortController();
		let signal!: AbortSignal;
		const first = share(
			"key",
			async (incoming) => {
				signal = incoming;
				return pending.promise;
			},
			{ signal: controller.signal },
		);
		const second = share("key", async () => 99);
		await Promise.resolve();
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(signal.aborted).toBe(false);
		pending.resolve(3);
		expect(await second).toBe(3);
	});

	test("the last cancellation aborts transport and cannot strand the next read", async () => {
		const share = createSharedInflight<number>();
		const pending = deferred<number>();
		const controller = new AbortController();
		let signal!: AbortSignal;
		const first = share(
			"key",
			async (incoming) => {
				signal = incoming;
				return pending.promise;
			},
			{ signal: controller.signal },
		);
		await Promise.resolve();
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(signal.aborted).toBe(true);
		expect(await share("key", async () => 4)).toBe(4);
		pending.resolve(1);
	});

	test("reconnect fresh bypasses the old read and old completion cannot evict the fresh entry", async () => {
		const share = createSharedInflight<number>();
		const old = deferred<number>();
		const next = deferred<number>();
		const first = share("key", () => old.promise);
		const fresh = share("key", () => next.promise, { fresh: true });
		old.resolve(1);
		expect(await first).toBe(1);
		const joined = share("key", async () => 999);
		next.resolve(2);
		expect(await Promise.all([fresh, joined])).toEqual([2, 2]);
	});
});

describe("panel connection lifecycle", () => {
	test("the first WS connection closes the pre-connect REST gap and reconnects stay fresh", () => {
		const mounted = panelConnectionRead(null, "u1:n1", false);
		expect(mounted.read).toBe("initial");
		const first = panelConnectionRead(mounted.state, "u1:n1", true);
		expect(first.read).toBe("fresh");
		const disconnected = panelConnectionRead(first.state, "u1:n1", false);
		expect(disconnected.read).toBeNull();
		const reconnected = panelConnectionRead(disconnected.state, "u1:n1", true);
		expect(reconnected.read).toBe("fresh");
		expect(panelConnectionRead(reconnected.state, "u2:n1", true).read).toBe("initial");
		expect(panelConnectionRead(reconnected.state, "u1:n2", true).read).toBe("initial");
		expect(panelConnectionRead(null, "u1:n1", true).read).toBe("initial");
	});
});

describe("budgeted snapshot restarts", () => {
	test("coalesces events, throttles to three restarts per window, and keeps a deferred retry", () => {
		let now = 0;
		let runs = 0;
		const state: { timer: { callback: () => void; delayMs: number } | null } = { timer: null };
		const scheduler = createPanelReconcileRestartScheduler(
			() => {
				runs++;
			},
			() => true,
			{
				now: () => now,
				defer: (callback, delayMs) => {
					state.timer = { callback, delayMs };
					return () => {
						state.timer = null;
					};
				},
			},
		);
		const tick = () => {
			if (!state.timer) throw new Error("No scheduled retry");
			const pending = state.timer;
			state.timer = null;
			now += pending.delayMs;
			pending.callback();
		};
		for (let burst = 0; burst < 3; burst++) {
			for (let event = 0; event < 10; event++) scheduler.schedule();
			expect(state.timer?.delayMs).toBe(250);
			tick();
		}
		expect(runs).toBe(3);
		scheduler.schedule();
		expect(state.timer?.delayMs).toBe(9250);
		tick();
		expect(runs).toBe(4);
		expect(now).toBe(10_000);
	});

	test("switches, disposal and a newer immediate read cancel pending retries", () => {
		let run: (() => void) | undefined;
		let current = true;
		let calls = 0;
		const scheduler = createPanelReconcileRestartScheduler(
			() => {
				calls++;
			},
			() => current,
			{
				now: () => 0,
				defer: (callback) => {
					run = callback;
					return () => {
						run = undefined;
					};
				},
			},
		);
		scheduler.schedule();
		scheduler.cancel();
		expect(run).toBeUndefined();
		scheduler.schedule();
		current = false;
		run?.();
		expect(calls).toBe(0);
		scheduler.schedule();
		scheduler.dispose();
		expect(run).toBeUndefined();
		scheduler.schedule();
		expect(run).toBeUndefined();
	});
});

describe("independent bounded panel pages", () => {
	test("shows initial permissions immediately and drains both cursors without truncating", async () => {
		const calls: NarratorPanelStateOptions[] = [];
		const seen: NarratorPanelStateResponse[] = [];
		const readScope = createNarratorPanelReadScope();
		const pages = [
			page({
				permissions: [permission("p1")],
				buffer: [message("b1")],
				hasMore: { permissions: true, buffer: true },
				nextCursor: { permissions: "p-next", buffer: "b-next" },
			}),
			page({
				permissions: [permission("p2")],
				buffer: [message("b2")],
				hasMore: { permissions: false, buffer: true },
				nextCursor: { buffer: "b-last" },
			}),
			page({ buffer: [message("b3")] }),
		];
		await reconcilePanelStatePages(
			async (options) => {
				calls.push(options);
				if (calls.length === 2)
					expect(seen[0]?.permissions.map((entry) => entry.id)).toEqual(["p1"]);
				return pages[calls.length - 1];
			},
			(snapshot) => seen.push(snapshot),
			{ fresh: true, readScope },
		);
		expect(calls.every((options) => options.readScope === readScope)).toBe(true);
		expect(
			calls.map(({ fresh, permissionsCursor, bufferCursor }) => ({
				fresh,
				permissionsCursor,
				bufferCursor,
			})),
		).toEqual([
			{ fresh: true, permissionsCursor: undefined, bufferCursor: undefined },
			{ fresh: false, permissionsCursor: "p-next", bufferCursor: "b-next" },
			{ fresh: false, permissionsCursor: "end", bufferCursor: "b-last" },
		]);
		expect(seen.at(-1)?.permissions.map((entry) => entry.id)).toEqual(["p1", "p2"]);
		expect(seen.at(-1)?.buffer.map((entry) => entry.id)).toEqual(["b1", "b2", "b3"]);
	});

	test("missing or cycling cursors fail visibly rather than silently cutting off permissions", async () => {
		for (const cursor of [undefined, "repeat"]) {
			await expect(
				reconcilePanelStatePages(
					async () =>
						page({
							permissions: [permission("p")],
							hasMore: { permissions: true, buffer: false },
							nextCursor: { permissions: cursor },
						}),
					() => {},
				),
			).rejects.toThrow("cursor did not advance");
		}
	});

	test("cancelled paging never starts another request", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			reconcilePanelStatePages(
				async () => {
					calls++;
					return page();
				},
				() => {},
				{ signal: controller.signal },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(0);
	});

	test("fallback permits legacy/network/item budgets, but never bypasses auth failure", () => {
		expect(shouldFallbackPanelState({ status: 404 })).toBe(true);
		expect(shouldFallbackPanelState({ status: 413 })).toBe(true);
		expect(shouldFallbackPanelState(new TypeError("offline"))).toBe(true);
		for (const status of [400, 401, 403]) expect(shouldFallbackPanelState({ status })).toBe(false);
		expect(shouldFallbackPanelState(new DOMException("Aborted", "AbortError"))).toBe(false);
	});
});

describe("panel-state API scope and endpoint contracts", () => {
	const originalFetch = globalThis.fetch;
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	afterEach(() => {
		Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
		if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});

	test("shares by authenticated scope and cursors while a fresh reconnect never joins old HTTP", async () => {
		let token = "u1-token";
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => token },
		});
		const pending = deferred<Response>();
		const calls: string[] = [];
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: async (url: string) => {
				calls.push(url);
				return calls.length === 1 ? pending.promise : Response.json(page());
			},
		});
		const readScope = createNarratorPanelReadScope();
		const first = api.getNarratorPanelState("n/1", { readScope });
		const composer = api.getNarratorPanelState("n/1", { readScope });
		const oldReads = Promise.allSettled([first, composer]);
		await Promise.resolve();
		expect(calls).toHaveLength(1);
		await api.getNarratorPanelState("n/1", { readScope, fresh: true });
		token = "u2-token";
		await expect(api.getNarratorPanelState("n/1", { readScope })).rejects.toMatchObject({
			name: "AbortError",
		});
		const nextScope = createNarratorPanelReadScope();
		await api.getNarratorPanelState("n/1", { readScope: nextScope });
		await api.getNarratorPanelState("n/1", {
			readScope: nextScope,
			permissionsCursor: "end",
			bufferCursor: "opaque/token",
		});
		pending.resolve(Response.json(page()));
		expect(await oldReads).toMatchObject([
			{ status: "rejected", reason: { name: "AbortError" } },
			{ status: "rejected", reason: { name: "AbortError" } },
		]);
		expect(calls).toEqual([
			"/api/narrators/n%2F1/panel-state",
			"/api/narrators/n%2F1/panel-state",
			"/api/narrators/n%2F1/panel-state",
			"/api/narrators/n%2F1/panel-state?permissionsCursor=end&bufferCursor=opaque%2Ftoken",
		]);
	});

	test("distinct mounts and implicit scopes never adopt another subscription's old read", async () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => "token" },
		});
		const pending = deferred<void>();
		let calls = 0;
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: async () => {
				calls++;
				await pending.promise;
				return Response.json(page());
			},
		});
		const readScope = createNarratorPanelReadScope();
		const reads = [
			api.getNarratorPanelState("n1", { readScope }),
			api.getNarratorPanelState("n1", { readScope }),
			api.getNarratorPanelState("n1", { readScope: createNarratorPanelReadScope() }),
			api.getNarratorPanelState("n1"),
		];
		await Promise.resolve();
		expect(calls).toBe(3);
		pending.resolve();
		await Promise.all(reads);
		await api.getNarratorPanelState("n1", { readScope });
		expect(calls).toBe(4);
	});

	test("token replacement before deferred start prevents any transport", async () => {
		let token = "old";
		let calls = 0;
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => token },
		});
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: async () => {
				calls++;
				return Response.json(page());
			},
		});
		const read = api.getNarratorPanelState("n1", { readScope: createNarratorPanelReadScope() });
		token = "new";
		await expect(read).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(0);
	});

	test("Git summary endpoint preserves null and the caller's abort signal", async () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => null },
		});
		const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: async (url: string, options?: RequestInit) => {
				calls.push({ url, signal: options?.signal });
				return Response.json(null);
			},
		});
		const controller = new AbortController();
		expect(await api.getNarratorGitSummary("n1", controller.signal)).toBeNull();
		expect(calls).toEqual([{ url: "/api/narrators/n1/git/summary", signal: controller.signal }]);
	});
});
