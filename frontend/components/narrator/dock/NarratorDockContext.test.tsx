import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DockviewApi } from "dockview-react";
import { parseHTML } from "linkedom";
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type NarratorDockContextValue,
	NarratorDockProvider,
	useNarratorDockContext,
} from "./NarratorDockContext";

let root: Root;
let dock: NarratorDockContextValue;
let renders: number[];
let panels: Array<{ params?: { panelType: string } }>;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Consumer = memo(({ index }: { index: number }) => {
	const context = useNarratorDockContext();
	if (!context) throw new Error("Missing dock provider");
	dock = context;
	renders[index]++;
	return <span>{[...context.openToolTypes].join(",")}</span>;
});

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	renders = [0, 0];
	panels = [{ params: { panelType: "chat" } }];
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => {
		root.render(
			<NarratorDockProvider narratorId="narrator">
				<Consumer index={0} />
				<Consumer index={1} />
			</NarratorDockProvider>,
		);
	});
	dock.apiRef.current = {
		get panels() {
			return panels;
		},
	} as unknown as DockviewApi;
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function refresh(...types: string[]) {
	panels = types.map((panelType) => ({ params: { panelType } }));
	await act(async () => dock.refreshOpenToolTypes());
}

describe("dock open tool types", () => {
	test("repeated layout events reuse the empty set and do not notify consumers", async () => {
		const initial = dock;
		const initialTypes = dock.openToolTypes;
		for (let i = 0; i < 4; i++) {
			await act(async () => dock.refreshOpenToolTypes());
		}
		expect(dock.openToolTypes).toBe(initialTypes);
		expect(dock).toBe(initial);
		expect(renders).toEqual([1, 1]);
	});

	test("publishes additions, equal-size replacements and removals without mutating old sets", async () => {
		const empty = dock.openToolTypes;
		await refresh("chat", "spec");
		const spec = dock.openToolTypes;
		expect(spec).toEqual(new Set(["spec"]));
		expect(spec).not.toBe(empty);
		expect(empty.size).toBe(0);
		expect(renders).toEqual([2, 2]);

		await refresh("chat", "terminal");
		expect(dock.openToolTypes).toEqual(new Set(["terminal"]));
		expect(dock.openToolTypes).not.toBe(spec);
		expect(spec).toEqual(new Set(["spec"]));
		expect(renders).toEqual([3, 3]);

		await refresh("chat", "terminal", "spec");
		expect(dock.openToolTypes).toEqual(new Set(["terminal", "spec"]));
		expect(renders).toEqual([4, 4]);

		await refresh("chat");
		expect(dock.openToolTypes.size).toBe(0);
		expect(renders).toEqual([5, 5]);
	});

	test("panel order and unrelated panel params do not publish a new context", async () => {
		await refresh("chat", "spec", "terminal");
		const initial = dock;
		await refresh("terminal", "chat", "spec");
		await refresh("spec", "subagent", "terminal", "file", "unknown");
		panels.push({});
		await act(async () => dock.refreshOpenToolTypes());
		expect(dock).toBe(initial);
		expect(dock.openToolTypes).toBe(initial.openToolTypes);
		expect(renders).toEqual([2, 2]);
	});

	test("removing one of several same-type panels retains the type without notification", async () => {
		await refresh("chat", "spec", "spec", "terminal");
		const initial = dock;
		await refresh("chat", "spec", "terminal");
		expect(dock).toBe(initial);
		expect(dock.openToolTypes.has("spec")).toBe(true);
		expect(renders).toEqual([2, 2]);

		await refresh("chat", "terminal");
		expect(dock.openToolTypes.has("spec")).toBe(false);
		expect(renders).toEqual([3, 3]);
	});

	test("batched refreshes compare against queued state instead of a stale render", async () => {
		await act(async () => {
			panels = [{ params: { panelType: "spec" } }];
			dock.refreshOpenToolTypes();
			panels = [{ params: { panelType: "terminal" } }];
			dock.refreshOpenToolTypes();
		});
		expect(dock.openToolTypes).toEqual(new Set(["terminal"]));
		expect(renders).toEqual([2, 2]);
		const current = dock;
		await refresh("terminal");
		expect(dock).toBe(current);
		expect(renders).toEqual([2, 2]);
	});
});
