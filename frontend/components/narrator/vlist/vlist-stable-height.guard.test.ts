/**
 * vlist-stable-height.guard.test.ts — Protects the exact list's core invariant:
 *
 *   A committed row's height must NEVER change unless the USER acted.
 *
 * Two features broke it and are fixed by the wiring this guard pins down:
 *
 *   1. TOOL DETAILS — cards that expand by themselves (`computeDefaultOpen` /
 *      LOD 6) were measured from a 2000-char preview, then re-measured taller once
 *      an async detail fetch resolved. Fix: the payloads are prefetched on the
 *      coordinator's async boundary, before the first build; only rows the USER
 *      expanded may still fetch on demand.
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

describe("stable-height invariant: auto-expanded tool details", () => {
	it("prefetches auto-expanded truncated payloads before the layout is built", () => {
		const src = read("pretext-layout-coordinator.ts");
		// The prefetch must be awaited on the SAME boundary as KaTeX, i.e. before
		// commitLayout runs — not in a later effect.
		expect(src).toContain("prepareToolDetails");
		expect(src).toContain("collectAutoExpandedTruncatedToolUses");
		// Both async paths (first screen + older pages) must resolve it.
		const tailAwait = src.indexOf("loadPretextDocumentTail");
		const olderAwait = src.indexOf("loadPretextDocumentOlder");
		expect(tailAwait).toBeGreaterThan(-1);
		expect(olderAwait).toBeGreaterThan(-1);
		expect(src.slice(tailAwait)).toContain("this.prepareToolDetails(");
		expect(src.slice(olderAwait)).toContain("this.prepareToolDetails(");
	});

	it("chains the prefetched payloads into every build", () => {
		const src = read("pretext-layout-coordinator.ts");
		// buildLayout must consult the prefetch store, else the fetched bodies would
		// never reach the measurement.
		expect(src).toContain("resolveFullToolInput: this.chainToolInput(");
		expect(src).toContain("resolveFullToolOutput: this.chainToolOutput(");
	});

	it("limits the shell's on-demand fetch to rows the user expanded", () => {
		const src = read("PretextExactMessageList.tsx");
		// Without this gate an auto-expanded card would ALSO be fetched here, which
		// rebuilds the document and grows the row after paint — the original bug.
		expect(src).toContain("isUserExpandedRow(activeInteraction, item.spec.key)");
	});

	it("treats both explicit-expansion channels as a user action", () => {
		const src = read("vlist-interaction-state.ts");
		const fn = src.slice(src.indexOf("export function isUserExpandedRow"));
		// `expanded` is the normal toggle; `lodUserOverrides` is force-open at an LOD
		// that otherwise collapses. Both are clicks.
		expect(fn).toContain("state.expanded.get(key) === true");
		expect(fn).toContain("state.lodUserOverrides.has(key)");
	});
});

describe("stable-height invariant: reflection notices", () => {
	it("measures the notice arithmetically instead of mounting the real component", () => {
		const measure = read("measure/measure-tool-call.ts");
		expect(measure).toContain("measureReflectionNotice(");
		// The measured region must contribute to the card's height.
		expect(measure).toContain("reflection.topMargin + reflection.height");
	});

	it("reserves the takeover row so a resolving gate cannot shrink the card", () => {
		const measure = read("measure/measure-tool-call.ts");
		// running → confirmed is a SERVER event; letting the button's row vanish
		// would shrink a committed row with no user action behind it.
		expect(measure).toContain("reserveTakeOver: true");
		const notice = read("measure/measure-reflection-notice.ts");
		expect(notice).toContain("hasTakeOver || opts.reserveTakeOver === true");
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
		expect(bridge).toContain('decision.kind !== "permission"');
	});
});
