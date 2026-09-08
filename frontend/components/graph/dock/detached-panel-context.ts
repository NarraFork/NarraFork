/**
 * The minimal dock context a detached canvas node's surface runs on.
 *
 * Every panel adapter reads `useNarratorDockContext()`, which on the focus page and
 * inside an expanded chapter node is backed by a full provider. A detached node has
 * no chat panel and no page around it, so this supplies just enough of that shape
 * for the adapters to work unchanged — rather than forking each adapter into a
 * "docked" and a "standalone" variant.
 *
 * Only the panels in `DETACHABLE_PANEL_KINDS` are supported. The ones that take
 * their data from chat-published context (`details`, `filemod`) are excluded
 * precisely because this value cannot supply it.
 */

import type { DockviewApi } from "dockview-react";
import type { NarratorDockContextValue } from "../../narrator/dock/NarratorDockContext";

/** A no-op unsubscribe, for the register* bridges nothing listens to here. */
const noopUnsubscribe = () => {};

/**
 * Build a `NarratorDockContextValue` for a standalone panel.
 *
 * `sourceDock` is the dock of the chapter this panel was torn out of, when that
 * node is still expanded. It exists only to forward the two actions that are
 * inherently chat-side:
 *
 *  - `scrollToMessage` (search result → jump to the message)
 *  - `openSubagentPanel` (background task → open the child session)
 *
 * When it is absent both are left NULL rather than wired to a silent no-op: the
 * panels check for them and disable the control, so a user never clicks something
 * that looks live and does nothing.
 */
export function createDetachedPanelDockValue(input: {
	narratorId: string;
	chapterId: string;
	sourceDock: NarratorDockContextValue | undefined;
	/**
	 * The node's OWN dockview api ref, owned by the caller so it survives this value
	 * being rebuilt.
	 *
	 * Load-bearing and previously wrong: this used to be a fresh `{ current: null }`
	 * created here. Because the value is rebuilt whenever `sourceDock` changes, each
	 * rebuild registered a NEW null ref over the live one, so every lookup through
	 * `dock-registry` (`getPanel` for "who holds this panel?") failed. That silently
	 * broke both directions of cross-surface dragging: a foreign tab was never
	 * accepted (no drop overlay), and a panel dragged out was never closed on its
	 * source — leaving it in two surfaces at once.
	 */
	apiRef: { current: DockviewApi | null };
}): NarratorDockContextValue {
	const { narratorId, chapterId, sourceDock, apiRef } = input;
	const scrollToMessage = sourceDock?.scrollToMessage;
	const openSubagentPanel = sourceDock?.openSubagentPanel;

	return {
		narratorId,
		chapterId,

		// Page-level affordances a canvas node does not offer.
		onForkFromMessage: null,
		highlightMessageId: undefined,
		onBack: null,
		onMinimize: null,

		// The node's own surface. Passed in rather than created here — see the prop doc.
		apiRef,

		// Published state: the detachable set contains no consumer of these (their
		// consumers, details/filemod, are excluded exactly because they need a chat
		// panel publishing into the same provider).
		fileModProps: null,
		setFileModProps: () => {},
		detailsProps: null,
		setDetailsProps: () => {},
		browserInfo: { sessionCount: 0, visualChange: null },
		setBrowserInfo: () => {},

		// Chat bridges: nothing to bridge to without a chat panel alongside.
		registerAppendChatInput: () => noopUnsubscribe,
		appendChatInput: () => {},
		registerWriteTerminalStdin: () => noopUnsubscribe,
		writeTerminalStdin: () => {},
		registerScrollToMessage: () => noopUnsubscribe,
		registerSubmitToNarrator: () => noopUnsubscribe,
		submitToNarrator: () => {},

		// Forwarded to the source dock when its node is still expanded; left absent
		// otherwise so the panels disable the control instead of offering a dead one.
		...(scrollToMessage ? { scrollToMessage } : {}),
		...(openSubagentPanel ? { openSubagentPanel } : {}),

		// A standalone panel has no siblings to open, close or toggle.
		openToolTypes: new Set(),
		refreshOpenToolTypes: () => {},
		openToolPanel: () => {},
		openFilePanel: sourceDock?.openFilePanel,
		fileReferenceSelection: sourceDock?.fileReferenceSelection,
		setFileReferenceSelection: sourceDock?.setFileReferenceSelection,
		registerAddFileReference: sourceDock?.registerAddFileReference,
		addFileReference: sourceDock?.addFileReference,
		closeToolPanel: () => {},
		toggleToolPanel: () => {},
	};
}

// A fake panel api and hand-built `IDockviewPanelProps` used to live here, for a
// version of the detached node that rendered panel adapters directly. Detached
// nodes now host a real dockview surface, which creates panels through
// `api.addPanel` and hands them genuine props — so faking either would only
// reintroduce a way to bypass dockview.
