import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

let canOpen: boolean | undefined = true;
let lists = 0;
let viewStateReads = 0;
let liveGrids = 0;
const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	ActionIcon: pass,
	Box: pass,
	Group: pass,
	Text: pass,
	Tooltip: pass,
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("../../hooks/usePlatform", () => ({
	useTerminalCapability: () => ({ supported: true }),
}));
mock.module("../../hooks/useTerminals", () => ({
	useCanOpenTerminals: () => canOpen,
	useNarratorTerminals: () => {
		lists++;
		return { data: [{ id: "term", name: "Terminal", status: "running" }] };
	},
	useCreateNarratorTerminal: () => ({ mutate: () => {}, isPending: false }),
	useDeleteNarratorTerminal: () => ({ mutate: () => {} }),
	useRenameTerminal: () => ({ mutate: () => {} }),
}));
mock.module("../../hooks/useTerminalViewState", () => ({
	useTerminalViewState: () => {
		viewStateReads++;
		return { data: { activeTabId: "term", layout: "single" }, update: () => {} };
	},
}));
mock.module("./LayoutSelector", () => ({ LayoutSelector: () => null }));
mock.module("./TerminalTabBar", () => ({ TerminalTabBar: () => null }));
mock.module("./TerminalGrid", () => ({
	TerminalGrid: () => {
		useEffect(() => {
			liveGrids++;
			return () => {
				liveGrids--;
			};
		}, []);
		return <output>connected</output>;
	},
}));
const { NarratorTerminal } = await import("./NarratorTerminal");
let root: Root;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.defineProperty(window.document, "visibilityState", {
		value: "visible",
		writable: true,
		configurable: true,
	});
	// A split pane is visible even while keyboard focus is elsewhere.
	Object.defineProperty(window.document, "hasFocus", { value: () => false, configurable: true });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	canOpen = true;
	lists = 0;
	viewStateReads = 0;
	liveGrids = 0;
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
async function render(visible = true) {
	await act(async () => root.render(<NarratorTerminal narratorId="n" visible={visible} />));
}
async function visibility(state: "visible" | "hidden") {
	await act(async () => {
		Object.defineProperty(document, "visibilityState", {
			value: state,
			writable: true,
			configurable: true,
		});
		document.dispatchEvent(new window.Event("visibilitychange"));
	});
}
test("hidden dock terminal never mounts its list, view-state reader or live grid", async () => {
	await render(false);
	expect(lists).toBe(0);
	expect(viewStateReads).toBe(0);
	expect(liveGrids).toBe(0);
	await render(true);
	expect(lists).toBeGreaterThan(0);
	expect(liveGrids).toBe(1);
	await render(false);
	expect(liveGrids).toBe(0);
});
test("document hiding releases the terminal connection and restores without requiring keyboard focus", async () => {
	await render();
	expect(liveGrids).toBe(1);
	await visibility("hidden");
	expect(liveGrids).toBe(0);
	const before = lists;
	await render();
	expect(lists).toBe(before);
	await visibility("visible");
	expect(liveGrids).toBe(1);
	expect(document.hasFocus()).toBe(false);
});
test("a document already hidden on first mount never briefly starts terminal transport", async () => {
	Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
	await render();
	expect(lists).toBe(0);
	expect(viewStateReads).toBe(0);
	expect(liveGrids).toBe(0);
});
test("unknown or revoked write permission cannot mount terminal transport", async () => {
	canOpen = undefined;
	await render();
	expect(lists).toBe(0);
	canOpen = true;
	await render();
	expect(liveGrids).toBe(1);
	canOpen = false;
	await render();
	expect(liveGrids).toBe(0);
});
