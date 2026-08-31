/**
 * Sidebar → Dockview drag-and-drop bridge.
 *
 * Recent-tab items in the sidebar are made HTML5-draggable and write a small
 * JSON payload onto the drag's dataTransfer under a custom MIME type. Dockview
 * surfaces the native drop via `onDidDrop`, where we decode the payload and
 * create the corresponding panel.
 *
 * Using a custom MIME type (rather than reusing Dockview's internal transfer)
 * keeps our external drag clearly distinguishable from Dockview's own panel/
 * group drags, so `onUnhandledDragOver` only accepts our payloads.
 */

import type { WorkspacePanelParams } from "./panel-types";

/** Custom MIME type identifying a NarraFork sidebar drag. */
export const WORKSPACE_DND_MIME = "application/x-narrafork-panel";

/** Payload serialized onto the drag's dataTransfer. */
export interface WorkspaceDropPayload {
	/** Preferred panel id (e.g. narrator id) — falls back to generated id. */
	id?: string;
	title: string;
	params: WorkspacePanelParams;
}

/** Build a narrator drag payload. */
export function narratorDropPayload(narratorId: string, title: string): WorkspaceDropPayload {
	return {
		id: narratorId,
		title: title || "Narrator",
		params: { panelType: "narrator", narratorId },
	};
}

// ── Removed: terminalDropPayload / webviewDropPayload ──
//
// Both were unreachable: nothing in the app called them, and nothing calls
// `writeWorkspaceDropPayload` either, so no terminal/webview payload is ever produced.
// (`narratorDropPayload` above is kept because the drop HANDLER still decodes narrator
// payloads, and a future producer is meaningful.)
//
// They are not merely dead but actively wrong now: terminal and webview panels are
// MEMBERSHIP, so creating one requires a `workspace_panels` row first — the row id then
// travels in the panel's params as `panelRowId`. A drag payload assembled on the client
// cannot know that id, which is why the type no longer permits these objects. A future
// drop path must call `POST /workspaces/:id/panels` and let the resulting row drive the
// panel, rather than smuggling params through the drag.

/** Write a payload onto a dragstart event's dataTransfer. */
export function writeWorkspaceDropPayload(
	dataTransfer: DataTransfer,
	payload: WorkspaceDropPayload,
): void {
	dataTransfer.effectAllowed = "copyMove";
	dataTransfer.setData(WORKSPACE_DND_MIME, JSON.stringify(payload));
	// Some environments require text/plain for a drag to initiate at all.
	dataTransfer.setData("text/plain", payload.title);
}

/** Decode a payload from a native drop event, or null if none/invalid. */
export function consumeWorkspaceDropPayload(
	nativeEvent: DragEvent | Event,
): WorkspaceDropPayload | null {
	const dt = (nativeEvent as DragEvent).dataTransfer;
	if (!dt) return null;
	const raw = dt.getData(WORKSPACE_DND_MIME);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as WorkspaceDropPayload;
		if (!parsed || typeof parsed !== "object" || !parsed.params) return null;
		return parsed;
	} catch {
		return null;
	}
}
