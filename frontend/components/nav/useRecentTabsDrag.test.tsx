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
		groupingEnabled: false,
		directoryCollapsedByPath: new Map(),
		containerRef: { current: list },
		qc: new QueryClient(),
		onError: () => {},
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
			item.id === "a" ? { ...item, title: "live", status: "running", dirSortOrder: 8 } : item,
		),
	};
	// Harness identity must be stable across renders.
	flushSync(() => root.render(createElement(StableHarness)));
	expect(result.renderTabs.find((item) => item.id === "a")).toMatchObject({
		title: "live",
		status: "running",
		dirSortOrder: 8,
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
it("mode and source membership changes cancel rather than reinterpret a drag", () => {
	start();
	options = { ...options, groupingEnabled: true };
	render();
	expect(result.draggingRef.current).toBe(false);
	render();
	expect(result.draggingId).toBeNull();
	options = { ...options, groupingEnabled: false };
	render();
	start();
	options = {
		...options,
		tabs: options.tabs.map((item) => (item.id === "a" ? { ...item, workspaceId: "new" } : item)),
	};
	render();
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
it("awaits directory member persistence without any flat move", async () => {
	options = {
		...options,
		groupingEnabled: true,
		tabs: [tab("a", { subtitle: "/repo" }), tab("b", { subtitle: "/repo" }), tab("c")],
		directoryCollapsedByPath: new Map([["/repo", false]]),
	};
	render();
	const move = spyOn(api, "moveRecentTab");
	let resolve!: (value: Awaited<ReturnType<typeof api.setRecentTabDirectoryOrder>>) => void;
	const directory = spyOn(api, "setRecentTabDirectoryOrder").mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	spies.push(move, directory);
	start();
	const promise = end(40);
	expect(directory.mock.calls[0]?.[0]).toEqual(["narrator:b", "narrator:a"]);
	expect(directory.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
	expect(result.pending).toBe(true);
	expect(result.renderTabs[0].dirSortOrder).toBe(1);
	expect(move).not.toHaveBeenCalled();
	resolve({ changed: true, baseRevision: 0, revision: 1, operations: [] });
	await promise;
	render();
	expect(result.pending).toBe(false);
});
it("serially awaits every flat move in a directory unit replay", async () => {
	options = {
		...options,
		groupingEnabled: true,
		tabs: [
			tab("a", { subtitle: "/a" }),
			tab("b", { subtitle: "/a" }),
			tab("c", { subtitle: "/b" }),
			tab("d", { subtitle: "/b" }),
		],
		directoryCollapsedByPath: new Map([
			["/a", true],
			["/b", true],
		]),
	};
	const list = options.containerRef.current as HTMLElement;
	list.replaceChildren();
	for (const [index, key] of ["dir:/a", "dir:/b"].entries()) {
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
	const resolves: ((value: Awaited<ReturnType<typeof api.moveRecentTab>>) => void)[] = [];
	const move = spyOn(api, "moveRecentTab").mockImplementation(
		() =>
			new Promise((done) => {
				resolves.push(done);
			}),
	);
	spies.push(move);
	start("dir:/a");
	const promise = end(40);
	expect(move).toHaveBeenCalledTimes(1);
	resolves[0]({ changed: true, baseRevision: 0, revision: 1, operations: [] });
	await Promise.resolve();
	await Promise.resolve();
	expect(move).toHaveBeenCalledTimes(2);
	expect(result.pending).toBe(true);
	resolves[1]({ changed: true, baseRevision: 1, revision: 2, operations: [] });
	await promise;
	render();
	expect(result.pending).toBe(false);
});
