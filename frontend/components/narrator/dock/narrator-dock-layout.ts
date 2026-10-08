/**
 * Local (per-narrator, per-device) layout persistence for the unified narrator
 * dockview surface.
 *
 * Unlike the workspace surface (whose layout lives server-side in
 * `workspaces.tree`), the narrator page persists its dockview layout in
 * localStorage, keyed by narratorId + device class so desktop and mobile
 * layouts never clobber each other.
 */

import type { DockviewApi, SerializedDockview } from "dockview-react";
import { removeRetiredFilemodPanels, stripIdentityFromLayout } from "../panels/layout-envelope";
import { dockPanelId, NARRATOR_DOCK_COMPONENT } from "./dock-panel-types";

/** Device class — desktop and mobile keep independent layouts. */
export type DockDevice = "desktop" | "mobile";

/** Current envelope schema version. */
export const NARRATOR_DOCK_LAYOUT_VERSION = 1 as const;

export {
	cleanupStaleNarratorDockLayouts,
	DOCK_LAYOUT_MAX_AGE_MS,
} from "./narrator-dock-storage-cleanup";

import { STORAGE_KEY_PREFIX } from "./narrator-dock-storage-cleanup";

interface NarratorDockEnvelope {
	version: typeof NARRATOR_DOCK_LAYOUT_VERSION;
	layout: SerializedDockview;
	/**
	 * Epoch ms the layout was last persisted (≈ last opened). Optional for
	 * backward compatibility with envelopes written before this field existed;
	 * such envelopes are treated as "age unknown" and kept until re-saved.
	 */
	lastOpenedAt?: number;
}

function storageKey(narratorId: string, device: DockDevice): string {
	return `${STORAGE_KEY_PREFIX}${narratorId}_${device}`;
}

/** Persist the current dockview layout to localStorage (best-effort). */
export function saveNarratorDockLayout(
	api: DockviewApi,
	narratorId: string,
	device: DockDevice,
): void {
	try {
		const envelope: NarratorDockEnvelope = {
			version: NARRATOR_DOCK_LAYOUT_VERSION,
			layout: stripIdentityFromLayout(api.toJSON()),
			lastOpenedAt: Date.now(),
		};
		localStorage.setItem(storageKey(narratorId, device), JSON.stringify(envelope));
	} catch {
		// Quota / serialization failures are non-fatal — layout just won't persist.
	}
}

/** Clear a persisted layout (e.g. when the user resets to defaults). */
export function clearNarratorDockLayout(narratorId: string, device: DockDevice): void {
	try {
		localStorage.removeItem(storageKey(narratorId, device));
	} catch {
		// ignore
	}
}

function isEnvelope(value: unknown): value is NarratorDockEnvelope {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return !!v.layout && typeof v.layout === "object";
}

/** Read a persisted layout, or null when none / invalid. */
export function loadNarratorDockLayout(
	narratorId: string,
	device: DockDevice,
): SerializedDockview | null {
	try {
		const raw = localStorage.getItem(storageKey(narratorId, device));
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (isEnvelope(parsed)) return removeRetiredFilemodPanels(parsed.layout);
	} catch {
		// fall through
	}
	return null;
}

/**
 * Apply a persisted layout to a fresh DockviewApi, or build the default layout
 * (chat only) when there is nothing valid to restore.
 *
 * Returns true when a persisted layout was restored, false when the default was
 * created — callers may want to open specific panels only on first run.
 */
export function applyNarratorDockLayout(
	api: DockviewApi,
	narratorId: string,
	device: DockDevice,
): boolean {
	const layout = loadNarratorDockLayout(narratorId, device);
	if (layout) {
		try {
			api.fromJSON(layout);
			const chat = api.getPanel(dockPanelId("chat"));
			// Guard 1: a restored layout with no chat panel is unusable.
			// Guard 2: a restored layout whose chat panel was serialized for a
			// DIFFERENT narrator is stale/foreign — restoring it would render the
			// wrong narrator ("open A, see B"). Discard it and rebuild the default.
			const restoredNarratorId = (chat?.params as { narratorId?: string } | undefined)?.narratorId;
			if (chat && (restoredNarratorId === undefined || restoredNarratorId === narratorId)) {
				return true;
			}
			// Foreign/invalid — clear whatever was restored before building default.
			api.clear();
		} catch {
			// fall through to default
		}
	}
	// Default layout: chat only. The chat panel uses a close-less tab component
	// so the cluster protagonist can never be closed (focus-page rule).
	api.addPanel({
		id: dockPanelId("chat"),
		component: NARRATOR_DOCK_COMPONENT.chat,
		tabComponent: "chat",
		params: { panelType: "chat", narratorId },
	});
	return false;
}
