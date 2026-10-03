/**
 * vlist-editing-wiring.test.ts — source-level assertions for the inline message
 * editing wiring in the exact shell.
 *
 * The shell itself is not unit-mountable (it owns a scroll container, a document
 * coordinator and a WS subscription), so the load-bearing invariants of the
 * editing path are asserted against its source, in the same spirit as the
 * existing guard tests:
 *
 *  1. the editing row is a DYNAMIC row → it takes part in the post-paint height
 *     override, otherwise the editor would be clipped to the arithmetic height;
 *  2. the editing row is PINNED into the mounted window → scrolling away must not
 *     unmount it (that would destroy the draft);
 *  3. the editor and the original-content modal are LAZY (a read-only session
 *     never loads them) and the modal is a SINGLE shell-level instance;
 *  4. the editor REPLACES the row body (no menu / selection surface while
 *     editing, matching the chunked path).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellSource } from "./guard-source";

const SHELL = shellSource();
const ROW_INTERACTION = readFileSync(join(import.meta.dir, "VListRowInteraction.tsx"), "utf8");

describe("vlist inline editing wiring", () => {
	it("treats the editing row as dynamic so its real height overrides the arithmetic one", () => {
		// dynamicRowKeys gates which keys may hold a height override.
		expect(SHELL).toMatch(/if \(editingRow\) keys\.add\(editingRow\.key\)/);
		// The row must receive a height reporter when it hosts the editor. That is now
		// derived from the SAME set, rather than a parallel disjunction of slots: the
		// set decides which keys may hold an override and the row decides which rows
		// report one, so any divergence left a row either clipped with no way to
		// report or reporting into a set that pruned it away.
		expect(SHELL).toMatch(/const isDynamicRow = dynamicRowKeys\.has\(item\.spec\.key\)/);
		expect(SHELL).toMatch(
			/isDynamicRow\s*\? getUnknownHeightReporter\(item\.spec\.key, item\.contentWidth \?\? contentWidth\)\s*: undefined/,
		);
	});

	it("pins the editing row into the mounted window", () => {
		expect(SHELL).toContain("resolvePinnedRowIndices(visible, editingRowIndex)");
	});

	it("loads the editor and the original-content modal lazily", () => {
		expect(SHELL).toMatch(/const MessageEditorPanel = lazy\(\(\) =>\s*\n?\s*import\("\.\.\//);
		expect(SHELL).toMatch(/const OriginalContentModal = lazy\(\(\) =>\s*\n?\s*import\("\.\.\//);
		// The pure text helper may be imported statically (it carries no component
		// graph); the editor component itself must NOT be.
		expect(SHELL).toContain('from "../message/message-edit-text"');
		expect(SHELL).not.toMatch(/^import \{[^}]*MessageEditorPanel[^}]*\} from/m);
	});

	it("mounts exactly one original-content modal, at shell level", () => {
		const opens = SHELL.match(/<OriginalContentModal/g) ?? [];
		expect(opens).toHaveLength(1);
		// Only while a target message is selected.
		expect(SHELL).toMatch(/originalModalEdited && originalModalMessageId \?/);
		// The row layer only calls back; it never renders the modal itself.
		expect(ROW_INTERACTION).not.toContain("OriginalContentModal");
		expect(ROW_INTERACTION).not.toContain("MessageOriginalContent");
	});

	it("replaces the row body while editing (no context menu / selection surface)", () => {
		// `editorBody` is the editor slot after the right-alignment wrapper below; it
		// stays nullish when no editor is mounted, so a read-only row still renders
		// its measured element.
		expect(SHELL).toContain("const body = editorBody ?? renderElement(kind, item.measured, extra)");
		expect(SHELL).toMatch(/interaction && editorSlot === undefined \?/);
	});

	it("keeps a user bubble's editor on the right at the bubble's width", () => {
		// The bubble is drawn right-aligned and shrink-wrapped. A full-column editor
		// threw the caret / attach / submit controls to the far left of the row the
		// moment editing started, so the slot is wrapped in the same flex-end column
		// at the width resolveVListEditorWidth decides (null → unchanged full width,
		// which is what assistant rows get).
		expect(SHELL).toContain(
			"resolveVListEditorWidth(kind, extra.role, item.measured.usedWidth, contentWidth)",
		);
		expect(SHELL).toMatch(
			/editorSlot != null && editorWidth != null \?[\s\S]{0,200}?justifyContent: "flex-end"/,
		);
		expect(SHELL).toMatch(/width: editorWidth, maxWidth: "100%"/);
	});

	it("routes the row menu's edit item through the shell's own editor state", () => {
		// The shell injects onEditMessage (opening its editor) rather than calling
		// the API directly, and only for rows resolveVListEditTarget accepted.
		expect(SHELL).toContain("onEditMessage: (id) => openEditor(specKey, id, editTarget.role)");
		expect(SHELL).toMatch(/editable: !!editTarget/);
	});

	it("refuses to open the editor for a message too large to edit safely", () => {
		expect(SHELL).toContain("resolveEditorInitialText");
		expect(SHELL).toContain('t("editMessageTooLarge")');
	});

	it("drops the editing row when its message leaves the document", () => {
		expect(SHELL).toMatch(
			/if \(editingRow && !messagesById\.has\(editingRow\.messageId\)\) setEditingRow\(null\)/,
		);
	});
});

/**
 * The reasoning language toggle ("show original").
 *
 * RenderReasoning has always DRAWN the toggle, but the shell never handed it a
 * handler and the layout never received the resolver — so the control looked live
 * and did nothing. Both halves are asserted because either one alone is silent:
 * without the handler the click is inert, and without the resolver the flip never
 * re-measures (the body would keep the other language's predicted height).
 */
describe("vlist reasoning translation toggle wiring", () => {
	it("binds the row's language toggle onto reasoning cards", () => {
		// The handler dispatches the flip…
		expect(SHELL).toContain("setInteraction((prev) => toggleVListShowOriginal(prev, key))");
		// …and the row actually receives it.
		expect(SHELL).toMatch(
			/if \(kind === "reasoning"\) \{\s*\n\s*extra\.onToggleTranslation = toggles\.onToggleTranslation;/,
		);
	});

	/**
	 * The flip is height-affecting, so it captures the pre-fold geometry like every
	 * other resizing toggle.
	 *
	 * The two texts wrap to different line counts at one width (`measureReasoning`
	 * measures the resolved display text, and `showOriginal` is part of the measure cache
	 * key). Measured at 860px wide: an expanded run is 70px showing its translation and
	 * 90px showing its original. Without a capture this was the one resizing toggle with
	 * no transition — it teleported every row below it while the rest of the list eased.
	 */
	it("captures the pre-flip geometry, because the flip resizes the row", () => {
		const start = SHELL.indexOf("onToggleTranslation: () => {");
		expect(start, "the translation handler is missing").toBeGreaterThan(0);
		const body = SHELL.slice(start, SHELL.indexOf("},", start));
		const captureAt = body.indexOf("captureFoldBefore(key)");
		const setAt = body.indexOf("setInteraction(");
		expect(captureAt, "the flip must capture the pre-fold geometry").toBeGreaterThan(-1);
		// A capture taken after the state change reads the geometry the flip already
		// invalidated, so the delta would always be zero.
		expect(captureAt).toBeLessThan(setAt);
	});

	it("feeds the show-original resolver into the document layout", () => {
		// Without the resolver the flip never re-measures and the body keeps the other
		// language's predicted height.
		//
		// There is exactly ONE layout call site now. Live streaming output used to
		// build its own layout as an overlay, so this resolver (and every other
		// interaction resolver) had to be threaded into two places or the streaming
		// copy silently lost the behaviour. The streaming row is now an ordinary
		// trailing message in the same document, so a single wiring point covers both.
		expect(SHELL).toContain("const resolveShowOriginal = useCallback(");
		const wired = SHELL.match(/showOriginal: resolveShowOriginal,/g) ?? [];
		expect(wired).toHaveLength(1);
	});
});
