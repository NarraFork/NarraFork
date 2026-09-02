/**
 * Registry of the customizable narrator-header toolbar entries.
 *
 * Mirrors `components/nav/nav-items.tsx`: a static data structure describing how
 * each id PRESENTS itself, with live values (counts, open state) resolved by the
 * rendering component. Keeping it data means the header, the overflow menu and
 * the reorder UI all agree by construction rather than by three parallel
 * `if (dock && …)` chains.
 *
 * The one thing this file adds over the nav registry is `hosts`: which surfaces
 * can actually present the entry. That field is what fixes the mobile gap — the
 * old header gated Git / search / browser / discussion behind `{dock && …}`, so
 * on a phone (no dock provider) those entries did not merely collapse, they
 * ceased to exist. Declaring the *hosting requirement* separately from the
 * *entry* lets the mobile header offer the same entry through a Drawer.
 */

import {
	isNarratorToolbarId,
	NARRATOR_TOOLBAR_IDS,
	type NarratorToolbarId,
} from "@shared/narrator-toolbar";
import {
	IconBaselineDensityMedium,
	IconDeviceDesktop,
	IconFileCode,
	IconFolder,
	IconGitBranch,
	IconInfoCircle,
	IconMessages,
	IconNotebook,
	IconPuzzle,
	IconRobot,
	IconSearch,
	IconTerminal,
	IconTextSize,
	IconWorldWww,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

/**
 * Where an entry can be presented.
 *
 * - `dock`   — as a dockview sibling panel (desktop focus page, workspace, graph node).
 * - `drawer` — as a full-screen Drawer (mobile), via `MobileToolPanelHost` or a
 *              host-supplied callback.
 * - `inline` — the control is self-contained (a Menu or popover) and needs no host.
 *
 * An entry is offered when the CURRENT host satisfies any listed capability. An
 * entry listing only `dock` is genuinely unavailable on mobile; that is then a
 * stated technical limit rather than an oversight, and it stays in the user's
 * layout so it returns when they open the same narrator on a desktop.
 */
export type NarratorToolbarHost = "dock" | "drawer" | "inline";

export interface NarratorToolbarItemDef {
	/** Stable id persisted in user_preferences.narrator_toolbar_layout. */
	id: NarratorToolbarId;
	/** i18n key, resolved against `namespace`. */
	labelKey: string;
	/** i18n namespace for `labelKey` (defaults to "narrator"). */
	namespace?: string;
	icon: ComponentType<{ size?: number | string }>;
	/** Hosts able to present this entry; see {@link NarratorToolbarHost}. */
	hosts: readonly NarratorToolbarHost[];
	/**
	 * Which live counter badges this entry. A wiring key only — the count is
	 * resolved centrally by `useNarratorToolbarBadges`, so adding a badge means
	 * touching one file rather than every surface that paints the toolbar.
	 */
	badge?: "backgroundTasks" | "browserSessions" | "userChatUnread" | "terminals";
	/**
	 * The entry is a self-contained control (its own Menu / picker) rather than a
	 * panel toggle: the header renders its component directly, and it cannot be
	 * "activated" through the panel-toggle switch.
	 *
	 * In the overflow menu such a row expands its options INLINE instead
	 * (`renderInlineOptions`), because a phone keeps only two icons in the header
	 * and everything else lives in that menu — the row used to be a dead
	 * "header only" hint, which left these controls with no reachable entry point
	 * at all on mobile.
	 */
	selfContained?: boolean;
}

/**
 * Presentation per id. A total record, so adding an id to
 * `@shared/narrator-toolbar` fails to compile until its details are filled in —
 * otherwise the server would accept an id that renders as nothing.
 */
const TOOLBAR_ITEM_DETAILS: Record<NarratorToolbarId, Omit<NarratorToolbarItemDef, "id">> = {
	tasks: {
		labelKey: "backgroundTasks.title",
		icon: IconRobot,
		// Already had both hosts: a dock panel and `BackgroundTasksDrawer`.
		hosts: ["dock", "drawer"],
		badge: "backgroundTasks",
	},
	filemod: {
		labelKey: "fileMod_title",
		icon: IconFileCode,
		hosts: ["dock", "drawer"],
	},
	filetree: {
		labelKey: "fileTree.title",
		icon: IconFolder,
		// Dock only, deliberately. `drawer` is not a capability flag but a claim that
		// `MobileToolPanelHost` can render this kind, and its `MobileToolPanelKind` union
		// has no `filetree` member — declaring it here would put a row in the mobile
		// overflow menu that opens nothing, which is precisely the dead-control trap the
		// notes on `hosts` describe. Add it back together with a mobile host.
		hosts: ["dock"],
	},
	details: {
		labelKey: "details.title",
		icon: IconInfoCircle,
		hosts: ["dock", "drawer"],
	},
	terminal: {
		labelKey: "openTerminal",
		namespace: "terminal",
		icon: IconTerminal,
		// Mobile hosts the terminal in the route's own drawer; the dock hosts a panel.
		hosts: ["dock", "drawer"],
		badge: "terminals",
	},
	spec: {
		labelKey: "spec.title",
		icon: IconNotebook,
		hosts: ["dock", "drawer"],
	},
	git: {
		labelKey: "panel.title",
		namespace: "git",
		icon: IconGitBranch,
		// Newly reachable on mobile through MobileToolPanelHost.
		hosts: ["dock", "drawer"],
	},
	search: {
		labelKey: "search.title",
		icon: IconSearch,
		hosts: ["dock", "drawer"],
	},
	browser: {
		labelKey: "browser.title",
		icon: IconWorldWww,
		hosts: ["dock", "drawer"],
		badge: "browserSessions",
	},
	userchat: {
		labelKey: "panelTitle",
		namespace: "chat",
		icon: IconMessages,
		hosts: ["dock", "drawer"],
		badge: "userChatUnread",
	},
	appearance: {
		labelKey: "appearance.title",
		icon: IconTextSize,
		// Dock only: the panel's whole purpose is being visible BESIDE the transcript
		// while a slider moves, which a modal drawer over the content cannot provide.
		hosts: ["dock"],
	},
	lodlevel: {
		labelKey: "lodDensity",
		icon: IconBaselineDensityMedium,
		// A Menu of detail levels; no host surface required, so it works even in
		// the lightweight workspace preview (whose only capability is "inline").
		hosts: ["inline"],
		selfContained: true,
	},
	device: {
		labelKey: "executionDeviceSelector",
		icon: IconDeviceDesktop,
		// A Menu of devices; no host surface required.
		hosts: ["inline"],
		selfContained: true,
	},
	plugins: {
		labelKey: "addPluginPanel",
		icon: IconPuzzle,
		/*
		 * Dock-only, and unlike the entries above this is a real constraint rather
		 * than a missing host: a plugin contribution is opened by calling
		 * `api.addPanel` on a live Dockview instance (see NarratorPanel's
		 * `openPluginPanel`), so there is no panel to render into without one.
		 * Giving it a Drawer would mean building a second plugin host, which is a
		 * separate piece of work — not something to fake here.
		 */
		hosts: ["dock"],
		selfContained: true,
	},
};

/** Default display order for fresh installs, driven by the shared id order. */
export const NARRATOR_TOOLBAR_ITEMS: readonly NarratorToolbarItemDef[] = NARRATOR_TOOLBAR_IDS.map(
	(id) => ({ id, ...TOOLBAR_ITEM_DETAILS[id] }),
);

const ITEM_BY_ID = new Map<string, NarratorToolbarItemDef>(
	NARRATOR_TOOLBAR_ITEMS.map((def) => [def.id, def]),
);

/** Look up one entry's presentation, or undefined for a stale/unknown id. */
export function narratorToolbarItem(id: string): NarratorToolbarItemDef | undefined {
	return ITEM_BY_ID.get(id);
}

/**
 * Whether the current host can present an entry.
 *
 * Takes the set of capabilities the host provides, so a caller cannot forget to
 * consider one: the mobile header passes `["drawer", "inline"]`, a dock surface
 * passes `["dock", "drawer", "inline"]` (it can do both), and a lightweight
 * workspace preview passes `["inline"]`.
 */
export function isNarratorToolbarItemAvailable(
	def: NarratorToolbarItemDef,
	hostCapabilities: readonly NarratorToolbarHost[],
): boolean {
	return def.hosts.some((host) => hostCapabilities.includes(host));
}

export { isNarratorToolbarId, NARRATOR_TOOLBAR_IDS, type NarratorToolbarId };
