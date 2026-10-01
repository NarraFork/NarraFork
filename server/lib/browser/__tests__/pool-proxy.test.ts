import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { settings } from "../../settings";

const realPuppeteer = { ...(await import("puppeteer-core")) };
const savedProxy = settings.proxy;
const savedPolicy = settings.agent.webFetchPolicy;
const savedBrowserProxy = settings.agent.browserProxy;
const contexts: Array<{ options: unknown; close: ReturnType<typeof mock>; page: EventEmitter }> =
	[];
let navigationFails = false;
let pageCreationFails = false;
const fakeBrowser = {
	connected: true,
	close: async () => {},
	createBrowserContext: mock(async (options: unknown) => {
		const page = Object.assign(new EventEmitter(), {
			setViewport: async () => {},
			setUserAgent: async () => {},
			setDefaultNavigationTimeout: () => {},
			setDefaultTimeout: () => {},
			goto: async () => {
				if (navigationFails) throw new Error("navigation failed");
			},
			close: async () => {
				page.emit("close");
			},
		});
		const context = {
			close: mock(async () => {}),
			newPage: async () => {
				if (pageCreationFails) throw new Error("page creation failed");
				return page;
			},
		};
		contexts.push({ options, close: context.close, page });
		return context;
	}),
};
mock.module("puppeteer-core", () => ({
	...realPuppeteer,
	default: { ...realPuppeteer.default, connect: async () => fakeBrowser },
}));
const { connectBrowser, closeBrowser, createContext, fetchPage } = await import("../pool");

beforeEach(async () => {
	contexts.length = 0;
	navigationFails = false;
	pageCreationFails = false;
	settings.proxy = { mode: "custom", url: "http://global:8080" };
	settings.agent.webFetchPolicy = { proxy: { mode: "custom", url: "http://fetch:8081" } };
	settings.agent.browserProxy = { mode: "custom", url: "http://browser:8082" };
	await connectBrowser(true, "ws://fake-browser");
});
afterEach(async () => {
	await closeBrowser();
	settings.proxy = savedProxy;
	settings.agent.webFetchPolicy = savedPolicy;
	settings.agent.browserProxy = savedBrowserProxy;
});
afterAll(() => {
	mock.module("puppeteer-core", () => realPuppeteer);
	mock.restore();
});

test("shared process creates independent Browser and WebFetch contexts", async () => {
	await createContext();
	const page = await fetchPage("https://example.test");
	expect(contexts[0]?.options).toMatchObject({ proxyServer: "http://browser:8082" });
	expect(contexts[1]?.options).toMatchObject({ proxyServer: "http://fetch:8081" });
	await page.close();
	expect(contexts[1]?.close).toHaveBeenCalledTimes(1);
	expect(contexts[0]?.close).not.toHaveBeenCalled();
});

test("new sessions pick up changes without closing an existing session", async () => {
	await createContext();
	settings.agent.browserProxy = { mode: "direct" };
	await createContext();
	expect(contexts[0]?.options).toMatchObject({ proxyServer: "http://browser:8082" });
	expect(contexts[1]?.options).toMatchObject({ proxyServer: "direct://" });
	expect(contexts[0]?.close).not.toHaveBeenCalled();
});

test("navigation failure disposes the isolated WebFetch context", async () => {
	navigationFails = true;
	await expect(fetchPage("https://example.test")).rejects.toThrow("navigation failed");
	expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
});

test("page creation failure disposes the isolated WebFetch context", async () => {
	pageCreationFails = true;
	await expect(fetchPage("https://example.test")).rejects.toThrow("page creation failed");
	expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
});
