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

const SHELL = readFileSync(join(import.meta.dir, "PretextExactMessageList.tsx"), "utf8");
const ROW_INTERACTION = readFileSync(join(import.meta.dir, "VListRowInteraction.tsx"), "utf8");

describe("vlist inline editing wiring", () => {
	it("treats the editing row as dynamic so its real height overrides the arithmetic one", () => {
		// dynamicRowKeys gates which keys may hold a height override.
		expect(SHELL).toMatch(/if \(editingRow\) keys\.add\(editingRow\.key\)/);
		// The row must receive a height reporter when it hosts the editor. Other
		// slot-hosting rows (permission form, the live ask-in-passing form) join the
		// same disjunction, so the assertion pins the editor's term rather than the
		// full expression.
		expect(SHELL).toMatch(/const isDynamicRow =[\s\S]{0,200}?editorSlot !== undefined/);
		expect(SHELL).toMatch(
			/isDynamicRow \? getUnknownHeightReporter\(item\.spec\.key\) : undefined/,
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
		expect(SHELL).toContain('from "../message-edit-text"');
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
		expect(SHELL).toContain("const body = editorSlot ?? renderElement(kind, item.measured, extra)");
		expect(SHELL).toMatch(/interaction && editorSlot === undefined \?/);
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
		expect(SHELL).toContain("onToggleTranslation: () => setInteraction((prev) =>");
		expect(SHELL).toMatch(
			/if \(kind === "reasoning"\) \{\s*\n\s*extra\.onToggleTranslation = toggles\.onToggleTranslation;/,
		);
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
