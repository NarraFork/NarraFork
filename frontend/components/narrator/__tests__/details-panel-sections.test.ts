/**
 * Findability rules for the session details panel.
 *
 * Two of these rules are the reason collapsing the panel is safe at all, and both
 * fail silently if broken — a hidden setting looks like a setting that did not
 * apply, and a hidden pending permission looks like a stalled session. They are
 * pinned here row by row rather than spot-checked.
 */
import { describe, expect, test } from "bun:test";
import {
	ADVANCED_SESSION_ROWS,
	type AdvancedRowInput,
	collapsedAdvancedRows,
	DETAILS_SECTION_IDS,
	isSectionOpenByDefault,
	normalizeBooleanOverride,
	promotedAdvancedRows,
	resolveActivitySignal,
	resolveAdvancedSubsectionOpen,
	resolveSectionOpen,
	sectionMatches,
	sectionStorageKey,
	shouldPromoteAdvancedRow,
	shouldRenderAdvancedSubsection,
} from "../details-panel-sections";

describe("section identity", () => {
	test("settings sections open by default, diagnostics do not", () => {
		expect(isSectionOpenByDefault("basic")).toBe(true);
		expect(isSectionOpenByDefault("session")).toBe(true);
		expect(isSectionOpenByDefault("activity")).toBe(false);
		expect(isSectionOpenByDefault("rules")).toBe(false);
		expect(isSectionOpenByDefault("contextSummary")).toBe(false);
	});

	test("every id has a default and a distinct storage key", () => {
		const keys = new Set(DETAILS_SECTION_IDS.map(sectionStorageKey));
		expect(keys.size).toBe(DETAILS_SECTION_IDS.length);
		for (const id of DETAILS_SECTION_IDS) {
			expect(typeof isSectionOpenByDefault(id)).toBe("boolean");
			expect(sectionStorageKey(id)).toContain(id);
		}
	});
});

describe("filtering", () => {
	const searchable = ["Session settings", "Permission mode", "Danger reflection"];

	test("an empty query keeps every section visible", () => {
		expect(sectionMatches(searchable, "")).toBe(true);
		expect(sectionMatches(searchable, "   ")).toBe(true);
		expect(sectionMatches([], "")).toBe(true);
	});

	test("a section matches on its title or on any row label", () => {
		expect(sectionMatches(searchable, "Session")).toBe(true);
		expect(sectionMatches(searchable, "permission")).toBe(true);
		expect(sectionMatches(searchable, "reflection")).toBe(true);
	});

	test("a section with no match is filtered out", () => {
		expect(sectionMatches(searchable, "terminal")).toBe(false);
	});

	test("case and surrounding whitespace do not affect matching", () => {
		expect(sectionMatches(searchable, "DANGER")).toBe(true);
		expect(sectionMatches(searchable, "  danger  ")).toBe(true);
	});

	/**
	 * The contract is that callers pass translated strings, not i18n keys — a user
	 * filtering in Chinese must match the Chinese label they can actually see.
	 */
	test("translated text is what gets searched, not the i18n key", () => {
		const zh = ["会话设置", "权限模式", "危险反思"];
		expect(sectionMatches(zh, "危险反思")).toBe(true);
		expect(sectionMatches(zh, "权限")).toBe(true);
		expect(sectionMatches(zh, "details.dangerReflection")).toBe(false);
	});
});

describe("advanced row promotion", () => {
	const untouched: AdvancedRowInput = {
		fastModeOverride: "inherit",
		relaxedPlan: false,
		pruneEnabled: false,
		planMode: false,
		backgroundStatus: null,
		pendingModelRestore: null,
		enabledTools: [],
	};

	test("a pristine narrator promotes nothing", () => {
		expect(promotedAdvancedRows(untouched)).toEqual([]);
		expect(collapsedAdvancedRows(untouched)).toEqual([...ADVANCED_SESSION_ROWS]);
		expect(shouldRenderAdvancedSubsection(untouched)).toBe(true);
	});

	/** Row by row: a single missed case silently hides a setting the user changed. */
	const promotingValues: Array<
		[(typeof ADVANCED_SESSION_ROWS)[number], Partial<AdvancedRowInput>]
	> = [
		["fastMode", { fastModeOverride: "on" }],
		["relaxedPlan", { relaxedPlan: true }],
		["pruneEnabled", { pruneEnabled: true }],
		["planMode", { planMode: true }],
		["backgroundStatus", { backgroundStatus: "completed" }],
		["pendingModelRestore", { pendingModelRestore: "provider:model" }],
		["enabledTools", { enabledTools: ["terminal"] }],
	];

	for (const [row, override] of promotingValues) {
		test(`${row} is promoted once explicitly configured`, () => {
			const input = { ...untouched, ...override };
			expect(shouldPromoteAdvancedRow(row, input)).toBe(true);
			expect(promotedAdvancedRows(input)).toContain(row);
			expect(collapsedAdvancedRows(input)).not.toContain(row);
		});
	}

	test("every advanced row has a promoting case covered", () => {
		expect(promotingValues.map(([row]) => row).sort()).toEqual([...ADVANCED_SESSION_ROWS].sort());
	});

	/**
	 * The subtle one: "off" is an explicit decision, not a default. Treating it as
	 * untouched would hide a switch the user deliberately turned off.
	 */
	test("fastMode off is an explicit choice and is promoted", () => {
		expect(shouldPromoteAdvancedRow("fastMode", { fastModeOverride: "off" })).toBe(true);
		expect(shouldPromoteAdvancedRow("fastMode", { fastModeOverride: "on" })).toBe(true);
		expect(shouldPromoteAdvancedRow("fastMode", { fastModeOverride: "inherit" })).toBe(false);
		// Unrecognized values normalize to inherit rather than promoting noise.
		expect(shouldPromoteAdvancedRow("fastMode", { fastModeOverride: undefined })).toBe(false);
		expect(shouldPromoteAdvancedRow("fastMode", { fastModeOverride: "bogus" })).toBe(false);
	});

	test("backgroundStatus promotes on presence, since the column has no none value", () => {
		expect(shouldPromoteAdvancedRow("backgroundStatus", { backgroundStatus: null })).toBe(false);
		expect(shouldPromoteAdvancedRow("backgroundStatus", { backgroundStatus: undefined })).toBe(
			false,
		);
		expect(shouldPromoteAdvancedRow("backgroundStatus", { backgroundStatus: "" })).toBe(false);
		for (const status of ["running", "completed", "failed", "cancelled"]) {
			expect(shouldPromoteAdvancedRow("backgroundStatus", { backgroundStatus: status })).toBe(true);
		}
	});

	test("the advanced subsection disappears when everything is promoted", () => {
		const allSet: AdvancedRowInput = {
			fastModeOverride: "on",
			relaxedPlan: true,
			pruneEnabled: true,
			planMode: true,
			backgroundStatus: "running",
			pendingModelRestore: "provider:model",
			enabledTools: ["terminal"],
		};
		expect(collapsedAdvancedRows(allSet)).toEqual([]);
		expect(shouldRenderAdvancedSubsection(allSet)).toBe(false);
	});

	test("normalizeBooleanOverride defaults unknown input to inherit", () => {
		expect(normalizeBooleanOverride("on")).toBe("on");
		expect(normalizeBooleanOverride("off")).toBe("off");
		expect(normalizeBooleanOverride("inherit")).toBe("inherit");
		expect(normalizeBooleanOverride(null)).toBe("inherit");
		expect(normalizeBooleanOverride(true)).toBe("inherit");
	});
});

describe("activity signal", () => {
	test("a pending permission badges in warning colour and forces the section open", () => {
		const signal = resolveActivitySignal({ pendingPermissionCount: 2, browserSessionCount: 0 });
		expect(signal).toEqual({ badgeCount: 2, badgeColor: "yellow", forceOpen: true });
	});

	test("pending permissions outrank browser sessions", () => {
		const signal = resolveActivitySignal({ pendingPermissionCount: 1, browserSessionCount: 5 });
		expect(signal.badgeCount).toBe(1);
		expect(signal.badgeColor).toBe("yellow");
		expect(signal.forceOpen).toBe(true);
	});

	test("browser sessions badge but never force the section open", () => {
		const signal = resolveActivitySignal({ pendingPermissionCount: 0, browserSessionCount: 3 });
		expect(signal).toEqual({ badgeCount: 3, badgeColor: "gray", forceOpen: false });
	});

	test("nothing to report means no badge at all, so badges stay meaningful", () => {
		expect(resolveActivitySignal({ pendingPermissionCount: 0, browserSessionCount: 0 })).toEqual({
			badgeCount: null,
			badgeColor: null,
			forceOpen: false,
		});
	});

	test("negative or fractional counts cannot produce a bogus badge", () => {
		expect(
			resolveActivitySignal({ pendingPermissionCount: -1, browserSessionCount: 0 }).badgeCount,
		).toBeNull();
		expect(
			resolveActivitySignal({ pendingPermissionCount: 1.7, browserSessionCount: 0 }).badgeCount,
		).toBe(1);
	});

	/**
	 * The whole point of the forceOpen path: the stat card that used to surface this
	 * count was removed as a duplicate, so a collapsed activity section must not be
	 * able to swallow a request that is blocking the session.
	 */
	test("a pending permission overrides a remembered collapsed state", () => {
		const signal = resolveActivitySignal({ pendingPermissionCount: 1, browserSessionCount: 0 });
		expect(
			resolveSectionOpen({ remembered: false, matchedFilter: false, forceOpen: signal.forceOpen }),
		).toBe(true);
	});
});

describe("open-state resolution", () => {
	test("with no filter the remembered preference wins", () => {
		expect(resolveSectionOpen({ remembered: true, matchedFilter: false })).toBe(true);
		expect(resolveSectionOpen({ remembered: false, matchedFilter: false })).toBe(false);
	});

	test("a filter match opens a section the user had collapsed", () => {
		expect(resolveSectionOpen({ remembered: false, matchedFilter: true })).toBe(true);
	});

	/**
	 * Nested collapse: a filter has to reach the advanced block too, otherwise
	 * searching an advanced row expands Session and reveals nothing.
	 */
	test("filtering opens the nested advanced subsection", () => {
		expect(
			resolveAdvancedSubsectionOpen({
				remembered: false,
				filterActive: true,
				sessionMatchedFilter: true,
			}),
		).toBe(true);
	});

	test("a filter that missed session leaves the advanced block as remembered", () => {
		expect(
			resolveAdvancedSubsectionOpen({
				remembered: false,
				filterActive: true,
				sessionMatchedFilter: false,
			}),
		).toBe(false);
	});

	test("with no filter the advanced block keeps its remembered state", () => {
		expect(
			resolveAdvancedSubsectionOpen({
				remembered: true,
				filterActive: false,
				sessionMatchedFilter: false,
			}),
		).toBe(true);
		expect(
			resolveAdvancedSubsectionOpen({
				remembered: false,
				filterActive: false,
				sessionMatchedFilter: true,
			}),
		).toBe(false);
	});
});
