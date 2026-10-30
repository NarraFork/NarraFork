import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realPuppeteer = { ...(await import("puppeteer-core")) };
const fakeBrowser = { disconnect: mock(async () => {}) };
let connectBehavior: Array<() => Promise<unknown>> = [];
const connect = mock((_options: { browserWSEndpoint: string; defaultViewport: unknown }) => {
	const next = connectBehavior.shift();
	return next ? next() : Promise.reject(new Error("connect ECONNREFUSED"));
});
mock.module("puppeteer-core", () => ({
	...realPuppeteer,
	default: { ...realPuppeteer.default, connect },
}));

const { attachUserBrowser } = await import("../user-browser");

/** 不存在的可执行文件：重试路径里的「拉起浏览器」只会记一条日志。 */
const MISSING_BROWSER = join(tmpdir(), "narrafork-missing-browser", "msedge.exe");
let userDataDir: string;

function enableRemoteDebugging(enabled: boolean) {
	writeFileSync(
		join(userDataDir, "Local State"),
		JSON.stringify({ devtools: { remote_debugging: { "user-enabled": enabled } } }),
	);
}

function writeActivePort() {
	writeFileSync(join(userDataDir, "DevToolsActivePort"), "9333\n/devtools/browser/abc\n");
}

describe("attachUserBrowser", () => {
	beforeEach(() => {
		userDataDir = mkdtempSync(join(tmpdir(), "narrafork-user-browser-"));
		connectBehavior = [];
		connect.mockClear();
	});

	afterEach(() => {
		rmSync(userDataDir, { recursive: true, force: true });
	});

	afterAll(() => {
		mock.module("puppeteer-core", () => realPuppeteer);
		mock.restore();
	});

	test("does nothing unless the user enabled remote debugging", async () => {
		writeActivePort();
		enableRemoteDebugging(false);
		expect(await attachUserBrowser(MISSING_BROWSER, userDataDir)).toBeUndefined();
		expect(connect).not.toHaveBeenCalled();
	});

	test("connects to the endpoint in DevToolsActivePort without forcing a viewport", async () => {
		enableRemoteDebugging(true);
		writeActivePort();
		connectBehavior = [async () => fakeBrowser];
		expect(await attachUserBrowser(MISSING_BROWSER, userDataDir)).toBe(fakeBrowser as never);
		expect(connect.mock.calls[0]?.[0]).toEqual({
			browserWSEndpoint: "ws://127.0.0.1:9333/devtools/browser/abc",
			defaultViewport: null,
		});
	});

	test("respects a declined approval prompt", async () => {
		enableRemoteDebugging(true);
		writeActivePort();
		connectBehavior = [
			async () => {
				await Bun.sleep(1_100);
				throw new Error("Unexpected server response: 403");
			},
		];
		expect(await attachUserBrowser(MISSING_BROWSER, userDataDir)).toBeUndefined();
		expect(connect).toHaveBeenCalledTimes(1);
	});

	test("retries while the browser has no window to show the prompt", async () => {
		enableRemoteDebugging(true);
		writeActivePort();
		connectBehavior = [
			async () => {
				throw new Error("Unexpected server response: 403");
			},
			async () => fakeBrowser,
		];
		expect(await attachUserBrowser(MISSING_BROWSER, userDataDir)).toBe(fakeBrowser as never);
		expect(connect).toHaveBeenCalledTimes(2);
	});
});
