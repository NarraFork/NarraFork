import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Browser } from "puppeteer-core";

const realPuppeteer = { ...(await import("puppeteer-core")) };
let closeCalls = 0;
let disconnectCalls = 0;
let releaseClose: (() => void) | null = null;
let fakeBrowser: Browser;

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
		connect: mock(async () => fakeBrowser),
	},
}));

const { closeBrowser, connectBrowser, setBrowserPreserveMode } = await import("../pool");

describe("browser pool shutdown", () => {
	beforeEach(async () => {
		setBrowserPreserveMode(false);
		releaseClose?.();
		await closeBrowser();
		closeCalls = 0;
		disconnectCalls = 0;
		releaseClose = null;
		fakeBrowser = createFakeBrowser();
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
});
