/**
 * The browser-native download path introduced for the "download file" menu item.
 *
 * `fsDownloadUrl` is the piece that replaced fetch-then-Blob, so what it has to get right is
 * narrow but load-bearing:
 *
 *   - the URL it navigates to is the TICKET route, with the ticket percent-encoded (a raw
 *     signature can contain `+`/`/` once base64, and `&`/`#` would truncate the query);
 *   - the mount base path is applied, because the URL is handed to the browser rather than to
 *     `fetch`, and a wrong URL here downloads nothing while looking fine;
 *   - the click goes through a synthetic anchor, so the SPA does not navigate away and the
 *     `Content-Disposition` filename still wins over the hint.
 *
 * A real DOM is not available in this test environment (no happy-dom/jsdom), so `document` is
 * stubbed with the three calls the helper actually makes. The assertions are on the anchor that
 * was created and clicked, which is exactly the observable behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetAppBaseForTest } from "@frontend/lib/base-path";
import { fsDownloadUrl } from "@frontend/lib/file-download";

interface RecordedAnchor {
	href: string;
	download: string;
	rel: string;
	appended: boolean;
	clicked: boolean;
	removed: boolean;
}

let recorded: RecordedAnchor[] = [];
let originalDocument: unknown;

/** Minimal `document` stub: `createElement`, `body.appendChild`, and `remove()`. */
function installDocumentStub(): void {
	originalDocument = (globalThis as { document?: unknown }).document;
	const body = {
		appendChild: (node: RecordedAnchor) => {
			node.appended = true;
			return node;
		},
	};
	const stub = {
		createElement: () => {
			const anchor: RecordedAnchor & { click: () => void; remove: () => void } = {
				href: "",
				download: "",
				rel: "",
				appended: false,
				clicked: false,
				removed: false,
				click() {
					anchor.clicked = true;
				},
				remove() {
					anchor.removed = true;
				},
			};
			recorded.push(anchor);
			return anchor;
		},
		body,
	};
	(globalThis as { document?: unknown }).document = stub;
}

beforeEach(() => {
	recorded = [];
	resetAppBaseForTest();
	installDocumentStub();
});

afterEach(() => {
	(globalThis as { document?: unknown }).document = originalDocument;
	resetAppBaseForTest();
});

/** The single anchor a call must produce, with the length assertion folded in. */
function onlyAnchor(): RecordedAnchor {
	expect(recorded).toHaveLength(1);
	const [anchor] = recorded;
	if (!anchor) throw new Error("expected exactly one anchor to be created");
	return anchor;
}

describe("fsDownloadUrl", () => {
	test("navigates to the ticket route with the ticket encoded", () => {
		// A base64url signature can still contain `-`/`_`; a `&` or `#` would truncate the query.
		fsDownloadUrl("abc.def.ghi-jkl_mno", "报告.json");

		const anchor = onlyAnchor();
		expect(anchor.href).toBe("/api/fs/download?ticket=abc.def.ghi-jkl_mno");
		expect(anchor.download).toBe("报告.json");
		// No opener: the download must not gain a handle back to this page.
		expect(anchor.rel).toBe("noopener");
	});

	test("percent-encodes characters that would break the query", () => {
		fsDownloadUrl("a b&c#d=e+f", "x.txt");

		expect(onlyAnchor().href).toBe("/api/fs/download?ticket=a%20b%26c%23d%3De%2Bf");
	});

	test("clicks the anchor and cleans it up", () => {
		fsDownloadUrl("ticket", "name.txt");

		const anchor = onlyAnchor();
		expect(anchor.appended).toBe(true);
		expect(anchor.clicked).toBe(true);
		expect(anchor.removed).toBe(true);
	});

	test("requests exactly one anchor per call, so one click downloads one file", () => {
		fsDownloadUrl("t1", "a.txt");
		fsDownloadUrl("t2", "b.txt");

		expect(recorded.map((a) => a.href)).toEqual([
			"/api/fs/download?ticket=t1",
			"/api/fs/download?ticket=t2",
		]);
	});
});

/**
 * The notification a user sees when the ticket could not be minted. The key has to exist in both
 * shipped locales — a missing translation renders the raw key, which is the exact opposite of the
 * "clear message" this path is supposed to provide.
 */
describe("download notification copy", () => {
	const locales = ["en", "zh-CN"] as const;

	function narratorLocale(locale: string): Record<string, string> {
		const path = resolve(import.meta.dir, `../../locales/${locale}/narrator.json`);
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
	}

	test.each(locales)("%s defines the download-failed title", (locale) => {
		const messages = narratorLocale(locale);
		expect(messages["fileViewer.downloadFailed"]).toBeTruthy();
	});

	test.each(locales)("%s defines the download menu label", (locale) => {
		const messages = narratorLocale(locale);
		expect(messages.contextMenu_downloadFile).toBeTruthy();
	});
});
