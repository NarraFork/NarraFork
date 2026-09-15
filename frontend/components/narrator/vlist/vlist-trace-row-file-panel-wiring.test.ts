/**
 * vlist-trace-row-file-panel-wiring.test.ts — the folded trace row must offer the
 * same "open in panel" item its EXPANDED card offers.
 *
 * The regression this locks down: at low LOD a tool call folds into a trace row,
 * and the vlist shell dropped `onOpenFilePanel` in TWO independent places —
 * `resolveTraceRowIdentity` omitted `isFileTool` from the row's tool facts, and the
 * row-interaction slot never forwarded the handler. Either one alone is enough to
 * hide the item, and both fail SILENTLY: the row still gets a working menu, just a
 * shorter one than the card at a higher LOD. TraceRowInteraction's own DOM tests
 * cannot see this — they hand the component a hand-built identity, which is exactly
 * the step that was losing the data.
 *
 * Asserted against the shell source because the shell is not unit-mountable (it
 * owns a scroll container, a document coordinator and a WS subscription), matching
 * vlist-editing-wiring / vlist-swipe-anchor-wiring.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const SHELL = readFileSync(join(DIR, "PretextExactMessageList.tsx"), "utf8");
const TRACE_ROW = readFileSync(join(DIR, "..", "trace", "TraceRowInteraction.tsx"), "utf8");
const TOOL_META = readFileSync(join(DIR, "vlist-tool-meta.ts"), "utf8");

/** The body of the shell's `resolveTraceRowIdentity`. */
function resolveIdentityBody(): string {
	const start = SHELL.indexOf("function resolveTraceRowIdentity(");
	expect(start).toBeGreaterThan(0);
	const end = SHELL.indexOf("\n}", start);
	expect(end).toBeGreaterThan(start);
	return SHELL.slice(start, end);
}

/** The body of the shell's shared trace-row interaction slot. */
function rowInteractionSlotBody(): string {
	const start = SHELL.indexOf("const traceRowInteractionSlot = useMemo<");
	expect(start).toBeGreaterThan(0);
	const end = SHELL.indexOf("}, [selectionIndex, rowHandlers", start);
	expect(end).toBeGreaterThan(start);
	return SHELL.slice(start, end);
}

describe("folded trace row: file-panel identity", () => {
	it("carries isFileTool into the row identity", () => {
		// `filePath` does NOT imply it: copy-path and view-file gate on the path, but
		// "open in panel" gates on isFileTool, so omitting it hides only that item.
		expect(resolveIdentityBody()).toContain("isFileTool");
	});

	it("derives isFileTool for every file tool, not just Read", () => {
		// The panel shows current on-disk content, so a Write/Edit is as valid an
		// entry point as a Read. Narrowing this to isReadTool would silently drop the
		// item for the two tools the user is most likely to inspect after a change.
		expect(TOOL_META).toContain("meta.isFileTool = true;");
		expect(TOOL_META).toMatch(/if \(toolName === "Read"\) meta\.isReadTool = true;/);
	});
});

describe("folded trace row: file-panel handler wiring", () => {
	it("forwards onOpenFilePanel to TraceRowInteraction", () => {
		expect(rowInteractionSlotBody()).toContain("onOpenFilePanel={handlers.onOpenFilePanel}");
	});

	it("forwards every row-level tool handler the row can render", () => {
		// One shared slot serves all trace rows, so a handler missing here is missing
		// for the whole document.
		const slot = rowInteractionSlotBody();
		for (const handler of [
			"onViewSubagentSession",
			"onDetachSubagent",
			"onCancelBackgroundTask",
			"onOpenFilePanel",
		]) {
			expect(slot).toContain(`${handler}={handlers.${handler}}`);
		}
	});

	it("allows edit navigation or a file tool with a path and panel handler", () => {
		// An exact Edit preview owns its own opener. The current-file fallback still
		// requires all three facts: neither a path nor a handler alone is sufficient.
		const condition = TRACE_ROW.match(/const canOpenFilePanel\s*=\s*([^;]+);/)?.[1];
		expect(condition?.replace(/\s+/g, " ").trim()).toBe(
			"!!editNavigation.open || !!(filePath && tool?.isFileTool && onOpenFilePanel)",
		);
		expect(TRACE_ROW).toContain("if (editNavigation.open) editNavigation.open();");
		expect(TRACE_ROW).toContain("else if (filePath) onOpenFilePanel?.(filePath);");
	});
});
