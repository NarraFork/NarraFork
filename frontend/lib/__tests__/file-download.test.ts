/**
 * The browser-native download path for the "download file" menu item.
 *
 * What it has to get right:
 *
 *   - the URL is the TICKET route, with the ticket percent-encoded (a raw signature can
 *     contain `+`/`/` once base64, and `&`/`#` would truncate the query);
 *   - the mount base path is applied, because the URL is handed to the browser rather than
 *     to `fetch`, and a wrong URL here downloads nothing while looking fine;
 *   - the tab is opened with `window.open` during the click, and only later pointed at the
 *     ticket URL. There is no `<a download>`: that attribute would save an error page under
 *     the real filename.
 *
 * A real DOM is not available in this test environment (no happy-dom/jsdom), so `window`
 * and `document` are stubbed with the calls the helpers actually make.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetAppBaseForTest } from "@frontend/lib/base-path";
import {
	closeDownloadTab,
	fsDownloadTicketUrl,
	navigateDownloadTab,
	openDownloadTab,
} from "@frontend/lib/file-download";

interface OpenCall {
	url: string;
	target: string;
}

let opened: OpenCall[] = [];
let nextTab: {
	location: { href: string; replace: (url: string) => void };
	opener: unknown;
	closed: boolean;
	close: () => void;
} | null = null;
let previousWindow: PropertyDescriptor | undefined;
let previousDocument: PropertyDescriptor | undefined;
let previousLocation: PropertyDescriptor | undefined;

function installWindow(baseURI = "https://narrafork.local/"): void {
	previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	const documentStub = { baseURI };
	const locationStub = { href: baseURI };
	const windowStub = {
		open: (url: string, target: string) => {
			opened.push({ url, target });
			return nextTab;
		},
		document: documentStub,
		location: locationStub,
	};
	Object.defineProperty(globalThis, "document", { value: documentStub, configurable: true });
	Object.defineProperty(globalThis, "location", { value: locationStub, configurable: true });
	Object.defineProperty(globalThis, "window", {
		value: windowStub,
		configurable: true,
		writable: true,
	});
}

function restore(
	name: "window" | "document" | "location",
	previous: PropertyDescriptor | undefined,
) {
	if (previous) Object.defineProperty(globalThis, name, previous);
	else Reflect.deleteProperty(globalThis, name);
}

beforeEach(() => {
	opened = [];
	nextTab = {
		location: {
			href: "about:blank",
			replace(url: string) {
				this.href = url;
			},
		},
		opener: {},
		closed: false,
		close() {
			this.closed = true;
		},
	};
	resetAppBaseForTest();
	installWindow();
});

afterEach(() => {
	restore("window", previousWindow);
	restore("document", previousDocument);
	restore("location", previousLocation);
	resetAppBaseForTest();
});

describe("fsDownloadTicketUrl", () => {
	test("builds the ticket route with the ticket encoded", () => {
		expect(fsDownloadTicketUrl("abc.def.ghi-jkl_mno")).toBe(
			"/api/fs/download?ticket=abc.def.ghi-jkl_mno",
		);
	});

	test("percent-encodes characters that would break the query", () => {
		expect(fsDownloadTicketUrl("a b&c#d=e+f")).toBe(
			"/api/fs/download?ticket=a%20b%26c%23d%3De%2Bf",
		);
	});

	test("applies a mount prefix from the document base", () => {
		restore("window", previousWindow);
		restore("document", previousDocument);
		restore("location", previousLocation);
		resetAppBaseForTest();
		installWindow("https://example.test/proxy/7778/");

		expect(fsDownloadTicketUrl("ticket")).toBe("/proxy/7778/api/fs/download?ticket=ticket");
	});
});

describe("download tab", () => {
	test("opens a blank tab during the click, with no download attribute involved", () => {
		const tab = openDownloadTab();

		expect(opened).toEqual([{ url: "about:blank", target: "_blank" }]);
		expect(tab).not.toBeNull();
	});

	test("a blocked popup is null rather than a throw", () => {
		nextTab = null;
		expect(openDownloadTab()).toBeNull();
	});

	test("navigates the already-open tab and drops its opener", () => {
		const tab = openDownloadTab();
		if (!tab) throw new Error("expected a tab");
		navigateDownloadTab(tab, "abc.def");

		expect(tab.location.href).toBe("/api/fs/download?ticket=abc.def");
		expect(tab.opener).toBeNull();
	});

	test("closes a tab that will not be used", () => {
		const tab = openDownloadTab();
		if (!tab) throw new Error("expected a tab");
		closeDownloadTab(tab);
		expect((tab as unknown as { closed: boolean }).closed).toBe(true);
	});
});

/**
 * The notification a user sees when the ticket could not be minted, or the popup was blocked.
 * The key has to exist in both shipped locales — a missing translation renders the raw key.
 */
describe("download notification copy", () => {
	const locales = ["en", "zh-CN"] as const;
	const keys = [
		"fileViewer.downloadFailed",
		"contextMenu_downloadFile",
		"contextMenu_downloadPopupBlocked",
		"contextMenu_copyFile",
		"contextMenu_copyFileDone",
		"contextMenu_copyFileFailed",
		"contextMenu_copyFileRemote",
	] as const;

	function narratorLocale(locale: string): Record<string, string> {
		const path = resolve(import.meta.dir, `../../locales/${locale}/narrator.json`);
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
	}

	test.each(locales)("%s defines the download and copy menu copy", (locale) => {
		const messages = narratorLocale(locale);
		for (const key of keys) expect(messages[key]).toBeTruthy();
	});
});
