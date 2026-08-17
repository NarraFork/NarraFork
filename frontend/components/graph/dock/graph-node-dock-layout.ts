/**
 * Layout persistence format for a graph node's embedded dockview surface.
 *
 * Unlike the focus page (localStorage, keyed by narratorId + device) this layout
 * lives SERVER-SIDE on `chapters.dockLayoutJson`, so a node keeps its open
 * panels across browsers and devices. The key is the CHAPTER, not the narrator:
 * a node's identity is its chapter, and the user's expectation ("this node has a
 * terminal and a git panel open") follows the node even when its primary
 * narrator changes through a fork or a split.
 *
 * This module is deliberately storage-free: it parses / serializes / applies,
 * and the caller owns the transport (see `hooks/useChapterDockLayout.ts`). That
 * keeps the format logic synchronously testable even though the real transport
 * is an async request.
 */

import type { DockviewApi, SerializedDockview } from "dockview-react";
import { dockPanelId, NARRATOR_DOCK_COMPONENT } from "../../narrator/dock/dock-panel-types";
import { isRestorableLayout, stripIdentityFromLayout } from "../../narrator/panels/layout-envelope";

/** Current envelope schema version. */
export const CHAPTER_DOCK_LAYOUT_VERSION = 1 as const;

/**
 * Hard cap on a serialized layout, mirroring the server validator. Enforced on
 * the write path too so an oversized payload is dropped locally instead of
 * making a request that is guaranteed to 400.
 */
export const CHAPTER_DOCK_LAYOUT_MAX_BYTES = 65536;

interface ChapterDockEnvelope {
	version: typeof CHAPTER_DOCK_LAYOUT_VERSION;
	layout: SerializedDockview;
}

function isEnvelope(value: unknown): value is ChapterDockEnvelope {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return !!v.layout && typeof v.layout === "object";
}

/**
 * Parse a stored layout string into a restorable dockview layout.
 *
 * Returns null for every unusable input — absent, malformed JSON, wrong shape,
 * or a layout with no panels — rather than throwing. A broken stored layout must
 * degrade to "use the default layout", never to a crashed node.
 */
export function parseChapterDockLayout(raw: string | null | undefined): SerializedDockview | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (isEnvelope(parsed) && isRestorableLayout(parsed.layout)) {
			return parsed.layout;
		}
	} catch {
		// Unparseable → fall through to the default layout.
	}
	return null;
}

/**
 * Serialize the live layout for persistence, or null when it is too large to
 * store. Host identity is stripped (see `stripIdentityFromLayout`): panels take
 * their narrator from the live provider, so a persisted id could only ever be
 * wrong after a fork or split.
 */
export function serializeChapterDockLayout(api: DockviewApi): string | null {
	const envelope: ChapterDockEnvelope = {
		version: CHAPTER_DOCK_LAYOUT_VERSION,
		layout: stripIdentityFromLayout(api.toJSON()),
	};
	const serialized = JSON.stringify(envelope);
	// Byte length, not string length: a layout full of CJK panel titles is
	// larger over the wire than `.length` suggests, and the server cap is bytes.
	if (new TextEncoder().encode(serialized).length > CHAPTER_DOCK_LAYOUT_MAX_BYTES) {
		return null;
	}
	return serialized;
}

/**
 * Build the default layout for a node: the chat panel alone.
 *
 * `tabComponent: "chat"` gives it the close-less tab, so the cluster's
 * protagonist can never be closed out of the node — the same rule the focus page
 * enforces.
 */
function addDefaultChatPanel(api: DockviewApi, narratorId: string): void {
	api.addPanel({
		id: dockPanelId("chat"),
		component: NARRATOR_DOCK_COMPONENT.chat,
		tabComponent: "chat",
		params: { panelType: "chat", narratorId },
	});
}

/**
 * Apply a layout to a fresh DockviewApi, falling back to the default (chat only)
 * when there is nothing restorable.
 *
 * Returns true when the persisted layout was restored, false when the default
 * was built — the caller can use that to decide whether the node needs an
 * initial write.
 *
 * Note there is no "restored layout belongs to another narrator" guard here,
 * unlike `applyNarratorDockLayout`. That guard exists on the focus page to cope
 * with layouts written BEFORE identity stripping was introduced. This is a new
 * field with no such history: every layout we write is identity-free, and panels
 * resolve their narrator from the live provider. That is precisely why a node's
 * layout survives its narrator changing.
 */
export function applyChapterDockLayout(
	api: DockviewApi,
	layout: SerializedDockview | null,
	narratorId: string,
): boolean {
	if (layout) {
		try {
			api.fromJSON(layout);
			// A restored layout without the chat panel is unusable: the node would
			// show tool panels with no conversation and no way to get it back.
			if (api.getPanel(dockPanelId("chat"))) return true;
			api.clear();
		} catch {
			// Restore failed (version skew, corrupt grid) → rebuild the default.
			// `fromJSON` may have left a partial layout behind, so clear first.
			try {
				api.clear();
			} catch {
				// Nothing more to do; addPanel below still gives a usable surface.
			}
		}
	}
	addDefaultChatPanel(api, narratorId);
	return false;
}
