import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { QueryClient } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import { api } from "../../lib/api";
import { cancelDrag, getPanelDrag, onPanelDragEnd, startDragManual } from "../../lib/panel-drag";
import { type UseRecentTabsDragOptions, useRecentTabsDrag } from "./useRecentTabsDrag";

const tab = (id: string, fields: Partial<RecentTab> = {}): RecentTab => ({
	type: "narrator",
	id,
	title: id,
	lastVisitedAt: 1,
	...fields,
});
let root: Root;
let result: ReturnType<typeof useRecentTabsDrag>;
let options: UseRecentTabsDragOptions;
let restore: () => void;
const spies: { mockRestore: () => void }[] = [];
function render() {
	flushSync(() => root.render(createElement(StableHarness)));
}
function start(id = "narrator:a", x = 50, y = 15) {
	flushSync(() =>
		result.onDragStart({
			active: { id },
			activatorEvent: { clientX: x, clientY: y },
		} as unknown as DragStartEvent),
	);
}
function end(deltaY = 70, deltaX = 0) {
	let promise: Promise<void> | undefined;
	flushSync(() => {
		promise = result.onDragEnd({ delta: { x: deltaX, y: deltaY } } as DragEndEvent);
	});
	return promise as Promise<void>;
}
beforeEach(() => {
	const { window } = parseHTML(
		'<html><body><div id="root"></div><nav data-auto-scroll-gate><div id="list"></div></nav><main></main></body></html>',
	);
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	const old = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	restore = () => {
		for (const [key, descriptor] of old) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	const list = window.document.getElementById("list") as unknown as HTMLElement;
	list.getBoundingClientRect = () => ({
		left: 0,
		right: 200,
		top: 0,
		bottom: 100,
		height: 100,
		width: 200,
		x: 0,
		y: 0,
		toJSON() {},
	});
	for (const [index, id] of ["a", "b", "c"].entries()) {
		const row = window.document.createElement("div");
		row.dataset.tabSortId = `narrator:${id}`;
		row.getBoundingClientRect = () => ({
			...list.getBoundingClientRect(),
			top: index * 30,
			bottom: index * 30 + 30,
			height: 30,
		});
		list.append(row);
	}
	root = createRoot(window.document.getElementById("root") as unknown as HTMLElement);
	options = {
		tabs: [tab("a"), tab("b"), tab("c")],
		folderOptions: { displayOf: () => "expanded", defaultPreview: 3 },
		containerRef: { current: list },
		qc: new QueryClient(),
		onError: () => {},
		newFolderTitle: "New folder",
	};
	render();
});
afterEach(async () => {
	flushSync(() => root.unmount());
	cancelDrag();
	for (const spy of spies.splice(0)) spy.mockRestore();
	await new Promise((resolve) => setTimeout(resolve, 0));
	restore();
});

it("normal clicks are untouched; cancel clears only the owned singleton and suppresses one click", () => {
	expect(result.consumeClick()).toBe(false);
	start();
	expect(getPanelDrag()?.id).toBe("a");
	let final: unknown = "unseen";
	const unsubscribe = onPanelDragEnd((state) => {
		final = state;
	});
	flushSync(() => result.onDragCancel());
	expect(final).toBeNull();
	expect(result.draggingId).toBeNull();
	expect(result.draggingRef.current).toBe(false);
	expect(result.consumeClick()).toBe(true);
	expect(result.consumeClick()).toBe(false);
	unsubscribe();
});
it("awaits a single mutation, clears drag synchronously and gates new drags during pending", async () => {
	let resolve!: (value: Awaited<ReturnType<typeof api.moveRecentTab>>) => void;
	const move = spyOn(api, "moveRecentTab").mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	spies.push(move);
	let suspended = false;
	const unsubscribe = onPanelDragEnd(() => {
		suspended = result.draggingRef.current;
	});
	start();
	const promise = end();
	expect(suspended).toBe(true);
	expect(result.draggingId).toBeNull();
	expect(result.pending).toBe(true);
	expect(move.mock.calls[0]?.slice(0, 2)).toEqual(["narrator:a", { afterKey: "narrator:c" }]);
	expect(move.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
	expect(result.renderTabs.map((item) => item.id)).toEqual(["b", "c", "a"]);
	start("narrator:b");
	expect(result.draggingId).toBeNull();
	// Update props without remounting: optimistic projection must retain live data.
	options = {
		...options,
		tabs: options.tabs.map((item) =>
			item.id === "a" ? { ...item, title: "live", status: "running" } : item,
		),
	};
	// Harness identity must be stable across renders.
	flushSync(() => root.render(createElement(StableHarness)));
	expect(result.renderTabs.find((item) => item.id === "a")).toMatchObject({
		title: "live",
		status: "running",
	});
	resolve({ changed: true, baseRevision: 0, revision: 1, operations: [] });
	await promise;
	render();
	expect(result.pending).toBe(false);
	unsubscribe();
});
function StableHarness() {
	result = useRecentTabsDrag(options);
	return null;
}
it("outside release only notifies panels, never sorts", async () => {
	const move = spyOn(api, "moveRecentTab");
	spies.push(move);
	start();
	await end(0, 300);
	expect(move).not.toHaveBeenCalled();
	expect(result.pending).toBe(false);
	expect(getPanelDrag()).toBeNull();
});
it("source removal and grouping changes cancel, while unmount does not cancel another owner", () => {
	start();
	options = { ...options, tabs: options.tabs.filter((item) => item.id !== "a") };
	flushSync(() => root.render(createElement(StableHarness)));
	expect(getPanelDrag()).toBeNull();
	start("narrator:b");
	startDragManual("other", "other", 400, 50);
	flushSync(() => root.unmount());
	expect(getPanelDrag()?.id).toBe("other");
});
it("scopes measurement and autoscroll to sidebar geometry", () => {
	expect(result.measureRows()).toHaveLength(3);
	const main = document.querySelector("main") as HTMLElement;
	expect(result.autoScrollOptions.canScroll(main)).toBe(false);
	expect(result.autoScrollOptions.canScroll(document.body)).toBe(false);
	start();
	flushSync(() => result.onDragMove({ delta: { x: 300, y: 0 } } as DragEndEvent));
	expect(result.autoScrollOptions.canScroll(options.containerRef.current as HTMLElement)).toBe(
		false,
	);
});

it("uses captured release coordinates instead of scroll-adjusted sensor delta", async () => {
	const move = spyOn(api, "moveRecentTab");
	spies.push(move);
	start();
	const event = document.createEvent("Event");
	event.initEvent("mouseup", true, true);
	Object.assign(event, { clientX: 350, clientY: 80 });
	document.dispatchEvent(event);
	await end(70);
	expect(move).not.toHaveBeenCalled();
});
it("a source that changes folder mid-drag cancels rather than reinterpreting the drag", () => {
	start();
	options = {
		...options,
		tabs: [
			tab("F", { type: "folder" }),
			...options.tabs.map((item) => (item.id === "a" ? { ...item, folderId: "F" } : item)),
		],
	};
	render();
	expect(result.draggingRef.current).toBe(false);
	render();
	expect(result.draggingId).toBeNull();
	expect(getPanelDrag()).toBeNull();
});
it("reports mutation failure, refreshes authority and always releases pending", async () => {
	let errors = 0;
	options = {
		...options,
		onError: () => {
			errors++;
		},
	};
	render();
	const move = spyOn(api, "moveRecentTab").mockRejectedValue(new Error("rejected"));
	spies.push(move);
	start();
	await end();
	render();
	expect(errors).toBe(1);
	expect(result.pending).toBe(false);
	expect(result.renderTabs).toBe(options.tabs);
});
it("dropping onto the middle of a tab creates a folder instead of moving", async () => {
	let resolve!: (value: Awaited<ReturnType<typeof api.createRecentTabFolder>>) => void;
	const create = spyOn(api, "createRecentTabFolder").mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const move = spyOn(api, "moveRecentTab");
	spies.push(create, move);
	// a starts at y=15; +60 lands on the middle of c (60-90).
	start();
	const promise = end(60);
	expect(create.mock.calls[0]?.[0]).toEqual({
		targetKey: "narrator:c",
		sourceKey: "narrator:a",
		title: "New folder",
	});
	expect(create.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
	expect(move).not.toHaveBeenCalled();
	expect(result.pending).toBe(true);
	resolve({ changed: true, baseRevision: 0, revision: 1, operations: [], folderId: "F" });
	await promise;
	render();
	expect(result.pending).toBe(false);
});

it("dropping on a folder member's slot sends the membership with the anchor", async () => {
	options = {
		...options,
		tabs: [tab("a"), tab("F", { type: "folder" }), tab("m", { folderId: "F" })],
	};
	const list = options.containerRef.current as HTMLElement;
	list.replaceChildren();
	for (const [index, key] of ["narrator:a", "folder:F", "narrator:m"].entries()) {
		const row = document.createElement("div");
		row.dataset.tabSortId = key;
		row.getBoundingClientRect = () => ({
			...list.getBoundingClientRect(),
			top: index * 30,
			bottom: index * 30 + 30,
			height: 30,
		});
		list.append(row);
	}
	render();
	const move = spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: true,
		baseRevision: 0,
		revision: 1,
		operations: [],
	});
	spies.push(move);
	// From y=15 to y=85: the lower half of member m.
	start();
	await end(70);
	expect(move.mock.calls[0]?.slice(0, 2)).toEqual([
		"narrator:a",
		{ afterKey: "narrator:m", folderId: "F" },
	]);
});

function dispatchMouse(type: string, fields: Record<string, number>) {
	const event = document.createEvent("Event");
	event.initEvent(type, true, true);
	Object.assign(event, fields);
	document.dispatchEvent(event);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("a release @dnd-kit never reports (quick click/double click) still ends the drag", async () => {
	let final: unknown = "unseen";
	const unsubscribe = onPanelDragEnd((state) => {
		final = state;
	});
	start();
	expect(getPanelDrag()?.id).toBe("a");
	dispatchMouse("mouseup", { clientX: 50, clientY: 20, buttons: 0 });
	await tick();
	render();
	expect(final).toBeNull();
	expect(getPanelDrag()).toBeNull();
	expect(result.draggingId).toBeNull();
	expect(result.draggingRef.current).toBe(false);
	unsubscribe();
});
it("a buttonless move after a missed release also ends the drag", async () => {
	start();
	dispatchMouse("mousemove", { clientX: 60, clientY: 20, buttons: 1 });
	await tick();
	expect(getPanelDrag()?.id).toBe("a");
	dispatchMouse("mousemove", { clientX: 400, clientY: 20, buttons: 0 });
	await tick();
	render();
	expect(getPanelDrag()).toBeNull();
	expect(result.draggingId).toBeNull();
});
it("a normal drop is not cancelled by the release watchdog", async () => {
	const move = spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: true,
		baseRevision: 0,
		revision: 1,
		operations: [],
	});
	spies.push(move);
	start();
	dispatchMouse("mouseup", { clientX: 50, clientY: 85, buttons: 0 });
	await end(70);
	await tick();
	expect(move).toHaveBeenCalledTimes(1);
});
