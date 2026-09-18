/**
 * streaming-row-rerender.test.ts — End-to-end guard: a streaming delta must not
 * change the props the ExactRow memo compares for rows it did not touch.
 *
 * ── Why this exists ALONGSIDE vlist-row-payload-reuse.test.ts ──────────────────
 *
 * That file proves the reuse primitive works. This one proves the SHELL is wired to
 * it, which is a separate fact and the one that actually regressed: the primitive
 * can be perfect while a builder keeps `renderItems` in the memo deps that mints its
 * objects, or while a new per-row prop is introduced with a fresh identity per frame.
 * Both failures are invisible in a rendering test — the rows look right, they just
 * re-render on every frame of a live turn and the folded row's CSS shimmer stutters
 * under the reconciliation.
 *
 * The assertions are on the SHELL SOURCE because the failure mode is silent and
 * has no runtime representation to observe without mounting the whole panel (which
 * needs a router, a query client, a WS manager and a narrator). What is pinned is
 * narrow and behavioural in intent:
 *
 *   1. `rowInteraction` comes from a resolver whose memo does NOT depend on
 *      `renderItems` — that dependency is exactly what made the slot churn.
 *   2. The `interaction` payload map goes through the reuse cache (begin + reuse +
 *      commit), so an untouched row keeps its object.
 *   3. The memo comparator still compares both props, i.e. the stability above is
 *      load-bearing rather than incidental.
 *
 * Sibling coverage, deliberately not duplicated here: `live-tail-crosses-row-memo`
 * proves the LIVE row still repaints (the tail must cross the memo), so this file
 * cannot be satisfied by freezing everything.
 */

import { describe, expect, it } from "bun:test";
import { shellModule, shellSource } from "./guard-source";

const SHELL = shellSource();

/**
 * Offset of a hook call's dependency array, given the offset of its declaration.
 *
 * Two body shapes occur and both must be handled, or the scan silently runs on into
 * the NEXT hook and asserts against its deps (which is how an earlier version of
 * this file reported `[editingRow, renderItems]` for a callback that has neither):
 *
 *   block body    → `\t}, [deps]`     (the common `useMemo(() => { … }, [x])`)
 *   concise body  → `\n\t\t[deps],`   (an arrow returning an expression directly)
 *
 * Whichever comes FIRST after the declaration is this hook's own.
 *
 * Both patterns are matched at ANY indentation depth. The concise-body pattern used
 * to be the literal `"\n\t\t["` — exactly two tabs — so re-indenting the shell made
 * it miss, the scan fell through to the next hook's `}, [`, and the guard reported
 * `[editingRow, renderItems]` for a callback that has neither. That is the very
 * failure this comment already warned about, reintroduced through the indentation.
 */
function depsRange(start: number): { open: number; close: number } {
	const rest = SHELL.slice(start);
	const candidates = [rest.indexOf("}, ["), rest.search(/\n\t+\[/)]
		.filter((at) => at > 0)
		.map((at) => start + at);
	expect(candidates.length).toBeGreaterThan(0);
	const at = Math.min(...candidates);
	const open = SHELL.indexOf("[", at);
	const close = SHELL.indexOf("]", open);
	expect(close).toBeGreaterThan(open);
	return { open, close };
}

/** The dependency array of the hook declared at `from`. */
function depsAfter(from: string): string {
	const start = SHELL.indexOf(from);
	expect(start).toBeGreaterThan(0);
	const { open, close } = depsRange(start);
	return SHELL.slice(open, close + 1);
}

/** Source of one hook body, from its declaration up to its dependency array. */
function hookBody(declaration: string): string {
	const start = SHELL.indexOf(declaration);
	expect(start).toBeGreaterThan(0);
	return SHELL.slice(start, depsRange(start).open);
}

describe("the trace row-interaction slot does not churn per frame", () => {
	it("is built by a memo that does NOT depend on renderItems", () => {
		// THE REGRESSION: this memo used to build a per-key MAP from `renderItems`,
		// which is a fresh array on every commit — so every mounted trace row got a
		// new `rowInteraction` prop on every streaming delta.
		const deps = depsAfter("const traceRowInteractionSlot = useMemo<");
		expect(deps).not.toContain("renderItems");
		// It legitimately depends on these (the closure captures them).
		expect(deps).toContain("selectionIndex");
		expect(deps).toContain("rowHandlers");
	});

	it("is resolved per row by KIND, allocating no per-frame map", () => {
		const body = hookBody("const resolveRowInteraction = useCallback(");
		expect(body).toContain("TRACE_ROW_INTERACTION_KINDS.has(item.spec.kind)");
		expect(body).toContain("traceRowInteractionSlot");
		// A resolver rebuilt from the items would reintroduce the churn.
		expect(depsAfter("const resolveRowInteraction = useCallback(")).not.toContain("renderItems");
	});

	it("is what the row actually receives", () => {
		// Guards against the resolver existing but the row still reading a stale map.
		expect(SHELL).toContain("rowInteraction={resolveRowInteraction(item)}");
		expect(SHELL).not.toContain("rowInteractionByKey");
	});
});

describe("the per-row interaction payload is reused when nothing changed", () => {
	it("runs the interaction map through the reuse cache", () => {
		const body = hookBody("const interactionsByKey = useMemo(");
		// All three phases must be present: a begin without a commit never reuses
		// anything, and a commit without a begin grows a cache nobody reads.
		expect(body).toContain("beginRowPayloadFrame(interactionReuseRef.current");
		expect(body).toContain("reuseRowPayload(previous, item.spec.key");
		expect(body).toContain("commitRowPayloadFrame(interactionReuseRef");
	});

	it("commits the cache on the EARLY RETURN too", () => {
		// The `!selectionIndex` bail returns before the loop. Without a commit there,
		// the cache would keep a generation from before the reset and the next frame
		// would compare against a map for a different document.
		const body = hookBody("const interactionsByKey = useMemo(");
		const bail = body.indexOf("if (!selectionIndex)");
		expect(bail).toBeGreaterThan(0);
		expect(body.slice(bail, bail + 220)).toContain("commitRowPayloadFrame");
	});

	it("compares content field-wise, never by closure identity", () => {
		// A plain function, not a hook: read from its own module and cut at its closing
		// brace rather than through `hookBody`, whose dependency-array scan would run on
		// into the next declaration and assert against unrelated code.
		const rowState = shellModule("vlist-exact-row-state.ts");
		const start = rowState.indexOf("export function sameRowInteraction(");
		expect(start).toBeGreaterThan(0);
		const comparator = rowState.slice(start, rowState.indexOf("\n}", start));
		// Every field the row paints or dispatches from.
		for (const field of ["blockId", "messageId", "blockIndex", "copyText", "toolUseId"]) {
			expect(comparator).toContain(field);
		}
		expect(comparator).toContain("sameNumberList(a.blockIndices, b.blockIndices)");
		expect(comparator).toContain("sameToolMeta(a.toolMeta, b.toolMeta)");
		// The action bundles are compared by WHICH keys are bound (a fresh closure
		// every frame would otherwise make every row a miss).
		expect(comparator).toContain("sameBoundActionKeys");
		// A payload compared by reference would defeat the whole cache.
		expect(comparator).not.toContain("a.actions === b.actions");
	});
});

describe("the stability above is load-bearing", () => {
	it("the memo comparator still compares both per-row payload props", () => {
		// If either term were dropped the churn would stop mattering — and so would
		// this file. Keeping them asserted means a future 'optimisation' that removes
		// a term has to face these tests rather than silently making them vacuous.
		expect(SHELL).toContain("prev.interaction === next.interaction");
		expect(SHELL).toContain("prev.rowInteraction === next.rowInteraction");
	});

	it("the LIVE row is still allowed through via the tail signature", () => {
		// The counterweight: reuse must never freeze the row that IS changing.
		expect(SHELL).toContain("liveTailSignature(item.spec.data)");
		expect(SHELL).toContain("prev.interactionSig === next.interactionSig");
	});
});
