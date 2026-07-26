/**
 * useVListToolDetails.test.ts — Guards the resolver-identity contract.
 *
 * The bug this locks down was a hard browser crash ("Maximum update depth
 * exceeded", surfaced through PretextLayoutCoordinator.emit → forceStoreRerender):
 * the hook returned its two resolver FUNCTIONS straight out of React Query's
 * `combine`. React Query stabilizes a combined result with `replaceEqualDeep`,
 * which cannot structurally compare functions, so the combined value was "new"
 * on every pass. That invalidated the layout buildOptions memo → rebuilt the
 * pretext document → emitted a coordinator snapshot → re-rendered → repeat.
 *
 * The fix moved the payload map into a ref and made `combine` return a plain
 * comparable revision string. These tests exercise that contract at both levels:
 *
 *   1. `buildToolDetailRevision` is function-free and stable while nothing new
 *      settles (unit level — the property React Query relies on).
 *   2. The mounted hook keeps its resolver identity across unrelated re-renders
 *      and only swaps it when a payload actually arrives (integration level —
 *      the property the layout pipeline relies on).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider, replaceEqualDeep } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { narratorsApi } from "../../../lib/api/narrators";
import {
	buildToolDetailRevision,
	mergeToolDetailPayloads,
	type ToolDetailQueryResult,
	type UseVListToolDetailsResult,
	useVListToolDetails,
} from "./useVListToolDetails";

const DOM_GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"IS_REACT_ACT_ENVIRONMENT",
	"requestAnimationFrame",
	"cancelAnimationFrame",
] as const;

function installDom(): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_GLOBAL_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: false,
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
	};
	for (const key of DOM_GLOBAL_KEYS) {
		const descriptor = previous.get(key);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) {
				(globalThis as Record<string, unknown>)[key] = values[key];
			}
			continue;
		}
		Object.defineProperty(globalThis, key, {
			configurable: true,
			enumerable: descriptor?.enumerable ?? true,
			writable: true,
			value: values[key],
		});
	}
	return () => {
		for (const key of [...DOM_GLOBAL_KEYS].reverse()) {
			const descriptor = previous.get(key);
			if (!descriptor) {
				delete (globalThis as Record<string, unknown>)[key];
				continue;
			}
			const current = Object.getOwnPropertyDescriptor(globalThis, key);
			if (current && !current.configurable) {
				if ("writable" in current && current.writable && "value" in descriptor) {
					(globalThis as Record<string, unknown>)[key] = descriptor.value;
				}
				continue;
			}
			Object.defineProperty(globalThis, key, descriptor);
		}
	};
}

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

const originalGetToolCallDetail = narratorsApi.getToolCallDetail;

let restoreDom: (() => void) | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** Every result object the hook produced, in render order. */
let renders: UseVListToolDetailsResult[] = [];

/** Mount-time harness: renders the hook and records each returned result. */
function Harness(props: { narratorId: string; toolUseIds: readonly string[]; tick: number }) {
	void props.tick;
	renders.push(useVListToolDetails(props.narratorId, props.toolUseIds));
	return null;
}

async function render(props: { narratorId: string; toolUseIds: readonly string[]; tick: number }) {
	if (!queryClient || !root) throw new Error("harness is not initialized");
	root.render(
		createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, props)),
	);
	await settle();
}

beforeEach(() => {
	restoreDom = installDom();
	renders = [];
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	root?.unmount();
	root = null;
	queryClient?.clear();
	queryClient = null;
	await settle();
	container?.remove();
	container = null;
	narratorsApi.getToolCallDetail = originalGetToolCallDetail;
	restoreDom?.();
	restoreDom = null;
});

describe("replaceEqualDeep — why combine must not return functions", () => {
	// This is the mechanism behind the crash, asserted against the real
	// query-core helper React Query uses to stabilize a combined result. It is
	// reproduced HERE rather than by reverting the hook, so nothing that the dev
	// server hot-reloads is touched.
	const combineOld = (payloads: Map<string, unknown>) => ({
		resolveFullToolInput: (id: string) => payloads.get(id),
		resolveFullToolOutput: (id: string) => payloads.get(id),
	});

	test("cannot stabilize a resolver object, so the old combine looped", () => {
		const payloads = new Map<string, unknown>([["t1", "body"]]);
		const first = combineOld(payloads);
		// Identical inputs, identical behavior — yet replaceEqualDeep must hand back
		// the NEW object because a function value can never compare equal. That is
		// the `previousResult !== newResult` the QueriesObserver acted on.
		const stabilized = replaceEqualDeep(first, combineOld(payloads));
		expect(stabilized).not.toBe(first);
	});

	test("does stabilize the revision string the hook returns instead", () => {
		const ids = ["a", "b"];
		const first = buildToolDetailRevision([], ids, [{ data: { inputJson: "x" } }, {}]);
		const second = buildToolDetailRevision([], ids, [{ data: { inputJson: "x" } }, {}]);
		expect(replaceEqualDeep(first, second)).toBe(first);
	});
});

describe("buildToolDetailRevision", () => {
	test("returns a plain string so replaceEqualDeep can compare it", () => {
		const revision = buildToolDetailRevision([], ["a", "b"], [{ data: { inputJson: 1 } }, {}]);
		expect(typeof revision).toBe("string");
	});

	test("is unchanged while nothing new settles", () => {
		const ids = ["a", "b"];
		const pending: readonly ToolDetailQueryResult[] = [{}, {}];
		expect(buildToolDetailRevision([], ids, pending)).toBe(
			buildToolDetailRevision([], ids, [{}, {}]),
		);
		// A different object identity for the SAME settled data must not move it.
		const settledOnce: readonly ToolDetailQueryResult[] = [{ data: { inputJson: "x" } }, {}];
		const settledAgain: readonly ToolDetailQueryResult[] = [{ data: { inputJson: "x" } }, {}];
		expect(buildToolDetailRevision([], ids, settledOnce)).toBe(
			buildToolDetailRevision([], ids, settledAgain),
		);
	});

	test("changes when another payload settles", () => {
		const ids = ["a", "b"];
		const before = buildToolDetailRevision([], ids, [{ data: { inputJson: "x" } }, {}]);
		const after = buildToolDetailRevision([], ids, [
			{ data: { inputJson: "x" } },
			{ data: { outputJson: "y" } },
		]);
		expect(before).not.toBe(after);
	});

	test("keeps a retained payload in the revision after its id is no longer requested", () => {
		// This is what stops the `[] ↔ [id]` oscillation: dropping the id from the
		// request list must not shrink the revision, or the resolvers would swap
		// identity and rebuild the document again.
		const settled = buildToolDetailRevision([], ["a"], [{ data: { inputJson: "x" } }]);
		expect(buildToolDetailRevision(["a"], [], [])).toBe(settled);
	});

	test("ignores the order the shell requested ids in", () => {
		expect(buildToolDetailRevision(["b", "a"], [], [])).toBe(
			buildToolDetailRevision(["a", "b"], [], []),
		);
	});
});

describe("mergeToolDetailPayloads", () => {
	test("keys the settled bodies by tool use id and skips pending ones", () => {
		const payloads = mergeToolDetailPayloads(
			new Map(),
			["a", "b"],
			[{ data: { inputJson: "in", outputJson: "out" } }, {}],
		);
		expect(payloads.get("a")).toEqual({ inputJson: "in", outputJson: "out" });
		expect(payloads.has("b")).toBe(false);
	});

	test("retains earlier payloads whose ids are no longer requested", () => {
		const retained = new Map([["a", { inputJson: "kept" }]]);
		const payloads = mergeToolDetailPayloads(retained, ["b"], [{ data: { inputJson: "new" } }]);
		expect(payloads.get("a")).toEqual({ inputJson: "kept" });
		expect(payloads.get("b")).toEqual({ inputJson: "new", outputJson: undefined });
	});

	test("returns the same map when nothing new settled", () => {
		const retained = new Map([["a", { inputJson: "kept" }]]);
		expect(mergeToolDetailPayloads(retained, ["b"], [{}])).toBe(retained);
		expect(mergeToolDetailPayloads(retained, [], [])).toBe(retained);
	});
});

describe("useVListToolDetails — settled payloads survive leaving the wanted set", () => {
	// The second loop in the same feedback path. Once a payload lands, the adapter
	// clears `hasTruncatedPayload`, so the shell drops that id from
	// `truncatedExpandedToolUseIds`. If the hook forgot the payload at that moment,
	// the resolver went back to `undefined`, the card re-rendered as truncated, the
	// id re-entered the wanted set, and the list oscillated `[] ↔ ["t1"]` forever
	// (React Query serves the cached body instantly, so each turn completes in the
	// same tick). Retaining settled payloads breaks that cycle.
	test("still resolves a body after its id leaves the requested list", async () => {
		narratorsApi.getToolCallDetail = (async () => ({
			inputJson: { command: "full input" },
			outputJson: { stdout: "full output" },
		})) as never;
		await render({ narratorId: "n1", toolUseIds: ["t1"], tick: 0 });
		const withId = renders.at(-1);
		if (!withId) throw new Error("hook did not render");
		expect(withId.resolveFullToolInput("t1")).toEqual({ command: "full input" });

		// The card is no longer truncated → the shell stops asking for it.
		await render({ narratorId: "n1", toolUseIds: [], tick: 1 });
		const withoutId = renders.at(-1);
		if (!withoutId) throw new Error("hook did not re-render");
		expect(withoutId.resolveFullToolInput("t1")).toEqual({ command: "full input" });
		expect(withoutId.resolveFullToolOutput("t1")).toEqual({ stdout: "full output" });
	});

	test("forgets a payload once the narrator changes", async () => {
		narratorsApi.getToolCallDetail = (async () => ({ inputJson: { n: 1 } })) as never;
		await render({ narratorId: "n1", toolUseIds: ["t1"], tick: 0 });
		expect(renders.at(-1)?.resolveFullToolInput("t1")).toEqual({ n: 1 });

		await render({ narratorId: "n2", toolUseIds: [], tick: 1 });
		expect(renders.at(-1)?.resolveFullToolInput("t1")).toBeUndefined();
	});
});

describe("useVListToolDetails", () => {
	test("keeps resolver identity stable across re-renders that settle nothing", async () => {
		narratorsApi.getToolCallDetail = (async () => new Promise(() => {})) as never;
		await render({ narratorId: "n1", toolUseIds: ["t1"], tick: 0 });
		const first = renders.at(-1);
		if (!first) throw new Error("hook did not render");

		// Re-render for an unrelated reason (the shell does this on every scroll /
		// interaction change). Nothing settled, so the resolvers must be the SAME
		// functions — a new identity here is what looped the layout coordinator.
		await render({ narratorId: "n1", toolUseIds: ["t1"], tick: 1 });
		await render({ narratorId: "n1", toolUseIds: ["t1"], tick: 2 });
		const last = renders.at(-1);
		if (!last) throw new Error("hook did not re-render");

		expect(last.resolveFullToolInput).toBe(first.resolveFullToolInput);
		expect(last.resolveFullToolOutput).toBe(first.resolveFullToolOutput);
	});

	test("does not re-render itself in a loop while a fetch is pending", async () => {
		narratorsApi.getToolCallDetail = (async () => new Promise(() => {})) as never;
		await render({ narratorId: "n1", toolUseIds: ["t1"], tick: 0 });
		const settledRenderCount = renders.length;
		// Give React and the QueriesObserver room to notify. A self-sustaining
		// notify loop would keep pushing renders here.
		await settle();
		await settle();
		expect(renders.length).toBe(settledRenderCount);
	});

	test("swaps resolver identity once a payload settles and exposes the full body", async () => {
		narratorsApi.getToolCallDetail = (async () => ({
			inputJson: { command: "full input" },
			outputJson: { stdout: "full output" },
		})) as never;
		await render({ narratorId: "n1", toolUseIds: ["t1"], tick: 0 });
		const first = renders[0];
		const last = renders.at(-1);
		if (!first || !last) throw new Error("hook did not render");

		expect(last.resolveFullToolInput).not.toBe(first.resolveFullToolInput);
		expect(last.resolveFullToolInput("t1")).toEqual({ command: "full input" });
		expect(last.resolveFullToolOutput("t1")).toEqual({ stdout: "full output" });
		expect(last.resolveFullToolInput("unknown")).toBeUndefined();
		expect(last.resolveFullToolInput(undefined)).toBeUndefined();
	});
});
