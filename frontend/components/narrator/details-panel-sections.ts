/**
 * details-panel-sections.ts — findability logic for the session details panel.
 *
 * The panel had grown to ten sections in a single scroll stream (~900 rendered
 * lines), mixing three unrelated jobs: settings the user adjusts, read-only
 * diagnostics, and navigation. Finding one switch meant scrolling past dozens of
 * rows that are never touched.
 *
 * The fix is collapsible sections plus a filter box. Everything that decides
 * *what is visible* lives here as pure functions so it can be tested without
 * rendering Mantine, and so the rules stay honest under change — in particular the
 * two rules that keep collapsing safe:
 *
 *  - a setting the user explicitly changed is never hidden inside "advanced"
 *    (`shouldPromoteAdvancedRow`)
 *  - a pending permission is never hidden behind a collapsed section
 *    (`resolveActivitySignal`)
 */

import { includesSearch } from "@frontend/lib/search-utils";

// ── Boolean overrides ──────────────────────────────────────────────────────

export const BOOLEAN_OVERRIDE_VALUES = ["inherit", "on", "off"] as const;
export type BooleanOverride = (typeof BOOLEAN_OVERRIDE_VALUES)[number];

/**
 * Normalize a tri-state override, defaulting to `inherit`.
 *
 * Moved here from `NarratorDetailsPanel` so the promotion rules below can be
 * tested. Note there are still sibling copies in `NarratorPanel.tsx` and
 * `server/lib/boolean-override.ts`; consolidating those touches the chat panel and
 * the backend, so it is intentionally out of scope here rather than being turned
 * into a fourth implementation.
 */
export function normalizeBooleanOverride(value: unknown): BooleanOverride {
	return BOOLEAN_OVERRIDE_VALUES.includes(value as BooleanOverride)
		? (value as BooleanOverride)
		: "inherit";
}

// ── Section identity ───────────────────────────────────────────────────────

/**
 * Stable section ids. These are persisted in localStorage keys, so renaming one
 * silently resets that section's remembered collapse state.
 */
export const DETAILS_SECTION_IDS = [
	"basic",
	"groups",
	"skills",
	"session",
	"export",
	"customTraits",
	"relationships",
	"activity",
	"rules",
	"contextSummary",
] as const;

export type DetailsSectionId = (typeof DETAILS_SECTION_IDS)[number];

/**
 * Whether a section starts expanded.
 *
 * Settings the user came to adjust stay open; diagnostics and navigation start
 * closed. `activity` is closed here but can still be forced open at runtime when
 * it holds something actionable — see `resolveActivitySignal`.
 */
const DEFAULT_OPEN: Record<DetailsSectionId, boolean> = {
	basic: true,
	session: true,
	groups: false,
	skills: false,
	export: false,
	customTraits: false,
	relationships: false,
	activity: false,
	rules: false,
	contextSummary: false,
};

export function isSectionOpenByDefault(id: DetailsSectionId): boolean {
	return DEFAULT_OPEN[id];
}

/** localStorage key for one section's remembered collapse state. */
export function sectionStorageKey(id: DetailsSectionId): string {
	return `narrafork_details_section_${id}`;
}

// ── Filtering ──────────────────────────────────────────────────────────────

/**
 * Does this section survive the current filter?
 *
 * `searchableText` must contain **already-translated** strings, not i18n keys:
 * someone filtering for "危险反思" has to match the rendered Chinese label, and
 * the key is `details.dangerReflection`. Translation therefore stays in the
 * component (which owns `t`) and matching stays here.
 *
 * An empty query matches everything, so the unfiltered panel renders in full.
 */
export function sectionMatches(searchableText: readonly string[], query: string): boolean {
	if (!query.trim()) return true;
	return searchableText.some((text) => includesSearch(text, query));
}

/**
 * Filtering is section-level, not row-level.
 *
 * Row-level filtering would mean threading searchable text through all 32
 * `DetailRow`s — a large change with many places to miss one, which would produce
 * the worst outcome: a row that exists but cannot be found. Section granularity
 * already turns "scroll ten screens" into "type two characters, get one section",
 * so the extra precision is not worth the risk yet.
 */
export const FILTER_GRANULARITY = "section" as const;

// ── Advanced-row promotion ─────────────────────────────────────────────────

/**
 * The session settings that live in the collapsed "advanced" subsection while
 * they hold their default value.
 */
export const ADVANCED_SESSION_ROWS = [
	"fastMode",
	"relaxedPlan",
	"pruneEnabled",
	"planMode",
	"backgroundStatus",
	"pendingModelRestore",
	"enabledTools",
] as const;

export type AdvancedSessionRow = (typeof ADVANCED_SESSION_ROWS)[number];

/** The narrator fields the promotion rules read. */
export interface AdvancedRowInput {
	fastModeOverride?: unknown;
	relaxedPlan?: unknown;
	pruneEnabled?: unknown;
	/** Precomputed by the panel: `planMode` flag OR the `plan` trait. */
	planMode?: boolean;
	backgroundStatus?: unknown;
	pendingModelRestore?: unknown;
	enabledTools?: readonly string[];
}

/**
 * Whether an advanced row must be shown at the top level instead of tucked away.
 *
 * This is what makes collapsing safe. If a user sets fastMode and then cannot see
 * it on the next visit, they reasonably conclude it did not take effect — so
 * anything deviating from its default is promoted out of "advanced".
 */
export function shouldPromoteAdvancedRow(
	row: AdvancedSessionRow,
	input: AdvancedRowInput,
): boolean {
	switch (row) {
		case "fastMode":
			// "off" is an explicit choice just as much as "on": only "inherit" (or an
			// unrecognized value) counts as untouched.
			return normalizeBooleanOverride(input.fastModeOverride) !== "inherit";
		case "relaxedPlan":
			return !!input.relaxedPlan;
		case "pruneEnabled":
			return !!input.pruneEnabled;
		case "planMode":
			return !!input.planMode;
		case "backgroundStatus":
			// The column is nullable with no "none" member (running/completed/failed/
			// cancelled), so presence alone means this narrator ran in the background.
			return input.backgroundStatus != null && input.backgroundStatus !== "";
		case "pendingModelRestore":
			return !!input.pendingModelRestore;
		case "enabledTools":
			return (input.enabledTools?.length ?? 0) > 0;
		default:
			return false;
	}
}

/** The advanced rows still hidden, i.e. those left at their default. */
export function collapsedAdvancedRows(input: AdvancedRowInput): AdvancedSessionRow[] {
	return ADVANCED_SESSION_ROWS.filter((row) => !shouldPromoteAdvancedRow(row, input));
}

/** Rows promoted to the top level because they were explicitly configured. */
export function promotedAdvancedRows(input: AdvancedRowInput): AdvancedSessionRow[] {
	return ADVANCED_SESSION_ROWS.filter((row) => shouldPromoteAdvancedRow(row, input));
}

/**
 * With every advanced row promoted there is nothing left to disclose, so the
 * subsection is omitted rather than rendered empty.
 */
export function shouldRenderAdvancedSubsection(input: AdvancedRowInput): boolean {
	return collapsedAdvancedRows(input).length > 0;
}

// ── Activity section signal ────────────────────────────────────────────────

export interface ActivitySignalInput {
	pendingPermissionCount: number;
	browserSessionCount: number;
}

export interface ActivitySignal {
	/** Count to show on the collapsed header, or null for no badge. */
	badgeCount: number | null;
	/** Warning colour only when the badge represents something to act on. */
	badgeColor: "yellow" | "gray" | null;
	/** Overrides the remembered collapse state (never persisted). */
	forceOpen: boolean;
}

/**
 * What the collapsed `activity` header must reveal.
 *
 * This exists because two otherwise reasonable decisions combine badly: the
 * duplicate `pendingPermissions` stat card was removed (activity already lists
 * each request with its tool name), and diagnostics sections default to
 * collapsed. Together they would leave a pending permission — which blocks the
 * session until answered — visible nowhere at all.
 *
 * So a pending request both badges the header in a warning colour AND forces the
 * section open. A number on a collapsed header is not enough for something that
 * is actively waiting on the user. Browser sessions are informational: they badge
 * but never force. A zero count renders no badge, so a row of "0"s never becomes
 * noise that trains users to ignore the badges.
 */
export function resolveActivitySignal(input: ActivitySignalInput): ActivitySignal {
	const pending = Math.max(0, Math.trunc(input.pendingPermissionCount || 0));
	if (pending > 0) {
		return { badgeCount: pending, badgeColor: "yellow", forceOpen: true };
	}
	const sessions = Math.max(0, Math.trunc(input.browserSessionCount || 0));
	if (sessions > 0) {
		return { badgeCount: sessions, badgeColor: "gray", forceOpen: false };
	}
	return { badgeCount: null, badgeColor: null, forceOpen: false };
}

// ── Open-state resolution ──────────────────────────────────────────────────

export interface SectionOpenInput {
	/** Remembered (persisted) collapse state. */
	remembered: boolean;
	/** A filter is active and this section matched it. */
	matchedFilter: boolean;
	/** Section-specific override, e.g. a pending permission in `activity`. */
	forceOpen?: boolean;
}

/**
 * Final open state for a section.
 *
 * Both override paths deliberately bypass the remembered state without writing to
 * it: a section opened by a filter or by an urgent signal must snap back to the
 * user's own preference once that condition clears.
 */
export function resolveSectionOpen(input: SectionOpenInput): boolean {
	if (input.forceOpen) return true;
	if (input.matchedFilter) return true;
	return input.remembered;
}

/**
 * Open state for the nested "advanced" subsection inside `session`.
 *
 * The advanced block is a *second* layer of collapse, so a filter has to reach
 * into it. Without this, searching for `fastMode` would expand the Session
 * section and still show nothing — the section matched on a row that stayed
 * hidden one level down, which is exactly the "I can't find it" failure this
 * work is meant to remove.
 *
 * `sessionMatchedFilter` (not "the advanced rows matched") is the trigger,
 * because the query may have matched an advanced row's label while the section's
 * own searchable text is what got tested.
 */
export function resolveAdvancedSubsectionOpen(input: {
	remembered: boolean;
	filterActive: boolean;
	sessionMatchedFilter: boolean;
}): boolean {
	if (input.filterActive && input.sessionMatchedFilter) return true;
	return input.remembered;
}
