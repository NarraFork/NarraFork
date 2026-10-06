import { describe, expect, test } from "bun:test";
import type {
	AttributionActor,
	CurrentDiffTarget,
	FileModificationGroup,
} from "@frontend/hooks/useGit";
import {
	buildAttributionBadge,
	buildAttributionLabels,
	buildCurrentAttributionBadge,
} from "./attribution-label";

const t = (key: string, opts?: Record<string, unknown>): string => {
	if (!opts || Object.keys(opts).length === 0) return key;
	return `${key}(${Object.entries(opts)
		.map(([k, v]) => `${k}=${String(v)}`)
		.join(",")})`;
};

function actor(overrides: Partial<AttributionActor> = {}): AttributionActor {
	return {
		kind: "primary",
		narratorId: "n1",
		userId: null,
		title: "Refactor auth",
		subagentType: null,
		parentTitle: null,
		exists: true,
		deleted: false,
		identityKnown: true,
		...overrides,
	};
}
const EXTERNAL_ACTOR = actor({
	kind: "external_unknown",
	narratorId: null,
	title: null,
	exists: false,
	identityKnown: false,
});
const UNKNOWN_NARRATOR = actor({
	kind: "narrator_unknown",
	narratorId: null,
	title: null,
	exists: false,
	deleted: null,
	identityKnown: false,
});

function group(overrides: Partial<FileModificationGroup> = {}): FileModificationGroup {
	const lastActor = overrides.lastActor ?? EXTERNAL_ACTOR;
	const actors = overrides.actors ?? [lastActor];
	return {
		filePath: "src/one.ts",
		changeCount: 1,
		lastChangedAt: "2026-01-01T00:00:00.000Z",
		lastAction: "external",
		lastActor,
		actors,
		recentEvents: [],
		hasExternalChange: false,
		hasImpreciseAttribution: true,
		hasDeletedActor: false,
		completeness: {
			fileHistoryComplete: true,
			contributorsTruncated: false,
			countsLowerBound: actors.some((actor) => !actor.identityKnown),
			warningScanComplete: actors.every((actor) => actor.deleted !== null),
			asOfRevision: null,
		},
		evidence: "legacy",
		attributionGrade: "observed_ambiguous",
		...overrides,
	};
}

describe("buildAttributionLabels", () => {
	test("names a primary narrator by its title", () => {
		expect(buildAttributionLabels(actor(), t)).toEqual({
			short: "Refactor auth",
			detail: "Refactor auth",
		});
	});
	test("retains a subagent's type and parent", () => {
		expect(
			buildAttributionLabels(
				actor({
					kind: "subagent",
					title: "Trace edges",
					subagentType: "explore",
					parentTitle: "Graph rewrite",
				}),
				t,
			),
		).toEqual({
			short: "Trace edges",
			detail:
				"attributionSubagentDetailWithParent(name=Trace edges,type=explore,parent=Graph rewrite)",
		});
	});
	test("untitled sessions and subagents have truthful fallbacks", () => {
		expect(buildAttributionLabels(actor({ title: "   " }), t).short).toBe("attributionUnnamed");
		expect(
			buildAttributionLabels(actor({ kind: "subagent", title: null, subagentType: "review" }), t)
				.short,
		).toBe("attributionSubagentUnnamed(type=review)");
	});
	test("a known deleted session is not relabelled external and keeps its subtype", () => {
		const labels = buildAttributionLabels(
			actor({
				kind: "subagent",
				exists: false,
				deleted: true,
				title: "Do not reuse",
				subagentType: "general",
			}),
			t,
		);
		expect(labels.short).toBe("attributionDeletedSession");
		expect(labels.detail).toBe(
			"attributionSubagentDetail(name=attributionDeletedSession,type=general)",
		);
		expect(labels.detail).not.toContain("Do not reuse");
	});
	test("human usernames are labelled as users, not narrator sessions", () => {
		expect(
			buildAttributionLabels(
				actor({ kind: "human", narratorId: null, userId: "u1", title: "Alice" }),
				t,
			).short,
		).toBe("attributionHuman(name=Alice)");
	});
	test("deleted and unknown human identities never get fabricated names", () => {
		const human = actor({
			kind: "human",
			narratorId: null,
			userId: null,
			exists: false,
			title: "Do not reuse",
			identityKnown: false,
			deleted: null,
		});
		expect(buildAttributionLabels(human, t).short).toBe("attributionUnknownUser");
		expect(buildAttributionLabels({ ...human, deleted: true }, t).short).toBe(
			"attributionDeletedUser",
		);
	});
	test("an id-less legacy tool subject is explicitly unknown, rather than assumed primary or external", () => {
		expect(buildAttributionLabels(UNKNOWN_NARRATOR, t).short).toBe("attributionUnknownSession");
		expect(buildAttributionLabels(EXTERNAL_ACTOR, t).short).toBe("attributionExternal");
		expect(buildAttributionLabels(undefined, t).short).toBe("attributionUnknown");
	});
});

describe("buildAttributionBadge", () => {
	test("a lone external observation is not counted twice", () => {
		const badge = buildAttributionBadge(group({ hasExternalChange: true }), t);
		expect(badge.label).toBe("attributionExternal");
		expect(badge.extraCount).toBe(0);
		expect(badge.extraCountIsLowerBound).toBe(true);
	});
	test("known deleted lastActor is not re-listed as another contributor", () => {
		const deleted = actor({ narratorId: "gone", exists: false, title: null, deleted: true });
		const badge = buildAttributionBadge(
			group({ lastActor: deleted, actors: [deleted], hasDeletedActor: true }),
			t,
		);
		expect(badge.label).toBe("attributionDeletedSession");
		expect(badge.extraCount).toBe(0);
		expect(
			badge.tooltipLines.filter((line) => line.includes("attributionAlsoModified")),
		).toHaveLength(0);
	});
	test("latest deleted/unknown narrator wins over older external events, regardless of flags", () => {
		const badge = buildAttributionBadge(
			group({
				lastActor: UNKNOWN_NARRATOR,
				lastAction: "edit",
				actors: [UNKNOWN_NARRATOR, EXTERNAL_ACTOR],
				hasExternalChange: true,
				hasDeletedActor: true,
			}),
			t,
		);
		expect(badge.label).toBe("attributionUnknownSession");
		expect(badge.tooltipLines[0]).toBe("attributionLastModified(name=attributionUnknownSession)");
		expect(badge.tooltipLines).toContain("attributionLastAction(action=attributionAction.edit)");
		expect(badge.tooltipLines).toContain("attributionAlsoModified(name=attributionExternal)");
	});
	test("latest external event is not replaced by a historical deleted session", () => {
		const deleted = actor({ exists: false, deleted: true, title: null });
		const badge = buildAttributionBadge(
			group({
				lastActor: EXTERNAL_ACTOR,
				actors: [EXTERNAL_ACTOR, deleted],
				hasExternalChange: true,
				hasDeletedActor: true,
			}),
			t,
		);
		expect(badge.label).toBe("attributionExternal");
		expect(badge.tooltipLines).toContain("attributionAlsoModified(name=attributionDeletedSession)");
		// An anonymous external subject could be the same person: no invented extra count.
		expect(badge.extraCount).toBe(0);
	});
	test("group flags do not invent extra participants", () => {
		const badge = buildAttributionBadge(
			group({
				lastActor: actor(),
				actors: [actor()],
				hasExternalChange: true,
				hasDeletedActor: true,
			}),
			t,
		);
		expect(badge.extraCount).toBe(0);
		expect(badge.label).toBe("Refactor auth");
	});
	test("counts other identified narrators without counting the displayed one", () => {
		const last = actor();
		const second = actor({ narratorId: "n2", title: "Fix tests" });
		const third = actor({
			narratorId: "n3",
			title: "Docs",
			kind: "subagent",
			subagentType: "general",
		});
		const badge = buildAttributionBadge(
			group({ lastActor: last, actors: [last, second, third, second] }),
			t,
		);
		expect(badge.extraCount).toBe(2);
		expect(badge.hasNarrator).toBe(true);
		expect(badge.tooltipLines).toContain("attributionAlsoModified(name=Fix tests)");
	});
	test("two users with null narratorIds remain two separate identified subjects", () => {
		const alice = actor({ kind: "human", narratorId: null, userId: "u1", title: "Alice" });
		const bob = actor({ kind: "human", narratorId: null, userId: "u2", title: "Bob" });
		const badge = buildAttributionBadge(
			group({ lastActor: bob, lastAction: "human", actors: [bob, alice] }),
			t,
		);
		expect(badge.label).toBe("attributionHuman(name=Bob)");
		expect(badge.extraCount).toBe(1);
		expect(badge.hasNarrator).toBe(false);
		expect(badge.tooltipLines).toContain(
			"attributionAlsoModified(name=attributionHuman(name=Alice))",
		);
	});
	test("truncated history discloses lower-bound counts and unknown absent flags", () => {
		const last = actor();
		const badge = buildAttributionBadge(
			group({
				lastActor: last,
				actors: [last],
				hasExternalChange: null,
				hasDeletedActor: null,
				completeness: {
					fileHistoryComplete: false,
					contributorsTruncated: true,
					countsLowerBound: true,
					warningScanComplete: false,
					asOfRevision: null,
				},
			}),
			t,
		);
		expect(badge.incomplete).toBe(true);
		expect(badge.extraCountIsLowerBound).toBe(true);
		expect(badge.tooltipLines).toContain("attributionHistoryTruncated");
		expect(badge.tooltipLines).toContain("attributionCountsLowerBound");
		expect(badge.tooltipLines).toContain("attributionFlagsUnknown");
	});
	test("even complete Write/Edit history is legacy observation, never current ownership", () => {
		const badge = buildAttributionBadge(group({ lastActor: actor(), lastAction: "write" }), t);
		expect(badge.incomplete).toBe(false);
		expect(badge.tooltipLines).toContain("attributionHistoryComplete");
		expect(badge.tooltipLines).toContain("attributionLegacyObserved");
		expect(badge.tooltipLines).toContain("attributionNotCurrentOwnership");
	});
});

function current(overrides: Partial<CurrentDiffTarget> = {}): CurrentDiffTarget {
	return {
		source: "current_diff",
		target: "worktree",
		status: "matching_evidence",
		actor: actor(),
		effectId: "effect-1",
		reason: null,
		baselineVersion: "a".repeat(64),
		historyComplete: true,
		modeScope: "filesystem",
		continuity: "unverified",
		...overrides,
	};
}

describe("current target attribution labels", () => {
	test("matching evidence names one actor but never counts historical participants as owners", () => {
		const old = actor({ narratorId: "old", title: "Historic" });
		const badge = buildCurrentAttributionBadge(
			current(),
			group({ lastActor: old, actors: [old, actor()] }),
			t,
		);
		expect(badge?.label).toBe("attributionEvidenceBadge(name=Refactor auth)");
		expect(badge?.extraCount).toBe(0);
		expect(badge?.tooltipLines).toContain("attributionHistorySection");
		expect(badge?.tooltipLines).toContain("attributionContinuityUnknown");
		expect(badge?.tooltipLines).toContain("attributionBaselineVersion(version=aaaaaaaaaaaa)");
	});
	test("unknown or missing current data cannot fall back to a historical actor", () => {
		for (const target of [
			undefined,
			current({ status: "unknown", actor: null, reason: "state_mismatch" }),
		]) {
			const badge = buildCurrentAttributionBadge(target, group({ lastActor: actor() }), t);
			expect(badge?.label).toBe("attributionCurrentUnknownBadge");
			expect(badge?.incomplete).toBe(true);
		}
	});
	test("clean target suppresses all attribution even with a populated history", () => {
		expect(
			buildCurrentAttributionBadge(current({ status: "clean", actor: null }), group(), t),
		).toBeNull();
	});
	test("human and deleted types survive current labels and index mode is explicit", () => {
		const deleted = actor({
			kind: "human",
			narratorId: null,
			userId: "gone",
			exists: false,
			deleted: true,
			title: null,
		});
		const badge = buildCurrentAttributionBadge(
			current({ target: "index", modeScope: "git_executable_bit", actor: deleted }),
			undefined,
			t,
		);
		expect(badge?.label).toBe("attributionEvidenceBadge(name=attributionDeletedUser)");
		expect(badge?.tooltipLines).toContain("attributionIndexMode");
		expect(badge?.hasNarrator).toBe(false);
	});
	test("a v2 historical group is not mislabeled legacy or promoted to current ownership", () => {
		const badge = buildAttributionBadge(group({ evidence: "v2", lastActor: actor() }), t);
		expect(badge.tooltipLines).toContain("attributionRecordedEvidence");
		expect(badge.tooltipLines).not.toContain("attributionLegacyObserved");
	});
});
