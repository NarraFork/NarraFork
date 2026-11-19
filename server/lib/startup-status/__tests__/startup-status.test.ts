import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import { STARTUP_STATUS_HEADER } from "../../../../shared/startup-status";
import * as compiled from "../../compiled-worker";
import { logger } from "../../logger";
import { WorkerCleanupError, WorkerHandle } from "../../worker-runtime/lifecycle";
import {
	closeStartupStatus,
	expectStartupViewer,
	reportStartupStep,
	showStartupProblem,
	startStartupStatus,
} from "../index";
import { isLocalViewer, type StartupProblem, snapshotForViewer } from "../protocol";
import { StartupError, toStartupProblem } from "../startup-error";

const problem: StartupProblem = {
	message: { en: "Port is busy.", zh: "端口被占用。" },
	command: "Stop-Process -Id 4242",
	detail: "Error: EADDRINUSE",
};

function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	if (port === undefined) throw new Error("no port");
	return port;
}

/** Another test can take a just-freed port; try a few. */
async function start() {
	for (let attempt = 0; attempt < 5; attempt++) {
		const port = freePort();
		const target = { hostname: "127.0.0.1", port };
		if (await startStartupStatus(target, { version: "9.9.9", brandName: "Lab <A&B>" })) {
			const url = (path: string) => `http://127.0.0.1:${port}${path}`;
			return { port, url };
		}
	}
	throw new Error("could not start the status page on a free port");
}

/** Messages reach the worker asynchronously; wait for the page to reflect one. */
async function startupBody(
	url: (path: string) => string,
	until: (body: Record<string, unknown>) => boolean,
) {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const body = (await (await fetch(url("/api/startup"))).json()) as Record<string, unknown>;
		if (until(body) || Date.now() > deadline) return body;
		await Bun.sleep(10);
	}
}

afterEach(closeStartupStatus);

describe("startup status page", () => {
	test("answers navigation, health and other requests while starting", async () => {
		const { url } = await start();

		const page = await fetch(url("/narrators/abc"), { headers: { accept: "text/html" } });
		expect(page.status).toBe(503);
		expect(page.headers.get(STARTUP_STATUS_HEADER)).toBe("1");
		const html = await page.text();
		// Relative to the page, so polling keeps working under a reverse-proxy prefix.
		expect(html).toContain('<base href="../">');
		expect(html).toContain('fetch("api/startup"');
		// The instance name titles the window, escaped.
		expect(html).toContain("<title>Lab &#60;A&#38;B&#62;</title>");

		const health = await fetch(url("/api/health"));
		expect(health.status).toBe(503);
		expect(await health.json()).toEqual({
			status: "starting",
			readiness: "starting",
			version: "9.9.9",
		});

		for (const path of ["/api/narrators", "/ws/narrator", "/assets/index.js"]) {
			const response = await fetch(url(path));
			expect(response.status).toBe(503);
			expect(response.headers.get(STARTUP_STATUS_HEADER)).toBe("1");
		}
	});

	test("reports the current step", async () => {
		const { url } = await start();
		reportStartupStep({ key: "migrating", current: 2, total: 5 });
		const body = await startupBody(url, (b) => (b.step as { key: string }).key === "migrating");
		expect(body.version).toBe("9.9.9");
		expect(body.step).toEqual({ key: "migrating", current: 2, total: 5 });
		expect(typeof body.now).toBe("number");
	});

	test("frees the port on close", async () => {
		const { port } = await start();
		await closeStartupStatus();
		const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("main") });
		try {
			expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("main");
		} finally {
			server.stop(true);
		}
	});

	test("skips the page when the port is taken", async () => {
		const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		try {
			const listening = await startStartupStatus(
				{ hostname: "127.0.0.1", port: holder.port ?? 0 },
				{ version: "9.9.9", brandName: "NarraFork" },
			);
			expect(listening).toBe(false);
			// Without a page there is nobody to wait for.
			const startedAt = Date.now();
			await showStartupProblem(problem);
			expect(Date.now() - startedAt).toBeLessThan(100);
		} finally {
			holder.stop(true);
		}
	});

	test("a failure waits until the open page has read it", async () => {
		const { url } = await start();
		// A page is polling.
		await fetch(url("/api/startup"));
		let done = false;
		const shown = showStartupProblem(problem).then(() => {
			done = true;
		});
		await Bun.sleep(50);
		expect(done).toBe(false);
		const body = await (await fetch(url("/api/startup"))).json();
		expect(body.problem).toEqual(problem);
		await shown;
		expect(done).toBe(true);
	});

	test("a failure waits for a browser that is being opened", async () => {
		const { url } = await start();
		expectStartupViewer();
		await startupBody(url, () => true);
		let done = false;
		const shown = showStartupProblem(problem).then(() => {
			done = true;
		});
		await startupBody(url, (b) => !!b.problem);
		await shown;
		expect(done).toBe(true);
	});

	test("a failure nobody is looking at does not wait", async () => {
		await start();
		const startedAt = Date.now();
		await showStartupProblem(problem);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});
});

describe("startup status ownership", () => {
	let handles: WorkerHandle<Worker>[];
	let mode: string;
	let readyDelay: number;
	let listens: Promise<void>[];
	let spawns: ReturnType<typeof spyOn<typeof WorkerHandle, "thread">>;
	const target = { hostname: "127.0.0.1", port: 1 };
	const branding = { version: "fixture", brandName: "fixture" };
	const fixture = new URL("./status-worker.fixture.ts", import.meta.url);

	function timeoutSpy(
		implementation: (...args: Parameters<typeof setTimeout>) => ReturnType<typeof setTimeout>,
	) {
		return spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign(implementation, {
				__promisify__: globalThis.setTimeout.__promisify__,
			}) as typeof setTimeout,
		);
	}

	async function created() {
		const deadlineAt = Date.now() + 2_000;
		while (!handles[0] && Date.now() < deadlineAt) await Bun.sleep(1);
		const handle = handles[0];
		if (!handle) throw new Error("fixture worker was not created");
		return handle;
	}

	beforeEach(() => {
		handles = [];
		listens = [];
		mode = "listening";
		readyDelay = 0;
		const create = WorkerHandle.thread;
		spawns = spyOn(WorkerHandle, "thread").mockImplementation(() => {
			const handle = create(fixture, { workerData: { mode, readyDelay } });
			handles.push(handle);
			const post = handle.resource.postMessage.bind(handle.resource);
			listens.push(
				new Promise<void>((resolve) => {
					handle.resource.postMessage = (message, transfer) => {
						if (message.type === "listen") resolve();
						post(message, transfer);
					};
				}),
			);
			return handle;
		});
	});

	afterEach(async () => {
		await closeStartupStatus();
		await Promise.all(handles.map((handle) => handle.close()));
		spawns.mockRestore();
	});

	test("unavailable diagnostics redact worker errors and a throwing sink cannot skip actual exit", async () => {
		mode = "silent";
		const canary = "/private/STARTUP_CANARY.ts?token=secret";
		const records: unknown[] = [];
		const info = spyOn(logger, "info").mockImplementation((message, fields) => {
			records.push({ message, fields });
			throw new Error("diagnostic sink failed");
		});
		try {
			const pending = startStartupStatus(target, branding);
			const handle = await created();
			await listens[0];
			handle.resource.emit("message", { type: "unavailable", error: canary });
			expect(await pending).toBe(false);
			await handle.exited;
			expect(handle.resource.threadId).toBe(-1);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ fields: { phase: "listen", outcome: "unavailable" } });
			expect(JSON.stringify(records)).not.toContain(canary);
			expect(JSON.stringify(records)).not.toContain("secret");
		} finally {
			info.mockRestore();
		}
	});

	test("throwing exit diagnostics still clear the owner and allow a new real worker", async () => {
		const records: unknown[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, fields) => {
			records.push({ message, fields });
			throw new Error("diagnostic sink failed");
		});
		try {
			expect(await startStartupStatus(target, branding)).toBe(true);
			const handle = handles[0];
			await handle.resource.terminate();
			await handle.exited;
			expect(handle.resource.threadId).toBe(-1);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ fields: { phase: "exit", outcome: "unavailable" } });
			expect(await startStartupStatus(target, branding)).toBe(true);
			expect(handles).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});
	test("deduplicates pending starts and closes a real never-ready worker before returning", async () => {
		mode = "never-ready";
		const first = startStartupStatus(target, branding);
		expect(startStartupStatus(target, branding)).toBe(first);
		const handle = await created();
		let exited = false;
		void handle.exited.then(() => {
			exited = true;
		});
		const closing = closeStartupStatus();
		expect(closeStartupStatus()).toBe(closing);
		expect(await startStartupStatus(target, branding)).toBe(false);
		await closing;
		expect(await first).toBe(false);
		expect(exited).toBe(true);
		expect(handles).toHaveLength(1);
		expect(handle.resource.listenerCount("message")).toBe(0);
		await closeStartupStatus();
		mode = "listening";
		expect(await startStartupStatus(target, branding)).toBe(true);
		expect(handles).toHaveLength(2);
	});

	test("a connector cleanup failure keeps its real startup owner until exit", async () => {
		mode = "never-ready";
		const handle = WorkerHandle.thread(fixture);
		const actualClose = handle.close.bind(handle);
		const failure = new Error("unconfirmed startup exit");
		const stop = spyOn(handle, "close").mockRejectedValue(failure);
		const connection = spyOn(compiled, "connectCompiledWorker").mockRejectedValue(
			new WorkerCleanupError(handle, failure),
		);
		try {
			expect(await startStartupStatus(target, branding)).toBe(false);
			expect(await startStartupStatus(target, branding)).toBe(false);
			expect(connection).toHaveBeenCalledTimes(1);
			expect(await closeStartupStatus().catch((error: unknown) => error)).toBe(failure);
			expect(await startStartupStatus(target, branding)).toBe(false);
			await actualClose();
			await handle.exited;
			connection.mockRestore();
			mode = "listening";
			expect(await startStartupStatus(target, branding)).toBe(true);
			expect(handles).toHaveLength(2);
		} finally {
			connection.mockRestore();
			stop.mockRestore();
			await actualClose();
		}
	});
	test("close before the reserved connect runs cannot publish a late page", async () => {
		const pending = startStartupStatus(target, branding);
		await closeStartupStatus();
		expect(await pending).toBe(false);
		expect(spawns).not.toHaveBeenCalled();
	});

	test("a close during listen blocks replacement until the real worker exits", async () => {
		mode = "control-only";
		const pending = startStartupStatus(target, branding);
		const handle = await created();
		await listens[0];
		// Hold the stop, so a fake "closed" flag cannot satisfy the handoff contract.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stop = handle.close.bind(handle);
		const stopping = spyOn(handle, "close").mockImplementation(async () => {
			await gate;
			await stop();
		});
		let closed = false;
		let exited = false;
		void handle.exited.then(() => {
			exited = true;
		});
		try {
			const closing = closeStartupStatus().then(() => {
				closed = true;
			});
			expect(await startStartupStatus(target, branding)).toBe(false);
			expect(closed).toBe(false);
			expect(exited).toBe(false);
			expect(handles).toHaveLength(1);
			release();
			await closing;
			expect(await pending).toBe(false);
			expect(exited).toBe(true);
			expect(handle.resource.listenerCount("message")).toBe(0);
		} finally {
			release();
			stopping.mockRestore();
		}
	});

	test("a connection completing after close is stopped without publishing or sending listen", async () => {
		const connect = compiled.connectCompiledWorker;
		let ready!: () => void;
		let release!: () => void;
		const connected = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = spyOn(compiled, "connectCompiledWorker").mockImplementation(
			async (entries, options) => {
				const result = await connect(entries, options);
				ready();
				// Simulate completion queued just before abort, delivered just after it.
				await gate;
				return result;
			},
		);
		try {
			const pending = startStartupStatus(target, branding);
			await connected;
			const handle = handles[0];
			if (!handle) throw new Error("missing worker");
			const post = spyOn(handle.resource, "postMessage");
			const closing = closeStartupStatus();
			expect(await startStartupStatus(target, branding)).toBe(false);
			release();
			await closing;
			expect(await pending).toBe(false);
			expect(post).not.toHaveBeenCalled();
			expect(typeof (await handle.exited)).toBe("number");
			expect(handle.resource.listenerCount("message")).toBe(0);
			post.mockRestore();
		} finally {
			release();
			connection.mockRestore();
		}
	});

	test("re-evaluated imports reuse the hot-safe owner, and stale exits cannot clear its successor", async () => {
		expect(await startStartupStatus(target, branding)).toBe(true);
		const source = new URL("../index.ts", import.meta.url);
		const copy = new URL(`../.startup-status-hot-${crypto.randomUUID()}.ts`, import.meta.url);
		await writeFile(copy, await readFile(source, "utf8"), { flag: "wx" });
		try {
			const reloaded = await import(copy.href);
			expect(reloaded.startStartupStatus).not.toBe(startStartupStatus);
			expect(await reloaded.startStartupStatus(target, branding)).toBe(true);
			expect(handles).toHaveLength(1);
			const previous = handles[0];
			await reloaded.closeStartupStatus();
			expect(await startStartupStatus(target, branding)).toBe(true);
			previous?.resource.emit("exit", 99);
			expect(await reloaded.startStartupStatus(target, branding)).toBe(true);
			expect(handles).toHaveLength(2);
		} finally {
			await rm(copy, { force: true });
		}
	});

	test("creation failure never serves a main-thread fallback and can be reset repeatedly", async () => {
		spawns.mockImplementation(() => {
			throw new Error("creation disabled");
		});
		const serve = spyOn(Bun, "serve");
		try {
			expect(await startStartupStatus(target, branding)).toBe(false);
			await showStartupProblem(problem);
			await closeStartupStatus();
			await closeStartupStatus();
			expect(await startStartupStatus(target, branding)).toBe(false);
			expect(serve).not.toHaveBeenCalled();
		} finally {
			serve.mockRestore();
		}
	});

	for (const failure of [
		"never-ready",
		"exit-before-ready",
		"unavailable",
		"exit",
		"error",
		"control-only",
	]) {
		test(`${failure} fails without a page or leaked wait listeners`, async () => {
			mode = failure;
			const serve = spyOn(Bun, "serve");
			// Exercise production timeout paths without waiting five seconds per fault.
			const schedule = globalThis.setTimeout;
			const timers = timeoutSpy((callback, ms, ...args) =>
				schedule(callback, Math.min(ms ?? 0, 1_000), ...args),
			);
			try {
				expect(await startStartupStatus(target, branding)).toBe(false);
				if (failure !== "never-ready" && failure !== "exit-before-ready")
					expect(timers).toHaveBeenCalledTimes(2);
				const handle = handles[0];
				expect(handle).toBeDefined();
				expect(typeof (await handle?.exited)).toBe("number");
				expect(handle?.resource.listenerCount("message")).toBe(0);
				// Only the public handle's lifetime error listener remains.
				expect(handle?.resource.listenerCount("error")).toBe(1);
				expect(handle?.resource.listenerCount("exit")).toBe(0);
				await showStartupProblem(problem);
				expect(serve).not.toHaveBeenCalled();
			} finally {
				timers.mockRestore();
				serve.mockRestore();
			}
		});
	}

	test("connect and listen share the original absolute five-second budget", async () => {
		readyDelay = 60;
		const connect = compiled.connectCompiledWorker;
		let deadlineAt = 0;
		const connection = spyOn(compiled, "connectCompiledWorker").mockImplementation(
			(entries, options) => {
				deadlineAt = options?.deadlineAt ?? 0;
				return connect(entries, options);
			},
		);
		const schedule = globalThis.setTimeout;
		const waits: number[] = [];
		const timerIds: ReturnType<typeof setTimeout>[] = [];
		const clears = spyOn(globalThis, "clearTimeout");
		const timers = timeoutSpy((callback, ms, ...args) => {
			waits.push(ms ?? 0);
			const timer = schedule(callback, ms, ...args);
			timerIds.push(timer);
			return timer;
		});
		// Observe the actual budget origin, not an earlier caller-side clock tick. Forward real
		// time unchanged: no frozen clock or wider deadline can hide a phase-budget reset.
		const now = Date.now;
		let before: number | undefined;
		const clock = spyOn(Date, "now").mockImplementation(() => {
			const value = now();
			before ??= value;
			return value;
		});
		try {
			expect(await startStartupStatus(target, branding)).toBe(true);
			expect(before).toBeDefined();
			const totalBudget = deadlineAt - (before ?? 0);
			expect(totalBudget).toBeGreaterThanOrEqual(4_900);
			expect(totalBudget).toBeLessThanOrEqual(5_000);
			expect(totalBudget).toBe(5_000);
			expect(waits).toHaveLength(2);
			expect(waits[1]).toBeLessThan((waits[0] ?? 0) - 40);
			for (const timer of timerIds) expect(clears).toHaveBeenCalledWith(timer);
			expect(handles[0]?.resource.listenerCount("message")).toBe(0);
		} finally {
			clock.mockRestore();
			timers.mockRestore();
			clears.mockRestore();
			connection.mockRestore();
		}
	});

	test("a late listen acknowledgement cannot beat an expired absolute deadline", async () => {
		mode = "control-only";
		const pending = startStartupStatus(target, branding);
		const handle = await created();
		await listens[0];
		const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
		try {
			handle.resource.emit("message", { type: "listening" });
		} finally {
			clock.mockRestore();
		}
		expect(await pending).toBe(false);
		expect(typeof (await handle.exited)).toBe("number");
		expect(handle.resource.listenerCount("message")).toBe(0);
	});

	test("problem waits remove timers and listeners on timeout, exit and acknowledgement", async () => {
		expect(await startStartupStatus(target, branding)).toBe(true);
		const handle = handles[0];
		if (!handle) throw new Error("missing worker");
		const schedule = globalThis.setTimeout;
		const timerIds: ReturnType<typeof setTimeout>[] = [];
		const clears = spyOn(globalThis, "clearTimeout");
		const timers = timeoutSpy((callback, ms, ...args) => {
			const timer = schedule(callback, Math.min(ms ?? 0, 30), ...args);
			timerIds.push(timer);
			return timer;
		});
		try {
			await showStartupProblem(problem);
			expect(handle.resource.listenerCount("message")).toBe(0);
			const shown = showStartupProblem(problem);
			handle.resource.emit("message", { type: "problem-shown" });
			await shown;
			expect(handle.resource.listenerCount("message")).toBe(0);
			const interrupted = showStartupProblem(problem);
			await closeStartupStatus();
			await interrupted;
			expect(handle.resource.listenerCount("message")).toBe(0);
			expect(handle.resource.listenerCount("error")).toBe(1);
			expect(timerIds).toHaveLength(3);
			for (const timer of timerIds) expect(clears).toHaveBeenCalledWith(timer);
		} finally {
			timers.mockRestore();
			clears.mockRestore();
		}
	});
});

describe("snapshotForViewer", () => {
	const snapshot = { version: "1", step: { key: "starting" as const }, stepStartedAt: 0, problem };

	test("keeps commands and details for a browser on the server itself", () => {
		expect(snapshotForViewer(snapshot, true)).toEqual(snapshot);
	});

	test("shows another machine only the message", () => {
		expect(snapshotForViewer(snapshot, false).problem).toEqual({ message: problem.message });
	});

	test("a browser on the server itself connects from loopback without forwarding", () => {
		const none = new Headers();
		for (const address of ["127.0.0.1", "127.8.0.2", "::1", "::ffff:127.0.0.1"]) {
			expect(isLocalViewer(address, none)).toBe(true);
		}
		for (const address of ["192.168.1.2", "::ffff:10.0.0.1", "fe80::1", undefined]) {
			expect(isLocalViewer(address, none)).toBe(false);
		}
	});

	test("a reverse proxy on the server is not the viewer", () => {
		for (const header of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
			expect(isLocalViewer("127.0.0.1", new Headers({ [header]: "203.0.113.7" }))).toBe(false);
		}
	});
});

describe("toStartupProblem", () => {
	test("passes a StartupError through", () => {
		expect(toStartupProblem(new StartupError(problem))).toBe(problem);
	});

	test("describes anything else as unexpected, with the error as detail", () => {
		const described = toStartupProblem(new Error("boom"));
		expect(described.message.en).toContain("unexpected");
		expect(described.detail).toContain("boom");
		expect(described.command).toBeUndefined();
	});
});
