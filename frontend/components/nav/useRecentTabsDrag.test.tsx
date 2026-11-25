import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { QueryClient } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import { recentTabsSectionQueryKey } from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";
import { clearToken, confirmAuthUser, setToken } from "../../lib/api/client";
import {
	cancelDrag,
	getPanelDrag,
	onPanelDragEnd,
	PANEL_DROP_PRIORITY,
	registerPanelDropTarget,
	startDragManual,
} from "../../lib/panel-drag";
import { getRecentTabsScope } from "../../lib/recent-tabs-owner";
import { useRecentTabExternalDrop } from "./useRecentTabExternalDrop";
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
const subscriptions: (() => void)[] = [];
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
	const storage = new Map<string, string>();
	const values = {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
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
	confirmAuthUser(setToken("fixture-auth"), "fixture-user");
	const scope = getRecentTabsScope();
	if (!scope) throw Error("Missing drag test scope");
	options = {
		scope,
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
	for (const off of subscriptions.splice(0)) off();
	flushSync(() => root.unmount());
	cancelDrag();
	for (const spy of spies.splice(0)) spy.mockRestore();
	await new Promise((resolve) => setTimeout(resolve, 0));
	clearToken();
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
it("a late drag result cannot reorder a replacement credential's cache", async () => {
	let resolve!: (value: Awaited<ReturnType<typeof api.moveRecentTab>>) => void;
	const move = spyOn(api, "moveRecentTab").mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	spies.push(move);
	start();
	const submitted = end();
	const oldKey = recentTabsSectionQueryKey(options.scope, "work");
	const before = {
		pages: [{ items: options.tabs, revision: 1, hasMore: false }],
		pageParams: [undefined],
	};
	options.qc.setQueryData(oldKey, before);
	confirmAuthUser(setToken("fixture-auth-rotated"), "fixture-user");
	const replacement = getRecentTabsScope();
	if (!replacement) throw Error("Missing replacement scope");
	const nextKey = recentTabsSectionQueryKey(replacement, "work");
	options.qc.setQueryData(nextKey, before);
	resolve({
		changed: true,
		baseRevision: 1,
		revision: 2,
		operations: [{ type: "remove", key: "narrator:a" }],
	});
	await submitted;
	expect(options.qc.getQueryData(oldKey)).toBe(before);
	expect(options.qc.getQueryData(nextKey)).toBe(before);
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
it("a team row bridges its coordinator as a narrator and does not reorder outside", async () => {
	const move = spyOn(api, "moveRecentTab");
	spies.push(move);
	options = {
		...options,
		tabs: [
			tab("coordinator", { type: "team", title: "Release crew", projectId: "project" }),
			...options.tabs,
		],
	};
	render();
	start("team:coordinator");
	expect(getPanelDrag()).toMatchObject({
		id: "coordinator",
		title: "Release crew",
		subjectKind: "narrator",
	});
	await end(0, 300);
	expect(move).not.toHaveBeenCalled();
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

function watchOtherTargets() {
	const calls: { target: string; x: number; y: number }[] = [];
	for (const target of ["page", "dock", "topology", "composer"] as const) {
		subscriptions.push(
			registerPanelDropTarget({
				id: `other:${target}`,
				priority: PANEL_DROP_PRIORITY[target],
				hitTest: (state) =>
					(target === "composer" || target === "topology") && state.subjectKind !== "narrator"
						? null
						: { x: state.x, y: state.y },
				onDrop: (_state, hit) => calls.push({ target, ...hit }),
			}),
		);
	}
	return calls;
}

it("an in-sidebar no-op is consumed, not cancelled or passed to composer/dock/page", async () => {
	const calls = watchOtherTargets();
	const move = spyOn(api, "moveRecentTab");
	spies.push(move);
	options = { ...options, tabs: [tab("a")] };
	const list = options.containerRef.current as HTMLElement;
	for (const row of [...list.querySelectorAll("[data-tab-sort-id]")].slice(1)) row.remove();
	render();
	let final: unknown = "unseen";
	subscriptions.push(
		onPanelDragEnd((state) => {
			final = state;
		}),
	);
	start();
	await end(0);
	expect(final).toMatchObject({ id: "a", x: 50, y: 15 });
	expect(calls).toEqual([]);
	expect(move).not.toHaveBeenCalled();
	expect(result.draggingId).toBeNull();
});

it("@dnd-kit release outside the sidebar reaches one composer hit with actual mouseup coordinates", async () => {
	const calls = watchOtherTargets();
	const move = spyOn(api, "moveRecentTab");
	spies.push(move);
	start();
	// No HTML5 drop is dispatched. The captured release, not dnd-kit's stale delta, wins.
	dispatchMouse("mouseup", { clientX: 350, clientY: 80, buttons: 0 });
	await end(0, 0);
	expect(calls).toEqual([{ target: "composer", x: 350, y: 80 }]);
	expect(move).not.toHaveBeenCalled();
	expect(result.draggingRef.current).toBe(false);
	expect(getPanelDrag()).toBeNull();
});

it.each([
	{ type: "narrator" as const, narratorId: undefined, expected: "a" },
	{ type: "subagent" as const, narratorId: "stable-subagent", expected: "stable-subagent" },
	{ type: "subagent" as const, narratorId: undefined, expected: "a" },
])("$type with narratorId=$narratorId reaches a strict narrator consumer by stable identity", async ({
	type,
	narratorId,
	expected,
}) => {
	options = { ...options, tabs: [tab("a", { type, narratorId }), tab("b"), tab("c")] };
	render();
	const references: string[] = [];
	subscriptions.push(
		registerPanelDropTarget({
			id: "strict-composer",
			priority: PANEL_DROP_PRIORITY.composer,
			hitTest: (state) => (state.subjectKind === "narrator" ? { narratorId: state.id } : null),
			onDrop: (_state, hit) => references.push(hit.narratorId),
		}),
	);
	start(`${type}:a`);
	expect(getPanelDrag()).toMatchObject({ id: expected, subjectKind: "narrator" });
	await end(0, 300);
	expect(references).toEqual([expected]);
	expect(getPanelDrag()).toBeNull();
});

it("subagent sorting keeps its tab key while global references use its narrator identity", async () => {
	options = {
		...options,
		tabs: [tab("a", { type: "subagent", narratorId: "stable-subagent" }), tab("b"), tab("c")],
	};
	const row = options.containerRef.current?.querySelector<HTMLElement>("[data-tab-sort-id]");
	if (!row) throw new Error("missing subagent row");
	row.dataset.tabSortId = "subagent:a";
	render();
	const lower = watchOtherTargets();
	const move = spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: true,
		baseRevision: 0,
		revision: 1,
		operations: [],
	});
	spies.push(move);
	start("subagent:a");
	expect(getPanelDrag()).toMatchObject({ id: "stable-subagent", subjectKind: "narrator" });
	await end();
	expect(move.mock.calls[0]?.slice(0, 2)).toEqual(["subagent:a", { afterKey: "narrator:c" }]);
	expect(lower).toEqual([]);
});

it("an internal mutation and an external sidebar receiver cannot both consume one release", async () => {
	const external: unknown[] = [];
	function CombinedHarness() {
		result = useRecentTabsDrag(options);
		useRecentTabExternalDrop({
			containerRef: options.containerRef,
			enabled: true,
			suspended: result.draggingId !== null,
			suspendedRef: result.draggingRef,
			measureRows: result.measureRows,
			sourceFor: (id) => ({ key: `narrator:${id}`, kind: "tab", pinned: false, canNest: true }),
			onDrop: (drop) => external.push(drop),
		});
		return null;
	}
	flushSync(() => root.render(createElement(CombinedHarness)));
	const calls = watchOtherTargets();
	const move = spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: true,
		baseRevision: 0,
		revision: 1,
		operations: [],
	});
	spies.push(move);
	start();
	await end();
	expect(move).toHaveBeenCalledTimes(1);
	expect(external).toEqual([]);
	expect(calls).toEqual([]);
});

it("a project sorts locally but is never bridged as a narrator reference", async () => {
	const calls = watchOtherTargets();
	options = {
		...options,
		tabs: [tab("a", { type: "project", narratorId: "not-a-session" }), tab("b"), tab("c")],
	};
	const row = options.containerRef.current?.querySelector<HTMLElement>("[data-tab-sort-id]");
	if (!row) throw new Error("missing project row");
	row.dataset.tabSortId = "project:a";
	render();
	const move = spyOn(api, "moveRecentTab").mockResolvedValue({
		changed: true,
		baseRevision: 0,
		revision: 1,
		operations: [],
	});
	spies.push(move);
	start("project:a");
	expect(getPanelDrag()).toBeNull();
	await end();
	expect(move.mock.calls[0]?.slice(0, 2)).toEqual(["project:a", { afterKey: "narrator:c" }]);
	expect(calls).toEqual([]);
});

it("a replaced global drag is neither completed nor reinterpreted as a local reorder", async () => {
	const move = spyOn(api, "moveRecentTab");
	spies.push(move);
	start();
	startDragManual("other", "Other owner", 400, 80);
	await end();
	expect(move).not.toHaveBeenCalled();
	expect(getPanelDrag()?.id).toBe("other");
});

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
