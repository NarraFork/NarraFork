import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { cancelDrag, endDrag, getPanelDrag, moveDrag, startDragManual } from "../../lib/panel-drag";
import type { RecentTabDropRow } from "./recent-tab-drop-target";
import {
	type RecentTabExternalDropState,
	type UseRecentTabExternalDropOptions,
	useRecentTabExternalDrop,
} from "./useRecentTabExternalDrop";

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
let state: RecentTabExternalDropState | null;
let renders: number;
let rows: RecentTabDropRow[];
let drops: Parameters<UseRecentTabExternalDropOptions["onDrop"]>[0][];
let measurements: number;
let options: UseRecentTabExternalDropOptions;
let rect: DOMRect;
const globals = new Map<string, PropertyDescriptor | undefined>();

function Probe() {
	state = useRecentTabExternalDrop(options);
	renders++;
	return <div data-indicator={state?.narratorId ?? ""} />;
}

async function render() {
	await act(async () => root.render(<Probe />));
}

async function drag(action: () => unknown) {
	await act(async () => {
		action();
	});
}

// Simulate a release update without notifying move listeners: the hook must remeasure.
function releaseAt(x: number, y: number) {
	const current = getPanelDrag();
	if (!current) throw new Error("missing active drag");
	Object.assign(current, { x, y });
	return endDrag();
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	mounted = true;
	state = null;
	renders = 0;
	measurements = 0;
	drops = [];
	rows = [
		{ key: "narrator:anchor", top: 30, bottom: 70, pinned: false, keyBlock: ["narrator:anchor"] },
	];
	rect = { left: 0, right: 100, top: 10, bottom: 200 } as DOMRect;
	const sidebar = document.createElement("div");
	sidebar.getBoundingClientRect = () => rect;
	document.body.appendChild(sidebar);
	options = {
		containerRef: { current: sidebar },
		enabled: true,
		suspended: false,
		measureRows: () => {
			measurements++;
			return rows;
		},
		onDrop: (drop) => drops.push(drop),
	};
});

afterEach(async () => {
	if (mounted) await act(async () => root.unmount());
	cancelDrag();
	host.remove();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

describe("useRecentTabExternalDrop", () => {
	test("rejects release outside the sidebar after an inside move", async () => {
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		expect(state).not.toBeNull();
		await drag(() => releaseAt(101, 40));
		expect(drops).toEqual([]);
		expect(state).toBeNull();
	});

	test("remeasures the container bounds at release", async () => {
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		rect = { ...rect, left: 200, right: 300 };
		await drag(endDrag);
		expect(drops).toEqual([]);
		expect(state).toBeNull();
	});

	test("accepts release without any observed move", async () => {
		startDragManual("external", "External", 50, 40);
		await render();
		expect(state).toBeNull();
		expect(measurements).toBe(0);
		await drag(endDrag);
		expect(drops).toEqual([
			{
				narratorId: "external",
				title: "External",
				target: { kind: "before", key: "narrator:anchor" },
			},
		]);
		expect(measurements).toBe(1);
	});

	test("uses release coordinates and fresh rows for workspace drops", async () => {
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		rows = [
			{
				key: "workspace:w",
				top: 80,
				bottom: 120,
				pinned: false,
				workspaceId: "w",
				keyBlock: ["workspace:w"],
			},
		];
		await drag(() => releaseAt(50, 100));
		expect(drops[0]?.target).toEqual({ kind: "workspace", workspaceId: "w" });
		expect(measurements).toBe(2);
		expect(state).toBeNull();
	});

	test("supports external drops in empty sections and does not repeat", async () => {
		rows = [];
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		await drag(endDrag);
		await drag(endDrag);
		expect(drops).toEqual([
			{ narratorId: "external", title: "External", target: { kind: "empty" } },
		]);
		expect(state).toBeNull();
	});

	test("reads synchronous suspendedRef changes without rerender on release", async () => {
		const suspendedRef = { current: false };
		options.suspendedRef = suspendedRef;
		await render();
		await drag(() => startDragManual("internal", "Internal", 50, 40));
		const previousRenders = renders;
		suspendedRef.current = true;
		expect(renders).toBe(previousRenders);
		await drag(endDrag);
		expect(drops).toEqual([]);
		expect(state).toBeNull();
	});

	test("reads synchronous suspendedRef on moves and gives false priority over boolean", async () => {
		const suspendedRef = { current: true };
		options.suspended = true;
		options.suspendedRef = suspendedRef;
		await render();
		await drag(() => startDragManual("internal", "Internal", 50, 40));
		expect(state).toBeNull();
		suspendedRef.current = false;
		await drag(() => moveDrag(50, 40));
		expect(state).not.toBeNull();
		suspendedRef.current = true;
		await drag(() => moveDrag(50, 40));
		expect(state).toBeNull();
		await drag(endDrag);
		expect(drops).toEqual([]);
	});

	test("retains the boolean suspension fallback and clears indicator on rerender", async () => {
		await render();
		await drag(() => startDragManual("internal", "Internal", 50, 40));
		options = { ...options, suspended: true };
		await render();
		expect(state).toBeNull();
		await drag(endDrag);
		expect(drops).toEqual([]);
	});

	test("null cancellation clears the indicator without dropping", async () => {
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		await drag(cancelDrag);
		expect(state).toBeNull();
		expect(drops).toEqual([]);
	});

	test("rejects non-narrator final subjects even after a narrator move", async () => {
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		const current = getPanelDrag();
		if (!current) throw new Error("missing drag");
		current.subjectKind = "tool";
		await drag(endDrag);
		expect(drops).toEqual([]);
		expect(state).toBeNull();
	});

	test("uses the final narrator identity and title rather than stale move state", async () => {
		await render();
		await drag(() => startDragManual("old", "Old", 50, 40));
		const current = getPanelDrag();
		if (!current) throw new Error("missing drag");
		Object.assign(current, { id: "new", title: "New" });
		await drag(endDrag);
		expect(drops[0]).toEqual({
			narratorId: "new",
			title: "New",
			target: { kind: "before", key: "narrator:anchor" },
		});
	});

	test("disable/re-enable clears stale indicators and does not duplicate listeners", async () => {
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		options = { ...options, enabled: false };
		await render();
		expect(state).toBeNull();
		await drag(endDrag);
		expect(drops).toEqual([]);
		options = { ...options, enabled: true };
		await render();
		expect(state).toBeNull();
		await drag(() => startDragManual("external", "External", 50, 40));
		await drag(endDrag);
		expect(drops).toHaveLength(1);
	});

	test("unmount removes subscriptions while an indicator is active", async () => {
		await render();
		await drag(() => startDragManual("external", "External", 50, 40));
		await act(async () => root.unmount());
		mounted = false;
		expect(host.childNodes.length).toBe(0);
		await drag(() => moveDrag(50, 60));
		await drag(endDrag);
		expect(drops).toEqual([]);
	});
});
