/**
 * Pure display decisions behind the narrator status bubble — no React, no JSX.
 *
 * Shared by the sidebar (`RecentTabs`) and the narrator list page (`NarratorListCard`)
 * so the two surfaces cannot drift: both derive colour / fill / shape for the same
 * narrator state through these functions and render it via `NarratorStatusIcon`.
 *
 * Kept out of the component module for the same Fast Refresh reason documented in
 * `recent-tabs-logic.ts`: a module that exports both components and plain functions
 * stops being a valid Fast Refresh boundary, and edits then escalate to full reloads.
 */
import {
	getEffectiveNarratorDisplay,
	type StatusShape,
	statusRegistry,
} from "@frontend/lib/status-registry";

/**
 * Everything the icon decisions read. Both `RecentTab` and the list page's
 * `NarratorListItem` satisfy this structurally, which is what lets one icon
 * component serve both surfaces.
 */
export interface NarratorStatusSource {
	status?: string | null;
	substatus?: string[] | null;
}

/**
 * Reasoning has its own corner marker; don't let it override higher-level session
 * states such as planning for the base icon color.
 */
export function getNarratorStatusDisplaySubstatus(
	source: NarratorStatusSource,
): string[] | undefined {
	return source.substatus?.includes("reasoning")
		? source.substatus.filter((tag) => tag !== "reasoning")
		: (source.substatus ?? undefined);
}

export function getNarratorStatusIconColor(source: NarratorStatusSource): string | undefined {
	const substatus = getNarratorStatusDisplaySubstatus(source);
	if (!source.status && !substatus?.length) return undefined;
	return statusRegistry.accentVar(
		getEffectiveNarratorDisplay(source.status ?? "idle", substatus),
		6,
	);
}

/**
 * The state shape for a narrator, or undefined when it has none.
 *
 * Derived from the registry rather than re-enumerated here, so a state that gains a
 * shape tomorrow is picked up automatically — the same contract `isFilledNarratorStatus`
 * follows for `solidAccent`.
 */
export function getNarratorStatusShape(source: NarratorStatusSource): StatusShape | undefined {
	return getEffectiveNarratorDisplay(
		source.status ?? "idle",
		getNarratorStatusDisplaySubstatus(source),
	).shape;
}

export function isFilledNarratorStatus(source: NarratorStatusSource): boolean {
	const display = getEffectiveNarratorDisplay(
		source.status ?? "idle",
		getNarratorStatusDisplaySubstatus(source),
	);
	// Hollow vs filled is the "idle vs occupied" signal, so a state
	// that owns a solid accent (e.g. waiting for a model) must fill too —
	// otherwise it stays a hollow dot next to idle's hollow dot regardless of hue.
	if (display.solidAccent) return true;
	// A state that draws a SHAPE must fill too, for a hard reason rather than a stylistic
	// one: `ShapeOverlay` knocks its glyph out in white, expecting a solid bubble of the
	// state's colour behind it. On a hollow outline that white glyph would sit on the page
	// background and disappear entirely.
	if (display.shape) return true;
	return (
		source.status === "working" ||
		!!source.substatus?.includes("planning") ||
		!!source.substatus?.includes("error") ||
		!!source.substatus?.includes("unread")
	);
}
