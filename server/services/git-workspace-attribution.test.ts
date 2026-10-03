import { afterEach, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { narrators, users } from "../db/schema";
import { generateId } from "../lib/id";
import { type AttributionActor, EXTERNAL_ACTOR } from "./attribution-actors";
import { redactGitActors, redactGitModificationView } from "./git-workspace-attribution";
import { canReadNarrator, canWriteNarrator } from "./narrator-acl";
import type { WorkspaceModificationView } from "./workspace-modification-view";

const { db } = await import("../db");
const createdNarrators: string[] = [];
const createdUsers: string[] = [];
const changedAt = "2026-01-01T00:00:00.000Z";
const completeness = {
	fileHistoryComplete: true,
	contributorsTruncated: false,
	countsLowerBound: false,
	warningScanComplete: true,
	asOfRevision: null,
};

function narratorActor(id: string, title: string): AttributionActor {
	return {
		...EXTERNAL_ACTOR,
		kind: "primary",
		narratorId: id,
		title,
		parentTitle: "PRIVATE PARENT TITLE",
		exists: true,
		identityKnown: true,
		subjectKey: `narrator:${id}`,
	};
}

function viewOf(actors: AttributionActor[]): WorkspaceModificationView {
	const recentEvents = actors.map((actor, index) => ({
		id: `event-${index}`,
		changedAt,
		action: "edit" as const,
		actor,
		evidence: "legacy" as const,
		linesAdded: index + 1,
		linesRemoved: null,
	}));
	return {
		workspacePath: "/fixture/repo",
		deviceId: "local",
		actors,
		timeline: recentEvents.map((event) => ({
			...event,
			filePath: "shared.txt",
			toolName: "Edit",
			toolUseId: `tool-${event.id}`,
			treeHashAfter: "tree-boundary",
			preciseAttribution: true,
			attributionGrade: "observed_ambiguous",
		})),
		byFile: [
			{
				filePath: "shared.txt",
				changeCount: actors.length,
				lastChangedAt: changedAt,
				lastActor: actors[0],
				lastAction: "edit",
				actors,
				recentEvents,
				hasExternalChange: false,
				hasImpreciseAttribution: true,
				hasDeletedActor: false,
				completeness,
				evidence: "legacy",
				attributionGrade: "observed_ambiguous",
			},
		],
		hasMore: false,
		windowCount: actors.length,
		completeness,
		evidence: "legacy",
		baselineStatus: "unverified",
	};
}

afterEach(async () => {
	if (createdNarrators.length)
		await db.delete(narrators).where(inArray(narrators.id, createdNarrators.splice(0)));
	if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers.splice(0)));
});

test("nested event actors match timeline and summaries without mutating observations", () => {
	const privateActor = narratorActor("private", "PRIVATE ACTOR TITLE");
	const readableActor = {
		...narratorActor("readable", "Readable actor"),
		kind: "subagent" as const,
		subagentType: "general",
	};
	const human = {
		...EXTERNAL_ACTOR,
		kind: "human" as const,
		userId: "human-id",
		title: "Human name",
		exists: true,
		identityKnown: true,
	};
	const view = viewOf([privateActor, readableActor, human, EXTERNAL_ACTOR]);
	const original = JSON.stringify(view);
	const result = redactGitActors(view, new Set(["readable"]));
	const file = result.byFile[0];
	const timeline = result.timeline;
	if (!timeline) throw new Error("expected timeline projection");
	const unknown: AttributionActor = { ...EXTERNAL_ACTOR, kind: "narrator_unknown", deleted: null };
	expect(file.lastActor).toEqual(unknown);
	expect(file.recentEvents[0].actor).toEqual(unknown);
	expect(JSON.stringify(result)).not.toContain("PRIVATE ACTOR TITLE");
	expect(JSON.stringify(result)).not.toContain("PRIVATE PARENT TITLE");
	expect(JSON.stringify(result)).not.toContain("narrator:private");
	for (let index = 0; index < file.recentEvents.length; index++) {
		expect(file.recentEvents[index].actor).toEqual(result.actors[index]);
		expect(file.recentEvents[index].actor).toEqual(file.actors[index]);
		expect(file.recentEvents[index].actor).toEqual(timeline[index].actor);
		const { actor: _actor, ...observation } = file.recentEvents[index];
		const { actor: _originalActor, ...originalObservation } = view.byFile[0].recentEvents[index];
		expect(observation).toEqual(originalObservation);
	}
	expect(file.recentEvents[1].actor).toEqual({ ...readableActor, parentTitle: null });
	expect(file.recentEvents[2].actor).toEqual(human);
	expect(file.recentEvents[3].actor).toEqual(EXTERNAL_ACTOR);
	expect(result.timeline?.[0]).toMatchObject({
		toolUseId: null,
		treeHashAfter: null,
		preciseAttribution: false,
	});
	expect(result.timeline?.[1].toolUseId).toBe(view.timeline?.[1].toolUseId);
	expect(file.changeCount).toBe(view.byFile[0].changeCount);
	expect(file.completeness).toEqual(view.byFile[0].completeness);
	expect(JSON.stringify(view)).toBe(original);
});

test("byFile-only projection redacts nested actors even without a timeline", () => {
	const view = viewOf([narratorActor("private", "PRIVATE ACTOR TITLE")]);
	delete view.timeline;
	const result = redactGitActors(view, new Set());
	expect(result.timeline).toBeUndefined();
	expect(result.byFile[0].recentEvents[0].actor).toEqual(result.byFile[0].lastActor);
	expect(JSON.stringify(result)).not.toContain("PRIVATE ACTOR TITLE");
});

test("nested-only actor ids use existing read ACL without granting write", async () => {
	const userId = generateId();
	const publicId = generateId();
	const privateId = generateId();
	const timestamp = new Date().toISOString();
	await db.insert(users).values({
		id: userId,
		username: userId,
		passwordHash: "fixture",
		createdAt: timestamp,
	});
	createdUsers.push(userId);
	for (const [id, visibility] of [
		[publicId, "public"],
		[privateId, "private"],
	] as const) {
		await db.insert(narrators).values({
			id,
			title: visibility,
			visibility,
			ownerUserId: null,
			writeAudience: "owner",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		createdNarrators.push(id);
	}
	const publicActor = narratorActor(publicId, "Readable actor");
	const view = viewOf([publicActor, narratorActor(privateId, "PRIVATE ACTOR TITLE")]);
	// The hover-card projection can contain actors absent from all other summaries.
	delete view.timeline;
	view.actors = [];
	view.byFile[0].actors = [];
	view.byFile[0].lastActor = EXTERNAL_ACTOR;
	const principal = { userId, isAdmin: false };
	const publicRow = await db.query.narrators.findFirst({ where: eq(narrators.id, publicId) });
	const privateRow = await db.query.narrators.findFirst({ where: eq(narrators.id, privateId) });
	if (!publicRow || !privateRow) throw new Error("missing narrator fixture");
	expect(await canReadNarrator(publicRow, principal)).toBe(true);
	expect(await canWriteNarrator(publicRow, principal)).toBe(false);
	expect(await canReadNarrator(privateRow, principal)).toBe(false);
	expect(await canWriteNarrator(privateRow, principal)).toBe(false);
	const result = await redactGitModificationView(view, principal);
	expect(result.byFile[0].recentEvents[0].actor).toEqual({ ...publicActor, parentTitle: null });
	expect(result.byFile[0].recentEvents[1].actor).toEqual({
		...EXTERNAL_ACTOR,
		kind: "narrator_unknown",
		deleted: null,
	});
	expect(JSON.stringify(result)).not.toContain("PRIVATE ACTOR TITLE");
	expect(JSON.stringify(result)).not.toContain(privateId);
	expect(await canWriteNarrator(publicRow, principal)).toBe(false);
	expect(await canReadNarrator(privateRow, principal)).toBe(false);
});
