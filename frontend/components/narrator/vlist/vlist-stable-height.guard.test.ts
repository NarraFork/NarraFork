/**
 * vlist-stable-height.guard.test.ts — Protects the exact list's core invariant:
 *
 *   A committed row's height must NEVER change unless the USER acted.
 *
 * Two features broke it and are fixed by the wiring this guard pins down:
 *
 *   1. TOOL DETAILS — cards that expand by themselves (`computeDefaultOpen` /
 *      LOD 6) were measured from a truncated preview, then re-measured taller once
 *      an async detail fetch resolved. Fix (two parts): a truncated body reserves
 *      its FULL cap, so its first painted height is already final; and the fetch is
 *      gated on an explicit "load full content" request rather than on expansion.
 *   2. REFLECTION NOTICES — the real `ReflectionNotice` was mounted and measured
 *      after paint (ResizeObserver → heightOverrides), so a row settled a frame
 *      late and shifted everything below it. Fix: the notice is measured
 *      arithmetically and rendered as a zero-DOM copy; reflection rows no longer
 *      enter the dynamic-height path at all.
 *
 * These are source-level assertions on purpose: the failure mode is a silent
 * re-introduction of a post-paint height correction, which no unit test on the
 * pure functions would notice.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VLIST_DIR = import.meta.dir;

function read(relativePath: string): string {
	return readFileSync(join(VLIST_DIR, relativePath), "utf8");
}

describe("stable-height invariant: truncated tool payloads", () => {
	it("reserves the FULL cap for a truncated body so the first height is final", () => {
		const measure = read("measure/measure-tool-call.ts");
		const fn = measure.slice(
			measure.indexOf("function cappedBodyHeight("),
			measure.indexOf("function finishRegion("),
		);
		expect(fn.length).toBeGreaterThan(0);
		// This is what makes the build-time payload prefetch unnecessary: measuring
		// the PREFIX would tie the height to how many chars the server's budget
		// happened to include, so a later full payload (or a different width) would
		// resize a committed row.
		expect(fn).toContain("textTruncated === true");
		expect(fn).toContain("? cap");
	});

	it("has no build-time payload prefetch left to resize rows behind the reader", () => {
		const src = read("pretext-layout-coordinator.ts");
		expect(src).not.toContain("prepareToolDetails");
		expect(src).not.toContain("collectAutoExpandedTruncatedToolUses");
		expect(src).not.toContain("PretextToolDetailPrefetchStore");
	});

	it("fetches the full payload ONLY on an explicit user request", () => {
		const src = read("PretextExactMessageList.tsx");
		const block = src.slice(
			src.indexOf("const truncatedExpandedToolUseIds = useMemo("),
			src.indexOf("const reflectionIndex = useMemo("),
		);
		expect(block.length).toBeGreaterThan(0);
		expect(block).toContain("isFullPayloadRequestedRow(activeInteraction, item.spec.key)");
		// Expansion must NOT trigger a fetch: opening a card shows the already
		// measured preview, and growing that row without a click is the original bug.
		expect(block).not.toContain("expanded.get(");
		expect(block).not.toContain("lodUserOverrides");
	});

	it("keeps the full-payload request as its OWN interaction channel", () => {
		const src = read("vlist-interaction-state.ts");
		// A separate set is the whole point: reusing `expanded` would re-couple
		// "show the body" with "fetch the bytes".
		expect(src).toContain("fullPayloadRequested: ReadonlySet<string>");
		const reset = src.slice(src.indexOf("export function resetVListInteractionStateForLod"));
		// A content preference, so it survives an LOD change like `expanded` does —
		// otherwise the same payload would be re-requested after every zoom step.
		expect(reset).toContain("fullPayloadRequested: state.fullPayloadRequested");
	});

	it("a DRILLED-IN trace row fetches on the same explicit-request gate", () => {
		const src = read("PretextExactMessageList.tsx");
		const block = src.slice(
			src.indexOf("const truncatedExpandedToolUseIds = useMemo("),
			src.indexOf("const reflectionIndex = useMemo("),
		);
		// A nested card reaches the same truncated payloads a standalone card does, so
		// it must not bypass the gate: merely drilling into a row shows the (already
		// measured, cap-reserved) preview, and only a click on the notice / fullscreen
		// asks for the bytes.
		expect(block).toContain("isFullPayloadRequestedRow(activeInteraction, rowKey)");
		// Per-ROW scope: several rows of one trace can be open, each with its own
		// request — a trace-level key would make one row's click fetch its siblings.
		expect(block).toContain("ownerRequestKey(rowOwner)");
		expect(block).toContain("traceItemIndex: row.itemIndex");
	});

	it("a truncated body inside a drilled-in card still reserves its full cap", () => {
		// The card is measured through the very same `measureToolCall` a standalone
		// card uses, so the `textTruncated → cap` reservation applies unchanged. Pinned
		// by source: a bespoke measure path here would silently reintroduce the resize.
		const measure = read("measure/measure-tool-run.ts");
		expect(measure).toContain("measureToolCall(");
		expect(measure).not.toContain("measureToolDetail(");
	});
});

describe("stable-height invariant: reflection notices", () => {
	it("measures the notice arithmetically instead of mounting the real component", () => {
		const measure = read("measure/measure-tool-call.ts");
		expect(measure).toContain("measureReflectionNotice(");
		// The measured region must contribute to the card's height.
		expect(measure).toContain("reflection.topMargin + reflection.height");
	});

	it("measures the takeover row only when it PAINTS (no reserved blank strip)", () => {
		const notice = read("measure/measure-reflection-notice.ts");
		// The row used to be reserved at the RUNNING maximum so a resolving gate
		// could not shrink the card. That traded one anchored resize for ~40px of
		// blank canvas under EVERY resolved notice, including historical ones that
		// never had a button. running → confirmed now shrinks the card and rides the
		// anchored live-patch rebuild, exactly like a completing tool card.
		expect(notice).not.toContain("reserveTakeOver");
		expect(notice).toContain("if (hasTakeOver) {");
		const measure = read("measure/measure-tool-call.ts");
		expect(measure).not.toContain("reserveTakeOver");
		// The height-affecting flag must key the measure cache, or a resolved gate
		// would be served the running geometry from the previous status.
		expect(read("measure-cache.ts")).toContain("r.hasTakeOver === true");
	});

	it("renders the notice through the zero-DOM copy, not the bridged component", () => {
		const render = read("render/RenderToolCall.tsx");
		expect(render).toContain("RenderReflectionNotice");
		const bridge = read("vlist-permission-bridge.tsx");
		// The bridge must no longer construct a ReflectionNotice at all.
		expect(bridge).not.toContain("<ReflectionNotice");
		expect(bridge).not.toContain("reflectionToolCallData(");
	});

	it("keeps reflection rows out of the dynamic-height (ResizeObserver) path", () => {
		const src = read("PretextExactMessageList.tsx");
		const block = src.slice(
			src.indexOf("const dynamicRowKeys = useMemo("),
			src.indexOf("const effectiveHeightOverrides"),
		);
		expect(block.length).toBeGreaterThan(0);
		// Only a live permission FORM and the inline editor may be dynamic. A
		// reflection row reaching this set would restore the post-paint correction.
		expect(block).toContain("permissionSlotByKey.has(item.spec.key)");
		expect(block).toContain("editingRow");
		expect(block).not.toContain("reflection");
	});

	it("only mounts a permission form when a request is actually pending", () => {
		const bridge = read("vlist-permission-bridge.tsx");
		// A row whose permission area is owned by the measured notice must not also
		// mount a form (that would double the region AND make the row dynamic).
		const reflectionGuard = bridge.indexOf('if (decision.kind === "reflection") continue;');
		const permissionGuard = bridge.indexOf(
			'if (decision.kind === "permission" && decision.pending)',
		);
		expect(reflectionGuard).toBeGreaterThanOrEqual(0);
		expect(permissionGuard).toBeGreaterThan(reflectionGuard);
	});
});

/**
 * The live-patch channel is the one place where a SERVER event legitimately
 * resizes a committed row: a tool going running → success grows its card. The
 * invariant is therefore not "heights never change" but "the viewport never jumps
 * when they do" — the patch commit must capture the scroll anchor and restore
 * scrollTop, exactly as the LOD-rebuild path does.
 */
describe("stable-height invariant: live lifecycle patches", () => {
	it("anchors the patch commit so a resized card cannot move the viewport", () => {
		const src = read("pretext-layout-coordinator.ts");
		const fn = src.slice(src.indexOf("applyLivePatch("));
		expect(fn.length).toBeGreaterThan(0);
		expect(fn).toContain("captureCoordinatorAnchor(");
		// The anchor must be restored through the same commit path that the rebuild
		// uses, so the correction reaches the shell's scroll write.
		expect(src).toMatch(
			/restorePretextLayoutAnchor\(\s*anchor,\s*indexWithHeightOverrides\(built\.index, restoreOverrides\),\s*viewportHeight,?\s*\)/,
		);
	});

	it("reads the LIVE scroll view at patch time, not a stale render-time copy", () => {
		// A scroll in flight when the event lands would otherwise desync the captured
		// anchor from the applied correction.
		const hook = read("usePretextDocument.ts");
		const fn = hook.slice(hook.indexOf("const applyLivePatch = useCallback"));
		expect(fn).toContain("resolvePretextDocumentView(viewRef.current, options.getCurrentView)");
	});

	it("keeps the patch out of the dynamic (post-paint measured) row path", () => {
		// Patched rows must re-measure ARITHMETICALLY. Routing them through
		// heightOverrides would reintroduce a post-paint correction for an event the
		// user did not trigger.
		const src = read("PretextExactMessageList.tsx");
		const block = src.slice(
			src.indexOf("const dynamicRowKeys = useMemo("),
			src.indexOf("const effectiveHeightOverrides"),
		);
		expect(block.length).toBeGreaterThan(0);
		expect(block).not.toContain("LivePatch");
		expect(block).not.toContain("toolUseId");
	});

	it("leaves the document version untouched so untouched rows keep cached heights", () => {
		// Bumping the version would invalidate every cached measurement and re-measure
		// the whole window on each tool event.
		const src = read("pretext-layout-coordinator.ts");
		const fn = src.slice(src.indexOf("applyLivePatch("), src.indexOf("cancel(): void"));
		expect(fn).not.toContain("messageVersion:");
	});
});
