import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fileReferenceApi } from "@frontend/lib/api/file-references";
import { MantineProvider } from "@mantine/core";
import type {
	FileReference,
	FileReferenceCandidate,
	FileReferenceEditorSelection,
	FileReferenceSearchResult,
} from "@shared/file-reference";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { FileReferencePopover } from "./FileReferencePopover";
import { getFileReferenceQuery, rememberFileReference } from "./file-reference-input";

let root: Root;
let host: HTMLElement;
let instance: i18n;
let textareaRef = createRef<HTMLTextAreaElement>();
let selected: FileReference[];
let navigated: FileReferenceCandidate[];
let closes = 0;
let sends = 0;
let scope = "";
let searchSpy: ReturnType<typeof spyOn<typeof fileReferenceApi, "search">>;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const entry: FileReferenceCandidate = {
	deviceId: "RemoteABC",
	path: "/work/src/中文 file.ts",
	name: "中文 file.ts",
	relativePath: "src/中文 file.ts",
	isDirectory: false,
};
const saved: FileReferenceEditorSelection = {
	target: {
		deviceId: entry.deviceId,
		path: entry.path,
		selection: { startLineNumber: 10, startColumn: 2, endLineNumber: 20, endColumn: 1 },
	},
	label: entry.relativePath,
	expectedHash: "saved-hash",
	dirty: false,
};

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	instance = i18next.createInstance();
	await instance
		.use(initReactI18next)
		.init({ lng: "en", resources: { en: { narrator: {} } }, react: { useSuspense: false } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	textareaRef = createRef<HTMLTextAreaElement>();
	selected = [];
	navigated = [];
	closes = 0;
	sends = 0;
	scope = `user:narrator:RemoteABC:/work:${Math.random()}`;
	searchSpy = spyOn(fileReferenceApi, "search").mockResolvedValue({
		entries: [entry],
		truncated: false,
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	searchSpy.mockRestore();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

async function render(value: string, selection?: FileReferenceEditorSelection) {
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={instance}>
					<FileReferencePopover
						narratorId="n1"
						context={{ deviceId: "RemoteABC", cwd: "/work" }}
						cacheScope={scope}
						query={getFileReferenceQuery(value, value.length)}
						selection={selection}
						textareaRef={textareaRef}
						onSelect={(ref) => selected.push(ref)}
						onNavigate={(candidate) => navigated.push(candidate)}
						onClose={() => {
							closes++;
						}}
					/>
					<textarea
						ref={textareaRef}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								!event.defaultPrevented &&
								!event.nativeEvent.isComposing &&
								event.nativeEvent.keyCode !== 229
							)
								sends++;
						}}
					/>
				</I18nextProvider>
			</MantineProvider>,
		),
	);
}

async function key(
	key: string,
	options: Partial<KeyboardEvent> = {},
	target: HTMLElement | null = textareaRef.current,
) {
	// React's input-event fallback needs an active element in linkedom (no native focus events).
	if (target === textareaRef.current && target) {
		Object.assign(target, { attachEvent() {}, detachEvent() {} });
		await act(async () => {
			target.dispatchEvent(new Event("focusin", { bubbles: true }));
		});
	}
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, {
		key,
		keyCode: key === "Enter" ? 13 : 0,
		isComposing: false,
		shiftKey: false,
		...options,
	});
	await act(async () => {
		target?.dispatchEvent(event);
	});
	return event;
}
const settleSearch = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 180));
	});

describe("file completion keyboard ownership", () => {
	test("empty query uses only recent metadata and arrows/Enter select without sending", async () => {
		rememberFileReference(scope, { ...entry, id: "a", label: entry.relativePath });
		rememberFileReference(scope, { ...entry, id: "b", path: "/work/other.ts", label: "other.ts" });
		await render("#");
		expect(searchSpy).not.toHaveBeenCalled();
		expect(host.textContent).toContain("RemoteABC");
		expect(host.textContent).toContain("src/");
		expect((await key("ArrowDown")).defaultPrevented).toBe(true);
		expect((await key("Enter")).defaultPrevented).toBe(true);
		expect(selected[0]?.path).toBe(entry.path);
		expect(sends).toBe(0);
		await key("ArrowUp");
		await key("Tab");
		expect(selected[1]?.path).toBe("/work/other.ts");
		await key("Escape");
		expect(closes).toBe(1);
	});
	test("pending or empty results consume Enter/Tab and never send", async () => {
		await render("#missing");
		await key("Enter");
		expect(selected).toEqual([]);
		expect(sends).toBe(0);
		searchSpy.mockResolvedValue({ entries: [], truncated: false });
		await settleSearch();
		expect((await key("Tab")).defaultPrevented).toBe(true);
		expect((await key("Enter")).defaultPrevented).toBe(true);
		expect(sends).toBe(0);
	});
	test("IME and Shift+Enter are not consumed; another textarea remains independent", async () => {
		await render("#selection", saved);
		expect((await key("Enter", { isComposing: true })).defaultPrevented).toBe(false);
		expect((await key("ArrowDown", { isComposing: true })).defaultPrevented).toBe(false);
		expect((await key("Enter", { keyCode: 229 })).defaultPrevented).toBe(false);
		expect(selected).toEqual([]);
		expect(sends).toBe(0);
		expect((await key("Enter", { shiftKey: true })).defaultPrevented).toBe(false);
		const other = document.createElement("textarea");
		document.body.append(other);
		expect((await key("Enter", {}, other)).defaultPrevented).toBe(false);
		other.remove();
	});
	test("#selection uses the saved hash and refuses dirty or missing selection", async () => {
		await render("#selection", { ...saved, dirty: true });
		await key("Enter");
		expect(selected).toEqual([]);
		expect(host.textContent).toContain("先保存");
		await render("#selection", saved);
		await key("Tab");
		expect(selected[0]).toMatchObject({ ...saved.target, expectedHash: saved.expectedHash });
		expect(searchSpy).not.toHaveBeenCalled();
	});
});

describe("file completion request lifecycle", () => {
	test("debounces each query, aborts the old request and ignores stale results", async () => {
		let finishOld: ((result: FileReferenceSearchResult) => void) | undefined;
		searchSpy.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishOld = resolve;
				}),
		);
		await render("#s");
		await render("#src");
		expect(searchSpy).not.toHaveBeenCalled();
		await settleSearch();
		expect(searchSpy).toHaveBeenCalledTimes(1);
		expect(searchSpy.mock.calls[0]?.[1]).toEqual({
			q: "src",
			deviceId: "RemoteABC",
			directory: "/work",
		});
		const oldSignal = searchSpy.mock.calls[0]?.[2];
		await render("#other");
		expect(oldSignal?.aborted).toBe(true);
		await settleSearch();
		expect(searchSpy).toHaveBeenCalledTimes(2);
		await act(async () =>
			finishOld?.({ entries: [{ ...entry, name: "STALE" }], truncated: false }),
		);
		expect(host.textContent).not.toContain("STALE");
		await render("");
		expect(searchSpy.mock.calls[1]?.[2]?.aborted).toBe(true);
	});
	test("supports directory navigation and row ranges without resolving or previewing sources", async () => {
		searchSpy.mockResolvedValueOnce({
			entries: [
				{ ...entry, path: "/work/src", name: "src", relativePath: "src", isDirectory: true },
			],
			truncated: false,
		});
		await render("#src");
		await settleSearch();
		await key("Enter");
		expect(navigated[0]?.isDirectory).toBe(true);
		expect(selected).toEqual([]);
		await render("#src/a.ts:10-20");
		await settleSearch();
		await key("Tab");
		expect(searchSpy.mock.calls[1]?.[1].q).toBe("src/a.ts");
		expect(selected[0]?.selection).toEqual({
			startLineNumber: 10,
			startColumn: 1,
			endLineNumber: 21,
			endColumn: 1,
		});
	});
	test("limits displayed candidates to fifty and preserves empty # recent-only behavior", async () => {
		searchSpy.mockResolvedValue({
			entries: Array.from({ length: 80 }, (_, i) => ({
				...entry,
				path: `/work/${i}`,
				name: String(i),
			})),
			truncated: true,
		});
		await render("#src");
		await settleSearch();
		expect(host.querySelectorAll("[data-file-reference-item]").length).toBe(50);
		await render("#");
		expect(searchSpy).toHaveBeenCalledTimes(1);
	});
});
