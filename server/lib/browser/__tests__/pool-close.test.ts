import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser } from "puppeteer-core";
import { logger } from "../../logger";

const realPuppeteer = { ...(await import("puppeteer-core")) };
let closeCalls = 0;
let disconnectCalls = 0;
let releaseClose: (() => void) | null = null;
let fakeBrowser: Browser;
let pendingConnect: Promise<Browser> | undefined;

function createFakeBrowser(options: { deferredClose?: boolean } = {}): Browser {
	return {
		connected: true,
		close: mock(() => {
			closeCalls++;
			if (!options.deferredClose) return Promise.resolve();
			return new Promise<void>((resolve) => {
				releaseClose = resolve;
			});
		}),
		disconnect: mock(() => {
			disconnectCalls++;
		}),
	} as unknown as Browser;
}

mock.module("puppeteer-core", () => ({
	...realPuppeteer,
	default: {
		...realPuppeteer.default,
		connect: mock(async () => pendingConnect ?? fakeBrowser),
	},
}));

const { closeBrowser, connectBrowser, getBrowser, setBrowserPreserveMode } = await import(
	"../pool"
);

describe("browser pool shutdown", () => {
	beforeEach(async () => {
		setBrowserPreserveMode(false);
		releaseClose?.();
		await closeBrowser();
		closeCalls = 0;
		disconnectCalls = 0;
		releaseClose = null;
		fakeBrowser = createFakeBrowser();
		pendingConnect = undefined;
	});

	afterEach(async () => {
		releaseClose?.();
		setBrowserPreserveMode(false);
		await closeBrowser();
	});

	afterAll(() => {
		mock.module("puppeteer-core", () => realPuppeteer);
		mock.restore();
	});

	test("deduplicates concurrent normal close calls", async () => {
		fakeBrowser = createFakeBrowser({ deferredClose: true });
		await connectBrowser(true, "ws://fake-normal");

		const first = closeBrowser();
		const second = closeBrowser();

		expect(second).toBe(first);
		expect(closeCalls).toBe(1);
		releaseClose?.();
		await Promise.all([first, second]);
	});

	test("deduplicates preserve-mode disconnects", async () => {
		await connectBrowser(false, "ws://fake-preserve");
		setBrowserPreserveMode(true);

		await Promise.all([closeBrowser(), closeBrowser()]);

		expect(disconnectCalls).toBe(1);
		expect(closeCalls).toBe(0);
	});

	test("close observes pending native connection and refuses replacement launch until cleanup", async () => {
		let resume!: (browser: Browser) => void;
		pendingConnect = new Promise((resolve) => {
			resume = resolve;
		});
		const connecting = connectBrowser(true, "ws://pending").catch((error: Error) => error);
		let settled = false;
		const closing = closeBrowser();
		void closing.then(() => {
			settled = true;
		});
		try {
			await expect(getBrowser(true)).rejects.toThrow("closing");
			expect(settled).toBe(false);
			expect(closeCalls).toBe(0);
			resume(fakeBrowser);
			expect(((await connecting) as Error).message).toContain("closing");
			await closing;
			expect(closeCalls).toBe(1);
		} finally {
			resume(fakeBrowser);
			await closing;
		}
	});

	test("pool HMR retains actual browser handles and installs no duplicate signal hooks", async () => {
		await connectBrowser(true, "ws://hot-owner");
		const hooks = ["beforeExit", "SIGINT", "SIGTERM"].map((name) => process.listenerCount(name));
		const reloaded = await import(`../pool.ts?reload=${crypto.randomUUID()}`);
		expect(reloaded.closeBrowser).not.toBe(closeBrowser);
		expect(await reloaded.getBrowser(true)).toBe(fakeBrowser);
		expect(["beforeExit", "SIGINT", "SIGTERM"].map((name) => process.listenerCount(name))).toEqual(
			hooks,
		);
		await Promise.all([reloaded.closeBrowser(), closeBrowser()]);
		expect(closeCalls).toBe(1);
	});

	for (const mode of ["standalone", "claimed"]) {
		test(`real isolated SIGTERM honors ${mode} shutdown ownership across HMR`, async () => {
			const home = await mkdtemp(join(tmpdir(), "nf-browser-signal-"));
			try {
				const { stdout } = await promisify(execFile)(
					process.execPath,
					[join(import.meta.dir, "browser-shutdown-signal.fixture.ts"), mode],
					{
						timeout: 10_000,
						maxBuffer: 64 * 1024,
						env: { ...process.env, NARRAFORK_HOME: home, NARRAFORK_LOG_LEVEL: "error" },
					},
				);
				expect(JSON.parse(stdout.trim())).toEqual({
					claimed: mode === "claimed",
					closed: mode === "claimed" ? 0 : 1,
					disconnected: mode === "claimed" ? 1 : 0,
					workersClosed: true,
					hooksUnchanged: true,
				});
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		}, 15_000);
	}

	test("legacy pool HMR without signal and resource ownership evidence fails closed", async () => {
		const key = Symbol.for("narrafork.browser.pool");
		const current = Reflect.get(globalThis, key);
		const hooks = process.listenerCount("SIGTERM");
		const legacy = { version: 1, browsers: new Map(), launching: new Map(), hooksInstalled: true };
		try {
			Reflect.set(globalThis, key, legacy);
			await expect(import(`../pool.ts?legacy=${crypto.randomUUID()}`)).rejects.toThrow(
				"ownership cannot be recovered",
			);
			expect(Reflect.get(globalThis, key)).toBe(legacy);
			expect(process.listenerCount("SIGTERM")).toBe(hooks);
		} finally {
			Reflect.set(globalThis, key, current);
		}
	});

	test("release failure logs fixed scalar classification, not the error or endpoint", async () => {
		const close = spyOn(fakeBrowser, "close").mockImplementation(async () => {
			throw new Error("ws://private-path-error-canary");
		});
		const sink = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await connectBrowser(true, "ws://private-endpoint-canary");
			await closeBrowser();
			expect(sink).toHaveBeenCalledWith("Failed to release browser", {
				headless: true,
				preserve: false,
				owned: true,
				stage: "release",
			});
			expect(JSON.stringify(sink.mock.calls)).not.toContain("canary");
		} finally {
			close.mockRestore();
			sink.mockRestore();
		}
	});

	test("throwing logger sinks cannot reject or bypass browser release", async () => {
		const sink = spyOn(logger, "info").mockImplementation(() => {
			throw new Error("sink failed");
		});
		try {
			expect(await connectBrowser(true, "ws://log-failure")).toBe(fakeBrowser);
			await closeBrowser();
			expect(closeCalls).toBe(1);
		} finally {
			sink.mockRestore();
		}
	});
});
