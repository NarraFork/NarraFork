/**
 * Which dock panels may be torn out of a chapter node onto the canvas.
 *
 * The dividing line is whether a panel can source its own data. Every kind below
 * reads from a query keyed by `narratorId` / `chapterId`, or carries its resource
 * identity in its own params — so it keeps working once it no longer sits next to
 * the chat panel.
 *
 * Deliberately excluded:
 *
 *  - `details` and `filemod` take their data from `dock.detailsProps` /
 *    `dock.fileModProps`, which the CHAT panel publishes into the shared provider
 *    (see NarratorPanel's publish effects). Detached, nothing publishes to them
 *    and `DetailsDockPanel` would render its loader forever. Supporting them means
 *    first making both panels fetch their own data, which also drags in the
 *    permission-approval and delete-preview flows they share with chat.
 *  - `chat` is the cluster's protagonist and has a close-less tab; tearing it out
 *    would leave a node with tool panels and no conversation.
 *  - `webview` only exists on workspace surfaces, never in a node dock.
 *  - `plugin` panels carry a whole iframe session bound to a host surface; moving
 *    one needs the plugin UI session re-established, which is its own change.
 *  - `mock` is the temporary streaming harness (see `../../narrator/mock/`).
 */

/** Panel kinds that can live as a standalone canvas node. */
export const DETACHABLE_PANEL_KINDS = [
	"terminal",
	"browser",
	"userchat",
	"tasks",
	"git",
	"spec",
	"search",
	"subagent",
	"file",
] as const;

export type DetachablePanelKind = (typeof DETACHABLE_PANEL_KINDS)[number];

const DETACHABLE_SET: ReadonlySet<string> = new Set(DETACHABLE_PANEL_KINDS);

/** Runtime guard for a value arriving from drag state or persisted JSON. */
export function isDetachablePanelKind(value: unknown): value is DetachablePanelKind {
	return typeof value === "string" && DETACHABLE_SET.has(value);
}

/**
 * Kinds that may appear more than once, because each instance points at a
 * different resource. Everything else is a singleton per narrator, so re-opening
 * it should focus the existing panel rather than add a second one.
 */
const MULTI_INSTANCE: ReadonlySet<DetachablePanelKind> = new Set(["subagent", "file"]);

/** Whether this kind needs a `resourceId` to identify which instance it is. */
export function isMultiInstanceKind(kind: DetachablePanelKind): boolean {
	return MULTI_INSTANCE.has(kind);
}
