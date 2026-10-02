/**
 * vlist-drilldown-live-controls.test.ts — a DRILLED-IN trace row must carry the
 * same live controls the standalone card carries.
 *
 * The regression this locks down: at low LOD a tool call folds into a trace row, and
 * opening that row nests a REAL tool card through the `rowCard` slot. That slot was
 * handed only `labels` / `narratorId` / `onToggle` (+ the viewer wiring), so three
 * live controls the L3+ card gets were missing from the opened row:
 *
 *   - onTerminate         — the header's stop button for a running shell / MCP tool
 *   - onUpdateTimeout     — the timing area's timeout editor for a running call
 *   - onReflectionTakeOver— the take-over button on a RUNNING reflection gate
 *
 * This is not an edge case: running and streaming tools DO fold into a trace (see
 * render-units' `isKeptToolItem` — only a permission-blocked call keeps its card),
 * so "the reader opened a live row" is the normal path. And each failure is silent
 * in the worst way — the control still PAINTS (the render layer draws the header
 * either way for the timeout area) or silently vanishes, and the only way to get it
 * back was to change LOD.
 *
 * The take-over case has a second trap of its own: the element-level
 * `onReflectionTakeOver` prop is already resolved for the ROW's element, and a trace
 * element is not a `tool-call` kind — so `resolveReflectionTakeOver` returns
 * undefined for it. Reusing that prop would therefore always bind nothing; the
 * drill-down has to bind the CARD's own reflection, which is why the unresolved
 * resolver is passed down as well.
 *
 * Asserted against the shell source because the shell is not unit-mountable (it owns
 * a scroll container, a document coordinator and a WS subscription), matching
 * vlist-editing-wiring / vlist-swipe-anchor-wiring / vlist-fold-wiring.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellSource } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";

const DIR = import.meta.dir;
const SHELL = shellSource();
const MEASURE_NOTICE = readFileSync(join(DIR, "measure", "measure-reflection-notice.ts"), "utf8");
const RENDER_CARD = readFileSync(join(DIR, "render", "RenderToolCall.tsx"), "utf8");

/** The body of the shell's `rowCard` drill-down slot. */
function rowCardBody(): string {
	const start = SHELL.indexOf("extra.rowCard = (row: MeasuredTraceRow) => {");
	expect(start).toBeGreaterThan(0);
	const end = SHELL.indexOf('return renderElement("tool-call", card, cardExtra);', start);
	expect(end).toBeGreaterThan(start);
	return SHELL.slice(start, end);
}

describe("drilled-in card: live header controls", () => {
	it("binds onTerminate, gated on the CARD's own tool name", () => {
		// Gated like the standalone card (canTerminateTool): binding it unconditionally
		// would paint a stop button on tools that cannot be stopped.
		const body = rowCardBody();
		expect(body).toContain("cardExtra.onTerminate = onTerminate;");
		expect(body).toContain("canTerminateTool(card.toolName)");
	});

	it("binds onUpdateTimeout only for a running call that HAS a deadline", () => {
		// Same three-part gate the standalone card uses; a call with no timeout has
		// nothing to edit, and a finished one must not be extendable.
		const body = rowCardBody();
		expect(body).toContain("cardExtra.onUpdateTimeout = resolveUpdateTimeout(card.toolUseId);");
		expect(body).toContain("isRunningStatus(card.status)");
		expect(body).toContain("card.timeoutMs != null");
	});

	it("reads its gates from the nested CARD, never from the trace element", () => {
		// `item.measured` is the TRACE here, not a tool call — it carries no status /
		// timeoutMs / toolName at all, so gating on it would silently disable all three.
		const body = rowCardBody();
		expect(body).not.toContain("item.measured as MeasuredToolCall");
	});
});

describe("drilled-in card: reflection take-over", () => {
	it("binds the take-over from the CARD's own reflection", () => {
		const body = rowCardBody();
		expect(body).toContain("card.reflection?.hasTakeOver");
		expect(body).toContain("cardExtra.onReflectionTakeOver = getReflectionTakeOver(");
	});

	it("does NOT reuse the element-resolved onReflectionTakeOver prop", () => {
		// That prop comes from `resolveReflectionTakeOver(item, …)`, which returns
		// undefined for any non-`tool-call` kind — and a trace element is one. Reusing
		// it would bind nothing, forever, with no error.
		const body = rowCardBody();
		expect(body).not.toMatch(/cardExtra\.onReflectionTakeOver\s*=\s*onReflectionTakeOver/);
	});

	it("passes the UNRESOLVED resolver down to the row", () => {
		const rowProps = sliceBracketedRegion(SHELL, "const rowProps: ExactRowProps = {");
		expect(rowProps).toMatch(/\n\s*getReflectionTakeOver,\s*\n/);
	});

	it("keeps the new resolver in the ExactRow memo comparator", () => {
		// A prop the comparator ignores is pinned at its first value: after a narrator
		// switch the button would still paint and still call the OLD narrator's handler.
		expect(SHELL).toContain("prev.getReflectionTakeOver === next.getReflectionTakeOver");
	});

	it("requires a requestId before binding", () => {
		// The handler is keyed by requestId; binding without one would produce a button
		// that calls stopXReflection("").
		expect(rowCardBody()).toContain("card.reflection.requestId");
	});
});

describe("drilled-in card: the three controls are height-neutral", () => {
	it("the take-over button's row is RESERVED by the measure pass", () => {
		// This is what makes binding it safe at all: the notice measures a button row
		// exactly when `hasTakeOver` is set, so revealing the button cannot move the row
		// and the zero-DOM height prediction still holds.
		expect(MEASURE_NOTICE).toContain('makeFixed(NOTICE_BUTTON_HEIGHT, "take-over")');
		expect(MEASURE_NOTICE).toMatch(/const hasTakeOver = data\.hasTakeOver === true;/);
	});

	it("the terminate button lives inside the card's single header row", () => {
		// Rendered as an inline-flex glyph in the header Group (not a new row), so the
		// measured header height is unchanged whether or not the callback is supplied.
		expect(RENDER_CARD).toContain("{running && onTerminate ? (");
		expect(RENDER_CARD).toContain("<IconPlayerStop size={11} />");
	});

	it("the timeout editor is portaled out of the header", () => {
		// The editor is a popover: supplying onUpdateTimeout adds no in-flow box.
		expect(RENDER_CARD).toContain("onUpdateTimeout={onUpdateTimeout}");
		expect(RENDER_CARD).toMatch(/timeout editor are portaled/);
	});
});
