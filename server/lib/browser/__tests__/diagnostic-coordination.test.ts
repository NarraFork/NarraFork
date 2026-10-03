import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, CDPSessionEvent } from "puppeteer-core";
import { reserveDiagnostic } from "../diagnostic-admission";
import { PROFILE_LIMITS } from "../memory-profile-constants";
import { finishPerformanceTrace, startPerformanceTrace } from "../performance-tracing";
import type { BrowserSession } from "../session";
import { acquireTraceLease } from "../tracing-lease";

class FakeBrowser extends EventEmitter {
	connected = true;
	constructor(private key = `ws://test-private-${crypto.randomUUID()}`) {
		super();
	}
	wsEndpoint() {
		return this.key;
	}
}
function fakeBrowser(value: FakeBrowser) {
	return value as unknown as Browser;
}
function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture(browser = new FakeBrowser()) {
	let starts = 0,
		stops = 0;
	const tracing = {
		start: async (_opts: { categories: string[]; screenshots: boolean }) => {
			starts++;
		},
		stop: async (): Promise<Uint8Array> => {
			stops++;
			return new Uint8Array([1]);
		},
	};
	const client = new EventEmitter();
	const calls: { method: string; params?: Record<string, unknown> }[] = [];
	let bytes: Uint8Array = new Uint8Array([1]);
	const cdp = Object.assign(client, {
		send: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
			calls.push({ method, params });
			if (method === "Tracing.start") return tracing.start({ categories: [], screenshots: false });
			if (method === "Tracing.end") {
				bytes = await tracing.stop();
				client.emit("Tracing.tracingComplete", { stream: "owned-stream" });
				return {};
			}
			if (method === "IO.read")
				return { data: Buffer.from(bytes).toString("base64"), base64Encoded: true, eof: true };
			return {};
		},
		detach: async () => {
			calls.push({ method: "detach" });
		},
	});
	const session = {
		id: crypto.randomUUID(),
		page: { browser: () => fakeBrowser(browser), createCDPSession: async () => cdp },
	} as unknown as BrowserSession;
	return { browser, session, tracing, cdp, calls, counts: () => ({ starts, stops }) };
}

describe("browser diagnostic admission", () => {
	test("profile blocks snapshot/GC/profile, releases idempotently", () => {
		const release = reserveDiagnostic("profile");
		try {
			for (const kind of ["profile", "snapshot", "gc"] as const)
				expect(() => reserveDiagnostic(kind)).toThrow("diagnostic_busy");
		} finally {
			release();
			release();
		}
		const next = reserveDiagnostic("snapshot");
		next();
	});
	test("snapshot and GC block profile until every operation releases", () => {
		const snapshot = reserveDiagnostic("snapshot"),
			gc = reserveDiagnostic("gc");
		try {
			expect(() => reserveDiagnostic("profile")).toThrow("diagnostic_busy");
			snapshot();
			expect(() => reserveDiagnostic("profile")).toThrow("diagnostic_busy");
		} finally {
			snapshot();
			gc();
		}
		const next = reserveDiagnostic("profile");
		next();
	});
});

async function withLimits(run: () => Promise<void>) {
	const original = { ...PROFILE_LIMITS };
	Object.assign(PROFILE_LIMITS, { startTimeoutMs: 30, stopTimeoutMs: 30, cleanupTimeoutMs: 15 });
	try {
		await run();
	} finally {
		Object.assign(PROFILE_LIMITS, original);
	}
}
const options = { categories: ["devtools.timeline"], screenshots: false };
function assertReleased(f: ReturnType<typeof fixture>) {
	const next = acquireTraceLease(fakeBrowser(f.browser), "next");
	next.confirmStopped();
}

// Separate stop evidence from IO success, and exercise captured-generation cleanup.
describe("dedicated CDP performance tracing", () => {
	for (const config of [
		{
			name: "ordinary categories",
			categories: ["devtools.timeline", "v8"],
			screenshots: false,
			included: ["devtools.timeline", "v8"],
			excluded: [],
		},
		{
			name: "mixed positive and negative categories",
			categories: ["-*", "devtools.timeline", "-v8"],
			screenshots: false,
			included: ["devtools.timeline"],
			excluded: ["*", "v8"],
		},
		{
			name: "only negative categories",
			categories: ["-v8", "-disabled-by-default-devtools.screenshot"],
			screenshots: false,
			included: [],
			excluded: ["v8", "disabled-by-default-devtools.screenshot"],
		},
		{
			name: "screenshots with negative categories",
			categories: ["-v8", "devtools.timeline"],
			screenshots: true,
			included: ["devtools.timeline", "disabled-by-default-devtools.screenshot"],
			excluded: ["v8"],
		},
	]) {
		test(`Puppeteer category parameters: ${config.name}`, async () => {
			const f = fixture();
			const categories = [...config.categories];
			try {
				await startPerformanceTrace(f.session, { categories, screenshots: config.screenshots });
				expect(f.calls.find((call) => call.method === "Tracing.start")?.params).toMatchObject({
					transferMode: "ReturnAsStream",
					traceConfig: {
						includedCategories: config.included,
						excludedCategories: config.excluded,
					},
				});
				expect(categories).toEqual(config.categories);
			} finally {
				await finishPerformanceTrace(f.session).catch(() => {});
				f.browser.emit("disconnected");
			}
		});
	}
	test("IO.read failure releases at completion, closes stream once, and cannot clear a new trace", async () => {
		const f = fixture(),
			read = deferred<unknown>();
		const send = f.cdp.send;
		f.cdp.send = (method, params) => (method === "IO.read" ? read.promise : send(method, params));
		await startPerformanceTrace(f.session, options);
		const old = f.session.tracing;
		const stopped = finishPerformanceTrace(f.session).catch((error) => error);
		await Bun.sleep(0);
		expect(old?.traceStopped).toBe(true);
		const next = fixture(f.browser);
		f.session.page = next.session.page;
		await startPerformanceTrace(f.session, options);
		const current = f.session.tracing;
		read.resolve(Promise.reject(new Error("injected IO.read failure")));
		expect(String(await stopped)).toContain("injected IO.read failure");
		expect(f.session.tracing).toBe(current);
		expect(f.calls.filter((c) => c.method === "IO.close")).toHaveLength(1);
		expect(f.calls.filter((c) => c.method === "detach")).toHaveLength(1);
		expect(await finishPerformanceTrace(f.session)).toBeInstanceOf(Uint8Array);
		assertReleased(f);
	});
	test("perfStop writing old export does not clear a newer session trace", async () => {
		const { perfStop } = await import("../actions");
		const dir = await mkdtemp(join(tmpdir(), "nf-perf-generation-"));
		const f = fixture(),
			read = deferred<unknown>(),
			send = f.cdp.send;
		f.cdp.send = (method, params) => (method === "IO.read" ? read.promise : send(method, params));
		try {
			await startPerformanceTrace(f.session, options);
			const path = join(dir, "old.json");
			const saved = perfStop(f.session, path);
			await Bun.sleep(0);
			const next = fixture(f.browser);
			f.session.page = next.session.page;
			await startPerformanceTrace(f.session, options);
			const current = f.session.tracing;
			read.resolve({ data: "owned bytes", eof: true });
			expect((await saved).fileSize).toBe(11);
			expect(await readFile(path, "utf8")).toBe("owned bytes");
			expect(f.session.tracing).toBe(current);
			await finishPerformanceTrace(f.session);
		} finally {
			f.browser.emit("disconnected");
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("duplicate finish during export shares the result without rereading the stopped trace", async () => {
		const f = fixture(),
			read = deferred<unknown>(),
			send = f.cdp.send;
		let reads = 0;
		f.cdp.send = (method, params) => {
			if (method === "IO.read") {
				reads++;
				return read.promise;
			}
			return send(method, params);
		};
		await startPerformanceTrace(f.session, options);
		const one = finishPerformanceTrace(f.session);
		await Bun.sleep(0);
		expect(f.session.tracing?.active).toBe(false);
		const two = finishPerformanceTrace(f.session);
		read.resolve({ data: "same", eof: true });
		expect(await one).toBe(await two);
		expect(reads).toBe(1);
		expect(f.counts().stops).toBe(1);
		assertReleased(f);
	});
	test("confirmed completion wins even if Tracing.end reply never resolves", async () =>
		withLimits(async () => {
			const f = fixture(),
				send = f.cdp.send;
			f.cdp.send = (method, params) => {
				if (method !== "Tracing.end") return send(method, params);
				f.cdp.emit("Tracing.tracingComplete", { stream: "owned-stream" });
				return new Promise(() => {});
			};
			await startPerformanceTrace(f.session, options);
			expect(await finishPerformanceTrace(f.session)).toBeInstanceOf(Uint8Array);
			assertReleased(f);
		}));
	test("missing stream is an export failure, not uncertainty", async () => {
		const f = fixture(),
			send = f.cdp.send;
		f.cdp.send = async (method, params) => {
			if (method === "Tracing.end") {
				f.cdp.emit("Tracing.tracingComplete", {});
				return {};
			}
			return send(method, params);
		};
		await startPerformanceTrace(f.session, options);
		await expect(finishPerformanceTrace(f.session)).rejects.toThrow("no stream");
		assertReleased(f);
		expect(f.calls.some((c) => c.method === "IO.read")).toBe(false);
		expect(f.calls.filter((c) => c.method === "detach")).toHaveLength(1);
	});
	test("export timeout and hanging IO.close/detach stay bounded without poisoning the lease", async () =>
		withLimits(async () => {
			const f = fixture(),
				send = f.cdp.send;
			f.cdp.send = (method, params) =>
				["IO.read", "IO.close"].includes(method) ? new Promise(() => {}) : send(method, params);
			f.cdp.detach = () => new Promise(() => {});
			await startPerformanceTrace(f.session, options);
			await expect(finishPerformanceTrace(f.session)).rejects.toThrow("trace_export");
			assertReleased(f);
		}));
	test("unconfirmed end remains fail-closed; late completion closes without reading and frees lease", async () =>
		withLimits(async () => {
			const f = fixture(),
				send = f.cdp.send;
			f.cdp.send = (method, params) =>
				method === "Tracing.end" ? new Promise(() => {}) : send(method, params);
			await startPerformanceTrace(f.session, options);
			const one = finishPerformanceTrace(f.session).catch((e) => e);
			const two = finishPerformanceTrace(f.session).catch((e) => e);
			expect(String(await one)).toContain("confirm shutdown");
			expect(await two).toBe(await one);
			expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_uncertain");
			f.cdp.emit("Tracing.tracingComplete", { stream: "late" });
			await Bun.sleep(0);
			assertReleased(f);
			expect(f.calls.some((c) => c.method === "IO.read")).toBe(false);
			expect(f.calls.filter((c) => c.method === "IO.close")).toHaveLength(1);
			expect(f.session.tracing).toBeUndefined();
		}));
	test("rejected end retains observation; late completion recovers uncertainty", async () => {
		const f = fixture();
		await startPerformanceTrace(f.session, options);
		f.tracing.stop = async () => {
			throw new Error("transport");
		};
		await expect(finishPerformanceTrace(f.session)).rejects.toThrow("confirm shutdown");
		expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_uncertain");
		f.cdp.emit("Tracing.tracingComplete", { stream: "late" });
		await Bun.sleep(0);
		assertReleased(f);
	});
	test("completion before our end or on a stale generation cannot release another owner's lease", async () => {
		const f = fixture();
		await startPerformanceTrace(f.session, options);
		const staleListener = f.session.tracing?.onComplete;
		f.cdp.emit("Tracing.tracingComplete", { stream: "foreign" });
		expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_busy");
		await finishPerformanceTrace(f.session);
		const next = acquireTraceLease(fakeBrowser(f.browser), "next");
		staleListener?.({ stream: "stale", dataLossOccurred: false });
		expect(next.isCurrent()).toBe(true);
		next.confirmStopped();
	});
	test("start timeout followed by late success ends only captured trace and discards export", async () =>
		withLimits(async () => {
			const f = fixture(),
				start = deferred<void>();
			f.tracing.start = () => start.promise;
			await expect(startPerformanceTrace(f.session, options)).rejects.toThrow("startup");
			expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_uncertain");
			start.resolve();
			await Bun.sleep(0);
			expect(f.counts().stops).toBe(1);
			expect(f.calls.some((c) => c.method === "IO.read")).toBe(false);
			assertReleased(f);
		}));
	test("late start after both startup and stop deadlines still sends one end and confirms cleanup", async () =>
		withLimits(async () => {
			const f = fixture(),
				start = deferred<void>(),
				end = deferred<void>(),
				endSent = deferred<void>();
			const send = f.cdp.send;
			f.tracing.start = () => start.promise;
			f.tracing.stop = async () => {
				await end.promise;
				return new Uint8Array([1]);
			};
			f.cdp.send = (method, params) => {
				if (method === "Tracing.end") endSent.resolve();
				return send(method, params);
			};
			try {
				await expect(startPerformanceTrace(f.session, options)).rejects.toThrow("startup");
				const state = f.session.tracing;
				if (!state) throw new Error("Expected the uncertain startup generation");
				expect(state.startSent).toBe(true);
				expect(state.startConfirmed).toBe(false);
				await expect(finishPerformanceTrace(f.session)).rejects.toThrow("confirm shutdown");
				const cachedStopping = state.stopping;
				// Both waits have now rejected while the original start command remains pending.
				await expect(finishPerformanceTrace(f.session)).rejects.toThrow("confirm shutdown");
				expect(state.stopping).toBe(cachedStopping);
				expect(f.calls.filter((c) => c.method === "Tracing.end")).toHaveLength(0);
				expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_uncertain");
				start.resolve();
				await endSent.promise;
				expect(state.startConfirmed).toBe(true);
				expect(state.endSent).toBe(true);
				expect(state.stopping).toBe(cachedStopping);
				expect(f.calls.filter((c) => c.method === "Tracing.end")).toHaveLength(1);
				// Sending end alone is still not shutdown proof; completion is gated separately.
				expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_uncertain");
				end.resolve();
				await state.completed;
				expect(state.traceStopped).toBe(true);
				expect(state.cleanup).toBeDefined();
				await state.cleanup;
				assertReleased(f);
				expect(state.cancelled).toBe(true);
				expect(f.session.tracing).toBeUndefined();
				expect(f.calls.filter((c) => c.method === "Tracing.end")).toHaveLength(1);
				expect(f.calls.filter((c) => c.method === "IO.read")).toHaveLength(0);
				expect(f.calls.filter((c) => c.method === "IO.close")).toHaveLength(1);
				expect(f.calls.filter((c) => c.method === "detach")).toHaveLength(1);
				expect(f.cdp.listenerCount("Tracing.tracingComplete")).toBe(0);
				expect(f.browser.listenerCount("disconnected")).toBe(0);
			} finally {
				start.resolve();
				end.resolve();
				f.browser.emit("disconnected");
			}
		}));
	test("late definite start rejection releases lease without sending end", async () =>
		withLimits(async () => {
			const f = fixture(),
				start = deferred<void>();
			f.tracing.start = () => start.promise;
			await expect(startPerformanceTrace(f.session, options)).rejects.toThrow("startup");
			start.resolve(Promise.reject(new Error("Tracing has already been started")) as never);
			await Bun.sleep(0);
			expect(f.counts().stops).toBe(0);
			assertReleased(f);
		}));
	test("closing or timeout before a delayed attach cannot start; old cleanup preserves new generation", async () =>
		withLimits(async () => {
			for (const close of [true, false]) {
				const f = fixture(),
					attach = deferred<unknown>();
				f.session.page.createCDPSession = (() =>
					attach.promise) as typeof f.session.page.createCDPSession;
				const startup = startPerformanceTrace(f.session, options).catch((e) => e);
				if (close) f.session.memoryDiagnosticsClosed = true;
				if (!close) {
					expect(String(await startup)).toContain("startup");
					const next = fixture(f.browser);
					f.session.page = next.session.page;
					await startPerformanceTrace(f.session, options);
				}
				const current = f.session.tracing;
				attach.resolve(f.cdp);
				expect(String(await startup)).toContain("startup");
				await Bun.sleep(0);
				expect(f.counts().starts).toBe(0);
				if (!close) {
					expect(f.session.tracing).toBe(current);
					await finishPerformanceTrace(f.session);
				}
				assertReleased(f);
			}
		}));
	test("closing during sent startup uses one end for duplicate stop and skips IO", async () => {
		const f = fixture(),
			pending = deferred<void>();
		f.tracing.start = () => pending.promise;
		const startup = startPerformanceTrace(f.session, options);
		await Bun.sleep(0);
		f.session.memoryDiagnosticsClosed = true;
		const one = finishPerformanceTrace(f.session),
			two = finishPerformanceTrace(f.session);
		pending.resolve();
		await startup;
		expect(await one).toBeUndefined();
		expect(await two).toBeUndefined();
		expect(f.counts().stops).toBe(1);
		expect(f.calls.some((c) => c.method === "IO.read")).toBe(false);
		assertReleased(f);
	});
	test("target detach is not stop evidence; browser disconnect releases only old token", async () => {
		const f = fixture();
		await startPerformanceTrace(f.session, options);
		f.cdp.emit((CDPSessionEvent as unknown as { Disconnected: symbol }).Disconnected);
		expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_uncertain");
		f.browser.emit("disconnected");
		const next = acquireTraceLease(fakeBrowser(f.browser), "next");
		await Bun.sleep(0);
		expect(next.isCurrent()).toBe(true);
		next.confirmStopped();
	});
	for (const kind of ["encoded", "decoded", "total", "empty", "tiny"] as const) {
		test(`stream ${kind} limit closes stream and releases lease`, async () =>
			withLimits(async () => {
				Object.assign(PROFILE_LIMITS, { traceReadBytes: 4, traceBytes: 8 });
				const f = fixture(),
					send = f.cdp.send;
				f.cdp.send = (method, params) => {
					if (method !== "IO.read") return send(method, params);
					f.calls.push({ method, params });
					const data =
						kind === "encoded"
							? "x".repeat(9)
							: kind === "decoded"
								? "x".repeat(5)
								: kind === "total"
									? "xxxx"
									: kind === "tiny"
										? "x"
										: "";
					return Promise.resolve({ data, eof: false });
				};
				await startPerformanceTrace(f.session, options);
				await expect(finishPerformanceTrace(f.session)).rejects.toThrow(
					kind === "empty" ? "no progress" : "limit",
				);
				assertReleased(f);
				expect(f.calls.filter((c) => c.method === "IO.close")).toHaveLength(1);
				for (const call of f.calls.filter((c) => c.method === "IO.read"))
					expect(call.params?.size).toBe(4);
			}));
	}
});

describe("browser-wide trace lease and legacy perf", () => {
	test("same endpoint has one owner; separate browser permits recording", () => {
		const a = new FakeBrowser(),
			b = new FakeBrowser(a.wsEndpoint()),
			separate = new FakeBrowser();
		const lease = acquireTraceLease(fakeBrowser(a), "perf:a");
		try {
			expect(() => acquireTraceLease(fakeBrowser(b), "profile:b")).toThrow("trace_busy");
			const other = acquireTraceLease(fakeBrowser(separate), "other");
			other.confirmStopped();
		} finally {
			lease.confirmStopped();
		}
	});
	test("uncertain stop blocks new owners until confirmed or disconnected", () => {
		const browser = new FakeBrowser(),
			lease = acquireTraceLease(fakeBrowser(browser), "a");
		lease.markUncertain();
		expect(() => acquireTraceLease(fakeBrowser(browser), "b")).toThrow("trace_uncertain");
		browser.emit("disconnected");
		const next = acquireTraceLease(fakeBrowser(browser), "b");
		lease.confirmStopped();
		expect(next.isCurrent()).toBe(true);
		next.confirmStopped();
	});
	test("perf start and concurrent stop share one end and release their lease", async () => {
		const f = fixture();
		await startPerformanceTrace(f.session, {
			categories: ["devtools.timeline"],
			screenshots: false,
		});
		expect(() => acquireTraceLease(fakeBrowser(f.browser), "profile")).toThrow("trace_busy");
		const done = deferred<Uint8Array>();
		let ends = 0;
		f.tracing.stop = async () => {
			ends++;
			return done.promise;
		};
		const one = finishPerformanceTrace(f.session),
			two = finishPerformanceTrace(f.session);
		await Bun.sleep(0);
		done.resolve(new Uint8Array([2]));
		expect(await one).toEqual(await two);
		expect(ends).toBe(1);
		expect(f.session.tracing).toBeUndefined();
		const next = acquireTraceLease(fakeBrowser(f.browser), "profile");
		next.confirmStopped();
	});
	test("definite foreign start rejection never ends somebody else's trace", async () => {
		const f = fixture();
		f.tracing.start = async () => {
			throw new Error("Protocol error: Tracing is already started");
		};
		await expect(
			startPerformanceTrace(f.session, { categories: [], screenshots: false }),
		).rejects.toThrow("startup");
		expect(f.counts().stops).toBe(0);
		expect(f.session.tracing).toBeUndefined();
		const next = acquireTraceLease(fakeBrowser(f.browser), "profile");
		next.confirmStopped();
	});
	test("ambiguous failed start and failed end never release an uncertain lease", async () => {
		const f = fixture();
		f.tracing.start = async () => {
			throw new Error("protocol transport timeout");
		};
		await expect(
			startPerformanceTrace(f.session, { categories: [], screenshots: false }),
		).rejects.toThrow("startup");
		expect(() => acquireTraceLease(fakeBrowser(f.browser), "next")).toThrow("trace_uncertain");
		f.browser.emit("disconnected");
		const g = fixture();
		await startPerformanceTrace(g.session, { categories: [], screenshots: false });
		g.tracing.stop = async () => {
			throw new Error("transport");
		};
		await expect(finishPerformanceTrace(g.session)).rejects.toThrow("confirm shutdown");
		expect(() => acquireTraceLease(fakeBrowser(g.browser), "next")).toThrow("trace_uncertain");
		g.browser.emit("disconnected");
	});
	test("closing during pending start cannot end a newer generation's trace", async () => {
		const f = fixture(),
			pending = deferred<void>();
		f.tracing.start = () => pending.promise;
		const startup = startPerformanceTrace(f.session, { categories: [], screenshots: false });
		await Bun.sleep(0); // Start has been sent, but its reply is still pending.
		const shutdown = finishPerformanceTrace(f.session);
		f.browser.emit("disconnected");
		const next = acquireTraceLease(fakeBrowser(f.browser), "new-generation");
		pending.resolve();
		await startup;
		await shutdown;
		expect(f.counts().stops).toBe(0);
		expect(next.isCurrent()).toBe(true);
		next.confirmStopped();
	});
});
