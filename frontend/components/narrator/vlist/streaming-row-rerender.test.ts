/**
 * Shell wiring guards complement the real React cache tests in
 * ordinary-row-cache.test.tsx and useVListTraceBindings.test.tsx.
 * A per-item map is safe when unchanged bindings are reused; forbidding the map
 * itself masked the real problem (global index identity invalidating every row).
 * Keep the shell-to-binding wiring and ExactRow's invalidation checks protected.
 */

import { describe, expect, it } from "bun:test";
import { shellModule, shellSource } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";

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

/** Source of one hook body, from its declaration up to its dependency array. */
function hookBody(declaration: string): string {
	const start = SHELL.indexOf(declaration);
	expect(start).toBeGreaterThan(0);
	return SHELL.slice(start, depsRange(start).open);
}

describe("the trace row-interaction slot uses per-group semantic bindings", () => {
	it("feeds live indices into the tested binding hook", () => {
		expect(SHELL).toContain("const traceBindingsByKey = useVListTraceBindings({");
	});

	it("resolves the current group's binding by the complete item key", () => {
		expect(SHELL).toContain("const traceBinding = traceBindingsByKey.get(item.spec.key)");
		const rowProps = sliceBracketedRegion(SHELL, "const rowProps: ExactRowProps = {");
		expect(rowProps).toContain("rowInteraction: traceBinding?.rowInteraction");
	});

	it("does not give ordinary rows a global tool-action resolver", () => {
		const rowProps = sliceBracketedRegion(SHELL, "const rowProps: ExactRowProps = {");
		expect(rowProps).toContain("resolveRowToolActions: traceBinding?.resolveRowToolActions");
		expect(SHELL).not.toContain("resolveRowToolActions={resolveRowToolActions}");
		expect(rowProps).not.toMatch(/resolveRowToolActions:\s*resolveRowToolActions\b/);
		expect(rowProps).not.toMatch(/\n\s*resolveRowToolActions,\s*\n/);
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

describe("animation metadata crosses the real row memo", () => {
	it("invalidates on animation gates and epochs even when measured content is identical", async () => {
		const { ExactRow } = await import("./ExactRow");
		type Props = import("./ExactRow").ExactRowProps;
		const compare = (ExactRow as unknown as { compare: (previous: Props, next: Props) => boolean })
			.compare;
		const previous = {
			item: { spec: { key: "__streaming__-b0", kind: "markdown" }, measured: {} },
			animateStreaming: true,
			streamAnimMountEpoch: 1,
			streamAnimSnapshotEpoch: 2,
		} as unknown as Props;
		expect(compare(previous, { ...previous })).toBe(true);
		expect(compare(previous, { ...previous, animateStreaming: false })).toBe(false);
		expect(compare(previous, { ...previous, streamAnimMountEpoch: 3 })).toBe(false);
		expect(compare(previous, { ...previous, streamAnimSnapshotEpoch: 4 })).toBe(false);
	});

	it("the shell takes snapshot identity from the committed layout, not the next hook value", () => {
		expect(SHELL).toContain("pretextDocument.streamingMessage?._streamAnimSnapshotEpoch");
		expect(SHELL).not.toContain("streamingMsg?._streamAnimSnapshotEpoch");
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
