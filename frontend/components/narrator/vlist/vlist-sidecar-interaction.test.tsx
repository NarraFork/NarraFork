/**
 * vlist-sidecar-interaction.test.tsx — a sidecar card must be FOLDABLE again, not
 * just expandable once.
 *
 * ── The bug this locks down ───────────────────────────────────────────────────
 *
 * The shell's fold toggle inverts "am I currently open?", and it read that state
 * exclusively from the MEASURED element:
 *
 *     measured?.form === "command"
 *       ? measured.expanded === true
 *       : (measured?.effectiveOpened ?? measured?.effectiveExpanded ??
 *          measured?.form === "expanded")
 *
 * Neither of the two sidecar fold paths can answer that expression:
 *
 *   (a) A tool card's MINI-CARDS fold under `${rowKey}-sc${index}`, which is not a
 *       top-level layout item — so `measuredByKeyRef` (populated from the render
 *       items' `spec.key`) never holds it. `measured` was `undefined`, the `??`
 *       chain collapsed to `false`, and every click wrote `expanded = true`.
 *
 *   (b) A STANDALONE sidecar element does have a measured entry, but `MeasuredSidecar`
 *       reports its fold on `expanded` and carries no `form` / `effectiveOpened` /
 *       `effectiveExpanded` — so the same expression returned `false` there too.
 *
 * Symptom for both: the card opens on the first click and then never closes.
 *
 * These tests drive the REAL loop (interaction state → adapter → measure) for two
 * clicks and assert the height comes back down, so a regression in either the state
 * resolution or the adapter's key scheme fails here. The four other toggleable kinds
 * are asserted alongside, because "make sidecars work" must not reinterpret their
 * fold reporting (`message-bubble`'s `form === "command"` special case in
 * particular).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	type AdapterSegment,
	adaptSegment,
	type SidecarSpecData,
} from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act, memo } from "react";
import { createRoot } from "react-dom/client";
import type { MeasuredSidecar } from "./measure/measure-sidecar";
import type { MeasuredToolCall } from "./measure/measure-tool-call";
import { installCanvasStub } from "./measure/test-canvas-stub";
import {
	resolveRowOpenState,
	resolveSidecarToggle,
	rowInteractionSig,
	rowSidecarCount,
	type SidecarToggleCache,
	sidecarFoldKey,
} from "./PretextExactMessageList";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import {
	createVListInteractionState,
	setVListExpanded,
	type VListInteractionState,
} from "./vlist-interaction-state";

const CONTENT_WIDTH = 700;
/** Long enough that expanding measurably grows the card. */
const BODY = "first injected line\nsecond injected line\nthird injected line";

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
	// linkedom ships no KeyboardEvent; the same minimal polyfill the ask-in-passing
	// interaction test uses (carries `key`, supports preventDefault — enough for
	// React's synthetic events).
	if (typeof g.KeyboardEvent !== "function") {
		const EventCtor = (win as unknown as { Event: typeof Event }).Event;
		g.KeyboardEvent = class KeyboardEvent extends (EventCtor as unknown as typeof Event) {
			key: string;
			constructor(type: string, init?: KeyboardEventInit & { bubbles?: boolean }) {
				super(type, { bubbles: init?.bubbles ?? true, cancelable: init?.cancelable ?? true });
				this.key = init?.key ?? "";
			}
		} as unknown as typeof KeyboardEvent;
	}
});

/** Dispatch a bubbling keydown, as a keyboard user's browser would. */
function pressKey(node: Element, key: string): void {
	const Ctor = (globalThis as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
	act(() => {
		node.dispatchEvent(new Ctor("keydown", { key, bubbles: true }));
	});
}

/**
 * The shell's fold click, reproduced end to end: resolve "am I open?" the way
 * `getRowToggles(key).onToggle` does, then write the inverse into the state.
 *
 * `measuredForKey` mirrors `measuredByKeyRef`: it returns the measured element for
 * TOP-LEVEL spec keys only, which is precisely why the `-sc{i}` sub-keys need the
 * interaction-state fallback.
 */
function clickFold(
	state: VListInteractionState,
	key: string,
	measuredForKey: (key: string) => unknown,
): VListInteractionState {
	const current = resolveRowOpenState(measuredForKey(key) as never, state, key);
	return setVListExpanded(state, key, !current);
}

// ── (b) standalone sidecar element ───────────────────────────────────────────

/** One assistant message carrying a single message-level sidecar. */
function messageWithSidecar(): AdapterSegment {
	return {
		kind: "message",
		msg: {
			id: "m1",
			role: "assistant",
			contentJson: [{ type: "text", text: "body" }],
			sideCars: [
				{ target: "user_message", source: "bg_agent", content: BODY, orderIndex: 0 },
				// A SECOND record, so the "expand only the second card" case below has one.
				{ target: "user_message", source: "spec_update", content: BODY, orderIndex: 1 },
				// biome-ignore lint/suspicious/noExplicitAny: structural sidecar mirror
			] as any,
		},
		visibleBlockIndices: [0],
	};
}

/** Adapt + measure the standalone sidecar cards at the current fold state. */
function buildStandalone(state: VListInteractionState) {
	const specs = adaptSegment(messageWithSidecar(), {
		lod: 5,
		isExpanded: (key) => state.expanded.get(key),
	}).filter((spec) => spec.kind === "sidecar");
	const measured = specs.map(
		(spec) =>
			VLIST_REGISTRY.sidecar.measure(spec.data, CONTENT_WIDTH, 5, spec.opts) as MeasuredSidecar,
	);
	const byKey = new Map(specs.map((spec, i) => [spec.key, measured[i] as unknown]));
	return { specs, measured, lookup: (key: string) => byKey.get(key) };
}

describe("standalone sidecar card — expand, then FOLD", () => {
	it("returns to the collapsed height on the second click", () => {
		let state = createVListInteractionState(5);
		const heights: number[] = [];
		let build = buildStandalone(state);
		const key = build.specs[0]?.key;
		if (!key) throw new Error("no sidecar spec");
		heights.push(build.measured[0]?.height ?? 0);

		state = clickFold(state, key, build.lookup);
		build = buildStandalone(state);
		heights.push(build.measured[0]?.height ?? 0);

		state = clickFold(state, key, build.lookup);
		build = buildStandalone(state);
		heights.push(build.measured[0]?.height ?? 0);

		// open, then closed again — NOT open, open, open.
		expect(heights[1]).toBeGreaterThan(heights[0] as number);
		expect(heights[2]).toBe(heights[0] as number);
		expect(build.measured[0]?.expanded).toBe(false);
		expect(state.expanded.get(key)).toBe(false);
	});

	it("folds each record independently (one card's toggle leaves the other alone)", () => {
		let state = createVListInteractionState(5);
		let build = buildStandalone(state);
		const first = build.specs[0]?.key;
		const second = build.specs[1]?.key;
		if (!first || !second) throw new Error("expected two sidecar specs");

		state = clickFold(state, second, build.lookup);
		build = buildStandalone(state);
		expect(build.measured[0]?.expanded).toBe(false);
		expect(build.measured[1]?.expanded).toBe(true);

		// And the second one folds back while the first stays untouched.
		state = clickFold(state, second, build.lookup);
		build = buildStandalone(state);
		expect(build.measured[0]?.expanded).toBe(false);
		expect(build.measured[1]?.expanded).toBe(false);
		expect(state.expanded.get(first)).toBeUndefined();
	});
});

// ── (a) a tool card's sidecar mini-cards ─────────────────────────────────────

/** One completed Bash call carrying two tool_result injections. */
function toolRunWithSidecars(): AdapterSegment {
	return {
		kind: "tool-run",
		sourceMessages: [],
		items: [
			{
				blockIndex: 0,
				isSubagent: false,
				tc: {
					toolUseId: "tu-bash",
					toolName: "Bash",
					status: "success",
					sideCars: [
						{ target: "tool_result", source: "bg_bash", content: BODY, orderIndex: 0 },
						{ target: "tool_result", source: "spec_update", content: BODY, orderIndex: 1 },
					],
				},
			},
		],
	};
}

function buildToolCard(state: VListInteractionState) {
	const spec = adaptSegment(toolRunWithSidecars(), {
		lod: 5,
		// The CARD itself must be open for its footnotes to exist at all: they are
		// footnotes to the tool's output, so a folded card (which shows no output) draws
		// none and reports them through `sidecarCount` instead. `?? true` opens it by
		// default while still letting the fold state answer for the `-sc{i}` sub-keys.
		isExpanded: (key) => (key === "tool-tu-bash" ? true : state.expanded.get(key)),
	})[0];
	if (!spec) throw new Error("no tool-call spec");
	const measured = VLIST_REGISTRY["tool-call"].measure(
		spec.data,
		CONTENT_WIDTH,
		5,
		spec.opts,
	) as MeasuredToolCall;
	if (!measured.effectiveOpened) throw new Error("expected an expanded tool card");
	// EXACTLY what measuredByKeyRef holds: top-level spec keys only. A `-sc{i}`
	// sub-key resolves to undefined here, which is the whole point.
	const lookup = (key: string) => (key === spec.key ? (measured as unknown) : undefined);
	return { spec, measured, lookup };
}

describe("tool-card sidecar mini-card — expand, then FOLD", () => {
	it("returns to the pre-expansion card height on the second click", () => {
		let state = createVListInteractionState(5);
		let build = buildToolCard(state);
		const subKey = sidecarFoldKey(build.spec.key, 0);
		const heights = [build.measured.height];

		state = clickFold(state, subKey, build.lookup);
		build = buildToolCard(state);
		heights.push(build.measured.height);
		expect(build.measured.sidecars?.[0]?.expanded).toBe(true);

		state = clickFold(state, subKey, build.lookup);
		build = buildToolCard(state);
		heights.push(build.measured.height);

		expect(heights[1]).toBeGreaterThan(heights[0] as number);
		expect(heights[2]).toBe(heights[0] as number);
		expect(build.measured.sidecars?.[0]?.expanded).toBe(false);
	});

	it("folds mini-cards independently, including when only the SECOND is opened", () => {
		// This is also the case the old `rowInteractionSig` probe loop missed: with
		// `-sc0` absent it broke at index 0 and never saw `-sc1`.
		let state = createVListInteractionState(5);
		let build = buildToolCard(state);
		const second = sidecarFoldKey(build.spec.key, 1);

		state = clickFold(state, second, build.lookup);
		build = buildToolCard(state);
		expect(build.measured.sidecars?.[0]?.expanded).toBe(false);
		expect(build.measured.sidecars?.[1]?.expanded).toBe(true);

		state = clickFold(state, second, build.lookup);
		build = buildToolCard(state);
		expect(build.measured.sidecars?.[1]?.expanded).toBe(false);
	});
});

// ── the other toggleable kinds keep their fold semantics ─────────────────────

describe("resolveRowOpenState — existing kinds are unchanged", () => {
	const state = createVListInteractionState(5);

	it("reads a tool card from effectiveOpened", () => {
		expect(resolveRowOpenState({ effectiveOpened: true } as never, state, "k")).toBe(true);
		expect(resolveRowOpenState({ effectiveOpened: false } as never, state, "k")).toBe(false);
	});

	it("reads a subagent card from effectiveExpanded", () => {
		expect(resolveRowOpenState({ effectiveExpanded: true } as never, state, "k")).toBe(true);
		expect(resolveRowOpenState({ effectiveExpanded: false } as never, state, "k")).toBe(false);
	});

	it("reads a reasoning run from its form", () => {
		expect(resolveRowOpenState({ form: "expanded" } as never, state, "k")).toBe(true);
		expect(resolveRowOpenState({ form: "collapsed" } as never, state, "k")).toBe(false);
		expect(resolveRowOpenState({ form: "count" } as never, state, "k")).toBe(false);
	});

	it("keeps the slash-command bubble special case (form 'command' + expanded)", () => {
		// The literal "command" must NOT be compared against "expanded", and the
		// bubble's own `expanded` flag is what decides.
		expect(resolveRowOpenState({ form: "command", expanded: true } as never, state, "k")).toBe(
			true,
		);
		expect(resolveRowOpenState({ form: "command", expanded: false } as never, state, "k")).toBe(
			false,
		);
	});

	it("prefers effectiveOpened over a stale `expanded` on the same object", () => {
		// A tool card carries both (`opts.opened` lands on `expanded` for the group
		// form); the LOD-resolved flag is the one the reader is looking at.
		expect(
			resolveRowOpenState({ effectiveOpened: false, expanded: true } as never, state, "k"),
		).toBe(false);
	});

	it("falls back to the interaction state ONLY when there is no measured element", () => {
		const opened = setVListExpanded(state, "row-sc0", true);
		expect(resolveRowOpenState(undefined, opened, "row-sc0")).toBe(true);
		expect(resolveRowOpenState(undefined, opened, "row-sc1")).toBe(false);
	});
});

// ── render → DOM: the header row is the fold affordance, and it is operable ──

function renderSidecarCard(
	measured: MeasuredSidecar,
	onToggle?: () => void,
): { container: Element; unmount: () => void } {
	const extra = resolveRenderExtra({
		kind: "sidecar",
		key: "sc",
		data: measured.payload as unknown as Record<string, unknown>,
	} as never);
	if (onToggle) extra.onToggle = onToggle;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>{renderElement("sidecar", measured, extra)}</MantineProvider>,
		);
	});
	return {
		container: container as unknown as Element,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

function measureFixture(over: Partial<SidecarSpecData> = {}, expanded = false): MeasuredSidecar {
	const data: SidecarSpecData = {
		payloadKind: "sidecar",
		source: "bg_agent",
		sourceLabel: "Background agent",
		tone: "background",
		// `folded` so the header owns a real fold: an `open` footnote whose body fits
		// declares no control at all (see the inert case below).
		form: "folded",
		headline: "preview line",
		lines: BODY.split("\n").map((text) => ({ kind: "text" as const, text })),
		fullText: BODY,
		isRaw: false,
		truncatedLabel: "[truncated]",
		showAllLabel: "Show all",
		...over,
	};
	return VLIST_REGISTRY.sidecar.measure(data, CONTENT_WIDTH, 5, {
		expanded,
	}) as MeasuredSidecar;
}

describe("RenderSidecar — the fold hot zone is keyboard-operable", () => {
	it("exposes the header as a button with its expanded state", () => {
		const card = renderSidecarCard(measureFixture(), () => {});
		const header = card.container.querySelector('[role="button"][aria-expanded]');
		expect(header).not.toBeNull();
		expect(header?.getAttribute("aria-expanded")).toBe("false");
		expect(header?.getAttribute("tabindex")).toBe("0");
		card.unmount();
	});

	it("reports aria-expanded=true once open", () => {
		const card = renderSidecarCard(measureFixture({}, true), () => {});
		expect(card.container.querySelector('[role="button"]')?.getAttribute("aria-expanded")).toBe(
			"true",
		);
		card.unmount();
	});

	it("declares NO control when the card is inert (no toggle injected)", () => {
		// A card the shell did not wire must not advertise a button that does nothing.
		const card = renderSidecarCard(measureFixture());
		expect(card.container.querySelector('[role="button"]')).toBeNull();
		card.unmount();
	});

	it("activates on click and on Enter / Space", () => {
		let clicks = 0;
		const card = renderSidecarCard(measureFixture(), () => clicks++);
		const header = card.container.querySelector('[role="button"]') as unknown as HTMLElement;
		act(() => header.click());
		expect(clicks).toBe(1);
		pressKey(header as unknown as Element, "Enter");
		pressKey(header as unknown as Element, " ");
		expect(clicks).toBe(3);
		card.unmount();
	});

	it("does NOT fold when the nested copy button handles the same keypress", () => {
		// The copy control is a real focusable <button> inside the header, so its
		// keydown bubbles up here. Without the target check, one Enter would both
		// copy and fold — a nested-interactive trap.
		let clicks = 0;
		const card = renderSidecarCard(measureFixture(), () => clicks++);
		const copy = card.container.querySelector("button");
		if (!copy) throw new Error("copy button not rendered");
		pressKey(copy, "Enter");
		expect(clicks).toBe(0);
		card.unmount();
	});
});

// ── the sidecar toggle prop must not defeat the row memo ─────────────────────

describe("resolveSidecarToggle — stable identity across rebuilds", () => {
	it("returns the SAME function for a row key on every subsequent render", () => {
		// This is what lets `onToggleSidecar` be a memo comparison term at all: an
		// unchanged row keeps the identity, so the comparator hits. A fresh arrow per
		// render (the previous inline JSX form) would re-render every mounted card on
		// every document rebuild.
		const cache: SidecarToggleCache = new Map();
		const noop = () => {};
		const first = resolveSidecarToggle(cache, "tool-tu1", noop);
		const second = resolveSidecarToggle(cache, "tool-tu1", noop);
		expect(second).toBe(first);
	});

	it("gives each row its own dispatcher", () => {
		const cache: SidecarToggleCache = new Map();
		const noop = () => {};
		expect(resolveSidecarToggle(cache, "tool-a", noop)).not.toBe(
			resolveSidecarToggle(cache, "tool-b", noop),
		);
	});

	it("addresses the adapter's `-sc{index}` fold key", () => {
		const cache: SidecarToggleCache = new Map();
		const seen: string[] = [];
		const toggle = resolveSidecarToggle(cache, "tool-tu1", (key) => seen.push(key));
		toggle(0);
		toggle(2);
		expect(seen).toEqual(["tool-tu1-sc0", "tool-tu1-sc2"]);
	});

	it("keeps an unchanged row out of a re-render when the prop is a memo term", () => {
		// The full property, through a memo shaped like the shell's: same item, same
		// signature, same dispatcher identity ⇒ no second render.
		const cache: SidecarToggleCache = new Map();
		const noop = () => {};
		let renders = 0;
		const Row = memo(
			function Row(_props: { item: unknown; onToggleSidecar: (index: number) => void }) {
				renders++;
				return null;
			},
			(prev, next) => prev.item === next.item && prev.onToggleSidecar === next.onToggleSidecar,
		);
		const item = { key: "tool-tu1" };
		const container = document.createElement("div");
		document.body.appendChild(container);
		const reactRoot = createRoot(container);
		const paint = () =>
			act(() => {
				reactRoot.render(
					<Row item={item} onToggleSidecar={resolveSidecarToggle(cache, "tool-tu1", noop)} />,
				);
			});
		paint();
		expect(renders).toBe(1);
		paint();
		expect(renders).toBe(1);
		act(() => reactRoot.unmount());
		container.remove();
	});
});

// ── the row signature must see EVERY sidecar fold, not just a leading run ─────

describe("rowInteractionSig — sidecar folds enter the signature by count", () => {
	const ROW = "tool-tu1";

	it("distinguishes 'second card open' from 'nothing open'", () => {
		// The old probe loop walked `-sc0, -sc1, …` and BROKE at the first missing
		// entry. Expanding only the second card leaves `-sc0` absent, so it stopped at
		// index 0 and `-sc1` never entered the signature — two visually different
		// states with identical signatures. It happened not to show because the memo's
		// `item.measured` term catches the height change; a signature that silently
		// omits state is still wrong, and depending on another term to cover it is how
		// the live-tail bug slipped through.
		const none = createVListInteractionState(5);
		const secondOpen = setVListExpanded(none, sidecarFoldKey(ROW, 1), true);
		expect(rowInteractionSig(secondOpen, ROW, 2)).not.toBe(rowInteractionSig(none, ROW, 2));
	});

	it("distinguishes which card is open, and open from explicitly-closed", () => {
		const base = createVListInteractionState(5);
		const firstOpen = setVListExpanded(base, sidecarFoldKey(ROW, 0), true);
		const secondOpen = setVListExpanded(base, sidecarFoldKey(ROW, 1), true);
		expect(rowInteractionSig(firstOpen, ROW, 2)).not.toBe(rowInteractionSig(secondOpen, ROW, 2));
		const firstClosed = setVListExpanded(base, sidecarFoldKey(ROW, 0), false);
		expect(rowInteractionSig(firstClosed, ROW, 2)).not.toBe(rowInteractionSig(firstOpen, ROW, 2));
	});

	it("is bounded by the row's OWN card count (a neighbour's folds cannot leak in)", () => {
		const base = createVListInteractionState(5);
		// A fold key belonging to a card index this row does not have.
		const beyond = setVListExpanded(base, sidecarFoldKey(ROW, 5), true);
		expect(rowInteractionSig(beyond, ROW, 2)).toBe(rowInteractionSig(base, ROW, 2));
	});

	it("costs nothing for a row with no sidecars", () => {
		const base = createVListInteractionState(5);
		const withOther = setVListExpanded(base, sidecarFoldKey(ROW, 0), true);
		expect(rowInteractionSig(withOther, ROW, 0)).toBe(rowInteractionSig(base, ROW, 0));
	});
});

describe("rowSidecarCount — only tool cards host mini-cards", () => {
	it("reads the count off the measured tool card", () => {
		const build = buildToolCard(createVListInteractionState(5));
		expect(rowSidecarCount({ spec: build.spec, measured: build.measured } as never)).toBe(2);
	});

	it("reports zero for a tool card without sidecars", () => {
		const spec = adaptSegment(
			{
				kind: "tool-run",
				sourceMessages: [],
				items: [
					{
						blockIndex: 0,
						isSubagent: false,
						tc: { toolUseId: "tu-plain", toolName: "Read", status: "success" },
					},
				],
			},
			{ lod: 5 },
		)[0];
		if (!spec) throw new Error("no spec");
		const measured = VLIST_REGISTRY["tool-call"].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
		expect(rowSidecarCount({ spec, measured } as never)).toBe(0);
	});

	it("reports zero for a STANDALONE sidecar row (its fold is its own spec key)", () => {
		const build = buildStandalone(createVListInteractionState(5));
		const spec = build.specs[0];
		if (!spec) throw new Error("no spec");
		expect(rowSidecarCount({ spec, measured: build.measured[0] } as never)).toBe(0);
	});
});
