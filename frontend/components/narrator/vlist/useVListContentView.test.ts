/**
 * useVListContentView.test.ts — the fullscreen viewer's two data-reaching paths.
 *
 * The exact vlist paints truncated tool payloads as a server-side PREFIX plus a
 * one-line notice. That left the fullscreen viewer showing the same prefix: a
 * reader who right-clicked → fullscreen (the obvious "show me all of it" gesture)
 * got the cut body with a footnote and no way forward.
 *
 * Two behaviours close that, both pinned here:
 *
 *   1. `openFullscreen` on a `truncated` target ALSO asks the shell to fetch the
 *      full payload — the same grow-only channel the notice line drives.
 *   2. `refreshOpenTarget` swaps the modal's snapshot for a newly derived target
 *      with the same id, so the body updates in place when those bytes land.
 *
 * Both are pure state transitions, so the hook is exercised through a mounted
 * harness with the user-preferences query stubbed (its only external dependency).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSourceText } from "@shared/pretext-layout/source-text";
import type { ToolCappedDetail } from "@shared/pretext-layout/tool-detail";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type UseVListContentViewResult, useVListContentView } from "./useVListContentView";
import type { VListViewOwner, VListViewTarget } from "./vlist-content-view-target";

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
	"matchMedia",
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
		// Mantine's useMediaQuery (reached through useUserPreferences' consumers)
		// needs this to exist; the viewer's defaults do not depend on the result.
		matchMedia: () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		}),
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

let restoreDom: (() => void) | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let renders: UseVListContentViewResult[] = [];
let requested: VListViewOwner[] = [];

function Harness() {
	renders.push(
		useVListContentView({
			requestFullPayload: (specKey) => {
				requested.push(specKey);
			},
		}),
	);
	return null;
}

async function mount() {
	if (!queryClient || !root) throw new Error("harness is not initialized");
	root.render(
		createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, {})),
	);
	await settle();
}

/** The most recent hook result. */
function latest(): UseVListContentViewResult {
	const last = renders.at(-1);
	if (!last) throw new Error("hook never rendered");
	return last;
}

function target(overrides: Partial<VListViewTarget> = {}): VListViewTarget {
	return {
		id: "call-1/output.main",
		slot: "output.main",
		owner: { specKey: "tool-tu_1" },
		kind: "term",
		text: "prefix only",
		...overrides,
	};
}

beforeEach(() => {
	restoreDom = installDom();
	renders = [];
	requested = [];
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// The hook's only network dependency; seeded so it never fetches.
	queryClient.setQueryData(["user-preferences"], {});
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
	restoreDom?.();
	restoreDom = null;
});

describe("openFullscreen requests a truncated body's full payload", () => {
	test("a prefix body asks the shell for its bytes, keyed by the row's spec key", async () => {
		await mount();
		latest().controls.openFullscreen(target({ truncated: true }));
		await settle();
		// The spec key half of `${specKey}:${slot}` — what the shell's
		// per-key `markVListFullPayloadRequested` handler is cached under.
		expect(requested).toEqual([{ specKey: "tool-tu_1" }]);
		expect(latest().openTarget?.id).toBe("call-1/output.main");
	});

	test("a COMPLETE body fetches nothing (there is nothing left to load)", async () => {
		await mount();
		latest().controls.openFullscreen(target());
		await settle();
		expect(requested).toEqual([]);
		expect(latest().openTarget?.id).toBe("call-1/output.main");
	});

	test("closing and reopening re-requests, which is safe (the channel is grow-only)", async () => {
		await mount();
		latest().controls.openFullscreen(target({ truncated: true }));
		await settle();
		latest().close();
		await settle();
		expect(latest().openTarget).toBeNull();
		latest().controls.openFullscreen(target({ truncated: true }));
		await settle();
		expect(requested).toEqual([{ specKey: "tool-tu_1" }, { specKey: "tool-tu_1" }]);
	});
});

describe("refreshOpenTarget follows the data into the open modal", () => {
	test("replaces the snapshot when the same body arrives complete", async () => {
		await mount();
		latest().controls.openFullscreen(target({ truncated: true }));
		await settle();
		expect(latest().openTarget?.text).toBe("prefix only");

		latest().refreshOpenTarget(target({ text: "the whole payload" }));
		await settle();
		expect(latest().openTarget?.text).toBe("the whole payload");
		expect(latest().openTarget?.truncated).toBeUndefined();
	});

	test("ignores an unchanged body, so it is safe to call from an effect", async () => {
		await mount();
		latest().controls.openFullscreen(target());
		await settle();
		const before = latest().openTarget;

		// Repeated calls with an equal body must all bail. Identity preservation is
		// the load-bearing part: the shell re-derives targets on every document
		// rebuild and hands the result back from an effect, so a new object each
		// time would keep the modal's props churning.
		for (let i = 0; i < 3; i++) {
			latest().refreshOpenTarget(target());
			await settle();
			expect(latest().openTarget).toBe(before);
		}
	});

	test("ignores a target belonging to a DIFFERENT body", async () => {
		await mount();
		latest().controls.openFullscreen(target());
		await settle();
		latest().refreshOpenTarget(target({ id: "tool-tu_2:s1", text: "other row" }));
		await settle();
		expect(latest().openTarget?.id).toBe("call-1/output.main");
		expect(latest().openTarget?.text).toBe("prefix only");
	});

	test("refreshes same-text lifecycle, revision and range changes", async () => {
		await mount();
		const model: ToolCappedDetail = {
			kind: "capped",
			id: "call-1/output.main",
			source: "output.main",
			cap: "term",
			format: "text",
			live: true,
			followTarget: { kind: "end" },
			text: "prefix only",
			revision: 1,
		};
		latest().controls.openFullscreen(target({ model }));
		await settle();
		const settled = { ...model, live: false };
		latest().refreshOpenTarget(target({ model: settled }));
		await settle();
		expect(latest().openTarget?.model?.live).toBe(false);
		const moved = {
			...settled,
			revision: 2,
			range: createSourceText("prefix only", { epoch: "next" }).range,
		};
		latest().refreshOpenTarget(target({ model: moved }));
		await settle();
		expect(latest().openTarget?.model?.revision).toBe(2);
		expect(latest().openTarget?.model?.range?.epoch).toBe("next");
	});

	test("scopes toggles and payload lookup by the explicit trace owner", async () => {
		await mount();
		const traced = target({
			owner: { specKey: "folded-trace", traceItemIndex: 9 },
			truncated: true,
		});
		latest().controls.toggleWrap(traced);
		latest().controls.openFullscreen(traced);
		await settle();
		expect(requested).toEqual([{ specKey: "folded-trace", traceItemIndex: 9 }]);
		expect(latest().rowSig("folded-trace")).toContain(traced.id);
		expect(latest().rowSig("tool-tu_1")).toBe("");
	});

	test("does nothing while no modal is open", async () => {
		await mount();
		latest().refreshOpenTarget(target({ text: "full" }));
		await settle();
		expect(latest().openTarget).toBeNull();
	});
});
