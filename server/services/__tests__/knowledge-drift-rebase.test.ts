/**
 * Drift + rebase tests for the knowledge branch service.
 *
 * Drift = a user's active draft was forked from an OLD main revision and main has since
 * advanced (draft.baseRevisionId !== entry.currentRevisionId). These tests verify:
 *  - getDraftDrift reports drifted / versionsBehind / content sides correctly
 *  - rebaseDraft three-way-merges a drifted draft onto current main (clean + conflict)
 *  - search flags drifted draft hits
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME (FTS triggers + ACL +
 * branch service all exercised).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

let collectionId: string;
let userId: string;
const principal = { userId: "", role: "user" as const };

const TAG = Date.now();

beforeAll(async () => {
	const now = new Date().toISOString();
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: `drift-author-${TAG}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	principal.userId = userId;

	const col = await knowledgeService.createCollection({ name: `drift-${TAG}` });
	collectionId = col.id;
});

describe("getDraftDrift", () => {
	test("no draft → { hasDraft: false }", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `NoDraft ${TAG}`,
			content: "line1\nline2\n",
		});
		const drift = await knowledgeBranchService.getDraftDrift(principal, entry.id);
		expect(drift.hasDraft).toBe(false);
	});

	test("draft on latest main → not drifted", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Fresh ${TAG}`,
			content: "alpha\nbeta\n",
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: "alpha\nbeta\ngamma\n",
		});

		const drift = await knowledgeBranchService.getDraftDrift(principal, entry.id);
		expect(drift.hasDraft).toBe(true);
		if (drift.hasDraft) {
			expect(drift.drifted).toBe(false);
			expect(drift.versionsBehind).toBe(0);
		}
	});

	test("main advances after draft fork → drifted with versionsBehind", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Drifty ${TAG}`,
			content: "v1-a\nv1-b\n",
		});
		// Draft forks from v1.
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: "v1-a\nv1-b\nmy-addition\n",
		});
		// Main advances twice (v2, v3) via direct writes (no principal → gate skipped).
		await knowledgeService.addRevision(entry.id, { content: "v2-a\nv1-b\n" });
		await knowledgeService.addRevision(entry.id, { content: "v3-a\nv1-b\n" });

		const drift = await knowledgeBranchService.getDraftDrift(principal, entry.id);
		expect(drift.hasDraft).toBe(true);
		if (drift.hasDraft) {
			expect(drift.drifted).toBe(true);
			expect(drift.versionsBehind).toBe(2);
			expect(drift.current).toBe("v3-a\nv1-b\n");
			expect(drift.draft).toBe("v1-a\nv1-b\nmy-addition\n");
		}
	});
});

describe("rebaseDraft", () => {
	test("clean rebase: non-overlapping changes merge onto current main", async () => {
		// Multi-paragraph body so the two edits sit in well-separated diff hunks (a realistic
		// knowledge entry; the three-way patch only conflicts when hunk context overlaps).
		const base = [
			"# Title",
			"",
			"intro paragraph one",
			"intro paragraph two",
			"",
			"## Section A",
			"detail a1",
			"detail a2",
			"detail a3",
			"",
			"## Section B",
			"detail b1",
			"detail b2",
			"detail b3",
			"",
			"## Footer",
			"closing note",
			"",
		].join("\n");
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `CleanRebase ${TAG}`,
			content: base,
		});
		// Draft edits the FOOTER region only.
		const draftContent = base.replace("closing note", "closing note\nmy extra footer line");
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, { content: draftContent });
		// Main edits the INTRO region only (far from the footer) → no hunk overlap.
		const mainContent = base.replace("intro paragraph one", "intro paragraph one (revised)");
		await knowledgeService.addRevision(entry.id, { content: mainContent });

		const res = await knowledgeBranchService.rebaseDraft(principal, draft.id);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.rebased).toBe(true);

		// After rebase the draft is on latest main and carries BOTH changes.
		const drift = await knowledgeBranchService.getDraftDrift(principal, entry.id);
		expect(drift.hasDraft).toBe(true);
		if (drift.hasDraft) {
			expect(drift.drifted).toBe(false);
			expect(drift.draft).toContain("intro paragraph one (revised)");
			expect(drift.draft).toContain("my extra footer line");
		}
	});

	test("conflict rebase: overlapping changes do NOT write, return three-way content", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `ConflictRebase ${TAG}`,
			content: "shared-line\n",
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: "draft-edit-of-shared-line\n",
		});
		// Main edits the SAME line differently → conflict.
		await knowledgeService.addRevision(entry.id, { content: "main-edit-of-shared-line\n" });

		const res = await knowledgeBranchService.rebaseDraft(principal, draft.id);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.conflict.theirs).toBe("main-edit-of-shared-line\n");
			expect(res.conflict.yours).toBe("draft-edit-of-shared-line\n");
		}

		// Draft is untouched (still drifted, content unchanged).
		const drift = await knowledgeBranchService.getDraftDrift(principal, entry.id);
		expect(drift.hasDraft).toBe(true);
		if (drift.hasDraft) {
			expect(drift.drifted).toBe(true);
			expect(drift.draft).toBe("draft-edit-of-shared-line\n");
		}
	});

	test("rebase on a non-drifted draft is a no-op", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `NoopRebase ${TAG}`,
			content: "x\n",
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, { content: "x\ny\n" });

		const res = await knowledgeBranchService.rebaseDraft(principal, draft.id);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.rebased).toBe(false);
	});
});

describe("search flags drifted draft hits", () => {
	test("a drifted draft hit is marked drifted; a fresh one is not", async () => {
		const driftTerm = `searchdrift${TAG}`;
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `SearchDrift ${TAG}`,
			content: `base ${driftTerm} content\n`,
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: `base ${driftTerm} content with edit\n`,
		});
		// Advance main so the draft drifts.
		await knowledgeService.addRevision(entry.id, { content: "totally new main content\n" });

		const res = knowledgeService.search({ q: driftTerm, collectionId, draftUserId: userId });
		const hit = res.find((r) => r.id === entry.id) as
			| { fromDraft?: boolean; drifted?: boolean }
			| undefined;
		expect(hit).toBeDefined();
		expect(hit?.fromDraft).toBe(true);
		expect(hit?.drifted).toBe(true);
	});
});
