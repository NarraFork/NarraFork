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
import {
	knowledgeBranchService,
	requireSqliteKnowledgeBranchMutation,
} from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

let collectionId: string;
let userId: string;
const principal = { userId: "", role: "user" as const };

const TAG = Date.now();

describe("PostgreSQL branch admission", () => {
	test("refuses branching and rebasing before legacy SQLite reads", () => {
		for (const operation of ["Knowledge draft branching", "Knowledge draft rebasing"]) {
			expect(() => requireSqliteKnowledgeBranchMutation(operation, "postgres")).toThrow(
				/PostgreSQL backend/,
			);
		}
		expect(() =>
			requireSqliteKnowledgeBranchMutation("Knowledge draft branching", "sqlite"),
		).not.toThrow();
	});
});

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

// The batch drift check exists so list views don't call getDraftDrift per row — that returns
// three full document bodies each. It must agree with the per-entry verdict exactly, or a
// library listing would mislabel which copies need a rebase.
describe("findDriftedDraftIds (batch) agrees with getDraftDrift", () => {
	test("classifies drifted, up-to-date and standalone rows in one query", async () => {
		// (a) drifted: fork, then advance main.
		const drifted = await knowledgeService.createEntry({
			collectionId,
			title: `BatchDrifted ${TAG}`,
			content: "base\n",
		});
		const driftedDraft = await knowledgeBranchService.createDraft(principal, drifted.id, {});
		await knowledgeService.addRevision(drifted.id, { content: "moved on\n" });

		// (b) up to date: fork and leave main alone.
		const fresh = await knowledgeService.createEntry({
			collectionId,
			title: `BatchFresh ${TAG}`,
			content: "stable\n",
		});
		const freshDraft = await knowledgeBranchService.createDraft(principal, fresh.id, {});

		// (c) standalone: no global counterpart, so drift is not even defined.
		const standalone = await knowledgeBranchService.createStandalone(principal, {
			title: `BatchStandalone ${TAG}`,
			content: "mine only\n",
			targetCollectionId: collectionId,
		});

		const rows = [driftedDraft, freshDraft, standalone];
		const batch = await knowledgeBranchService.findDriftedDraftIds(rows);

		expect(batch.has(driftedDraft.id)).toBe(true);
		expect(batch.has(freshDraft.id)).toBe(false);
		expect(batch.has(standalone.id)).toBe(false);

		// Equivalence with the per-entry path for both linked rows.
		for (const [draft, entryId] of [
			[driftedDraft, drifted.id],
			[freshDraft, fresh.id],
		] as const) {
			const single = await knowledgeBranchService.getDraftDrift(principal, entryId);
			expect(single.hasDraft).toBe(true);
			if (single.hasDraft) expect(batch.has(draft.id)).toBe(single.drifted);
		}
	});

	test("an empty input performs no query and returns an empty set", async () => {
		const batch = await knowledgeBranchService.findDriftedDraftIds([]);
		expect(batch.size).toBe(0);
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

		const res = await knowledgeService.search({ q: driftTerm, collectionId, draftUserId: userId });
		const hit = res.find((r) => r.id === entry.id) as
			| { fromDraft?: boolean; drifted?: boolean }
			| undefined;
		expect(hit).toBeDefined();
		expect(hit?.fromDraft).toBe(true);
		expect(hit?.drifted).toBe(true);
	});
});

/**
 * Submitting from a stale base is ALLOWED (approve three-way-merges it and usually succeeds),
 * but it must be reported: otherwise the conflict only surfaces when a reviewer clicks approve,
 * by which time the author — the only person who knows what their edit meant — is out of the
 * loop. The warning rides on the submit result so no extra round-trip is needed.
 */
describe("submitForReview reports a drifted base", () => {
	test("a drifted linked entry submits successfully but carries driftWarning", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `SubmitDrift ${TAG}`,
			content: "v1 body\n",
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, { content: "my edit\n" });
		// Main advances twice AFTER the fork point → 2 versions behind.
		await knowledgeService.addRevision(entry.id, { content: "v2 body\n" });
		await knowledgeService.addRevision(entry.id, { content: "v3 body\n" });

		const submission = await knowledgeBranchService.submitForReview(principal, draft.id, {});
		// Still a normal pending request — the warning does not block the submit.
		expect(submission?.status).toBe("pending");
		expect(submission?.driftWarning).not.toBeNull();
		expect(submission?.driftWarning?.versionsBehind).toBe(2);
		expect(submission?.driftWarning?.currentRevisionId).not.toBe(
			submission?.driftWarning?.baseRevisionId,
		);
	});

	test("an up-to-date linked entry reports no drift", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `SubmitFresh ${TAG}`,
			content: "v1 body\n",
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, { content: "my edit\n" });

		const submission = await knowledgeBranchService.submitForReview(principal, draft.id, {});
		expect(submission?.driftWarning).toBeNull();
	});

	test("a standalone entry never reports drift (it has no main to drift against)", async () => {
		const created = await knowledgeBranchService.createStandalone(principal, {
			title: `SubmitStandalone ${TAG}`,
			content: "body\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(principal, created.id, {});
		expect(submission?.driftWarning).toBeNull();
	});

	test("rebasing before submitting clears the warning", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `SubmitAfterRebase ${TAG}`,
			content: "line one\n",
		});
		const draft = await knowledgeBranchService.createDraft(principal, entry.id, {});
		await knowledgeBranchService.updateDraft(principal, draft.id, {
			content: "line one\nmy addition\n",
		});
		// A non-overlapping main change, so the rebase merges cleanly.
		await knowledgeService.addRevision(entry.id, { content: "line one\nmain addition\n" });
		const rebase = await knowledgeBranchService.rebaseDraft(principal, draft.id);
		expect(rebase.ok).toBe(true);

		const submission = await knowledgeBranchService.submitForReview(principal, draft.id, {});
		expect(submission?.driftWarning).toBeNull();
	});
});
