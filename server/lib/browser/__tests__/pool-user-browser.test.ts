// 有头会话进入用户自己浏览器时的池行为：标签归属、放手方式、交接排除。
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "puppeteer-core";

const realUserBrowser = { ...(await import("../user-browser")) };
const pages: Array<Page & EventEmitter> = [];
const context = {
	targets: () => pages.filter((page) => !page.isClosed()).map((page) => page.target()),
	newPage: async () => fakePage(),
	close: mock(async () => {
		throw new Error("the default context cannot be closed");
	}),
};
const userBrowser = {
	connected: true,
	defaultBrowserContext: () => context,
	disconnect: mock(async () => {}),
	close: mock(async () => {}),
	wsEndpoint: () => "ws://user-browser",
};
Object.assign(context, { browser: () => userBrowser });

function fakePage(): Page & EventEmitter {
	let closed = false;
	const page = Object.assign(new EventEmitter(), {
		isClosed: () => closed,
		close: mock(async () => {
			closed = true;
			page.emit("close");
		}),
	}) as unknown as Page & EventEmitter;
	const target = {
		type: () => "page",
		opener: () => undefined,
		page: async () => page,
		browserContext: () => context,
	};
	Object.assign(page, { target: () => target });
	pages.push(page);
	return page;
}

mock.module("../user-browser", () => ({
	...realUserBrowser,
	attachUserBrowser: mock(async () => userBrowser as unknown as Browser),
}));

const { closeBrowser, getBrowserWsEndpoints, openTab, systemBrowsers } = await import("../pool");

/** 只有找得到装在系统位置、带默认 profile 的浏览器时，池才会尝试用户自己的浏览器。 */
const hasSystemBrowser = systemBrowsers().some(
	({ path, userDataDir }) => userDataDir && existsSync(path),
);
const savedEnv = {
	PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH,
	PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
	DISPLAY: process.env.DISPLAY,
};
const emptyCache = mkdtempSync(join(tmpdir(), "narrafork-empty-puppeteer-cache-"));

describe.skipIf(!hasSystemBrowser)("headed sessions in the user's own browser", () => {
	beforeAll(() => {
		delete process.env.PUPPETEER_EXECUTABLE_PATH;
		process.env.PUPPETEER_CACHE_DIR = emptyCache;
		process.env.DISPLAY ??= ":0";
	});

	afterEach(async () => {
		await closeBrowser();
		pages.length = 0;
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(emptyCache, { recursive: true, force: true });
		mock.module("../user-browser", () => realUserBrowser);
		mock.restore();
	});

	test("opens tabs in the user's default context", async () => {
		const tab = await openTab(false);
		expect(tab.inUserBrowser).toBe(true);
		expect(tab.context).toBe(context as never);
	});

	test("releasing closes only our tabs and never the user's browser", async () => {
		const usersOwnTab = fakePage();
		const ours = await openTab(false);
		await closeBrowser();
		expect(ours.page.isClosed()).toBe(true);
		expect(usersOwnTab.isClosed()).toBe(false);
		expect(userBrowser.disconnect).toHaveBeenCalled();
		expect(userBrowser.close).not.toHaveBeenCalled();
	});

	test("the user's browser is not offered for restart handoff", async () => {
		await openTab(false);
		expect(getBrowserWsEndpoints()).toEqual({});
	});
});
