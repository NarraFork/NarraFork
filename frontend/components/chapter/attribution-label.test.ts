/**
 * attribution-label.test.ts — "who changed this file" must name real writers.
 *
 * The bug this guards: the panel used to resolve narrator ids against the CHAPTER's
 * primary narrator list, so every subagent write and every write from a standalone
 * or other-chapter session rendered as "Unknown" — the common case in a shared
 * worktree, not an edge case. Labels now come from the resolved actor, and these
 * tests pin the phrasing decisions rather than the lookup mechanism.
 */
import { describe, expect, test } from "bun:test";
import type { AttributionActor, FileModificationGroup } from "@frontend/hooks/useGit";
import { buildAttributionBadge, buildAttributionLabels } from "./attribution-label";

/** Stand-in for i18n: renders "key(param=value,...)" so assertions stay readable. */
const t = (key: string, opts?: Record<string, unknown>): string => {
	if (!opts || Object.keys(opts).length === 0) return key;
	const params = Object.entries(opts)
		.map(([k, v]) => `${k}=${String(v)}`)
		.join(",");
	return `${key}(${params})`;
};

function actor(overrides: Partial<AttributionActor> = {}): AttributionActor {
	return {
		narratorId: "n1",
		title: "Refactor auth",
		subagentType: null,
		parentTitle: null,
		exists: true,
		...overrides,
	};
}

describe("buildAttributionLabels", () => {
	test("names a primary narrator by its title", () => {
		const labels = buildAttributionLabels(actor(), t);
		expect(labels.short).toBe("Refactor auth");
		// Nothing more to add for a plain narrator, so the tooltip must not invent a
		// parenthetical that the badge lacks.
		expect(labels.detail).toBe("Refactor auth");
	});

	test("a subagent is named, not reported as unknown", () => {
		const labels = buildAttributionLabels(
			actor({ title: "Implement OAuth fix", subagentType: "general" }),
			t,
		);
		expect(labels.short).toBe("Implement OAuth fix");
		expect(labels.detail).toBe("attributionSubagentDetail(name=Implement OAuth fix,type=general)");
		expect(labels.detail).not.toContain("attributionUnknown");
	});

	test("a subagent's detail credits the spawning session when known", () => {
		const labels = buildAttributionLabels(
			actor({ title: "Trace edges", subagentType: "explore", parentTitle: "Graph rewrite" }),
			t,
		);
		expect(labels.detail).toBe(
			"attributionSubagentDetailWithParent(name=Trace edges,type=explore,parent=Graph rewrite)",
		);
	});

	test("an untitled subagent falls back to its type, not the generic session label", () => {
		const labels = buildAttributionLabels(actor({ title: null, subagentType: "review" }), t);
		expect(labels.short).toBe("attributionSubagentUnnamed(type=review)");
		expect(labels.short).not.toBe("attributionUnnamed");
	});

	test("a blank title is treated as absent", () => {
		expect(buildAttributionLabels(actor({ title: "   " }), t).short).toBe("attributionUnnamed");
	});

	test("a deleted session is reported as deleted rather than unknown", () => {
		// The distinction is actionable: "deleted" means there is no session to open,
		// while "unknown" would send the user looking for one.
		const labels = buildAttributionLabels(
			actor({ title: null, exists: false, subagentType: "general" }),
			t,
		);
		expect(labels.short).toBe("attributionDeletedSession");
		expect(labels.detail).toBe("attributionDeletedSession");
	});

	test("no actor means external when the change came from outside the tool path", () => {
		expect(buildAttributionLabels(null, t, { external: true }).short).toBe("attributionExternal");
	});

	test("no actor and no external evidence stays unknown", () => {
		expect(buildAttributionLabels(undefined, t).short).toBe("attributionUnknown");
	});

	test("an id-less row from a deleted session is labelled deleted, not unknown", () => {
		// The FK is ON DELETE SET NULL, so the row loses its id entirely; the caller
		// signals the cause because the row alone cannot.
		expect(buildAttributionLabels(null, t, { deleted: true }).short).toBe(
			"attributionDeletedSession",
		);
	});

	test("external wins over deleted when both were recorded", () => {
		// External is the one the user can still investigate.
		expect(buildAttributionLabels(null, t, { external: true, deleted: true }).short).toBe(
			"attributionExternal",
		);
	});

	test("an actor with a null narratorId is treated as having no session", () => {
		// The server sends this shape for an external change rather than omitting the
		// actor, so the label must not present it as a named session.
		const labels = buildAttributionLabels(actor({ narratorId: null, title: null }), t);
		expect(labels.short).toBe("attributionUnnamed");
	});
});

const EXTERNAL_ACTOR: AttributionActor = {
	narratorId: null,
	title: null,
	subagentType: null,
	parentTitle: null,
	exists: false,
};

function group(overrides: Partial<FileModificationGroup> = {}): FileModificationGroup {
	return {
		filePath: "src/one.ts",
		changeCount: 1,
		lastChangedAt: "2026-01-01T00:00:00.000Z",
		lastActor: EXTERNAL_ACTOR,
		actors: [EXTERNAL_ACTOR],
		hasExternalChange: false,
		hasImpreciseAttribution: false,
		hasDeletedActor: false,
		...overrides,
	};
}

/**
 * The count as it was computed before the caption and the count shared a decision.
 *
 * Kept here so these tests demonstrably fail against the old behaviour rather than
 * merely passing against the new one: each case below asserts what this formula got
 * wrong alongside what the current one gets right.
 */
function legacyExtraCount(attribution: FileModificationGroup): number {
	const lastActor = attribution.lastActor;
	const hasNarratorId = !!lastActor?.narratorId;
	const others = attribution.actors.filter(
		(candidate) => candidate.narratorId && candidate.narratorId !== lastActor?.narratorId,
	);
	return (
		others.length +
		(attribution.hasExternalChange ? 1 : 0) +
		(attribution.hasDeletedActor && hasNarratorId ? 1 : 0)
	);
}

describe("buildAttributionBadge", () => {
	test("a lone external contributor is counted once, not twice", () => {
		const attribution = group({ hasExternalChange: true });
		const badge = buildAttributionBadge(attribution, t);

		expect(badge.label).toBe("attributionExternal");
		// The caption IS the external contributor, so there is nothing left to add.
		expect(badge.extraCount).toBe(0);
		// Pin the regression: the old formula claimed a second contributor.
		expect(legacyExtraCount(attribution)).toBe(1);
	});

	test("a lone deleted session is counted once, not twice", () => {
		const attribution = group({ hasDeletedActor: true });
		const badge = buildAttributionBadge(attribution, t);

		expect(badge.label).toBe("attributionDeletedSession");
		expect(badge.extraCount).toBe(0);
		expect(badge.tooltipLines).toEqual(["attributionLastModified(name=attributionDeletedSession)"]);
	});

	test("a deleted lastActor is not re-listed as somebody else", () => {
		// `exists: false` with an id is the same deleted session, seen from a row that
		// kept the id. The tooltip used to name it, then add "also modified by" ABOUT IT.
		const deleted = actor({ narratorId: "gone", title: null, exists: false });
		const attribution = group({
			lastActor: deleted,
			actors: [deleted],
			hasDeletedActor: true,
		});
		const badge = buildAttributionBadge(attribution, t);

		expect(badge.label).toBe("attributionDeletedSession");
		expect(badge.extraCount).toBe(0);
		expect(badge.tooltipLines).toEqual(["attributionLastModified(name=attributionDeletedSession)"]);
		expect(legacyExtraCount(attribution)).toBe(1);
	});

	test("external and deleted together: the caption's class is the one subtracted", () => {
		// The label builder picks external here, so the count must keep deleted and drop
		// external. Getting this backwards is the subtle failure: the total stays 1 while
		// naming the wrong leftover.
		const attribution = group({ hasExternalChange: true, hasDeletedActor: true });
		const badge = buildAttributionBadge(attribution, t);

		expect(badge.label).toBe("attributionExternal");
		expect(badge.extraCount).toBe(1);
		expect(badge.tooltipLines).toEqual([
			"attributionLastModified(name=attributionExternal)",
			"attributionAlsoModified(name=attributionDeletedSession)",
		]);
		// Not the external line: the caption already says external.
		expect(badge.tooltipLines).not.toContain("attributionHasExternal");
	});

	test("narrator contributors are counted except the one named", () => {
		const last = actor({ narratorId: "n1", title: "Refactor auth" });
		const second = actor({ narratorId: "n2", title: "Fix tests" });
		const third = actor({ narratorId: "n3", title: "Docs", subagentType: "general" });
		const badge = buildAttributionBadge(
			group({ lastActor: last, actors: [last, second, third], changeCount: 3 }),
			t,
		);

		expect(badge.label).toBe("Refactor auth");
		expect(badge.extraCount).toBe(2);
		expect(badge.hasNarrator).toBe(true);
		expect(badge.tooltipLines).toEqual([
			"attributionLastModified(name=Refactor auth)",
			"attributionAlsoModified(name=Fix tests)",
			"attributionAlsoModified(name=attributionSubagentDetail(name=Docs,type=general))",
		]);
	});

	test("an external change beside a named narrator is genuinely extra", () => {
		// The complement: the caption names a session, so the external flag adds
		// information and must be counted. This is the case the old formula got right,
		// and it must keep working after the fix.
		const last = actor();
		const badge = buildAttributionBadge(
			group({ lastActor: last, actors: [last], hasExternalChange: true }),
			t,
		);

		expect(badge.extraCount).toBe(1);
		expect(badge.tooltipLines).toContain("attributionHasExternal");
	});

	test("imprecise attribution is disclosed last, without inflating the count", () => {
		// A shell command's write set is a guess, which is a caveat about the answer
		// rather than an additional contributor.
		const last = actor();
		const badge = buildAttributionBadge(
			group({ lastActor: last, actors: [last], hasImpreciseAttribution: true }),
			t,
		);

		expect(badge.extraCount).toBe(0);
		expect(badge.tooltipLines.at(-1)).toBe("attributionImprecise");
	});
});
